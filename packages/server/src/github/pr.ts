import type { GitHubClient } from './client.js';
import { parsePatch, type ParsedPatch } from './patch.js';

export interface PrFileDetail {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: ParsedPatch;
  /** Present for text files we intend to render; null when added/deleted/too large. */
  base: string | null;
  head: string | null;
  /** Set when content was skipped, so the UI can explain instead of showing an empty pane. */
  skipped: string | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: 'LEFT' | 'RIGHT';
  comments: Array<{
    id: string;
    databaseId: number | null;
    author: string;
    avatarUrl: string;
    body: string;
    createdAt: string;
    url: string;
  }>;
}

export interface PrDetail {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  author: { login: string; avatarUrl: string } | null;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  /** Opaque localhost capability for images at headSha. Added by the HTTP route. */
  imageBaseUrl?: string;
  viewerLogin: string;
  /** True when the viewer is the PR author — GitHub forbids approving your own PR. */
  viewerIsAuthor: boolean;
  files: PrFileDetail[];
  threads: ReviewThread[];
  warnings: string[];
}

const MAX_BLOB = 1_000_000;
const TEXT_RE = /\.(mdx?|txt|ya?ml|json|toml|ts|tsx|js|jsx|css|html|sh|py|go|java|rs|sql)$/i;

const THREADS_QUERY = `
query Threads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide
          comments(first: 50) {
            nodes { id databaseId body createdAt url author { login avatarUrl } }
          }
        }
      }
    }
  }
}`;

export async function fetchReviewThreads(
  gh: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<ReviewThread[]> {
  const out: ReviewThread[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const data: any = await gh.graphql(THREADS_QUERY, { owner, repo, number, cursor });
    const conn = data.repository?.pullRequest?.reviewThreads;
    if (!conn) break;
    for (const node of conn.nodes ?? []) {
      out.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line,
        startLine: node.startLine,
        originalLine: node.originalLine,
        side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
        comments: (node.comments?.nodes ?? []).map((c: any) => ({
          id: c.id,
          databaseId: c.databaseId ?? null,
          author: c.author?.login ?? 'ghost',
          avatarUrl: c.author?.avatarUrl ?? '',
          body: c.body,
          createdAt: c.createdAt,
          url: c.url,
        })),
      });
    }
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return out;
}

async function blobAt(gh: GitHubClient, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    // SHAs are immutable, so this cache never has to be invalidated.
    return await gh.rest<string>(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`, {
      accept: 'application/vnd.github.raw',
      cache: true,
    });
  } catch {
    return null;
  }
}

export async function fetchPr(gh: GitHubClient, owner: string, repo: string, number: number): Promise<PrDetail> {
  const warnings: string[] = [];

  const [pr, rawFiles, viewer] = await Promise.all([
    gh.rest<any>(`/repos/${owner}/${repo}/pulls/${number}`),
    gh.rest<any[]>(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
    gh.rest<{ login: string }>('/user', { cache: true }),
  ]);

  const headSha: string = pr.head.sha;
  const baseSha: string = pr.base.sha;

  if (rawFiles.length === 100) {
    warnings.push('This PR has 100 or more changed files; only the first 100 are shown.');
  }

  const files: PrFileDetail[] = await Promise.all(
    rawFiles.map(async (f): Promise<PrFileDetail> => {
      const patch = parsePatch(f.patch);
      const renderable = TEXT_RE.test(f.filename);
      let base: string | null = null;
      let head: string | null = null;
      let skipped: string | null = null;

      if (!renderable) {
        skipped = 'Binary or unsupported file type.';
      } else if ((f.changes ?? 0) === 0 && f.status !== 'renamed') {
        skipped = 'No textual changes.';
      } else {
        if (f.status !== 'added') {
          base = await blobAt(gh, owner, repo, f.previous_filename ?? f.filename, baseSha);
        }
        if (f.status !== 'removed') {
          head = await blobAt(gh, owner, repo, f.filename, headSha);
        }
        if ((base?.length ?? 0) > MAX_BLOB || (head?.length ?? 0) > MAX_BLOB) {
          base = null;
          head = null;
          skipped = 'File is larger than 1 MB.';
        }
      }

      return {
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: f.status,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        patch,
        base,
        head,
        skipped,
      };
    }),
  );

  let threads: ReviewThread[] = [];
  try {
    threads = await fetchReviewThreads(gh, owner, repo, number);
  } catch (err) {
    warnings.push(`Could not load review threads: ${(err as Error).message}`);
  }

  return {
    owner,
    repo,
    number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    isDraft: Boolean(pr.draft),
    author: pr.user ? { login: pr.user.login, avatarUrl: pr.user.avatar_url } : null,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    baseSha,
    headSha,
    viewerLogin: viewer.login,
    viewerIsAuthor: pr.user?.login === viewer.login,
    files,
    threads,
    warnings,
  };
}
