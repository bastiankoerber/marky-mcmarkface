import type { Side, SourceRange } from '@marky-mcmarkface/viewer-api';

/**
 * describe() / anchor() for the built-in markdown viewer.
 *
 * Everything here reads only the `data-marky-mcmarkface-pos` / `data-marky-mcmarkface-x` stamps that render.ts emitted,
 * so it never needs the mdast tree at runtime and works the same on a server-rendered string as
 * on a live React tree.
 */

const SHOW_TEXT = 4;

interface Stamp {
  el: Element;
  start: number;
  end: number;
  exact: boolean;
}

/**
 * The position attribute for this render.
 *
 * The nonce lives on the host-rendered root element, outside anything DOMPurify touches, so a
 * pull request cannot set or read it. Falling back to the bare name keeps tests and the
 * anchoring spike working, which render without a nonce.
 */
function posAttrFor(root: Element): string {
  const nonce = root.getAttribute('data-marky-mcmarkface-nonce');
  return nonce ? `data-marky-mcmarkface-pos-${nonce}` : 'data-marky-mcmarkface-pos';
}

function readStamp(el: Element, posAttr: string): Stamp | null {
  const raw = el.getAttribute(posAttr);
  if (!raw) return null;
  const sep = raw.indexOf(':');
  if (sep === -1) return null;
  const start = Number(raw.slice(0, sep));
  const end = Number(raw.slice(sep + 1));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { el, start, end, exact: el.hasAttribute('data-marky-mcmarkface-x') };
}

function closestStamp(node: Node, root: Element): Stamp | null {
  const posAttr = posAttrFor(root);
  let el: Element | null =
    node.nodeType === 1 ? (node as Element) : (node.parentElement as Element | null);
  while (el) {
    const stamp = readStamp(el, posAttr);
    if (stamp) return stamp;
    if (el === root) break;
    el = el.parentElement;
  }
  return null;
}

function firstTextNode(node: Node): Text | null {
  if (node.nodeType === 3) return node as Text;
  const doc = node.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(node, SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function lastTextNode(node: Node): Text | null {
  if (node.nodeType === 3) return node as Text;
  const doc = node.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(node, SHOW_TEXT);
  let last: Text | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) last = n as Text;
  return last;
}

/**
 * Selections routinely land on element boundaries rather than inside text — a triple-click, or
 * dragging past the end of a paragraph. Resolve such a point to a concrete text position first,
 * otherwise `closestStamp` returns the container element and every such selection degrades to
 * block granularity for no reason.
 */
function normalisePoint(container: Node, offset: number, edge: 'start' | 'end'): { node: Node; offset: number } {
  if (container.nodeType === 3) return { node: container, offset };
  const kids = container.childNodes;
  if (edge === 'start') {
    for (let i = offset; i < kids.length; i++) {
      const t = firstTextNode(kids[i]!);
      if (t) return { node: t, offset: 0 };
    }
    for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
      const t = lastTextNode(kids[i]!);
      if (t) return { node: t, offset: t.data.length };
    }
  } else {
    for (let i = Math.min(offset, kids.length) - 1; i >= 0; i--) {
      const t = lastTextNode(kids[i]!);
      if (t) return { node: t, offset: t.data.length };
    }
    for (let i = offset; i < kids.length; i++) {
      const t = firstTextNode(kids[i]!);
      if (t) return { node: t, offset: 0 };
    }
  }
  return { node: container, offset };
}

/** How many characters of text sit inside `root` before the point (container, offset). */
function precedingTextLength(root: Element, container: Node, offset: number): number | null {
  const doc = root.ownerDocument;
  if (!doc) return null;
  if (!root.contains(container.nodeType === 3 ? (container.parentNode as Node) : container)) {
    return null;
  }
  let acc = 0;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    if (text === container) return acc + Math.min(offset, text.data.length);
    acc += text.data.length;
  }
  return acc;
}

/** Inverse of precedingTextLength: the text position `charIndex` characters into `root`. */
function textPointAt(root: Element, charIndex: number): { node: Node; offset: number } | null {
  const doc = root.ownerDocument;
  if (!doc) return null;
  let acc = 0;
  let last: Text | null = null;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n as Text;
    if (charIndex <= acc + text.data.length) {
      return { node: text, offset: charIndex - acc };
    }
    acc += text.data.length;
    last = text;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: root, offset: 0 };
}

function pointToSource(root: Element, container: Node, offset: number, edge: 'start' | 'end'): number | null {
  const point = normalisePoint(container, offset, edge);
  const stamp = closestStamp(point.node, root);
  if (!stamp) return null;
  // A non-exact stamp (escaped text, raw HTML, an entity) cannot be trusted at character
  // granularity, so widen to the whole element rather than emit an offset that is subtly wrong.
  if (!stamp.exact) return edge === 'start' ? stamp.start : stamp.end;
  const within = precedingTextLength(stamp.el, point.node, point.offset);
  if (within === null) return edge === 'start' ? stamp.start : stamp.end;
  return Math.min(stamp.start + within, stamp.end);
}

export function describeRange(root: HTMLElement, range: Range, side: Side = 'RIGHT'): SourceRange | null {
  const start = pointToSource(root, range.startContainer, range.startOffset, 'start');
  const end = pointToSource(root, range.endContainer, range.endOffset, 'end');
  if (start === null || end === null) return null;
  if (end <= start) return null;
  return { side, start, end };
}

function allStamps(root: Element): Stamp[] {
  const posAttr = posAttrFor(root);
  const out: Stamp[] = [];
  const self = readStamp(root, posAttr);
  if (self) out.push(self);
  for (const el of Array.from(root.querySelectorAll(`[${posAttr}]`))) {
    const stamp = readStamp(el, posAttr);
    if (stamp) out.push(stamp);
  }
  return out;
}

function sourceToPoint(root: Element, offset: number, edge: 'start' | 'end'): { node: Node; offset: number } | null {
  const stamps = allStamps(root);

  // Prefer an exact leaf: it is the only thing that can place the point at character precision.
  let best: Stamp | null = null;
  for (const stamp of stamps) {
    if (!stamp.exact) continue;
    const contains = edge === 'start' ? offset >= stamp.start && offset < stamp.end : offset > stamp.start && offset <= stamp.end;
    if (!contains) continue;
    if (!best || stamp.end - stamp.start < best.end - best.start) best = stamp;
  }
  if (best) return textPointAt(best.el, offset - best.start);

  // No exact leaf covers it. Fall back to the tightest element whose span contains the offset
  // and return its boundary — a block-granularity highlight, which is the honest answer.
  let block: Stamp | null = null;
  for (const stamp of stamps) {
    if (offset < stamp.start || offset > stamp.end) continue;
    if (!block || stamp.end - stamp.start < block.end - block.start) block = stamp;
  }
  if (!block) return null;
  return edge === 'start'
    ? (firstTextNode(block.el) ? { node: firstTextNode(block.el)!, offset: 0 } : { node: block.el, offset: 0 })
    : (lastTextNode(block.el)
        ? { node: lastTextNode(block.el)!, offset: lastTextNode(block.el)!.data.length }
        : { node: block.el, offset: block.el.childNodes.length });
}

export function anchorRange(root: HTMLElement, range: SourceRange): Range | null {
  const doc = root.ownerDocument;
  if (!doc) return null;
  const start = sourceToPoint(root, range.start, 'start');
  const end = sourceToPoint(root, range.end, 'end');
  if (!start || !end) return null;
  const out = doc.createRange();
  try {
    out.setStart(start.node, start.offset);
    out.setEnd(end.node, end.offset);
  } catch {
    return null;
  }
  if (out.collapsed) return null;
  return out;
}

/**
 * Exposed for the conformance kit and the Phase 0 gate, which need to build an independent
 * ground truth rather than trusting describe() to grade its own homework.
 */
export const __internals = { readStamp, closestStamp, precedingTextLength, textPointAt };

/** True when every stamp covering this span is exact, i.e. character-precise anchoring holds. */
export function isExactlyAnchorable(root: HTMLElement, range: SourceRange): boolean {
  for (const stamp of allStamps(root)) {
    if (!stamp.exact) continue;
    if (range.start >= stamp.start && range.end <= stamp.end) return true;
  }
  return false;
}
