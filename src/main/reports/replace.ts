// Замена отчёта (ТЗ §6, Схема_БД §7): сравнение версий по row_key и перенос ручных правок на новую версию.
import { insertRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';

export interface ReplaceDiff {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** Новая сумма по строкам минус старая, копейки. */
  deltaKop: number;
  /** Строк с ручными правками или переносами, которые найдут пару в новой версии. */
  carriedLines: number;
  /** Строк с правками, которым пары нет (уйдут в «Проверить»). */
  lostLines: number;
  /** Примеры изменившихся строк. */
  sample: Array<{ title: string | null; platform: string | null; month: string | null; country: string | null; beforeKop: number; afterKop: number; beforeQty: number; afterQty: number }>;
}

interface NewLine { rowKey: string; qty: number; royaltyKop: number }

interface OldLine { id: string; row_key: string; qty: number; royalty_kop: number; title_raw: string | null; platform: string | null; month: string | null; country: string | null }

function oldLines(db: Db, versionId: string): OldLine[] {
  return db.prepare('SELECT id, row_key, qty, royalty_kop, title_raw, platform, period_month AS month, country FROM statement_line WHERE report_version_id = ?').all(versionId) as OldLine[];
}

function editedLineIds(db: Db, versionId: string): Set<string> {
  const ids = new Set<string>();
  for (const r of db.prepare(
    `SELECT DISTINCT e.line_id AS id FROM line_edit e JOIN statement_line l ON l.id = e.line_id WHERE l.report_version_id = ? AND e.reverted_at IS NULL AND e.deleted_at IS NULL`,
  ).all(versionId)) ids.add(r.id);
  for (const r of db.prepare(
    `SELECT DISTINCT s.line_id AS id FROM line_split s JOIN statement_line l ON l.id = s.line_id WHERE l.report_version_id = ? AND s.reverted_at IS NULL AND s.deleted_at IS NULL`,
  ).all(versionId)) ids.add(r.id);
  return ids;
}

export function diffVersions(db: Db, oldVersionId: string, next: NewLine[]): ReplaceDiff {
  const old = oldLines(db, oldVersionId);
  const oldByKey = new Map(old.map((o) => [o.row_key, o]));
  const nextKeys = new Set(next.map((n) => n.rowKey));
  const d: ReplaceDiff = { added: 0, removed: 0, changed: 0, unchanged: 0, deltaKop: 0, carriedLines: 0, lostLines: 0, sample: [] };
  for (const n of next) {
    const o = oldByKey.get(n.rowKey);
    if (!o) { d.added++; d.deltaKop += n.royaltyKop; continue; }
    if (o.qty !== n.qty || o.royalty_kop !== n.royaltyKop) {
      d.changed++;
      d.deltaKop += n.royaltyKop - o.royalty_kop;
      if (d.sample.length < 10) d.sample.push({ title: o.title_raw, platform: o.platform, month: o.month, country: o.country, beforeKop: o.royalty_kop, afterKop: n.royaltyKop, beforeQty: o.qty, afterQty: n.qty });
    } else d.unchanged++;
  }
  for (const o of old) if (!nextKeys.has(o.row_key)) { d.removed++; d.deltaKop -= o.royalty_kop; }
  for (const id of editedLineIds(db, oldVersionId)) {
    const o = old.find((x) => x.id === id);
    if (o && nextKeys.has(o.row_key)) d.carriedLines++;
    else d.lostLines++;
  }
  return d;
}

/** Переносит действующие правки и переносы прослушиваний старой версии на строки новой с тем же row_key. Непарные → вопросы «Проверить». */
export function carryEdits(db: Db, ctx: Ctx, oldVersionId: string, newVersionId: string): { carried: number; lost: number } {
  const newByKey = new Map<string, string>();
  for (const r of db.prepare('SELECT id, row_key FROM statement_line WHERE report_version_id = ?').all(newVersionId)) newByKey.set(r.row_key, r.id);
  let carried = 0, lost = 0;
  for (const o of oldLines(db, oldVersionId).filter((x) => editedLineIds(db, oldVersionId).has(x.id))) {
    const target = newByKey.get(o.row_key);
    const edits = db.prepare('SELECT field, new_value, batch_id FROM line_edit WHERE line_id = ? AND reverted_at IS NULL AND deleted_at IS NULL ORDER BY id').all(o.id);
    const splits = db.prepare('SELECT qty_moved, to_stream_kind, to_usage_type, rate_per_stream, batch_id FROM line_split WHERE line_id = ? AND reverted_at IS NULL AND deleted_at IS NULL ORDER BY id').all(o.id);
    if (!target) {
      lost++;
      insertRow(db, ctx, 'issue', {
        kind: 'edit_lost_on_replace', entity_type: 'report_version', entity_id: newVersionId, report_version_id: newVersionId, status: 'open',
        details_json: { title: o.title_raw, platform: o.platform, month: o.month, country: o.country, edits: edits.map((e) => `${e.field}=${e.new_value}`), splits: splits.map((s) => `${s.qty_moved}→${s.to_stream_kind}`) },
      });
      continue;
    }
    for (const e of edits) insertRow(db, ctx, 'line_edit', { line_id: target, field: e.field, new_value: e.new_value, batch_id: e.batch_id });
    for (const s of splits) insertRow(db, ctx, 'line_split', { line_id: target, qty_moved: s.qty_moved, to_stream_kind: s.to_stream_kind, to_usage_type: s.to_usage_type, rate_per_stream: s.rate_per_stream, batch_id: s.batch_id });
    carried++;
  }
  return { carried, lost };
}

export interface VersionItem {
  id: string;
  versionNo: number;
  status: string;
  importedAt: string;
  importedBy: string | null;
  fileName: string | null;
  rows: number;
  rowsKop: number;
  current: boolean;
}

export function listVersions(db: Db, reportId: string): VersionItem[] {
  const cur = db.prepare('SELECT current_version_id FROM report WHERE id = ?').get(reportId)?.current_version_id;
  return db.prepare(
    `SELECT v.*, (SELECT count(*) FROM statement_line l WHERE l.report_version_id = v.id) AS n FROM report_version v WHERE v.report_id = ? AND v.deleted_at IS NULL ORDER BY v.version_no DESC`,
  ).all(reportId).map((v) => ({
    id: v.id, versionNo: v.version_no, status: v.status, importedAt: v.imported_at, importedBy: v.imported_by,
    fileName: v.header_json ? ((JSON.parse(v.header_json) as { fileName?: string }).fileName ?? null) : null, rows: v.n, rowsKop: v.total_rows_kop, current: v.id === cur,
  }));
}
