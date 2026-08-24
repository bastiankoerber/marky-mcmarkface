import { beforeEach, describe, expect, it } from 'vitest';
import { draftCounts, draftKey, loadDrafts, saveDrafts } from './draftStore.js';

/** Minimal Storage stand-in; the store only ever uses getItem/setItem. */
function installStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
  return map;
}

const comment = (id: string, line: number) => ({
  id,
  path: 'docs/a.md',
  side: 'RIGHT' as const,
  line,
  body: 'note',
});

describe('draftStore', () => {
  let map: Map<string, string>;
  beforeEach(() => {
    map = installStorage();
  });

  it('round-trips a buffer for the same commit', () => {
    saveDrafts('o', 'r', 7, {
      headSha: 'abc',
      summary: 'looks good',
      comments: [{ ...comment('c1', 12), suggestion: 'replacement text' }],
    });
    const { buffer, stale } = loadDrafts('o', 'r', 7, 'abc');
    expect(stale).toBe(0);
    expect(buffer?.summary).toBe('looks good');
    expect(buffer?.comments).toHaveLength(1);
    expect(buffer?.comments[0]?.line).toBe(12);
    expect(buffer?.comments[0]?.suggestion).toBe('replacement text');
  });

  /*
   * The whole point of storing the head SHA. Comment positions are line numbers into the head
   * file, so restoring them against a newer commit pins them to whatever text now occupies
   * those rows — a wrong-line comment, which is the one failure this project cannot ship.
   */
  it('discards a buffer written against an older commit, and reports how many', () => {
    saveDrafts('o', 'r', 7, { headSha: 'abc', summary: '', comments: [comment('c1', 12), comment('c2', 30)] });
    const { buffer, stale } = loadDrafts('o', 'r', 7, 'def');
    expect(buffer).toBeNull();
    expect(stale).toBe(2);
    // And it is gone, so the warning is not repeated on every reload.
    expect(loadDrafts('o', 'r', 7, 'def').stale).toBe(0);
  });

  it('keeps buffers separate per pull request', () => {
    saveDrafts('o', 'r', 7, { headSha: 'abc', summary: '', comments: [comment('c1', 1)] });
    saveDrafts('o', 'r', 8, { headSha: 'zzz', summary: '', comments: [comment('c1', 2), comment('c2', 3)] });
    expect(loadDrafts('o', 'r', 7, 'abc').buffer?.comments).toHaveLength(1);
    expect(draftCounts()).toEqual({ [draftKey('o', 'r', 7)]: 1, [draftKey('o', 'r', 8)]: 2 });
  });

  it('keeps branch drafts separate from pull-request drafts and from other branches', () => {
    saveDrafts('o', 'r', 'branch:docs/update', { headSha: 'abc', summary: '', comments: [comment('c1', 1)] });
    saveDrafts('o', 'r', 'branch:docs/other', { headSha: 'def', summary: '', comments: [comment('c2', 2)] });
    expect(loadDrafts('o', 'r', 'branch:docs/update', 'abc').buffer?.comments).toHaveLength(1);
    expect(draftCounts()).toMatchObject({
      [draftKey('o', 'r', 'branch:docs/update')]: 1,
      [draftKey('o', 'r', 'branch:docs/other')]: 1,
    });
  });

  it('removes the entry once the buffer is empty, rather than leaving a husk behind', () => {
    saveDrafts('o', 'r', 7, { headSha: 'abc', summary: '', comments: [comment('c1', 1)] });
    saveDrafts('o', 'r', 7, { headSha: 'abc', summary: '', comments: [] });
    expect(loadDrafts('o', 'r', 7, 'abc').buffer).toBeNull();
    expect(draftCounts()).toEqual({});
  });

  it('survives a corrupt store instead of taking the review screen down', () => {
    map.set('marky-mcmarkface.drafts.v1', '{not json');
    expect(loadDrafts('o', 'r', 7, 'abc')).toEqual({ buffer: null, stale: 0 });
  });
});
