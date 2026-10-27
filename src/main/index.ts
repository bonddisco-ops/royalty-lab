import { app, BrowserWindow, dialog } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc.ts';
import { endSession, setLockListener } from './session.ts';

const profileDir = process.env.ROYALTY_LAB_DATA ?? join(app.getPath('appData'), 'RoyaltyLab');
let shutdown: () => void = () => {};
let win: BrowserWindow | null = null;

/** После системных окон (выбор файла, «Подтвердить») Electron теряет клавиатурный фокус страницы: в полях нельзя печатать. Возвращаем фокус. */
export function refocusWindow(): void {
  if (!win || win.isDestroyed()) return;
  win.focus();
  win.webContents.focus();
}
for (const m of ['showOpenDialog', 'showSaveDialog', 'showMessageBox'] as const) {
  const orig = (dialog[m] as (...a: unknown[]) => Promise<unknown>).bind(dialog);
  (dialog as unknown as Record<string, unknown>)[m] = async (...a: unknown[]) => { try { return await orig(...a); } finally { refocusWindow(); setTimeout(refocusWindow, 80); } };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14110f',
    title: 'Royalty Lab',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => (win = null));
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    shutdown = registerIpc(profileDir, () => win, () => app.quit(), refocusWindow).shutdown;
    setLockListener(() => win?.webContents.send('locked'));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('before-quit', () => { endSession(); shutdown(); });
  app.on('window-all-closed', () => {
    endSession();
    shutdown();
    app.quit();
  });
}
