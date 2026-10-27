import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { deleteRow, insertRow, updateRow } from '../db/mutate.ts';
import { commitImport, sha256Hex } from '../reports/importer.ts';
import { parseKnown } from '../reports/parse.ts';
import { computeQuarter, rowsOfGroup } from './calc.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
type D = ReturnType<typeof freshDb>;

function world(opts: { threshold?: number | null; rule?: string | null; labelRate?: string | null } = {}) {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const cp = insertRow(db, ctx, 'counterparty', { last_name: 'Тестов', first_name: 'Артист', middle_name: 'Иванович', status: 'ip' });
  const contract = insertRow(db, ctx, 'contract', {
    counterparty_id: cp, number: 'ПР-1/26', threshold_rub: opts.threshold === undefined ? 500000 : opts.threshold,
    threshold_rule: opts.rule === undefined ? 'carry_until_exceeded' : opts.rule,
  });
  const artist = insertRow(db, ctx, 'artist', { name: 'Artist A', counterparty_id: cp });
  const track = insertRow(db, ctx, 'track', { title: 'Song A', isrc: 'RUAAA2600001' });
  const part = insertRow(db, ctx, 'participation', {
    track_id: track, artist_id: artist, share_authors: '0.5', share_related: '0.5', label_rate: opts.labelRate === undefined ? '0.7' : opts.labelRate,
  });
  return { db, cp, contract, artist, track, part };
}

let n = 0;
function report(db: D, quarter: string, royaltyRub: number, flow: 'artists' | 'personal' | 'ignore' = 'artists', isrc = 'RUAAA2600001') {
  const wb = spDigital('related', [spRelRow(isrc, 'Song A', 'Artist A', 'Yandex Music', 1000, royaltyRub, royaltyRub)], [royaltyRub, royaltyRub]);
  return commitImport(db, ctx, { parsed: parseKnown(wb), fileName: `r${n}.xlsx`, fileSha: sha256Hex(Buffer.from(`r${++n}`)), flow, quarter });
}

test('К выплате = роялти × ставка в треке × ставка лейбла × 0,94, итог вниз до копейки', () => {
  const { db } = world({ threshold: null });
  report(db, '2026Q2', 1234.57); // 123457 коп × 0,5 × 0,7 × 0,94 = 40617,953 коп
  const q = computeQuarter(db, '2026Q2');
  assert.equal(q.groups.length, 1);
  assert.equal(q.groups[0]!.accruedKop, 40617); // вниз, не 40618
  assert.equal(q.groups[0]!.payableKop, 40617);
  assert.equal(q.groups[0]!.contractNumber, 'ПР-1/26');
  assert.equal(q.groups[0]!.labelRatePct, '70');
  assert.equal(q.totals.flowRoyaltyKop, 123457);
  assert.equal(q.totals.allocatedKop, 123457);
  assert.equal(q.totals.marginKop, 123457 - 40617);
});

test('порог: ниже — переносится, в следующем квартале уходит вместе с новым', () => {
  const { db } = world(); // порог 5000 ₽
  report(db, '2026Q1', 3000);
  report(db, '2026Q2', 20000);
  const q1 = computeQuarter(db, '2026Q1').groups[0]!;
  assert.equal(q1.accruedKop, 98700);
  assert.equal(q1.payableKop, 0);
  assert.equal(q1.carriedOutKop, 98700);
  assert.equal(q1.thresholdApplied, true);
  const q2 = computeQuarter(db, '2026Q2').groups[0]!;
  assert.equal(q2.carriedInKop, 98700);
  assert.equal(q2.accruedKop, 658000);
  assert.equal(q2.payableKop, 756700);
  assert.equal(q2.carriedOutKop, 0);
});

test('accumulate_year_end: в 4 квартале платим всё независимо от порога', () => {
  const { db } = world({ rule: 'accumulate_year_end' });
  report(db, '2026Q3', 3000);
  report(db, '2026Q4', 1000);
  assert.equal(computeQuarter(db, '2026Q3').groups[0]!.payableKop, 0);
  const q4 = computeQuarter(db, '2026Q4').groups[0]!;
  assert.equal(q4.payableKop, 98700 + 32900);
  assert.equal(q4.thresholdApplied, false);
});

test('личный доход и игнор начислений не создают', () => {
  const { db } = world({ threshold: null });
  report(db, '2026Q2', 1000, 'personal');
  const q = computeQuarter(db, '2026Q2');
  assert.equal(q.groups.length, 0);
  assert.equal(q.totals.flowRoyaltyKop, 0);
});

test('проблемы: нет трека, нет участников, нет ставки, нет договора', () => {
  const a = world({ threshold: null });
  report(a.db, '2026Q2', 100, 'artists', 'RUZZZ2600099'); // трек не найден
  assert.ok(computeQuarter(a.db, '2026Q2').problems.some((p) => p.kind === 'no_track'));

  const b = world({ threshold: null });
  const t2 = insertRow(b.db, ctx, 'track', { title: 'Song B', isrc: 'RUBBB2600002' });
  report(b.db, '2026Q2', 100, 'artists', 'RUBBB2600002');
  const qb = computeQuarter(b.db, '2026Q2');
  assert.ok(qb.problems.some((p) => p.kind === 'no_participation'));
  assert.equal(qb.totals.unallocatedKop, 10000);
  assert.ok(t2);

  const c = world({ threshold: null, labelRate: null });
  report(c.db, '2026Q2', 100);
  assert.ok(computeQuarter(c.db, '2026Q2').problems.some((p) => p.kind === 'no_rate'));
  assert.equal(computeQuarter(c.db, '2026Q2').groups.length, 0);

  const d = world({ threshold: null });
  deleteRow(d.db, ctx, 'contract', d.contract);
  report(d.db, '2026Q2', 100);
  assert.ok(computeQuarter(d.db, '2026Q2').problems.some((p) => p.kind === 'no_contract'));
});

test('авторские/смежные: доля по типу прав, разные доли для «авт.+смеж.» — в проблемы', () => {
  const { db, part } = world({ threshold: null });
  updateRow(db, ctx, 'participation', part, { share_authors: '0.4', share_related: '0.6' });
  report(db, '2026Q2', 1000); // spDigital related → доля 0,6
  assert.equal(computeQuarter(db, '2026Q2').groups[0]!.accruedKop, Math.floor(100000 * 0.6 * 0.7 * 0.94));
});

test('отпечаток меняется при правке строки, ставке и замене отчёта', async () => {
  const { editLine } = await import('../reports/edits.ts');
  const { queryLines } = await import('../reports/lines.ts');
  const { db, part } = world({ threshold: null });
  report(db, '2026Q2', 1000);
  const d0 = computeQuarter(db, '2026Q2').groups[0]!.digest;
  assert.equal(computeQuarter(db, '2026Q2').groups[0]!.digest, d0);
  const line = queryLines(db, { quarter: '2026Q2' }).rows[0]!.lineId;
  editLine(db, ctx, line, 'royalty', '900');
  const d1 = computeQuarter(db, '2026Q2').groups[0]!.digest;
  assert.notEqual(d1, d0);
  updateRow(db, ctx, 'participation', part, { label_rate: '0.6' });
  assert.notEqual(computeQuarter(db, '2026Q2').groups[0]!.digest, d1);
  assert.equal(rowsOfGroup(db, '2026Q2', computeQuarter(db, '2026Q2').groups[0]!.key).length, 1);
});

test('вкладка «Выплаты»: период создаётся при отметке, статус и выплата сохраняются, расчёт не пишет в базу', async () => {
  const { payoutsView, markPaid } = await import('./store.ts');
  const { db } = world({ threshold: null });
  report(db, '2026Q2', 1000);
  const v = payoutsView(db, '2026Q2');
  assert.equal(v.rows.length, 1);
  assert.equal(v.rows[0]!.periodId, null);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM payout_period').get()?.n), 0);
  markPaid(db, ctx, '2026Q2', v.rows[0]!.key, 'paid', 32900, '2026-09-21');
  const v2 = payoutsView(db, '2026Q2');
  assert.equal(v2.rows[0]!.status, 'paid');
  assert.equal(v2.rows[0]!.paidKop, 32900);
  assert.throws(() => markPaid(db, ctx, '2026Q2', v.rows[0]!.key, 'paid', null, null), /сумму/);
  assert.throws(() => markPaid(db, ctx, '2026Q2', 'nope', 'paid', 1, null), /не найден/);
  markPaid(db, ctx, '2026Q2', v.rows[0]!.key, 'draft', null, null);
  assert.equal(payoutsView(db, '2026Q2').rows[0]!.paidKop, null);
});
