import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { alligator, effective, fmk, silk, spDigital, spRelRow } from '../../test/sampleReports.ts';
import { insertRow } from '../db/mutate.ts';
import { detectBuiltin } from './detect.ts';
import { aggregate, commitImport, previewImport, sha256Hex } from './importer.ts';
import { parseKnown } from './parse.ts';
import { aliasUnknownArtist, createTrackFromUnmatched, linkUnmatchedToTrack } from './resolve.ts';
import { deleteReport, listReports, quarterPanel } from './queries.ts';
import { FormatError } from './types.ts';
import { toKop } from './util.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };

test('деньги: копейки до ближайшей, без ошибки двоичной дроби', () => {
  assert.equal(toKop(0.285), 29);
  assert.equal(toKop(633222.5018), 63322250);
  assert.equal(toKop(0.0943729), 9);
});

test('SP Digital: легенда колонок, подвал, квартал, ставка 70%', () => {
  const wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 6, 1, 0.7), spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Not reported', 1, 0.5, 0.35, 'Цифровые права - рекламная модель')], [1.5, 1.05]);
  assert.equal(detectBuiltin(wb), 'sp_digital');
  const r = parseKnown(wb);
  assert.deepEqual([r.rightsScope, r.quarter, r.licensorShare, r.defaultFlow, r.lines.length], ['related', '2026Q3', '0.7', 'artists', 2]);
  assert.equal(r.totals?.royalty, 1.05);
  assert.deepEqual(r.lines.map((l) => l.streamKind), ['paid', 'ad']);
  assert.equal(r.lines[0]!.periodMonth, '2026-07');
  assert.equal(r.lines[0]!.isrcRaw, 'RUAAA2600001');
});

test('SP Digital: авторский файл читает другую раскладку колонок', () => {
  const row: (string | number | null)[] = ['Song A', 'Автор', 'Композитор', 'TITLE_R', 'UMA', 'UMA (Vkontakte)', 14, '100%', 1.04, '70%', 0.73, 'РОССИЯ', 'RUAAA2600002', 16447414, 'Цифровые права - стриминг, подписка', '062026', 'Lew Heart;Tony Moncler', '© 2026'];
  const r = parseKnown(spDigital('authors', [row], [1.04, 0.73]));
  assert.equal(r.rightsScope, 'authors');
  assert.equal(r.lines[0]!.isrcRaw, 'RUAAA2600002');
  assert.equal(r.lines[0]!.artistRaw, 'Lew Heart;Tony Moncler');
  assert.equal(r.lines[0]!.periodMonth, '2026-06');
  assert.equal(r.lines[0]!.platform, 'UMA (Vkontakte)');
});

test('Эффектив: личный доход, листы авторские/смежные, итог на «Свод»', () => {
  const r = parseKnown(effective());
  assert.equal(r.formatCode, 'effective');
  assert.deepEqual([r.defaultFlow, r.rightsScope, r.quarter, r.lines.length], ['personal', 'mixed', '2026Q3', 3]);
  assert.equal(r.totals?.royalty, 30);
  assert.deepEqual(r.lines.map((l) => [l.rightsType, l.streamKind, l.periodMonth]), [['authors', 'paid', '2026-06'], ['related', 'ad', '2026-07'], ['related', 'nonstream', '2026-04']]);
  assert.equal(r.lines[2]!.platform, 'Чистые носители (РСП)');
  assert.equal(r.warnings.length, 0);
});

test('ФМК: тип прав в строке, периоды кварталами, квартал из имени файла', () => {
  const r = parseKnown(fmk());
  assert.equal(r.formatCode, 'fmk');
  assert.equal(r.quarter, '2026Q3');
  assert.equal(r.quarterSource, 'filename');
  assert.deepEqual(r.lines.map((l) => [l.rightsType, l.periodMonth, l.streamKind, l.royalty]), [['authors', '2026-07', 'paid', 1.5], ['mixed', '2025-Q4', 'nonstream', 3], ['related', '2026-Q1', 'ad', 0.5]]);
  assert.equal(r.totals?.royalty, 5);
  assert.equal(r.licensorShare, '0.7');
});

test('Music Alligator: рубли на дату отчёта, устройства агрегируются, UGC/синхронизация без стримов', () => {
  const r = parseKnown(alligator());
  assert.equal(r.formatCode, 'music_alligator');
  assert.equal(r.quarter, '2026Q2');
  const agg = aggregate(r.lines);
  assert.equal(r.lines.length, 4);
  assert.equal(agg.length, 3); // iOS + Android → одна строка
  const paid = agg.find((a) => a.streamKind === 'paid')!;
  assert.deepEqual([paid.qty, paid.royaltyKop, paid.merged], [3, 30, 2]);
  assert.equal(agg.find((a) => a.streamKind === 'ad')!.royaltyKop, 90); // сумма в рублях, а не 0.01 EUR
  assert.equal(agg.find((a) => a.streamKind === 'nonstream')!.royaltyKop, 500);
  assert.ok(r.warnings.some((w) => w.includes('EUR')));
});

test('Silk: ставка 75% из шапки, коды вместо ISRC, периоды «7-9.2025», сумма разделов = доходу', () => {
  const r = parseKnown(silk());
  assert.deepEqual([r.formatCode, r.quarter, r.licensorShare, r.lines.length], ['silk', '2025Q4', '0.75', 3]);
  assert.equal(r.lines.reduce((a, l) => a + l.royalty, 0), 75);
  assert.equal(r.warnings.length, 0);
  assert.deepEqual(r.lines.map((l) => l.periodMonth), ['2025-10', '2024', '2025-Q3']);
  assert.equal(r.lines[0]!.codeRaw, 'PRR00002');
  assert.equal(r.totals?.royalty, 75);
});

test('незнакомый файл не определяется', () => {
  assert.equal(detectBuiltin({ fileName: 'x.xlsx', sheets: [{ name: 'Лист1', rows: [['a', 'b']] }] }), null);
  assert.throws(() => parseKnown({ fileName: 'x.xlsx', sheets: [{ name: 'Лист1', rows: [['a']] }] }), FormatError);
});

function seed() {
  const db = freshDb('r1');
  const a = insertRow(db, ctx, 'artist', { name: 'Artist A' });
  const t = insertRow(db, ctx, 'track', { title: 'Song A', isrc: 'RUAAA2600001' });
  insertRow(db, ctx, 'participation', { track_id: t, artist_id: a, share_authors: '1', share_related: '1', label_rate: '0.5' });
  return { db, a, t };
}
const input = (db: ReturnType<typeof freshDb>, wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 6, 1, 0.7), spRelRow('RUAAA2600009', 'New Song', 'Brand New', 'Not reported', 1, 0.5, 0.35)], [1.5, 1.05]), sha = 'a'.repeat(64)) => {
  void db;
  const parsed = parseKnown(wb);
  return { parsed, fileName: wb.fileName, fileSha: sha, flow: parsed.defaultFlow, quarter: parsed.quarter! };
};

test('импорт: привязка по ISRC, очередь «Проверить», сверка с подвалом', () => {
  const { db, t } = seed();
  const inp = input(db);
  const pv = previewImport(db, inp);
  assert.deepEqual([pv.srcRows, pv.aggRows, pv.rowsKop, pv.footerOk, pv.duplicateOf, pv.replaces], [2, 2, 105, true, null, null]);
  assert.deepEqual([pv.match.matchedLines, pv.match.unmatchedLines, pv.match.unmatchedTracks, pv.match.unknownArtists], [1, 1, 1, 1]);
  assert.equal(db.prepare('SELECT count(*) n FROM report').get()!.n, 0, 'предпросмотр ничего не пишет');
  const res = commitImport(db, ctx, inp);
  assert.equal(res.versionNo, 1);
  assert.equal(db.prepare('SELECT track_id FROM statement_line WHERE isrc_raw = ?').get('RUAAA2600001')!.track_id, t);
  const kinds = db.prepare('SELECT kind, count(*) n FROM issue GROUP BY kind ORDER BY kind').all().map((r) => `${r.kind}:${r.n}`);
  assert.deepEqual(kinds, ['not_reported_platform:1', 'unknown_artist:1', 'unmatched_track:1']);
  assert.equal(db.prepare('SELECT count(*) n FROM change_log WHERE table_name = ?').get('statement_line')!.n, 0, 'строки идут мимо журнала правок');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('дубль файла не импортируется; новая версия заменяет прежнюю', () => {
  const { db } = seed();
  commitImport(db, ctx, input(db));
  assert.throws(() => commitImport(db, ctx, input(db)), /уже загружен/);
  assert.equal(previewImport(db, input(db)).duplicateOf?.versionNo, 1);
  const wb2 = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 7, 1.1, 0.77)], [1.1, 0.77]);
  const inp2 = input(db, wb2, 'b'.repeat(64));
  assert.equal(previewImport(db, inp2).replaces?.versionNo, 1);
  const r2 = commitImport(db, ctx, inp2);
  assert.equal(r2.versionNo, 2);
  assert.deepEqual(db.prepare('SELECT version_no, status FROM report_version ORDER BY version_no').all().map((r) => `${r.version_no}:${r.status}`), ['1:superseded', '2:active']);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE status = 'open'").get()!.n, 0, 'вопросы старой версии закрыты');
  assert.equal(db.prepare('SELECT count(*) n FROM report').get()!.n, 1);
});

test('несходящийся подвал попадает в «Проверить»', () => {
  const { db } = seed();
  const wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 6, 1, 0.7)], [1, 9.99]);
  const inp = input(db, wb);
  assert.equal(previewImport(db, inp).footerOk, false);
  commitImport(db, ctx, inp);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'footer_mismatch'").get()!.n, 1);
});

test('личный доход: вопросов по трекам и артистам не создаётся', () => {
  const { db } = seed();
  const inp = input(db, effective(), 'c'.repeat(64));
  assert.equal(inp.flow, 'personal');
  commitImport(db, ctx, inp);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind IN ('unmatched_track','unknown_artist')").get()!.n, 0);
  const panel = quarterPanel(db);
  assert.equal(panel.totalsByFlow.personal, 3000);
  assert.equal(panel.totalsByFlow.artists, 0);
});

test('ISRC от двух дистрибьюторов за квартал → пометка', () => {
  const { db } = seed();
  commitImport(db, ctx, input(db));
  const f = fmk();
  const inp = { parsed: parseKnown(f), fileName: f.fileName, fileSha: 'd'.repeat(64), flow: 'artists' as const, quarter: '2026Q3' };
  assert.equal(previewImport(db, inp).match.isrcTwoDistributors, 1);
  commitImport(db, ctx, inp);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'isrc_two_distributors'").get()!.n, 1);
});

test('привязка к треку запоминается и подхватывается следующим отчётом', () => {
  const { db, t } = seed();
  commitImport(db, ctx, input(db));
  const iss = db.prepare("SELECT id FROM issue WHERE kind = 'unmatched_track'").get()!;
  const r = linkUnmatchedToTrack(db, ctx, iss.id, t);
  assert.equal(r.lines, 1);
  assert.equal(db.prepare('SELECT track_id FROM statement_line WHERE isrc_raw = ?').get('RUAAA2600009')!.track_id, t);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'unmatched_track' AND status = 'open'").get()!.n, 0);
  const wb = spDigital('related', [spRelRow('RUAAA2600009', 'New Song', 'Brand New', 'VK', 1, 1, 0.7)], [1, 0.7]);
  const pv = previewImport(db, input(db, wb, 'e'.repeat(64)));
  assert.equal(pv.match.unmatchedLines, 0);
});

test('новый трек по строке отчёта и алиас артиста', () => {
  const { db, a } = seed();
  commitImport(db, ctx, input(db));
  const u = db.prepare("SELECT id FROM issue WHERE kind = 'unmatched_track'").get()!;
  const r = createTrackFromUnmatched(db, ctx, u.id);
  assert.equal(db.prepare('SELECT title, isrc FROM track WHERE id = ?').get(r.trackId)!.title, 'New Song');
  assert.equal(db.prepare('SELECT isrc FROM track WHERE id = ?').get(r.trackId)!.isrc, 'RUAAA2600009');
  const ua = db.prepare("SELECT id FROM issue WHERE kind = 'unknown_artist'").get()!;
  aliasUnknownArtist(db, ctx, ua.id, a);
  const wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Brand New', 'VK', 1, 1, 0.7)], [1, 0.7]);
  assert.equal(previewImport(db, input(db, wb, 'f'.repeat(64))).match.unknownArtists, 0);
  assert.equal(listReports(db).length, 1);
});

import { fingerprintOf, matchSavedFormat, parseCustom, proposeMapping } from './custom.ts';

test('мастер незнакомого формата: догадка по заголовкам, разбор, узнавание по отпечатку', () => {
  const wb = {
    fileName: 'Новый_дистр_2026Q3.xlsx',
    sheets: [{ name: 'Лист1', rows: [
      ['Отчёт'], [],
      ['Исполнитель', 'Название трека', 'ISRC', 'Площадка', 'Страна', 'Месяц', 'Количество', 'Сумма'],
      ['Artist A', 'Song A', 'RUAAA2600001', 'VK', 'RU', '2026-07', 10, 12.5],
      ['Artist A', 'Song A', 'RUAAA2600001', 'Apple', 'RU', '2026-08', 5, 6],
      ['Итого', null, null, null, null, null, 15, 18.5],
    ] }],
  };
  const p = proposeMapping(wb)!;
  assert.equal(p.mapping.headerRow, 2);
  assert.deepEqual(p.mapping.columns, { artist: 0, title: 1, isrc: 2, platform: 3, country: 4, period: 5, qty: 6, royalty: 7 });
  const parsed = parseCustom(wb, { ...p.mapping, distributorName: 'Новый', licensorShare: 0.5 });
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0]!.royalty, 6.25);
  assert.equal(parsed.quarter, '2026Q3');
  const fp = fingerprintOf(wb, p.mapping.sheet, p.mapping.headerRow);
  assert.ok(matchSavedFormat(wb, [{ id: 'f1', fingerprint: fp, mapping: p.mapping }]));
  assert.equal(matchSavedFormat({ ...wb, sheets: [{ name: 'Лист1', rows: [[], [], ['другая', 'шапка']] }] }, [{ id: 'f1', fingerprint: fp, mapping: p.mapping }]), null);
});

import { readXlsxBuffer } from './xlsx.ts';
import { miniXlsx } from '../../test/miniXlsx.ts';

test('чтение .xlsx: общие строки, форматированный текст, даты, пустые ячейки, пропуски строк', () => {
  const wb = readXlsxBuffer(miniXlsx(), 'x.xlsx');
  assert.equal(wb.sheets[0]!.name, 'Данные & итог');
  const rows = wb.sheets[0]!.rows;
  assert.deepEqual(rows[0], ['Артист', null, 'inline']);
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[2], ['Song A', 12.5, '2026-07-01', '2026-07-01 12:00:00', true, null, ' a & b ']);
});

test('удаление отчёта: мягко, вопросы закрыты, файл и квартал можно загрузить заново', () => {
  const db = freshDb();
  const wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 6, 1, 0.7)], [1, 0.7]);
  const input = { parsed: parseKnown(wb), fileName: 'a.xlsx', fileSha: sha256Hex(Buffer.from('x')), flow: 'artists' as const, quarter: '2026Q2' };
  const r = commitImport(db, ctx, input);
  assert.equal(listReports(db).length, 1);
  assert.ok(Number(db.prepare("SELECT count(*) AS n FROM issue WHERE status = 'open' AND report_version_id = ?").get(r.versionId)?.n) > 0);
  const res = deleteReport(db, ctx, r.reportId);
  assert.equal(res.versions, 1);
  assert.equal(listReports(db).length, 0);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM issue WHERE status = 'open' AND deleted_at IS NULL AND report_version_id = ?").get(r.versionId)?.n), 0);
  assert.throws(() => deleteReport(db, ctx, r.reportId), /не найден/);
  commitImport(db, ctx, input);
  assert.equal(listReports(db).length, 1);
});

test('трек без ISRC в каталоге узнаётся по названию и артисту, ISRC запоминается', () => {
  const db = freshDb('r1');
  const a = insertRow(db, ctx, 'artist', { name: 'Artist A' });
  const t = insertRow(db, ctx, 'track', { title: 'Song A' });
  insertRow(db, ctx, 'participation', { track_id: t, artist_id: a, share_authors: '1', share_related: '1', label_rate: '0.5' });
  const t2 = insertRow(db, ctx, 'track', { title: 'Song B', isrc: 'RUAAA2600777' });
  const wb = spDigital('related', [spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'VK', 1, 1, 0.7), spRelRow('RUAAA2600002', 'Song B', 'Artist A', 'VK', 1, 1, 0.7)], [2, 1.4]);
  const res = commitImport(db, ctx, input(db, wb, 'b'.repeat(64)));
  assert.equal(res.lines, 2);
  assert.equal(db.prepare('SELECT track_id FROM statement_line WHERE isrc_raw = ?').get('RUAAA2600001')!.track_id, t);
  assert.equal(db.prepare('SELECT isrc FROM track WHERE id = ?').get(t)!.isrc, 'RUAAA2600001', 'ISRC запомнен');
  // у «Song B» в каталоге другой ISRC: по названию не гадаем
  assert.equal(db.prepare('SELECT track_id FROM statement_line WHERE isrc_raw = ?').get('RUAAA2600002')!.track_id, null);
  void t2;
});

import { createMissingTracks } from './resolve.ts';

test('недостающие треки создаются сами: артист найден, ставка из договора, остальное подсвечено', () => {
  const { db, a } = seed();
  const p = insertRow(db, ctx, 'counterparty', { last_name: 'Иванов', first_name: 'Иван', status: 'ip' });
  db.prepare('UPDATE artist SET counterparty_id = ? WHERE id = ?').run(p, a);
  insertRow(db, ctx, 'contract', { counterparty_id: p, number: 'X-1', rate_default: '0.5' });
  const wb = spDigital('related', [spRelRow('RUAAA2600009', 'New Song', 'Artist A', 'VK', 1, 1, 0.7), spRelRow('RUAAA2600010', 'Ghost', 'Nobody', 'VK', 1, 1, 0.7)], [2, 1.4]);
  commitImport(db, ctx, input(db, wb, 'c'.repeat(64)));
  const r = createMissingTracks(db, ctx);
  assert.deepEqual([r.created, r.withArtist, r.withRate], [2, 1, 1]);
  const tr = db.prepare("SELECT id FROM track WHERE title = 'New Song'").get()!;
  const part = db.prepare('SELECT label_rate, share_authors, contract_id FROM participation WHERE track_id = ?').get(tr.id)!;
  assert.deepEqual([part.label_rate, part.share_authors], ['0.5', '0']);
  assert.ok(part.contract_id);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'new_track'").get()!.n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'unmatched_track' AND status = 'open'").get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM statement_line WHERE track_id IS NULL').get()!.n, 0);
});

test('строки: фильтр по человеку-получателю, «без получателя», доли коллаба в колонке', async () => {
  const { insertRow: ins, updateRow: upd } = await import('../db/mutate.ts');
  const { queryLines: ql } = await import('./lines.ts');
  const db = freshDb();
  const p1 = ins(db, ctx, 'counterparty', { last_name: 'Брянский', first_name: 'Андрей', middle_name: 'Николаевич', status: 'ip' });
  const a1 = ins(db, ctx, 'artist', { name: 'Shtain', counterparty_id: p1 });
  const a2 = ins(db, ctx, 'artist', { name: 'DJ Harvie', counterparty_id: null });
  const t = ins(db, ctx, 'track', { title: 'Cold Heart', isrc: 'RUA1D2588339' });
  ins(db, ctx, 'participation', { track_id: t, artist_id: a1, share_authors: '0.5', share_related: '0.5', label_rate: '0.7' });
  ins(db, ctx, 'participation', { track_id: t, artist_id: a2, share_authors: '0.5', share_related: '0.5', label_rate: '0.7' });
  commitImport(db, ctx, { parsed: parseKnown(spDigital('related', [spRelRow('RUA1D2588339', 'Cold Heart', 'DJ Harvie, Shtain', 'YouTube', 36, 1000, 1000)], [1000, 1000])), fileName: 'p.xlsx', fileSha: sha256Hex(Buffer.from('p1')), flow: 'artists', quarter: '2026Q2' });
  const mine = ql(db, { quarter: '2026Q2', person: p1 });
  assert.equal(mine.total, 1);
  const pay = mine.rows[0]!.payees!;
  assert.deepEqual(pay.map((x) => [x.artist, x.sharePct, !!x.personId]), [['DJ Harvie', '50%', false], ['Shtain', '50%', true]]);
  assert.equal(pay[1]!.name, 'Брянский А.Н.');
  assert.equal(ql(db, { quarter: '2026Q2', person: '__none' }).total, 1, 'у DJ Harvie нет человека');
  upd(db, ctx, 'artist', a2, { counterparty_id: p1 });
  assert.equal(ql(db, { quarter: '2026Q2', person: '__none' }).total, 0);
  assert.equal(ql(db, { quarter: '2026Q2', person: 'нет-такого' }).total, 0);
});
