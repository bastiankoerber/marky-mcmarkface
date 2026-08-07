import { useEffect, useMemo, useRef } from 'react';
import { diffLines } from 'diff';
import type { AnchoringImpl, ViewerProps } from '@marky-mcmarkface/viewer-api';

/**
 * The always-available fallback viewer: a plain unified diff with line numbers.
 *
 * It claims `**\/*` at the worst rank, so resolution can never dead-end — every file in a pull
 * request opens in something. It anchors at line granularity, which is all a raw diff can
 * meaningfully offer, and is the escape hatch when a rendered view hides what you need to see.
 */

type Row = { kind: 'ctx' | 'add' | 'del'; base: number | null; head: number | null; text: string; offset: number };

function buildRows(base: string, head: string): Row[] {
  const rows: Row[] = [];
  let baseLine = 1;
  let headLine = 1;
  let headOffset = 0;

  for (const part of diffLines(base, head)) {
    const lines = part.value.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    for (const text of lines) {
      if (part.added) {
        rows.push({ kind: 'add', base: null, head: headLine++, text, offset: headOffset });
        headOffset += text.length + 1;
      } else if (part.removed) {
        rows.push({ kind: 'del', base: baseLine++, head: null, text, offset: -1 });
      } else {
        rows.push({ kind: 'ctx', base: baseLine++, head: headLine++, text, offset: headOffset });
        headOffset += text.length + 1;
      }
    }
  }

  return rows;
}

export function SourceDiffViewer({ file, host, registerAnchoring }: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(file.base ?? '', file.head ?? ''), [file.base, file.head]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const listeners = new Set<() => void>();
    const impl: AnchoringImpl = {
      describe: (range) => {
        const startRow = rowElementOf(range.startContainer, root);
        const endRow = rowElementOf(range.endContainer, root) ?? startRow;
        if (!startRow || !endRow) return null;
        const start = Number(startRow.dataset.offset);
        const endOffset = Number(endRow.dataset.offset);
        const endLen = Number(endRow.dataset.len);
        if (!Number.isFinite(start) || start < 0 || !Number.isFinite(endOffset) || endOffset < 0) return null;
        return { side: 'RIGHT', start, end: endOffset + endLen };
      },
      anchor: (range) => {
        const el = [...root.querySelectorAll<HTMLElement>('[data-offset]')].find((row) => {
          const offset = Number(row.dataset.offset);
          return offset >= 0 && offset <= range.start && offset + Number(row.dataset.len) >= range.start;
        });
        if (!el) return null;
        const created = root.ownerDocument.createRange();
        created.selectNodeContents(el);
        return created;
      },
      scrollTo: () => {},
      contentContainer: () => root,
      onLayoutChange: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };

    registerAnchoring(impl);
    return () => {
      listeners.clear();
      registerAnchoring(null);
    };
  }, [registerAnchoring, rows]);

  const onMouseUp = () => {
    const root = containerRef.current;
    if (!root) return;
    const selection = root.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      host.onSelect(null);
      return;
    }
    const row = rowElementOf(selection.getRangeAt(0).startContainer, root);
    if (!row) return;
    const offset = Number(row.dataset.offset);
    if (offset < 0) return;
    host.onSelect({ side: 'RIGHT', start: offset, end: offset + Number(row.dataset.len) });
  };

  return (
    <div ref={containerRef} className="srcdiff" onMouseUp={onMouseUp}>
      {rows.map((row, i) => (
        <div
          key={i}
          className={`srcdiff-row srcdiff-${row.kind}`}
          data-offset={row.offset}
          data-len={row.text.length}
        >
          <span className="srcdiff-num">{row.base ?? ''}</span>
          <span className="srcdiff-num">{row.head ?? ''}</span>
          <span className="srcdiff-mark">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
          <span className="srcdiff-text">{row.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function rowElementOf(node: Node, root: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
  while (el && el !== root) {
    if (el.dataset.offset !== undefined) return el;
    el = el.parentElement;
  }
  return null;
}

export default SourceDiffViewer;
