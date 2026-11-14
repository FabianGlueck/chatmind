import { appendFileSync, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, type MenuItemConstructorOptions } from 'electron';
import { defaultEnvFile, parseEnvFile, writeEnvFile } from '@chatmind/index';
import { envChanges, needsSetup, parseForm, settingsView, type SettingsView } from './config';
import { DesktopServer } from './server';
import { CHANNELS } from './settings/api';
import { loadBounds, MIN_SIZE, saveBounds, type Bounds } from './window-state';

// Desktop spec §1: one app per machine, so never two servers and indexers on one vault from here.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run(): void {
  const appDir = app.getAppPath();
  const logFile = path.join(app.getPath('logs'), 'chatmind.log');
  const boundsFile = path.join(app.getPath('userData'), 'window.json');
  mkdirSync(path.dirname(logFile), { recursive: true });

  // Desktop spec §1: every console line of the main process (server, indexer) also goes to a file, for users
  // without a terminal.
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')}\n`);
      } catch {
        // a full disk must not take the app down
      }
    };
  }
  const log = (line: string): void => console.log(line);
  const error = (line: string): void => console.error(line);

  const server = new DesktopServer({ staticDir: path.join(appDir, 'web'), log, error });
  let main: BrowserWindow | null = null;
  let settings: BrowserWindow | null = null;
  const origin = (): string => `http://127.0.0.1:${server.current?.port ?? 0}`;

  async function currentView(): Promise<SettingsView> {
    const file = defaultEnvFile();
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return settingsView(process.env, parseEnvFile(text), file);
  }

  /** Links and window.open go to the default browser; the window itself never leaves the server origin. */
  function guard(win: BrowserWindow, allowed: (url: string) => boolean): void {
    const external = (url: string): void => {
      if (/^https?:\/\//.test(url) || url.startsWith('mailto:')) void shell.openExternal(url);
    };
    win.webContents.setWindowOpenHandler(({ url }) => {
      external(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (allowed(url)) return;
      e.preventDefault();
      external(url);
    });
  }

  /** A remembered position only when it is still on one of the screens. */
  function onScreen(b: Bounds): Bounds {
    if (b.x === undefined || b.y === undefined) return b;
    const { x, y } = b;
    const visible = screen.getAllDisplays().some(({ workArea: a }) => x < a.x + a.width - 100 && x + b.width > a.x + 100 && y >= a.y - 10 && y < a.y + a.height - 100);
    return visible ? b : { width: b.width, height: b.height };
  }

  /** Also called on quit: `app.exit` closes no windows, so their `close` handler would never run. */
  async function persistBounds(): Promise<void> {
    if (main && !main.isDestroyed()) await saveBounds(boundsFile, main.getNormalBounds()).catch(() => undefined);
  }

  async function openMain(): Promise<void> {
    if (main) {
      main.show();
      return;
    }
    const win = new BrowserWindow({
      ...onScreen(await loadBounds(boundsFile)),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: 'chatmind',
      show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    main = win;
    guard(win, (url) => url.startsWith(`${origin()}/`));
    win.once('ready-to-show', () => win.show());
    win.on('close', () => void persistBounds());
    win.on('closed', () => { main = null; });
    await win.loadURL(`${origin()}/`);
  }

  async function openSettings(): Promise<void> {
    if (settings) {
      settings.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 560,
      height: 640,
      resizable: false,
      minimizable: false,
      fullscreenable: false,
      title: 'chatmind Settings',
      show: false,
      webPreferences: { preload: path.join(appDir, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    settings = win;
    const page = `file://${path.join(appDir, 'settings.html')}`;
    guard(win, (url) => url === page);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { settings = null; });
    await win.loadFile(path.join(appDir, 'settings.html'));
  }

  // Desktop spec §1: IPC only from the settings window.
  const fromSettings = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => settings !== null && e.sender === settings.webContents;
  ipcMain.handle(CHANNELS.load, async (e) => {
    if (!fromSettings(e)) throw new Error('not allowed');
    return currentView();
  });
  ipcMain.handle(CHANNELS.chooseFolder, async (e, current: unknown) => {
    if (!fromSettings(e) || !settings) throw new Error('not allowed');
    const res = await dialog.showOpenDialog(settings, {
      title: 'Choose the chatmind data folder',
      defaultPath: typeof current === 'string' ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle(CHANNELS.save, async (e, raw: unknown) => {
    if (!fromSettings(e)) throw new Error('not allowed');
    const form = parseForm(raw);
    if (!form) return { ok: false, error: 'invalid form' };
    try {
      const changes = envChanges(form, await currentView());
      if (Object.keys(changes).length > 0) {
        await writeEnvFile(changes);
        log(`settings: wrote ${Object.keys(changes).join(', ')} — restarting the server`);
        await server.restart();
        await main?.loadURL(`${origin()}/`);
      }
      return { ok: true };
    } catch (err) {
      error(`settings: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.on(CHANNELS.close, (e) => {
    if (fromSettings(e)) settings?.close();
  });

  function buildMenu(): void {
    const mac = process.platform === 'darwin';
    const dataDir = (): string => server.current?.dataDir ?? '';
    const template: MenuItemConstructorOptions[] = [
      ...(mac
        ? [{
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => void openSettings() },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'Open Data Folder', click: () => void shell.openPath(dataDir()) },
          { label: 'Open in Obsidian', click: () => void shell.openExternal(`obsidian://open?path=${encodeURIComponent(dataDir())}`) },
          ...(mac ? [] : [{ type: 'separator' as const }, { label: 'Settings…', accelerator: 'Ctrl+,', click: () => void openSettings() }, { type: 'separator' as const }, { role: 'quit' as const }]),
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
      { role: 'help', submenu: [{ label: 'Show Log File', click: () => void shell.openPath(logFile) }] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.on('second-instance', () => {
    if (!main) return void openMain();
    if (main.isMinimized()) main.restore();
    main.focus();
  });
  app.on('activate', () => void openMain()); // macOS: dock click with no window open
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Spec M5 §8 / desktop spec §1: close the server (watcher, indexer, db) before the process goes, at most 12 s.
  const SHUTDOWN_MS = 12_000;
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const cutoff = setTimeout(() => {
      error(`shutdown took over ${SHUTDOWN_MS / 1000} s — exiting anyway`);
      app.exit(1);
    }, SHUTDOWN_MS);
    void persistBounds().then(() => server.close()).catch((err: unknown) => error(`shutdown: ${String(err)}`)).finally(() => {
      clearTimeout(cutoff);
      app.exit(0);
    });
  });

  void app.whenReady().then(async () => {
    buildMenu();
    try {
      await server.start();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`server: ${msg}`);
      dialog.showErrorBox('chatmind could not start', `${msg}\n\nLog file: ${logFile}`);
      app.exit(1);
      return;
    }
    await openMain();
    if (needsSetup(await currentView())) await openSettings();
  });
}
