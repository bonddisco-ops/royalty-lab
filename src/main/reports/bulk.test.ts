import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { applyBulk, listBatches, planBulk, revertBatch } from './bulk.ts';
import { editLine } from './edits.ts';
import { commitImport, sha256Hex } from './importer.ts';
import { queryLines } from './lines.ts';
import { parseKnown } from './parse.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
const Q = { quarter: '2026Q2' };

function setup() {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const wb = spDigital('related', [
    spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 1000, 50, 35),
    spRelRow('RUAAA2600002', 'Song B', 'Artist B', 'VK Music', 200, 10, 7),
    spRelRow('RUAAA2600003', 'Song C', 'Artist C', 'VK Music', 100, 5, 3.5),
  ], [65, 45.5]);
  commitImport(db, ctx, { parsed: parseKnown(wb), fileName: 'a.xlsx', fileSha: sha256Hex(Buffer.from('a')), flow: 'artists', quarter: '2026Q2' });
  return db;
}
const total = (db: ReturnType<typeof setup>, f = Q) => queryLines(db, f).totals.royaltyKop;

test('массово: роялти −10% по фильтру площадки, предпросмотр равен результату, откат возвращает', () => {
  const db = setup();
  const f = { ...Q, platform: ['VK Music'] };
  const plan = planBulk(db, f, { type: 'change', field: 'royalty', mode: 'percent', value: '-10' });
  assert.equal(plan.affected, 2);
  assert.equal(plan.deltaKop, -105); // 700+350 = 1050 → −105
  const before = total(db);
  const res = applyBulk(db, ctx, f, { type: 'change', field: 'royalty', mode: 'percent', value: '-10' });
  assert.equal(res.deltaKop, -105);
  assert.equal(total(db), before - 105);
  assert.equal(listBatches(db)[0]!.affected, 2);
  assert.ok(revertBatch(db, ctx, res.batchId) >= 2);
  assert.equal(total(db), before);
  assert.throws(() => revertBatch(db, ctx, res.batchId), /уже откатана/);
});

test('массово: задать тип стрима и тираж +N', () => {
  const db = setup();
  applyBulk(db, ctx, { ...Q, platform: ['VK Music'] }, { type: 'set', field: 'stream_kind', value: 'ad' });
  assert.equal(queryLines(db, { ...Q, streamKind: ['ad'] }).total, 2);
  const p = planBulk(db, { ...Q, q: 'song a' }, { type: 'change', field: 'qty', mode: 'amount', value: '500' });
  assert.equal(p.sample[0]!.after.qty, 1500);
  assert.equal(p.sample[0]!.after.royaltyKop, 5250);
});

test('массово: перенос 25% прослушиваний в рекламные, сумма не меняется', () => {
  const db = setup();
  const before = total(db);
  const res = applyBulk(db, ctx, Q, { type: 'move', by: 'percent', value: '25', toKind: 'ad' });
  assert.equal(res.affected, 3);
  assert.equal(res.deltaKop, 0);
  assert.equal(total(db), before);
  const ad = queryLines(db, { ...Q, streamKind: ['ad'] });
  assert.equal(ad.total, 3);
  assert.equal(ad.totals.qty, 250 + 50 + 25);
  // строки с переносом при следующей массовой правке пропускаются
  const again = planBulk(db, Q, { type: 'set', field: 'usage_type', value: 'X' });
  assert.equal(again.skipped.hasSplit, 3);
  revertBatch(db, ctx, res.batchId);
  assert.equal(queryLines(db, Q).total, 3);
});

test('массово: ставка +10%, уже изменённые строки считаются от текущего', () => {
  const db = setup();
  const a = queryLines(db, { ...Q, q: 'song a' }).rows[0]!;
  editLine(db, ctx, a.lineId, 'royalty', '40');
  const p = planBulk(db, { ...Q, q: 'song a' }, { type: 'change', field: 'rate', mode: 'percent', value: '10' });
  assert.equal(p.sample[0]!.after.royaltyKop, 4400);
});

test('массово: плохие значения и пустой результат', () => {
  const db = setup();
  assert.throws(() => planBulk(db, Q, { type: 'change', field: 'royalty', mode: 'percent', value: 'abc' }), /Процент/);
  assert.throws(() => planBulk(db, Q, { type: 'move', by: 'percent', value: '150', toKind: 'ad' }), /0 до 100/);
  assert.throws(() => applyBulk(db, ctx, { ...Q, q: 'нет такого' }, { type: 'set', field: 'stream_kind', value: 'ad' }), /ни одной/);
});
