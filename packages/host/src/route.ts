export type View =
  | { kind: 'dashboard' }
  | { kind: 'review'; owner: string; repo: string; number: number; file?: string }
  | { kind: 'branch'; owner: string; repo: string; branch: string; file?: string };

export function hashForView(view: View): string {
  if (view.kind === 'dashboard') return '';
  if (view.kind === 'branch') {
    return `#/branch/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}?${new URLSearchParams({
      ref: view.branch,
      ...(view.file ? { file: view.file } : {}),
    })}`;
  }
  const path = `#/pr/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.repo)}/${view.number}`;
  if (!view.file) return path;
  return `${path}?${new URLSearchParams({ file: view.file })}`;
}

export function parseHash(hash: string): View {
  const question = hash.indexOf('?');
  const pathname = question === -1 ? hash : hash.slice(0, question);
  const match = /^#\/pr\/([^/]+)\/([^/]+)\/(\d+)$/.exec(pathname);
  const branchMatch = /^#\/branch\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match && !branchMatch) return { kind: 'dashboard' };

  try {
    const file = question === -1 ? null : new URLSearchParams(hash.slice(question + 1)).get('file');
    if (branchMatch) {
      const branch = question === -1 ? null : new URLSearchParams(hash.slice(question + 1)).get('ref');
      if (!branch) return { kind: 'dashboard' };
      return {
        kind: 'branch',
        owner: decodeURIComponent(branchMatch[1]!),
        repo: decodeURIComponent(branchMatch[2]!),
        branch,
        ...(file ? { file } : {}),
      };
    }
    return {
      kind: 'review',
      owner: decodeURIComponent(match![1]!),
      repo: decodeURIComponent(match![2]!),
      number: Number(match![3]),
      ...(file ? { file } : {}),
    };
  } catch {
    return { kind: 'dashboard' };
  }
}
