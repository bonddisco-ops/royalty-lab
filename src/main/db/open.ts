import { existsSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { initMeta, migrate } from './schema.ts';
import type { Db } from './types.ts';

export interface OpenDb {
  db: Db;
  file: string;
  close(): void;
}

/** Открывает (или создаёт) зашифрованную SQLite. Ключ данных (DK) передаётся «сырым»: x'<64 hex>'. */
export function openEncryptedDb(file: string, dk: Buffer, replicaId: string): OpenDb {
  if (dk.length !== 32) throw new Error('Ключ данных должен быть 32 байта');
  const isNew = !existsSync(file);
  const raw = new Database(file);
  try {
    raw.pragma("cipher='sqlcipher'");
    raw.pragma(`key="x'${dk.toString('hex')}'"`);
    raw.prepare('SELECT count(*) AS n FROM sqlite_master').get(); // с неверным ключом падает здесь
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
  } catch {
    raw.close();
    throw new Error(isNew ? 'Не удалось создать базу' : 'Не удалось открыть базу: неверный ключ или файл повреждён');
  }
  const db = raw as unknown as Db;
  migrate(db);
  initMeta(db, replicaId);
  return { db, file, close: () => raw.close() };
}
