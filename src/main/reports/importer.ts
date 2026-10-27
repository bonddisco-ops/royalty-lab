// Импорт распознанного отчёта в БД (ТЗ §5, Схема_БД §6, §9): агрегация по row_key, привязка треков, очередь «Проверить».
import { carryEdits, diffVersions, type ReplaceDiff } from './replace.ts';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { insertRow, mutate, updateRow } from '../db/mutate.ts';
import type { Ctx, Db, Row } from '../db/types.ts';
import { uuidv7 } from '../domain/ids.ts';
import { normKey } from '../domain/normalize.ts';
import type { Flow, ParsedLine, ParsedReport, RightsType, StreamKind } from './types.ts';
import { isIsrcLike, toExactKop, toKop } from './util.ts';

// ------------------------------------------------------------------ агрегация

export interface AggLine {
  rowKey: string;
  rightsType: RightsType;
  artistRaw: string | null;
  titleRaw: string | null;
  isrc: string | null;
  upc: string | null;
  code: string | null;
  platform: string | null;
  usageType: string | null;
  usageModel: string | null;
  streamKind: StreamKind;
  country: string | null;
  periodMonth: string | null;
  qty: number;
  royaltyExact: number;
  royaltyKop: number;
  currencyOrig: string | null;
  amountOrig: number | null;
  merged: number;
  firstRow: number;
  raw: Record<string, unknown>;
}

export const normCode = (s: string | null): string | null => (s ? s.replace(/\s+/g, '').toUpperCase() : null);

export function rowKeyOf(l: ParsedLine): string {
  const isrc = l.isrcRaw ? l.isrcRaw.replace(/[\s-]/g, '').toUpperCase() : null;
  const code = normCode(l.codeRaw);
  const ident = isrc ? `I:${isrc}` : code ? `C:${code}` : `T:${normKey(l.titleRaw)}|${normKey(l.artistRaw)}`;
  const parts = [ident, normKey(l.platform), normKey(l.usageType), normKey(l.usageModel), l.periodMonth ?? '', normKey(l.country), l.rightsType];
  return createHash('sha1').update(parts.join('\u0001')).digest('hex').slice(0, 24);
}

/** Строки с одинаковым ключом агрегируются (Music Alligator: устройства/дубли). Сумма копеек считается по агрегату. */
export function aggregate(lines: ParsedLine[]): AggLine[] {
  const map = new Map<string, AggLine>();
  for (const l of lines) {
    const key = rowKeyOf(l);
    const ex = map.get(key);
    if (ex) {
      ex.qty += l.qty;
      ex.royaltyExact += l.royalty;
      ex.amountOrig = ex.amountOrig === null || l.amountOrig === null ? ex.amountOrig ?? l.amountOrig : ex.amountOrig + l.amountOrig;
      ex.merged++;
      continue;
    }
    map.set(key, {
      rowKey: key, rightsType: l.rightsType, artistRaw: l.artistRaw, titleRaw: l.titleRaw,
      isrc: l.isrcRaw ? l.isrcRaw.replace(/[\s-]/g, '').toUpperCase() : null, upc: l.upcRaw, code: normCode(l.codeRaw),
      platform: l.platform, usageType: l.usageType, usageModel: l.usageModel, streamKind: l.streamKind, country: l.country,
      periodMonth: l.periodMonth, qty: l.qty, royaltyExact: l.royalty, royaltyKop: 0, currencyOrig: l.currencyOrig,
      amountOrig: l.amountOrig, merged: 1, firstRow: l.srcRow, raw: l.raw,
    });
  }
  const out = [...map.values()];
  for (const a of out) {
    a.royaltyKop = toKop(a.royaltyExact);
    a.qty = Math.round(a.qty);
  }
  return out;
}

// ------------------------------------------------------------ привязка треков

export type MatchHow = 'isrc' | 'code' | 'remembered' | 'title';
export interface Matcher {
  match(l: Pick<AggLine, 'isrc' | 'code' | 'titleRaw' | 'artistRaw'>): { trackId: string | null; how: MatchHow | null };
  isKnownArtist(artistRaw: string | null): boolean;
}

export const ARTIST_SPLIT = /\s*(?:[,;&/]|\bfeat\.?\b|\bft\.?\b|\bx\b|\sи\s)\s*/i;
export const artistTokens = (raw: string | null): string[] => (raw ? raw.split(ARTIST_SPLIT).map((x) => normKey(x)).filter(Boolean) : []);

export function buildMatcher(db: Db): Matcher {
  const byIsrc = new Map<string, string>();
  for (const t of db.prepare('SELECT id, isrc FROM track WHERE deleted_at IS NULL AND isrc IS NOT NULL').all()) byIsrc.set(String(t.isrc).toUpperCase(), t.id);
  const byCode = new Map<string, string>();
  const remembered = new Map<string, string>();
  for (const r of db.prepare('SELECT track_id, kind, value_norm FROM track_identifier WHERE deleted_at IS NULL').all()) {
    const v = String(r.value_norm);
    if (r.kind === 'isrc') byIsrc.set(v.toUpperCase(), r.track_id);
    else if (r.kind === 'distributor_code') byCode.set(v.replace(/\s+/g, '').toUpperCase(), r.track_id);
    else if (r.kind === 'title_artist') remembered.set(v, r.track_id);
  }
  const titles = new Map<string, string[]>();
  const hasIsrc = new Set<string>();
  for (const t of db.prepare('SELECT id, title, isrc FROM track WHERE deleted_at IS NULL').all()) {
    const k = normKey(t.title);
    if (k) titles.set(k, [...(titles.get(k) ?? []), t.id]);
    if (t.isrc) hasIsrc.add(t.id);
  }
  const known = new Set<string>();
  const idToArtistNames = new Map<string, Set<string>>();
  const artistNorms = new Map<string, Set<string>>();
  for (const a of db.prepare('SELECT id, name FROM artist WHERE deleted_at IS NULL').all()) {
    known.add(normKey(a.name));
    artistNorms.set(a.id, new Set([normKey(a.name)]));
  }
  for (const v of db.prepare('SELECT artist_id, variant_norm FROM artist_name_variant WHERE deleted_at IS NULL').all()) {
    known.add(String(v.variant_norm));
    artistNorms.get(v.artist_id)?.add(String(v.variant_norm));
  }
  for (const p of db.prepare('SELECT track_id, artist_id FROM participation WHERE deleted_at IS NULL').all()) {
    const s = idToArtistNames.get(p.track_id) ?? new Set<string>();
    for (const n of artistNorms.get(p.artist_id) ?? []) s.add(n);
    idToArtistNames.set(p.track_id, s);
  }
  return {
    isKnownArtist(raw) {
      if (!raw) return false;
      if (known.has(normKey(raw))) return true;
      return artistTokens(raw).some((t) => known.has(t));
    },
    match(l) {
      if (l.isrc && byIsrc.has(l.isrc)) return { trackId: byIsrc.get(l.isrc)!, how: 'isrc' };
      if (l.code && byCode.has(l.code)) return { trackId: byCode.get(l.code)!, how: 'code' };
      const key = `${normKey(l.titleRaw)}|${normKey(l.artistRaw)}`;
      if (remembered.has(key)) return { trackId: remembered.get(key)!, how: 'remembered' };
      const withCode = !!(l.isrc || l.code);
      // у строки есть код, но он неизвестен: по названию ищем только среди треков каталога БЕЗ ISRC (у остальных код другой — не гадаем)
      const cands = (titles.get(normKey(l.titleRaw)) ?? []).filter((id) => !withCode || !hasIsrc.has(id));
      if (cands.length === 1) {
        const arts = idToArtistNames.get(cands[0]!);
        const tokens = artistTokens(l.artistRaw);
        if (!arts || arts.size === 0 || tokens.some((t) => arts.has(t))) return { trackId: cands[0]!, how: 'title' };
        return { trackId: null, how: null };
      }
      const tokens = artistTokens(l.artistRaw);
      const hit = cands.filter((id) => tokens.some((t) => idToArtistNames.get(id)?.has(t)));
      return hit.length === 1 ? { trackId: hit[0]!, how: 'title' } : { trackId: null, how: null };
    },
  };
}

// ------------------------------------------------------------- очередь «Проверить»

export interface IssueDraft {
  kind: 'unmatched_track' | 'unknown_artist' | 'not_reported_platform' | 'footer_mismatch' | 'isrc_two_distributors';
  details: Record<string, unknown>;
}

export interface Analysis {
  agg: AggLine[];
  matches: Array<string | null>;
  issues: IssueDraft[];
  matchedLines: number;
  unmatchedLines: number;
  unmatchedKop: number;
  exactSum: number;
  rowsKop: number;
  footerKop: number | null;
  footerDiffKop: number | null;
  footerOk: boolean | null;
  /** Строки узнаны по названию, а в отчёте есть ISRC/код: после загрузки запомним их у трека. */
  learn: Array<{ trackId: string; isrc: string | null; code: string | null }>;
}

export function isNotReported(platform: string | null): boolean {
  return /^not reported$/i.test((platform ?? '').trim());
}

export function analyze(db: Db, parsed: ParsedReport, flow: Flow, distributorId: string | null, quarter: string): Analysis {
  const agg = aggregate(parsed.lines);
  const matcher = buildMatcher(db);
  const matches: Array<string | null> = [];
  const learn: Analysis['learn'] = [];
  const issues: IssueDraft[] = [];
  const unmatched = new Map<string, { title: string | null; artist: string | null; isrc: string | null; code: string | null; lines: number; kop: number; platforms: Set<string> }>();
  const unknownArtists = new Map<string, { lines: number; kop: number }>();
  let matchedLines = 0;
  let unmatchedLines = 0;
  let unmatchedKop = 0;
  let nrLines = 0;
  let nrKop = 0;
  for (const l of agg) {
    const m = matcher.match(l);
    matches.push(m.trackId);
    if (m.trackId && m.how === 'title' && (l.isrc || l.code)) learn.push({ trackId: m.trackId, isrc: l.isrc, code: l.code });
    if (m.trackId) matchedLines++;
    else {
      unmatchedLines++;
      unmatchedKop += l.royaltyKop;
      const key = l.isrc ?? l.code ?? `${normKey(l.titleRaw)}|${normKey(l.artistRaw)}`;
      const u = unmatched.get(key) ?? { title: l.titleRaw, artist: l.artistRaw, isrc: l.isrc, code: l.code, lines: 0, kop: 0, platforms: new Set<string>() };
      u.lines++;
      u.kop += l.royaltyKop;
      if (l.platform) u.platforms.add(l.platform);
      unmatched.set(key, u);
    }
    if (l.artistRaw && !matcher.isKnownArtist(l.artistRaw)) {
      const u = unknownArtists.get(l.artistRaw) ?? { lines: 0, kop: 0 };
      u.lines++;
      u.kop += l.royaltyKop;
      unknownArtists.set(l.artistRaw, u);
    }
    if (isNotReported(l.platform)) {
      nrLines++;
      nrKop += l.royaltyKop;
    }
  }
  const exactSum = parsed.lines.reduce((a, l) => a + l.royalty, 0);
  const rowsKop = agg.reduce((a, l) => a + l.royaltyKop, 0);
  const footerKop = parsed.totals?.royalty != null ? toKop(parsed.totals.royalty) : null;
  const footerDiffKop = footerKop !== null ? toKop(exactSum) - footerKop : null;
  const tol = Math.max(1, parsed.totals?.toleranceKop ?? 0);
  const footerOk = footerDiffKop === null ? null : Math.abs(footerDiffKop) <= tol;
  if (footerOk === false) issues.push({ kind: 'footer_mismatch', details: { footer_kop: footerKop, rows_kop: toKop(exactSum), diff_kop: footerDiffKop, label: parsed.totals?.label } });
  if (nrLines > 0) issues.push({ kind: 'not_reported_platform', details: { lines: nrLines, royalty_kop: nrKop } });
  if (flow === 'artists') {
    for (const u of unmatched.values())
      issues.push({ kind: 'unmatched_track', details: { title: u.title, artist: u.artist, isrc: u.isrc, code: u.code, lines: u.lines, royalty_kop: u.kop, platforms: [...u.platforms].slice(0, 5) } });
    for (const [artist, u] of unknownArtists) issues.push({ kind: 'unknown_artist', details: { artist, lines: u.lines, royalty_kop: u.kop } });
  }
  // один ISRC от двух дистрибьюторов за квартал
  const isrcs = [...new Set(agg.map((l) => l.isrc).filter((x): x is string => !!x))];
  if (isrcs.length > 0 && flow !== 'ignore') {
    const rows = db.prepare(
      `SELECT DISTINCT l.isrc_raw AS isrc, d.name AS distributor
         FROM statement_line l JOIN report_version v ON v.id = l.report_version_id
         JOIN report r ON r.id = v.report_id JOIN distributor d ON d.id = r.distributor_id
        WHERE r.quarter = ? AND v.status = 'active' AND r.deleted_at IS NULL AND r.flow != 'ignore' AND (? IS NULL OR r.distributor_id != ?)`,
    ).all(quarter, distributorId, distributorId);
    const mine = new Set(isrcs);
    const clash = new Map<string, Set<string>>();
    for (const r of rows) if (r.isrc && mine.has(String(r.isrc).toUpperCase())) (clash.get(String(r.isrc).toUpperCase()) ?? clash.set(String(r.isrc).toUpperCase(), new Set()).get(String(r.isrc).toUpperCase())!).add(r.distributor);
    for (const [isrc, ds] of clash) issues.push({ kind: 'isrc_two_distributors', details: { isrc, other_distributors: [...ds] } });
  }
  return { agg, matches, issues, matchedLines, unmatchedLines, unmatchedKop, exactSum, rowsKop, footerKop, footerDiffKop, footerOk, learn };
}

// -------------------------------------------------------------------- предпросмотр

export interface ImportInput {
  parsed: ParsedReport;
  fileName: string;
  fileSha: string;
  flow: Flow;
  quarter: string;
}

export interface ImportPreview {
  formatCode: string;
  distributorName: string;
  rightsScope: RightsType;
  quarter: string;
  quarterSource: ParsedReport['quarterSource'];
  flow: Flow;
  periodFrom: string | null;
  periodTo: string | null;
  licensorShare: string | null;
  srcRows: number;
  aggRows: number;
  rowsKop: number;
  footerKop: number | null;
  footerDiffKop: number | null;
  footerOk: boolean | null;
  footerLabel: string | null;
  duplicateOf: { quarter: string; distributor: string; versionNo: number } | null;
  replaces: { versionNo: number; aggRows: number; rowsKop: number } | null;
  /** Сравнение с заменяемой версией (только если replaces). */
  diff: ReplaceDiff | null;
  match: { matchedLines: number; unmatchedLines: number; unmatchedTracks: number; unmatchedKop: number; unknownArtists: number; notReportedKop: number; isrcTwoDistributors: number };
  byStreamKind: Record<string, { rows: number; kop: number }>;
  warnings: string[];
}

export function findDistributor(db: Db, formatCode: string): Row | undefined {
  return db.prepare('SELECT * FROM distributor WHERE format_code = ? AND deleted_at IS NULL').get(formatCode);
}

export function previewImport(db: Db, inp: ImportInput): ImportPreview {
  const { parsed } = inp;
  const dist = findDistributor(db, parsed.formatCode);
  const a = analyze(db, parsed, inp.flow, dist?.id ?? null, inp.quarter);
  const dup = db.prepare(
    `SELECT v.version_no, r.quarter, d.name FROM report_version v JOIN report r ON r.id = v.report_id JOIN distributor d ON d.id = r.distributor_id
      WHERE v.file_sha256 = ? AND v.deleted_at IS NULL`,
  ).get(inp.fileSha);
  const prev = dist
    ? db.prepare(
        `SELECT v.id AS version_id, v.version_no, v.total_rows_kop, (SELECT count(*) FROM statement_line l WHERE l.report_version_id = v.id) AS n
           FROM report r JOIN report_version v ON v.id = r.current_version_id
          WHERE r.distributor_id = ? AND r.quarter = ? AND r.rights_scope = ? AND r.deleted_at IS NULL`,
      ).get(dist.id, inp.quarter, parsed.rightsScope)
    : undefined;
  const byKind: Record<string, { rows: number; kop: number }> = {};
  for (const l of a.agg) {
    const k = (byKind[l.streamKind] ??= { rows: 0, kop: 0 });
    k.rows++;
    k.kop += l.royaltyKop;
  }
  return {
    formatCode: parsed.formatCode,
    distributorName: parsed.distributorName,
    rightsScope: parsed.rightsScope,
    quarter: inp.quarter,
    quarterSource: parsed.quarterSource,
    flow: inp.flow,
    periodFrom: parsed.periodFrom,
    periodTo: parsed.periodTo,
    licensorShare: parsed.licensorShare,
    srcRows: parsed.lines.length,
    aggRows: a.agg.length,
    rowsKop: a.rowsKop,
    footerKop: a.footerKop,
    footerDiffKop: a.footerDiffKop,
    footerOk: a.footerOk,
    footerLabel: parsed.totals?.label ?? null,
    duplicateOf: dup ? { quarter: dup.quarter, distributor: dup.name, versionNo: dup.version_no } : null,
    replaces: prev ? { versionNo: prev.version_no, aggRows: prev.n, rowsKop: prev.total_rows_kop } : null,
    diff: prev ? diffVersions(db, prev.version_id, a.agg.map((l) => ({ rowKey: l.rowKey, qty: l.qty, royaltyKop: l.royaltyKop }))) : null,
    match: {
      matchedLines: a.matchedLines,
      unmatchedLines: a.unmatchedLines,
      unmatchedTracks: a.issues.filter((i) => i.kind === 'unmatched_track').length,
      unmatchedKop: a.unmatchedKop,
      unknownArtists: a.issues.filter((i) => i.kind === 'unknown_artist').length,
      notReportedKop: Number(a.issues.find((i) => i.kind === 'not_reported_platform')?.details.royalty_kop ?? 0),
      isrcTwoDistributors: a.issues.filter((i) => i.kind === 'isrc_two_distributors').length,
    },
    byStreamKind: byKind,
    warnings: parsed.warnings,
  };
}

// --------------------------------------------------------------------------- запись

export interface CommitResult {
  reportId: string;
  versionId: string;
  versionNo: number;
  lines: number;
  rowsKop: number;
  issues: number;
  /** Строк с ручными правками, перенесённых из прежней версии / не нашедших пару. */
  carried: number;
  lost: number;
}

export interface CommitOptions {
  /** Исходный файл отчёта: копия кладётся в папку reports/ (имя = sha256 + расширение). */
  file?: { sourcePath?: string; bytes?: Uint8Array; reportsDir: string };
}

export function commitImport(db: Db, ctx: Ctx, inp: ImportInput, opts: CommitOptions = {}): CommitResult {
  const { parsed } = inp;
  if (db.prepare('SELECT 1 FROM report_version WHERE file_sha256 = ? AND deleted_at IS NULL').get(inp.fileSha)) {
    throw new Error('Этот файл уже загружен (такое же содержимое)');
  }
  if (!/^\d{4}Q[1-4]$/.test(inp.quarter)) throw new Error('Квартал должен быть вида 2026Q3');
  // копия файла кладётся до записи в БД; при ошибке удаляем
  let storedRel: string | null = null;
  let storedAbs: string | null = null;
  const f = opts.file;
  if (f) {
    mkdirSync(f.reportsDir, { recursive: true });
    const ext = extname(inp.fileName) || '.xlsx';
    storedRel = `${inp.fileSha}${ext}`;
    storedAbs = join(f.reportsDir, storedRel);
    if (!existsSync(storedAbs)) {
      if (f.sourcePath) copyFileSync(f.sourcePath, storedAbs);
      else if (f.bytes) writeFileSync(storedAbs, f.bytes);
      else storedRel = null;
    }
  }
  try {
    return db.transaction(() => {
      const dist = findDistributor(db, parsed.formatCode);
      const distributorId =
        dist?.id ??
        insertRow(db, ctx, 'distributor', {
          name: parsed.distributorName, format_code: parsed.formatCode, default_flow: parsed.defaultFlow, licensor_share: parsed.licensorShare,
        });
      if (dist && !dist.licensor_share && parsed.licensorShare) updateRow(db, ctx, 'distributor', dist.id, { licensor_share: parsed.licensorShare });
      const a = analyze(db, parsed, inp.flow, distributorId, inp.quarter);

      const existing = db.prepare('SELECT * FROM report WHERE distributor_id = ? AND quarter = ? AND rights_scope = ? AND deleted_at IS NULL').get(distributorId, inp.quarter, parsed.rightsScope);
      let reportId: string;
      let versionNo = 1;
      const prevVersionId: string | null = existing?.current_version_id ?? null;
      if (existing) {
        reportId = existing.id;
        versionNo = Number(db.prepare('SELECT max(version_no) AS m FROM report_version WHERE report_id = ?').get(reportId)?.m ?? 0) + 1;
        const olds = db.prepare("SELECT id FROM report_version WHERE report_id = ? AND status = 'active' AND deleted_at IS NULL").all(reportId);
        for (const o of olds) updateRow(db, ctx, 'report_version', o.id, { status: 'superseded' });
        // открытые вопросы по старой версии больше не актуальны
        const stale = db.prepare("SELECT id FROM issue WHERE status = 'open' AND deleted_at IS NULL AND report_version_id IN (SELECT id FROM report_version WHERE report_id = ?)").all(reportId);
        for (const st of stale) {
          updateRow(db, ctx, 'issue', st.id, { status: 'ignored', resolved_at: new Date().toISOString(), resolved_by: ctx.userId, resolution_json: { auto: 'replaced_by_new_version' } });
        }
        if (existing.flow !== inp.flow) updateRow(db, ctx, 'report', reportId, { flow: inp.flow });
      } else {
        reportId = insertRow(db, ctx, 'report', { distributor_id: distributorId, quarter: inp.quarter, rights_scope: parsed.rightsScope, flow: inp.flow });
      }
      const versionId = insertRow(db, ctx, 'report_version', {
        report_id: reportId, version_no: versionNo, file_path: storedRel, file_sha256: inp.fileSha, imported_at: new Date().toISOString(),
        imported_by: ctx.userId, period_from: parsed.periodFrom, period_to: parsed.periodTo,
        header_json: {
          ...parsed.header, fileName: inp.fileName, formatCode: parsed.formatCode, quarterSource: parsed.quarterSource,
          exactSumKop: toKop(a.exactSum), footerToleranceKop: Math.max(1, parsed.totals?.toleranceKop ?? 0), srcRows: parsed.lines.length,
        },
        total_footer_kop: a.footerKop, total_rows_kop: a.rowsKop, status: 'active',
      });
      updateRow(db, ctx, 'report', reportId, { current_version_id: versionId });

      const ins = db.prepare(
        `INSERT INTO statement_line (id, report_version_id, row_key, rights_type, track_id, artist_raw, title_raw, isrc_raw, upc_raw, code_raw, platform, usage_type, usage_model,
           stream_kind, country, period_month, qty, royalty_kop, royalty_exact, currency_orig, amount_orig, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      a.agg.forEach((l, i) => {
        ins.run(uuidv7(), versionId, l.rowKey, l.rightsType, a.matches[i] ?? null, l.artistRaw, l.titleRaw, l.isrc, l.upc, l.code, l.platform, l.usageType, l.usageModel,
          l.streamKind, l.country, l.periodMonth, l.qty, l.royaltyKop, toExactKop(l.royaltyExact), l.currencyOrig, l.amountOrig, JSON.stringify({ ...l.raw, merged: l.merged, firstRow: l.firstRow }));
      });
      learnIdentifiers(db, ctx, a.learn);
      for (const iss of a.issues) {
        insertRow(db, ctx, 'issue', { kind: iss.kind, entity_type: 'report_version', entity_id: versionId, report_version_id: versionId, details_json: iss.details, status: 'open' });
      }
      const carry = prevVersionId ? carryEdits(db, ctx, prevVersionId, versionId) : { carried: 0, lost: 0 };
      return { reportId, versionId, versionNo, lines: a.agg.length, rowsKop: a.rowsKop, issues: a.issues.length + carry.lost, carried: carry.carried, lost: carry.lost };
    })();
  } catch (e) {
    if (storedAbs && opts.file && existsSync(storedAbs)) {
      const used = db.prepare('SELECT 1 FROM report_version WHERE file_sha256 = ?').get(inp.fileSha);
      if (!used) rmSync(storedAbs, { force: true });
    }
    throw e;
  }
}

/** Трек узнан по названию — запоминаем ISRC (если у трека его не было) и код дистрибьютора, чтобы следующие отчёты находили его сами. */
export function learnIdentifiers(db: Db, ctx: Ctx, learn: Analysis['learn']): void {
  const done = new Set<string>();
  for (const x of learn) {
    const key = `${x.trackId}|${x.isrc ?? ''}|${x.code ?? ''}`;
    if (done.has(key)) continue;
    done.add(key);
    const t = db.prepare('SELECT isrc FROM track WHERE id = ?').get(x.trackId);
    const addIdent = (kind: string, value: string) => {
      if (!db.prepare('SELECT 1 FROM track_identifier WHERE kind = ? AND value_norm = ? AND deleted_at IS NULL').get(kind, value)) insertRow(db, ctx, 'track_identifier', { track_id: x.trackId, kind, value_norm: value });
    };
    if (x.isrc) {
      const used = db.prepare('SELECT 1 FROM track WHERE isrc = ? AND deleted_at IS NULL').get(x.isrc);
      if (t && !t.isrc && isIsrcLike(x.isrc) && !used) updateRow(db, ctx, 'track', x.trackId, { isrc: x.isrc });
      else addIdent('isrc', x.isrc);
    }
    if (x.code) addIdent('distributor_code', x.code.replace(/\s+/g, '').toUpperCase());
  }
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
