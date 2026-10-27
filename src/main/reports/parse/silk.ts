// Silk (ООО «СИЛК»): лист «TDSheet»; в шапке договор и доход лицензиата, ниже разделы «Авторские права» и «Смежные права».
// В строках суммы — доход лицензиата; роялти лицензиара = сумма × ставка из шапки («Вознаграждение Лицензиару 75,0%»).
import { FormatError, type Cell, type ParsedLine, type ParsedReport, type RightsType, type StreamKind, type WorkbookData } from '../types.ts';
import { findRow, lab, num, parseDotDate, quarterOf, rowText, str } from '../util.ts';

export function detectSilk(wb: WorkbookData): boolean {
  const s = wb.sheets.find((x) => x.name.toLowerCase() === 'tdsheet');
  if (!s) return false;
  return findRow(s.rows, (t) => /Договор\s*№\s*СИЛК|ООО\s*"?«?СИЛК/i.test(t), 0, 10) >= 0;
}

export function streamKindSilk(usage: string | null): StreamKind {
  const u = (usage ?? '').toLowerCase();
  if (u === 'подписка' || u === 'пробная подписка') return 'paid';
  if (u === 'аудиостриминг' || u === 'аудио') return 'ad';
  if (u === 'рбт') return 'nonstream';
  return 'other'; // видео, загрузка, облачный сервис
}

/** '10.2025' → '2025-10', '7-9.2025' → '2025-Q3', 2024 → '2024'. */
export function silkPeriod(v: Cell | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  let m = /^(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{1,2})-(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return Math.ceil(a / 3) === Math.ceil(b / 3) && b - a >= 2 ? `${m[3]}-Q${Math.ceil(a / 3)}` : `${m[3]}-${m[1]!.padStart(2, '0')}`;
  }
  m = /^(\d{4})$/.exec(s);
  return m ? m[1]! : s;
}

export function parseSilk(wb: WorkbookData): ParsedReport {
  const s = wb.sheets.find((x) => x.name.toLowerCase() === 'tdsheet');
  if (!s) throw new FormatError('Нет листа «TDSheet»');
  const rows = s.rows;
  const warnings: string[] = [];
  const head = rows.slice(0, 30).map(rowText);
  const contract = head.find((t) => /^Договор/i.test(t))?.replace(/^Договор\s*№?\s*/i, '') ?? null;
  const per = head.find((t) => /Отчет за период/i.test(t)) ?? '';
  const pm = /(\d{2}\.\d{2}\.\d{4})\s+по\s+(\d{2}\.\d{2}\.\d{4})/i.exec(per);
  const from = pm ? parseDotDate(pm[1]!) : null;
  const to = pm ? parseDotDate(pm[2]!) : null;
  const rewardRow = rows.slice(0, 30).find((r) => /Вознаграждение Лицензиару/i.test(rowText(r)));
  const rewardText = rewardRow ? rowText(rewardRow) : '';
  const rm = /Лицензиару\s+([\d.,]+)\s*%/i.exec(rewardText);
  const share = rm ? Number(rm[1]!.replace(',', '.')) / 100 : null;
  const reward = rewardRow ? rewardRow.map(num).find((x) => x !== null) ?? null : null;
  const incomeRow = rows.slice(0, 30).find((r) => /Итого доход Лицензиата/i.test(rowText(r)));
  const income = incomeRow ? incomeRow.map(num).find((x) => x !== null) ?? null : null;
  if (share === null) throw new FormatError('Не нашёл ставку «Вознаграждение Лицензиару N%» в шапке отчёта');

  const lines: ParsedLine[] = [];
  let sumAmount = 0;
  let section: RightsType | null = null;
  let col: Record<string, number> | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const first = str(row[0]);
    if (first && /^авторские права$/i.test(first) && row.filter((c) => c !== null).length === 1) { section = 'authors'; col = null; continue; }
    if (first && /^смежные права$/i.test(first) && row.filter((c) => c !== null).length === 1) { section = 'related'; col = null; continue; }
    if (!section) continue;
    if (!col) {
      if (first && lab(first) === 'код') {
        col = {};
        row.forEach((c, k) => { const l = lab(c); if (l) col![l] = k; });
      }
      continue;
    }
    if (first && /^итого/i.test(first)) { col = null; section = null; continue; }
    if (row.every((c) => c === null)) continue;
    const iAmount = col['сумма'];
    const iQty = col['тираж'];
    if (iAmount === undefined || iQty === undefined) throw new FormatError('В разделе нет колонок «Сумма» / «Тираж»');
    let amount = num(row[iAmount]);
    let qty = num(row[iQty]);
    if (amount === null) {
      // подписи колонок съехали относительно данных: берём два последних числа строки как сумму и тираж
      const nums = row.map((c, k) => [k, num(c)] as const).filter((x): x is readonly [number, number] => x[1] !== null && x[0] > 3);
      if (nums.length >= 2) { amount = nums[nums.length - 2]![1]; qty = nums[nums.length - 1]![1]; warnings.push(`Строка ${i + 1}: подписи колонок съехали, сумма и тираж взяты по положению чисел`); }
      else { warnings.push(`Строка ${i + 1}: нет суммы, пропущена`); continue; }
    }
    const usage = str(row[col['видиспользования'] ?? -1]);
    sumAmount += amount;
    lines.push({
      rightsType: section,
      artistRaw: str(row[col['исполнитель'] ?? -1]),
      titleRaw: str(row[col['наименование'] ?? -1]),
      isrcRaw: null,
      upcRaw: null,
      codeRaw: first,
      platform: str(row[col['площадка'] ?? -1]),
      usageType: usage,
      usageModel: null,
      streamKind: streamKindSilk(usage),
      country: null,
      periodMonth: silkPeriod(row[col['период'] ?? -1]),
      qty: qty ?? 0,
      royalty: amount * share,
      currencyOrig: 'RUB',
      amountOrig: amount,
      srcRow: i + 1,
      raw: { album: str(row[col['альбом'] ?? -1]) },
    });
  }
  if (lines.length === 0) throw new FormatError('В отчёте Silk нет строк в разделах «Авторские права» / «Смежные права»');
  if (income !== null && Math.abs(income - sumAmount) > 0.01) warnings.push(`Сумма строк ${sumAmount.toFixed(2)} не равна «Итого доход Лицензиата» ${income.toFixed(2)}`);
  const q = from ? quarterOf(Number(from.slice(0, 4)), Number(from.slice(5, 7))) : null;
  return {
    formatCode: 'silk',
    distributorName: 'Silk',
    rightsScope: 'mixed',
    defaultFlow: 'artists',
    licensorShare: String(Number(share.toPrecision(10))),
    quarter: q,
    quarterSource: q ? 'text' : null,
    periodFrom: from,
    periodTo: to,
    header: { contract, income, reward, licensorRate: String(share) },
    totals: reward !== null ? { royalty: reward, revenue: income, label: 'Вознаграждение лицензиару в шапке (округлено до рубля)', toleranceKop: 100 } : null,
    lines,
    warnings,
  };
}
