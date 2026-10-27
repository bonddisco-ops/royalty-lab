import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { basename } from 'node:path';
import type { AuthStatus, ChannelMap, IpcResult, StarterPreview } from '../shared/api.ts';
import { addUser, changePassword, initVault, listUsers, readUsers, unlock } from './crypto/keys.ts';
import { backupDb } from './db/backup.ts';
import { ensureDefaultSettings } from './db/init.ts';
import { openEncryptedDb } from './db/open.ts';
import { uuidv7 } from './domain/ids.ts';
import { ensureDataDirs, type DataPaths } from './paths.ts';
import * as repo from './repo.ts';
import { buildStarterPlan, type StarterPlan } from './seed/starterPlan.ts';
import { readStarterWorkbook } from './seed/starterReader.ts';
import { writeStarterPlan } from './seed/starterWrite.ts';
import { beginSession, endSession, getSession, reschedule, requireSession, touch } from './session.ts';

type Handler<K extends keyof ChannelMap> = (req: ChannelMap[K][0]) => Promise<ChannelMap[K][1]> | ChannelMap[K][1];

const pending = new Map<string, { plan: StarterPlan; fileName: string }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerIpc(paths: DataPaths, getWindow: () => BrowserWindow | null): void {
  function handle<K extends keyof ChannelMap>(channel: K, fn: Handler<K>, opts: { open?: boolean } = {}): void {
    ipcMain.handle(channel, async (_e, req): Promise<IpcResult<ChannelMap[K][1]>> => {
      try {
        if (!opts.open) {
          requireSession();
          touch();
        }
        return { ok: true, data: await fn(req) };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
  }

  const status = (): AuthStatus => {
    const s = getSession();
    return { initialized: readUsers(paths.usersFile) !== null, unlocked: !!s, user: s?.user ?? null, users: listUsers(paths.usersFile) };
  };

  const db = () => requireSession().db;
  const ctx = () => requireSession().ctx;

  // ------------------------------------------------------------------ вход
  handle('auth:status', () => status(), { open: true });

  handle('auth:init', async ({ login, password }) => {
    ensureDataDirs(paths);
    const { dk, replicaId, user } = await initVault(paths.usersFile, login, password);
    const open = openEncryptedDb(paths.dbFile, dk, replicaId);
    const c = { userId: user.login, replicaId };
    ensureDefaultSettings(open.db, c);
    beginSession({ open, db: open.db, ctx: c, user: { login: user.login, role: user.role }, dk, paths });
    return status();
  }, { open: true });

  handle('auth:login', async ({ login, password }) => {
    try {
      const { dk, replicaId, user } = await unlock(paths.usersFile, login, password);
      const open = openEncryptedDb(paths.dbFile, dk, replicaId);
      const c = { userId: user.login, replicaId };
      ensureDefaultSettings(open.db, c);
      beginSession({ open, db: open.db, ctx: c, user: { login: user.login, role: user.role }, dk, paths });
      return status();
    } catch (e) {
      await sleep(600); // не даём перебирать пароли быстро
      throw e;
    }
  }, { open: true });

  handle('auth:logout', () => {
    endSession();
    return status();
  }, { open: true });

  handle('auth:addUser', async ({ login, password, role }) => {
    await addUser(paths.usersFile, requireSession().dk, login, password, role);
  });
  handle('auth:changePassword', async ({ oldPassword, newPassword }) => {
    await changePassword(paths.usersFile, requireSession().user.login, oldPassword, newPassword);
  });

  // ---------------------------------------------------------------- каталог
  handle('dash:get', () => repo.dashboard(db()));
  handle('people:list', ({ q }) => repo.listPeople(db(), q));
  handle('people:get', ({ id, reveal }) => repo.getPerson(db(), id, !!reveal));
  handle('people:create', (data) => repo.createPerson(db(), ctx(), data));
  handle('people:update', ({ id, patch }) => repo.updatePerson(db(), ctx(), id, patch));
  handle('artists:list', ({ q }) => repo.listArtists(db(), q));
  handle('artists:create', (d) => repo.createArtist(db(), ctx(), d));
  handle('artists:update', ({ id, patch }) => repo.updateArtist(db(), ctx(), id, patch));
  handle('artists:addVariant', ({ id, text }) => repo.addArtistVariant(db(), ctx(), id, text));
  handle('tracks:list', ({ q, onlyProblems }) => repo.listTracks(db(), q, !!onlyProblems));
  handle('tracks:create', (d) => repo.createTrack(db(), ctx(), d));
  handle('tracks:update', ({ id, patch }) => repo.updateTrack(db(), ctx(), id, patch));
  handle('parts:add', (d) => repo.addParticipation(db(), ctx(), d));
  handle('parts:update', ({ id, patch }) => repo.updateParticipation(db(), ctx(), id, patch));
  handle('parts:remove', ({ id }) => repo.removeParticipation(db(), ctx(), id));
  handle('parts:fix', ({ trackId, participationId }) => repo.fixShares(db(), ctx(), trackId, participationId));
  handle('issues:list', ({ status: st, kind }) => repo.listIssues(db(), st ?? 'open', kind));
  handle('issues:resolve', ({ id, status: st, note }) => repo.resolveIssue(db(), ctx(), id, st, note));
  handle('history:get', ({ table, id }) => repo.history(db(), table, id));
  handle('settings:get', () => repo.getSettings(db()));
  handle('settings:set', ({ id, value }) => {
    repo.setSetting(db(), ctx(), id, value);
    if (id === 'auto_lock_minutes') reschedule();
  });

  // ---------------------------------------------------- стартовая база (этап 1)
  handle('starter:pick', async (): Promise<StarterPreview | null> => {
    const win = getWindow();
    const opts = { title: 'Стартовая_база.xlsx', properties: ['openFile' as const], filters: [{ name: 'Excel', extensions: ['xlsx'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    const plan = buildStarterPlan(await readStarterWorkbook(file));
    const token = uuidv7();
    pending.set(token, { plan, fileName: basename(file) });
    return { token, fileName: basename(file), summary: plan.summary };
  });

  handle('starter:apply', ({ token }) => {
    const p = pending.get(token);
    if (!p) throw new Error('Предпросмотр устарел, выберите файл заново');
    const s = requireSession();
    const backup = backupDb(s.db, s.open.file, s.paths.backups, 'before-starter');
    writeStarterPlan(s.db, s.ctx, p.plan);
    pending.delete(token);
    return { summary: p.plan.summary, backup };
  });

  handle('backup:now', () => {
    const s = requireSession();
    return backupDb(s.db, s.open.file, s.paths.backups, 'manual');
  });
}
