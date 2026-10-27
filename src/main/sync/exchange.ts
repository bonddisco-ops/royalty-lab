// Обмен обновлениями между двумя установками (ТЗ §11, Схема_БД.md §10).
// Файл = zip: manifest.json, changes.jsonl (события change_log), lines.jsonl (строки отчётов: они не журналируются), files/…
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PII_FIELDS } from '../domain/validate.ts';
import { DATA_TABLES } from '../db/schema.ts';
import { unzipAll } from '../export/zipReader.ts';
import { zipFiles } from '../export/zipWriter.ts';
import type { Ctx, Db, Row } from '../db/types.ts';
import { decryptBuf, encryptBuf } from '../photos.ts';

const PII = new Set<string>(PII_FIELDS);
const FILE_FIELDS = new Set(['photo_file', 'cover_file', 'file_path']);
const SAFE_NAME = /^[0-9A-Za-z._-]{1,200}$/;

export interface Ev { id: string; replica_id: string; seq: number; user_id: string; ts: string; table_name: string; row_id: string; op: 'insert' | 'update' | 'delete'; field: string | null; old_value: string | null; new_value: string | null }
export interface Manifest { v: 1; replica: string; author: string; ts: string; includePii: boolean; known: Record<string, number>; appVersion?: number }

const jl = (xs: unknown[]): string => xs.map((x) => JSON.stringify(x)).join('\n');
const parseJl = <T>(s: string): T[] => s.split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

export function knownSeqs(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare('SELECT replica_id, MAX(seq) AS m FROM change_log GROUP BY replica_id').all()) out[String(r.replica_id)] = Number(r.m);
  return out;
}
const peerKnown = (db: Db): Record<string, number> => {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'peer_known'").get();
  try { return r ? (JSON.parse(String(r.value)) as Record<string, number>) : {}; } catch { return {}; }
};
function setPeerKnown(db: Db, k: Record<string, number>): void {
  const merged = { ...peerKnown(db) };
  for (const [r, s] of Object.entries(k)) merged[r] = Math.max(merged[r] ?? 0, s);
  db.prepare("INSERT INTO meta (key, value) VALUES ('peer_known', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(merged));
}

function stripPii(e: Ev): Ev | null {
  if (e.table_name !== 'counterparty') return e;
  if (e.op === 'update' && e.field && PII.has(e.field)) return null;
  if (e.op === 'insert' && e.new_value) {
    const row = JSON.parse(e.new_value) as Row;
    for (const k of PII_FIELDS) if (k in row) row[k] = null;
    return { ...e, new_value: JSON.stringify(row) };
  }
  return e;
}

function fileRefs(e: Ev): string[] {
  const out: string[] = [];
  if (e.op === 'update' && e.field && FILE_FIELDS.has(e.field) && e.new_value) out.push(e.new_value);
  if (e.op === 'insert' && e.new_value) {
    const row = JSON.parse(e.new_value) as Row;
    for (const f of FILE_FIELDS) if (typeof row[f] === 'string' && row[f]) out.push(row[f] as string);
  }
  return out;
}

export interface BuildOpts { includePii: boolean; author: string; replicaId: string; dk: Buffer; photosDir: string; reportsDir: string }

export function buildPayload(db: Db, o: BuildOpts): { zip: Buffer; events: number } {
  const peer = o.includePii ? {} : peerKnown(db);
  let evs = db.prepare('SELECT * FROM change_log ORDER BY ts, id').all() as unknown as Ev[];
  evs = evs.filter((e) => e.seq > (peer[e.replica_id] ?? 0));
  if (!o.includePii) evs = evs.map(stripPii).filter((e): e is Ev => e !== null);
  const files: Array<{ name: string; data: Buffer }> = [];
  const seen = new Set<string>();
  const addFile = (kind: 'photos' | 'reports', name: string): void => {
    if (!SAFE_NAME.test(name) || seen.has(`${kind}/${name}`)) return;
    seen.add(`${kind}/${name}`);
    const variants = kind === 'photos' ? [name, name.replace(/\.img$/, '.thumb')] : [name];
    for (const v of variants) {
      const p = join(kind === 'photos' ? o.photosDir : o.reportsDir, v);
      if (!existsSync(p)) continue;
      const raw = readFileSync(p);
      files.push({ name: `files/${kind}/${v}`, data: kind === 'photos' ? decryptBuf(o.dk, raw) : raw });
    }
  };
  const lineRows: Array<Record<string, unknown>> = [];
  for (const e of evs) {
    for (const f of fileRefs(e)) addFile(e.table_name === 'report_version' || e.field === 'file_path' ? 'reports' : 'photos', f);
    if (e.table_name === 'report_version' && e.op === 'insert') {
      for (const l of db.prepare('SELECT * FROM statement_line WHERE report_version_id = ?').all(e.row_id)) lineRows.push(l);
    }
  }
  const manifest: Manifest = { v: 1, replica: o.replicaId, author: o.author, ts: new Date().toISOString(), includePii: o.includePii, known: knownSeqs(db) };
  const zip = zipFiles([
    { name: 'manifest.json', data: JSON.stringify(manifest) },
    { name: 'changes.jsonl', data: jl(evs) },
    { name: 'lines.jsonl', data: jl(lineRows) },
    ...files,
  ]);
  return { zip, events: evs.length };
}

// ------------------------------------------------------------------ разбор и предпросмотр

export interface Parsed { manifest: Manifest; events: Ev[]; lines: Row[]; files: Map<string, Buffer> }

export function parsePayload(zip: Buffer): Parsed {
  const m = unzipAll(zip);
  const get = (n: string): string => m.get(n)?.toString('utf8') ?? '';
  if (!m.has('manifest.json')) throw new Error('В файле нет описания (manifest.json)');
  const manifest = JSON.parse(get('manifest.json')) as Manifest;
  if (manifest.v !== 1) throw new Error('Файл создан более новой версией программы. Обновите Royalty Lab.');
  const ok = new Set<string>(DATA_TABLES);
  const events = parseJl<Ev>(get('changes.jsonl')).filter((e) => ok.has(e.table_name) && (e.field === null || /^[a-z_]+$/.test(e.field)));
  return { manifest, events, lines: parseJl<Row>(get('lines.jsonl')), files: m };
}

export interface Change { eventId: string; field: string | null; was: string | null; now: string | null; conflict: boolean; mine: string | null }
export interface Group { key: string; table: string; rowId: string; title: string; kind: 'insert' | 'update' | 'delete'; users: string[]; from: string; to: string; changes: Change[] }
export interface UpdatePreview { author: string; ts: string; includePii: boolean; total: number; fresh: number; groups: Group[]; conflicts: number; reports: Array<{ label: string; lines: number; rowsKop: number }> }

const TABLE_RU: Record<string, string> = { counterparty: 'Человек', artist: 'Артист', track: 'Трек', participation: 'Участие в треке', contract: 'Договор', appendix: 'Приложение', appendix_item: 'Строка приложения', report: 'Отчёт', report_version: 'Версия отчёта', line_edit: 'Правка строки', line_split: 'Разделение строки', payout_period: 'Выплата', payout_statement: 'Ведомость', issue: 'Проверка', settings: 'Настройка', distributor: 'Дистрибьютор', track_identifier: 'Идентификатор трека', artist_name_variant: 'Вариант имени', edit_batch: 'Пакет правок', report_payment: 'Поступление', contract_template: 'Шаблон', import_format: 'Формат' };

function rowTitle(db: Db, table: string, id: string, evs: Ev[]): string {
  const ins = evs.find((e) => e.op === 'insert');
  const snap: Row = ins?.new_value ? (JSON.parse(ins.new_value) as Row) : (db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? {});
  let t = '';
  if (table === 'counterparty') t = [snap.last_name, snap.first_name, snap.middle_name].filter(Boolean).join(' ');
  else if (table === 'artist') t = String(snap.name ?? '');
  else if (table === 'track') t = String(snap.title ?? '');
  else if (table === 'contract') t = String(snap.number ?? '');
  else if (table === 'settings') t = id;
  else if (table === 'payout_period') t = String(snap.quarter ?? '');
  else if (table === 'report') t = String(snap.quarter ?? '');
  return `${TABLE_RU[table] ?? table}${t ? `: ${t}` : ` ${id.slice(-6)}`}`;
}

export function previewPayload(db: Db, p: Parsed, myReplica: string): UpdatePreview {
  const have = new Set((db.prepare('SELECT id FROM change_log').all()).map((r) => String(r.id)));
  const fresh = p.events.filter((e) => !have.has(e.id)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  // локальные события, которых у отправителя ещё нет
  const unknownToSender = (db.prepare('SELECT * FROM change_log').all() as unknown as Ev[]).filter((e) => e.seq > (p.manifest.known[e.replica_id] ?? 0));
  void myReplica;
  const localKey = new Map<string, Ev>();
  for (const e of unknownToSender) if (e.op !== 'insert') localKey.set(`${e.table_name}/${e.row_id}/${e.field ?? ''}`, e);
  const byRow = new Map<string, Ev[]>();
  for (const e of fresh) {
    const k = `${e.table_name}/${e.row_id}`;
    (byRow.get(k) ?? byRow.set(k, []).get(k)!).push(e);
  }
  let conflicts = 0;
  const groups: Group[] = [];
  for (const [key, evs] of byRow) {
    const [table, rowId] = [evs[0]!.table_name, evs[0]!.row_id];
    const changes: Change[] = [];
    for (const e of evs) {
      if (e.op === 'insert') { changes.push({ eventId: e.id, field: null, was: null, now: 'новая запись', conflict: false, mine: null }); continue; }
      const loc = localKey.get(`${e.table_name}/${e.row_id}/${e.field ?? ''}`);
      const conflict = !!loc && (loc.new_value ?? '') !== (e.new_value ?? '');
      if (conflict) conflicts++;
      changes.push({ eventId: e.id, field: e.field, was: e.old_value, now: e.new_value, conflict, mine: conflict ? (loc?.new_value ?? null) : null });
    }
    groups.push({
      key, table, rowId, title: rowTitle(db, table, rowId, evs), kind: evs.some((e) => e.op === 'insert') ? 'insert' : evs.every((e) => e.op === 'delete') ? 'delete' : 'update',
      users: [...new Set(evs.map((e) => e.user_id))], from: evs[0]!.ts, to: evs[evs.length - 1]!.ts, changes,
    });
  }
  const byVer = new Map<string, { lines: number; rowsKop: number }>();
  for (const l of p.lines) {
    const v = byVer.get(String(l.report_version_id)) ?? { lines: 0, rowsKop: 0 };
    v.lines++; v.rowsKop += Number(l.royalty_kop ?? 0);
    byVer.set(String(l.report_version_id), v);
  }
  const reports = [...byVer].map(([vid, v]) => {
    const g = groups.find((x) => x.rowId === vid);
    const ev = fresh.find((e) => e.row_id === vid && e.op === 'insert');
    let label = g?.title ?? vid.slice(-6);
    if (ev?.new_value) { const r = JSON.parse(ev.new_value) as Row; try { label = `Отчёт (${(JSON.parse(String(r.header_json ?? '{}')) as Row).fileName ?? 'файл'})`; } catch { /* оставляем */ } }
    return { label, ...v };
  });
  groups.sort((a, b) => (a.from < b.from ? -1 : 1));
  return { author: p.manifest.author, ts: p.manifest.ts, includePii: p.manifest.includePii, total: p.events.length, fresh: fresh.length, groups, conflicts, reports };
}

// ------------------------------------------------------------------ применение

export interface Selection { skipGroups: string[]; keepMine: string[] }
export interface ApplyResult { applied: number; skipped: number; lines: number; files: number }

function columns(db: Db, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
}

export function applyPayload(db: Db, ctx: Ctx, p: Parsed, sel: Selection, io: { dk: Buffer; photosDir: string; reportsDir: string }): ApplyResult {
  const prev = previewPayload(db, p, ctx.replicaId);
  const skip = new Set(sel.skipGroups);
  const mine = new Set(sel.keepMine);
  const have = new Set((db.prepare('SELECT id FROM change_log').all()).map((r) => String(r.id)));
  const fresh = p.events.filter((e) => !have.has(e.id)).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  const conflictIds = new Set(prev.groups.flatMap((g) => g.changes.filter((c) => c.conflict).map((c) => c.eventId)));
  const res: ApplyResult = { applied: 0, skipped: 0, lines: 0, files: 0 };
  const colCache = new Map<string, Set<string>>();
  const cols = (t: string): Set<string> => colCache.get(t) ?? colCache.set(t, columns(db, t)).get(t)!;
  const insertedVersions: string[] = [];

  db.transaction(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    const logIns = db.prepare(
      `INSERT OR IGNORE INTO change_log (id, replica_id, seq, user_id, ts, table_name, row_id, op, field, old_value, new_value) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const e of fresh) {
      const gk = `${e.table_name}/${e.row_id}`;
      const take = !skip.has(gk) && !(conflictIds.has(e.id) && mine.has(e.id));
      if (take) {
        const table = e.table_name;
        const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(e.row_id);
        if (e.op === 'insert') {
          if (!exists && e.new_value) {
            const row = JSON.parse(e.new_value) as Row;
            const keys = Object.keys(row).filter((k) => cols(table).has(k));
            const full: Row = { ...row, created_at: e.ts, updated_at: e.ts, updated_by: e.user_id, deleted_at: null };
            const ks = [...new Set([...keys, 'created_at', 'updated_at', 'updated_by', 'deleted_at'])].filter((k) => cols(table).has(k));
            db.prepare(`INSERT INTO ${table} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => bindVal(full[k])));
            if (table === 'report_version') insertedVersions.push(e.row_id);
            res.applied++;
          } else res.skipped++;
        } else if (exists && e.field && cols(table).has(e.field)) {
          db.prepare(`UPDATE ${table} SET ${e.field} = ?, updated_at = ?, updated_by = ? WHERE id = ?`).run(e.new_value, e.ts, e.user_id, e.row_id);
          res.applied++;
        } else res.skipped++;
      } else res.skipped++;
      logIns.run(e.id, e.replica_id, e.seq, e.user_id, e.ts, e.table_name, e.row_id, e.op, e.field, e.old_value, e.new_value);
    }
    for (const v of insertedVersions) {
      for (const l of p.lines.filter((x) => String(x.report_version_id) === v)) {
        const ks = Object.keys(l).filter((k) => cols('statement_line').has(k));
        db.prepare(`INSERT OR IGNORE INTO statement_line (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`).run(...ks.map((k) => bindVal(l[k])));
        res.lines++;
      }
    }
    const maxSeen = new Map<string, number>();
    for (const e of fresh) maxSeen.set(e.replica_id, Math.max(maxSeen.get(e.replica_id) ?? 0, e.seq));
    for (const [r, s] of maxSeen) {
      db.prepare('INSERT INTO sync_state (replica_id, last_seq_seen) VALUES (?, ?) ON CONFLICT(replica_id) DO UPDATE SET last_seq_seen = MAX(last_seq_seen, excluded.last_seq_seen)').run(r, s);
    }
    setPeerKnown(db, p.manifest.known);
  })();

  for (const [name, data] of p.files) {
    const m = /^files\/(photos|reports)\/([^/]+)$/.exec(name);
    if (!m || !SAFE_NAME.test(m[2]!)) continue;
    const dir = m[1] === 'photos' ? io.photosDir : io.reportsDir;
    const target = join(dir, m[2]!);
    if (existsSync(target)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, m[1] === 'photos' ? encryptBuf(io.dk, data) : data);
    res.files++;
  }
  return res;
}

function bindVal(v: unknown): string | number | bigint | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number | bigint;
}
