import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { deleteRow, insertRow, mutate, updateRow } from './mutate.ts';
import type { Ctx } from './types.ts';

const ctx: Ctx = { userId: 'owner', replicaId: 'test-replica' };

test('insert пишет строку и событие в change_log', () => {
  const db = freshDb();
  const id = insertRow(db, ctx, 'artist', { name: 'Alosa' });
  const row = db.prepare('SELECT * FROM artist WHERE id = ?').get(id)!;
  assert.equal(row.name, 'Alosa');
  assert.equal(row.updated_by, 'owner');
  const log = db.prepare('SELECT * FROM change_log WHERE row_id = ?').all(id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.op, 'insert');
  assert.equal(log[0]!.seq, 1);
});

test('update: по событию на каждое изменённое поле, без изменений событий нет', () => {
  const db = freshDb();
  const id = insertRow(db, ctx, 'counterparty', { last_name: 'Иванов', first_name: 'Иван' });
  updateRow(db, ctx, 'counterparty', id, { last_name: 'Петров', first_name: 'Иван' });
  const upd = db.prepare("SELECT * FROM change_log WHERE row_id = ? AND op = 'update'").all(id);
  assert.equal(upd.length, 1);
  assert.equal(upd[0]!.field, 'last_name');
  assert.equal(upd[0]!.old_value, 'Иванов');
  assert.equal(upd[0]!.new_value, 'Петров');
  updateRow(db, ctx, 'counterparty', id, { last_name: 'Петров' });
  assert.equal(db.prepare("SELECT count(*) AS n FROM change_log WHERE op = 'update'").get()!.n, 1);
});

test('delete мягкий: строка остаётся, deleted_at проставлен', () => {
  const db = freshDb();
  const id = insertRow(db, ctx, 'artist', { name: 'X' });
  deleteRow(db, ctx, 'artist', id);
  assert.ok(db.prepare('SELECT deleted_at FROM artist WHERE id = ?').get(id)!.deleted_at);
});

test('seq растёт без дыр, откат транзакции не оставляет событий', () => {
  const db = freshDb();
  insertRow(db, ctx, 'artist', { name: 'A' });
  assert.throws(() =>
    mutate(db, ctx, [
      { kind: 'insert', table: 'artist', row: { name: 'B' } },
      { kind: 'insert', table: 'artist', row: { nope: 1 } },
    ]),
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM artist').get()!.n, 1);
  insertRow(db, ctx, 'artist', { name: 'C' });
  const seqs = db.prepare('SELECT seq FROM change_log ORDER BY seq').all().map((r) => r.seq);
  assert.deepEqual(seqs, [1, 2]);
});

test('запись мимо списка таблиц данных запрещена', () => {
  const db = freshDb();
  assert.throws(() => insertRow(db, ctx, 'change_log', { id: 'x' }), /не входит в таблицы данных/);
});

test('защищённые поля менять нельзя', () => {
  const db = freshDb();
  const id = insertRow(db, ctx, 'artist', { name: 'A' });
  assert.throws(() => updateRow(db, ctx, 'artist', id, { deleted_at: 'x' }), /менять нельзя/);
});
