// Эффектив Рекордс: листы «Свод», «По категориям», «Авторские», «Смежные». Личный доход артиста.
import { FormatError, type Cell, type ParsedLine, type ParsedReport, type SheetData, type StreamKind, type WorkbookData } from '../types.ts';
import { cleanIsrc, findRow, lab, num, parseDotDate, quarterOf, rowText, str } from '../util.ts';

type Field = 'title' | 'artist' | 'contract' | 'revenue' | 'royalty' | 'qty' | 'category' | 'period' | 'country' | 'content' | 'model' | 'delivery' | 'platform' | 'isrc';
const HEAD: Array<[RegExp, Field]> = [
  [/^наименование$/, 'title'],
  [/^исполнитель$/, 'artist'],
  [/^договор$/, 'contract'],
  [/^сумма дохода$/, 'revenue'],
  [/^роялти лицензиара$/, 'royalty'],
  [/^тираж|кол-во использований/, 'qty'],
  [/^способ использования/, 'category'],
  [/^период$/, 'period'],
  [/^территория$/, 'country'],
  [/^тип контента$/, 'content'],
  [/^модель использования$/, 'model'],
  [/^тип доставки$/, 'delivery'],
  [/^сервис/, 'platform'],
  [/^isrc$/, 'isrc'],
];

export function detectEffective(wb: WorkbookData): boolean {
  const names = wb.sheets.map((s) => s.name.toLowerCase());
  return names.includes('свод') && names.includes('по категориям') && (names.includes('авторские') || names.includes('смежные'));
}

/** '2026M6' → '2026-06', '2026Q1' → '2026-Q1'. */
export function effectivePeriod(p: string | null): string | null {
  if (!p) return null;
  let m = /^(\d{4})M(\d{1,2})$/i.exec(p);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`;
  m = /^(\d{4})Q([1-4])$/i.exec(p);
  return m ? `${m[1]}-Q${m[2]}` : p;
}

export function streamKindEffective(category: string | null, model: string | null): StreamKind {
  if ((category ?? '').toLowerCase() !== 'интернет') return 'nonstream'; // РСП, публичка, мобильный контент
  const m = (model ?? '').toLowerCase();
  if (m.includes('ugc') || m.includes('creation')) return 'nonstream';
  if (m.includes('download') || m.includes('cloud')) return 'other';
  if (m === 'подписка') return 'paid';
  if (m === 'стриминг') return 'ad';
  return 'other';
}

function readSheet(s: SheetData, rights: 'authors' | 'related', warnings: string[], lines: ParsedLine[]): { royalty: number; revenue: number } | null {
  const h = findRow(s.rows, (t) => /наименование/i.test(t) && /роялти/i.test(t), 0, 10);
  if (h < 0) return null;
  const col = new Map<Field, number>();
  s.rows[h]!.forEach((c, i) => {
    const l = lab(c);
    for (const [re, f] of HEAD) if (re.test(l) && !col.has(f)) col.set(f, i);
  });
  for (const need of ['title', 'royalty', 'qty'] as Field[]) if (!col.has(need)) throw new FormatError(`Лист «${s.name}»: нет колонки «${need}»`);
  const get = (row: Cell[], f: Field) => (col.has(f) ? row[col.get(f)!] ?? null : null);
  // «Итого:» над таблицей
  const totRow = findRow(s.rows, (t) => /^Итого/i.test(t), 0, h);
  const nums = totRow >= 0 ? s.rows[totRow]!.map(num).filter((x): x is number => x !== null) : [];
  let sumRoy = 0;
  let sumRev = 0;
  for (let i = h + 1; i < s.rows.length; i++) {
    const row = s.rows[i]!;
    if (num(row[0]) === null) continue; // пустые строки, подписи
    const royalty = num(get(row, 'royalty'));
    if (royalty === null) {
      warnings.push(`Лист «${s.name}», строка ${i + 1}: нет роялти лицензиара, пропущена`);
      continue;
    }
    const category = str(get(row, 'category'));
    const model = str(get(row, 'model'));
    lines.push({
      rightsType: rights,
      artistRaw: str(get(row, 'artist')),
      titleRaw: str(get(row, 'title')),
      isrcRaw: cleanIsrc(get(row, 'isrc')),
      upcRaw: null,
      codeRaw: null,
      platform: str(get(row, 'platform')) ?? category,
      usageType: category,
      usageModel: model,
      streamKind: streamKindEffective(category, model),
      country: str(get(row, 'country')),
      periodMonth: effectivePeriod(str(get(row, 'period'))),
      qty: num(get(row, 'qty')) ?? 0,
      royalty,
      currencyOrig: 'RUB',
      amountOrig: num(get(row, 'revenue')),
      srcRow: i + 1,
      raw: { contract: str(get(row, 'contract')), content: str(get(row, 'content')), delivery: str(get(row, 'delivery')) },
    });
    sumRoy += royalty;
    sumRev += num(get(row, 'revenue')) ?? 0;
  }
  if (nums.length >= 2 && Math.abs((nums[1] ?? 0) - sumRoy) > 0.01) warnings.push(`Лист «${s.name}»: сумма строк ${sumRoy.toFixed(2)} не равна «Итого» ${nums[1]!.toFixed(2)}`);
  return { royalty: sumRoy, revenue: sumRev };
}

export function parseEffective(wb: WorkbookData): ParsedReport {
  const warnings: string[] = [];
  const lines: ParsedLine[] = [];
  const svod = wb.sheets.find((s) => s.name.toLowerCase() === 'свод');
  let from: string | null = null;
  let to: string | null = null;
  let svodTotal: number | null = null;
  const contracts: Array<{ number: string; date: string | null; sum: number | null }> = [];
  if (svod) {
    const pr = findRow(svod.rows, (t) => /\d{2}\.\d{2}\.\d{4}\s*\.\.\s*\d{2}\.\d{2}\.\d{4}/.test(t), 0, 12);
    if (pr >= 0) {
      const m = /(\d{2}\.\d{2}\.\d{4})\s*\.\.\s*(\d{2}\.\d{2}\.\d{4})/.exec(rowText(svod.rows[pr]));
      from = m ? parseDotDate(m[1]!) : null;
      to = m ? parseDotDate(m[2]!) : null;
    }
    const tr = findRow(svod.rows, (t) => /^Итого/i.test(t), 0, 15);
    if (tr >= 0) svodTotal = svod.rows[tr]!.map(num).find((x) => x !== null) ?? null;
    const h = findRow(svod.rows, (t) => /Договор/i.test(t) && /Дата/i.test(t), 0, 20);
    if (h >= 0) {
      for (let i = h + 1; i < svod.rows.length; i++) {
        const r = svod.rows[i]!;
        if (num(r[0]) === null) break;
        contracts.push({ number: str(r[1]) ?? '', date: parseDotDate(str(r[2]) ?? ''), sum: num(r[3]) });
      }
    }
  }
  let got = false;
  let total = 0;
  for (const s of wb.sheets) {
    const n = s.name.toLowerCase();
    const rights = n === 'авторские' ? 'authors' : n === 'смежные' ? 'related' : null;
    if (!rights) continue;
    const t = readSheet(s, rights, warnings, lines);
    if (t) {
      got = true;
      total += t.royalty;
    }
  }
  if (!got) throw new FormatError('В отчёте Эффектив нет листов «Авторские» / «Смежные» с данными');
  if (svodTotal !== null && Math.abs(svodTotal - total) > 0.01) warnings.push(`Сумма строк ${total.toFixed(2)} не равна итогу листа «Свод» ${svodTotal.toFixed(2)}`);
  const q = from ? quarterOf(Number(from.slice(0, 4)), Number(from.slice(5, 7))) : null;
  return {
    formatCode: 'effective',
    distributorName: 'Эффектив Рекордс',
    rightsScope: 'mixed',
    defaultFlow: 'personal',
    licensorShare: null,
    quarter: q,
    quarterSource: q ? 'text' : null,
    periodFrom: from,
    periodTo: to,
    header: { contracts },
    totals: svodTotal !== null ? { royalty: svodTotal, revenue: null, label: 'Итого на листе «Свод»' } : null,
    lines,
    warnings,
  };
}
