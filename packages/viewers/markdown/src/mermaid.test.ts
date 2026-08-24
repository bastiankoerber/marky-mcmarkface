import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { diffMarkdown } from './blockdiff.js';
import { parseMarkdown, parseStandaloneMermaid } from './parse.js';
import { renderToHtml } from './render.js';
import { prepareMermaidLinks, sourceFromDiagram } from './mermaid.js';
import { sanitizeMermaidSvg } from './sanitize.js';
import DOMPurify from 'dompurify';

function diagramFrom(html: string): Element {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const diagram = dom.window.document.querySelector('[data-marky-mcmarkface-mermaid]');
  if (!diagram) throw new Error('fixture did not render a Mermaid diagram');
  return diagram;
}

describe('Mermaid source discovery', () => {
  it('marks Mermaid fences without changing their exact source stamps', () => {
    const source = '```mermaid\ngraph TD\n  A --> B\n```\n';
    const diagram = diagramFrom(renderToHtml(source, parseMarkdown(source)));
    expect(sourceFromDiagram(diagram)).toBe('graph TD\n  A --> B');
    expect(diagram.getAttribute('data-marky-mcmarkface-pos')).toBe(`0:${source.length - 1}`);
  });

  it('does not treat other fenced code as a diagram', () => {
    const source = '```typescript\nconst mermaid = true\n```\n';
    expect(renderToHtml(source, parseMarkdown(source))).not.toContain('data-marky-mcmarkface-mermaid');
  });

  it('maps a standalone Mermaid file directly to offsets in the original source', () => {
    const source = 'flowchart LR\n  Request --> Response\n';
    const html = renderToHtml(source, parseStandaloneMermaid(source));
    const diagram = diagramFrom(html);
    expect(sourceFromDiagram(diagram)).toBe(source);
    expect(diagram.getAttribute('data-marky-mcmarkface-pos')).toBe(`0:${source.length}`);
    expect(diagram.querySelector('code')?.getAttribute('data-marky-mcmarkface-pos')).toBe(`0:${source.length}`);
  });

  it('renders head source only when a rich diff contains deletions', () => {
    const base = '```mermaid\ngraph LR\n  Old --> Node\n```\n';
    const head = '```mermaid\ngraph LR\n  New --> Node\n```\n';
    const headTree = parseMarkdown(head);
    const diff = diffMarkdown(base, parseMarkdown(base), head, headTree);
    const diagram = diagramFrom(renderToHtml(head, headTree, { blocks: diff.blocks, inline: diff.inline }));
    expect(diagram.textContent).toContain('Old');
    expect(sourceFromDiagram(diagram)).toBe('graph LR\n  New --> Node');
  });
});

describe('Mermaid SVG sanitisation', () => {
  it('removes scripts, event handlers, unsafe links, and external image loads', () => {
    const dom = new JSDOM('<!doctype html>');
    const purifier = DOMPurify(dom.window as unknown as Window & typeof globalThis);
    const output = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(1)</script><a href="javascript:alert(1)"><text>Node</text></a>' +
        '<style>.leak{fill:url(https://tracker.example/style)}</style>' +
        '<rect style="fill:url(https://tracker.example/attribute)" />' +
        '<image href="https://tracker.example/pixel.png" /></svg>',
      purifier,
    );
    expect(output).toContain('Node');
    expect(output).not.toMatch(/script|onload|javascript:|tracker\.example/i);
  });

  it('keeps repository-relative and ordinary HTTPS links', () => {
    const dom = new JSDOM('<!doctype html>');
    const purifier = DOMPurify(dom.window as unknown as Window & typeof globalThis);
    const output = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<a href="docs/details.md"><text>Repository</text></a>' +
        '<a href="https://example.com/docs"><text>Website</text></a></svg>',
      purifier,
    );
    expect(output).toContain('href="docs/details.md"');
    expect(output).toContain('href="https://example.com/docs"');
  });

  it('blocks protocol-relative, backslash-relative, and active-content links', () => {
    const dom = new JSDOM('<!doctype html>');
    const purifier = DOMPurify(dom.window as unknown as Window & typeof globalThis);
    const output = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<a href="//tracker.example/a"><text>A</text></a>' +
        '<a href="\\tracker.example/b"><text>B</text></a>' +
        '<a href="data:text/html,hello"><text>C</text></a></svg>',
      purifier,
    );
    expect(output).not.toMatch(/href=/i);
  });

  it('keeps local SVG marker references used for Mermaid arrows', () => {
    const dom = new JSDOM('<!doctype html>');
    const purifier = DOMPurify(dom.window as unknown as Window & typeof globalThis);
    const output = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(#arrowhead)" /></svg>',
      purifier,
    );
    expect(output).toContain('url(#arrowhead)');
  });
});

describe('Mermaid links', () => {
  it('normalises generated SVG anchors for safe new-tab navigation', () => {
    const dom = new JSDOM(
      '<!doctype html><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<a xlink:href="docs/details.md"><text>Details</text></a></svg>',
    );
    const svg = dom.window.document.querySelector('svg') as unknown as SVGElement;
    prepareMermaidLinks(svg);
    const link = svg.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('docs/details.md');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(link.getAttribute('role')).toBe('link');
    expect(link.getAttribute('aria-label')).toBe('Details');
  });
});
