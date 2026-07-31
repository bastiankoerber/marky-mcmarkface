import type { PendingComment } from '../api.js';

/**
 * Pending comments carry a stable id rather than being addressed by array index. The rail only
 * shows the active file's comments, so its indices are into a *filtered* list — using those to
 * splice the full buffer deletes the wrong comment as soon as two files have pending notes.
 */
export type LocalComment = PendingComment & { id: string };

export interface DraftBuffer {
  /** The commit the line numbers were measured against. */
  headSha: string;
  summary: string;
  comments: LocalComment[];
}

const KEY = 'pilcrow.drafts.v1';
const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

type Store = Record<string, DraftBuffer>;

function read(): Store {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    // A corrupt or unavailable store must never take the review screen down with it.
    return {};
  }
}

function write(store: Store): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode, or quota. Losing persistence is survivable; throwing here is not.
  }
}

/**
 * Load the buffer for a pull request.
 *
 * Returns `stale` when the buffer was written against a different commit. Comment positions are
 * line numbers into the head file, so a new push moves the text out from under them — restoring
 * would place comments on whatever now occupies those rows. That is the exact failure this
 * project spends most of its effort preventing, so the drafts are dropped and the reader is
 * told, rather than quietly resurrected against the wrong lines.
 */
export function loadDrafts(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
): { buffer: DraftBuffer | null; stale: number } {
  const store = read();
  const key = prKey(owner, repo, number);
  const buffer = store[key];
  if (!buffer) return { buffer: null, stale: 0 };
  if (buffer.headSha !== headSha) {
    const stale = buffer.comments.length;
    delete store[key];
    write(store);
    return { buffer: null, stale };
  }
  return { buffer, stale: 0 };
}

export function saveDrafts(
  owner: string,
  repo: string,
  number: number,
  buffer: DraftBuffer,
): void {
  const store = read();
  const key = prKey(owner, repo, number);
  if (buffer.comments.length === 0 && !buffer.summary.trim()) delete store[key];
  else store[key] = buffer;
  write(store);
}

/** Every pull request holding unsent comments, for the dashboard's "you left something" hint. */
export function draftCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, buffer] of Object.entries(read())) {
    if (buffer?.comments?.length) counts[key] = buffer.comments.length;
  }
  return counts;
}

export const draftKey = prKey;
