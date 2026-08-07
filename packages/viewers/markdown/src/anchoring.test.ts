import { describe as suite, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { parseMarkdown, normaliseSource } from './parse.js';
import { renderToHtml } from './render.js';
import { describeRange, anchorRange } from './anchoring.js';

/**
 * These assert against `source.indexOf(...)` rather than against the renderer's own stamps, so
 * they are independent of the machinery under test — unlike the Phase 0 gate, which necessarily
 * shares helpers with it. Every construct here is one the plan flagged as a likely source of
 * offset drift.
 */

interface Fixture {
  root: HTMLElement;
  dom: JSDOM;
  source: string;
}

function render(markdown: string): Fixture {
  const source = normaliseSource(markdown);
  const html = renderToHtml(source, parseMarkdown(source));
  const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
  return { root: dom.window.document.getElementById('root') as unknown as HTMLElement, dom, source };
}

/** Build a DOM Range over the first occurrence of `needle` in the rendered text. */
function select(fx: Fixture, needle: string): Range {
  const walker = fx.dom.window.document.createTreeWalker(fx.root as unknown as Node, 4);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const idx = t.data.indexOf(needle);
    if (idx === -1) continue;
    const range = fx.dom.window.document.createRange();
    range.setStart(t, idx);
    range.setEnd(t, idx + needle.length);
    return range;
  }
  throw new Error(`rendered output has no text node containing ${JSON.stringify(needle)}`);
}

/** The offsets `needle` genuinely occupies in the source. The oracle. */
function truth(fx: Fixture, needle: string) {
  const start = fx.source.indexOf(needle);
  expect(start, `source must contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return { side: 'RIGHT' as const, start, end: start + needle.length };
}

function expectExact(markdown: string, needle: string) {
  const fx = render(markdown);
  const got = describeRange(fx.root, select(fx, needle));
  expect(got).toEqual(truth(fx, needle));
  const back = anchorRange(fx.root, got!);
  expect(back?.toString()).toBe(needle);
}

suite('markdown anchoring — character-exact cases', () => {
  it('plain paragraph text', () => {
    expectExact('The quick brown fox jumps.\n', 'brown fox');
  });

  it('text inside emphasis, without the delimiters', () => {
    expectExact('Install the **agent** by running this.\n', 'agent');
  });

  it('inline code, excluding its backticks', () => {
    // The mdast node spans the backticks; the stamp must narrow to the code text itself.
    expectExact('Run `brew install marky-mcmarkface` to begin.\n', 'brew install marky-mcmarkface');
  });

  it('fenced code, excluding the fences', () => {
    expectExact('```bash\nbrew install marky-mcmarkface\n```\n', 'brew install marky-mcmarkface');
  });

  it('link text, not the destination', () => {
    expectExact('See [the handbook](https://example.com/handbook) for details.\n', 'the handbook');
  });

  it('heading text, not the hashes', () => {
    expectExact('## Getting started\n\nBody.\n', 'Getting started');
  });

  it('a GFM table cell', () => {
    expectExact('| Tool | Status |\n| --- | --- |\n| marky-mcmarkface | shipping |\n', 'shipping');
  });

  it('a nested list item', () => {
    expectExact('- outer\n  - inner item\n    - deepest one\n', 'deepest one');
  });

  it('blockquote content', () => {
    expectExact('> quoted wisdom here\n', 'quoted wisdom here');
  });

  it('prose after front matter, with offsets shifted past it', () => {
    const fx = render('---\ntitle: Rock 13\n---\n\nSeamless orchestration.\n');
    const got = describeRange(fx.root, select(fx, 'Seamless orchestration'));
    // The point of this case: the offset must account for the front matter block above it.
    expect(got).toEqual(truth(fx, 'Seamless orchestration'));
    expect(got!.start).toBeGreaterThan(20);
  });

  it('text inside a raw HTML table', () => {
    // Without interior stamping this degrades to the whole <table> block.
    expectExact('<table>\n<tr><td>Replacement value</td></tr>\n</table>\n', 'Replacement value');
  });
});

suite('markdown anchoring — honest degradation', () => {
  it('widens to the element rather than emitting a wrong offset for escaped text', () => {
    const fx = render('A literal \\*asterisk\\* here.\n');
    const range = select(fx, 'asterisk');
    const got = describeRange(fx.root, range);
    expect(got).not.toBeNull();
    // The value differs from the raw source, so the leaf cannot be character-exact. What it must
    // never do is return an offset that is quietly a few characters off.
    expect(fx.source.slice(got!.start, got!.end)).toContain('asterisk');
  });

  it('covers both blocks when a selection spans a paragraph boundary', () => {
    const fx = render('First paragraph.\n\nSecond paragraph.\n');
    const doc = fx.dom.window.document;
    const a = select(fx, 'paragraph.');
    const b = select(fx, 'Second');
    const range = doc.createRange();
    range.setStart(a.startContainer, a.startOffset);
    range.setEnd(b.endContainer, b.endOffset);

    const got = describeRange(fx.root, range)!;
    const slice = fx.source.slice(got.start, got.end);
    expect(slice).toContain('paragraph.');
    expect(slice).toContain('Second');
  });

  it('never returns a collapsed or inverted range', () => {
    const fx = render('Some text.\n');
    const doc = fx.dom.window.document;
    const range = doc.createRange();
    const t = select(fx, 'Some').startContainer;
    range.setStart(t, 2);
    range.setEnd(t, 2);
    expect(describeRange(fx.root, range)).toBeNull();
  });
});

suite('markdown anchoring — round trip', () => {
  const docs = [
    'Plain sentence one.\n\nPlain sentence two.\n',
    '## Heading\n\nWith `code` and **bold** and [a link](https://x.test).\n',
    '| a | b |\n| --- | --- |\n| one | two |\n',
    '- item one\n- item two\n  - nested\n',
    '```ts\nconst x = 1;\n```\n',
    '<table><tr><td>raw cell</td></tr></table>\n',
  ];

  it('anchor(describe(r)) reselects the same text for every construct', () => {
    for (const md of docs) {
      const fx = render(md);
      const walker = fx.dom.window.document.createTreeWalker(fx.root as unknown as Node, 4);
      let n: Node | null;
      while ((n = walker.nextNode())) {
        const t = n as Text;
        if (t.data.trim().length < 3) continue;
        const range = fx.dom.window.document.createRange();
        range.setStart(t, 0);
        range.setEnd(t, t.data.length);

        const described = describeRange(fx.root, range);
        expect(described, `describe failed for ${JSON.stringify(t.data)} in ${JSON.stringify(md)}`).not.toBeNull();
        const back = anchorRange(fx.root, described!);
        expect(back?.toString(), `round trip lost text in ${JSON.stringify(md)}`).toContain(t.data.trim());
      }
    }
  });
});
