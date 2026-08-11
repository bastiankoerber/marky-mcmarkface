import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

export const MAX_REPOSITORY_IMAGE_BYTES = 10 * 1024 * 1024;
const SCOPE_TTL_MS = 12 * 60 * 60 * 1000;

export interface AssetScope {
  owner: string;
  repo: string;
  sha: string;
  /** Immutable PR base commit, used only when the asset is absent from the head commit. */
  baseSha?: string;
}

interface StoredScope extends AssetScope {
  expiresAt: number;
}

const scopes = new Map<string, StoredScope>();

function pruneScopes(now = Date.now()): void {
  for (const [token, scope] of scopes) {
    if (scope.expiresAt <= now) scopes.delete(token);
  }
}

/**
 * An image tag cannot carry the API's CSRF header, so it authenticates with a narrow capability
 * instead. The capability grants read access to the PR's immutable head and base commits, not
 * to the GitHub token or the rest of the local API, and exists only for this server process.
 */
export function issueAssetScope(scope: AssetScope): string {
  pruneScopes();
  const token = randomBytes(24).toString('base64url');
  scopes.set(token, { ...scope, expiresAt: Date.now() + SCOPE_TTL_MS });
  return token;
}

export function readAssetScope(token: string): AssetScope | null {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const scope = scopes.get(token);
  if (!scope) return null;
  if (scope.expiresAt <= Date.now()) {
    scopes.delete(token);
    return null;
  }
  return {
    owner: scope.owner,
    repo: scope.repo,
    sha: scope.sha,
    ...(scope.baseSha ? { baseSha: scope.baseSha } : {}),
  };
}

export function clearAssetScopes(): void {
  scopes.clear();
}

/** Resolve a Markdown image path inside the reviewed repository, never on the local filesystem. */
export function resolveRepositoryImagePath(documentPath: string, source: string): string | null {
  if (!documentPath || documentPath.length > 4096 || !source || source.length > 4096) return null;
  if (documentPath.includes('\\') || documentPath.includes('\0')) return null;

  const value = source.trim();
  if (!value || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;

  const cut = Math.min(
    ...[value.indexOf('?'), value.indexOf('#')].filter((at) => at >= 0),
    value.length,
  );
  const encodedPath = value.slice(0, cut);
  if (!encodedPath) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) return null;

  const cleanDocument = posix.normalize(documentPath.replace(/^\/+/, ''));
  if (cleanDocument === '..' || cleanDocument.startsWith('../') || posix.isAbsolute(cleanDocument)) return null;

  const joined = decoded.startsWith('/')
    ? decoded.slice(1)
    : posix.join(posix.dirname(cleanDocument), decoded);
  const resolved = posix.normalize(joined);
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    return null;
  }
  return resolved;
}

function ascii(bytes: Uint8Array, length: number): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, length));
}

/** Trust file signatures rather than GitHub's occasionally generic application/octet-stream. */
export function repositoryImageMime(body: ArrayBuffer): string | null {
  const bytes = new Uint8Array(body);
  if (bytes.length >= 8 && bytes.slice(0, 8).every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(bytes, 6) === 'GIF87a' || ascii(bytes, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 4) === 'RIFF' && ascii(bytes.subarray(8), 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && ascii(bytes.subarray(4), 4) === 'ftyp' && /^(avif|avis)$/.test(ascii(bytes.subarray(8), 4))) {
    return 'image/avif';
  }

  const prefix = ascii(bytes, Math.min(bytes.length, 2048)).replace(/^\uFEFF?\s*/, '');
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return 'image/svg+xml';
  return null;
}

export function encodedRepositoryPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
