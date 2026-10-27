import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './types.ts';

export const BACKUPS_TO_KEEP = 30;

/** Копия зашифрованного файла базы (она уже зашифрована, шифровать повторно не нужно). Хранится 30 копий. */
export function backupDb(db: Db, dbFile: string, backupsDir: string, reason: string): string {
  mkdirSync(backupsDir, { recursive: true });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupsDir, `data-${stamp}-${reason.replace(/[^a-z0-9_-]/gi, '')}.rldb`);
  copyFileSync(dbFile, target);
  const all = readdirSync(backupsDir).filter((f) => f.startsWith('data-') && f.endsWith('.rldb')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_TO_KEEP))) rmSync(join(backupsDir, old), { force: true });
  return target;
}
