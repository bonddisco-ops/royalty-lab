import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../test/nodeSqliteDb.ts';
import { sampleSheets } from '../test/sampleStarter.ts';
import { ensureDefaultSettings } from './db/init.ts';
import { buildStarterPlan } from './seed/starterPlan.ts';
import { writeStarterPlan } from './seed/starterWrite.ts';
import { insertRow, updateRow } from './db/mutate.ts';
import * as repo from './repo.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
function loaded() {
  const db = freshDb('r1');
  ensureDefaultSettings(db, ctx);
  writeStarterPlan(db, ctx, buildStarterPlan(sampleSheets));
  return db;
}
const track = (db: ReturnType<typeof loaded>, title: string) => repo.listTracks(db).find((t) => t.title === title)!;

test('люди: PII маскируются, показываются по запросу, индикатор полноты и проверки', () => {
  const db = loaded();
  const p = repo.listPeople(db).find((x) => x.display.startsWith('Иванов'))!;
  assert.deepEqual(p.artists, ['Alpha', 'Beta']);
  assert.ok(p.filled < p.total);
  const masked = repo.getPerson(db, p.id, false);
  assert.match(String(masked.fields.inn), /^••••/);
  assert.equal(masked.fields.last_name, 'Иванов');
  const open = repo.getPerson(db, p.id, true);
  assert.equal(open.fields.inn, '525011482295');
  assert.equal(repo.listPeople(db, 'beta').length, 1); // поиск по псевдониму
});

test('правка человека идёт через журнал, мусорные поля отклоняются', () => {
  const db = loaded();
  const p = repo.listPeople(db)[0]!;
  repo.updatePerson(db, ctx, p.id, { email: ' new@mail.ru ' });
  assert.equal(repo.getPerson(db, p.id, true).fields.email, 'new@mail.ru');
  assert.equal(repo.history(db, 'counterparty', p.id)[0]!.field, 'email');
  assert.throws(() => repo.updatePerson(db, ctx, p.id, { deleted_at: 'x' }), /менять нельзя/);
  assert.throws(() => repo.updatePerson(db, ctx, p.id, { status: 'вор' }), /Статус/);
});

test('артист: переименование добавляет написание, чужое написание занять нельзя', () => {
  const db = loaded();
  const a = repo.listArtists(db).find((x) => x.name === 'Zed')!;
  assert.equal(a.withoutContract, true);
  repo.updateArtist(db, ctx, a.id, { name: 'Zed Zero' });
  assert.equal(repo.listArtists(db).find((x) => x.id === a.id)!.variants.length, 2);
  assert.throws(() => repo.createArtist(db, ctx, { name: 'alpha' }), /уже закреплено/);
  repo.addArtistVariant(db, ctx, a.id, 'Зед');
});

test('трек: сумма долей, «Исправить» дописывает остаток выбранному участнику', () => {
  const db = loaded();
  const t = track(db, 'Song Two');
  assert.equal(t.shareSumBad, true); // Delta 0.5 + Zed 0
  const delta = t.participants.find((p) => p.artist === 'Delta')!;
  repo.fixShares(db, ctx, t.id, delta.id);
  const after = track(db, 'Song Two');
  assert.equal(after.shareSumBad, false);
  assert.equal(after.participants.find((p) => p.artist === 'Delta')!.shareAuthors, '1');
  assert.equal(repo.listTracks(db, '', true).some((x) => x.title === 'Song Two'), false);
});

test('участие: доли проверяются, дубль участника подсвечивается, разные получатели — не дубль', () => {
  const db = loaded();
  const t = track(db, 'Song One');
  const alpha = t.participants.find((p) => p.artist === 'Alpha')!;
  assert.throws(() => repo.updateParticipation(db, ctx, alpha.id, { share_authors: '1.5' }), /от 0 до 1/);
  assert.throws(() => repo.updateParticipation(db, ctx, alpha.id, { share_authors: 'abc' }), /от 0 до 1/);
  repo.addParticipation(db, ctx, { trackId: t.id, artistId: alpha.artistId, shareAuthors: '0', shareRelated: '0', labelRate: '0.8' });
  assert.equal(track(db, 'Song One').hasDuplicates, true);
  const payee = repo.listPeople(db)[0]!.id;
  const dup = track(db, 'Song One').participants.filter((p) => p.artistId === alpha.artistId).find((p) => p.id !== alpha.id)!;
  repo.updateParticipation(db, ctx, dup.id, { payee_counterparty_id: payee });
  assert.equal(track(db, 'Song One').hasDuplicates, false);
});

test('очередь «Проверить»: открытые и закрытие с отметкой', () => {
  const db = loaded();
  const open = repo.listIssues(db, 'open');
  assert.ok(open.length > 0);
  const first = open.find((i) => i.kind === 'no_contract')!;
  assert.equal(first.label, 'Zed');
  repo.resolveIssue(db, ctx, first.id, 'ignored', 'это сессионник');
  assert.equal(repo.listIssues(db, 'open').some((i) => i.id === first.id), false);
  assert.equal(repo.listIssues(db, 'ignored')[0]!.id, first.id);
});

test('сводка и настройки', () => {
  const db = loaded();
  const d = repo.dashboard(db);
  assert.equal(d.people, 4);
  assert.equal(d.contracts, 3);
  assert.equal(repo.getSettings(db).hidden_deduction, '0.06');
  repo.setSetting(db, ctx, 'auto_lock_minutes', '30');
  assert.throws(() => repo.setSetting(db, ctx, 'hidden_deduction', '1.2'), /от 0 до 1/);
  assert.throws(() => repo.setSetting(db, ctx, 'nope', '1'), /Неизвестная/);
});

import { addArtistToPerson, closeNoContractIssue, createArtist, createPerson } from './repo.ts';

test('новый человек: вопрос «нет договора»; артист нельзя забрать у другого человека', () => {
  const db = freshDb('r1');
  const c = { userId: 'owner', replicaId: 'r1' };
  const p1 = createPerson(db, c, { last_name: 'Иванов', first_name: 'Иван' });
  const p2 = createPerson(db, c, { last_name: 'Петров', first_name: 'Пётр' });
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'no_contract' AND status = 'open'").get()!.n, 2);
  const a = createArtist(db, c, { name: 'Alosa' });
  addArtistToPerson(db, c, p1, { artistId: a });
  assert.throws(() => addArtistToPerson(db, c, p2, { artistId: a }), /уже закреплён за другим человеком: Иванов/);
  assert.notEqual(addArtistToPerson(db, c, p2, { name: 'New One' }), a);
  closeNoContractIssue(db, c, p1);
  assert.equal(db.prepare("SELECT count(*) n FROM issue WHERE kind = 'no_contract' AND status = 'open'").get()!.n, 1);
});

test('автопроверка закрывает вопросы, причина которых устранена', () => {
  const db = freshDb();
  const c = { userId: 'owner', replicaId: 'r1' };
  const p = repo.createPerson(db, c, { last_name: 'Тестов', first_name: 'Тест' });
  assert.equal(repo.listIssues(db, 'open').filter((i) => i.kind === 'no_contract').length, 1);
  assert.equal(repo.revalidateIssues(db, c), 0, 'пока договора нет — вопрос остаётся');
  insertRow(db, c, 'contract', { counterparty_id: p, number: 'Т-1' });
  assert.equal(repo.revalidateIssues(db, c), 1);
  assert.equal(repo.listIssues(db, 'open').length, 0);
  insertRow(db, c, 'issue', { kind: 'missing_pii', entity_type: 'counterparty', entity_id: p, details_json: { field: 'inn' }, status: 'open' });
  assert.equal(repo.revalidateIssues(db, c), 0);
  updateRow(db, c, 'counterparty', p, { inn: '504407626681' });
  assert.equal(repo.revalidateIssues(db, c), 1);
  insertRow(db, c, 'issue', { kind: 'unknown_artist', details_json: { artist: 'Новый Артист' }, status: 'open' });
  assert.equal(repo.revalidateIssues(db, c), 0);
  repo.createArtist(db, c, { name: 'Новый Артист' });
  assert.equal(repo.revalidateIssues(db, c), 1);
});

test('треки: люди по долям — коллаб двух людей и несколько артистов одного человека', () => {
  const db = freshDb();
  const c = { userId: 'owner', replicaId: 'r1' };
  const p1 = repo.createPerson(db, c, { last_name: 'Первый', first_name: 'Пётр' });
  const p2 = repo.createPerson(db, c, { last_name: 'Второй', first_name: 'Семён' });
  const a1 = repo.createArtist(db, c, { name: 'Alias One', counterparty_id: p1 });
  const a2 = repo.createArtist(db, c, { name: 'Alias Two', counterparty_id: p1 });
  const a3 = repo.createArtist(db, c, { name: 'Solo', counterparty_id: p2 });
  const a4 = repo.createArtist(db, c, { name: 'Free' });
  const t = repo.createTrack(db, c, { title: 'Collab' });
  for (const [a, sa, sr] of [[a1, '0.25', '0.25'], [a2, '0.25', '0.25'], [a3, '0.25', '0.25'], [a4, '0.25', '0.25']] as const) insertRow(db, c, 'participation', { track_id: t, artist_id: a, share_authors: sa, share_related: sr, label_rate: '0.7' });
  const v = repo.listTracks(db).find((x) => x.id === t)!;
  assert.equal(v.people.length, 3);
  const one = v.people.find((x) => x.personId === p1)!;
  assert.deepEqual([one.artists.length, one.shareRelated], [2, '0.5']);
  assert.ok(v.people.some((x) => x.personId === null && x.artists[0] === 'Free'));
  assert.equal(v.participants.find((x) => x.artist === 'Solo')!.person, 'Второй Семён');
});

import { quickAddTrack, listTracks as listTracksQ } from './repo.ts';
test('быстрое внесение трека: известный артист привязывается, новый создаётся без человека, дубль отклоняется', () => {
  const db = freshDb();
  const c = { userId: 'owner', replicaId: 'r1' };
  const p = createPerson(db, c, { last_name: 'Иванов', first_name: 'Иван' } as never);
  const a = createArtist(db, c, { name: 'Vasya Pupkin', counterparty_id: p });
  const r1 = quickAddTrack(db, c, { title: 'Новый трек', artistName: '  vasya  pupkin ' });
  assert.equal(r1.artistCreated, false);
  assert.equal(r1.artistId, a);
  assert.equal(r1.personId, p);
  const r2 = quickAddTrack(db, c, { title: 'Другой', artistName: 'Совсем Новый' });
  assert.equal(r2.artistCreated, true);
  assert.equal(r2.personId, null);
  assert.throws(() => quickAddTrack(db, c, { title: 'новый ТРЕК', artistName: 'Vasya Pupkin' }), /уже есть/);
  const t = listTracksQ(db).find((x) => x.id === r2.trackId)!;
  assert.equal(t.participants[0]!.shareAuthors, '1');
});

test('смена ISRC: связи остаются, старый код сохраняется, строки без трека подхватываются, чужой ISRC нельзя', () => {
  const db = freshDb();
  const c = { userId: 'owner', replicaId: 'r1' };
  const t1 = repo.createTrack(db, c, { title: 'Один', isrc: 'RUA1D2500001' });
  const t2 = repo.createTrack(db, c, { title: 'Два', isrc: 'RUA1D2500002' });
  const art = repo.createArtist(db, c, { name: 'Артист' });
  repo.addParticipation(db, c, { trackId: t1, artistId: art, shareAuthors: '1', shareRelated: '1', labelRate: null });
  assert.throws(() => repo.updateTrack(db, c, t1, { isrc: 'RUA1D2500002' }), /уже закреплён за треком «Два»/);
  assert.throws(() => repo.updateTrack(db, c, t1, { isrc: 'ABC' }), /ISRC должен быть/);
  assert.equal(repo.updateTrack(db, c, t1, { isrc: 'rua1d2599999' }), 0);
  const tr = repo.listTracks(db).find((x) => x.id === t1)!;
  assert.equal(tr.isrc, 'RUA1D2599999');
  assert.equal(tr.participants.length, 1);
  const idents = db.prepare("SELECT value_norm FROM track_identifier WHERE track_id = ? AND kind = 'isrc' AND deleted_at IS NULL").all(t1).map((r) => r.value_norm).sort();
  assert.deepEqual(idents, ['RUA1D2500001', 'RUA1D2599999']);
  repo.updateTrack(db, c, t1, { isrc: null });
  assert.equal(repo.listTracks(db).find((x) => x.id === t1)!.isrc, null);
});

test('удаление: артист с треками и человек с артистом/договором защищены, пустые удаляются', () => {
  const db = freshDb();
  const c = { userId: 'owner', replicaId: 'r1' };
  const p = repo.createPerson(db, c, { last_name: 'Сидоров', first_name: 'Сидор' });
  const a = repo.createArtist(db, c, { name: 'Сидр', counterparty_id: p });
  const t = repo.createTrack(db, c, { title: 'Трек' });
  const part = repo.addParticipation(db, c, { trackId: t, artistId: a, shareAuthors: '1', shareRelated: '1', labelRate: null });
  assert.throws(() => repo.deleteArtist(db, c, a), /есть треки/);
  assert.throws(() => repo.deletePerson(db, c, p), /закреплены артисты/);
  repo.removeParticipation(db, c, part);
  repo.deleteArtist(db, c, a);
  assert.equal(repo.listArtists(db).length, 0);
  insertRow(db, c, 'contract', { counterparty_id: p, number: 'Д-1' });
  assert.throws(() => repo.deletePerson(db, c, p), /есть договор/);
  db.prepare('UPDATE contract SET deleted_at = ?').run(new Date().toISOString());
  repo.deletePerson(db, c, p);
  assert.equal(repo.listPeople(db).length, 0);
});
