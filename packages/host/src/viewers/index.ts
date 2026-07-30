import { lazy } from 'react';
import { defineViewer, BUILTIN_RANK, type ViewerPlugin } from '@pilcrow/viewer-api';
import { ViewerRegistry } from './registry.js';

/**
 * The built-in viewer set.
 *
 * Every `component` is `React.lazy`, so a viewer's dependencies land in their own Vite chunk and
 * never enter the entry bundle. That is what keeps adding a heavy viewer — bpmn-js, a notebook
 * renderer — from taxing everyone who never opens one.
 *
 * Phase 2 adds `pilcrow.config.ts` plus a Vite virtual module that `import()`s configured npm
 * packages into this same array. Because Vite does the bundling, React stays a singleton for
 * free: no import maps, no Module Federation, no runtime loader.
 */

const markdown = defineViewer({
  manifest: {
    id: 'pilcrow.markdown',
    displayName: 'Rich diff',
    selector: [{ filenamePattern: '**/*.md' }, { filenamePattern: '**/*.mdx' }],
    rank: BUILTIN_RANK,
    priority: 'default',
    safe: true,
    capabilities: { sourceMapping: true, diff: 'native', anchorGranularity: 'char' },
  },
  component: lazy(async () => ({ default: (await import('@pilcrow/viewer-markdown/src/MarkdownViewer.js')).MarkdownViewer })),
});

const sourceDiff = defineViewer({
  manifest: {
    id: 'pilcrow.source-diff',
    displayName: 'Source diff',
    // Claims everything at the worst rank, so resolution can never dead-end.
    selector: [{ filenamePattern: '**/*' }],
    rank: 9000,
    priority: 'default',
    safe: true,
    capabilities: { sourceMapping: true, diff: 'native', anchorGranularity: 'line' },
  },
  component: lazy(async () => ({
    default: (await import('@pilcrow/viewer-source-diff/src/SourceDiffViewer.js')).SourceDiffViewer,
  })),
});

export const builtinViewers: Array<ViewerPlugin<unknown>> = [markdown, sourceDiff];

export function createRegistry(overrides: Record<string, string> = {}): ViewerRegistry {
  const registry = new ViewerRegistry().registerAll(builtinViewers);
  for (const [path, id] of Object.entries(overrides)) registry.setOverride(path, id);
  return registry;
}

export { ViewerRegistry };
