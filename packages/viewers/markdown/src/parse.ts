import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import type { Root } from 'mdast';

/**
 * Offsets are the whole contract, so the source must be normalised *before* parsing and the
 * normalised string is what every offset refers to from then on. CRLF would otherwise make
 * every mdast offset disagree with the string the host slices quotes out of.
 */
export function normaliseSource(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function parseMarkdown(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm(), frontmatter(['yaml', 'toml'])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml'])],
  });
}

/** Mermaid source files use the Markdown viewer without pretending their source has fences. */
export function isStandaloneMermaidPath(path: string): boolean {
  return /\.(?:mmd|mermaid)$/i.test(path);
}

/**
 * Represent a standalone Mermaid file as one fenced-code-equivalent mdast block.
 *
 * Building the node directly is important: wrapping the source in a synthetic Markdown fence
 * would shift every offset, breaking the viewer's source-mapping contract.
 */
export function parseStandaloneMermaid(source: string): Root {
  const end = pointAtEnd(source);
  const position = {
    start: { line: 1, column: 1, offset: 0 },
    end: { ...end, offset: source.length },
  };
  return {
    type: 'root',
    children: [{ type: 'code', lang: 'mermaid', value: source, position }],
    position,
  };
}

function pointAtEnd(source: string): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (const character of source) {
    if (character === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
