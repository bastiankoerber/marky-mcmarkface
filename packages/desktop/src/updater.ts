import { app, autoUpdater, dialog, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { selectUpdate, type AvailableUpdate, type GitHubRelease } from './update-policy.js';

const REPOSITORY = 'bastiankoerber/pilcrow';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface DesktopUpdater {
  check(manual?: boolean): Promise<void>;
  dispose(): void;
}

function showMessage(owner: () => BrowserWindow | null, options: MessageBoxOptions) {
  const window = owner();
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

async function latestRelease(): Promise<GitHubRelease> {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'marky-mcmarkface-updater',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status}).`);
  return (await response.json()) as GitHubRelease;
}

async function localFeed(update: AvailableUpdate): Promise<{ url: string; close: () => void }> {
  if (!update.zipUrl) throw new Error('This release has no signed automatic-update artifact.');
  const token = randomBytes(24).toString('hex');
  let server: Server;
  const body = JSON.stringify({
    url: update.zipUrl,
    name: update.version,
    notes: update.notes,
    pub_date: update.publishedAt,
  });

  server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not create the local update feed.');
  }

  const timeout = setTimeout(() => {
    if (server.listening) server.close();
  }, 5 * 60_000);
  timeout.unref();
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: () => {
      clearTimeout(timeout);
      if (server.listening) server.close();
    },
  };
}

export function createDesktopUpdater(
  owner: () => BrowserWindow | null,
  signedRelease: boolean,
): DesktopUpdater {
  let promptedVersion: string | null = null;
  let downloading: AvailableUpdate | null = null;
  let feed: { close: () => void } | null = null;
  let interval: NodeJS.Timeout | null = null;

  const download = async (update: AvailableUpdate) => {
    if (downloading) return;
    downloading = update;
    try {
      const nextFeed = await localFeed(update);
      feed = nextFeed;
      autoUpdater.setFeedURL({ url: nextFeed.url, serverType: 'json' });
      autoUpdater.checkForUpdates();
    } catch {
      downloading = null;
      feed?.close();
      feed = null;
      await showMessage(owner, {
        type: 'error',
        title: 'Update could not start',
        message: 'Marky McMarkface could not start the secure update download.',
        detail: 'Nothing was installed. You can download the release directly from GitHub.',
        buttons: ['Open GitHub Release', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(async ({ response }) => {
        if (response === 0) await shell.openExternal(update.releaseUrl);
      });
    }
  };

  const check = async (manual = false) => {
    if (!app.isPackaged || downloading) return;
    try {
      const update = selectUpdate(await latestRelease(), app.getVersion(), process.arch, REPOSITORY);
      if (!update) {
        if (manual) {
          await showMessage(owner, {
            type: 'info',
            title: 'No update available',
            message: 'Marky McMarkface is up to date.',
            detail: `You are using version ${app.getVersion()}.`,
            buttons: ['OK'],
          });
        }
        return;
      }
      if (!manual && promptedVersion === update.version) return;
      promptedVersion = update.version;

      const runningFromDiskImage = app.getPath('exe').startsWith('/Volumes/');
      if (!signedRelease || runningFromDiskImage || !update.zipUrl) {
        const { response } = await showMessage(owner, {
          type: 'info',
          title: 'Update available',
          message: `Marky McMarkface ${update.version} is available.`,
          detail: runningFromDiskImage
            ? 'This copy is still running from a disk image. Move it to Applications, or open the installer on GitHub.'
            : !signedRelease
              ? 'This copy is an ad-hoc development build, so macOS will not allow it to replace itself safely. Open the release on GitHub instead.'
              : 'This release does not contain the expected signed automatic-update file. Open the release on GitHub instead.',
          buttons: ['Open GitHub Release', 'Later'],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) await shell.openExternal(update.releaseUrl);
        return;
      }

      const { response } = await showMessage(owner, {
        type: 'info',
        title: 'Update available',
        message: `Marky McMarkface ${update.version} is available.`,
        detail:
          'Download the signed update directly from GitHub? Nothing will be installed until the download finishes and you approve the restart.',
        buttons: ['Download Update', 'View Release Notes', 'Later'],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) await download(update);
      if (response === 1) await shell.openExternal(update.releaseUrl);
    } catch {
      if (!manual) return;
      await showMessage(owner, {
        type: 'warning',
        title: 'Could not check for updates',
        message: 'Marky McMarkface could not reach GitHub Releases.',
        detail: 'No information was sent anywhere except GitHub. Try again when you are online.',
        buttons: ['OK'],
      });
    }
  };

  autoUpdater.on('update-downloaded', async () => {
    const update = downloading;
    downloading = null;
    feed?.close();
    feed = null;
    if (!update) return;
    const { response } = await showMessage(owner, {
      type: 'info',
      title: 'Update ready',
      message: `Marky McMarkface ${update.version} is ready to install.`,
      detail: 'Restart now to install it. If you choose Later, it will be applied the next time the app starts.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('update-not-available', async () => {
    const update = downloading;
    downloading = null;
    feed?.close();
    feed = null;
    if (!update) return;
    await showMessage(owner, {
      type: 'info',
      title: 'Update no longer available',
      message: 'GitHub no longer offers that update to this installation.',
      detail: 'Nothing was downloaded or installed. Marky McMarkface will check again later.',
      buttons: ['OK'],
    });
  });

  autoUpdater.on('error', async () => {
    const update = downloading;
    downloading = null;
    feed?.close();
    feed = null;
    if (!update) return;
    const { response } = await showMessage(owner, {
      type: 'error',
      title: 'Update failed',
      message: 'The update could not be downloaded or verified.',
      detail: 'Nothing was installed. You can try the signed installer from GitHub.',
      buttons: ['Open GitHub Release', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await shell.openExternal(update.releaseUrl);
  });

  interval = setInterval(() => void check(false), CHECK_INTERVAL_MS);
  interval.unref();

  return {
    check,
    dispose: () => {
      if (interval) clearInterval(interval);
      interval = null;
      feed?.close();
      feed = null;
    },
  };
}
