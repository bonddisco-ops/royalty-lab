// Комплект для получателя: Excel + PDF-ведомость, запись payout_statement. Файлы лежат в output/<квартал>/<получатель>/.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting } from '../db/init.ts';
import { insertRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import { computeQuarter, rowsOfGroup } from './calc.ts';
import { ensurePeriod } from './store.ts';
import { fmtRubPdf, statementHtml } from './statementHtml.ts';
import { buildStatementXlsx } from './xlsxOut.ts';

/** Лицензиат во всех договорах — константа (ТЗ §4). */
export const LICENSEE = 'ИП Федотов Иван Васильевич';

export interface GenerateOptions { city: string; date: string }
export interface Generated { groupKey: string; payee: string; versionNo: number; folder: string; xlsx: string; pdf: string }
export type PdfRenderer = (html: string) => Promise<Buffer>;

export const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 80) || 'Получатель';

export async function generateStatement(db: Db, ctx: Ctx, outputDir: string, quarter: string, groupKey: string, opts: GenerateOptions, renderPdf: PdfRenderer): Promise<Generated> {
  if (!/^\d{4}Q[1-4]$/.test(quarter)) throw new Error('Некорректный квартал');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error('Дата в виде 2026-09-21');
  if (!opts.city.trim()) throw new Error('Укажите город для ведомости');
  const g = computeQuarter(db, quarter).groups.find((x) => x.key === groupKey);
  if (!g) throw new Error('Получатель не найден в этом квартале');
  if (!g.contractId || !g.contractNumber) throw new Error('У получателя нет договора: номер договора нужен для ведомости');
  const cp = db.prepare('SELECT * FROM counterparty WHERE id = ?').get(g.payeeId);
  if (!cp) throw new Error('Получатель не найден');

  const rows = rowsOfGroup(db, quarter, groupKey);
  const byArtist = new Map<string, typeof rows>();
  for (const r of rows) {
    const a = byArtist.get(r.artistName) ?? [];
    a.push(r);
    byArtist.set(r.artistName, a);
  }
  const xl = buildStatementXlsx([...byArtist.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([name, rs]) => ({ name, rows: rs })), getSetting(db, 'hidden_deduction'));
  if (xl.totalKop !== g.accruedKop) throw new Error(`Внутренняя ошибка: итог Excel (${xl.totalKop}) не совпал с расчётом (${g.accruedKop})`);

  const html = statementHtml({
    quarter, city: opts.city.trim(), date: opts.date, streams: g.qty, ratePct: g.labelRatePct, netKop: g.accruedKop, accumulatedKop: g.carriedInKop, payableKop: g.payableKop,
    payeeName: g.payeeName, inn: cp.inn ?? null, contractNumber: g.contractNumber, licensee: LICENSEE,
    heldNote: g.thresholdApplied ? `Сумма ниже порога выплаты (${fmtRubPdf(g.thresholdKop ?? 0)}) и переносится на следующий Отчётный период.` : null,
  });
  const pdf = await renderPdf(html);

  return db.transaction(() => {
    const periodId = ensurePeriod(db, ctx, quarter, g);
    const versionNo = Number(db.prepare('SELECT max(version_no) AS m FROM payout_statement WHERE payout_period_id = ?').get(periodId)?.m ?? 0) + 1;
    const folderRel = `${quarter}/${safeName(g.payeeName)}`;
    const folder = join(outputDir, quarter, safeName(g.payeeName));
    mkdirSync(folder, { recursive: true });
    const base = `${safeName(g.payeeName.split(' ')[0] ?? 'Ведомость')} ${quarter}${versionNo > 1 ? ` v${versionNo}` : ''}`;
    let stem = base, k = 2;
    while (existsSync(join(folder, `${stem}.pdf`)) || existsSync(join(folder, `${stem}.xlsx`))) stem = `${base} (${k++})`;
    writeFileSync(join(folder, `${stem}.xlsx`), xl.buffer);
    writeFileSync(join(folder, `${stem}.pdf`), pdf);
    const versionIds = [...new Set(rows.map((r) => r.reportId))].sort();
    insertRow(db, ctx, 'payout_statement', {
      payout_period_id: periodId, version_no: versionNo, xlsx_file: `${folderRel}/${stem}.xlsx`, pdf_file: `${folderRel}/${stem}.pdf`,
      generated_at: new Date().toISOString(), generated_by: ctx.userId, status: 'current',
      source_versions_json: { digest: g.digest, reports: versionIds, quarter, accruedKop: g.accruedKop, payableKop: g.payableKop, city: opts.city.trim(), date: opts.date },
    });
    return { groupKey, payee: g.payeeName, versionNo, folder: folderRel, xlsx: `${folderRel}/${stem}.xlsx`, pdf: `${folderRel}/${stem}.pdf` };
  })();
}
