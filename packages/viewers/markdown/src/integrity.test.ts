import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { parseMarkdown, normaliseSource } from './parse.js';
import { renderToHtml } from './render.js';
import { describeRange } from './anchoring.js';

/**
 * Review integrity — a pull request author attacking the reviewer.
 *
 * This is the threat this product uniquely creates: the reader is looking at *rendered* content
 * supplied by the person being reviewed, and a comment is a statement of record on GitHub. These
 * are not XSS tests (there is no XSS); they are tests that what you highlight is what you
 * comment on, and that what you see is what will merge.
 */

// Mirrors the production config in MarkdownViewer.tsx. Kept in sync deliberately: if that config
// is loosened, these tests should start failing.
function sanitize(html: string, window: Window): string {
  return DOMPurify(window as unknown as Window & typeof globalThis).sanitize(html, {
    ADD_TAGS: ['ins', 'del'],
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'class', 'srcdoc', 'formaction', 'ping'],
  });
}

function render(markdown: string, nonce: string) {
  const source = normaliseSource(markdown);
  const dom = new JSDOM('<!doctype html><body></body>');
  const html = sanitize(renderToHtml(source, parseMarkdown(source), { nonce }), dom.window as unknown as Window);
  const root = dom.window.document.createElement('div');
  root.setAttribute('data-pilcrow-root', '');
  root.setAttribute('data-pilcrow-nonce', nonce);
  root.innerHTML = html;
  dom.window.document.body.appendChild(root);
  return { dom, root: root as unknown as HTMLElement, source, html };
}

function selectText(dom: JSDOM, root: HTMLElement, needle: string): Range {
  const walker = dom.window.document.createTreeWalker(root as unknown as Node, 4);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const idx = t.data.indexOf(needle);
    if (idx === -1) continue;
    const range = dom.window.document.createRange();
    range.setStart(t, idx);
    range.setEnd(t, idx + needle.length);
    return range;
  }
  throw new Error(`no rendered text node contains ${JSON.stringify(needle)}`);
}

describe('a pull request cannot forge anchoring stamps', () => {
  // The attack: wrap innocuous text in an element carrying a stamp that points at a different
  // part of the file. `<pre>` matters because stampRawHtml deliberately skips its contents, so
  // there is no genuine inner stamp and the lookup walks up to the attacker's.
  const hostile = [
    'We grant the vendor unlimited access to all customer data.',
    '',
    '<div data-pilcrow-pos="0:40" data-pilcrow-x=""><pre>This release only fixes typos.</pre></div>',
    '',
  ].join('\n');

  it('ignores a forged stamp, so the comment cannot be redirected', () => {
    const { dom, root, source } = render(hostile, 'abc12345');
    const range = selectText(dom, root, 'This release only fixes typos.');
    const described = describeRange(root, range);

    if (described) {
      const quoted = source.slice(described.start, described.end);
      // Whatever it resolves to, it must not be the passage the attacker aimed at.
      expect(quoted).not.toContain('We grant the vendor');
      expect(quoted).toContain('typos');
    }
  });

  it('a forged stamp does resolve when the nonce is absent — proving the nonce is what stops it', () => {
    // Same document rendered without a nonce: the attacker's bare `data-pilcrow-pos` is now
    // indistinguishable from ours, and the comment lands on text the reviewer never read.
    const { dom, root, source } = render(hostile, '');
    root.removeAttribute('data-pilcrow-nonce');
    const range = selectText(dom, root, 'This release only fixes typos.');
    const described = describeRange(root, range);
    expect(described).not.toBeNull();
    // The reviewer highlighted "This release only fixes typos." and would have commented on
    // the vendor-access sentence instead. That is the whole attack, reproduced.
    const quoted = source.slice(described!.start, described!.end);
    expect(quoted).toContain('We grant the vendor');
    expect(quoted).not.toContain('typos');
  });
});

describe('a pull request cannot hide content or paint over the interface', () => {
  const window = new JSDOM('<!doctype html>').window as unknown as Window;

  it('strips style, so nothing can be hidden from the rendered review', () => {
    const out = sanitize('<div style="display:none">shipped but invisible</div>', window);
    expect(out).not.toContain('display:none');
    expect(out).not.toContain('style=');
    // The text stays — it is in the file, so the reviewer must be able to see it.
    expect(out).toContain('shipped but invisible');
  });

  it('strips a full-viewport overlay that would cover the Approve button', () => {
    const out = sanitize('<div style="position:fixed;inset:0;z-index:99999">OVERLAY</div>', window);
    expect(out).not.toContain('position:fixed');
  });

  it('strips class, so raw HTML cannot borrow the app’s own chrome', () => {
    const out = sanitize('<div class="banner ok">Pilcrow says this is safe</div>', window);
    expect(out).not.toContain('class=');
  });
});

describe('the sanitiser still blocks script execution', () => {
  const window = new JSDOM('<!doctype html>').window as unknown as Window;

  it.each([
    ['<img src=x onerror=alert(1)>', 'onerror'],
    ['<svg onload=alert(1)></svg>', 'onload'],
    ['<iframe src="javascript:alert(1)"></iframe>', 'iframe'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<meta http-equiv="refresh" content="0;url=//evil.test">', 'http-equiv'],
    ['<base href="//evil.test">', 'base'],
  ])('neutralises %s', (payload, forbidden) => {
    expect(sanitize(payload, window)).not.toContain(forbidden);
  });
});
