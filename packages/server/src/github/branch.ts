import type { GitHubClient } from './client.js';
import { materializeChangedFiles, type PrDetail } from './pr.js';
import { fetchRepositoryFile, isRepositoryFilePath } from './repository-file.js';
import { submitReview, type PendingComment } from './review.js';

export interface BranchDetail extends PrDetail {
  /** Branch reviews do not have a pull-request number until the user submits. */
  number: 0;
  branchReview: true;
  /** Present when a pasted /blob/ URL is being edited into a new branch and pull request. */
  documentReview?: { path: string };
}

export interface CreateBranchPullRequestInput {
  branch: string;
  expectedHeadSha: string;
  title: string;
  body: string;
  comments: PendingComment[];
  documentPath?: string;
}

export interface CreatedBranchPullRequest {
  number: number;
  url: string;
  reviewUrl: string | null;
  reviewError: string | null;
}

export class BranchReviewError extends Error {}

function encodedRef(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}

export function isBranchName(branch: string): boolean {
  return Boolean(
    branch &&
      branch.length <= 255 &&
      !branch.startsWith('/') &&
      !branch.endsWith('/') &&
      !branch.includes('..') &&
      !branch.includes('\\') &&
      !branch.includes('\0') &&
      !/[~^:?*[\]]/.test(branch) &&
      branch.split('/').every((part) => part && part !== '.' && !part.endsWith('.lock')),
  );
}

async function branchSha(gh: GitHubClient, owner: string, repo: string, branch: string): Promise<string> {
  const ref = await gh.rest<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodedRef(branch)}`,
  );
  return ref.object.sha;
}

/** Build the same read model as a PR, but without writing anything to GitHub. */
export async function fetchBranch(
  gh: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  documentPath?: string,
): Promise<BranchDetail> {
  const [repository, viewer, headSha] = await Promise.all([
    gh.rest<{ default_branch: string; html_url: string }>(`/repos/${owner}/${repo}`, { cache: true }),
    gh.rest<{ login: string }>('/user', { cache: true }),
    branchSha(gh, owner, repo, branch),
  ]);
  if (documentPath) {
    if (!isRepositoryFilePath(documentPath)) throw new BranchReviewError('That repository file path is not supported.');
    const document = await fetchRepositoryFile(gh, owner, repo, documentPath, branch);
    if (!document) throw new BranchReviewError(`Could not find ${documentPath} on branch ${branch}.`);
    const lineCount = Math.max(1, document.content.split('\n').length);
    return {
      owner,
      repo,
      number: 0,
      branchReview: true,
      documentReview: { path: documentPath },
      title: `Edit ${documentPath.split('/').pop()}`,
      url: `${repository.html_url}/blob/${encodedRef(branch)}/${documentPath.split('/').map(encodeURIComponent).join('/')}`,
      state: 'document',
      isDraft: false,
      author: { login: viewer.login, avatarUrl: '' },
      baseRef: branch,
      headRef: branch,
      baseSha: headSha,
      headSha,
      viewerLogin: viewer.login,
      viewerIsAuthor: true,
      files: [
        {
          path: documentPath,
          previousPath: null,
          status: 'unchanged',
          additions: 0,
          deletions: 0,
          patch: { hunks: [], rightLines: [[1, lineCount]], leftLines: [] },
          base: document.content,
          head: document.content,
          skipped: null,
        },
      ],
      threads: [],
      warnings: [],
    };
  }
  const baseRef = repository.default_branch;
  const comparison = await gh.rest<any>(
    `/repos/${owner}/${repo}/compare/${encodeURIComponent(`${baseRef}...${branch}`)}?per_page=100`,
  );
  const baseSha: string = comparison.base_commit?.sha;
  const comparedFiles: any[] = comparison.files ?? [];
  if (!baseSha || comparison.status === 'identical' || comparison.ahead_by === 0 || comparedFiles.length === 0) {
    throw new BranchReviewError(`Branch ${branch} has no changes from ${baseRef}.`);
  }
  const rawFiles = comparedFiles.slice(0, 100);
  const warnings: string[] = [];
  if (comparedFiles.length > rawFiles.length) warnings.push('This comparison has more than 100 changed files; only the first 100 are shown.');
  const files = await materializeChangedFiles(gh, owner, repo, rawFiles, baseSha, headSha);

  return {
    owner,
    repo,
    number: 0,
    branchReview: true,
    title: `Review ${branch}`,
    url: `${repository.html_url}/tree/${encodedRef(branch)}`,
    state: 'branch',
    isDraft: false,
    author: { login: viewer.login, avatarUrl: '' },
    baseRef,
    headRef: branch,
    baseSha,
    headSha,
    viewerLogin: viewer.login,
    viewerIsAuthor: true,
    files,
    threads: [],
    warnings,
  };
}

/** Create the PR only at the review boundary, then attach the locally buffered comments. */
export async function createBranchPullRequest(
  gh: GitHubClient,
  owner: string,
  repo: string,
  input: CreateBranchPullRequestInput,
): Promise<CreatedBranchPullRequest> {
  if (input.documentPath) return createDocumentPullRequest(gh, owner, repo, input);

  const [repository, currentHeadSha] = await Promise.all([
    gh.rest<{ default_branch: string }>(`/repos/${owner}/${repo}`, { cache: true }),
    branchSha(gh, owner, repo, input.branch),
  ]);
  if (currentHeadSha !== input.expectedHeadSha) {
    throw new BranchReviewError('New commits were pushed to this branch. Reopen it before creating the pull request.');
  }

  const created = await gh.write<any>('POST', `/repos/${owner}/${repo}/pulls`, {
    title: input.title.trim(),
    head: input.branch,
    base: repository.default_branch,
    body: input.body.trim(),
  });

  if (input.comments.length === 0) {
    return { number: created.number, url: created.html_url, reviewUrl: null, reviewError: null };
  }
  if (created.head?.sha !== input.expectedHeadSha) {
    return {
      number: created.number,
      url: created.html_url,
      reviewUrl: null,
      reviewError: 'The branch moved while the pull request was being created, so comments were not posted.',
    };
  }

  try {
    const review = await submitReview(gh, owner, repo, created.number, {
      event: 'COMMENT',
      body: '',
      comments: input.comments,
      commitId: created.head.sha,
    });
    const fileFailures = review.fileCommentErrors.length
      ? `${review.fileCommentErrors.length} file comment(s) failed: ${review.fileCommentErrors.join('; ')}`
      : null;
    return { number: created.number, url: created.html_url, reviewUrl: review.url, reviewError: fileFailures };
  } catch (error) {
    return {
      number: created.number,
      url: created.html_url,
      reviewUrl: null,
      reviewError: `The pull request was created, but the review could not be posted: ${(error as Error).message}`,
    };
  }
}

function lineOffset(source: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = source.indexOf('\n', offset);
    if (newline === -1) return source.length;
    offset = newline + 1;
  }
  return offset;
}

/** Apply whole-line suggestions from bottom to top so earlier offsets never move. */
export function applyDocumentSuggestions(source: string, comments: PendingComment[]): string {
  const edits = comments
    .filter((comment): comment is PendingComment & { suggestion: string } => comment.suggestion !== undefined)
    .map((comment) => {
      const startLine = comment.startLine ?? comment.line;
      const endLine = comment.line;
      if (startLine < 1 || endLine < startLine) throw new BranchReviewError('A suggested edit has an invalid line range.');
      const start = lineOffset(source, startLine);
      const after = lineOffset(source, endLine + 1);
      const consumesNewline = after > start && source.charCodeAt(after - 1) === 10;
      return {
        start,
        end: after,
        replacement: `${comment.suggestion}${consumesNewline ? '\n' : ''}`,
      };
    })
    .sort((a, b) => b.start - a.start);

  let previousStart = source.length + 1;
  let result = source;
  for (const edit of edits) {
    if (edit.end > previousStart) throw new BranchReviewError('Suggested edits overlap. Remove one and try again.');
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    previousStart = edit.start;
  }
  return result;
}

function pullRequestBranch(path: string): string {
  const stem = (path.split('/').pop() ?? 'document')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 42) || 'document';
  return `marky/${stem}-${Date.now().toString(36)}`;
}

async function createDocumentPullRequest(
  gh: GitHubClient,
  owner: string,
  repo: string,
  input: CreateBranchPullRequestInput & { documentPath?: string },
): Promise<CreatedBranchPullRequest> {
  const path = input.documentPath!;
  if (!isRepositoryFilePath(path)) throw new BranchReviewError('That repository file path is not supported.');
  const currentHeadSha = await branchSha(gh, owner, repo, input.branch);
  if (currentHeadSha !== input.expectedHeadSha) {
    throw new BranchReviewError('New commits were pushed to this branch. Reopen the document before creating the pull request.');
  }
  const document = await fetchRepositoryFile(gh, owner, repo, path, input.branch);
  if (!document) throw new BranchReviewError(`Could not find ${path} on branch ${input.branch}.`);
  const updated = applyDocumentSuggestions(document.content, input.comments);
  if (updated === document.content) {
    throw new BranchReviewError('Add at least one suggested edit before creating a pull request.');
  }

  const baseCommit = await gh.rest<{ tree: { sha: string } }>(
    `/repos/${owner}/${repo}/git/commits/${input.expectedHeadSha}`,
  );
  const blob = await gh.write<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
    content: updated,
    encoding: 'utf-8',
  });
  const tree = await gh.write<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  const commit = await gh.write<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: input.title.trim(),
    tree: tree.sha,
    parents: [input.expectedHeadSha],
  });
  const head = pullRequestBranch(path);
  await gh.write('POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${head}`,
    sha: commit.sha,
  });
  const created = await gh.write<any>('POST', `/repos/${owner}/${repo}/pulls`, {
    title: input.title.trim(),
    head,
    base: input.branch,
    body: input.body.trim(),
  });

  // The edits are already committed. Preserve the reader's prose as file-level PR comments,
  // rather than posting suggestion blocks that would ask GitHub to apply the same change twice.
  const reviewComments = input.comments.map(({ suggestion: _suggestion, ...comment }) => ({
    ...comment,
    subjectType: 'file' as const,
  }));
  try {
    const review = await submitReview(gh, owner, repo, created.number, {
      event: 'COMMENT',
      body: '',
      comments: reviewComments,
      commitId: commit.sha,
    });
    const fileFailures = review.fileCommentErrors.length
      ? `${review.fileCommentErrors.length} file comment(s) failed: ${review.fileCommentErrors.join('; ')}`
      : null;
    return { number: created.number, url: created.html_url, reviewUrl: review.url, reviewError: fileFailures };
  } catch (error) {
    return {
      number: created.number,
      url: created.html_url,
      reviewUrl: null,
      reviewError: `The pull request was created, but the review could not be posted: ${(error as Error).message}`,
    };
  }
}
