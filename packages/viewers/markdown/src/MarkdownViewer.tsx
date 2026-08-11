import { useEffect, useMemo, useRef } from 'react';
import type { AnchoringImpl, SourceRange, ViewerProps } from '@marky-mcmarkface/viewer-api';
import { parseMarkdown, normaliseSource } from './parse.js';
import { renderToHtml } from './render.js';
import { diffMarkdown } from './blockdiff.js';
import { describeRange, anchorRange } from './anchoring.js';
import { sanitizeRenderedHtml } from './sanitize.js';

/**
 * The built-in markdown viewer: a rendered rich diff you can select prose in.
 *
 * Sanitisation is not optional here. This renders Markdown from an arbitrary pull request inside
 * a page whose origin can reach a local server holding a `repo`-scoped GitHub token, and Markdown
 * permits raw HTML by design. DOMPurify keeps `data-*` attributes, so the position stamps that
 * anchoring depends on survive while scripts and event handlers do not.
 */

export type ViewMode = 'rich' | 'final';

export interface MarkdownViewerProps extends ViewerProps {
  mode?: ViewMode;
}

export function MarkdownViewer({ file, host, registerAnchoring, mode = 'rich' }: MarkdownViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  /*
   * A fresh nonce per render, namespacing the position attribute.
   *
   * Markdown may contain raw HTML and `data-` attributes survive sanitisation, so without this
   * a pull request author could ship their own `data-marky-mcmarkface-pos` and steer where a reviewer's
   * comment lands — highlighting one sentence while the posted comment quotes another. The
   * nonce is generated here, outside anything the document can influence, and is carried on the
   * root element rather than inside the sanitised HTML.
   */
  const { html, nonce } = useMemo(() => {
    const token = Math.random().toString(36).slice(2, 10);
    const head = normaliseSource(file.head ?? '');
    const headTree = parseMarkdown(head);
    const resolveImageUrl = host.resolveImageUrl
      ? (source: string) => host.resolveImageUrl!(source, file.path)
      : undefined;

    // 'final' is the deliberate no-markup read. Everything else gets the diff — including a
    // newly added file, where `base` is null and every block is new. Skipping the diff there
    // would render an added file identically to an unchanged one.
    if (mode === 'final') {
      return {
        html: sanitizeRenderedHtml(renderToHtml(head, headTree, { nonce: token, resolveImageUrl })),
        nonce: token,
      };
    }

    const base = file.base === null ? null : normaliseSource(file.base);
    const baseTree = base === null ? null : parseMarkdown(base);
    const diff = diffMarkdown(base, baseTree, head, headTree);
    return {
      html: sanitizeRenderedHtml(
        renderToHtml(head, headTree, { blocks: diff.blocks, inline: diff.inline, nonce: token, resolveImageUrl }),
      ),
      nonce: token,
    };
  }, [file.head, file.base, file.path, host.resolveImageUrl, mode]);

  // Register the anchoring implementation. The host owns everything downstream of this — the
  // viewer's entire contribution to commenting is these five functions.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const layoutListeners = new Set<() => void>();
    const observer = new ResizeObserver(() => layoutListeners.forEach((cb) => cb()));
    observer.observe(root);

    // A blocked, missing, or unsupported image should not disappear as a tiny broken icon. The
    // replacement is created after sanitisation, so hostile Markdown cannot borrow its class or
    // hide arbitrary prose with it. Copy the image's source stamp so it remains commentable.
    const imageCleanups: Array<() => void> = [];
    for (const img of root.querySelectorAll('img')) {
      let replaced = false;
      const unavailable = () => {
        if (replaced || !img.isConnected) return;
        replaced = true;
        const fallback = root.ownerDocument.createElement('span');
        fallback.className = 'md-image-unavailable';
        fallback.textContent = img.alt ? `Image unavailable: ${img.alt}` : 'Image unavailable';
        for (const attribute of img.attributes) {
          if (
            attribute.name.startsWith('data-marky-mcmarkface-pos') ||
            attribute.name === 'data-marky-mcmarkface-change'
          ) {
            fallback.setAttribute(attribute.name, attribute.value);
          }
        }
        img.replaceWith(fallback);
      };
      img.addEventListener('error', unavailable);
      imageCleanups.push(() => img.removeEventListener('error', unavailable));
      if (!img.getAttribute('src') || (img.complete && img.naturalWidth === 0)) unavailable();
    }

    const impl: AnchoringImpl = {
      describe: (range) => describeRange(root, range, 'RIGHT'),
      anchor: (range) => anchorRange(root, range),
      scrollTo: (range) => {
        const found = anchorRange(root, range);
        if (!found) return;
        const container = root.closest('[data-marky-mcmarkface-scroll]') ?? root.parentElement;
        if (!container) return;
        // Centre the passage and animate. Jumping it to a fixed 120px from the top read as an
        // abrupt cut, and left the reader without the context above the line they asked for.
        const rect = found.getBoundingClientRect();
        const box = container.getBoundingClientRect();
        const target = container.scrollTop + (rect.top - box.top) - box.height / 2 + rect.height / 2;
        container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      },
      contentContainer: () => root,
      onLayoutChange: (cb) => {
        layoutListeners.add(cb);
        return () => layoutListeners.delete(cb);
      },
    };

    registerAnchoring(impl);
    return () => {
      observer.disconnect();
      for (const cleanup of imageCleanups) cleanup();
      layoutListeners.clear();
      registerAnchoring(null);
    };
  }, [registerAnchoring, html]);

  // Report selections upward. Debounced through a frame so a drag reports once on release
  // rather than on every intermediate selectionchange.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const onUp = () => {
      requestAnimationFrame(() => {
        const selection = root.ownerDocument.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
          host.onSelect(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) {
          host.onSelect(null);
          return;
        }
        host.onSelect(describeRange(root, range, 'RIGHT'));
      });
    };

    root.addEventListener('mouseup', onUp);
    root.addEventListener('keyup', onUp);
    return () => {
      root.removeEventListener('mouseup', onUp);
      root.removeEventListener('keyup', onUp);
    };
  }, [host]);

  // The viewer knows that an anchor was clicked; only the host knows whether its destination is
  // another file in this repository. Modified clicks remain ordinary browser actions so opening
  // an external link in a new tab keeps working exactly as expected.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !host.openLink) return;
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null;
      const href = anchor?.getAttribute('href');
      if (!anchor || !href || !root.contains(anchor)) return;
      if (host.openLink?.(href, file.path)) event.preventDefault();
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [file.path, host]);

  return (
    <div
      ref={containerRef}
      className="md-body"
      data-marky-mcmarkface-root=""
      data-marky-mcmarkface-nonce={nonce}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Exposed so the host can paint highlights for annotations without re-implementing anchoring. */
export function highlightFor(root: HTMLElement, range: SourceRange): DOMRect | null {
  const found = anchorRange(root, range);
  if (!found) return null;
  const rect = found.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

export default MarkdownViewer;
