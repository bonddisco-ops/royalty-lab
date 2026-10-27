import { insertRow, deleteRow, updateRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import { computeTax, paramsFor, type TaxCalc, type TaxParams, type TaxPay } from './calc.ts';

export interface ReceiptItem { id: string; date: string; kop: number; source: string | null; note: string | null }
export interface PaymentItem { id: string; year: number; kind: 'fixed' | 'extra' | 'usn'; period: string | null; date: string; kop: number; note: string | null }
export interface TaxView { year: number; years: number[]; params: TaxParams; defaults: boolean; receipts: ReceiptItem[]; payments: PaymentItem[]; calc: TaxCalc; sources: string[] }

const PARAM_KEYS: Array<[keyof TaxParams, string]> = [['ratePct', 'rate_pct'], ['fixedKop', 'fixed_kop'], ['opsFixedKop', 'ops_fixed_kop'], ['capKop', 'cap_kop'], ['extraFromKop', 'extra_from_kop'], ['extraPct', 'extra_pct']];
const sid = (year: number, k: string): string => `tax.${year}.${k}`;

export function getParams(db: Db, year: number): { params: TaxParams; defaults: boolean } {
  const base = paramsFor(year);
  const out = { ...base };
  let any = false;
  for (const [k, name] of PARAM_KEYS) {
    const r = db.prepare('SELECT value FROM settings WHERE id = ? AND deleted_at IS NULL').get(sid(year, name));
    if (r) { const n = Number(r.value); if (Number.isFinite(n)) { out[k] = n; any = true; } }
  }
  return { params: out, defaults: !any };
}

export function setParams(db: Db, ctx: Ctx, year: number, p: TaxParams): void {
  for (const [k, name] of PARAM_KEYS) {
    const v = p[k];
    if (!Number.isFinite(v) || v < 0) throw new Error('Параметры налога должны быть неотрицательными числами');
  }
  if (p.ratePct > 100 || p.extraPct > 100) throw new Error('Ставка не может быть больше 100%');
  db.transaction(() => {
    for (const [k, name] of PARAM_KEYS) {
      const id = sid(year, name);
      if (db.prepare('SELECT 1 FROM settings WHERE id = ?').get(id)) updateRow(db, ctx, 'settings', id, { value: String(Math.round(p[k] * 100) / 100) });
      else insertRow(db, ctx, 'settings', { id, value: String(Math.round(p[k] * 100) / 100) });
    }
  })();
}

const okDate = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));

export function addReceipt(db: Db, ctx: Ctx, r: { date: string; kop: number; source?: string | null; note?: string | null }): string {
  if (!okDate(r.date)) throw new Error('Укажите дату получения денег');
  if (!Number.isInteger(r.kop) || r.kop <= 0) throw new Error('Сумма должна быть больше нуля');
  return insertRow(db, ctx, 'income_receipt', { received_date: r.date, amount_kop: r.kop, source: r.source?.trim() || null, note: r.note?.trim() || null });
}
export const deleteReceipt = (db: Db, ctx: Ctx, id: string): void => deleteRow(db, ctx, 'income_receipt', id);

export function addPayment(db: Db, ctx: Ctx, p: { year: number; kind: 'fixed' | 'extra' | 'usn'; period?: string | null; date: string; kop: number; note?: string | null }): string {
  if (!okDate(p.date)) throw new Error('Укажите дату платежа');
  if (!Number.isInteger(p.kop) || p.kop <= 0) throw new Error('Сумма должна быть больше нуля');
  if (!['fixed', 'extra', 'usn'].includes(p.kind)) throw new Error('Неизвестный вид платежа');
  if (p.kind === 'usn' && !['Q1', 'H1', 'M9', 'Y'].includes(p.period ?? '')) throw new Error('Для налога укажите, за какой период платёж');
  return insertRow(db, ctx, 'tax_payment', { deduct_year: p.year, kind: p.kind, period: p.kind === 'usn' ? p.period : null, paid_date: p.date, amount_kop: p.kop, note: p.note?.trim() || null });
}
export const deletePayment = (db: Db, ctx: Ctx, id: string): void => deleteRow(db, ctx, 'tax_payment', id);

export function taxView(db: Db, yearIn?: number): TaxView {
  const thisYear = new Date().getFullYear();
  const year = yearIn ?? thisYear;
  const rec = db.prepare('SELECT * FROM income_receipt WHERE deleted_at IS NULL ORDER BY received_date, created_at').all();
  const receipts: ReceiptItem[] = rec.filter((r) => String(r.received_date).startsWith(String(year))).map((r) => ({ id: String(r.id), date: String(r.received_date), kop: Number(r.amount_kop), source: r.source ?? null, note: r.note ?? null }));
  const pay = db.prepare('SELECT * FROM tax_payment WHERE deleted_at IS NULL AND deduct_year = ? ORDER BY paid_date, created_at').all(year);
  const payments: PaymentItem[] = pay.map((r) => ({ id: String(r.id), year: Number(r.deduct_year), kind: r.kind, period: r.period ?? null, date: String(r.paid_date), kop: Number(r.amount_kop), note: r.note ?? null }));
  const { params, defaults } = getParams(db, year);
  const years = [...new Set([thisYear, thisYear - 1, year, ...rec.map((r) => Number(String(r.received_date).slice(0, 4)))])].sort((a, b) => b - a);
  const sources = [...new Set([...db.prepare('SELECT DISTINCT name FROM distributor WHERE deleted_at IS NULL').all().map((r) => String(r.name)), ...rec.map((r) => String(r.source ?? '')).filter(Boolean)])].sort();
  const pays: TaxPay[] = payments.map((x) => ({ kind: x.kind, period: x.period, date: x.date, kop: x.kop, deductYear: x.year }));
  return { year, years, params, defaults, receipts, payments, calc: computeTax(year, receipts.map((r) => ({ date: r.date, kop: r.kop })), pays, params), sources };
}

const rub = (k: number): string => (k / 100).toFixed(2).replace('.', ',');
/** CSV для бухгалтера (Excel откроет, разделитель «;»). */
export function taxCsv(v: TaxView): string {
  const L: string[] = [];
  const q = (s: string | number | null): string => `"${String(s ?? '').replace(/"/g, '""')}"`;
  L.push(`Налоги ИП, УСН ${v.params.ratePct}% «доходы», ${v.year} год`);
  L.push('');
  L.push(['Период', 'Доход нарастающим', 'Налог', 'Принято взносов', 'Налог после зачёта', 'К уплате за период', 'Уплачено', 'Осталось', 'Срок'].map(q).join(';'));
  for (const p of v.calc.periods) L.push([p.label, rub(p.incomeKop), rub(p.taxKop), rub(p.deductKop), rub(p.netKop), rub(p.toPayKop), rub(p.paidKop), rub(p.leftKop), p.due].map(q).join(';'));
  L.push('');
  const c = v.calc.contribs;
  L.push(['Взносы за себя', 'Начислено', 'Уплачено', 'Осталось', 'Срок'].map(q).join(';'));
  L.push(['Фиксированные', rub(c.fixedKop), rub(c.fixedPaidKop), rub(c.fixedLeftKop), c.fixedDue].map(q).join(';'));
  L.push([`1% свыше ${rub(v.params.extraFromKop)}`, rub(c.extraKop), rub(c.extraPaidKop), rub(c.extraLeftKop), c.extraDue].map(q).join(';'));
  L.push('');
  L.push(['Поступления', 'Дата', 'Сумма', 'Источник', 'Примечание'].map(q).join(';'));
  for (const r of v.receipts) L.push(['', r.date, rub(r.kop), r.source, r.note].map(q).join(';'));
  L.push('');
  L.push(['Платежи', 'Дата', 'Сумма', 'Вид', 'Период', 'Примечание'].map(q).join(';'));
  for (const p of v.payments) L.push(['', p.date, rub(p.kop), p.kind === 'fixed' ? 'Фиксированные взносы' : p.kind === 'extra' ? 'Взносы 1%' : 'Налог УСН', p.period ?? '', p.note].map(q).join(';'));
  return '﻿' + L.join('\r\n');
}
