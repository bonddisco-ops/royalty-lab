// Налоги ИП на УСН «доходы» 6% без работников: авансы нарастающим итогом, зачёт взносов, взносы за себя.
// Чистые числа, без БД. Деньги — целые копейки. Ставки и пороги приходят параметрами (их можно править по годам).

export interface TaxParams {
  ratePct: number;        // ставка УСН, %
  fixedKop: number;       // фиксированные взносы за год
  opsFixedKop: number;    // из них пенсионная часть (нужна, чтобы посчитать потолок «1%»)
  capKop: number;         // предельный размер пенсионных взносов за год (фикс + 1%)
  extraFromKop: number;   // порог дохода для «1%»
  extraPct: number;       // % свыше порога
}
export interface Receipt { date: string; kop: number }
export interface TaxPay { kind: 'fixed' | 'extra' | 'usn'; period: string | null; date: string; kop: number; deductYear: number }

export type PeriodKey = 'Q1' | 'H1' | 'M9' | 'Y';
export const PERIODS: Array<{ key: PeriodKey; label: string; end: string; due: (year: number) => string }> = [
  { key: 'Q1', label: '1 квартал', end: '03-31', due: (y) => `${y}-04-28` },
  { key: 'H1', label: 'Полугодие', end: '06-30', due: (y) => `${y}-07-28` },
  { key: 'M9', label: '9 месяцев', end: '09-30', due: (y) => `${y}-10-28` },
  { key: 'Y', label: 'Год (налог по итогам)', end: '12-31', due: (y) => `${y + 1}-04-28` },
];

export interface PeriodCalc {
  key: PeriodKey; label: string; end: string; due: string;
  incomeKop: number;      // доход нарастающим итогом
  taxKop: number;         // налог 6% с нарастающего дохода
  deductKop: number;      // принятые взносы (не больше налога)
  netKop: number;         // налог после зачёта, нарастающим итогом
  toPayKop: number;       // к уплате за этот период (после вычета уже посчитанных авансов)
  overKop: number;        // уменьшение/переплата к зачёту (только если расчёт отрицательный)
  paidKop: number;        // отмечено уплаченным по этому периоду
  leftKop: number;        // осталось доплатить
}
export interface Contribs {
  fixedKop: number; extraKop: number; extraCapKop: number; incomeKop: number;
  fixedPaidKop: number; extraPaidKop: number; fixedLeftKop: number; extraLeftKop: number;
  fixedDue: string; extraDue: string;
}
export interface TaxCalc { year: number; periods: PeriodCalc[]; contribs: Contribs; totalIncomeKop: number }

export const DEFAULT_PARAMS: Record<number, TaxParams> = {
  2026: { ratePct: 6, fixedKop: 5_739_000, opsFixedKop: 4_022_725, capKop: 32_181_800, extraFromKop: 30_000_000, extraPct: 1 },
  2025: { ratePct: 6, fixedKop: 5_365_800, opsFixedKop: 3_761_100, capKop: 30_088_800, extraFromKop: 30_000_000, extraPct: 1 },
};
export const paramsFor = (year: number): TaxParams => DEFAULT_PARAMS[year] ?? DEFAULT_PARAMS[2026]!;

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export function computeTax(year: number, receipts: Receipt[], pays: TaxPay[], p: TaxParams, today = ''): TaxCalc {
  const yr = receipts.filter((r) => r.date.startsWith(String(year)));
  const periods: PeriodCalc[] = [];
  let prevToPay = 0;
  for (const per of PERIODS) {
    const end = `${year}-${per.end}`;
    const incomeKop = sum(yr.filter((r) => r.date <= end).map((r) => r.kop));
    const taxKop = Math.floor((incomeKop * p.ratePct) / 100);
    const ded = sum(pays.filter((x) => (x.kind === 'fixed' || x.kind === 'extra') && x.deductYear === year && (per.key === 'Y' || x.date <= end)).map((x) => x.kop));
    const deductKop = Math.min(ded, taxKop); // ИП без работников: вплоть до 100% налога
    const netKop = taxKop - deductKop;
    const raw = netKop - prevToPay;
    const toPayKop = Math.max(0, raw);
    const paidKop = sum(pays.filter((x) => x.kind === 'usn' && x.period === per.key && x.deductYear === year).map((x) => x.kop));
    periods.push({ key: per.key, label: per.label, end, due: per.due(year), incomeKop, taxKop, deductKop, netKop, toPayKop, overKop: raw < 0 ? -raw : 0, paidKop, leftKop: Math.max(0, toPayKop - paidKop) });
    prevToPay += toPayKop;
  }
  const incomeYear = periods[3]!.incomeKop;
  const extraCapKop = Math.max(0, p.capKop - p.opsFixedKop);
  const extraKop = Math.min(extraCapKop, Math.floor((Math.max(0, incomeYear - p.extraFromKop) * p.extraPct) / 100));
  const paid = (k: 'fixed' | 'extra'): number => sum(pays.filter((x) => x.kind === k && x.deductYear === year).map((x) => x.kop));
  const contribs: Contribs = {
    fixedKop: p.fixedKop, extraKop, extraCapKop, incomeKop: incomeYear,
    fixedPaidKop: paid('fixed'), extraPaidKop: paid('extra'),
    fixedLeftKop: Math.max(0, p.fixedKop - paid('fixed')), extraLeftKop: Math.max(0, extraKop - paid('extra')),
    fixedDue: `${year}-12-31`, extraDue: `${year + 1}-07-01`,
  };
  void today;
  return { year, periods, contribs, totalIncomeKop: incomeYear };
}
