import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { dataPaths, ensureDataDirs } from './paths.ts';
import { registerIpc } from './ipc.ts';
import { endSession, setLockListener } from './session.ts';

const root = process.env.ROYALTY_LAB_DATA ?? join(app.getPath('appData'), 'RoyaltyLab');
const paths = dataPaths(root);
let win: BrowserWindow | null = null;

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
    ensureDataDirs(paths);
    registerIpc(paths, () => win);
    setLockListener(() => win?.webContents.send('locked'));
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('before-quit', () => endSession());
  app.on('window-all-closed', () => {
    endSession();
    app.quit();
  });
}
