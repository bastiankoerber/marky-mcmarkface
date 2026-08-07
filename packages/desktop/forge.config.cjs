const { resolve } = require('node:path');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

const icon = resolve(__dirname, '../../assets/brand/app-icon');
const releaseSigning = process.env.MARKY_RELEASE_SIGNING === 'true';

function requiredForRelease(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when MARKY_RELEASE_SIGNING=true`);
  return value;
}

const osxSign = releaseSigning
  ? {
      // If no identity is specified, @electron/osx-sign selects the Developer ID Application
      // certificate from the temporary CI keychain.
      identity: process.env.APPLE_SIGNING_IDENTITY || undefined,
      keychain: process.env.MARKY_SIGNING_KEYCHAIN || undefined,
      identityValidation: true,
      preAutoEntitlements: true,
      optionsForFile: () => ({ hardenedRuntime: true }),
    }
  : {
      // Local builds remain usable without paid Apple credentials. Public releases should set
      // MARKY_RELEASE_SIGNING through the release workflow and never ship this ad-hoc identity.
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    };

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.bastiankoerber.markymcmarkface',
    appCategoryType: 'public.app-category.developer-tools',
    appCopyright: 'Copyright © 2026 Bastian Körber and contributors',
    darwinDarkModeSupport: true,
    executableName: 'Marky McMarkface',
    extendInfo: {
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
      },
    },
    icon,
    osxSign,
    ...(releaseSigning
      ? {
          osxNotarize: {
            appleId: requiredForRelease('APPLE_ID'),
            appleIdPassword: requiredForRelease('APPLE_APP_SPECIFIC_PASSWORD'),
            teamId: requiredForRelease('APPLE_TEAM_ID'),
          },
        }
      : {}),
    // The application and server are fully bundled by esbuild, so no runtime
    // node_modules belong in the app. Skipping Forge's dependency pruning also
    // avoids following pnpm's development-only symlink graph.
    prune: false,
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/forge\.config\.cjs$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform) => {
      const applePlatform = platform === 'darwin' || platform === 'mas';
      const basePath = resolve(buildPath, '../..');
      const executable = applePlatform
        ? resolve(basePath, 'MacOS', 'Electron')
        : resolve(basePath, `electron${platform === 'win32' ? '.exe' : ''}`);

      await flipFuses(executable, {
        version: FuseVersion.V1,
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        // Authentication is held by the local server, not Chromium cookies. Enabling this fuse
        // makes Chromium touch macOS "Safe Storage" at launch, before the app can explain the
        // dialog. GitHub credentials remain encrypted explicitly with Electron safeStorage.
        [FuseV1Options.EnableCookieEncryption]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
        // Electron Packager signs the completed bundle after this hook.
        resetAdHocDarwinSignature: false,
      });
    },
  },
};
