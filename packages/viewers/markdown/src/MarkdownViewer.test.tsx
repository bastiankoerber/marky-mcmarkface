import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { ViewerHost } from '@marky-mcmarkface/viewer-api';

const unstub = () => vi.unstubAllGlobals();
afterEach(unstub);

describe('MarkdownViewer DOM lifetime', () => {
  it('keeps rendered nodes connected across a host-only rerender', async () => {
    const dom = new JSDOM('<!doctype html><div id="app"></div>', { pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    // DOMPurify binds itself to the ambient window at module evaluation time.
    const { MarkdownViewer } = await import('./MarkdownViewer.js');

    const container = dom.window.document.querySelector('#app')!;
    const reactRoot = createRoot(container);
    const host: ViewerHost = {
      onSelect: () => {},
      commentableRanges: () => [],
      requestComment: () => {},
      theme: 'light',
    };
    const registerAnchoring = vi.fn();
    const source = '# Stable heading\n';

    await act(async () => {
      reactRoot.render(
        <MarkdownViewer
          file={{ path: 'docs/readme.md', base: null, head: source, hunks: [] }}
          annotations={[]}
          host={host}
          registerAnchoring={registerAnchoring}
          mode="rich"
        />,
      );
    });
    const firstHeading = container.querySelector('h1');
    expect(firstHeading).not.toBeNull();

    // Review creates a fresh file/annotations wrapper whenever its rail position changes. The
    // authored HTML itself is unchanged, so async post-processors must keep the same live nodes.
    await act(async () => {
      reactRoot.render(
        <MarkdownViewer
          file={{ path: 'docs/readme.md', base: null, head: source, hunks: [] }}
          annotations={[]}
          host={host}
          registerAnchoring={registerAnchoring}
          mode="rich"
        />,
      );
    });
    expect(container.querySelector('h1')).toBe(firstHeading);
    expect(firstHeading?.isConnected).toBe(true);

    await act(async () => reactRoot.unmount());
    dom.window.close();
  });
});
