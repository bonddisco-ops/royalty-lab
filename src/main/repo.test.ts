import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../test/nodeSqliteDb.ts';
import { sampleSheets } from '../test/sampleStarter.ts';
import { ensureDefaultSettings } from './db/init.ts';
import { buildStarterPlan } from './seed/starterPlan.ts';
import { writeStarterPlan } from './seed/starterWrite.ts';
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
