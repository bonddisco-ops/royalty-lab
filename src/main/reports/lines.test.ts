import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { updateRow } from '../db/mutate.ts';
import { editLine, revertLine, rubToKop, splitLine } from './edits.ts';
import { commitImport, sha256Hex } from './importer.ts';
import { lineFacets, queryLines } from './lines.ts';
import { parseKnown } from './parse.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };

function setup() {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const wb = spDigital('related', [
    spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 1000, 50, 35),
    spRelRow('RUAAA2600002', 'Song B', 'Artist B', 'VK Music', 200, 10, 7),
  ], [60, 42]);
  const r = commitImport(db, ctx, { parsed: parseKnown(wb), fileName: 'a.xlsx', fileSha: sha256Hex(Buffer.from('a')), flow: 'artists', quarter: '2026Q2' });
  return { db, r };
}

test('рубли → копейки', () => {
  assert.equal(rubToKop('12,34'), 1234);
  assert.equal(rubToKop('0.005'), 1);
  assert.equal(rubToKop('-3'), -300);
  assert.throws(() => rubToKop('abc'));
});

test('таблица: без правок = исходные строки, итоги и фильтры', () => {
  const { db } = setup();
  const p = queryLines(db, { quarter: '2026Q2' });
  assert.equal(p.total, 2);
  assert.equal(p.totals.royaltyKop, 4200);
  assert.equal(p.totals.edited, 0);
  assert.equal(queryLines(db, { quarter: '2026Q2', q: 'song b' }).total, 1);
  assert.equal(queryLines(db, { quarter: '2026Q2', platform: ['VK Music'] }).total, 1);
  assert.deepEqual(lineFacets(db, '2026Q2').platform, ['VK Music', 'Yandex Music']);
});

test('правка тиража: ставка остаётся, исходное видно, откат возвращает', () => {
  const { db } = setup();
  const row = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  editLine(db, ctx, row.lineId, 'qty', '2000');
  const after = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  assert.equal(after.qty, 2000);
  assert.equal(after.royaltyKop, 7000);
  assert.equal(after.origQty, 1000);
  assert.deepEqual(after.changed, ['qty', 'royalty']);
  assert.equal(queryLines(db, { quarter: '2026Q2', edited: true }).total, 1);
  assert.equal(revertLine(db, ctx, row.lineId), 1);
  assert.equal(queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!.royaltyKop, 3500);
});

test('режим keep_royalty: при смене тиража роялти не меняется', () => {
  const { db } = setup();
  updateRow(db, ctx, 'settings', 'rate_change_mode', { value: 'keep_royalty' });
  const row = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  editLine(db, ctx, row.lineId, 'qty', '2000');
  const a = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  assert.equal(a.royaltyKop, 3500);
  assert.equal(a.rate, '0.0175');
});

test('перенос прослушиваний: две строки, сумма та же; в основной строке с переносом правится только тираж', () => {
  const { db } = setup();
  const row = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  splitLine(db, ctx, row.lineId, 400, 'ad');
  const rows = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((a, r) => a + r.royaltyKop, 0), 3500);
  assert.deepEqual(rows.map((r) => r.streamKind).sort(), ['ad', 'paid']);
  assert.throws(() => editLine(db, ctx, row.lineId, 'royalty', '5'), /только тираж/);
  assert.throws(() => splitLine(db, ctx, row.lineId, 9999, 'ad'), /осталось/);
  revertLine(db, ctx, row.lineId);
  assert.equal(queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows.length, 1);
});

test('валидация правок', () => {
  const { db } = setup();
  const row = queryLines(db, { quarter: '2026Q2' }).rows[0]!;
  assert.throws(() => editLine(db, ctx, row.lineId, 'qty', '-5'), /целое/);
  assert.throws(() => editLine(db, ctx, row.lineId, 'stream_kind', 'foo'), /тип/);
  assert.throws(() => editLine(db, ctx, row.lineId, 'track_id', 'nope'), /не найден/);
  assert.throws(() => editLine(db, ctx, 'nope', 'qty', '1'), /не найдена/);
});

test('правка перенесённой части: тираж возвращается в основную строку, ставка части, удаление переноса', () => {
  const { db } = setup();
  const line = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!.lineId;
  splitLine(db, ctx, line, 400, 'ad');
  const get = () => {
    const rows = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows;
    return { main: rows.find((r) => !r.splitId)!, moved: rows.find((r) => r.splitId)! };
  };
  editLine(db, ctx, line, 'qty', '300', get().moved.splitId);
  let { main, moved } = get();
  assert.deepEqual([main.qty, moved.qty], [700, 300]);
  assert.equal(main.royaltyKop + moved.royaltyKop, 3500); // ставка не задана — сумма сохраняется
  editLine(db, ctx, line, 'rate', '0', moved.splitId);
  ({ main, moved } = get());
  assert.equal(moved.royaltyKop, 0);
  assert.equal(main.royaltyKop, 2450); // 700 × 0,035
  editLine(db, ctx, line, 'qty', '600', null); // основная строка: разница уходит в перенос
  ({ main, moved } = get());
  assert.deepEqual([main.qty, moved.qty], [600, 400]);
  assert.throws(() => editLine(db, ctx, line, 'royalty', '1', null), /только тираж/);
  assert.throws(() => editLine(db, ctx, line, 'qty', '2000', get().moved.splitId), /не больше/);
  editLine(db, ctx, line, 'qty', '0', get().moved.splitId);
  assert.equal(queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows.length, 1);
  assert.equal(queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!.royaltyKop, 3500);
});

test('история строки: исходные значения неизменны, правки с автором, отменённые остаются', async () => {
  const { lineHistory } = await import('./lines.ts');
  const { db } = setup();
  const line = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!.lineId;
  editLine(db, ctx, line, 'qty', '2000');
  editLine(db, ctx, line, 'royalty', '40');
  const row = queryLines(db, { quarter: '2026Q2', q: 'song a' }).rows[0]!;
  assert.equal(row.lastEditBy, 'owner');
  revertLine(db, ctx, line);
  const h = lineHistory(db, line);
  assert.equal(h.original.qty, 1000);
  assert.equal(h.original.royaltyKop, 3500);
  assert.equal(h.steps.length, 2);
  assert.ok(h.steps.every((s) => !s.active && s.by === 'owner'));
});
