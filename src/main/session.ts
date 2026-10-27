import { backupDb } from './db/backup.ts';
import { getSetting } from './db/init.ts';
import type { OpenDb } from './db/open.ts';
import type { Ctx, Db } from './db/types.ts';
import type { Role } from './crypto/keys.ts';
import type { DataPaths } from './paths.ts';

export interface Session {
  open: OpenDb;
  db: Db;
  ctx: Ctx;
  user: { login: string; role: Role };
  dk: Buffer;
  paths: DataPaths;
}

let session: Session | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lockListener: (() => void) | null = null;

export function setLockListener(cb: () => void): void {
  lockListener = cb;
}
export function getSession(): Session | null {
  return session;
}
export function requireSession(): Session {
  if (!session) throw new Error('Программа заблокирована. Войдите заново.');
  return session;
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Автоблокировка после N минут простоя (настройка auto_lock_minutes, 0 = выключена). */
export function reschedule(): void {
  clearTimer();
  if (!session) return;
  const minutes = Number(getSetting(session.db, 'auto_lock_minutes'));
  if (minutes > 0) {
    timer = setTimeout(() => {
      endSession();
      lockListener?.();
    }, minutes * 60_000);
  }
}

export function beginSession(s: Session): void {
  endSession();
  session = s;
  reschedule();
}

/** Любое действие пользователя сдвигает таймер простоя. */
export function touch(): void {
  if (session) reschedule();
}

/** Закрытие: автобэкап (Схема_БД.md §1), закрытие базы, стирание ключа из памяти. */
export function endSession(): void {
  clearTimer();
  const s = session;
  if (!s) return;
  session = null;
  try {
    backupDb(s.db, s.open.file, s.paths.backups, 'close');
  } catch (e) {
    console.error('Бэкап при закрытии не удался:', e);
  }
  try {
    s.open.close();
  } catch (e) {
    console.error('Закрытие базы:', e);
  }
  s.dk.fill(0);
}
