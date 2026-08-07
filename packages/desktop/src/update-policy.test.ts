import { describe, expect, it } from 'vitest';
import { isNewerVersion, selectUpdate, type GitHubRelease } from './update-policy.js';

const repository = 'bastiankoerber/marky-mcmarkface';

function release(version: string, assetName = `Marky-McMarkface-${version}-arm64.zip`): GitHubRelease {
  return {
    tag_name: `v${version}`,
    name: `Version ${version}`,
    body: 'Release notes',
    html_url: `https://github.com/${repository}/releases/tag/v${version}`,
    published_at: '2026-08-07T08:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${assetName}`,
      },
    ],
  };
}

describe('desktop update policy', () => {
  it('compares semantic versions numerically', () => {
    expect(isNewerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
    expect(isNewerVersion('not-a-version', '1.2.3')).toBe(false);
  });

  it('selects the exact signed ZIP for this architecture', () => {
    expect(selectUpdate(release('0.2.0'), '0.1.0', 'arm64', repository)).toMatchObject({
      version: '0.2.0',
      zipUrl: `https://github.com/${repository}/releases/download/v0.2.0/Marky-McMarkface-0.2.0-arm64.zip`,
    });
  });

  it('reports releases without treating unsigned or foreign assets as installable', () => {
    expect(
      selectUpdate(release('0.2.0', 'Marky-McMarkface-0.2.0-arm64-UNSIGNED.zip'), '0.1.0', 'arm64', repository),
    ).toMatchObject({ version: '0.2.0', zipUrl: null });

    const preview = release('0.2.0');
    preview.prerelease = true;
    expect(selectUpdate(preview, '0.1.0', 'arm64', repository)).toBeNull();
    expect(selectUpdate(release('0.1.0'), '0.1.0', 'arm64', repository)).toBeNull();

    const foreign = release('0.2.0');
    foreign.assets[0]!.browser_download_url =
      'https://github.com/someone/else/releases/download/v0.2.0/Marky-McMarkface-0.2.0-arm64.zip';
    expect(selectUpdate(foreign, '0.1.0', 'arm64', repository)).toMatchObject({ zipUrl: null });
  });
});
