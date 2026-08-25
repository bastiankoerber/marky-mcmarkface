import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { diffMarkdown } from './blockdiff.js';
import { parseMarkdown, parseStandaloneMermaid } from './parse.js';
import { renderToHtml } from './render.js';
import {
  ensureMermaidNodeContrast,
  prepareMermaidLinks,
  replacementForMermaid,
  sourceFromDiagram,
  sourceRangeFromDiagram,
} from './mermaid.js';
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

  it('reads only the renderer nonce when resolving an editable diagram range', () => {
    const dom = new JSDOM(
      '<!doctype html><main data-marky-mcmarkface-nonce="trusted">' +
        '<div data-marky-mcmarkface-pos="900:999" data-marky-mcmarkface-pos-trusted="12:48"></div>' +
        '</main>',
    );
    const root = dom.window.document.querySelector('main')!;
    expect(sourceRangeFromDiagram(root, root.firstElementChild!)).toEqual({ side: 'RIGHT', start: 12, end: 48 });
  });

  it('preserves Markdown fences when edited Mermaid source becomes a suggestion', () => {
    const document = 'Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter\n';
    const original = 'flowchart LR\n  A --> B';
    const start = document.indexOf('```mermaid');
    const end = document.indexOf('\n\nAfter');
    expect(
      replacementForMermaid(
        document,
        { side: 'RIGHT', start, end },
        original,
        'flowchart LR\n  A --> Changed',
      ),
    ).toBe('```mermaid\nflowchart LR\n  A --> Changed\n```');
  });

  it('preserves a standalone Mermaid file final newline around edited source', () => {
    const document = 'flowchart LR\n  A --> B\n';
    expect(
      replacementForMermaid(
        document,
        { side: 'RIGHT', start: 0, end: document.length },
        document,
        'flowchart TD\n  A --> C\n',
      ),
    ).toBe('flowchart TD\n  A --> C\n');
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

describe('Mermaid node contrast', () => {
  function nodeFixture(fill: string, labelStyle = ''): { svg: SVGElement; label: SVGGElement } {
    const dom = new JSDOM(
      '<!doctype html><body><svg xmlns="http://www.w3.org/2000/svg">' +
        '<g class="node"><rect class="label-container" style="fill:' +
        fill +
        ' !important"></rect><g class="label" style="' +
        labelStyle +
        '"><text><tspan>Node</tspan></text></g></g></svg></body>',
    );
    const svg = dom.window.document.querySelector('svg') as unknown as SVGElement;
    return { svg, label: svg.querySelector('g.label') as SVGGElement };
  }

  it('uses dark ink on an authored light node fill', () => {
    const { svg, label } = nodeFixture('#efe8ff');
    ensureMermaidNodeContrast(svg);
    expect(label.style.getPropertyValue('color')).toBe('rgb(31, 35, 40)');
    expect(label.querySelector('text')?.style.getPropertyValue('fill')).toBe('#1f2328');
  });

  it('uses light ink on an authored dark node fill', () => {
    const { svg, label } = nodeFixture('#172554');
    ensureMermaidNodeContrast(svg);
    expect(label.style.getPropertyValue('color')).toBe('rgb(246, 248, 250)');
    expect(label.querySelector('text')?.style.getPropertyValue('fill')).toBe('#f6f8fa');
  });

  it('chooses the higher-contrast ink for a mid-tone fill', () => {
    const { svg, label } = nodeFixture('#808080');
    ensureMermaidNodeContrast(svg);
    expect(label.style.getPropertyValue('color')).toBe('rgb(31, 35, 40)');
  });

  it('preserves an authored label colour', () => {
    const { svg, label } = nodeFixture('#efe8ff', 'color:#654321 !important');
    ensureMermaidNodeContrast(svg);
    expect(label.style.getPropertyValue('color')).toBe('rgb(101, 67, 33)');
    expect(label.querySelector('text')?.style.getPropertyValue('fill')).toBe('');
  });

  it('leaves theme-owned fills and labels untouched', () => {
    const dom = new JSDOM(
      '<!doctype html><body><svg xmlns="http://www.w3.org/2000/svg"><g class="node">' +
        '<rect class="label-container"></rect><g class="label"><text>Node</text></g>' +
        '</g></svg></body>',
    );
    const svg = dom.window.document.querySelector('svg') as unknown as SVGElement;
    ensureMermaidNodeContrast(svg);
    expect(svg.querySelector<SVGGElement>('g.label')?.getAttribute('style')).toBeNull();
  });
});
