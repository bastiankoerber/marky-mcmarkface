import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { findDocumentText } from './documentSearch.js';

function documentRoot(html: string): HTMLElement {
  const dom = new JSDOM(`<!doctype html><main id="document">${html}</main>`);
  return dom.window.document.querySelector<HTMLElement>('#document')!;
}

describe('findDocumentText', () => {
  it('finds every match without regard to case', () => {
    const root = documentRoot('<p>Mark this mark.</p>');
    expect(findDocumentText(root, 'MARK').map((range) => range.toString())).toEqual(['Mark', 'mark']);
  });

  it('finds a phrase split across inline markup', () => {
    const root = documentRoot('<p>The <strong>rendered document</strong> is searchable.</p>');
    const matches = findDocumentText(root, 'The rendered');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.toString()).toBe('The rendered');
  });

  it('does not invent a match across block boundaries', () => {
    const root = documentRoot('<p>first</p><p>second</p>');
    expect(findDocumentText(root, 'firstsecond')).toEqual([]);
  });

  it('ignores hidden and non-document text', () => {
    const root = documentRoot('<p>Visible</p><p hidden>Hidden</p><script>Hidden</script>');
    expect(findDocumentText(root, 'Hidden')).toEqual([]);
  });

  it('returns no matches for an empty query', () => {
    expect(findDocumentText(documentRoot('<p>Anything</p>'), '')).toEqual([]);
  });
});
