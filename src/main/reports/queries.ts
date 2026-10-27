import { deleteRow, updateRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import type { Flow } from './types.ts';

export interface ReportListItem {
  reportId: string;
  versionId: string;
  distributorId: string;
  distributor: string;
  formatCode: string;
  quarter: string;
  scope: string;
  flow: string;
  versionNo: number;
  versions: number;
  rows: number;
  rowsKop: number;
  footerKop: number | null;
  footerOk: boolean | null;
  importedAt: string;
  importedBy: string | null;
  fileName: string | null;
  openIssues: number;
}

export function listReports(db: Db, quarter?: string): ReportListItem[] {
  const rows = db.prepare(
    `SELECT r.id AS report_id, r.quarter, r.rights_scope, r.flow, d.id AS distributor_id, d.name AS distributor, d.format_code,
            v.id AS version_id, v.version_no, v.imported_at, v.imported_by, v.total_footer_kop, v.total_rows_kop, v.header_json,
            (SELECT count(*) FROM statement_line l WHERE l.report_version_id = v.id) AS n,
            (SELECT count(*) FROM report_version x WHERE x.report_id = r.id AND x.deleted_at IS NULL) AS versions,
            (SELECT count(*) FROM issue i WHERE i.report_version_id = v.id AND i.status = 'open' AND i.deleted_at IS NULL) AS open_issues
       FROM report r JOIN distributor d ON d.id = r.distributor_id JOIN report_version v ON v.id = r.current_version_id
      WHERE r.deleted_at IS NULL AND (? IS NULL OR r.quarter = ?) ORDER BY r.quarter DESC, d.name, r.rights_scope`,
  ).all(quarter ?? null, quarter ?? null);
  return rows.map((r) => {
    const h = r.header_json ? (JSON.parse(r.header_json) as Record<string, unknown>) : {};
    return {
      reportId: r.report_id, versionId: r.version_id, distributorId: r.distributor_id, distributor: r.distributor, formatCode: r.format_code ?? '',
      quarter: r.quarter, scope: r.rights_scope, flow: r.flow, versionNo: r.version_no, versions: r.versions, rows: r.n, rowsKop: r.total_rows_kop,
      footerKop: r.total_footer_kop, footerOk: r.total_footer_kop === null ? null : Math.abs(Number(h.exactSumKop ?? r.total_rows_kop) - r.total_footer_kop) <= Number(h.footerToleranceKop ?? 1),
      importedAt: r.imported_at, importedBy: r.imported_by, fileName: (h.fileName as string) ?? null, openIssues: r.open_issues,
    };
  });
}

export interface QuarterPanel {
  quarter: string;
  quarters: string[];
  distributors: Array<{ id: string; name: string; loaded: boolean; reports: number; rows: number; rowsKop: number; flows: string[] }>;
  totalsByFlow: Record<Flow, number>;
  openIssues: number;
}

/** Панель квартала: какие дистрибьюторы загружены, сколько строк и денег. Выплаты и маржа появятся с расчётом (этап 4). */
export function quarterPanel(db: Db, quarter?: string): QuarterPanel {
  const quarters = db.prepare('SELECT DISTINCT quarter FROM report WHERE deleted_at IS NULL ORDER BY quarter DESC').all().map((r) => String(r.quarter));
  const q = quarter ?? quarters[0] ?? '';
  const reports = listReports(db, q);
  const dists = db.prepare('SELECT id, name FROM distributor WHERE deleted_at IS NULL ORDER BY name').all();
  const totals: Record<Flow, number> = { artists: 0, personal: 0, ignore: 0 };
  for (const r of reports) totals[r.flow as Flow] += r.rowsKop;
  return {
    quarter: q,
    quarters,
    distributors: dists.map((d) => {
      const rs = reports.filter((r) => r.distributorId === d.id);
      return { id: d.id, name: d.name, loaded: rs.length > 0, reports: rs.length, rows: rs.reduce((a, r) => a + r.rows, 0), rowsKop: rs.reduce((a, r) => a + r.rowsKop, 0), flows: [...new Set(rs.map((r) => r.flow))] };
    }),
    totalsByFlow: totals,
    openIssues: reports.reduce((a, r) => a + r.openIssues, 0),
  };
}

export function setReportFlow(db: Db, ctx: Ctx, reportId: string, flow: Flow): void {
  if (!['artists', 'personal', 'ignore'].includes(flow)) throw new Error('Неизвестный маршрут отчёта');
  updateRow(db, ctx, 'report', reportId, { flow });
}

/**
 * Удаление отчёта целиком (все версии). Мягкое: запись остаётся в истории, файл-оригинал остаётся на диске,
 * открытые вопросы по нему закрываются. После удаления тот же файл и тот же квартал можно загрузить заново.
 */
export function deleteReport(db: Db, ctx: Ctx, reportId: string): { versions: number; closedIssues: number } {
  return db.transaction(() => {
    const rep = db.prepare('SELECT id FROM report WHERE id = ? AND deleted_at IS NULL').get(reportId);
    if (!rep) throw new Error('Отчёт не найден (возможно, уже удалён)');
    const versions = db.prepare('SELECT id FROM report_version WHERE report_id = ? AND deleted_at IS NULL').all(reportId);
    const now = new Date().toISOString();
    let closed = 0;
    for (const v of versions) {
      const open = db.prepare("SELECT id FROM issue WHERE report_version_id = ? AND status = 'open' AND deleted_at IS NULL").all(v.id);
      for (const i of open) {
        updateRow(db, ctx, 'issue', i.id, { status: 'ignored', resolved_at: now, resolved_by: ctx.userId, resolution_json: { auto: 'report_deleted' } });
        closed++;
      }
      deleteRow(db, ctx, 'report_version', v.id);
    }
    deleteRow(db, ctx, 'report', reportId);
    return { versions: versions.length, closedIssues: closed };
  })();
}
