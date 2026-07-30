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
