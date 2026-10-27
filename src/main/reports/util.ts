import type { Cell, Rows } from './types.ts';

export const MONTHS_GEN: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6, июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};

export function str(v: Cell | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** Число из ячейки: 12.5, "12,5", "1 234,56", "70%" (→ 70). Не число → null. */
export function num(v: Cell | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = str(v);
  if (s === null) return null;
  const t = s.replace(/\s/g, '').replace(',', '.').replace(/%$/, '');
  if (!/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(t)) return null;
  return Number(t);
}

/** "70%" → "0.7"; 0.7 → "0.7"; 70 → "0.7". */
export function rateToShare(v: Cell | undefined): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const share = typeof v === 'string' && v.includes('%') ? n / 100 : n > 1 ? n / 100 : n;
  return String(Number(share.toPrecision(10)));
}

/** Рубли → точные копейки десятичной строкой (до 6 знаков), без округления до копейки: 0.003614 ₽ → "0.3614". */
export function toExactKop(rub: number): string {
  const v = Number((rub * 100).toPrecision(14));
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** Рубли → копейки, до ближайшей копейки (поправка на двоичную дробь: 0.285 → 29). */
export function toKop(rub: number): number {
  return Math.round(Number((rub * 100).toPrecision(14)));
}

/** Нормализация подписи колонки: без переносов, регистра, "/" и лишних пробелов. */
export function lab(v: Cell | undefined): string {
  return (str(v) ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s/]+/g, ' ').trim();
}

export const quarterOf = (year: number, month: number): string => `${year}Q${Math.ceil(month / 3)}`;

/** "01 июля 2026" | "1 июля 2026 г." → "2026-07-01". */
export function parseRuLongDate(s: string): string | null {
  const m = /(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(s);
  if (!m) return null;
  const mon = MONTHS_GEN[m[2]!.toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
}

/** "01.07.2026" → "2026-07-01". */
export function parseDotDate(s: string): string | null {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

/** Все ячейки листа одной строкой (для поиска фраз в шапке). */
export function rowText(row: Cell[] | undefined): string {
  return (row ?? []).map((c) => str(c) ?? '').filter(Boolean).join(' ');
}

export function findRow(rows: Rows, test: (text: string, row: Cell[]) => boolean, from = 0, to = rows.length): number {
  for (let i = from; i < Math.min(to, rows.length); i++) if (test(rowText(rows[i]), rows[i]!)) return i;
  return -1;
}

export const isIsrcLike = (s: string | null): boolean => !!s && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(s.replace(/[\s-]/g, ''));

export function cleanIsrc(v: Cell | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  const t = s.replace(/[\s-]/g, '').toUpperCase();
  return isIsrcLike(t) ? t : s.toUpperCase();
}

/** Квартал из имени файла: "…2026Q3…", "2026_Q3", "Q3 2026", "3 кв 2026". */
export function quarterFromFileName(name: string): string | null {
  let m = /(20\d\d)[\s_.-]?Q([1-4])/i.exec(name);
  if (m) return `${m[1]}Q${m[2]}`;
  m = /Q([1-4])[\s_.-]?(20\d\d)/i.exec(name);
  if (m) return `${m[2]}Q${m[1]}`;
  m = /([1-4])\s*кв\.?[\s_.-]*(20\d\d)/i.exec(name);
  return m ? `${m[2]}Q${m[1]}` : null;
}

/** Период строки ('YYYY-MM' | 'YYYY-Qn' | 'YYYY') → месяц/квартал для вывода квартала по самому позднему периоду. */
export function quarterFromPeriod(p: string | null): string | null {
  if (!p) return null;
  let m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return quarterOf(Number(m[1]), Number(m[2]));
  m = /^(\d{4})-Q([1-4])$/.exec(p);
  return m ? `${m[1]}Q${m[2]}` : null;
}

export function sumBy<T>(list: T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of list) s += f(x);
  return s;
}
