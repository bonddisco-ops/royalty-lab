// Хранение итогов выплат и выданных комплектов (payout_period, payout_statement) поверх расчёта.
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { deleteRow, insertRow, updateRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import { computeQuarter, type GroupCalc, type QuarterCalc } from './calc.ts';

export interface StatementInfo {
  id: string;
  versionNo: number;
  generatedAt: string;
  generatedBy: string | null;
  xlsxFile: string | null;
  pdfFile: string | null;
  stale: boolean;
  /** Записана в базе, но файла нет на этом компьютере (ведомость сделал другой пользователь, файл не доехал). */
  filesMissing: boolean;
}

export interface PayoutRow extends GroupCalc {
  periodId: string | null;
  status: 'draft' | 'ready' | 'paid';
  paidKop: number | null;
  paidDate: string | null;
  statement: StatementInfo | null;
}

export interface PayoutsView {
  quarter: string;
  quarters: string[];
  calc: Omit<QuarterCalc, 'groups'>;
  rows: PayoutRow[];
}

export function payoutQuarters(db: Db): string[] {
  return db.prepare("SELECT DISTINCT quarter FROM report WHERE deleted_at IS NULL AND flow = 'artists' ORDER BY quarter DESC").all().map((r) => String(r.quarter));
}

function findPeriod(db: Db, g: GroupCalc, quarter: string) {
  return db.prepare('SELECT * FROM payout_period WHERE counterparty_id = ? AND ifnull(contract_id, \'\') = ? AND quarter = ? AND deleted_at IS NULL').get(g.payeeId, g.contractId ?? '', quarter);
}

/** Период в базе: создаём при первом обращении, числа обновляем из актуального расчёта (выплаты и статус не трогаем). */
export function ensurePeriod(db: Db, ctx: Ctx, quarter: string, g: GroupCalc): string {
  const vals = {
    accrued_kop: g.accruedKop, carried_in_kop: g.carriedInKop, payable_kop: g.payableKop, carried_out_kop: g.carriedOutKop,
    threshold_applied: g.thresholdApplied ? 1 : 0, accumulated_total_kop: g.carriedInKop,
  };
  const cur = findPeriod(db, g, quarter);
  if (!cur) return insertRow(db, ctx, 'payout_period', { counterparty_id: g.payeeId, contract_id: g.contractId, quarter, ...vals, status: 'draft' });
  const changed = Object.entries(vals).some(([k, v]) => Number(cur[k]) !== Number(v));
  if (changed) updateRow(db, ctx, 'payout_period', cur.id, vals);
  return cur.id;
}

export function latestStatement(db: Db, periodId: string, digest: string, outputDir?: string): StatementInfo | null {
  const s = db.prepare('SELECT * FROM payout_statement WHERE payout_period_id = ? AND deleted_at IS NULL ORDER BY version_no DESC').get(periodId);
  if (!s) return null;
  const src = JSON.parse(s.source_versions_json) as { digest?: string };
  return { id: s.id, versionNo: s.version_no, generatedAt: s.generated_at, generatedBy: s.generated_by, xlsxFile: s.xlsx_file, pdfFile: s.pdf_file, stale: src.digest !== digest, filesMissing: !!outputDir && [s.xlsx_file, s.pdf_file].some((f: string | null) => !!f && !existsSync(join(outputDir, ...f.split('/')))) };
}

/** Данные вкладки «Выплаты». Чтение не пишет в базу: периоды создаются при выдаче комплекта или отметке «выплачено». */
export function payoutsView(db: Db, quarter?: string, outputDir?: string): PayoutsView {
  const quarters = payoutQuarters(db);
  const q = quarter ?? quarters[0] ?? '';
  if (!q) return { quarter: '', quarters, calc: { quarter: '', owner: null, carry: { kop: 0, people: 0 }, montage: null, problems: [], totals: { flowRoyaltyKop: 0, allocatedKop: 0, unallocatedKop: 0, accruedKop: 0, payableKop: 0, marginKop: 0 } }, rows: [] };
  const { groups, ...calc } = computeQuarter(db, q);
  const rows: PayoutRow[] = groups.map((g) => {
    const p = findPeriod(db, g, q);
    return {
      ...g,
      periodId: p?.id ?? null,
      status: p?.status ?? 'draft',
      paidKop: p?.paid_kop ?? null,
      paidDate: p?.paid_date ?? null,
      statement: p ? latestStatement(db, p.id, g.digest, outputDir) : null,
    };
  });
  return { quarter: q, quarters, calc, rows };
}

export function markPaid(db: Db, ctx: Ctx, quarter: string, groupKey: string, status: 'draft' | 'ready' | 'paid', paidKop: number | null, paidDate: string | null): void {
  db.transaction(() => {
    const g = computeQuarter(db, quarter).groups.find((x) => x.key === groupKey);
    if (!g) throw new Error('Получатель не найден в этом квартале');
    if (status === 'paid' && (paidKop === null || paidKop < 0)) throw new Error('Укажите выплаченную сумму');
    if (paidDate && !/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) throw new Error('Дата в виде 2026-09-21');
    const id = ensurePeriod(db, ctx, quarter, g);
    updateRow(db, ctx, 'payout_period', id, { status, paid_kop: status === 'paid' ? paidKop : null, paid_date: status === 'paid' ? paidDate : null });
  })();
}

/**
 * Удалить последний выданный комплект получателя за квартал (пробный, ошибочный): запись скрывается, файлы Excel и PDF стираются.
 * Более ранняя версия, если была, снова становится текущей. Можно сразу выпускать новый комплект.
 */
export function deleteLatestStatement(db: Db, ctx: Ctx, outputDir: string, quarter: string, groupKey: string): { versionNo: number; files: number } {
  const [payeeId = '', contractId = ''] = groupKey.split('|');
  const period = db.prepare("SELECT id FROM payout_period WHERE counterparty_id = ? AND ifnull(contract_id, '') = ? AND quarter = ? AND deleted_at IS NULL").get(payeeId, contractId, quarter);
  if (!period) throw new Error('Комплект не найден');
  const st = db.prepare('SELECT * FROM payout_statement WHERE payout_period_id = ? AND deleted_at IS NULL ORDER BY version_no DESC').get(period.id);
  if (!st) throw new Error('У этого получателя нет выданного комплекта');
  let files = 0;
  const root = resolve(outputDir);
  for (const rel of [st.xlsx_file, st.pdf_file]) {
    if (!rel) continue;
    const abs = resolve(root, String(rel));
    if (abs.startsWith(root + sep) && existsSync(abs)) { rmSync(abs, { force: true }); files++; }
  }
  deleteRow(db, ctx, 'payout_statement', st.id);
  return { versionNo: Number(st.version_no), files };
}
