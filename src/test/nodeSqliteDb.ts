// Адаптер над встроенным node:sqlite: позволяет гонять ядро (миграции, mutate, загрузчик)
// без нативных зависимостей. В самой программе используется better-sqlite3-multiple-ciphers.
import { DatabaseSync } from 'node:sqlite';
import type { Db, Stmt } from '../main/db/types.ts';
import { initMeta, migrate } from '../main/db/schema.ts';

export function openNodeSqlite(path = ':memory:'): Db {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  let sp = 0;
  const db: Db = {
    prepare(sql: string): Stmt {
      const st = raw.prepare(sql);
      return {
        run: (...p) => st.run(...(p as never[])) as { changes: number | bigint },
        get: (...p) => st.get(...(p as never[])) as Record<string, any> | undefined,
        all: (...p) => st.all(...(p as never[])) as Record<string, any>[],
      };
    },
    exec: (sql) => raw.exec(sql),
    transaction<T>(fn: () => T): () => T {
      return () => {
        const name = depth === 0 ? null : `sp${++sp}`;
        raw.exec(name ? `SAVEPOINT ${name}` : 'BEGIN');
        depth++;
        try {
          const r = fn();
          depth--;
          raw.exec(name ? `RELEASE ${name}` : 'COMMIT');
          return r;
        } catch (e) {
          depth--;
          raw.exec(name ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
          throw e;
        }
      };
    },
  };
  return db;
}

export function freshDb(replicaId = 'test-replica'): Db {
  const db = openNodeSqlite();
  migrate(db);
  initMeta(db, replicaId);
  return db;
}
