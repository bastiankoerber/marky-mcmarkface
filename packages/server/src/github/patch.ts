import type { DiffHunk, Side } from '@marky-mcmarkface/viewer-api';

/**
 * Unified-diff parsing, for one reason above all: **GitHub rejects a review comment on any line
 * that does not appear in the diff** with a 422. That has to be known up front so the UI can grey
 * out un-commentable prose, rather than discovered when the user hits Submit.
 */

export interface ParsedPatch {
  hunks: DiffHunk[];
  /** Lines addressable on the head side (context + additions). */
  rightLines: Array<[number, number]>;
  /** Lines addressable on the base side (context + deletions). */
  leftLines: Array<[number, number]>;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string | undefined | null): ParsedPatch {
  const hunks: DiffHunk[] = [];
  const right: number[] = [];
  const left: number[] = [];
  if (!patch) return { hunks, rightLines: [], leftLines: [] };

  let baseLine = 0;
  let headLine = 0;

  for (const line of patch.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      const baseStart = Number(header[1]);
      const baseLines = header[2] === undefined ? 1 : Number(header[2]);
      const headStart = Number(header[3]);
      const headLines = header[4] === undefined ? 1 : Number(header[4]);
      hunks.push({ baseStart, baseLines, headStart, headLines });
      baseLine = baseStart;
      headLine = headStart;
      continue;
    }
    if (hunks.length === 0) continue;

    const marker = line[0];
    if (marker === '+') {
      right.push(headLine++);
    } else if (marker === '-') {
      left.push(baseLine++);
    } else if (marker === ' ') {
      right.push(headLine++);
      left.push(baseLine++);
    }
    // '\' (no newline at end of file) advances neither side.
  }

  return { hunks, rightLines: toRanges(right), leftLines: toRanges(left) };
}

function toRanges(lines: number[]): Array<[number, number]> {
  if (lines.length === 0) return [];
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  let start = sorted[0]!;
  let prev = start;
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push([start, prev]);
    start = n;
    prev = n;
  }
  out.push([start, prev]);
  return out;
}

export function isCommentable(parsed: ParsedPatch, side: Side, from: number, to: number): boolean {
  const ranges = side === 'RIGHT' ? parsed.rightLines : parsed.leftLines;
  // Every line in the span must be addressable — GitHub validates start_line and line both.
  for (let line = from; line <= to; line++) {
    if (!ranges.some(([lo, hi]) => line >= lo && line <= hi)) return false;
  }
  return true;
}

/**
 * Snap a line span down to something GitHub will accept, or null when nothing in it is
 * addressable. Lets the UI offer "comment on the nearest commentable line" instead of failing.
 */
export function snapToCommentable(
  parsed: ParsedPatch,
  side: Side,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const ranges = side === 'RIGHT' ? parsed.rightLines : parsed.leftLines;
  for (const [lo, hi] of ranges) {
    if (to < lo || from > hi) continue;
    return { from: Math.max(from, lo), to: Math.min(to, hi) };
  }
  return null;
}
