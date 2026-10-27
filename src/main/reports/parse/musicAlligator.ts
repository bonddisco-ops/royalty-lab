// Music Alligator: один лист «Report», около 48 тыс. строк. Валюты EUR и RUB; берём «Amount on report date» (в рублях).
import { FormatError, type Cell, type ParsedLine, type ParsedReport, type StreamKind, type WorkbookData } from '../types.ts';
import { cleanIsrc, lab, num, quarterFromFileName, str } from '../util.ts';

type Field = 'period' | 'saleDate' | 'label' | 'upc' | 'artist' | 'release' | 'isrc' | 'title' | 'version' | 'territory' | 'dsp' | 'store' | 'saleType' | 'usageType' | 'subType' | 'streams' | 'downloads' | 'revenue' | 'currency' | 'amount' | 'split';
const HEAD: Array<[RegExp, Field]> = [
  [/^period$/, 'period'],
  [/^sale date$/, 'saleDate'],
  [/^label$/, 'label'],
  [/^ean upc$/, 'upc'],
  [/^artist$/, 'artist'],
  [/^release$/, 'release'],
  [/^isrc$/, 'isrc'],
  [/^track title$/, 'title'],
  [/^track version$/, 'version'],
  [/^territory$/, 'territory'],
  [/^dsp$/, 'dsp'],
  [/^store name$/, 'store'],
  [/^sale type$/, 'saleType'],
  [/^usage type$/, 'usageType'],
  [/^subscription type$/, 'subType'],
  [/^streams$/, 'streams'],
  [/^downloads$/, 'downloads'],
  [/^revenue$/, 'revenue'],
  [/^report currency$/, 'currency'],
  [/^amount on report date$/, 'amount'],
  [/^split share/, 'split'],
];

export function detectAlligator(wb: WorkbookData): boolean {
  const s = wb.sheets.find((x) => x.name.toLowerCase() === 'report');
  const h = s?.rows[0]?.map(lab) ?? [];
  return h.includes('amount on report date') && h.some((x) => x.startsWith('split share'));
}

export function streamKindAlligator(saleType: string | null, subType: string | null): StreamKind {
  const st = (saleType ?? '').toLowerCase();
  const sub = (subType ?? '').toLowerCase();
  if (sub === 'ugc') return 'nonstream';
  if (st === 'синхронизация' || st === 'доплата') return 'nonstream';
  if (st === 'загрузка') return 'other';
  if (st === 'реклама') return 'ad';
  const adSupported = sub.includes('ad-supported') || sub.includes('ad supported');
  if (st === 'подписка') return 'paid';
  if (st === 'стриминг') return adSupported ? 'ad' : 'paid';
  if (st.startsWith('video stream')) return adSupported ? 'ad' : 'other';
  return 'other';
}

/** '2026-06-01' → '2026-06'; '2026-Q2' → '2026-Q2'. */
function maPeriod(v: string | null): string | null {
  if (!v) return null;
  let m = /^(\d{4})-(\d{2})(-\d{2})?/.exec(v);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{4})-Q([1-4])$/i.exec(v);
  return m ? `${m[1]}-Q${m[2]}` : v;
}

export function parseAlligator(wb: WorkbookData): ParsedReport {
  const s = wb.sheets.find((x) => x.name.toLowerCase() === 'report');
  if (!s) throw new FormatError('Нет листа «Report»');
  const col = new Map<Field, number>();
  s.rows[0]!.forEach((c, i) => {
    const l = lab(c).replace(/[()%]/g, '').trim();
    for (const [re, f] of HEAD) if (re.test(l) && !col.has(f)) col.set(f, i);
  });
  for (const need of ['isrc', 'amount', 'currency'] as Field[]) if (!col.has(need)) throw new FormatError(`Music Alligator: нет колонки «${need}»`);
  const get = (row: Cell[], f: Field) => (col.has(f) ? row[col.get(f)!] ?? null : null);
  const warnings: string[] = [];
  const lines: ParsedLine[] = [];
  const quarters = new Map<string, number>();
  const currencies = new Set<string>();
  let badSplit = 0;
  for (let i = 1; i < s.rows.length; i++) {
    const row = s.rows[i]!;
    if (row.every((c) => c === null)) continue;
    const amount = num(get(row, 'amount'));
    if (amount === null) {
      warnings.push(`Строка ${i + 1}: нет «Amount on report date», пропущена`);
      continue;
    }
    const splitRaw = num(get(row, 'split'));
    const split = splitRaw === null ? 100 : splitRaw;
    if (split !== 100) badSplit++;
    const saleType = str(get(row, 'saleType'));
    const subType = str(get(row, 'subType'));
    const q = str(get(row, 'period'));
    if (q) quarters.set(q, (quarters.get(q) ?? 0) + 1);
    const cur = str(get(row, 'currency'));
    if (cur) currencies.add(cur);
    const title = str(get(row, 'title'));
    const version = str(get(row, 'version'));
    lines.push({
      rightsType: 'mixed',
      artistRaw: str(get(row, 'artist')),
      titleRaw: title && version ? `${title} (${version})` : title,
      isrcRaw: cleanIsrc(get(row, 'isrc')),
      upcRaw: str(get(row, 'upc')),
      codeRaw: null,
      platform: str(get(row, 'dsp')) ?? str(get(row, 'store')),
      usageType: saleType,
      usageModel: subType,
      streamKind: streamKindAlligator(saleType, subType),
      country: str(get(row, 'territory')),
      periodMonth: maPeriod(str(get(row, 'saleDate'))),
      qty: (num(get(row, 'streams')) ?? 0) + (num(get(row, 'downloads')) ?? 0),
      royalty: (amount * split) / 100,
      currencyOrig: cur,
      amountOrig: num(get(row, 'revenue')),
      srcRow: i + 1,
      raw: { label: str(get(row, 'label')), release: str(get(row, 'release')), device: str(get(row, 'usageType')), split },
    });
  }
  if (badSplit) warnings.push(`У ${badSplit} строк Split Share не равен 100: учтён как доля (сумма × Split / 100)`);
  if ([...currencies].some((c) => c !== 'RUB')) warnings.push(`Есть строки в ${[...currencies].filter((c) => c !== 'RUB').join(', ')}: взята сумма в рублях на дату отчёта`);
  warnings.push('В отчёте нет итога в подвале: сверить сумму строк не с чем');
  const topQ = [...quarters.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const m = topQ ? /^(\d{4})-?Q([1-4])$/i.exec(topQ) : null;
  const quarter = m ? `${m[1]}Q${m[2]}` : quarterFromFileName(wb.fileName);
  return {
    formatCode: 'music_alligator',
    distributorName: 'Music Alligator',
    rightsScope: 'mixed',
    defaultFlow: 'artists',
    licensorShare: null,
    quarter,
    quarterSource: m ? 'text' : quarter ? 'filename' : null,
    periodFrom: null,
    periodTo: null,
    header: { currencies: [...currencies] },
    totals: null,
    lines,
    warnings,
  };
}
