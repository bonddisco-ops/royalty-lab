// IPC обмена обновлениями (.rlab): сохранить файл, открыть, показать «Что изменилось», применить.
import { dialog, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { backupDb } from './db/backup.ts';
import { applyPayload, buildPayload, parsePayload, previewPayload, type Parsed } from './sync/exchange.ts';
import { openRlab, sealRlab } from './sync/rlab.ts';
import { uuidv7 } from './domain/ids.ts';
import { requireSession } from './session.ts';
import type { HandleFn } from './ipcReports.ts';

const pending = new Map<string, Parsed>();

export function registerSyncIpc(handle: HandleFn, getWindow: () => BrowserWindow | null): void {
  handle('sync:save', async ({ password, includePii }) => {
    const s = requireSession();
    const { zip, events } = buildPayload(s.db, { includePii, author: s.user.login, replicaId: s.ctx.replicaId, dk: s.dk, photosDir: s.paths.photos, reportsDir: s.paths.reports });
    const sealed = await sealRlab(zip, password);
    const win = getWindow();
    const stamp = new Date().toISOString().slice(0, 10);
    const opts = { title: 'Сохранить обновление', defaultPath: `Обновление-${stamp}.rlab`, filters: [{ name: 'Обновление Royalty Lab', extensions: ['rlab'] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, sealed);
    return { path: res.filePath, events, bytes: sealed.length };
  });
  handle('sync:open', async ({ password }) => {
    const s = requireSession();
    const win = getWindow();
    const opts = { title: 'Загрузить обновление', properties: ['openFile' as const], filters: [{ name: 'Обновление Royalty Lab', extensions: ['rlab'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    const parsed = parsePayload(await openRlab(readFileSync(res.filePaths[0]), password));
    if (parsed.manifest.replica === s.ctx.replicaId) throw new Error('Это файл, который сделан в этой же программе. Загрузить его нужно на другом компьютере.');
    const token = uuidv7();
    pending.clear();
    pending.set(token, parsed);
    return { token, preview: previewPayload(s.db, parsed, s.ctx.replicaId) };
  });
  handle('sync:apply', ({ token, skipGroups, keepMine }) => {
    const s = requireSession();
    const p = pending.get(token);
    if (!p) throw new Error('Файл обновления уже закрыт. Откройте его заново.');
    backupDb(s.db, s.open.file, s.paths.backups, 'before-update');
    const r = applyPayload(s.db, s.ctx, p, { skipGroups, keepMine }, { dk: s.dk, photosDir: s.paths.photos, reportsDir: s.paths.reports });
    pending.delete(token);
    return r;
  });
  handle('sync:cancel', () => { pending.clear(); });
}
