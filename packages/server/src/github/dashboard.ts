import type { GitHubClient } from './client.js';

/**
 * The whole dashboard in one GraphQL query.
 *
 * Measured cost 1 (nodeCount 265; still cost 1 at nodeCount 1230 with far more fields), because
 * point cost is ceil(connections / 100) floored at 1 — four search connections cost the same as
 * one. Critically, GraphQL `search` does **not** draw on the REST search bucket, so the 30/min
 * ceiling that would otherwise dominate the design simply does not apply.
 */

const PR_FIELDS = `
  number title url isDraft createdAt updatedAt reviewDecision
  author { login avatarUrl }
  repository { nameWithOwner }
  baseRefName headRefName
  changedFiles additions deletions
  files(first: 100) { totalCount nodes { path additions deletions changeType } }
`;

const DASHBOARD_QUERY = `
query Dashboard($reviewCount: Int!, $authoredCount: Int!) {
  viewer { login name avatarUrl }
  reviewRequested: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: $reviewCount) {
    issueCount
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  authored: search(query: "is:open is:pr author:@me archived:false", type: ISSUE, first: $authoredCount) {
    issueCount
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
  rateLimit { limit cost remaining nodeCount resetAt }
}`;

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  reviewDecision: string | null;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  baseRefName: string;
  headRefName: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  files: { totalCount: number; nodes: PrFile[] };
  /** Derived, free — the file list already came back in this query. */
  markdown: { count: number; total: number; ratio: number; truncated: boolean };
}

export interface ActivityItem {
  id: string;
  reason: string;
  unread: boolean;
  updatedAt: string;
  title: string;
  repo: string;
  prNumber: number | null;
}

export interface DashboardData {
  viewer: { login: string; name: string | null; avatarUrl: string };
  reviewRequested: PrSummary[];
  authored: PrSummary[];
  activity: ActivityItem[];
  repos: Array<{ nameWithOwner: string; count: number }>;
  rateLimit: { limit: number; cost: number; remaining: number; nodeCount: number; resetAt: string };
  /** Non-fatal problems worth showing rather than swallowing (org approval, rate limits). */
  warnings: string[];
  fetchedAt: string;
}

const MD_RE = /\.mdx?$/i;

function decorate(node: Record<string, unknown>): PrSummary {
  const pr = node as unknown as Omit<PrSummary, 'markdown'>;
  const nodes = pr.files?.nodes ?? [];
  const total = pr.files?.totalCount ?? 0;
  const count = nodes.filter((f) => MD_RE.test(f.path)).length;
  return {
    ...pr,
    markdown: {
      count,
      total,
      ratio: nodes.length > 0 ? count / nodes.length : 0,
      // `files(first: 100)` caps at 100, so the ratio is a sample above that.
      truncated: total > nodes.length,
    },
  };
}

/**
 * Recent activity.
 *
 * `participating=true` is not optional: the unfiltered feed measured 92% `ci_activity` noise,
 * while participating returns only assign / author / mention / review_requested — every item
 * something a human did that concerns you. `received_events` was rejected outright; in a large
 * org it is the org firehose, ~100 events per 4 minutes, almost none involving you.
 */
async function fetchActivity(gh: GitHubClient): Promise<{ items: ActivityItem[]; pollInterval: number }> {
  const { data, headers } = await gh.restWithHeaders<
    Array<{
      id: string;
      reason: string;
      unread: boolean;
      updated_at: string;
      subject: { title: string; type: string; url: string | null };
      repository: { full_name: string };
    }>
  >('/notifications?participating=true&per_page=30');

  const pollInterval = Number(headers.get('x-poll-interval') ?? 60);
  const items = (data ?? [])
    .filter((n) => n.subject.type === 'PullRequest')
    .map((n) => ({
      id: n.id,
      reason: n.reason,
      unread: n.unread,
      updatedAt: n.updated_at,
      title: n.subject.title,
      repo: n.repository.full_name,
      prNumber: n.subject.url ? Number(n.subject.url.split('/').pop()) || null : null,
    }));

  return { items, pollInterval: Number.isFinite(pollInterval) ? pollInterval : 60 };
}

export async function fetchDashboard(gh: GitHubClient): Promise<DashboardData> {
  const warnings: string[] = [];

  const data = await gh.graphql<{
    viewer: { login: string; name: string | null; avatarUrl: string };
    reviewRequested: { issueCount: number; nodes: Array<Record<string, unknown>> };
    authored: { issueCount: number; nodes: Array<Record<string, unknown>> };
    rateLimit: DashboardData['rateLimit'];
  }>(DASHBOARD_QUERY, { reviewCount: 25, authoredCount: 25 });

  let activity: ActivityItem[] = [];
  try {
    activity = (await fetchActivity(gh)).items;
  } catch (err) {
    warnings.push(`Could not load activity: ${(err as Error).message}`);
  }

  const reviewRequested = data.reviewRequested.nodes.filter(Boolean).map(decorate);
  const authored = data.authored.nodes.filter(Boolean).map(decorate);

  // Repo chips are derived from results rather than from a repo picker. The account this was
  // designed against can see 1,017 repos and sorting them by push time surfaces the busiest
  // repos in the org, not yours — the PR results already name exactly the relevant ones.
  const counts = new Map<string, number>();
  for (const pr of [...reviewRequested, ...authored]) {
    const name = pr.repository.nameWithOwner;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const repos = [...counts.entries()]
    .map(([nameWithOwner, count]) => ({ nameWithOwner, count }))
    .sort((a, b) => b.count - a.count || a.nameWithOwner.localeCompare(b.nameWithOwner));

  // An org with OAuth app access restrictions authenticates fine and then returns nothing.
  // Silence would read as "no work to do", so say it out loud.
  if (reviewRequested.length === 0 && authored.length === 0 && activity.length === 0) {
    warnings.push(
      'No pull requests found. If you expect some, your organisation may restrict OAuth app ' +
        'access — an owner has to approve marky-mcmarkface before its token can see org repositories.',
    );
  }

  return {
    viewer: data.viewer,
    reviewRequested,
    authored,
    activity,
    repos,
    rateLimit: data.rateLimit,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
