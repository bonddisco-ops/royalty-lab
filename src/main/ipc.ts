import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, parse } from 'node:path';
import type { AuthStatus, ChannelMap, DataState, FolderPick, IpcResult, PhotoTable, StarterPreview } from '../shared/api.ts';
import { cloudWarning, findExistingRoot, readConfig, rootFromParent, writeConfig } from './config.ts';
import { addUser, changePassword, initVault, listUsers, readUsers, unlock } from './crypto/keys.ts';
import { acquireLock, releaseLock } from './dataLock.ts';
import { backupDb } from './db/backup.ts';
import { ensureDefaultSettings } from './db/init.ts';
import { updateRow } from './db/mutate.ts';
import { openEncryptedDb } from './db/open.ts';
import { uuidv7 } from './domain/ids.ts';
import { dataPaths, ensureDataDirs, type DataPaths } from './paths.ts';
import { readPhoto, removePhoto, savePhoto } from './photos.ts';
import * as repo from './repo.ts';
import { catalogPeople, catalogTree, exportCatalog } from './export/catalog.ts';
import { registerReportsIpc } from './ipcReports.ts';
import { registerContractsIpc } from './ipcContracts.ts';
import { registerSyncIpc } from './ipcSync.ts';
import { moveDataRoot } from './moveData.ts';
import { buildStarterPlan, type StarterPlan } from './seed/starterPlan.ts';
import { readStarterWorkbook } from './seed/starterReader.ts';
import { writeStarterPlan } from './seed/starterWrite.ts';
import { beginSession, endSession, getSession, reschedule, requireSession, touch } from './session.ts';

type Handler<K extends keyof ChannelMap> = (req: ChannelMap[K][0]) => Promise<ChannelMap[K][1]> | ChannelMap[K][1];

const pending = new Map<string, { plan: StarterPlan; fileName: string }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PHOTO_COLUMN: Record<PhotoTable, string> = { counterparty: 'photo_file', artist: 'photo_file', track: 'cover_file' };

export function registerIpc(profileDir: string, getWindow: () => BrowserWindow | null, quit: () => void, refocus: () => void = () => {}): { shutdown: () => void } {
  const cfgFile = join(profileDir, 'config.json');
  let paths: DataPaths | null = null;
  let state: DataState = 'setup';
  let message: string | undefined;

  /** Определяет, можно ли работать: папка данных выбрана, доступна, не занята. Ничего молча не создаёт заново. */
  function evaluate(): void {
    if (paths) releaseLock(paths.lockFile);
    paths = null;
    message = undefined;
    const cfg = readConfig(cfgFile);
    if (!cfg.dataRoot) { state = 'setup'; return; }
    const p = dataPaths(cfg.dataRoot, profileDir, cfg.backupDir);
    const vault = readUsers(p.usersFile) !== null;
    if (!existsSync(p.root) || (vault && !existsSync(p.dbFile))) { state = 'missing'; return; }
    try {
      ensureDataDirs(p);
      acquireLock(p.lockFile);
      paths = p;
      state = 'ok';
    } catch (e) {
      state = 'busy';
      message = (e as Error).message;
    }
  }
  evaluate();

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
    const cfg = readConfig(cfgFile);
    return {
      data: { state, path: paths?.root ?? cfg.dataRoot, defaultRoot: profileDir, backupDir: cfg.backupDir, message },
      initialized: paths ? readUsers(paths.usersFile) !== null : false,
      unlocked: !!s,
      user: s?.user ?? null,
      users: paths ? listUsers(paths.usersFile) : [],
    };
  };
  const dataPathsOrThrow = (): DataPaths => {
    if (state !== 'ok' || !paths) throw new Error('Папка данных недоступна');
    return paths;
  };
  const pickFolder = async (title: string): Promise<string | null> => {
    const win = getWindow();
    const opts = { title, properties: ['openDirectory' as const, 'createDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : res.filePaths[0] ?? null;
  };

  const db = () => requireSession().db;
  const ctx = () => requireSession().ctx;

  // ------------------------------------------------------- папка данных (самое начало)
  handle('data:pick', async (): Promise<FolderPick | null> => {
    const p = await pickFolder('Где хранить данные? Внутри создам папку RoyaltyLab');
    return p ? { path: p, warning: cloudWarning(rootFromParent(p)) ?? cloudWarning(p) } : null;
  }, { open: true });

  handle('data:setup', ({ parent }) => {
    if (state !== 'setup') throw new Error('Папка данных уже выбрана');
    const root = parent ? rootFromParent(parent) : profileDir;
    try {
      mkdirSync(root, { recursive: true });
      const probe = join(root, '.rl-write-test');
      writeFileSync(probe, '');
      rmSync(probe, { force: true });
      ensureDataDirs(dataPaths(root, profileDir));
    } catch {
      throw new Error(`Не получилось создать папку «${root}». Проверьте, что диск подключён и есть права на запись.`);
    }
    writeConfig(cfgFile, { dataRoot: root, backupDir: null });
    evaluate();
    return status();
  }, { open: true });

  handle('data:relocate', async () => {
    const picked = await pickFolder('Укажите папку с данными (где лежит data.rldb)');
    if (picked) {
      const root = findExistingRoot(picked);
      if (!root) throw new Error('В этой папке нет файла data.rldb. Выберите папку RoyaltyLab с вашими данными.');
      writeConfig(cfgFile, { ...readConfig(cfgFile), dataRoot: root });
      evaluate();
    }
    return status();
  }, { open: true });

  handle('data:retry', () => { evaluate(); return status(); }, { open: true });
  handle('data:quit', () => { quit(); }, { open: true });

  handle('data:pickBackupDir', async (): Promise<FolderPick | null> => {
    const cur = dataPathsOrThrow();
    const p = await pickFolder('Папка для резервных копий (лучше на другом диске)');
    if (!p) return null;
    writeConfig(cfgFile, { ...readConfig(cfgFile), backupDir: p });
    paths = dataPaths(cur.root, profileDir, p);
    const s = getSession();
    if (s) s.paths = paths;
    const sameDrive = parse(p).root.toLowerCase() === parse(cur.root).root.toLowerCase();
    return { path: p, warning: cloudWarning(p) ?? (sameDrive ? 'Копии лежат на том же диске, что и база: при поломке диска пропадёт всё сразу. Лучше выбрать другой диск.' : null) };
  }, { open: true });

  // ------------------------------------------------------------------ вход
  handle('auth:status', () => status(), { open: true });

  handle('auth:init', async ({ login, password }) => {
    const P = dataPathsOrThrow();
    const { dk, replicaId, user } = await initVault(P.usersFile, login, password);
    const open = openEncryptedDb(P.dbFile, dk, replicaId);
    const c = { userId: user.login, replicaId };
    ensureDefaultSettings(open.db, c);
    beginSession({ open, db: open.db, ctx: c, user: { login: user.login, role: user.role }, dk, paths: P });
    return status();
  }, { open: true });

  handle('auth:login', async ({ login, password }) => {
    const P = dataPathsOrThrow();
    try {
      const { dk, replicaId, user } = await unlock(P.usersFile, login, password);
      const open = openEncryptedDb(P.dbFile, dk, replicaId);
      const c = { userId: user.login, replicaId };
      ensureDefaultSettings(open.db, c);
      beginSession({ open, db: open.db, ctx: c, user: { login: user.login, role: user.role }, dk, paths: P });
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
    await addUser(requireSession().paths.usersFile, requireSession().dk, login, password, role);
  });
  handle('auth:changePassword', async ({ oldPassword, newPassword }) => {
    const s = requireSession();
    await changePassword(s.paths.usersFile, s.user.login, oldPassword, newPassword);
  });

  // ------------------------------------------------------- фото и обложки
  const photoOwner = (table: PhotoTable, id: string) => {
    if (!(table in PHOTO_COLUMN)) throw new Error('Неизвестный тип картинки');
    const row = db().prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id);
    if (!row) throw new Error('Карточка не найдена');
    return row;
  };
  handle('photo:set', ({ table, id, full, thumb }) => {
    const s = requireSession();
    const row = photoOwner(table, id);
    const col = PHOTO_COLUMN[table];
    const file = savePhoto(s.paths.photos, s.dk, full, thumb);
    updateRow(s.db, s.ctx, table, id, { [col]: file });
    removePhoto(s.paths.photos, row[col] as string | null);
    return file;
  });
  handle('photo:remove', ({ table, id }) => {
    const s = requireSession();
    const row = photoOwner(table, id);
    const col = PHOTO_COLUMN[table];
    updateRow(s.db, s.ctx, table, id, { [col]: null });
    removePhoto(s.paths.photos, row[col] as string | null);
  });
  handle('photo:get', ({ file, thumb }) => {
    const s = requireSession();
    const buf = readPhoto(s.paths.photos, s.dk, file, thumb);
    return buf ? `data:image/png;base64,${buf.toString('base64')}` : null;
  });
  handle('photo:export', async ({ table, id }) => {
    const s = requireSession();
    const row = photoOwner(table, id);
    const file = row[PHOTO_COLUMN[table]] as string | null;
    if (!file) throw new Error('Картинки нет');
    const buf = readPhoto(s.paths.photos, s.dk, file, false);
    if (!buf) throw new Error('Файл картинки не найден в папке данных');
    const name = String(row.name ?? row.title ?? row.last_name ?? 'image').replace(/[\\/:*?"<>|]/g, '_');
    const win = getWindow();
    const opts = { title: 'Сохранить картинку', defaultPath: `${name}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, buf);
    return res.filePath;
  });

  // ---------------------------------------------------------------- каталог
  handle('dash:get', () => { const s = requireSession(); repo.revalidateIssues(s.db, s.ctx); return repo.dashboard(s.db); });
  handle('people:list', ({ q }) => repo.listPeople(db(), q));
  handle('people:get', ({ id, reveal }) => repo.getPerson(db(), id, !!reveal));
  handle('people:create', (data) => repo.createPerson(db(), ctx(), data));
  handle('people:addArtist', ({ personId, artistId, name }) => repo.addArtistToPerson(db(), ctx(), personId, { artistId, name }));
  handle('catalog:tree', () => catalogTree(db()));
  handle('catalog:preview', ({ artistIds }) => {
    const r = catalogPeople(db(), artistIds);
    return { people: r.people.map((p) => ({ personId: p.personId, name: p.name, projects: p.projects, tracks: p.tracks.length, missing: p.missing })), unassigned: r.unassigned };
  });
  handle('catalog:export', ({ artistIds }) => exportCatalog(db(), requireSession().paths.output, artistIds));
  handle('people:setOwner', ({ id, owner }) => repo.setOwner(db(), ctx(), id, owner));
  handle('people:update', ({ id, patch }) => repo.updatePerson(db(), ctx(), id, patch));
  handle('artists:list', ({ q }) => repo.listArtists(db(), q));
  handle('artists:delete', ({ id }) => repo.deleteArtist(db(), ctx(), id));
  handle('people:delete', ({ id }) => repo.deletePerson(db(), ctx(), id));
  handle('artists:create', (d) => repo.createArtist(db(), ctx(), d));
  handle('artists:update', ({ id, patch }) => repo.updateArtist(db(), ctx(), id, patch));
  handle('artists:addVariant', ({ id, text }) => repo.addArtistVariant(db(), ctx(), id, text));
  handle('tracks:list', ({ q, onlyProblems }) => repo.listTracks(db(), q, !!onlyProblems));
  handle('tracks:quickAdd', (d) => repo.quickAddTrack(db(), ctx(), d));
  handle('tracks:create', (d) => repo.createTrack(db(), ctx(), d));
  handle('tracks:update', ({ id, patch }) => repo.updateTrack(db(), ctx(), id, patch));
  handle('parts:add', (d) => repo.addParticipation(db(), ctx(), d));
  handle('parts:update', ({ id, patch }) => repo.updateParticipation(db(), ctx(), id, patch));
  handle('parts:remove', ({ id }) => repo.removeParticipation(db(), ctx(), id));
  handle('parts:fix', ({ trackId, participationId }) => repo.fixShares(db(), ctx(), trackId, participationId));
  handle('issues:list', ({ status: st, kind, reportVersionId }) => { const s = requireSession(); repo.revalidateIssues(s.db, s.ctx); return repo.listIssues(s.db, st ?? 'open', kind, reportVersionId); });
  handle('issues:resolve', ({ id, status: st, note }) => repo.resolveIssue(db(), ctx(), id, st, note));
  handle('history:get', ({ table, id }) => repo.history(db(), table, id));
  handle('settings:get', () => repo.getSettings(db()));
  handle('settings:set', ({ id, value }) => {
    repo.setSetting(db(), ctx(), id, value);
    if (id === 'auto_lock_minutes') reschedule();
  });

  handle('app:refocus', () => { refocus(); });
  registerReportsIpc(handle, getWindow);
  registerContractsIpc(handle);
  registerSyncIpc(handle, getWindow);

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

  handle('data:move', async () => {
    const s = requireSession();
    if (s.user.role !== 'owner') throw new Error('Переносить данные может только владелец');
    const parent = await pickFolder('Куда перенести данные? Внутри создам папку RoyaltyLab');
    if (!parent) return null;
    const oldRoot = s.paths.root;
    const newRoot = rootFromParent(parent);
    const warning = cloudWarning(newRoot) ?? cloudWarning(parent);
    endSession(); // закрывает базу, делает копию
    try {
      const r = moveDataRoot(oldRoot, newRoot);
      writeConfig(cfgFile, { ...readConfig(cfgFile), dataRoot: newRoot });
      evaluate();
      return { path: newRoot, oldPath: oldRoot, files: r.files, warning, status: status() };
    } catch (e) {
      evaluate();
      throw e;
    }
  });

  handle('backup:now', () => {
    const s = requireSession();
    return backupDb(s.db, s.open.file, s.paths.backups, 'manual');
  });
  return { shutdown: () => { if (paths) releaseLock(paths.lockFile); } };
}
