import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { buildStarterPlan } from './starterPlan.ts';
import { splitPassportIssued, parseFio } from './starterParse.ts';
import { writeStarterPlan } from './starterWrite.ts';
import { sampleSheets } from '../../test/sampleStarter.ts';

const plan = buildStarterPlan(sampleSheets);
const rows = (t: string) => plan.ops.filter((o) => o.table === t).map((o) => o.row);
const artistName = (id: unknown) => rows('artist').find((a) => a.id === id)?.name as string;
const part = (track: string, artist: string) => {
  const t = rows('track').find((x) => x.title === track)!;
  return rows('participation').find((p) => p.track_id === t.id && artistName(p.artist_id) === artist)!;
};

test('разбор ФИО: статус, ОГРНИП и «Казахстан» убираются', () => {
  const f = parseFio('ИП Иванов Иван Иванович ОГРНИП: 321000000000001 ИНН: 525011482295 ОКВЭД: 9');
  assert.deepEqual([f.last, f.first, f.middle, f.ogrnip, f.statusHint], ['Иванов', 'Иван', 'Иванович', '321000000000001', 'ip']);
  assert.equal(parseFio('Казахстан Юсибов Гасан').middle, '');
});

test('«кем выдан» и дата выдачи разделяются', () => {
  assert.deepEqual(splitPassportIssued('27.07.2011 г. ОТДЕЛОМ УФМС'), { issuedBy: 'ОТДЕЛОМ УФМС', date: '2011-07-27' });
  assert.deepEqual(splitPassportIssued('УВД Кстовского р-на 08.08.2003'), { issuedBy: 'УВД Кстовского р-на', date: '2003-08-08' });
});

test('люди и договоры: исключения, Gassan-правило, дата из имени файла', () => {
  assert.equal(plan.summary.people, 4); // IMSOLO не загружен
  assert.equal(plan.summary.contracts, 3); // договор Gassan не привязан
  assert.ok(!rows('contract').some((c) => c.number === 'ПР-КЗ/ЛМД'));
  const c = rows('contract').find((x) => x.number === 'ПР-ИП/А/26')!;
  assert.equal(c.date, '2026-03-05');
  assert.match(String(c.notes), /имени файла/);
  assert.equal(c.threshold_rub, 500000); // копейки
  const d = rows('contract').find((x) => x.number === 'ПР-СЗ/Д/26')!;
  assert.equal(d.rate_default, '0.7');
  assert.equal(d.end_date, '2035-10-01');
  const cp = rows('counterparty').find((x) => x.last_name === 'Иванов')!;
  assert.equal(cp.ogrnip, '321000000000001');
  assert.equal(cp.status, 'ip');
  assert.equal(cp.passport_issued_date, '2011-07-27');
});

test('артисты: папка с несколькими псевдонимами, опечатка Emersson, пробелы', () => {
  const names = rows('artist').map((a) => a.name).sort();
  assert.deepEqual(names, ['Alpha', 'Beta', 'Delta', 'Eps', 'Gassan', 'Matvey Emerson', 'Zed']);
  const cpId = rows('artist').find((a) => a.name === 'Alpha')!.counterparty_id;
  assert.equal(rows('artist').find((a) => a.name === 'Beta')!.counterparty_id, cpId);
  assert.equal(rows('artist').find((a) => a.name === 'Zed')!.counterparty_id, null);
});

test('треки: внутренние коды склеиваются, ISRC уникален', () => {
  const code = rows('track').find((t) => t.title === 'Code Song')!;
  assert.equal(code.isrc, null);
  const ids = rows('track_identifier').filter((i) => i.track_id === code.id);
  assert.deepEqual(ids.map((i) => i.kind), ['distributor_code', 'distributor_code']);
  assert.equal(rows('track').filter((t) => t.isrc === 'AEA2Z2620508').length, 1);
  assert.equal(plan.summary.tracks, 7);
  assert.deepEqual(plan.summary.unmatchedAppendixTracks, ['Delta: «Missing Track»']);
});

test('договорная доля приоритетнее SPLIT, но однозначно только для одного лицензиара', () => {
  // Song Two: в договоре 50 50 и исполнители «Delta, Zed» → Delta = 0.5 (в SPLIT было 1)
  const p = part('Song Two', 'Delta');
  assert.equal(p.share_authors, '0.5');
  assert.match(String(p.notes), /Приоритет у договора/);
  assert.equal(part('Song Two', 'Zed').share_authors, '0'); // 0/0 в SPLIT не трогаем
  // Song Four: «Авторские / Смежные» из встроенной шапки
  const f = part('Song Four', 'Eps');
  assert.equal(f.share_authors, '0.8');
  assert.equal(f.share_related, '0.6');
  // Song One: в папке два псевдонима с участием → доля неоднозначна, остаётся SPLIT, но связь с договором есть
  assert.equal(part('Song One', 'Alpha').share_authors, '0.4');
  assert.ok(part('Song One', 'Alpha').contract_id);
  assert.ok(plan.summary.ambiguousContractShares.some((s) => s.includes('Song One')));
  // участие, которого нет в SPLIT, создаётся из договора со ставкой договора
  const m = part('Missing Track', 'Delta');
  assert.equal(m.share_authors, '1');
  assert.equal(m.label_rate, '0.7');
  assert.match(String(m.notes), /Создано из договора/);
  assert.deepEqual(plan.summary.unmatchedAppendixTracks, ['Delta: «Missing Track»']);
});

test('дубли строк SPLIT склеиваются, а не множатся', () => {
  assert.equal(rows('participation').filter((p) => artistName(p.artist_id) === 'Eps').length, 1);
  assert.ok(plan.summary.duplicateSplitRowsMerged >= 2);
});

test('очередь «Проверить»: перенос листа и пересчёт по актуальным данным', () => {
  const k = plan.summary.issuesByKind;
  assert.equal(k.missing_pii, 1);
  assert.equal(k.whitespace, 1);
  assert.equal(k.no_contract, 1);
  assert.equal(k.missing_rate ?? 0, 0); // у Gassan договора нет, строку листа пропускаем
  assert.equal(k.share_sum, 4); // Song Two, Song Three, Song Four, Typo Song
  const ws = rows('issue').find((i) => i.kind === 'whitespace')!;
  assert.equal(ws.status, 'resolved');
});

test('запись в БД: внешние ключи целы, всё через журнал, повторная загрузка блокируется', () => {
  const db = freshDb('r1');
  const ctx = { userId: 'owner', replicaId: 'r1' };
  ensureDefaultSettings(db, ctx);
  writeStarterPlan(db, ctx, plan);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM artist').get()!.n), 7);
  const logged = Number(db.prepare("SELECT count(*) AS n FROM change_log WHERE op = 'insert'").get()!.n);
  assert.equal(logged, plan.ops.length + 3); // + три настройки по умолчанию
  assert.throws(() => writeStarterPlan(db, ctx, plan), /только в пустой каталог/);
});
