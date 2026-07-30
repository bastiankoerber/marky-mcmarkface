import { describe, it, expect } from 'vitest';
import { parsePatch, isCommentable, snapToCommentable } from './patch.js';

/**
 * These guard the one rule that decides whether a review submits or 422s: GitHub accepts a
 * comment only on a line that appears in the diff. Getting the line arithmetic wrong here means
 * comments land on the wrong prose, which is worse than failing outright.
 */

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '+two changed',
  '+two and a half',
  ' three',
  ' four',
  '@@ -20,3 +21,3 @@',
  ' twenty',
  '-twentyone',
  '+twentyone changed',
  ' twentytwo',
].join('\n');

describe('parsePatch', () => {
  it('reads hunk headers including the omitted-count form', () => {
    const single = parsePatch('@@ -5 +7 @@\n context');
    expect(single.hunks).toEqual([{ baseStart: 5, baseLines: 1, headStart: 7, headLines: 1 }]);
  });

  it('tracks head and base line numbers independently across a hunk', () => {
    const parsed = parsePatch(PATCH);
    expect(parsed.hunks).toHaveLength(2);
    // head: 1 (one), 2 (two changed), 3 (two and a half), 4 (three), 5 (four)
    expect(parsed.rightLines).toEqual([
      [1, 5],
      [21, 23],
    ]);
    // base: 1 (one), 2 (two), 3 (three), 4 (four)
    expect(parsed.leftLines).toEqual([
      [1, 4],
      [20, 22],
    ]);
  });

  it('treats an absent patch as nothing being commentable', () => {
    const parsed = parsePatch(undefined);
    expect(parsed.hunks).toEqual([]);
    expect(isCommentable(parsed, 'RIGHT', 1, 1)).toBe(false);
  });

  it('ignores the no-newline-at-eof marker, which advances neither side', () => {
    const parsed = parsePatch('@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b');
    expect(parsed.rightLines).toEqual([[1, 1]]);
    expect(parsed.leftLines).toEqual([[1, 1]]);
  });
});

describe('isCommentable', () => {
  const parsed = parsePatch(PATCH);

  it('accepts a line inside a hunk', () => {
    expect(isCommentable(parsed, 'RIGHT', 3, 3)).toBe(true);
  });

  it('rejects a line in the gap between hunks', () => {
    expect(isCommentable(parsed, 'RIGHT', 12, 12)).toBe(false);
  });

  it('rejects a span that straddles a gap, because GitHub validates both ends', () => {
    expect(isCommentable(parsed, 'RIGHT', 4, 21)).toBe(false);
  });

  it('checks the correct side', () => {
    expect(isCommentable(parsed, 'LEFT', 4, 4)).toBe(true);
    expect(isCommentable(parsed, 'RIGHT', 4, 4)).toBe(true);
    expect(isCommentable(parsed, 'LEFT', 23, 23)).toBe(false);
  });
});

describe('snapToCommentable', () => {
  const parsed = parsePatch(PATCH);

  it('trims a span down to the hunk it overlaps', () => {
    expect(snapToCommentable(parsed, 'RIGHT', 3, 12)).toEqual({ from: 3, to: 5 });
  });

  it('returns null when nothing in the span is addressable', () => {
    expect(snapToCommentable(parsed, 'RIGHT', 10, 15)).toBeNull();
  });

  it('leaves an already-valid span alone', () => {
    expect(snapToCommentable(parsed, 'RIGHT', 21, 22)).toEqual({ from: 21, to: 22 });
  });
});
