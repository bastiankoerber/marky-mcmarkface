import type { Nodes, Parents } from 'mdast';
import type { DiffBlock, InlineChange } from './blockdiff.js';

/**
 * mdast -> HTML, stamping every element with the source span it came from, and optionally
 * marking up a diff.
 *
 * Three attributes carry the whole story:
 *
 *   data-marky-mcmarkface-pos="<start>:<end>"   source char span of this element, on every element
 *   data-marky-mcmarkface-x                     the element's text maps 1:1 onto source[start..end], so
 *                                   character-level anchoring is exact
 *   data-marky-mcmarkface-change                added | removed | changed, on top-level blocks
 *
 * Diff marks are applied by *splitting stamped leaves*, never by wrapping opaque regions, so
 * rich-diff rendering costs nothing in anchoring accuracy — every fragment keeps its own exact
 * offsets and `describe()` behaves identically with or without a diff.
 */

const ESCAPE_RE = /[&<>"]/g;
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function esc(value: string): string {
  return value.replace(ESCAPE_RE, (c) => ESCAPES[c] ?? c);
}

interface Span {
  start: number;
  end: number;
}

export interface RenderOptions {
  /** Block-level diff results, keyed by head offset internally. */
  blocks?: DiffBlock[];
  /** Word-level changes in this document's coordinates. */
  inline?: InlineChange[];
  /**
   * Per-render random token appended to the position attribute name.
   *
   * Markdown may contain raw HTML, and `data-` attributes survive sanitisation — so without
   * this a pull request author can write their own `data-marky-mcmarkface-pos` and steer where the
   * reviewer's comment lands. Demonstrated: highlighting "This release only fixes typos."
   * produced a comment quoting an entirely different sentence. A nonce they cannot predict
   * makes forged stamps unreadable. Empty (tests, the spike) keeps the bare attribute name.
   */
  nonce?: string;
  /** Resolve an authored image source at the host's resource boundary. null means blocked. */
  resolveImageUrl?: ((source: string) => string | null) | undefined;
}

interface Ctx {
  source: string;
  posAttr: string;
  blockKind: Map<number, string>;
  ins: Array<{ start: number; end: number }>;
  del: Array<{ at: number; text: string }>;
  definitions: Map<string, { url: string; title: string | null }>;
  resolveImageUrl: ((source: string) => string | null) | undefined;
  depth: number;
}

const RAW_SKIP_CONTENT = new Set(['script', 'style', 'textarea', 'pre']);

function spanOf(node: Nodes): Span | null {
  const p = node.position;
  if (!p || p.start.offset === undefined || p.end.offset === undefined) return null;
  return { start: p.start.offset, end: p.end.offset };
}

function attrs(ctx: Ctx, span: Span | null, exact = false): string {
  if (!span) return '';
  const change = ctx.depth === 1 ? ctx.blockKind.get(span.start) : undefined;
  return (
    ` ${ctx.posAttr}="${span.start}:${span.end}"` +
    (exact ? ' data-marky-mcmarkface-x=""' : '') +
    (change ? ` data-marky-mcmarkface-change="${change}"` : '')
  );
}

function definitionKey(identifier: string): string {
  return identifier.trim().replace(/\s+/g, ' ').toLowerCase();
}

function collectDefinitions(node: Nodes, out: Ctx['definitions']): void {
  if (node.type === 'definition') {
    out.set(definitionKey(node.identifier), { url: node.url, title: node.title ?? null });
  }
  const maybeParent = node as { children?: Nodes[] };
  for (const child of maybeParent.children ?? []) collectDefinitions(child, out);
}

function image(ctx: Ctx, node: Nodes, source: string, alt: string, title: string | null): string {
  const resolved = ctx.resolveImageUrl ? ctx.resolveImageUrl(source) : source;
  const src = resolved ? ` src="${esc(resolved)}"` : '';
  const titleAttr = title ? ` title="${esc(title)}"` : '';
  return `<img${src} alt="${esc(alt)}"${titleAttr}${attrs(ctx, spanOf(node))}>`;
}

/**
 * Locate a leaf's decoded `value` inside the raw source it was parsed from.
 *
 * `inlineCode` spans include their backticks and a fenced `code` node spans its fences, so a
 * node's own offsets are wider than the text that renders. Finding the value inside the raw
 * slice recovers the true span. When parsing transformed the value — a backslash escape, an
 * entity — indexOf fails and the leaf is honestly reported as non-exact rather than given an
 * offset that is quietly a few characters wrong.
 */
function exactSpan(source: string, span: Span | null, value: string): { span: Span; exact: boolean } | null {
  if (!span) return null;
  if (value.length === 0) return { span, exact: false };
  const raw = source.slice(span.start, span.end);
  if (raw === value) return { span, exact: true };
  const idx = raw.indexOf(value);
  if (idx !== -1 && raw.indexOf(value, idx + 1) === -1) {
    return { span: { start: span.start + idx, end: span.start + idx + value.length }, exact: true };
  }
  return { span, exact: false };
}

/**
 * Emit a stamped text leaf, split at any diff boundary that falls inside it.
 *
 * Each fragment carries its own exact offsets, so a word marked as an insertion anchors exactly
 * as well as one that was not touched.
 */
function emitLeaf(ctx: Ctx, tag: string, span: Span, value: string, extra: string): string {
  const cuts = new Set<number>([span.start, span.end]);
  for (const r of ctx.ins) {
    if (r.end > span.start && r.start < span.end) {
      cuts.add(Math.max(span.start, r.start));
      cuts.add(Math.min(span.end, r.end));
    }
  }
  for (const d of ctx.del) {
    if (d.at > span.start && d.at < span.end) cuts.add(d.at);
  }

  const points = [...cuts].sort((a, b) => a - b);
  let out = '';

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;

    for (const d of ctx.del) {
      if (d.at === from) out += `<del data-marky-mcmarkface-del="">${esc(d.text)}</del>`;
    }

    if (to <= from) continue;
    const text = value.slice(from - span.start, to - span.start);
    const inserted = ctx.ins.some((r) => from >= r.start && to <= r.end);
    const stamped = `<${tag}${extra} ${ctx.posAttr}="${from}:${to}" data-marky-mcmarkface-x="">${esc(text)}</${tag}>`;
    out += inserted ? `<ins data-marky-mcmarkface-ins="">${stamped}</ins>` : stamped;
  }

  for (const d of ctx.del) {
    if (d.at === span.end) out += `<del data-marky-mcmarkface-del="">${esc(d.text)}</del>`;
  }

  return out;
}

function leaf(ctx: Ctx, node: Nodes, value: string, tag: string, extra = ''): string {
  const resolved = exactSpan(ctx.source, spanOf(node), value);
  if (!resolved) return `<${tag}${extra}>${esc(value)}</${tag}>`;
  if (!resolved.exact) {
    return `<${tag}${extra}${attrs(ctx, resolved.span, false)}>${esc(value)}</${tag}>`;
  }
  return emitLeaf(ctx, tag, resolved.span, value, extra);
}

/**
 * Wrap the text runs of a raw HTML block in stamped spans.
 *
 * The block is emitted verbatim, so every character of rendered text sits at a known source
 * offset; only markup has to be skipped. Anything that cannot be confidently classified is left
 * unwrapped, degrading that run to the enclosing block rather than risking a wrong offset.
 */
function stampRawHtml(value: string, base: number, posAttr: string): string {
  let out = '';
  let i = 0;

  const flushText = (from: number, to: number) => {
    const text = value.slice(from, to);
    if (text.trim().length === 0) {
      out += text;
      return;
    }
    out += `<span ${posAttr}="${base + from}:${base + to}" data-marky-mcmarkface-x="">${text}</span>`;
  };

  while (i < value.length) {
    const lt = value.indexOf('<', i);
    if (lt === -1) {
      flushText(i, value.length);
      break;
    }
    if (lt > i) flushText(i, lt);

    if (value.startsWith('<!--', lt)) {
      const close = value.indexOf('-->', lt);
      const end = close === -1 ? value.length : close + 3;
      out += value.slice(lt, end);
      i = end;
      continue;
    }

    const gt = value.indexOf('>', lt);
    if (gt === -1) {
      out += value.slice(lt);
      break;
    }

    const tag = value.slice(lt, gt + 1);
    out += tag;
    i = gt + 1;

    const name = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (name && RAW_SKIP_CONTENT.has(name) && !tag.endsWith('/>')) {
      const close = value.toLowerCase().indexOf(`</${name}`, i);
      const end = close === -1 ? value.length : close;
      out += value.slice(i, end);
      i = end;
    }
  }

  return out;
}

function children(ctx: Ctx, node: Parents): string {
  ctx.depth++;
  const out = node.children.map((child) => renderNode(ctx, child as Nodes)).join('');
  ctx.depth--;
  return out;
}

function wrap(ctx: Ctx, node: Nodes, tag: string, inner: () => string, extra = ''): string {
  const open = `<${tag}${extra}${attrs(ctx, spanOf(node))}>`;
  return `${open}${inner()}</${tag}>`;
}

/**
 * One table row. `head` selects `<th>` over `<td>`; `align` is applied per column so a numeric
 * column reads right-aligned the way the author wrote it.
 */
function renderRow(ctx: Ctx, row: Nodes, align: Array<string | null | undefined>, head: boolean): string {
  const cells = (row as Parents).children;
  const tag = head ? 'th' : 'td';
  ctx.depth++;
  const inner = cells
    .map((cell, index) => {
      const at = align[index];
      const style = at ? ` style="text-align:${at}"` : '';
      const scope = head ? ' scope="col"' : '';
      return `<${tag}${scope}${style}${attrs(ctx, spanOf(cell as Nodes))}>${children(ctx, cell as Parents)}</${tag}>`;
    })
    .join('');
  ctx.depth--;
  return `<tr${attrs(ctx, spanOf(row))}>${inner}</tr>`;
}

function renderNode(ctx: Ctx, node: Nodes): string {
  // Front matter is not part of the rendered document. Keep it addressable but hidden so it can
  // still be commented on from the source view. Handled ahead of the switch because `toml` only
  // joins the mdast union when mdast-util-frontmatter's types are in scope.
  const type: string = node.type;
  if (type === 'yaml' || type === 'toml') {
    return `<div${attrs(ctx, spanOf(node))} data-marky-mcmarkface-frontmatter="" hidden></div>`;
  }

  switch (node.type) {
    case 'root':
      return children(ctx, node);
    case 'paragraph':
      return wrap(ctx, node, 'p', () => children(ctx, node));
    case 'heading':
      return wrap(ctx, node, `h${node.depth}`, () => children(ctx, node));
    case 'blockquote':
      return wrap(ctx, node, 'blockquote', () => children(ctx, node));
    case 'list':
      return wrap(
        ctx,
        node,
        node.ordered ? 'ol' : 'ul',
        () => children(ctx, node),
        node.ordered && node.start != null && node.start !== 1 ? ` start="${node.start}"` : '',
      );
    case 'listItem':
      return wrap(ctx, node, 'li', () => children(ctx, node));
    case 'thematicBreak':
      return `<hr${attrs(ctx, spanOf(node))}>`;
    case 'break':
      return `<br${attrs(ctx, spanOf(node))}>`;
    case 'text':
      return leaf(ctx, node, node.value, 'span');
    case 'inlineCode':
      return leaf(ctx, node, node.value, 'code');
    case 'code': {
      // The <pre> carries the full fenced span; the inner <code> carries just the program text,
      // so a comment on line 3 of a snippet anchors to line 3 and not to the fence.
      const span = spanOf(node);
      const resolved = exactSpan(ctx.source, span, node.value);
      const lang = node.lang ? ` data-lang="${esc(node.lang)}"` : '';
      const inner = resolved?.exact
        ? emitLeaf(ctx, 'code', resolved.span, node.value, lang)
        : `<code${lang}${attrs(ctx, resolved?.span ?? null)}>${esc(node.value)}</code>`;
      return `<pre${attrs(ctx, span)}>${inner}</pre>`;
    }
    case 'strong':
      return wrap(ctx, node, 'strong', () => children(ctx, node));
    case 'emphasis':
      return wrap(ctx, node, 'em', () => children(ctx, node));
    case 'delete':
      return wrap(ctx, node, 'del', () => children(ctx, node));
    case 'link':
      return wrap(ctx, node, 'a', () => children(ctx, node), ` href="${esc(node.url)}" rel="noreferrer" target="_blank"`);
    case 'linkReference':
      return wrap(ctx, node, 'a', () => children(ctx, node), ' data-marky-mcmarkface-ref=""');
    case 'image':
      return image(ctx, node, node.url, node.alt ?? '', node.title ?? null);
    case 'imageReference': {
      const definition = ctx.definitions.get(definitionKey(node.identifier));
      return definition
        ? image(ctx, node, definition.url, node.alt ?? '', definition.title)
        : image(ctx, node, '', node.alt ?? '', null);
    }
    /*
     * GFM tables: the first row is the header, and the `align` array applies per column.
     *
     * Every cell used to render as a plain `<td>` inside a bare `<table>`, so a table arrived as
     * an undifferentiated grid — no bold header, no alignment, nothing to read a column against.
     * Reviewers responded by asking authors to "make this a proper table" for tables that were
     * already correct Markdown, which is the worst kind of rendering bug: it sends the reader
     * after the wrong culprit.
     */
    case 'table': {
      const rows = node.children;
      const align = node.align ?? [];
      const head = rows[0] ? renderRow(ctx, rows[0], align, true) : '';
      const body = rows
        .slice(1)
        .map((row) => renderRow(ctx, row, align, false))
        .join('');
      return wrap(ctx, node, 'table', () => `<thead>${head}</thead><tbody>${body}</tbody>`);
    }
    // Reached only if a row or cell is rendered outside its table — keep them addressable.
    case 'tableRow':
      return wrap(ctx, node, 'tr', () => children(ctx, node));
    case 'tableCell':
      return wrap(ctx, node, 'td', () => children(ctx, node));
    case 'footnoteReference':
      return `<sup${attrs(ctx, spanOf(node))}>${esc(node.identifier)}</sup>`;
    case 'footnoteDefinition':
      return wrap(ctx, node, 'section', () => children(ctx, node), ' data-marky-mcmarkface-footnote=""');
    case 'html': {
      const span = spanOf(node);
      const inner = span ? stampRawHtml(node.value, span.start, ctx.posAttr) : node.value;
      return `<span${attrs(ctx, span)} data-marky-mcmarkface-raw="">${inner}</span>`;
    }
    case 'definition':
      return `<span${attrs(ctx, spanOf(node))} data-marky-mcmarkface-definition="" hidden></span>`;
    default: {
      const anyNode = node as { children?: unknown };
      if (Array.isArray(anyNode.children)) {
        return wrap(ctx, node, 'div', () => children(ctx, node as unknown as Parents));
      }
      return '';
    }
  }
}

export function renderToHtml(source: string, tree: Nodes, options: RenderOptions = {}): string {
  const blockKind = new Map<number, string>();
  for (const b of options.blocks ?? []) {
    if (b.head && b.kind !== 'unchanged') blockKind.set(b.head.start, b.kind);
  }

  const definitions = new Map<string, { url: string; title: string | null }>();
  collectDefinitions(tree, definitions);

  const ctx: Ctx = {
    source,
    posAttr: options.nonce ? `data-marky-mcmarkface-pos-${options.nonce}` : 'data-marky-mcmarkface-pos',
    blockKind,
    ins: (options.inline ?? []).filter((c): c is Extract<InlineChange, { kind: 'ins' }> => c.kind === 'ins'),
    del: (options.inline ?? []).filter((c): c is Extract<InlineChange, { kind: 'del' }> => c.kind === 'del'),
    definitions,
    resolveImageUrl: options.resolveImageUrl,
    depth: 0,
  };

  return renderNode(ctx, tree as Nodes);
}
