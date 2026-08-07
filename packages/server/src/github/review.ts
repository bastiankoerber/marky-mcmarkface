import type { Side } from '@marky-mcmarkface/viewer-api';
import type { GitHubClient } from './client.js';

/**
 * Submitting a review.
 *
 * Comments buffer on the client and go up as one review, which is both what GitHub's model wants
 * and what the Google-Docs analogy implies: you read the whole document, leave your notes, and
 * then decide approve / request changes / comment once.
 */

export interface PendingComment {
  path: string;
  side: Side;
  /** Last line of the span. GitHub calls this `line`. */
  line: number;
  /** First line of a multi-line span, omitted for single-line comments. */
  startLine?: number;
  body: string;
  /** Rendered as a ```suggestion block; must cover whole lines. */
  suggestion?: string;
  /**
   * `file` attaches the comment to the whole file rather than a line — the escape hatch for a
   * passage GitHub cannot anchor because it is not part of the diff. Defaults to `line`.
   */
  subjectType?: 'line' | 'file';
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface SubmitReviewInput {
  event: ReviewEvent;
  body: string;
  comments: PendingComment[];
  /** Head SHA, required to attach file-level comments. */
  commitId?: string;
}

function renderBody(c: PendingComment): string {
  if (c.suggestion === undefined) return c.body;
  const fence = '```';
  return `${c.body}\n\n${fence}suggestion\n${c.suggestion}\n${fence}`;
}

function toApiComment(c: PendingComment) {
  const out: Record<string, unknown> = {
    path: c.path,
    line: c.line,
    side: c.side,
    body: renderBody(c),
  };
  // GitHub rejects start_line when it equals line, so only send it for genuine multi-line spans.
  if (c.startLine !== undefined && c.startLine < c.line) {
    out.start_line = c.startLine;
    out.start_side = c.side;
  }
  return out;
}

export class ReviewSubmitError extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
    readonly rejected: PendingComment[] = [],
  ) {
    super(message);
  }
}

export async function submitReview(
  gh: GitHubClient,
  owner: string,
  repo: string,
  number: number,
  input: SubmitReviewInput,
): Promise<{ id: number; url: string; fileCommentsPosted: number; fileCommentErrors: string[] }> {
  // File-level comments cannot ride along in the review: the batch endpoint's `comments[]`
  // accepts only path/position/body/line/side/start_line/start_side — `subject_type` exists
  // solely on the single-comment endpoint. So they go up separately, after the review itself.
  const lineComments = input.comments.filter((c) => c.subjectType !== 'file');
  const fileComments = input.comments.filter((c) => c.subjectType === 'file');

  try {
    const res = await gh.write<any>('POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      event: input.event,
      body: input.body,
      comments: lineComments.map(toApiComment),
    });

    const fileCommentErrors: string[] = [];
    let fileCommentsPosted = 0;

    if (fileComments.length > 0) {
      if (!input.commitId) {
        fileCommentErrors.push('No commit SHA was supplied, so file-level comments were not posted.');
      } else {
        for (const comment of fileComments) {
          try {
            await gh.write('POST', `/repos/${owner}/${repo}/pulls/${number}/comments`, {
              path: comment.path,
              body: renderBody(comment),
              commit_id: input.commitId,
              subject_type: 'file',
            });
            fileCommentsPosted++;
          } catch (err) {
            // The review is already posted; say precisely which notes did not make it rather
            // than failing the whole submission after the fact.
            fileCommentErrors.push(`${comment.path}: ${(err as Error).message}`);
          }
        }
      }
    }

    return { id: res.id, url: res.html_url, fileCommentsPosted, fileCommentErrors };
  } catch (err) {
    const detail = (err as { body?: unknown }).body;
    // A 422 here almost always means a comment landed on a line outside the diff. The UI greys
    // those out, but a PR can be updated underneath us, so name the offending files rather than
    // surfacing GitHub's opaque "Validation Failed".
    // Only the line comments were sent to this endpoint, so only they can be at fault.
    const message = describeValidationFailure(detail, lineComments);
    throw new ReviewSubmitError(message ?? (err as Error).message, detail);
  }
}

function describeValidationFailure(detail: unknown, comments: PendingComment[]): string | null {
  const body = detail as { message?: string; errors?: Array<{ message?: string; field?: string }> } | undefined;
  if (!body?.message) return null;
  const parts = (body.errors ?? []).map((e) => e.message).filter(Boolean);
  const where = comments.length
    ? ` Comments were on: ${[...new Set(comments.map((c) => `${c.path}:${c.line}`))].slice(0, 5).join(', ')}.`
    : '';
  const hint =
    body.message.includes('Validation Failed') || parts.some((p) => p?.includes('line'))
      ? ' GitHub only accepts comments on lines that appear in the diff — the pull request may have been updated since this page loaded. Reload and try again.'
      : '';
  return `${body.message}${parts.length ? `: ${parts.join('; ')}` : ''}.${where}${hint}`;
}

/** Reply into an existing thread. Uses the REST comment id, not the GraphQL node id. */
export async function replyToComment(
  gh: GitHubClient,
  owner: string,
  repo: string,
  number: number,
  commentId: number,
  body: string,
): Promise<unknown> {
  return gh.write('POST', `/repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies`, { body });
}

const RESOLVE = `
mutation Resolve($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

const UNRESOLVE = `
mutation Unresolve($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

/** Resolve state is GraphQL-only; there is no REST equivalent. */
export async function setThreadResolved(gh: GitHubClient, threadId: string, resolved: boolean): Promise<boolean> {
  const data = await gh.graphql<any>(resolved ? RESOLVE : UNRESOLVE, { id: threadId });
  const thread = data.resolveReviewThread?.thread ?? data.unresolveReviewThread?.thread;
  return Boolean(thread?.isResolved);
}
