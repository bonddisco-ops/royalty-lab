import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchCovers, type CoverTrack } from './coverMatch.ts';

const T = (id: string, title: string, artists: string[], version: string | null = null): CoverTrack => ({ id, title, version, artists, hasCover: false });
const tracks = [
  T('1', 'Storm', ['Skif Bazzaty']), T('2', 'Baby Move', ['WALLMERS', 'FEDO']), T('3', 'Как канье', ['Саша Винстон', 'Lew Heart']),
  T('4', 'Perfect Day', ['Twin Scream'], 'Original'), T('5', 'Perfect Day', ['Twin Scream'], 'Extended'), T('6', 'Что-то: тест?', ['A']),
];

test('сопоставление обложек: регистр, тире, порядок артистов, ё, спецсимволы', () => {
  const r = matchCovers(['skif bazzaty – STORM.jpg', 'FEDO, WALLMERS - Baby Move.png', 'Саша Винстон, Lew Heart - Как канье.jpg', 'A - Что-то_ тест_.jpg', 'Twin Scream - Perfect Day.jpg', 'Twin Scream - Perfect Day Extended.jpg', 'Nobody - Nothing.jpg', 'без тире.jpg'], tracks);
  assert.deepEqual(r.map((x) => x.status), ['ok', 'ok', 'ok', 'ok', 'ambiguous', 'ok', 'none', 'bad']);
  assert.deepEqual(r[4]!.candidates.sort(), ['4', '5']);
  assert.deepEqual(r[5]!.candidates, ['5']);
});
