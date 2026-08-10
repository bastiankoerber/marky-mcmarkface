export interface RepositoryLink {
  path: string;
  fragment: string | null;
}

/** Resolve only links whose destination stays inside the current repository. */
export function resolveRepositoryLink(href: string, documentPath: string): RepositoryLink | null {
  const value = href.trim();
  if (!value || value.startsWith('#') || value.startsWith('?')) return null;
  if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;

  try {
    const base = new URL(documentPath, 'https://repository.invalid/');
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin || resolved.pathname.endsWith('/')) return null;
    const path = decodeURIComponent(resolved.pathname.slice(1));
    if (!path || path.includes('\0')) return null;
    return { path, fragment: resolved.hash ? decodeURIComponent(resolved.hash.slice(1)) : null };
  } catch {
    return null;
  }
}
