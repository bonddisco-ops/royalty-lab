// Доступ к каталогу для карточек: чтение с вычислением флагов, запись только через mutate().
import { formatDec, isWholeShare, parseDec, sumDec, DEC_ONE } from './domain/dec.ts';
import { cleanText, isIsrc, normIsrc, normKey } from './domain/normalize.ts';
import { checkPerson, completeness, maskValue, PII_FIELDS, type PersonCheck } from './domain/validate.ts';
import { insertRow, mutate, updateRow, deleteRow } from './db/mutate.ts';
import type { Ctx, Db, Row } from './db/types.ts';

const PII = new Set<string>(PII_FIELDS);

export const PERSON_EDITABLE = [
  'last_name', 'first_name', 'middle_name', 'birth_date', 'status', 'inn', 'ogrnip', 'snils', 'passport_series', 'passport_number',
  'passport_issued_by', 'passport_issued_date', 'passport_division_code', 'addr_region', 'addr_city', 'addr_street', 'addr_house',
  'addr_flat', 'addr_zip', 'addr_raw', 'bank_name', 'bank_bik', 'bank_corr_account', 'bank_account', 'email', 'phone', 'notes', 'custom_json',
] as const;

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v);

function friendly<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const m = (e as Error).message;
    if (/UNIQUE constraint failed: .*variant_norm|ux_variant/.test(m)) throw new Error('Такое написание имени уже закреплено за другим артистом');
    if (/ux_track_isrc/.test(m) || /UNIQUE constraint failed: track\.isrc/.test(m)) throw new Error('Трек с таким ISRC уже есть');
    throw e;
  }
}

// ------------------------------------------------------------------- люди

export interface PersonListItem {
  id: string;
  display: string;
  status: string;
  artists: string[];
  contracts: string[];
  filled: number;
  total: number;
  problems: number;
  photo: string | null;
}

export function personDisplay(r: Row): string {
  return [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ') || '(без имени)';
}

export function listPeople(db: Db, q = ''): PersonListItem[] {
  const needle = normKey(q);
  const cps = db.prepare('SELECT * FROM counterparty WHERE deleted_at IS NULL ORDER BY last_name, first_name').all();
  const artists = db.prepare('SELECT counterparty_id, name FROM artist WHERE deleted_at IS NULL AND counterparty_id IS NOT NULL ORDER BY name').all();
  const contracts = db.prepare('SELECT counterparty_id, number FROM contract WHERE deleted_at IS NULL ORDER BY number').all();
  const out: PersonListItem[] = [];
  for (const c of cps) {
    const a = artists.filter((x) => x.counterparty_id === c.id).map((x) => String(x.name));
    const k = contracts.filter((x) => x.counterparty_id === c.id).map((x) => String(x.number));
    if (needle && !normKey([personDisplay(c), ...a, ...k].join(' ')).includes(needle)) continue;
    const comp = completeness(c);
    out.push({ id: c.id, display: personDisplay(c), status: c.status, artists: a, contracts: k, filled: comp.filled, total: comp.total, problems: checkPerson(c).length, photo: c.photo_file ?? null });
  }
  return out;
}

export interface PersonDetail {
  id: string;
  fields: Row;
  masked: boolean;
  checks: PersonCheck[];
  completeness: { filled: number; total: number; missing: string[] };
  artists: Array<{ id: string; name: string }>;
  contracts: Array<{ id: string; number: string; date: string | null; kind: string; rate_default: string | null; threshold_rub: number | null; has_pdf: number }>;
}

export function getPerson(db: Db, id: string, reveal: boolean): PersonDetail {
  const c = db.prepare('SELECT * FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!c) throw new Error('Человек не найден');
  const fields: Row = {};
  for (const [k, v] of Object.entries(c)) fields[k] = !reveal && PII.has(k) && v ? maskValue(v) : v;
  return {
    id,
    fields,
    masked: !reveal,
    checks: checkPerson(c),
    completeness: completeness(c),
    artists: db.prepare('SELECT id, name FROM artist WHERE counterparty_id = ? AND deleted_at IS NULL ORDER BY name').all(id) as PersonDetail['artists'],
    contracts: db.prepare('SELECT id, number, date, kind, rate_default, threshold_rub, has_pdf FROM contract WHERE counterparty_id = ? AND deleted_at IS NULL ORDER BY number').all(id) as PersonDetail['contracts'],
  };
}

export function createPerson(db: Db, ctx: Ctx, data: Row): string {
  const row: Row = { status: 'unknown' };
  for (const k of PERSON_EDITABLE) if (k in data) row[k] = emptyToNull(data[k]);
  if (!row.last_name) throw new Error('Нужна хотя бы фамилия');
  const id = insertRow(db, ctx, 'counterparty', row);
  ensureNoContractIssue(db, ctx, id);
  return id;
}

/** Человек без договора подсвечивается в «Проверить» и в «Договорах». Когда договор появится, вопрос закроется сам (см. closeNoContractIssue). */
export function ensureNoContractIssue(db: Db, ctx: Ctx, personId: string): void {
  const has = db.prepare('SELECT 1 FROM contract WHERE counterparty_id = ? AND deleted_at IS NULL').get(personId);
  const open = db.prepare("SELECT 1 FROM issue WHERE kind = 'no_contract' AND entity_type = 'counterparty' AND entity_id = ? AND status = 'open' AND deleted_at IS NULL").get(personId);
  if (!has && !open) insertRow(db, ctx, 'issue', { kind: 'no_contract', entity_type: 'counterparty', entity_id: personId, details_json: { note: 'У человека нет договора' }, status: 'open' });
}

export function closeNoContractIssue(db: Db, ctx: Ctx, personId: string): void {
  for (const i of db.prepare("SELECT id FROM issue WHERE kind = 'no_contract' AND entity_type = 'counterparty' AND entity_id = ? AND status = 'open' AND deleted_at IS NULL").all(personId)) {
    updateRow(db, ctx, 'issue', i.id, { status: 'resolved', resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_json: { auto: 'договор создан' } });
  }
}

/** «+ артист» в карточке человека: привязать существующего (ошибка, если он уже за другим человеком) или завести нового. */
export function addArtistToPerson(db: Db, ctx: Ctx, personId: string, d: { artistId?: string; name?: string }): string {
  return db.transaction(() => {
    if (d.artistId) {
      const a = db.prepare('SELECT a.id, a.name, a.counterparty_id, c.last_name, c.first_name, c.middle_name FROM artist a LEFT JOIN counterparty c ON c.id = a.counterparty_id WHERE a.id = ? AND a.deleted_at IS NULL').get(d.artistId);
      if (!a) throw new Error('Артист не найден');
      if (a.counterparty_id && a.counterparty_id !== personId) throw new Error(`Артист «${a.name}» уже закреплён за другим человеком: ${personDisplay(a)}. Сначала открепите его там.`);
      updateArtist(db, ctx, a.id, { counterparty_id: personId });
      return a.id;
    }
    const name = cleanText(d.name ?? '');
    if (!name) throw new Error('Выберите артиста или введите новое имя');
    const same = db.prepare('SELECT a.id, a.name, a.counterparty_id FROM artist a JOIN artist_name_variant v ON v.artist_id = a.id AND v.deleted_at IS NULL WHERE a.deleted_at IS NULL AND v.variant_norm = ?').get(normKey(name));
    if (same) return addArtistToPerson(db, ctx, personId, { artistId: same.id });
    return createArtist(db, ctx, { name, counterparty_id: personId });
  })();
}

const countOf = (db: Db, sql: string, ...args: unknown[]): number => Number(db.prepare(sql).get(...args)!.n);

/** Артиста можно удалить, пока на нём нет треков: иначе пропадут доли и начисления. Написания и открытые вопросы по нему удаляются вместе с ним. */
export function deleteArtist(db: Db, ctx: Ctx, id: string): void {
  db.transaction(() => {
    const a = db.prepare('SELECT name FROM artist WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!a) throw new Error('Артист не найден');
    const n = countOf(db, 'SELECT count(*) n FROM participation p JOIN track t ON t.id = p.track_id AND t.deleted_at IS NULL WHERE p.artist_id = ? AND p.deleted_at IS NULL', id);
    if (n > 0) throw new Error(`У артиста «${a.name}» есть треки (${n}). Сначала уберите его из треков в разделе «Треки» или добавьте его имя как другое написание к настоящему артисту.`);
    for (const v of db.prepare('SELECT id FROM artist_name_variant WHERE artist_id = ? AND deleted_at IS NULL').all(id)) deleteRow(db, ctx, 'artist_name_variant', v.id);
    for (const i of db.prepare("SELECT id FROM issue WHERE entity_type = 'artist' AND entity_id = ? AND status = 'open' AND deleted_at IS NULL").all(id)) deleteRow(db, ctx, 'issue', i.id);
    deleteRow(db, ctx, 'artist', id);
  })();
}

/** Человека можно удалить, если за ним нет договоров, артистов, расчётов выплат и входящих остатков. */
export function deletePerson(db: Db, ctx: Ctx, id: string): void {
  db.transaction(() => {
    const p = db.prepare('SELECT last_name, first_name, middle_name FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!p) throw new Error('Человек не найден');
    const who = personDisplay(p);
    const arts = db.prepare('SELECT name FROM artist WHERE counterparty_id = ? AND deleted_at IS NULL ORDER BY name').all(id).map((r) => r.name);
    if (arts.length) throw new Error(`За «${who}» закреплены артисты: ${arts.join(', ')}. Сначала открепите их в разделе «Артисты».`);
    if (countOf(db, 'SELECT count(*) n FROM contract WHERE counterparty_id = ? AND deleted_at IS NULL', id)) throw new Error(`У «${who}» есть договор. Сначала удалите договор в разделе «Договоры».`);
    if (countOf(db, 'SELECT count(*) n FROM participation WHERE payee_counterparty_id = ? AND deleted_at IS NULL', id)) throw new Error(`«${who}» указан получателем выплаты в треках. Сначала смените получателя в «Треках».`);
    if (countOf(db, 'SELECT count(*) n FROM payout_period WHERE counterparty_id = ? AND deleted_at IS NULL', id)) throw new Error(`По «${who}» уже есть расчёты выплат, удалять такого человека нельзя.`);
    if (countOf(db, 'SELECT count(*) n FROM opening_balance WHERE counterparty_id = ? AND deleted_at IS NULL', id)) throw new Error(`По «${who}» есть входящий остаток. Сначала удалите его в «Выплатах».`);
    for (const i of db.prepare("SELECT id FROM issue WHERE entity_type = 'counterparty' AND entity_id = ? AND status = 'open' AND deleted_at IS NULL").all(id)) deleteRow(db, ctx, 'issue', i.id);
    deleteRow(db, ctx, 'counterparty', id);
  })();
}

export function updatePerson(db: Db, ctx: Ctx, id: string, patch: Row): void {
  const clean: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(PERSON_EDITABLE as readonly string[]).includes(k)) throw new Error(`Поле «${k}» менять нельзя`);
    clean[k] = emptyToNull(v);
  }
  if ('status' in clean && !['ip', 'sz', 'fl', 'unknown'].includes(String(clean.status))) throw new Error('Статус: ип / сз / фл / неизвестно');
  updateRow(db, ctx, 'counterparty', id, clean);
}

// ----------------------------------------------------------------- артисты

export interface ArtistListItem {
  id: string;
  name: string;
  counterpartyId: string | null;
  person: string | null;
  variants: string[];
  tracks: number;
  withoutContract: boolean;
  /** Своё фото артиста, а если нет — фото человека (иначе null = заглушка). */
  photo: string | null;
}

export function listArtists(db: Db, q = ''): ArtistListItem[] {
  const needle = normKey(q);
  const arts = db.prepare('SELECT a.id, a.name, a.counterparty_id, a.photo_file AS own_photo, c.photo_file AS person_photo, c.last_name, c.first_name, c.middle_name FROM artist a LEFT JOIN counterparty c ON c.id = a.counterparty_id AND c.deleted_at IS NULL WHERE a.deleted_at IS NULL ORDER BY a.name').all();
  const variants = db.prepare('SELECT artist_id, variant_norm FROM artist_name_variant WHERE deleted_at IS NULL').all();
  const counts = new Map(db.prepare('SELECT artist_id, count(DISTINCT track_id) AS n FROM participation WHERE deleted_at IS NULL GROUP BY artist_id').all().map((r) => [r.artist_id as string, Number(r.n)]));
  const withContract = new Set(db.prepare('SELECT DISTINCT counterparty_id FROM contract WHERE deleted_at IS NULL').all().map((r) => r.counterparty_id as string));
  const out: ArtistListItem[] = [];
  for (const a of arts) {
    const person = a.counterparty_id ? personDisplay(a) : null;
    if (needle && !normKey(`${a.name} ${person ?? ''}`).includes(needle)) continue;
    out.push({
      id: a.id, name: a.name, counterpartyId: a.counterparty_id, person,
      variants: variants.filter((v) => v.artist_id === a.id).map((v) => String(v.variant_norm)),
      tracks: counts.get(a.id) ?? 0,
      withoutContract: !a.counterparty_id || !withContract.has(a.counterparty_id),
      photo: a.own_photo ?? a.person_photo ?? null,
    });
  }
  return out;
}

export function createArtist(db: Db, ctx: Ctx, data: { name: string; counterparty_id?: string | null; notes?: string | null }): string {
  const name = cleanText(data.name);
  if (!name) throw new Error('Нужно имя артиста');
  return friendly(() => {
    let id = '';
    db.transaction(() => {
      id = insertRow(db, ctx, 'artist', { name, counterparty_id: data.counterparty_id ?? null, notes: data.notes ?? null });
      insertRow(db, ctx, 'artist_name_variant', { artist_id: id, variant_norm: normKey(name) });
    })();
    return id;
  });
}

export function updateArtist(db: Db, ctx: Ctx, id: string, patch: { name?: string; counterparty_id?: string | null; notes?: string | null }): void {
  friendly(() => {
    db.transaction(() => {
      const p: Row = {};
      if (patch.name !== undefined) {
        const name = cleanText(patch.name);
        if (!name) throw new Error('Имя не может быть пустым');
        p.name = name;
        const n = normKey(name);
        if (!db.prepare('SELECT 1 FROM artist_name_variant WHERE artist_id = ? AND variant_norm = ? AND deleted_at IS NULL').get(id, n)) {
          insertRow(db, ctx, 'artist_name_variant', { artist_id: id, variant_norm: n });
        }
      }
      if (patch.counterparty_id !== undefined) p.counterparty_id = patch.counterparty_id || null;
      if (patch.notes !== undefined) p.notes = emptyToNull(patch.notes);
      updateRow(db, ctx, 'artist', id, p);
    })();
  });
}

/** Ещё одно написание того же артиста (для сопоставления при импорте отчётов). */
export function addArtistVariant(db: Db, ctx: Ctx, artistId: string, text: string): void {
  const n = normKey(text);
  if (!n) throw new Error('Пустое написание');
  friendly(() => insertRow(db, ctx, 'artist_name_variant', { artist_id: artistId, variant_norm: n }));
}

// ------------------------------------------------------------------- треки

export interface ParticipantView {
  id: string;
  artistId: string;
  artist: string;
  shareAuthors: string;
  shareRelated: string;
  labelRate: string | null;
  payeeCounterpartyId: string | null;
  payee: string | null;
  contract: string | null;
  contractId: string | null;
  appendixId: string | null;
  appendixNo: number | null;
  notes: string | null;
  duplicate: boolean;
  /** Кто реально получает деньги: явный получатель или человек, к которому привязан артист. */
  personId: string | null;
  person: string | null;
}

export interface TrackPerson { personId: string | null; name: string; artists: string[]; shareAuthors: string; shareRelated: string }

export interface TrackView {
  id: string;
  title: string;
  isrc: string | null;
  cover: string | null;
  codes: string[];
  participants: ParticipantView[];
  /** Доли по людям: несколько артистов одного человека сложены вместе. */
  people: TrackPerson[];
  sumAuthors: string;
  sumRelated: string;
  shareSumBad: boolean;
  hasDuplicates: boolean;
}

export function listTracks(db: Db, q = '', onlyProblems = false): TrackView[] {
  const needle = normKey(q);
  const tracks = db.prepare('SELECT id, title, isrc, cover_file FROM track WHERE deleted_at IS NULL ORDER BY title').all();
  const codes = db.prepare("SELECT track_id, value_norm FROM track_identifier WHERE kind = 'distributor_code' AND deleted_at IS NULL").all();
  const parts = db.prepare(
    `SELECT p.*, a.name AS artist_name, c.number AS contract_number, ap.number AS appendix_number, pc.last_name AS payee_last, pc.first_name AS payee_first
       FROM participation p
       JOIN artist a ON a.id = p.artist_id
       LEFT JOIN contract c ON c.id = p.contract_id
       LEFT JOIN appendix ap ON ap.id = p.appendix_id AND ap.deleted_at IS NULL
       LEFT JOIN counterparty pc ON pc.id = p.payee_counterparty_id
      WHERE p.deleted_at IS NULL ORDER BY a.name`,
  ).all();
  const persons = new Map<string, string>();
  for (const c of db.prepare('SELECT id, last_name, first_name, middle_name FROM counterparty WHERE deleted_at IS NULL').all()) persons.set(c.id, personDisplay(c));
  const artistPerson = new Map<string, string | null>();
  for (const a of db.prepare('SELECT id, counterparty_id FROM artist WHERE deleted_at IS NULL').all()) artistPerson.set(a.id, a.counterparty_id ?? null);
  const out: TrackView[] = [];
  for (const t of tracks) {
    const ps = parts.filter((p) => p.track_id === t.id);
    const tc = codes.filter((c) => c.track_id === t.id).map((c) => String(c.value_norm));
    if (needle && !normKey([t.title, t.isrc ?? '', ...tc, ...ps.map((p) => p.artist_name)].join(' ')).includes(needle)) continue;
    const seen = new Map<string, number>();
    for (const p of ps) {
      const key = `${p.artist_id}|${p.payee_counterparty_id ?? ''}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const sa = sumDec(ps.map((p) => p.share_authors));
    const sr = sumDec(ps.map((p) => p.share_related));
    const view: TrackView = {
      id: t.id, title: t.title, isrc: t.isrc, cover: t.cover_file ?? null, codes: tc,
      participants: ps.map((p) => ({
        id: p.id, artistId: p.artist_id, artist: p.artist_name, shareAuthors: p.share_authors, shareRelated: p.share_related,
        labelRate: p.label_rate, payeeCounterpartyId: p.payee_counterparty_id,
        payee: p.payee_counterparty_id ? [p.payee_last, p.payee_first].filter(Boolean).join(' ') : null,
        contract: p.contract_number, contractId: p.contract_id, appendixId: p.appendix_id, appendixNo: p.appendix_number === null || p.appendix_number === undefined ? null : Number(p.appendix_number), notes: p.notes,
        duplicate: (seen.get(`${p.artist_id}|${p.payee_counterparty_id ?? ''}`) ?? 0) > 1,
        personId: p.payee_counterparty_id ?? artistPerson.get(p.artist_id) ?? null,
        person: ((): string | null => { const pid = p.payee_counterparty_id ?? artistPerson.get(p.artist_id) ?? null; return pid ? persons.get(pid) ?? null : null; })(),
      })),
      people: ((): TrackPerson[] => {
        const g = new Map<string, { personId: string | null; artists: string[]; sa: string[]; sr: string[] }>();
        for (const p of ps) {
          const pid: string | null = p.payee_counterparty_id ?? artistPerson.get(p.artist_id) ?? null;
          const k = pid ?? `a:${p.artist_id}`;
          const e = g.get(k) ?? { personId: pid, artists: [], sa: [], sr: [] };
          if (!e.artists.includes(p.artist_name)) e.artists.push(p.artist_name);
          e.sa.push(p.share_authors); e.sr.push(p.share_related);
          g.set(k, e);
        }
        return [...g.values()].map((e) => ({ personId: e.personId, name: e.personId ? persons.get(e.personId) ?? '' : '', artists: e.artists, shareAuthors: formatDec(sumDec(e.sa)), shareRelated: formatDec(sumDec(e.sr)) }));
      })(),
      sumAuthors: formatDec(sa), sumRelated: formatDec(sr),
      shareSumBad: ps.length > 0 && (!isWholeShare(sa) || !isWholeShare(sr)),
      hasDuplicates: [...seen.values()].some((n) => n > 1),
    };
    if (onlyProblems && !view.shareSumBad && !view.hasDuplicates) continue;
    out.push(view);
  }
  return out;
}

export function createTrack(db: Db, ctx: Ctx, data: { title: string; isrc?: string | null; version?: string | null }): string {
  const title = cleanText(data.title);
  if (!title) throw new Error('Нужно название трека');
  const isrc = data.isrc ? normIsrc(data.isrc) : null;
  return friendly(() => {
    let id = '';
    db.transaction(() => {
      id = insertRow(db, ctx, 'track', { title, isrc, version: data.version ?? null });
      if (isrc) insertRow(db, ctx, 'track_identifier', { track_id: id, kind: 'isrc', value_norm: isrc });
    })();
    return id;
  });
}

export interface QuickTrackInput { title: string; artistName: string; isrc?: string | null; shareAuthors?: string | null; shareRelated?: string | null; labelRate?: string | null }
export interface QuickTrackResult { trackId: string; artistId: string; artistCreated: boolean; personId: string | null; person: string | null }

/**
 * Быстрое внесение трека, по которому ещё не было отчётов: название + имя артиста.
 * Артист находится по имени (с учётом вариантов написания); если его нет — создаётся новый без человека, привязать нужно позже.
 * Доли по умолчанию 100% / 100% на этого артиста, ставку можно не указывать.
 */
export function quickAddTrack(db: Db, ctx: Ctx, d: QuickTrackInput): QuickTrackResult {
  const title = cleanText(d.title);
  const artistName = cleanText(d.artistName);
  if (!title) throw new Error('Нужно название трека');
  if (!artistName) throw new Error('Нужно имя артиста');
  return friendly(() => db.transaction(() => {
    const found = db.prepare('SELECT a.id, a.counterparty_id FROM artist a JOIN artist_name_variant v ON v.artist_id = a.id AND v.deleted_at IS NULL WHERE a.deleted_at IS NULL AND v.variant_norm = ?').get(normKey(artistName));
    const artistId: string = found ? found.id : createArtist(db, ctx, { name: artistName });
    const personId: string | null = found?.counterparty_id ?? null;
    const dup = db.prepare('SELECT t.id FROM track t JOIN participation p ON p.track_id = t.id AND p.deleted_at IS NULL WHERE t.deleted_at IS NULL AND p.artist_id = ?').all(artistId)
      .some((r) => normKey(String(db.prepare('SELECT title FROM track WHERE id = ?').get(r.id)?.title ?? '')) === normKey(title));
    if (dup) throw new Error(`У артиста «${artistName}» уже есть трек «${title}»`);
    const trackId = createTrack(db, ctx, { title, isrc: d.isrc ?? null });
    addParticipation(db, ctx, { trackId, artistId, shareAuthors: d.shareAuthors || '1', shareRelated: d.shareRelated || '1', labelRate: d.labelRate || null });
    const person = personId ? db.prepare('SELECT last_name, first_name, middle_name FROM counterparty WHERE id = ?').get(personId) : null;
    return { trackId, artistId, artistCreated: !found, personId, person: person ? personDisplay(person) : null };
  })());
}

/** Возвращает, сколько строк отчётов без трека подхватилось по новому ISRC. */
export function updateTrack(db: Db, ctx: Ctx, id: string, patch: { title?: string; isrc?: string | null; version?: string | null; notes?: string | null }): number {
  return friendly(() => db.transaction(() => {
    const p: Row = {};
    let relinked = 0;
    if (patch.title !== undefined) {
      p.title = cleanText(patch.title);
      if (!p.title) throw new Error('Название не может быть пустым');
    }
    if (patch.version !== undefined) p.version = emptyToNull(patch.version);
    if (patch.notes !== undefined) p.notes = emptyToNull(patch.notes);
    if (patch.isrc !== undefined) {
      const cur = db.prepare('SELECT isrc FROM track WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!cur) throw new Error('Трек не найден');
      const isrc = patch.isrc ? normIsrc(patch.isrc) : null;
      if (isrc && !isIsrc(isrc)) throw new Error('ISRC должен быть вида RUA1D2588339 (2 буквы страны, 3 символа владельца, 2 цифры года, 5 цифр)');
      if (isrc !== (cur.isrc ?? null)) {
        if (isrc) {
          const other = db.prepare(
            `SELECT t.title FROM track t WHERE t.deleted_at IS NULL AND t.id <> ? AND (t.isrc = ? OR EXISTS (SELECT 1 FROM track_identifier i WHERE i.track_id = t.id AND i.kind = 'isrc' AND i.value_norm = ? AND i.deleted_at IS NULL))`,
          ).get(id, isrc, isrc);
          if (other) throw new Error(`Этот ISRC уже закреплён за треком «${other.title}»`);
        }
        // старый ISRC остаётся в «кодах» трека: прошлые отчёты и повторная загрузка старых файлов по-прежнему узнают этот трек
        const hasIdent = (v: string): boolean => !!db.prepare("SELECT 1 FROM track_identifier WHERE track_id = ? AND kind = 'isrc' AND value_norm = ? AND deleted_at IS NULL").get(id, v);
        if (cur.isrc && !hasIdent(cur.isrc)) insertRow(db, ctx, 'track_identifier', { track_id: id, kind: 'isrc', value_norm: cur.isrc });
        p.isrc = isrc;
        if (isrc) {
          if (!hasIdent(isrc)) insertRow(db, ctx, 'track_identifier', { track_id: id, kind: 'isrc', value_norm: isrc });
          // строки отчётов с новым ISRC, которые раньше не нашли трек, привязываем сейчас
          const upd = db.prepare('UPDATE statement_line SET track_id = ? WHERE id = ?');
          for (const l of db.prepare("SELECT l.id, l.isrc_raw FROM statement_line l JOIN report_version v ON v.id = l.report_version_id WHERE l.track_id IS NULL AND v.status = 'active' AND v.deleted_at IS NULL AND l.isrc_raw IS NOT NULL").all()) {
            if (normIsrc(l.isrc_raw) === isrc) { upd.run(id, l.id); relinked++; }
          }
        }
      }
    }
    updateRow(db, ctx, 'track', id, p);
    return relinked;
  })());
}

// ----------------------------------------------------------------- участия

function checkShare(label: string, v: unknown, allowNull = false): string | null {
  if (v === null || v === undefined || v === '') {
    if (allowNull) return null;
    throw new Error(`${label}: нужно число от 0 до 1`);
  }
  const d = parseDec(v);
  if (d === null || d < 0n || d > DEC_ONE) throw new Error(`${label}: нужно число от 0 до 1`);
  return formatDec(d);
}

export interface ParticipationInput {
  trackId: string;
  artistId: string;
  shareAuthors: string;
  shareRelated: string;
  labelRate: string | null;
  payeeCounterpartyId?: string | null;
}

export function addParticipation(db: Db, ctx: Ctx, d: ParticipationInput): string {
  // если у человека ровно один договор — привязываем участие к нему сразу, чтобы трек попал в очередь «ждут внесения в приложение»
  const pid: string | null = d.payeeCounterpartyId ?? db.prepare('SELECT counterparty_id FROM artist WHERE id = ?').get(d.artistId)?.counterparty_id ?? null;
  const own = pid ? db.prepare('SELECT id FROM contract WHERE counterparty_id = ? AND deleted_at IS NULL').all(pid) : [];
  return insertRow(db, ctx, 'participation', {
    contract_id: own.length === 1 ? own[0]!.id : null,
    track_id: d.trackId, artist_id: d.artistId,
    share_authors: checkShare('Авторские', d.shareAuthors)!, share_related: checkShare('Смежные', d.shareRelated)!,
    label_rate: checkShare('Ставка лейбла', d.labelRate, true), payee_counterparty_id: d.payeeCounterpartyId ?? null,
  });
}

const PART_FIELDS = ['share_authors', 'share_related', 'label_rate', 'payee_counterparty_id', 'contract_id', 'appendix_id', 'term_from', 'term_to', 'valid_from_quarter', 'valid_to_quarter', 'notes'] as const;

export function updateParticipation(db: Db, ctx: Ctx, id: string, patch: Row): void {
  const clean: Row = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(PART_FIELDS as readonly string[]).includes(k)) throw new Error(`Поле «${k}» менять нельзя`);
    if (k === 'share_authors' || k === 'share_related') clean[k] = checkShare(k === 'share_authors' ? 'Авторские' : 'Смежные', v);
    else if (k === 'label_rate') clean[k] = checkShare('Ставка лейбла', v, true);
    else clean[k] = emptyToNull(v);
  }
  updateRow(db, ctx, 'participation', id, clean);
}

export function removeParticipation(db: Db, ctx: Ctx, id: string): void {
  deleteRow(db, ctx, 'participation', id);
}

/** Кнопка «Исправить»: остаток до 100% дописывается выбранному участнику (по каждой колонке отдельно). */
export function fixShares(db: Db, ctx: Ctx, trackId: string, participationId: string): void {
  db.transaction(() => {
    const ps = db.prepare('SELECT id, share_authors, share_related FROM participation WHERE track_id = ? AND deleted_at IS NULL').all(trackId);
    const target = ps.find((p) => p.id === participationId);
    if (!target) throw new Error('Участник не найден в этом треке');
    const patch: Row = {};
    for (const col of ['share_authors', 'share_related'] as const) {
      const sum = sumDec(ps.map((p) => p[col]));
      const next = (parseDec(target[col]) ?? 0n) + (DEC_ONE - sum);
      if (next < 0n) throw new Error('Остаток отрицательный: сначала уменьшите доли других участников');
      patch[col] = formatDec(next);
    }
    updateRow(db, ctx, 'participation', participationId, patch);
  })();
}

// ---------------------------------------------------------- «Проверить»

export interface IssueView {
  id: string;
  kind: string;
  status: string;
  entityType: string | null;
  entityId: string | null;
  label: string;
  details: Row;
  reportVersionId: string | null;
}

/**
 * Автопроверка открытых вопросов: если причина уже устранена (заполнили поле, создали договор, привязали артиста, поправили доли),
 * вопрос закрывается сам. Вызывается при открытии «Проверить» и при подсчёте красных значков.
 */
export function revalidateIssues(db: Db, ctx: Ctx): number {
  const open = db.prepare("SELECT * FROM issue WHERE deleted_at IS NULL AND status = 'open'").all();
  if (open.length === 0) return 0;
  const FIELD_COL: Record<string, string> = { 'дата рождения': 'birth_date', 'паспорт': 'passport_number', 'адрес': 'addr_raw', 'ИНН': 'inn', 'р/с': 'bank_account', 'БИК': 'bank_bik' };
  const hasLine = db.prepare("SELECT 1 FROM statement_line l JOIN report_version v ON v.id = l.report_version_id WHERE l.track_id IS NULL AND v.status = 'active' AND v.deleted_at IS NULL AND l.report_version_id = ? AND (CASE WHEN ? <> '' THEN l.isrc_raw = ? WHEN ? <> '' THEN ifnull(l.code_raw, '') = ? ELSE 1 END) LIMIT 1");
  let closed = 0;
  const close = (id: string, why: string): void => {
    updateRow(db, ctx, 'issue', id, { status: 'resolved', resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_json: { auto: why } });
    closed++;
  };
  db.transaction(() => {
    for (const i of open) {
      const d: Row = i.details_json ? (typeof i.details_json === 'string' ? JSON.parse(i.details_json) : i.details_json) : {};
      switch (i.kind) {
        case 'missing_pii': {
          const c = i.entity_id ? db.prepare('SELECT * FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(i.entity_id) : undefined;
          if (i.entity_id && !c) { close(i.id, 'человека больше нет'); break; }
          const col = d.field === 'status' ? 'status' : FIELD_COL[String(d.field)] ?? (typeof d.field === 'string' && /^[a-z_]+$/.test(d.field) ? d.field : null);
          if (c && col && col in c) {
            const v = c[col];
            if (col === 'status' ? v && v !== 'unknown' : v !== null && v !== undefined && String(v).trim() !== '') close(i.id, 'поле заполнено');
          }
          break;
        }
        case 'no_contract': {
          if (i.entity_type !== 'counterparty' || !i.entity_id) break;
          const alive = db.prepare('SELECT 1 FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(i.entity_id);
          const has = db.prepare('SELECT 1 FROM contract WHERE counterparty_id = ? AND deleted_at IS NULL').get(i.entity_id);
          if (!alive || has) close(i.id, 'договор есть');
          break;
        }
        case 'unknown_artist': {
          const n = normKey(String(d.artist ?? ''));
          if (n && db.prepare('SELECT 1 FROM artist_name_variant v JOIN artist a ON a.id = v.artist_id WHERE v.variant_norm = ? AND v.deleted_at IS NULL AND a.deleted_at IS NULL').get(n)) close(i.id, 'артист заведён');
          break;
        }
        case 'unmatched_track': {
          if (!i.report_version_id) break;
          const isrc = String(d.isrc ?? ''), code = isrc ? '' : String(d.code ?? '');
          if (!isrc && !code) break; // без кода сопоставление по названию — только вручную
          if (!hasLine.get(i.report_version_id, isrc, isrc, code, code)) close(i.id, 'все строки привязаны к трекам');
          break;
        }
        case 'new_track': {
          if (!i.entity_id) break;
          const t = db.prepare('SELECT 1 FROM track WHERE id = ? AND deleted_at IS NULL').get(i.entity_id);
          if (!t) { close(i.id, 'трека больше нет'); break; }
          const ps = db.prepare('SELECT share_authors, share_related, label_rate FROM participation WHERE track_id = ? AND deleted_at IS NULL').all(i.entity_id);
          if (ps.length > 0 && ps.every((p) => p.label_rate !== null && p.label_rate !== '') && isWholeShare(sumDec(ps.map((p) => p.share_authors))) && isWholeShare(sumDec(ps.map((p) => p.share_related)))) close(i.id, 'доли и ставки заполнены');
          break;
        }
        default: break;
      }
    }
  })();
  return closed;
}

export function listIssues(db: Db, status: 'open' | 'resolved' | 'ignored' = 'open', kind?: string, reportVersionId?: string): IssueView[] {
  const rows = db.prepare(`SELECT * FROM issue WHERE deleted_at IS NULL AND status = ? ${kind ? 'AND kind = ?' : ''} ${reportVersionId ? 'AND report_version_id = ?' : ''} ORDER BY kind, created_at`).all(...[status, ...(kind ? [kind] : []), ...(reportVersionId ? [reportVersionId] : [])]);
  return rows.map((r) => {
    const details = r.details_json ? (JSON.parse(r.details_json) as Row) : {};
    return { id: r.id, kind: r.kind, status: r.status, entityType: r.entity_type, entityId: r.entity_id, label: issueLabel(db, r, details), details, reportVersionId: r.report_version_id ?? null };
  });
}

function issueLabel(db: Db, r: Row, d: Row): string {
  const get = (sql: string, id: string | null): Row | undefined => (id ? db.prepare(sql).get(id) : undefined);
  switch (r.entity_type) {
    case 'track': return get('SELECT title FROM track WHERE id = ?', r.entity_id)?.title ?? d.title ?? d.subject ?? '';
    case 'artist': return get('SELECT name FROM artist WHERE id = ?', r.entity_id)?.name ?? d.who ?? '';
    case 'contract': return get('SELECT number FROM contract WHERE id = ?', r.entity_id)?.number ?? d.subject ?? '';
    case 'counterparty': { const c = get('SELECT * FROM counterparty WHERE id = ?', r.entity_id); return c ? personDisplay(c) : d.who ?? ''; }
    case 'participation': return `${d.artist ?? ''} — ${d.track ?? ''}`;
    case 'report_version': {
      const v = get(`SELECT d.name AS dn, r.quarter, r.rights_scope FROM report_version v JOIN report r ON r.id = v.report_id JOIN distributor d ON d.id = r.distributor_id WHERE v.id = ?`, r.entity_id);
      const scope = v?.rights_scope === 'authors' ? 'авторские' : v?.rights_scope === 'related' ? 'смежные' : 'авт.+смеж.';
      return v ? `${v.dn} ${v.quarter} (${scope})` : '';
    }
    default: return d.who ?? '';
  }
}

export function resolveIssue(db: Db, ctx: Ctx, id: string, status: 'resolved' | 'ignored' | 'open', note?: string): void {
  updateRow(db, ctx, 'issue', id, {
    status,
    resolution_json: note ? JSON.stringify({ note }) : null,
    resolved_by: status === 'open' ? null : ctx.userId,
    resolved_at: status === 'open' ? null : new Date().toISOString(),
  });
}

// --------------------------------------------------------- история и сводка

export function history(db: Db, table: string, rowId: string): Row[] {
  return db.prepare('SELECT ts, user_id, op, field, old_value, new_value FROM change_log WHERE table_name = ? AND row_id = ? ORDER BY seq DESC LIMIT 200').all(table, rowId);
}

export interface Dashboard {
  people: number;
  artists: number;
  artistsWithoutPerson: number;
  tracks: number;
  participations: number;
  contracts: number;
  openIssues: Record<string, number>;
}

export function dashboard(db: Db): Dashboard {
  const n = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  const issues: Record<string, number> = {};
  for (const r of db.prepare("SELECT kind, count(*) AS n FROM issue WHERE deleted_at IS NULL AND status = 'open' GROUP BY kind").all()) issues[r.kind] = Number(r.n);
  return {
    people: n('SELECT count(*) AS n FROM counterparty WHERE deleted_at IS NULL'),
    artists: n('SELECT count(*) AS n FROM artist WHERE deleted_at IS NULL'),
    artistsWithoutPerson: n('SELECT count(*) AS n FROM artist WHERE deleted_at IS NULL AND counterparty_id IS NULL'),
    tracks: n('SELECT count(*) AS n FROM track WHERE deleted_at IS NULL'),
    participations: n('SELECT count(*) AS n FROM participation WHERE deleted_at IS NULL'),
    contracts: n('SELECT count(*) AS n FROM contract WHERE deleted_at IS NULL'),
    openIssues: issues,
  };
}

export function getSettings(db: Db): Record<string, string> {
  return Object.fromEntries(db.prepare('SELECT id, value FROM settings WHERE deleted_at IS NULL').all().map((r) => [r.id as string, r.value as string]));
}

export function setSetting(db: Db, ctx: Ctx, id: string, value: string): void {
  if (!db.prepare('SELECT 1 FROM settings WHERE id = ?').get(id)) throw new Error(`Неизвестная настройка «${id}»`);
  if (id === 'hidden_deduction' && (parseDec(value) === null || parseDec(value)! < 0n || parseDec(value)! >= DEC_ONE)) throw new Error('Скрытый вычет: число от 0 до 1');
  if (id === 'auto_lock_minutes' && !/^\d+$/.test(value)) throw new Error('Автоблокировка: целое число минут (0 = выключена)');
  mutate(db, ctx, [{ kind: 'update', table: 'settings', id, patch: { value } }]);
}

// ------------------------------------------------------------ поиск трека (привязка из «Проверить»)

export interface TrackHit {
  id: string;
  title: string;
  isrc: string | null;
  artists: string[];
}

export function searchTracks(db: Db, q: string, limit = 30): TrackHit[] {
  const needle = normKey(q);
  if (!needle) return [];
  const hits: TrackHit[] = [];
  const tracks = db.prepare('SELECT id, title, isrc FROM track WHERE deleted_at IS NULL ORDER BY title').all();
  const arts = db.prepare('SELECT p.track_id, a.name FROM participation p JOIN artist a ON a.id = p.artist_id WHERE p.deleted_at IS NULL').all();
  const byTrack = new Map<string, string[]>();
  for (const a of arts) byTrack.set(a.track_id, [...(byTrack.get(a.track_id) ?? []), a.name]);
  for (const t of tracks) {
    const names = byTrack.get(t.id) ?? [];
    if (normKey([t.title, t.isrc ?? '', ...names].join(' ')).includes(needle)) {
      hits.push({ id: t.id, title: t.title, isrc: t.isrc, artists: names });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}
