export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface AvailableUpdate {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  releaseUrl: string;
  /** Null when the release has no exact signed artifact suitable for automatic replacement. */
  zipUrl: string | null;
}

function versionParts(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index]! > installed[index]!) return true;
    if (next[index]! < installed[index]!) return false;
  }
  return false;
}

function trustedGitHubUrl(raw: string, repository: string, kind: 'release' | 'asset'): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    const prefix = `/${repository}/releases/${kind === 'release' ? 'tag/' : 'download/'}`;
    return url.pathname.startsWith(prefix) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Select only the exact signed ZIP name produced by the release workflow. */
export function selectUpdate(
  release: GitHubRelease,
  currentVersion: string,
  arch: string,
  repository: string,
): AvailableUpdate | null {
  if (release.draft || release.prerelease) return null;
  const parts = versionParts(release.tag_name);
  if (!parts || !isNewerVersion(release.tag_name, currentVersion)) return null;
  const version = parts.join('.');
  const expectedName = `Marky-McMarkface-${version}-${arch}.zip`;
  const releaseUrl = trustedGitHubUrl(release.html_url, repository, 'release');
  if (!releaseUrl) return null;
  const asset = release.assets.find((candidate) => candidate.name === expectedName);
  const zipUrl = asset ? trustedGitHubUrl(asset.browser_download_url, repository, 'asset') : null;

  return {
    version,
    name: release.name?.trim() || `Marky McMarkface ${version}`,
    notes: release.body?.trim().slice(0, 4_000) || `Version ${version}`,
    publishedAt: release.published_at || new Date().toISOString(),
    releaseUrl,
    zipUrl,
  };
}
