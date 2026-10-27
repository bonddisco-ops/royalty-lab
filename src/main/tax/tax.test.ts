import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { computeTax, paramsFor } from './calc.ts';
import { addPayment, addReceipt, deleteReceipt, getParams, setParams, taxCsv, taxView } from './store.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
const P = paramsFor(2026);
const R = (date: string, rub: number) => ({ date, kop: rub * 100 });

test('аванс нарастающим итогом: 6% с дохода, взносы зачитываются до нуля', () => {
  const c = computeTax(2026, [R('2026-02-10', 100_000), R('2026-05-15', 200_000), R('2026-08-01', 300_000)], [], P);
  assert.deepEqual(c.periods.map((p) => p.incomeKop / 100), [100_000, 300_000, 600_000, 600_000]);
  assert.deepEqual(c.periods.map((p) => p.toPayKop / 100), [6_000, 12_000, 18_000, 0], 'авансы: 6000, 18000-6000, 36000-18000, год 36000-36000');
  // взносы 57 390 уплачены в 1 квартале и зачтены, налог за год 36 000 — зачёт не больше налога
  const c2 = computeTax(2026, [R('2026-02-10', 100_000)], [{ kind: 'fixed', period: null, date: '2026-03-20', kop: 5_739_000, deductYear: 2026 }], P);
  assert.equal(c2.periods[0]!.deductKop, 6_000 * 100, 'не больше налога периода');
  assert.equal(c2.periods[0]!.toPayKop, 0);
  assert.equal(c2.periods[3]!.netKop, 0);
});

test('взносы позже периода не уменьшают более ранние авансы; уплаченное отражается в остатке', () => {
  const c = computeTax(2026, [R('2026-02-10', 1_000_000)], [
    { kind: 'fixed', period: null, date: '2026-05-01', kop: 20_000 * 100, deductYear: 2026 },
    { kind: 'usn', period: 'Q1', date: '2026-04-20', kop: 60_000 * 100, deductYear: 2026 },
  ], P);
  assert.equal(c.periods[0]!.toPayKop, 60_000 * 100, '1 кв: 6% от 1 000 000, взнос ещё не платили');
  assert.equal(c.periods[0]!.leftKop, 0);
  assert.equal(c.periods[1]!.deductKop, 20_000 * 100);
  assert.equal(c.periods[1]!.toPayKop, 0, 'полугодие: 60000-20000=40000 < уже начисленных 60000 → 0, переплата');
  assert.equal(c.periods[1]!.overKop, 20_000 * 100);
});

test('1% свыше 300 000 и потолок', () => {
  const small = computeTax(2026, [R('2026-03-01', 250_000)], [], P);
  assert.equal(small.contribs.extraKop, 0);
  const mid = computeTax(2026, [R('2026-03-01', 1_300_000)], [], P);
  assert.equal(mid.contribs.extraKop, 10_000 * 100, '1% от 1 000 000');
  const huge = computeTax(2026, [R('2026-03-01', 100_000_000)], [], P);
  assert.equal(huge.contribs.extraKop, P.capKop - P.opsFixedKop, 'потолок: предел минус пенсионная фикс.часть');
  assert.equal(huge.contribs.fixedKop, 5_739_000);
});

test('поступления прошлых лет не мешают; хранение, параметры и выгрузка', () => {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const a = addReceipt(db, ctx, { date: '2026-01-15', kop: 500_000_00, source: 'SP Digital' });
  addReceipt(db, ctx, { date: '2025-11-20', kop: 100_00 });
  addPayment(db, ctx, { year: 2026, kind: 'usn', period: 'Q1', date: '2026-04-27', kop: 100_00 });
  const v = taxView(db, 2026);
  assert.equal(v.receipts.length, 1);
  assert.equal(v.calc.totalIncomeKop, 500_000_00);
  assert.equal(v.calc.periods[0]!.paidKop, 100_00);
  assert.ok(v.years.includes(2025));
  assert.equal(taxView(db, 2025).calc.totalIncomeKop, 100_00);
  assert.throws(() => addReceipt(db, ctx, { date: 'вчера', kop: 1 }), /дату/);
  assert.throws(() => addPayment(db, ctx, { year: 2026, kind: 'usn', date: '2026-04-27', kop: 1 }), /период/);
  assert.equal(getParams(db, 2026).defaults, true);
  setParams(db, ctx, 2026, { ...P, fixedKop: 6_000_000 });
  assert.equal(getParams(db, 2026).params.fixedKop, 6_000_000);
  assert.equal(getParams(db, 2026).defaults, false);
  setParams(db, ctx, 2026, { ...P, fixedKop: 6_100_000 }); // повторное сохранение
  assert.equal(taxView(db, 2026).calc.contribs.fixedKop, 6_100_000);
  const csv = taxCsv(taxView(db, 2026));
  assert.ok(csv.startsWith('﻿') && csv.includes('SP Digital') && csv.includes('Налог УСН'));
  deleteReceipt(db, ctx, a);
  assert.equal(taxView(db, 2026).receipts.length, 0);
});
