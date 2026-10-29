// Экспорт каталога по людям: один лист на человека — ФИО, почта, проекты и список треков «Артисты – Название».
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/types.ts';
import { buildSimpleXlsx, type XCell, type XSheet } from './simpleXlsx.ts';

export interface TreeArtist { id: string; name: string; tracks: number }
export interface TreePerson { personId: string | null; name: string; email: string | null; artists: TreeArtist[] }

const personName = (r: { last_name?: string | null; first_name?: string | null; middle_name?: string | null }): string => [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ') || '(без имени)';

/** Дерево для выбора: люди → их артисты (с числом треков); артисты без человека — отдельной группой в конце. */
export function catalogTree(db: Db): TreePerson[] {
  const counts = new Map<string, number>();
  for (const r of db.prepare('SELECT p.artist_id, count(DISTINCT p.track_id) n FROM participation p JOIN track t ON t.id = p.track_id AND t.deleted_at IS NULL WHERE p.deleted_at IS NULL GROUP BY p.artist_id').all()) counts.set(r.artist_id, Number(r.n));
  const artists = db.prepare('SELECT id, name, counterparty_id FROM artist WHERE deleted_at IS NULL ORDER BY name').all();
  const out: TreePerson[] = [];
  for (const c of db.prepare('SELECT * FROM counterparty WHERE deleted_at IS NULL ORDER BY last_name, first_name').all()) {
    const mine = artists.filter((a) => a.counterparty_id === c.id);
    if (mine.length === 0) continue;
    out.push({ personId: c.id, name: personName(c), email: c.email ?? null, artists: mine.map((a) => ({ id: a.id, name: a.name, tracks: counts.get(a.id) ?? 0 })) });
  }
  const free = artists.filter((a) => !a.counterparty_id);
  if (free.length) out.push({ personId: null, name: 'Без человека (в файл не попадут)', email: null, artists: free.map((a) => ({ id: a.id, name: a.name, tracks: counts.get(a.id) ?? 0 })) });
  return out;
}

export interface PersonSheet { personId: string; name: string; last: string; first: string; middle: string; email: string; projects: string[]; tracks: string[]; missing: string[] }

/** Данные по выбранным артистам, сгруппированные по людям. Артисты без человека пропускаются (их имена — в unassigned). */
export function catalogPeople(db: Db, artistIds: string[]): { people: PersonSheet[]; unassigned: string[] } {
  const sel = new Set(artistIds);
  const artists = db.prepare('SELECT id, name, counterparty_id FROM artist WHERE deleted_at IS NULL ORDER BY name').all().filter((a) => sel.has(a.id));
  const parts = db.prepare(
    `SELECT p.track_id, p.artist_id, a.name AS artist_name, t.title, t.version FROM participation p
       JOIN artist a ON a.id = p.artist_id AND a.deleted_at IS NULL JOIN track t ON t.id = p.track_id AND t.deleted_at IS NULL
      WHERE p.deleted_at IS NULL ORDER BY p.created_at, p.id`,
  ).all();
  const byTrack = new Map<string, { title: string; artists: string[] }>();
  const tracksOfArtist = new Map<string, Set<string>>();
  for (const p of parts) {
    const t = byTrack.get(p.track_id) ?? { title: String(p.title) + (p.version ? ` (${p.version})` : ''), artists: [] };
    if (!t.artists.includes(p.artist_name)) t.artists.push(p.artist_name);
    byTrack.set(p.track_id, t);
    const set = tracksOfArtist.get(p.artist_id) ?? new Set<string>();
    set.add(p.track_id);
    tracksOfArtist.set(p.artist_id, set);
  }
  const unassigned = artists.filter((a) => !a.counterparty_id).map((a) => String(a.name));
  const people: PersonSheet[] = [];
  for (const c of db.prepare('SELECT * FROM counterparty WHERE deleted_at IS NULL ORDER BY last_name, first_name').all()) {
    const mine = artists.filter((a) => a.counterparty_id === c.id);
    if (mine.length === 0) continue;
    const ids = new Set<string>();
    for (const a of mine) for (const t of tracksOfArtist.get(a.id) ?? []) ids.add(t);
    const lines = [...new Set([...ids].map((id) => { const t = byTrack.get(id)!; return `${t.artists.join(', ')} – ${t.title}`; }))].sort((x, y) => x.localeCompare(y, 'ru'));
    const missing: string[] = [];
    if (!c.last_name) missing.push('фамилия');
    if (!c.first_name) missing.push('имя');
    if (!c.middle_name) missing.push('отчество');
    if (!c.email) missing.push('электронная почта');
    if (lines.length === 0) missing.push('нет треков у выбранных проектов');
    people.push({ personId: c.id, name: personName(c), last: c.last_name ?? '', first: c.first_name ?? '', middle: c.middle_name ?? '', email: c.email ?? '', projects: mine.map((a) => String(a.name)), tracks: lines, missing });
  }
  return { people, unassigned };
}

export function catalogWorkbook(people: PersonSheet[]): Buffer {
  const sheets: XSheet[] = people.map((p) => {
    const field = (label: string, v: string): Array<XCell | null> => [{ v: label, s: 1 }, { v, s: v ? 0 : 2 }];
    const rows: Array<Array<XCell | null>> = [
      field('Фамилия', p.last), field('Имя', p.first), field('Отчество', p.middle), field('Электронная почта', p.email),
      [{ v: 'Проекты', s: 1 }, { v: p.projects.join(', ') }],
      [],
      [{ v: 'Треки', s: 1 }],
      ...(p.tracks.length ? p.tracks.map((t): Array<XCell | null> => [{ v: t }]) : [[{ v: 'нет треков', s: 2 } as XCell]]),
    ];
    return { name: `${p.last} ${p.first}`.trim() || p.name, rows, widths: [22, 70] };
  });
  return buildSimpleXlsx(sheets);
}

export function exportCatalog(db: Db, outputDir: string, artistIds: string[]): { path: string; people: number; tracks: number } {
  const { people } = catalogPeople(db, artistIds);
  if (people.length === 0) throw new Error('Нечего выгружать: выберите хотя бы одного артиста, привязанного к человеку');
  const dir = join(outputDir, 'Экспорт');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  let name = `Каталог_${stamp}.xlsx`, k = 2;
  while (existsSync(join(dir, name))) name = `Каталог_${stamp} (${k++}).xlsx`;
  writeFileSync(join(dir, name), catalogWorkbook(people));
  return { path: join(dir, name), people: people.length, tracks: people.reduce((a, p) => a + p.tracks.length, 0) };
}
