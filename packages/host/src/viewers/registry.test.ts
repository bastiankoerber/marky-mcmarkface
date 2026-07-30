import { describe, it, expect } from 'vitest';
import { defineViewer, BUILTIN_RANK, type ViewerManifest } from '@pilcrow/viewer-api';
import { ViewerRegistry } from './registry.js';

function viewer(id: string, patterns: string[], extra: Partial<ViewerManifest> = {}) {
  return defineViewer({
    manifest: {
      id,
      displayName: id,
      selector: patterns.map((filenamePattern) => ({ filenamePattern })),
      capabilities: { sourceMapping: true, diff: 'new-only', anchorGranularity: 'char' },
      ...extra,
    },
    component: id,
  });
}

const markdown = viewer('pilcrow.markdown', ['**/*.md', '**/*.mdx'], { rank: BUILTIN_RANK });
const sourceDiff = viewer('pilcrow.source-diff', ['**/*'], { rank: 9000 });

describe('ViewerRegistry', () => {
  it('resolves by glob and prefers the lower rank', () => {
    const r = new ViewerRegistry().registerAll([sourceDiff, markdown]);
    expect(r.resolve('docs/intro.md')?.manifest.id).toBe('pilcrow.markdown');
    expect(r.resolve('src/main.go')?.manifest.id).toBe('pilcrow.source-diff');
  });

  it('never dead-ends, because source-diff claims everything', () => {
    const r = new ViewerRegistry().registerAll([markdown, sourceDiff]);
    for (const path of ['a.bin', 'deep/nested/thing.xyz', 'no-extension']) {
      expect(r.resolve(path), path).toBeDefined();
    }
  });

  it('matches a bare pattern against the basename so contributors need not write **/', () => {
    const r = new ViewerRegistry().register(viewer('csv', ['*.csv']));
    expect(r.resolve('deeply/nested/data.csv')?.manifest.id).toBe('csv');
  });

  it('lets a narrow selector beat a broad one via rank', () => {
    const spec = viewer('spec', ['**/docs/**/*.md'], { rank: 50 });
    const r = new ViewerRegistry().registerAll([markdown, spec]);
    expect(r.resolve('docs/guide/intro.md')?.manifest.id).toBe('spec');
    expect(r.resolve('README.md')?.manifest.id).toBe('pilcrow.markdown');
  });

  it('never auto-opens a priority:option viewer, but still offers it', () => {
    const raw = viewer('raw', ['**/*.md'], { rank: 1, priority: 'option' });
    const r = new ViewerRegistry().registerAll([raw, markdown]);
    expect(r.resolve('a.md')?.manifest.id).toBe('pilcrow.markdown');
    expect(r.candidates('a.md').map((v) => v.manifest.id)).toEqual(['raw', 'pilcrow.markdown']);
  });

  it('honours a user override, including over an option-priority viewer', () => {
    const raw = viewer('raw', ['**/*.md'], { priority: 'option' });
    const r = new ViewerRegistry().registerAll([markdown, raw]);
    r.setOverride('a.md', 'raw');
    expect(r.resolve('a.md')?.manifest.id).toBe('raw');
    r.setOverride('a.md', null);
    expect(r.resolve('a.md')?.manifest.id).toBe('pilcrow.markdown');
  });

  it('ignores an override whose viewer does not claim the path', () => {
    const r = new ViewerRegistry().registerAll([markdown, sourceDiff]);
    r.setOverride('main.go', 'pilcrow.markdown');
    expect(r.resolve('main.go')?.manifest.id).toBe('pilcrow.source-diff');
  });

  it('breaks rank ties by registration order, so resolution is deterministic', () => {
    const a = viewer('a', ['**/*.md'], { rank: 200 });
    const b = viewer('b', ['**/*.md'], { rank: 200 });
    expect(new ViewerRegistry().registerAll([a, b]).resolve('x.md')?.manifest.id).toBe('a');
    expect(new ViewerRegistry().registerAll([b, a]).resolve('x.md')?.manifest.id).toBe('b');
  });

  it('rejects a duplicate id and a selector-less viewer', () => {
    const r = new ViewerRegistry().register(markdown);
    expect(() => r.register(markdown)).toThrow(/duplicate viewer id/);
    expect(() => r.register(viewer('empty', []))).toThrow(/no selector/);
  });
});
