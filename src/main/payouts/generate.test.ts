import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { insertRow } from '../db/mutate.ts';
import { editLine } from '../reports/edits.ts';
import { commitImport, sha256Hex } from '../reports/importer.ts';
import { queryLines } from '../reports/lines.ts';
import { parseKnown } from '../reports/parse.ts';
import { computeQuarter } from './calc.ts';
import { generateStatement, safeName } from './generate.ts';
import { payoutsView } from './store.ts';
import { readXlsxBuffer } from '../reports/xlsx.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
let seq = 0;

function setup() {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const cp = insertRow(db, ctx, 'counterparty', { last_name: 'Брянский', first_name: 'Андрей', middle_name: 'Николаевич', status: 'ip', inn: '504407626681' });
  insertRow(db, ctx, 'contract', { counterparty_id: cp, number: 'ПР-ИП/ССЮТ/25', threshold_rub: null });
  const artist = insertRow(db, ctx, 'artist', { name: 'Shtain', counterparty_id: cp });
  const track = insertRow(db, ctx, 'track', { title: 'Cold Heart', isrc: 'RUA1D2588339' });
  insertRow(db, ctx, 'participation', { track_id: track, artist_id: artist, share_authors: '0.5', share_related: '0.5', label_rate: '0.7' });
  const wb = spDigital('related', [spRelRow('RUA1D2588339', 'Cold Heart', 'DJ Harvie, Shtain', 'YouTube', 36, 1000, 1000)], [1000, 1000]);
  commitImport(db, ctx, { parsed: parseKnown(wb), fileName: 'a.xlsx', fileSha: sha256Hex(Buffer.from('s' + seq++)), flow: 'artists', quarter: '2026Q2' });
  return db;
}

test('имя файла: запрещённые символы убираются', () => {
  assert.equal(safeName('Иванов/Пётр: "Тест"?'), 'Иванов Пётр Тест');
  assert.equal(safeName('...'), 'Получатель');
});

test('комплект: файлы на диске, итог Excel = расчёт, версии, «устарел» после правки', async () => {
  const db = setup();
  const dir = mkdtempSync(join(tmpdir(), 'rl-out-'));
  try {
    let html = '';
    const render = async (h: string) => { html = h; return Buffer.from('%PDF-fake'); };
    const key = computeQuarter(db, '2026Q2').groups[0]!.key;
    const g1 = await generateStatement(db, ctx, dir, '2026Q2', key, { city: 'Санкт-Петербург', date: '2026-09-21' }, render);
    assert.equal(g1.versionNo, 1);
    assert.ok(existsSync(join(dir, g1.pdf)) && existsSync(join(dir, g1.xlsx)));
    assert.equal(readFileSync(join(dir, g1.pdf), 'utf8'), '%PDF-fake');
    assert.ok(html.includes('Брянский Андрей Николаевич') && html.includes('504407626681') && html.includes('ПР-ИП/ССЮТ/25') && html.includes('ИП Федотов Иван Васильевич'));
    const wb = readXlsxBuffer(readFileSync(join(dir, g1.xlsx)), 'x.xlsx');
    assert.equal(wb.sheets[0]!.name, 'Shtain');
    assert.equal(wb.sheets[0]!.rows[1]![3], 'Shtain');

    let v = payoutsView(db, '2026Q2').rows[0]!;
    assert.equal(v.statement?.versionNo, 1);
    assert.equal(v.statement?.stale, false);

    editLine(db, ctx, queryLines(db, { quarter: '2026Q2' }).rows[0]!.lineId, 'royalty', '900');
    v = payoutsView(db, '2026Q2').rows[0]!;
    assert.equal(v.statement?.stale, true); // правка строки → комплект устарел

    const g2 = await generateStatement(db, ctx, dir, '2026Q2', computeQuarter(db, '2026Q2').groups[0]!.key, { city: 'Москва', date: '2026-10-01' }, render);
    assert.equal(g2.versionNo, 2);
    assert.notEqual(g2.pdf, g1.pdf);
    assert.ok(existsSync(join(dir, g1.pdf))); // старая версия остаётся
    v = payoutsView(db, '2026Q2').rows[0]!;
    assert.equal(v.statement?.versionNo, 2);
    assert.equal(v.statement?.stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('комплект: без договора или с неверными данными — понятная ошибка', async () => {
  const db = setup();
  const dir = mkdtempSync(join(tmpdir(), 'rl-out-'));
  try {
    const render = async () => Buffer.from('x');
    const key = computeQuarter(db, '2026Q2').groups[0]!.key;
    await assert.rejects(generateStatement(db, ctx, dir, '2026Q2', key, { city: '', date: '2026-09-21' }, render), /город/);
    await assert.rejects(generateStatement(db, ctx, dir, '2026Q2', key, { city: 'X', date: '21.09.2026' }, render), /Дата/);
    await assert.rejects(generateStatement(db, ctx, dir, '2026Q2', 'нет', { city: 'X', date: '2026-09-21' }, render), /не найден/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
