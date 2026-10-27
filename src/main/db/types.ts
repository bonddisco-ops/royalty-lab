// Минимальный интерфейс БД: его реализуют better-sqlite3-multiple-ciphers (в программе)
// и адаптер над node:sqlite (в локальных тестах без нативных зависимостей).
export type Row = Record<string, any>;

export interface Stmt {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  /** Возвращает функцию, которая выполняет fn в транзакции (вложенные — через savepoint). */
  transaction<T>(fn: () => T): () => T;
}

export interface Ctx {
  /** Логин пользователя, подписывающего правки. */
  userId: string;
  /** Идентификатор этой установки программы (у владельца и бухгалтера разные). */
  replicaId: string;
}
