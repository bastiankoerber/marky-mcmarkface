import { describe, expect, it } from 'vitest';
import { parseMarkdown, normaliseSource } from './parse.js';
import { renderToHtml } from './render.js';

function render(markdown: string, resolveImageUrl?: (source: string) => string | null): string {
  const source = normaliseSource(markdown);
  return renderToHtml(source, parseMarkdown(source), { resolveImageUrl });
}

describe('Markdown images', () => {
  it('uses the host resolver for an inline repository image', () => {
    const seen: string[] = [];
    const html = render('![Architecture](../assets/system.png "System")\n', (source) => {
      seen.push(source);
      return `/_marky/image/cap?source=${encodeURIComponent(source)}`;
    });

    expect(seen).toEqual(['../assets/system.png']);
    expect(html).toContain('src="/_marky/image/cap?source=..%2Fassets%2Fsystem.png"');
    expect(html).toContain('alt="Architecture"');
    expect(html).toContain('title="System"');
  });

  it('resolves full and shortcut reference-style images through definitions', () => {
    const resolver = (source: string) => `/resolved/${source}`;
    const html = render(
      '![Full][diagram]\n\n![Shortcut][]\n\n[diagram]: images/full.png\n[shortcut]: images/short.png\n',
      resolver,
    );
    expect(html).toContain('src="/resolved/images/full.png" alt="Full"');
    expect(html).toContain('src="/resolved/images/short.png" alt="Shortcut"');
  });

  it('emits no loadable source when the host blocks an image', () => {
    const html = render('![Tracking pixel](https://tracker.example/open.png)\n', () => null);
    expect(html).toContain('<img alt="Tracking pixel"');
    expect(html).not.toContain('tracker.example');
    expect(html).not.toContain(' src=');
  });
});
