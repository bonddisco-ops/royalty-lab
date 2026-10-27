import { uuidv7 } from '../domain/ids.ts';
import { DATA_TABLES } from './schema.ts';
import type { Ctx, Db, Row } from './types.ts';

export type InsertOp = { kind: 'insert'; table: string; row: Row };
export type UpdateOp = { kind: 'update'; table: string; id: string; patch: Row };
export type DeleteOp = { kind: 'delete'; table: string; id: string };
export type Op = InsertOp | UpdateOp | DeleteOp;

const PROTECTED = new Set(['id', 'created_at', 'updated_at', 'updated_by', 'deleted_at']);
const columnCache = new WeakMap<Db, Map<string, Set<string>>>();

function columnsOf(db: Db, table: string): Set<string> {
  if (!(DATA_TABLES as readonly string[]).includes(table)) {
    throw new Error(`mutate: таблица «${table}» не входит в таблицы данных`);
  }
  let perDb = columnCache.get(db);
  if (!perDb) columnCache.set(db, (perDb = new Map()));
  let cols = perDb.get(table);
  if (!cols) {
    cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
    perDb.set(table, cols);
  }
  return cols;
}

function bind(v: unknown): string | number | bigint | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | bigint;
}

function asLog(v: unknown): string | null {
  const b = bind(v);
  return b === null ? null : String(b);
}

function nextSeq(db: Db): number {
  const cur = Number(db.prepare("SELECT value FROM meta WHERE key = 'seq'").get()?.value ?? 0);
  const next = cur + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'seq'").run(String(next));
  return next;
}

function logEvent(
  db: Db,
  ctx: Ctx,
  e: { table: string; rowId: string; op: 'insert' | 'update' | 'delete'; field: string | null; oldV: string | null; newV: string | null },
): void {
  db.prepare(
    `INSERT INTO change_log (id, replica_id, seq, user_id, ts, table_name, row_id, op, field, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuidv7(), ctx.replicaId, nextSeq(db), ctx.userId, new Date().toISOString(), e.table, e.rowId, e.op, e.field, e.oldV, e.newV);
}

function applyOp(db: Db, ctx: Ctx, op: Op): string {
  const cols = columnsOf(db, op.table);
  const now = new Date().toISOString();

  if (op.kind === 'insert') {
    const id = String(op.row.id ?? uuidv7());
    const row: Row = { ...op.row, id, created_at: now, updated_at: now, updated_by: ctx.userId, deleted_at: null };
    for (const k of Object.keys(row)) {
      if (!cols.has(k)) throw new Error(`mutate: в таблице «${op.table}» нет колонки «${k}»`);
    }
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${op.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
      ...keys.map((k) => bind(row[k])),
    );
    const logged: Row = {};
    for (const k of keys) if (!PROTECTED.has(k) || k === 'id') logged[k] = row[k] ?? null;
    logEvent(db, ctx, { table: op.table, rowId: id, op: 'insert', field: null, oldV: null, newV: JSON.stringify(logged) });
    return id;
  }

  if (op.kind === 'update') {
    const old = db.prepare(`SELECT * FROM ${op.table} WHERE id = ?`).get(op.id);
    if (!old) throw new Error(`mutate: строка ${op.table}/${op.id} не найдена`);
    const changed: Array<[string, unknown, unknown]> = [];
    for (const [k, v] of Object.entries(op.patch)) {
      if (PROTECTED.has(k)) throw new Error(`mutate: поле «${k}» менять нельзя`);
      if (!cols.has(k)) throw new Error(`mutate: в таблице «${op.table}» нет колонки «${k}»`);
      const before = asLog(old[k]);
      const after = asLog(v);
      if (before !== after) changed.push([k, old[k], v]);
    }
    if (changed.length === 0) return op.id;
    const sets = changed.map(([k]) => `${k} = ?`).concat(['updated_at = ?', 'updated_by = ?']);
    db.prepare(`UPDATE ${op.table} SET ${sets.join(', ')} WHERE id = ?`).run(
      ...changed.map(([, , v]) => bind(v)),
      now,
      ctx.userId,
      op.id,
    );
    for (const [k, before, after] of changed) {
      logEvent(db, ctx, { table: op.table, rowId: op.id, op: 'update', field: k, oldV: asLog(before), newV: asLog(after) });
    }
    return op.id;
  }

  // delete = мягкое удаление
  const old = db.prepare(`SELECT deleted_at FROM ${op.table} WHERE id = ?`).get(op.id);
  if (!old) throw new Error(`mutate: строка ${op.table}/${op.id} не найдена`);
  if (old.deleted_at) return op.id;
  db.prepare(`UPDATE ${op.table} SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(now, now, ctx.userId, op.id);
  logEvent(db, ctx, { table: op.table, rowId: op.id, op: 'delete', field: 'deleted_at', oldV: null, newV: now });
  return op.id;
}

/** Единственный путь записи в таблицы данных: правка + событие в change_log в одной транзакции. */
export function mutate(db: Db, ctx: Ctx, ops: Op[]): string[] {
  const ids: string[] = [];
  db.transaction(() => {
    for (const op of ops) ids.push(applyOp(db, ctx, op));
  })();
  return ids;
}

export const insertRow = (db: Db, ctx: Ctx, table: string, row: Row): string => mutate(db, ctx, [{ kind: 'insert', table, row }])[0]!;
export const updateRow = (db: Db, ctx: Ctx, table: string, id: string, patch: Row): void => {
  mutate(db, ctx, [{ kind: 'update', table, id, patch }]);
};
export const deleteRow = (db: Db, ctx: Ctx, table: string, id: string): void => {
  mutate(db, ctx, [{ kind: 'delete', table, id }]);
};
