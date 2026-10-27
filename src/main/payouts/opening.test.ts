import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { insertRow, updateRow } from '../db/mutate.ts';
import { commitImport, sha256Hex } from '../reports/importer.ts';
import { parseKnown } from '../reports/parse.ts';
import { computeQuarter } from './calc.ts';
import { commitOpening, listOpening, matchOpeningName, parseOpeningXlsx } from './opening.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };

function setup(threshold: number | null) {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const cp = insertRow(db, ctx, 'counterparty', { last_name: 'Брянский', first_name: 'Андрей', middle_name: 'Николаевич', status: 'ip', inn: '504407626681' });
  const contract = insertRow(db, ctx, 'contract', { counterparty_id: cp, number: 'ПР-1', threshold_rub: threshold });
  const artist = insertRow(db, ctx, 'artist', { name: 'Shtain', counterparty_id: null });
  insertRow(db, ctx, 'artist_name_variant', { artist_id: artist, variant_norm: 'shtain' });
  const other = insertRow(db, ctx, 'artist', { name: 'Tim3bomb', counterparty_id: null });
  insertRow(db, ctx, 'artist_name_variant', { artist_id: other, variant_norm: 'tim3bomb' });
  const track = insertRow(db, ctx, 'track', { title: 'Cold Heart', isrc: 'RUA1D2588339' });
  insertRow(db, ctx, 'participation', { track_id: track, artist_id: artist, share_authors: '0.5', share_related: '0.5', label_rate: '0.7' });
  const wb = spDigital('related', [spRelRow('RUA1D2588339', 'Cold Heart', 'DJ Harvie, Shtain', 'YouTube', 36, 1000, 1000)], [1000, 1000]);
  commitImport(db, ctx, { parsed: parseKnown(wb), fileName: 'a.xlsx', fileSha: sha256Hex(Buffer.from('s')), flow: 'artists', quarter: '2026Q2' });
  return { db, cp, contract, artist, other };
}

const sheet = (rows: unknown[][]) => ({ fileName: 'o.xlsx', sheets: [{ name: 'FINANCE', rows: [[null, null, null, '2026 Q3'], [], ...rows] }] });
const HEAD = [null, null, null, 'Артист', null, 'Входящий остаток Q1', null, 'Начислено за Q2', 'К выплате', 'Входящий остаток'];

test('разбор Excel: квартал, остаток берётся из последней колонки, «ИТОГО» останавливает, расхождения с формулой помечаются', () => {
  const p = parseOpeningXlsx(sheet([
    HEAD,
    [null, null, null, 'Shtain', null, 10, null, 5, 0, 15],
    [null, null, null, 'Rapossa', null, 0, null, 688.75, 688.75, 688.75],
    [null, null, null, 'ИТОГО:', null, 0, null, 0, 0, 703.75],
    [null, null, null, 'После итога', null, 0, null, 0, 0, 999],
  ]));
  assert.equal(p.quarterGuess, '2026Q3');
  assert.deepEqual(p.rows.map((r) => [r.name, r.fileKop, r.mismatch]), [['Shtain', 1500, false], ['Rapossa', 68875, true]]);
  assert.equal(p.rows[1]!.formulaKop, 0);
  assert.equal(p.totalKop, 70375);
  assert.throws(() => parseOpeningXlsx(sheet([[1, 2, 3]])), /Не нашёл таблицу/);
});

test('сопоставление: по имени, по нескольким именам одного человека, неизвестное', () => {
  const { db, cp, artist, other } = setup(null);
  assert.equal(matchOpeningName(db, 'SHTAIN').artistId, artist);
  assert.equal(matchOpeningName(db, 'Нет такого').artistId, null);
  assert.equal(matchOpeningName(db, 'Shtain, Tim3bomb').personId, null); // не привязаны — ручной выбор
  updateRow(db, ctx, 'artist', artist, { counterparty_id: cp });
  updateRow(db, ctx, 'artist', other, { counterparty_id: cp });
  const m = matchOpeningName(db, 'Shtain, Tim3bomb');
  assert.equal(m.personId, cp);
  assert.match(m.person ?? '', /Брянский/);
});

test('остаток идёт человеку (даже если артиста привяжут позже), входит в перенос и порог', () => {
  const { db, cp, artist } = setup(100_000_00); // порог 100 000 ₽ — всё копится
  const base = computeQuarter(db, '2026Q2').groups;
  assert.equal(base.length, 0, 'артист не привязан — получателя нет');
  commitOpening(db, ctx, '2026Q2', [{ name: 'Shtain', kop: 123_45, artistId: artist }]);
  let calc = computeQuarter(db, '2026Q2');
  assert.ok(calc.problems.some((p) => p.kind === 'opening_unassigned'), 'не привязан к человеку — подсвечено');
  updateRow(db, ctx, 'artist', artist, { counterparty_id: cp }); // привязали позже
  calc = computeQuarter(db, '2026Q2');
  const g = calc.groups[0]!;
  assert.equal(g.carriedInKop, 123_45);
  assert.equal(g.payableKop, 0, 'с остатком всё равно ниже порога — держим');
  assert.equal(g.carriedOutKop, g.accruedKop + 123_45);
  assert.ok(!calc.problems.some((p) => p.kind === 'opening_unassigned'));
});

test('остаток вместе с начислением переходит порог; повторный импорт заменяет прежний', () => {
  const { db, cp, artist } = setup(null);
  updateRow(db, ctx, 'artist', artist, { counterparty_id: cp });
  const acc = computeQuarter(db, '2026Q2').groups[0]!.accruedKop;
  assert.ok(acc > 0);
  const thr = acc + 50_00;
  updateRow(db, ctx, 'contract', db.prepare('SELECT id FROM contract').get()!.id as string, { threshold_rub: thr });
  assert.equal(computeQuarter(db, '2026Q2').groups[0]!.payableKop, 0, 'без остатка ниже порога');
  commitOpening(db, ctx, '2026Q2', [{ name: 'Shtain', kop: 60_00, artistId: artist }]);
  const g = computeQuarter(db, '2026Q2').groups[0]!;
  assert.equal(g.payableKop, acc + 60_00, 'остаток помог пройти порог');
  const r = commitOpening(db, ctx, '2026Q2', [{ name: 'Shtain', kop: 10_00, artistId: artist }]);
  assert.equal(r.replaced, 1);
  assert.equal(listOpening(db).length, 1);
  assert.equal(listOpening(db)[0]!.kop, 10_00);
});

test('остаток человека без начислений в квартале всё равно появляется в выплатах', () => {
  const { db, cp } = setup(null);
  commitOpening(db, ctx, '2026Q2', [{ name: 'Брянский', kop: 777_00, artistId: null, personId: cp }]);
  const g = computeQuarter(db, '2026Q2').groups;
  assert.equal(g.length, 1);
  assert.equal(g[0]!.carriedInKop, 777_00);
  assert.equal(g[0]!.payableKop, 777_00);
});
