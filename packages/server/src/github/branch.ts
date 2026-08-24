import type { GitHubClient } from './client.js';
import { materializeChangedFiles, type PrDetail } from './pr.js';
import { submitReview, type PendingComment } from './review.js';

export interface BranchDetail extends PrDetail {
  /** Branch reviews do not have a pull-request number until the user submits. */
  number: 0;
  branchReview: true;
}

export interface CreateBranchPullRequestInput {
  branch: string;
  expectedHeadSha: string;
  title: string;
  body: string;
  comments: PendingComment[];
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
): Promise<BranchDetail> {
  const [repository, viewer, headSha] = await Promise.all([
    gh.rest<{ default_branch: string; html_url: string }>(`/repos/${owner}/${repo}`, { cache: true }),
    gh.rest<{ login: string }>('/user', { cache: true }),
    branchSha(gh, owner, repo, branch),
  ]);
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
