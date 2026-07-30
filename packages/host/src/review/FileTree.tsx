import { useMemo } from 'react';
import type { PrDetail } from '../api.js';

interface Node {
  name: string;
  path: string;
  children: Map<string, Node>;
  file: PrDetail['files'][number] | null;
}

function build(files: PrDetail['files']): Node {
  const root: Node = { name: '', path: '', children: new Map(), file: null };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, path, children: new Map(), file: null };
        node.children.set(part, next);
      }
      node = next;
    });
    node.file = file;
  }
  return collapse(root);
}

/** Fold single-child directory chains into one row, so `a/b/c/file.md` costs one line not four. */
function collapse(node: Node): Node {
  for (const [key, child] of node.children) {
    let folded = collapse(child);
    while (folded.children.size === 1 && !folded.file) {
      const only = [...folded.children.values()][0]!;
      folded = { ...only, name: `${folded.name}/${only.name}` };
    }
    node.children.set(key, folded);
  }
  return node;
}

export function FileTree({
  pr,
  active,
  counts,
  viewed,
  onSelect,
  onToggleViewed,
}: {
  pr: PrDetail;
  active: string | null;
  counts: Map<string, number>;
  viewed: Set<string>;
  onSelect: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const tree = useMemo(() => build(pr.files), [pr.files]);

  const render = (node: Node, depth: number): React.ReactNode =>
    [...node.children.values()].map((child) =>
      child.file ? (
        <div
          key={child.path}
          className={`tree-file ${active === child.path ? 'on' : ''} ${viewed.has(child.path) ? 'viewed' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <input
            type="checkbox"
            checked={viewed.has(child.path)}
            onChange={() => onToggleViewed(child.path)}
            title="Mark as viewed"
            onClick={(e) => e.stopPropagation()}
          />
          <button className="tree-name" onClick={() => onSelect(child.path)} title={child.path}>
            {child.name}
          </button>
          {counts.get(child.path) ? <span className="tree-badge">{counts.get(child.path)}</span> : null}
          <span className="tree-stat">
            <span className="add">+{child.file.additions}</span>
            <span className="del">−{child.file.deletions}</span>
          </span>
        </div>
      ) : (
        <div key={child.path}>
          <div className="tree-dir" style={{ paddingLeft: 8 + depth * 12 }}>
            {child.name}
          </div>
          {render(child, depth + 1)}
        </div>
      ),
    );

  return (
    <div className="tree">
      <div className="tree-head">
        {pr.files.length} file{pr.files.length === 1 ? '' : 's'} · {viewed.size} viewed
      </div>
      {render(tree, 0)}
    </div>
  );
}
