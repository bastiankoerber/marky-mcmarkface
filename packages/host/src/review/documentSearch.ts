const BLOCK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'DT',
  'DD',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * Find text as the viewer renders it, including phrases split by inline markup.
 *
 * Text nodes inside the same paragraph are joined directly, while block boundaries receive a
 * newline. Without that boundary, the end of one paragraph and start of the next become a word
 * that does not actually exist on the page.
 */
export function findDocumentText(root: HTMLElement, query: string): Range[] {
  if (!query) return [];

  const segments: TextSegment[] = [];
  let rendered = '';
  let previousBlock: Element | null = null;
  const showText = root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const value = textNode.data;
    const parent = textNode.parentElement;
    if (!value || !parent || parent.closest('script, style, template, [hidden], [aria-hidden="true"]')) continue;

    const block = nearestBlock(parent, root);
    if (rendered && previousBlock && block !== previousBlock) rendered += '\n';
    const start = rendered.length;
    rendered += value;
    segments.push({ node: textNode, start, end: rendered.length });
    previousBlock = block;
  }

  const ranges: Range[] = [];
  const matcher = new RegExp(escapeRegExp(query), 'giu');
  for (const match of rendered.matchAll(matcher)) {
    const start = match.index;
    const end = start + match[0].length;
    const first = segments.find((segment) => start >= segment.start && start < segment.end);
    const last = segments.find((segment) => end - 1 >= segment.start && end - 1 < segment.end);
    if (!first || !last) continue;

    const range = root.ownerDocument.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    ranges.push(range);
  }
  return ranges;
}

function nearestBlock(element: Element, root: HTMLElement): Element {
  let current: Element | null = element;
  while (current && current !== root) {
    if (BLOCK_ELEMENTS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
