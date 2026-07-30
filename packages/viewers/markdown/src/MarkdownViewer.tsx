import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import type { AnchoringImpl, SourceRange, ViewerProps } from '@pilcrow/viewer-api';
import { parseMarkdown, normaliseSource } from './parse.js';
import { renderToHtml } from './render.js';
import { diffMarkdown } from './blockdiff.js';
import { describeRange, anchorRange } from './anchoring.js';

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

  const html = useMemo(() => {
    const head = normaliseSource(file.head ?? '');
    const headTree = parseMarkdown(head);

    // 'final' is the deliberate no-markup read. Everything else gets the diff — including a
    // newly added file, where `base` is null and every block is new. Skipping the diff there
    // would render an added file identically to an unchanged one.
    if (mode === 'final') return sanitize(renderToHtml(head, headTree, {}));

    const base = file.base === null ? null : normaliseSource(file.base);
    const baseTree = base === null ? null : parseMarkdown(base);
    const diff = diffMarkdown(base, baseTree, head, headTree);
    return sanitize(renderToHtml(head, headTree, { blocks: diff.blocks, inline: diff.inline }));
  }, [file.head, file.base, mode]);

  // Register the anchoring implementation. The host owns everything downstream of this — the
  // viewer's entire contribution to commenting is these five functions.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const layoutListeners = new Set<() => void>();
    const observer = new ResizeObserver(() => layoutListeners.forEach((cb) => cb()));
    observer.observe(root);

    const impl: AnchoringImpl = {
      describe: (range) => describeRange(root, range, 'RIGHT'),
      anchor: (range) => anchorRange(root, range),
      scrollTo: (range) => {
        const found = anchorRange(root, range);
        if (!found) return;
        const rect = found.getBoundingClientRect();
        const container = root.closest('[data-pilcrow-scroll]') ?? root.parentElement;
        if (container) {
          container.scrollTop += rect.top - container.getBoundingClientRect().top - 120;
        }
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

  return (
    <div
      ref={containerRef}
      className="md-body"
      data-pilcrow-root=""
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    // ALLOW_DATA_ATTR defaults true, which is what preserves data-pilcrow-pos / -x / -change.
    ADD_TAGS: ['ins', 'del'],
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'ping'],
  });
}

/** Exposed so the host can paint highlights for annotations without re-implementing anchoring. */
export function highlightFor(root: HTMLElement, range: SourceRange): DOMRect | null {
  const found = anchorRange(root, range);
  if (!found) return null;
  const rect = found.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

export default MarkdownViewer;
