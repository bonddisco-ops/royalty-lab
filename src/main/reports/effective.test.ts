import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectivePieces, parseRateRub, rateToRubString, roundFrac, type BaseLine, type EditRec, type SplitRec } from './effective.ts';

const base: BaseLine = { id: 'L1', qty: 1000, royaltyKop: 5000, streamKind: 'paid', usageType: 'Стриминг', trackId: 't1' };
const ed = (field: EditRec['field'], v: string, id = 'e' + Math.random()): EditRec => ({ id, lineId: 'L1', field, newValue: v });

test('округление дроби: к ближайшему, половина от нуля', () => {
  assert.equal(roundFrac(5n, 2n), 3n);
  assert.equal(roundFrac(-5n, 2n), -3n);
  assert.equal(roundFrac(7n, 3n), 2n);
});

test('ставка: рубли ↔ дробь без потерь', () => {
  assert.equal(rateToRubString(parseRateRub('0,05')), '0.05');
  assert.equal(rateToRubString({ n: 5000n, d: 1000n }), '0.05');
  assert.equal(rateToRubString({ n: 1n, d: 3n }), '0.00333333');
});

test('без правок строка не меняется', () => {
  const [p] = effectivePieces(base, [], []);
  assert.equal(p!.qty, 1000); assert.equal(p!.royaltyKop, 5000); assert.deepEqual(p!.changed, []); assert.equal(p!.rate, '0.05');
});

test('смена тиража: ставка остаётся, роялти пересчитывается', () => {
  const [p] = effectivePieces(base, [ed('qty', '2000')], []);
  assert.equal(p!.royaltyKop, 10000); assert.equal(p!.rate, '0.05'); assert.deepEqual(p!.changed, ['qty', 'royalty']);
});

test('смена роялти: ставка пересчитывается', () => {
  const [p] = effectivePieces(base, [ed('royalty_kop', '2500')], []);
  assert.equal(p!.rate, '0.025'); assert.equal(p!.qty, 1000);
});

test('смена ставки: роялти = тираж × ставка', () => {
  const [p] = effectivePieces(base, [ed('rate_per_stream', '0,1')], []);
  assert.equal(p!.royaltyKop, 10000);
});

test('несколько правок идут по порядку, откат = их отсутствие', () => {
  const [p] = effectivePieces(base, [ed('qty', '500'), ed('royalty_kop', '999')], []);
  assert.equal(p!.qty, 500); assert.equal(p!.royaltyKop, 999);
});

test('нет тиража: ставка не определена, роялти править можно', () => {
  const [p] = effectivePieces({ ...base, qty: 0, royaltyKop: 300 }, [], []);
  assert.equal(p!.rate, null);
  const [q] = effectivePieces({ ...base, qty: 0, royaltyKop: 300 }, [ed('royalty_kop', '400')], []);
  assert.equal(q!.royaltyKop, 400);
});

test('перенос части: сумма отчёта сохраняется, у части свой тип', () => {
  const sp: SplitRec = { id: 's1', lineId: 'L1', qtyMoved: 400, toStreamKind: 'ad', toUsageType: null, ratePerStream: null };
  const ps = effectivePieces(base, [], [sp]);
  assert.equal(ps.length, 2);
  assert.equal(ps[0]!.qty, 600); assert.equal(ps[1]!.qty, 400);
  assert.equal(ps[0]!.royaltyKop + ps[1]!.royaltyKop, 5000);
  assert.equal(ps[1]!.streamKind, 'ad'); assert.equal(ps[0]!.streamKind, 'paid');
  assert.equal(ps[1]!.royaltyKop, 2000);
});

test('перенос со своей ставкой: остаток по прежней ставке, сумма строки уменьшается', () => {
  const sp: SplitRec = { id: 's1', lineId: 'L1', qtyMoved: 400, toStreamKind: 'ad', toUsageType: null, ratePerStream: '0.01' };
  const ps = effectivePieces(base, [], [sp]);
  assert.equal(ps[1]!.royaltyKop, 400); // 400 × 0,01 ₽
  assert.equal(ps[0]!.royaltyKop, 3000); // 600 × 0,05 ₽
  assert.equal(ps[0]!.rate, '0.05');
  assert.equal(ps[0]!.royaltyKop + ps[1]!.royaltyKop, 3400);
});

test('миллион прослушиваний за 30 000 ₽: половину сделали бесплатными', () => {
  const big: BaseLine = { id: 'L1', qty: 1_000_000, royaltyKop: 3_000_000, streamKind: 'paid', usageType: null, trackId: null };
  const ps = effectivePieces(big, [], [{ id: 's1', lineId: 'L1', qtyMoved: 500_000, toStreamKind: 'ad', toUsageType: null, ratePerStream: '0' }]);
  assert.equal(ps[0]!.royaltyKop, 1_500_000);
  assert.equal(ps[1]!.royaltyKop, 0);
});

test('перенос больше остатка обрезается, два переноса подряд', () => {
  const sps: SplitRec[] = [
    { id: 's1', lineId: 'L1', qtyMoved: 700, toStreamKind: 'ad', toUsageType: null, ratePerStream: null },
    { id: 's2', lineId: 'L1', qtyMoved: 700, toStreamKind: 'other', toUsageType: null, ratePerStream: null },
  ];
  const ps = effectivePieces(base, [], sps);
  assert.deepEqual(ps.map((p) => p.qty), [0, 700, 300]);
  assert.equal(ps.reduce((a, p) => a + p.royaltyKop, 0), 5000);
});
