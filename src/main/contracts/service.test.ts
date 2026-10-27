import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { insertRow } from '../db/mutate.ts';
import { unzipAll } from '../export/zipReader.ts';
import { defaultTerms } from './fields.ts';
import { deleteContract, draftAppendix, exportContractFile, getContract, listContracts, newContract, previewContract, saveAppendix, saveContract, trackRow, type ContractEdit } from './service.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };

function setup(status: 'ip' | 'sz' | 'fl' = 'sz') {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const cp = insertRow(db, ctx, 'counterparty', {
    last_name: 'Тестов', first_name: 'Антон', middle_name: 'Игоревич', status, inn: '501213042843', birth_date: '1990-05-06',
    passport_series: '4620', passport_number: '770378', passport_issued_by: 'ГУ МВД', passport_issued_date: '2020-07-07', addr_raw: 'г. Одинцово, ул. Тестовая, д. 4',
    bank_name: 'АО "Банк"', bank_account: '40802810001500360177', bank_corr_account: '30101810745374525104', bank_bik: '044525104', email: 'a@b.ru',
  });
  const artist = insertRow(db, ctx, 'artist', { name: 'Tester', counterparty_id: cp });
  const track = insertRow(db, ctx, 'track', { title: 'Cold Heart', isrc: 'RUA1D2588339', release_date: '2025-03-01', explicit: 0 });
  return { db, cp, artist, track };
}
const edit = (cp: string, over: Partial<ContractEdit> = {}): ContractEdit => {
  const t = defaultTerms();
  return { id: null, counterpartyId: cp, number: 'ПР-СЗ/ТТ/26', date: '2026-10-27', fields: t.fields, options: t.options, okved: null, ...over };
};

test('новый договор: номер-подсказка по статусу, умолчания', () => {
  const { db, cp } = setup('sz');
  const d = newContract(db, cp);
  assert.equal(d.kind, 'sz');
  assert.match(d.number, /^ПР-СЗ\/TES\/\d\d$/);
  assert.equal(d.fields.threshold, 5000);
  assert.equal(d.options.p413, 'rate');
});

test('физлицо не допускается', () => {
  const { db, cp } = setup('fl');
  assert.throws(() => saveContract(db, ctx, edit(cp)), /ИП или самозанятый/);
});

test('сохранение: порог уходит в колонку (копейки) для расчёта выплат, условия — в terms_json', () => {
  const { db, cp } = setup('sz');
  const id = saveContract(db, ctx, edit(cp, { fields: { ...defaultTerms().fields, threshold: 3000, pay_days: 15 }, options: { cover: true, release: false, p413: 'nochange' } }));
  const r = db.prepare('SELECT * FROM contract WHERE id = ?').get(id)!;
  assert.equal(r.threshold_rub, 300000);
  assert.equal(r.threshold_rule, 'carry_until_exceeded');
  assert.equal(r.status_clause_50, 0);
  const d = getContract(db, id);
  assert.equal(d.fields.threshold, 3000);
  assert.equal(d.fields.pay_days, 15);
  assert.equal(d.options.cover, true);
  // правка
  saveContract(db, ctx, edit(cp, { id, fields: { ...d.fields, threshold: 7000 } }));
  assert.equal(db.prepare('SELECT threshold_rub FROM contract WHERE id = ?').get(id)!.threshold_rub, 700000);
  assert.equal(listContracts(db).length, 1);
  assert.equal(listContracts(db)[0]!.thresholdRub, 7000);
  assert.throws(() => saveContract(db, ctx, edit(cp)), /уже есть/);
  assert.throws(() => saveContract(db, ctx, edit(cp, { number: 'X', fields: { ...d.fields, report_days: 0 } })), /Срок отчёта/);
});

test('предпросмотр: блоки с редактируемыми полями и список недостающих данных', () => {
  const { db, cp } = setup('sz');
  db.prepare('UPDATE counterparty SET bank_bik = NULL WHERE id = ?').run(cp);
  const p = previewContract(db, edit(cp));
  assert.deepEqual(p.missing, ['БИК']);
  const texts = JSON.stringify(p.blocks);
  assert.ok(texts.includes('"key":"threshold"') && texts.includes('"key":"rate_loss"'));
  const opt = p.blocks.filter((b) => b.kind === 'p' && b.optional);
  assert.equal(opt.length, 2);
  assert.ok(opt.every((b) => b.kind === 'p' && !b.included));
});

test('приложение: черновик из участий, повторное использование авторов, запись и привязка', () => {
  const { db, cp, artist, track } = setup('sz');
  const id = saveContract(db, ctx, edit(cp));
  const part = insertRow(db, ctx, 'participation', { track_id: track, artist_id: artist, share_authors: '0.3333', share_related: '0.5', label_rate: '0.8', contract_id: id });
  const d = draftAppendix(db, id, null);
  assert.equal(d.no, 1);
  assert.equal(d.tracks.length, 1);
  const r = d.tracks[0]!.row;
  assert.equal(r.title, 'Cold Heart');
  assert.equal(r.performers, 'Tester');
  assert.equal(r.shareAuthors, '33,33%');
  assert.equal(r.shareRelated, '50%');
  assert.equal(r.rate, '80%');
  assert.equal(r.year, '2025');
  assert.match(r.term, /^\d\d\.\d\d\.\d{4} - \d\d\.\d\d\.\d{4}$/);
  d.tracks[0]!.row.lyricists = 'Тестов А.И.';
  d.tracks[0]!.row.composers = 'Тестов А.И.';
  const aid = saveAppendix(db, ctx, id, d);
  assert.equal(db.prepare('SELECT appendix_id FROM participation WHERE id = ?').get(part)!.appendix_id, aid);
  assert.equal(getContract(db, id).appendices[0]!.items, 1);
  // следующий черновик не тянет уже включённый трек, а ручное добавление подставляет авторов из прошлого приложения
  assert.equal(draftAppendix(db, id, null).tracks.length, 0);
  assert.equal(trackRow(db, id, track, '2026-11-01').row.lyricists, 'Тестов А.И.');
  // перечитывание и пересохранение
  const again = draftAppendix(db, id, aid);
  assert.equal(again.tracks[0]!.row.lyricists, 'Тестов А.И.');
  saveAppendix(db, ctx, id, { ...again, images: [{ workTitle: 'Cold Heart', description: 'Обложка трека', authors: 'Тестов А.И.', performer: 'Tester', share: '100%', year: '2025', term: 'x' }] });
  assert.equal(draftAppendix(db, id, aid).images.length, 1);
  assert.throws(() => saveAppendix(db, ctx, id, { ...again, appendixId: null }), /уже есть/);
});

test('выгрузка: Word и PDF в папку «Договоры», имена не затираются, поля подставлены', async () => {
  const { db, cp } = setup('sz');
  const id = saveContract(db, ctx, edit(cp));
  const dir = mkdtempSync(join(tmpdir(), 'rl-contracts-'));
  try {
    let html = '';
    const render = async (h: string) => { html = h; return Buffer.from('%PDF-fake'); };
    const p1 = await exportContractFile(db, dir, { contractId: id, format: 'docx', part: 'contract' }, null, null, render);
    const p2 = await exportContractFile(db, dir, { contractId: id, format: 'docx', part: 'contract' }, null, null, render);
    assert.notEqual(p1, p2);
    assert.ok(existsSync(join(dir, p1)));
    const x = unzipAll(readFileSync(join(dir, p1))).get('word/document.xml')!.toString('utf8');
    assert.ok(x.includes('ПР-СЗ/ТТ/26') && !x.includes('{{'));
    const p3 = await exportContractFile(db, dir, { contractId: id, format: 'pdf', part: 'both' }, null, null, render);
    assert.ok(p3.endsWith('.pdf'));
    assert.ok(html.includes('ПЕРЕЧЕНЬ ОБЪЕКТОВ') && html.includes('ПРЕДМЕТ ДОГОВОРА'));
    // экран важнее базы: условия, которые ещё не сохранены
    const p4 = await exportContractFile(db, dir, { contractId: id, format: 'docx', part: 'contract' }, edit(cp, { id, fields: { ...defaultTerms().fields, threshold: 9000 } }), null, render);
    const y = unzipAll(readFileSync(join(dir, p4))).get('word/document.xml')!.toString('utf8').replace(/<[^>]+>/g, '');
    assert.ok(y.includes('9 000 (девять тысяч) рублей'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('удаление договора снимает привязку приложений', () => {
  const { db, cp, artist, track } = setup('sz');
  const id = saveContract(db, ctx, edit(cp));
  const part = insertRow(db, ctx, 'participation', { track_id: track, artist_id: artist, share_authors: '0.5', share_related: '0.5', label_rate: '0.8', contract_id: id });
  saveAppendix(db, ctx, id, draftAppendix(db, id, null));
  deleteContract(db, ctx, id);
  assert.equal(listContracts(db).length, 0);
  assert.equal(db.prepare('SELECT appendix_id FROM participation WHERE id = ?').get(part)!.appendix_id, null);
});

test('приложение из стартовой базы («сырые» поля) открывается с заполненными строками', () => {
  const { db, cp, artist, track } = setup('sz');
  insertRow(db, ctx, 'participation', { track_id: track, artist_id: artist, share_authors: '0.5', share_related: '0.5', label_rate: '0.7' });
  const c = saveContract(db, ctx, edit(cp));
  const app = insertRow(db, ctx, 'appendix', { contract_id: c, number: 1, date: '2026-07-31', status: 'draft' });
  insertRow(db, ctx, 'appendix_item', { appendix_id: app, track_id: track, participation_id: null, kind: 'works', payload_json: JSON.stringify({ title_raw: 'Cold Heart', performers_raw: 'Tester', shares_raw: '50%', term_raw: '2025-2035', mode: 'x' }) });
  insertRow(db, ctx, 'appendix_item', { appendix_id: app, track_id: null, participation_id: null, kind: 'works', payload_json: JSON.stringify({ title_raw: 'Без трека', performers_raw: 'Кто-то' }) });
  const d = draftAppendix(db, c, app);
  assert.equal(d.tracks.length, 2);
  for (const t of d.tracks) for (const v of Object.values(t.row)) assert.equal(typeof v, 'string', 'ни одного undefined');
  assert.equal(d.tracks[0]!.row.title, 'Cold Heart');
  assert.equal(d.tracks[0]!.row.term, '2025-2035');
  assert.equal(d.tracks[1]!.row.title, 'Без трека');
  assert.equal(d.tracks[1]!.row.performers, 'Кто-то');
});
