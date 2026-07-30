import { diffArrays, diffWordsWithSpace } from 'diff';
import type { Root, RootContent } from 'mdast';

/**
 * Rendered rich diff for markdown.
 *
 * Two levels, because prose changes read badly at only one of them:
 *
 *   Blocks   top-level nodes are matched by normalised text, so a paragraph that moved reads as
 *            a move rather than as a delete plus an unrelated add.
 *   Words    inside a changed block, a word-level diff marks exactly what shifted — the
 *            difference between "this paragraph changed" and "this word changed".
 *
 * Everything is expressed as **head source offsets**, which is what the renderer already speaks,
 * so marking up a diff costs nothing in anchoring accuracy.
 */

export type BlockKind = 'unchanged' | 'added' | 'removed' | 'changed';

export interface DiffBlock {
  kind: BlockKind;
  /** Offsets into head source. Null for a block that only exists in base. */
  head: { start: number; end: number } | null;
  /** Offsets into base source. Null for a block that only exists in head. */
  base: { start: number; end: number } | null;
}

/** A run of head text that is new, or a deletion to show at a head position. */
export type InlineChange =
  | { kind: 'ins'; start: number; end: number }
  | { kind: 'del'; at: number; text: string };

export interface MarkdownDiff {
  blocks: DiffBlock[];
  inline: InlineChange[];
  /** Head offsets of blocks that changed at all, for the "next change" navigation. */
  changedOffsets: number[];
}

interface Block {
  node: RootContent;
  start: number;
  end: number;
  text: string;
  key: string;
}

function blocksOf(source: string, tree: Root): Block[] {
  const out: Block[] = [];
  for (const node of tree.children) {
    const p = node.position;
    if (!p?.start.offset === undefined || p?.start.offset === undefined || p.end.offset === undefined) continue;
    const start = p.start.offset;
    const end = p.end.offset;
    const text = source.slice(start, end);
    out.push({ node, start, end, text, key: normalise(text) });
  }
  return out;
}

/** Matching key: whitespace-insensitive so reflowed prose is not reported as a rewrite. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  if (longer.length === 0) return 1;
  // Cheap token overlap. A real edit distance is not worth the cost here — this only has to
  // decide "is this the same paragraph, edited" versus "these are two different paragraphs".
  const at = new Set(a.split(/\s+/));
  const bt = b.split(/\s+/);
  const shared = bt.filter((t) => at.has(t)).length;
  return shared / Math.max(at.size, bt.length, 1);
}

const PAIR_THRESHOLD = 0.4;

export function diffMarkdown(baseSource: string | null, baseTree: Root | null, headSource: string, headTree: Root): MarkdownDiff {
  const head = blocksOf(headSource, headTree);

  // Added file: everything is new, and there is nothing to diff against.
  if (baseSource === null || baseTree === null) {
    return {
      blocks: head.map((b) => ({ kind: 'added' as const, head: { start: b.start, end: b.end }, base: null })),
      inline: [],
      changedOffsets: head.map((b) => b.start),
    };
  }

  const base = blocksOf(baseSource, baseTree);
  const script = diffArrays(
    base.map((b) => b.key),
    head.map((b) => b.key),
  );

  const blocks: DiffBlock[] = [];
  const inline: InlineChange[] = [];
  let bi = 0;
  let hi = 0;

  // diffArrays emits runs; a removed run immediately followed by an added run is where an edit
  // lives, so pair those up positionally and only then decide changed-vs-unrelated.
  const parts = script as Array<{ added?: boolean; removed?: boolean; count?: number }>;

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!;
    const count = part.count ?? 0;

    if (!part.added && !part.removed) {
      for (let i = 0; i < count; i++) {
        const h = head[hi++]!;
        blocks.push({ kind: 'unchanged', head: { start: h.start, end: h.end }, base: null });
        bi++;
      }
      continue;
    }

    if (part.removed) {
      const next = parts[p + 1];
      const removed = base.slice(bi, bi + count);
      bi += count;

      if (next?.added) {
        const addedCount = next.count ?? 0;
        const added = head.slice(hi, hi + addedCount);
        hi += addedCount;
        p++; // consume the paired added run

        const pairs = Math.min(removed.length, added.length);
        for (let i = 0; i < pairs; i++) {
          const b = removed[i]!;
          const h = added[i]!;
          if (similarity(b.key, h.key) >= PAIR_THRESHOLD) {
            blocks.push({ kind: 'changed', head: { start: h.start, end: h.end }, base: { start: b.start, end: b.end } });
            inline.push(...wordChanges(b.text, h.text, h.start));
          } else {
            blocks.push({ kind: 'removed', head: null, base: { start: b.start, end: b.end } });
            blocks.push({ kind: 'added', head: { start: h.start, end: h.end }, base: null });
          }
        }
        for (const b of removed.slice(pairs)) {
          blocks.push({ kind: 'removed', head: null, base: { start: b.start, end: b.end } });
        }
        for (const h of added.slice(pairs)) {
          blocks.push({ kind: 'added', head: { start: h.start, end: h.end }, base: null });
        }
        continue;
      }

      for (const b of removed) blocks.push({ kind: 'removed', head: null, base: { start: b.start, end: b.end } });
      continue;
    }

    // Added with no preceding removal.
    for (let i = 0; i < count; i++) {
      const h = head[hi++]!;
      blocks.push({ kind: 'added', head: { start: h.start, end: h.end }, base: null });
    }
  }

  return {
    blocks,
    inline: inline.sort(sortInline),
    changedOffsets: blocks.filter((b) => b.kind !== 'unchanged' && b.head).map((b) => b.head!.start),
  };
}

function sortInline(a: InlineChange, b: InlineChange): number {
  const ao = a.kind === 'ins' ? a.start : a.at;
  const bo = b.kind === 'ins' ? b.start : b.at;
  return ao - bo;
}

/** Word-level diff of two block texts, expressed in head source offsets. */
function wordChanges(baseText: string, headText: string, headStart: number): InlineChange[] {
  const out: InlineChange[] = [];
  let offset = headStart;

  for (const part of diffWordsWithSpace(baseText, headText)) {
    if (part.added) {
      out.push({ kind: 'ins', start: offset, end: offset + part.value.length });
      offset += part.value.length;
    } else if (part.removed) {
      // Deletions have no head span; they are shown at the point they were removed from.
      out.push({ kind: 'del', at: offset, text: part.value });
    } else {
      offset += part.value.length;
    }
  }

  return out;
}
