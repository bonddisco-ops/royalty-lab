import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { insertRow, updateRow } from '../db/mutate.ts';
import { applyPayload, buildPayload, parsePayload, previewPayload } from './exchange.ts';
import { openRlab, sealRlab, type DeriveKey } from './rlab.ts';

const fastKey: DeriveKey = async (pw, salt) => Buffer.concat([Buffer.from(pw), salt, Buffer.alloc(32)]).subarray(0, 32);
const dk = Buffer.alloc(32, 7);
const dir = mkdtempSync(join(tmpdir(), 'rlx-'));
const io = { dk, photosDir: join(dir, 'p'), reportsDir: join(dir, 'r') };
const mk = (id: string) => ({ db: freshDb(id), ctx: { userId: id, replicaId: id } });
const build = (db: ReturnType<typeof freshDb>, id: string, pii = false) => buildPayload(db, { includePii: pii, author: id, replicaId: id, dk, photosDir: io.photosDir, reportsDir: io.reportsDir });

test('контейнер .rlab: неверный пароль и подмена', async () => {
  const sealed = await sealRlab(Buffer.from('hello'), 'secret1', fastKey);
  assert.equal((await openRlab(sealed, 'secret1', fastKey)).toString(), 'hello');
  await assert.rejects(openRlab(sealed, 'wrong-pw', fastKey), /Неверный пароль/);
  const bad = Buffer.from(sealed); bad[bad.length - 1]! ^= 1;
  await assert.rejects(openRlab(bad, 'secret1', fastKey));
  await assert.rejects(openRlab(Buffer.from('nope'), 'secret1', fastKey), /не файл обновления/);
});

test('первый обмен: данные переезжают, паспорт — только по галочке', () => {
  const A = mk('A'), B = mk('B');
  const cp = insertRow(A.db, A.ctx, 'counterparty', { last_name: 'Иванов', first_name: 'Иван', inn: '123456789012', status: 'ip' });
  insertRow(A.db, A.ctx, 'artist', { name: 'Alosa', counterparty_id: cp });
  const p = parsePayload(build(A.db, 'A').zip);
  const pv = previewPayload(B.db, p, 'B');
  assert.equal(pv.groups.length, 2);
  assert.equal(pv.conflicts, 0);
  const r = applyPayload(B.db, B.ctx, p, { skipGroups: [], keepMine: [] }, io);
  assert.equal(r.applied, 2);
  const got = B.db.prepare('SELECT * FROM counterparty WHERE id = ?').get(cp)!;
  assert.equal(got.last_name, 'Иванов');
  assert.equal(got.inn, null);
  // повторная загрузка того же файла ничего не меняет
  assert.equal(previewPayload(B.db, p, 'B').fresh, 0);
  // с галочкой PII
  const full = parsePayload(build(A.db, 'A', true).zip);
  const C = mk('C');
  applyPayload(C.db, C.ctx, full, { skipGroups: [], keepMine: [] }, io);
  assert.equal(C.db.prepare('SELECT inn FROM counterparty WHERE id = ?').get(cp)!.inn, '123456789012');
});

test('конфликт: одно поле изменено у обоих; выбор «моё» и «его»', () => {
  const A = mk('A'), B = mk('B');
  const id = insertRow(A.db, A.ctx, 'artist', { name: 'Old' });
  applyPayload(B.db, B.ctx, parsePayload(build(A.db, 'A').zip), { skipGroups: [], keepMine: [] }, io);
  updateRow(A.db, A.ctx, 'artist', id, { name: 'FromA' });
  updateRow(B.db, B.ctx, 'artist', id, { name: 'FromB' });
  const p = parsePayload(build(A.db, 'A').zip);
  const pv = previewPayload(B.db, p, 'B');
  assert.equal(pv.conflicts, 1);
  const ch = pv.groups[0]!.changes.find((c) => c.conflict)!;
  assert.equal(ch.mine, 'FromB');
  // оставить моё
  applyPayload(B.db, B.ctx, p, { skipGroups: [], keepMine: [ch.eventId] }, io);
  assert.equal(B.db.prepare('SELECT name FROM artist WHERE id = ?').get(id)!.name, 'FromB');
});

test('конфликт: берём его правку; «не применять» группу пропускает', () => {
  const A = mk('A'), B = mk('B');
  const id = insertRow(A.db, A.ctx, 'artist', { name: 'Old' });
  const id2 = insertRow(A.db, A.ctx, 'artist', { name: 'Second' });
  applyPayload(B.db, B.ctx, parsePayload(build(A.db, 'A').zip), { skipGroups: [], keepMine: [] }, io);
  updateRow(A.db, A.ctx, 'artist', id, { name: 'FromA' });
  updateRow(A.db, A.ctx, 'artist', id2, { name: 'Second2' });
  updateRow(B.db, B.ctx, 'artist', id, { name: 'FromB' });
  const p = parsePayload(build(A.db, 'A').zip);
  applyPayload(B.db, B.ctx, p, { skipGroups: [`artist/${id2}`], keepMine: [] }, io);
  assert.equal(B.db.prepare('SELECT name FROM artist WHERE id = ?').get(id)!.name, 'FromA');
  assert.equal(B.db.prepare('SELECT name FROM artist WHERE id = ?').get(id2)!.name, 'Second');
});

test('обратный обмен: бухгалтер возвращает свои правки, полученные не дублируются', () => {
  const A = mk('A'), B = mk('B');
  const id = insertRow(A.db, A.ctx, 'artist', { name: 'X' });
  applyPayload(B.db, B.ctx, parsePayload(build(A.db, 'A').zip), { skipGroups: [], keepMine: [] }, io);
  updateRow(B.db, B.ctx, 'artist', id, { name: 'Y' });
  const back = parsePayload(build(B.db, 'B').zip);
  const pv = previewPayload(A.db, back, 'A');
  assert.equal(pv.fresh, 1);
  applyPayload(A.db, A.ctx, back, { skipGroups: [], keepMine: [] }, io);
  assert.equal(A.db.prepare('SELECT name FROM artist WHERE id = ?').get(id)!.name, 'Y');
  // второй файл от A уже не содержит того, что B подтвердил
  const again = parsePayload(build(A.db, 'A').zip);
  assert.equal(again.events.filter((e) => e.replica_id === 'A').length, 0);
});

test('фото артиста и обложка трека переезжают внутри файла и перешифровываются ключом получателя', async () => {
  const { savePhoto, readPhoto } = await import('../photos.ts');
  const { mkdirSync } = await import('node:fs');
  const dkA = Buffer.alloc(32, 1), dkB = Buffer.alloc(32, 2);
  const dA = mkdtempSync(join(tmpdir(), 'rla-')), dB = mkdtempSync(join(tmpdir(), 'rlb-'));
  mkdirSync(join(dA, 'photos')); mkdirSync(join(dB, 'photos'));
  const A = mk('A'), B = mk('B');
  const file = savePhoto(join(dA, 'photos'), dkA, Buffer.from('FULLIMG'), Buffer.from('THUMB'));
  insertRow(A.db, A.ctx, 'artist', { name: 'Pic', photo_file: file });
  const cover = savePhoto(join(dA, 'photos'), dkA, Buffer.from('COVER'), Buffer.from('CT'));
  insertRow(A.db, A.ctx, 'track', { title: 'T', cover_file: cover });
  const zip = buildPayload(A.db, { includePii: false, author: 'A', replicaId: 'A', dk: dkA, photosDir: join(dA, 'photos'), reportsDir: join(dA, 'reports') }).zip;
  const r = applyPayload(B.db, B.ctx, parsePayload(zip), { skipGroups: [], keepMine: [] }, { dk: dkB, photosDir: join(dB, 'photos'), reportsDir: join(dB, 'reports') });
  assert.equal(r.files, 4);
  assert.equal(readPhoto(join(dB, 'photos'), dkB, file, false)!.toString(), 'FULLIMG');
  assert.equal(readPhoto(join(dB, 'photos'), dkB, cover, true)!.toString(), 'CT');
});

test('ведомости (xlsx/pdf) переезжают в обмене и раскладываются в output получателя; опасные пути отбрасываются', async () => {
  const { mkdirSync, writeFileSync, existsSync, readFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { safeStatementPath } = await import('./exchange.ts');
  assert.equal(safeStatementPath('../x.xlsx'), null);
  assert.equal(safeStatementPath('/etc/a.xlsx'), null);
  assert.equal(safeStatementPath('2026Q3/Иванов/Иванов 2026Q3.xlsx'), '2026Q3/Иванов/Иванов 2026Q3.xlsx');
  assert.equal(safeStatementPath('2026Q3/Иванов/virus.exe'), null);
  const A = mk('A'), B = mk('B');
  const root = mkdtempSync(join(tmpdir(), 'rl-st-'));
  const outA = join(root, 'a'), outB = join(root, 'b');
  const rel = '2026Q3/Иванов Иван/Иванов 2026Q3.xlsx';
  mkdirSync(join(outA, '2026Q3', 'Иванов Иван'), { recursive: true });
  writeFileSync(join(outA, ...rel.split('/')), Buffer.from('XLSX-DATA'));
  const cp = insertRow(A.db, A.ctx, 'counterparty', { last_name: 'Иванов' });
  const per = insertRow(A.db, A.ctx, 'payout_period', { counterparty_id: cp, quarter: '2026Q3', status: 'draft' } as never);
  insertRow(A.db, A.ctx, 'payout_statement', { payout_period_id: per, version_no: 1, xlsx_file: rel, pdf_file: null, generated_at: new Date().toISOString(), source_versions_json: {}, status: 'current' });
  const zip = buildPayload(A.db, { includePii: false, author: 'A', replicaId: 'A', dk, photosDir: io.photosDir, reportsDir: io.reportsDir, outputDir: outA }).zip;
  const r = applyPayload(B.db, B.ctx, parsePayload(zip), { skipGroups: [], keepMine: [] }, { ...io, outputDir: outB });
  assert.ok(r.files >= 1);
  assert.equal(readFileSync(join(outB, ...rel.split('/'))).toString(), 'XLSX-DATA');
  assert.ok(existsSync(join(outB, '2026Q3')));
});
