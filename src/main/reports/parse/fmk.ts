// Фабрика мобильного контента (RCID): лист «Сводный» (сводная по артистам) + плоский лист с колонкой «Тип прав».
import { FormatError, type Cell, type ParsedLine, type ParsedReport, type RightsType, type SheetData, type StreamKind, type WorkbookData } from '../types.ts';
import { cleanIsrc, findRow, lab, num, quarterFromFileName, quarterFromPeriod, str } from '../util.ts';

type Field = 'period' | 'platform' | 'type' | 'country' | 'usage' | 'artist' | 'title' | 'isrc' | 'upc' | 'qty' | 'rate' | 'royaltyAuthors' | 'royaltyRelated' | 'royalty' | 'code';
const HEAD: Array<[RegExp, Field]> = [
  [/^период использования$/, 'period'],
  [/^витрина$/, 'platform'],
  [/^тип прав$/, 'type'],
  [/^территория$/, 'country'],
  [/^вид использования$/, 'usage'],
  [/^исполнитель$/, 'artist'],
  [/^название трека$/, 'title'],
  [/^isrc$/, 'isrc'],
  [/^upc$/, 'upc'],
  [/^количество$/, 'qty'],
  [/^доля лицензиара$/, 'rate'],
  [/^вознаграждение лицензиара за авторские/, 'royaltyAuthors'],
  [/^вознаграждение лицензиара за смежные/, 'royaltyRelated'],
  [/^итого вознаграждение лицензиара$/, 'royalty'],
  [/^код лицензиата$/, 'code'],
];

function findDataSheet(wb: WorkbookData): { sheet: SheetData; head: number } | null {
  for (const s of wb.sheets) {
    const h = findRow(s.rows, (t) => /тип прав/i.test(t) && /витрина/i.test(t) && /вознаграждение/i.test(t), 0, 6);
    if (h >= 0) return { sheet: s, head: h };
  }
  return null;
}

export function detectFmk(wb: WorkbookData): boolean {
  return wb.sheets.some((s) => s.name.toLowerCase() === 'сводный') && findDataSheet(wb) !== null;
}

/** '2026-07' → '2026-07', '2025-4 кв.' → '2025-Q4'. */
export function fmkPeriod(p: string | null): string | null {
  if (!p) return null;
  let m = /^(\d{4})-(\d{1,2})$/.exec(p);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}`;
  m = /^(\d{4})-([1-4])\s*кв/i.exec(p);
  return m ? `${m[1]}-Q${m[2]}` : p;
}

export function streamKindFmk(usage: string | null): StreamKind {
  const u = (usage ?? '').toLowerCase();
  if (u === 'подписка' || u === 'стриминг') return 'paid';
  if (u === 'реклама') return 'ad';
  return 'nonstream'; // тексты песен, синхронизация, публичное исполнение и прочие доходы без прослушиваний
}

function rightsOf(v: string | null): RightsType {
  const t = (v ?? '').toLowerCase();
  if (t.includes('авторские') && t.includes('смежные')) return 'mixed';
  return t.includes('авторские') ? 'authors' : 'related';
}

export function parseFmk(wb: WorkbookData): ParsedReport {
  const found = findDataSheet(wb);
  if (!found) throw new FormatError('Не нашёл лист с колонкой «Тип прав»');
  const { sheet, head } = found;
  const warnings: string[] = [];
  const col = new Map<Field, number>();
  sheet.rows[head]!.forEach((c, i) => {
    const l = lab(c);
    for (const [re, f] of HEAD) if (re.test(l) && !col.has(f)) col.set(f, i);
  });
  for (const need of ['type', 'royalty', 'qty', 'title'] as Field[]) if (!col.has(need)) throw new FormatError(`В отчёте ФМК нет колонки «${need}»`);
  const get = (row: Cell[], f: Field) => (col.has(f) ? row[col.get(f)!] ?? null : null);
  const lines: ParsedLine[] = [];
  let footer: number | null = null;
  const rates = new Map<string, number>();
  for (let i = head + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]!;
    if (num(row[0]) === null) {
      // строка итогов внизу: в колонке «Итого вознаграждение» стоит число, а номера строки нет
      const t = num(get(row, 'royalty'));
      if (t !== null && row.every((c, k) => k === col.get('royalty') || k === col.get('royaltyAuthors') || k === col.get('royaltyRelated') || typeof c === 'number' || c === null)) footer = t;
      continue;
    }
    const royalty = num(get(row, 'royalty'));
    if (royalty === null) {
      warnings.push(`Строка ${i + 1}: нет «Итого вознаграждение лицензиара», пропущена`);
      continue;
    }
    const ra = num(get(row, 'royaltyAuthors')) ?? 0;
    const rr = num(get(row, 'royaltyRelated')) ?? 0;
    if (Math.abs(ra + rr - royalty) > 0.0001) warnings.push(`Строка ${i + 1}: авторские + смежные не равны итогу вознаграждения`);
    const rate = num(get(row, 'rate'));
    if (rate !== null) rates.set(String(rate), (rates.get(String(rate)) ?? 0) + 1);
    const usage = str(get(row, 'usage'));
    lines.push({
      rightsType: rightsOf(str(get(row, 'type'))),
      artistRaw: str(get(row, 'artist')),
      titleRaw: str(get(row, 'title')),
      isrcRaw: cleanIsrc(get(row, 'isrc')),
      upcRaw: str(get(row, 'upc')),
      codeRaw: str(get(row, 'code')),
      platform: str(get(row, 'platform')),
      usageType: usage,
      usageModel: null,
      streamKind: streamKindFmk(usage),
      country: str(get(row, 'country')),
      periodMonth: fmkPeriod(str(get(row, 'period'))),
      qty: num(get(row, 'qty')) ?? 0,
      royalty,
      currencyOrig: 'RUB',
      amountOrig: null,
      srcRow: i + 1,
      raw: { royaltyAuthors: ra, royaltyRelated: rr },
    });
  }
  // квартал: в тексте отчёта его нет → имя файла, иначе по самому позднему периоду строк
  let quarter = quarterFromFileName(wb.fileName);
  let source: 'filename' | 'periods' | null = quarter ? 'filename' : null;
  if (!quarter) {
    const months = lines.map((l) => l.periodMonth).filter((p): p is string => !!p && /^\d{4}-\d{2}$/.test(p)).sort();
    quarter = quarterFromPeriod(months[months.length - 1] ?? null);
    source = quarter ? 'periods' : null;
    if (quarter) warnings.push(`Квартал ${quarter} определён по самому позднему месяцу в строках — проверьте`);
  }
  const topRate = [...rates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    formatCode: 'fmk',
    distributorName: 'Фабрика мобильного контента',
    rightsScope: 'mixed',
    defaultFlow: 'artists',
    licensorShare: topRate,
    quarter,
    quarterSource: source,
    periodFrom: null,
    periodTo: null,
    header: { licensorRate: topRate },
    totals: footer !== null ? { royalty: footer, revenue: null, label: 'Итоговая строка листа' } : null,
    lines,
    warnings,
  };
}
