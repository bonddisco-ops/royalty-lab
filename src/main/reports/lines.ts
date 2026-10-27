// Таблица строк: эффективные строки по отчётам квартала, фильтры, сортировка, страницы.
import type { Db } from '../db/types.ts';
import { effectivePieces, rateToRubString, type BaseLine, type EditRec, type EffPiece, type SplitRec } from './effective.ts';
import type { StreamKind } from './types.ts';

export interface LineRow {
  key: string;
  lineId: string;
  splitId: string | null;
  versionId: string;
  reportId: string;
  distributor: string;
  quarter: string;
  rights: string;
  upc: string | null;
  isrc: string | null;
  code: string | null;
  artist: string | null;
  title: string | null;
  platform: string | null;
  usage: string | null;
  model: string | null;
  country: string | null;
  month: string | null;
  qty: number;
  royaltyKop: number;
  rate: string | null;
  streamKind: StreamKind;
  trackId: string | null;
  trackTitle: string | null;
  origQty: number;
  origRoyaltyKop: number;
  origRate: string | null;
  origStreamKind: StreamKind;
  origUsage: string | null;
  changed: string[];
  hasSplit: boolean;
  /** Сколько действующих переносов у исходной строки. */
  splitCount: number;
  /** Кто и когда последним правил строку (для подсказки). */
  lastEditBy: string | null;
  lastEditAt: string | null;
}

export interface LineFilter {
  quarter?: string;
  reportIds?: string[];
  q?: string;
  distributor?: string[];
  rights?: string[];
  platform?: string[];
  usage?: string[];
  model?: string[];
  country?: string[];
  month?: string[];
  streamKind?: string[];
  edited?: boolean;
  unmatched?: boolean;
}

export type SortKey = 'distributor' | 'artist' | 'title' | 'platform' | 'usage' | 'country' | 'month' | 'qty' | 'royalty' | 'rate' | 'streamKind';
export interface LineSort { key: SortKey; dir: 'asc' | 'desc' }

export interface LinePage {
  rows: LineRow[];
  total: number;
  totals: { qty: number; royaltyKop: number; origRoyaltyKop: number; edited: number };
}

export interface LineSrc { base: BaseLine; edits: EditRec[]; splits: SplitRec[]; pieces: EffPiece[] }
interface VersionCache { rows: LineRow[]; src: Map<string, LineSrc> }
const cache = new WeakMap<Db, Map<string, VersionCache>>();
export function invalidateLines(db: Db, versionId?: string): void {
  const m = cache.get(db);
  if (!m) return;
  if (versionId) m.delete(versionId);
  else m.clear();
}

function loadVersionFull(db: Db, versionId: string): VersionCache {
  let m = cache.get(db);
  if (!m) cache.set(db, (m = new Map()));
  const hit = m.get(versionId);
  if (hit) return hit;
  const empty: VersionCache = { rows: [], src: new Map() };

  const head = db.prepare(
    `SELECT v.id AS version_id, r.id AS report_id, r.quarter, d.name AS distributor
       FROM report_version v JOIN report r ON r.id = v.report_id JOIN distributor d ON d.id = r.distributor_id WHERE v.id = ?`,
  ).get(versionId);
  if (!head) return empty;
  const edits = new Map<string, EditRec[]>();
  const last = new Map<string, { by: string | null; at: string }>();
  for (const e of db.prepare(
    `SELECT e.id, e.line_id, e.field, e.new_value, e.updated_by, e.created_at FROM line_edit e JOIN statement_line l ON l.id = e.line_id
      WHERE l.report_version_id = ? AND e.reverted_at IS NULL AND e.deleted_at IS NULL ORDER BY e.id`,
  ).all(versionId)) {
    const a = edits.get(e.line_id) ?? [];
    a.push({ id: e.id, lineId: e.line_id, field: e.field, newValue: e.new_value });
    edits.set(e.line_id, a);
    last.set(e.line_id, { by: e.updated_by, at: e.created_at });
  }
  const splits = new Map<string, SplitRec[]>();
  for (const s of db.prepare(
    `SELECT s.id, s.line_id, s.qty_moved, s.to_stream_kind, s.to_usage_type, s.rate_per_stream, s.updated_by, s.created_at FROM line_split s JOIN statement_line l ON l.id = s.line_id
      WHERE l.report_version_id = ? AND s.reverted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.id`,
  ).all(versionId)) {
    const a = splits.get(s.line_id) ?? [];
    a.push({ id: s.id, lineId: s.line_id, qtyMoved: s.qty_moved, toStreamKind: s.to_stream_kind, toUsageType: s.to_usage_type, ratePerStream: s.rate_per_stream });
    splits.set(s.line_id, a);
    const prev = last.get(s.line_id);
    if (!prev || prev.at < s.created_at) last.set(s.line_id, { by: s.updated_by, at: s.created_at });
  }
  const titles = new Map<string, string>();
  for (const t of db.prepare('SELECT id, title FROM track WHERE deleted_at IS NULL').all()) titles.set(t.id, t.title);

  const out: LineRow[] = [];
  const src = new Map<string, LineSrc>();
  for (const l of db.prepare('SELECT * FROM statement_line WHERE report_version_id = ?').all(versionId)) {
    const base: BaseLine = { id: l.id, qty: l.qty, royaltyKop: l.royalty_kop, streamKind: l.stream_kind, usageType: l.usage_type, trackId: l.track_id };
    const ed = edits.get(l.id) ?? [];
    const sp = splits.get(l.id) ?? [];
    const origRate = l.qty > 0 ? rateToRubString({ n: BigInt(l.royalty_kop), d: BigInt(l.qty) }) : null;
    const pieces: EffPiece[] = ed.length === 0 && sp.length === 0
      ? [{ key: l.id, lineId: l.id, splitId: null, qty: l.qty, royaltyKop: l.royalty_kop, rate: origRate, streamKind: l.stream_kind, usageType: l.usage_type, trackId: l.track_id, changed: [], rateFrac: l.qty > 0 ? { n: BigInt(l.royalty_kop), d: BigInt(l.qty) } : null }]
      : effectivePieces(base, ed, sp);
    src.set(l.id, { base, edits: ed, splits: sp, pieces });
    for (const p of pieces) {
      const moved = p.splitId !== null;
      out.push({
        key: p.key, lineId: l.id, splitId: p.splitId, versionId, reportId: head.report_id, distributor: head.distributor, quarter: head.quarter, rights: l.rights_type,
        upc: l.upc_raw, isrc: l.isrc_raw, code: l.code_raw, artist: l.artist_raw, title: l.title_raw, platform: l.platform, usage: p.usageType, model: l.usage_model,
        country: l.country, month: l.period_month, qty: p.qty, royaltyKop: p.royaltyKop, rate: p.rate, streamKind: p.streamKind, trackId: p.trackId,
        trackTitle: p.trackId ? titles.get(p.trackId) ?? null : null,
        origQty: moved ? 0 : l.qty, origRoyaltyKop: moved ? 0 : l.royalty_kop, origRate: moved ? null : origRate, origStreamKind: l.stream_kind, origUsage: l.usage_type,
        changed: p.changed, hasSplit: sp.length > 0, splitCount: sp.length,
        lastEditBy: last.get(l.id)?.by ?? null, lastEditAt: last.get(l.id)?.at ?? null,
      });
    }
  }
  const full = { rows: out, src };
  m.set(versionId, full);
  return full;
}
const loadVersion = (db: Db, versionId: string): LineRow[] => loadVersionFull(db, versionId).rows;

/** Исходные данные строки и её действующие правки (для пробного пересчёта в предпросмотре). */
export function lineSrc(db: Db, lineId: string): { versionId: string; src: LineSrc } | null {
  const v = db.prepare('SELECT report_version_id FROM statement_line WHERE id = ?').get(lineId);
  if (!v) return null;
  const s = loadVersionFull(db, v.report_version_id).src.get(lineId);
  return s ? { versionId: v.report_version_id, src: s } : null;
}

/** Текущие версии отчётов квартала (или выбранные отчёты). */
export function currentVersionIds(db: Db, f: Pick<LineFilter, 'quarter' | 'reportIds'>): string[] {
  const rows = db.prepare(
    `SELECT r.id AS report_id, r.current_version_id FROM report r WHERE r.deleted_at IS NULL AND r.current_version_id IS NOT NULL AND (? IS NULL OR r.quarter = ?)`,
  ).all(f.quarter ?? null, f.quarter ?? null);
  const only = f.reportIds && f.reportIds.length > 0 ? new Set(f.reportIds) : null;
  return rows.filter((r) => !only || only.has(r.report_id)).map((r) => r.current_version_id);
}

const lower = (s: string | null): string => (s ?? '').toLowerCase();
const inList = (list: string[] | undefined, v: string | null): boolean => !list || list.length === 0 || list.includes(v ?? '');

export function matchesFilter(r: LineRow, f: LineFilter): boolean {
  if (!inList(f.distributor, r.distributor) || !inList(f.rights, r.rights) || !inList(f.platform, r.platform) || !inList(f.usage, r.usage)) return false;
  if (!inList(f.model, r.model) || !inList(f.country, r.country) || !inList(f.month, r.month) || !inList(f.streamKind, r.streamKind)) return false;
  if (f.edited && r.changed.length === 0) return false;
  if (f.unmatched && r.trackId) return false;
  if (f.q) {
    const needle = f.q.trim().toLowerCase();
    if (needle && ![r.artist, r.title, r.isrc, r.code, r.upc].some((x) => lower(x).includes(needle))) return false;
  }
  return true;
}

export function filteredLines(db: Db, f: LineFilter): LineRow[] {
  const out: LineRow[] = [];
  for (const id of currentVersionIds(db, f)) for (const r of loadVersion(db, id)) if (matchesFilter(r, f)) out.push(r);
  return out;
}

const SORTERS: Record<SortKey, (r: LineRow) => string | number> = {
  distributor: (r) => lower(r.distributor), artist: (r) => lower(r.artist), title: (r) => lower(r.title), platform: (r) => lower(r.platform),
  usage: (r) => lower(r.usage), country: (r) => lower(r.country), month: (r) => r.month ?? '', qty: (r) => r.qty, royalty: (r) => r.royaltyKop,
  rate: (r) => (r.rate === null ? -Infinity : Number(r.rate)), streamKind: (r) => r.streamKind,
};

export function queryLines(db: Db, f: LineFilter, sort: LineSort = { key: 'royalty', dir: 'desc' }, offset = 0, limit = 200): LinePage {
  const all = filteredLines(db, f);
  const get = SORTERS[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  const sorted = [...all].sort((a, b) => {
    const x = get(a), y = get(b);
    return x < y ? -sign : x > y ? sign : 0;
  });
  let qty = 0, roy = 0, orig = 0, edited = 0;
  for (const r of all) { qty += r.qty; roy += r.royaltyKop; orig += r.origRoyaltyKop; if (r.changed.length > 0) edited++; }
  return { rows: sorted.slice(offset, offset + limit), total: all.length, totals: { qty, royaltyKop: roy, origRoyaltyKop: orig, edited } };
}

export interface Facets {
  distributor: string[]; rights: string[]; platform: string[]; usage: string[]; model: string[]; country: string[]; month: string[]; streamKind: string[];
}

/** Значения для выпадающих фильтров: что реально есть в строках квартала. */
export function lineFacets(db: Db, quarter?: string): Facets {
  const sets: Record<keyof Facets, Set<string>> = {
    distributor: new Set(), rights: new Set(), platform: new Set(), usage: new Set(), model: new Set(), country: new Set(), month: new Set(), streamKind: new Set(),
  };
  for (const id of currentVersionIds(db, { quarter })) {
    for (const r of loadVersion(db, id)) {
      sets.distributor.add(r.distributor); sets.rights.add(r.rights); sets.platform.add(r.platform ?? ''); sets.usage.add(r.usage ?? '');
      sets.model.add(r.model ?? ''); sets.country.add(r.country ?? ''); sets.month.add(r.month ?? ''); sets.streamKind.add(r.streamKind);
    }
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, 'ru'));
  return {
    distributor: sorted(sets.distributor), rights: sorted(sets.rights), platform: sorted(sets.platform), usage: sorted(sets.usage), model: sorted(sets.model),
    country: sorted(sets.country), month: sorted(sets.month), streamKind: sorted(sets.streamKind),
  };
}

/** Строка по ключу (для проверок перед правкой). */
export function findLine(db: Db, lineId: string): LineRow[] {
  const v = db.prepare('SELECT report_version_id FROM statement_line WHERE id = ?').get(lineId);
  if (!v) return [];
  return loadVersion(db, v.report_version_id).filter((r) => r.lineId === lineId);
}

export interface LineHistory {
  original: { title: string | null; platform: string | null; usage: string | null; qty: number; royaltyKop: number; rate: string | null; streamKind: string };
  steps: Array<{
    id: string;
    kind: 'edit' | 'split';
    what: string;
    value: string | null;
    by: string | null;
    at: string;
    active: boolean;
    batchId: string | null;
  }>;
}

const FIELD_TITLES: Record<string, string> = {
  qty: 'Тираж', royalty_kop: 'Роялти (коп.)', rate_per_stream: 'Ставка за прослушивание', stream_kind: 'Тип стрима', usage_type: 'Вид использования', track_id: 'Трек',
};

/** Полная история правок строки, включая отменённые: исходные значения всегда остаются неизменными. */
export function lineHistory(db: Db, lineId: string): LineHistory {
  const l = db.prepare('SELECT * FROM statement_line WHERE id = ?').get(lineId);
  if (!l) throw new Error('Строка не найдена');
  const steps: LineHistory['steps'] = [];
  for (const e of db.prepare('SELECT * FROM line_edit WHERE line_id = ? AND deleted_at IS NULL ORDER BY id').all(lineId)) {
    steps.push({ id: e.id, kind: 'edit', what: FIELD_TITLES[e.field] ?? e.field, value: e.new_value, by: e.updated_by, at: e.created_at, active: !e.reverted_at, batchId: e.batch_id });
  }
  for (const s of db.prepare('SELECT * FROM line_split WHERE line_id = ? AND deleted_at IS NULL ORDER BY id').all(lineId)) {
    steps.push({
      id: s.id, kind: 'split', what: 'Перенос прослушиваний', by: s.updated_by, at: s.created_at, active: !s.reverted_at, batchId: s.batch_id,
      value: `${s.qty_moved} шт. → ${s.to_stream_kind}${s.rate_per_stream ? `, ставка ${s.rate_per_stream} ₽` : ''}`,
    });
  }
  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    original: {
      title: l.title_raw, platform: l.platform, usage: l.usage_type, qty: l.qty, royaltyKop: l.royalty_kop, streamKind: l.stream_kind,
      rate: l.qty > 0 ? rateToRubString({ n: BigInt(l.royalty_kop), d: BigInt(l.qty) }) : null,
    },
    steps,
  };
}
