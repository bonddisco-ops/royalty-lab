import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsxBuffer } from '../reports/xlsx.ts';
import type { AccrualRow } from './calc.ts';
import { buildStatementXlsx, multiplierText } from './xlsxOut.ts';

const DEC = 10n ** 12n;
function row(over: Partial<AccrualRow>): AccrualRow {
  const roy = over.royaltyKop ?? 12346;
  const share = over.share ?? '0.5', rate = over.labelRate ?? '0.7';
  const p = (s: string): bigint => BigInt(Math.round(Number(s) * 1e12));
  return {
    key: 'k' + Math.random(), lineId: 'l', reportId: 'r', distributor: 'D', rights: 'authors', upc: '4660275083205', isrc: 'RUAGV2501290', code: null, artistRaw: 'YUME;Takisha',
    title: 'Motives', platform: 'Apple Music', usage: 'Подписка', country: 'РОССИЯ', month: '2026-04', qty: 2, royaltyKop: roy, exactKop: String(roy), trackId: 't', artistId: 'a', artistName: 'YUME',
    participationId: 'p', share, labelRate: rate, groupKey: 'g|c', scaled: BigInt(roy) * DEC * p(share) * p(rate) * p('0.94'), ...over,
  };
}

test('множитель из вычета: 0.06 → 0.94', () => {
  assert.equal(multiplierText('0.06'), '0.94');
  assert.equal(multiplierText('0'), '1');
});

test('xlsx: листы по псевдонимам, формулы, итог вниз до копейки, сводный лист', () => {
  const a = [row({ royaltyKop: 12346, title: 'B' }), row({ royaltyKop: 100000, title: 'A' })];
  const b = [row({ royaltyKop: 5000, artistName: 'SYNRY', share: '0.45' })];
  const res = buildStatementXlsx([{ name: 'YUME', rows: a }, { name: 'SYNRY', rows: b }], '0.06');
  assert.deepEqual(res.sheetNames, ['YUME', 'SYNRY', 'Итого']);
  const wb = readXlsxBuffer(res.buffer, 'x.xlsx');
  assert.deepEqual(wb.sheets.map((s) => s.name), ['YUME', 'SYNRY', 'Итого']);
  const yume = wb.sheets[0]!.rows;
  assert.equal(yume[0]![0], 'UPC');
  assert.equal(yume[0]![12], 'К выплате');
  assert.equal(yume[1]![4], 'A'); // отсортировано по названию
  assert.equal(yume.length, 4); // шапка + 2 + итог
  assert.equal(yume[3]![0], 'Итог');
  assert.equal(yume[3]![8], 4);
  // ожидаемая сумма по формуле: (123,46 + 1000) × 0,5 × 0,7 × 0,94
  const exact = (123.46 + 1000) * 0.5 * 0.7 * 0.94 + 50 * 0.45 * 0.7 * 0.94;
  assert.equal(res.totalKop, Math.floor(exact * 100 + 1e-6));
  const sum = wb.sheets[2]!.rows;
  assert.equal(sum[3]![0], 'Итого к выплате (вниз до копейки)');
  assert.equal(sum[3]![2], res.totalKop / 100);
});

test('xlsx: опасные символы в названиях листов и спецсимволы в тексте', () => {
  const res = buildStatementXlsx([{ name: 'A/B:C*?[x]', rows: [row({ title: 'Rock & <Roll> "X"' })] }, { name: 'a/b:c*?[x]', rows: [row({})] }], '0.06');
  assert.equal(new Set(res.sheetNames.map((n) => n.toLowerCase())).size, res.sheetNames.length);
  const wb = readXlsxBuffer(res.buffer, 'x.xlsx');
  assert.equal(wb.sheets[0]!.rows[1]![4], 'Rock & <Roll> "X"');
});
