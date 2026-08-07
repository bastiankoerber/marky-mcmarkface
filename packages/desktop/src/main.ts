import { app, BrowserWindow, dialog, Menu, safeStorage, session, shell } from 'electron';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createDesktopUpdater, type DesktopUpdater } from './updater.js';

declare const __MARKY_SIGNED_RELEASE__: boolean;

const PRODUCT_NAME = 'Marky McMarkface';
const BACKGROUND = '#191816';

let mainWindow: BrowserWindow | null = null;
let appOrigin = '';
let updater: DesktopUpdater | null = null;

function safeExternalUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
      ? url
      : null;
  } catch {
    return null;
  }
}

async function openExternal(raw: string): Promise<void> {
  const url = safeExternalUrl(raw);
  if (url) await shell.openExternal(url.toString());
}

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  probe.unref();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a loopback port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitForServer(origin: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { redirect: 'manual' });
      if (response.ok) return;
      lastError = new Error(`Local server returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw lastError instanceof Error ? lastError : new Error('Local server did not start.');
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: BACKGROUND,
    icon: join(app.getAppPath(), 'app/icons/icon-512.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === appOrigin) return;
    } catch {
      // Invalid and non-web URLs are denied below.
    }
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  void window.loadURL(appOrigin);
  return window;
}

function installApplicationMenu(): void {
  if (process.platform !== 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: PRODUCT_NAME,
        submenu: [
          { role: 'about' },
          {
            label: 'Check for Updates…',
            click: () => void updater?.check(true),
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
}

async function start(): Promise<void> {
  await app.whenReady();
  app.setName(PRODUCT_NAME);
  app.setAppUserModelId('com.bastiankoerber.markymcmarkface');

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const port = await freeLoopbackPort();
  appOrigin = `http://127.0.0.1:${port}`;
  process.env.MARKY_MCMARKFACE_DESKTOP = '1';
  process.env.MARKY_MCMARKFACE_PORT = String(port);
  process.env.MARKY_MCMARKFACE_DATA_DIR = app.getPath('userData');
  process.env.MARKY_MCMARKFACE_UI_DIST = join(app.getAppPath(), 'app/ui');
  Object.assign(globalThis, { __markyMcMarkfaceSafeStorage: safeStorage });

  await import('../../server/src/index.js');
  await waitForServer(appOrigin);
  mainWindow = createWindow();
  updater = createDesktopUpdater(() => mainWindow, __MARKY_SIGNED_RELEASE__);
  installApplicationMenu();
  const firstCheck = setTimeout(() => void updater?.check(false), 15_000);
  firstCheck.unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('activate', () => {
    if (!mainWindow && appOrigin) mainWindow = createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => updater?.dispose());

  void start().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'The desktop application could not start.';
    dialog.showErrorBox(`${PRODUCT_NAME} could not start`, detail);
    app.quit();
  });
}
