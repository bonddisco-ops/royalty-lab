// SP Digital («Отчет (авторские/смежные права), задание №», ООО «СП ДИДЖИТАЛ»).
// Колонки не зашиты по номерам: сверху в шапке лежит легенда "1 – ISRC", "2 – Фонограмма"..., а под ней
// строка с номерами 1..N. Авторские и смежные файлы различаются порядком колонок, поэтому читаем легенду.
import { FormatError, type ParsedLine, type ParsedReport, type RightsType, type SheetData, type StreamKind, type WorkbookData } from '../types.ts';
import { cleanIsrc, findRow, lab, num, parseRuLongDate, quarterOf, rateToShare, rowText, str } from '../util.ts';

type Field = 'isrc' | 'title' | 'artist' | 'platform' | 'qty' | 'revenue' | 'rate' | 'royalty' | 'country' | 'periodText' | 'usage' | 'upc' | 'month' | 'code' | 'share';

const LEGEND: Array<[RegExp, Field]> = [
  [/^isrc$/, 'isrc'],
  [/^(фонограмма|произведение)$/, 'title'],
  [/^исполнитель$/, 'artist'],
  [/контент.?провайдер/, 'platform'],
  [/количество продаж/, 'qty'],
  [/^выручка/, 'revenue'],
  [/ставка роялти/, 'rate'],
  [/^сумма роялти/, 'royalty'],
  [/^территория$/, 'country'],
  [/период отчета партнера/, 'periodText'],
  [/^тип использования$/, 'usage'],
  [/upc|баркод/, 'upc'],
  [/месяц.?год продажи/, 'month'],
  [/идентификатор произведения/, 'code'],
  [/^доля лицензиара/, 'share'],
];

export function streamKindSp(usage: string | null): StreamKind {
  const u = (usage ?? '').toLowerCase();
  if (u.includes('рекламн')) return 'ad';
  if (u.includes('публичн')) return 'nonstream';
  if (u.includes('загрузк')) return 'other';
  if (u.includes('стриминг') || u.includes('подписк')) return 'paid';
  return 'other';
}

function monthFromMmYyyy(s: string | null): string | null {
  const m = s ? /^(\d{2})(\d{4})$/.exec(s) : null;
  return m ? `${m[2]}-${m[1]}` : null;
}

export function detectSpDigital(wb: WorkbookData): boolean {
  return wb.sheets.some((s) => findRow(s.rows, (t) => /Отчет \((авторские|смежные) права\), задание/i.test(t), 0, 8) >= 0);
}

interface SheetInfo {
  scope: RightsType;
  job: string;
  contract: string | null;
  from: string | null;
  to: string | null;
  licensor: string | null;
  delivered: string | null;
}

function readHead(s: SheetData): SheetInfo | null {
  const r = findRow(s.rows, (t) => /Отчет \((авторские|смежные) права\), задание/i.test(t), 0, 8);
  if (r < 0) return null;
  const t = rowText(s.rows[r]);
  const scope: RightsType = /авторские/i.test(t) ? 'authors' : 'related';
  const job = /задание №\s*(.+)$/i.exec(t)?.[1]?.trim() ?? '';
  const head = s.rows.slice(0, 12).map(rowText);
  const per = head.find((x) => /Период операций/i.test(x)) ?? '';
  const parts = per.split(/\s+по\s+/i);
  const from = parts[0] ? parseRuLongDate(parts[0]) : null;
  const to = parts[1] ? parseRuLongDate(parts[1]) : null;
  return {
    scope,
    job,
    contract: head.find((x) => /^Договор/i.test(x))?.replace(/^Договор\s*№?\s*/i, '') ?? null,
    from,
    to,
    licensor: head.find((x) => /^Лицензиар/i.test(x))?.replace(/^Лицензиар\s*[-–:]\s*/i, '') ?? null,
    delivered: head.find((x) => /Отчет предоставлен/i.test(x)) ?? null,
  };
}

export function parseSpDigital(wb: WorkbookData): ParsedReport {
  const warnings: string[] = [];
  const lines: ParsedLine[] = [];
  let info: SheetInfo | null = null;
  const jobs: string[] = [];
  let footerRevenue = 0;
  let footerRoyalty = 0;
  let footerFound = false;
  const rates = new Map<string, number>();

  for (const s of wb.sheets) {
    const h = readHead(s);
    if (!h) continue; // лист-пустышка без шапки
    if (!info) info = h;
    else if (info.scope !== h.scope) throw new FormatError('В одном файле SP Digital смешаны авторские и смежные листы');
    jobs.push(h.job);

    // легенда: строки "N – название" до строки с номерами колонок
    const numRow = findRow(s.rows, (_t, row) => str(row[0]) === '1' && str(row[1]) === '2' && str(row[2]) === '3', 0, 60);
    if (numRow < 0) {
      if (s.rows.length > 30) throw new FormatError(`Лист «${s.name}»: не нашёл строку с номерами колонок`);
      continue;
    }
    const col = new Map<Field, number>();
    for (let i = 0; i < numRow; i++) {
      const m = /^(\d+)\s*[–—-]\s*(.+)$/.exec(str(s.rows[i]?.[0]) ?? '');
      if (!m) continue;
      const name = lab(m[2]).replace(/\s*\(.*\)\s*$/, (x) => (/\(p\)|\(c\)/i.test(x) ? '' : x));
      for (const [re, f] of LEGEND) if (re.test(name) && !col.has(f)) col.set(f, Number(m[1]) - 1);
    }
    for (const need of ['isrc', 'title', 'royalty', 'qty'] as Field[]) {
      // в авторском файле ISRC стоит отдельной колонкой «13 – ISRC»; если её нет — просто работаем по коду произведения
      if (!col.has(need) && need !== 'isrc') throw new FormatError(`Лист «${s.name}»: в легенде нет колонки «${need}»`);
    }
    const get = (row: (string | number | boolean | null)[], f: Field) => (col.has(f) ? row[col.get(f)!] : null);

    for (let i = numRow + 1; i < s.rows.length; i++) {
      const row = s.rows[i]!;
      const first = str(row[0]);
      if (first && /^ИТОГО/i.test(first)) {
        const m = /:\s*([\d\s.,]+)\s*\/\s*([\d\s.,]+)\s*$/.exec(first);
        if (m) {
          footerRevenue += num(m[1]!.replace(/\s/g, '')) ?? 0;
          footerRoyalty += num(m[2]!.replace(/\s/g, '')) ?? 0;
          footerFound = true;
        }
        continue;
      }
      if (row.every((c) => c === null || str(c) === null)) continue;
      const royalty = num(get(row, 'royalty'));
      if (royalty === null) {
        warnings.push(`Лист «${s.name}», строка ${i + 1}: нет суммы роялти, пропущена`);
        continue;
      }
      const usage = str(get(row, 'usage'));
      const rate = rateToShare(get(row, 'rate'));
      if (rate) rates.set(rate, (rates.get(rate) ?? 0) + 1);
      const periodText = str(get(row, 'periodText'));
      let periodMonth = monthFromMmYyyy(str(get(row, 'month')));
      if (!periodMonth && periodText) {
        const d = parseRuLongDate(periodText.split('-')[0] ?? '');
        if (d) periodMonth = d.slice(0, 7);
      }
      const artistRaw = str(get(row, 'artist'));
      lines.push({
        rightsType: h.scope,
        artistRaw,
        titleRaw: str(get(row, 'title')),
        isrcRaw: col.has('isrc') ? cleanIsrc(get(row, 'isrc')) : null,
        upcRaw: str(get(row, 'upc')),
        codeRaw: str(get(row, 'code')),
        platform: str(get(row, 'platform')),
        usageType: usage,
        usageModel: null,
        streamKind: streamKindSp(usage),
        country: str(get(row, 'country')),
        periodMonth,
        qty: num(get(row, 'qty')) ?? 0,
        royalty,
        currencyOrig: 'RUB',
        amountOrig: num(get(row, 'revenue')),
        srcRow: i + 1,
        raw: { usage, rate: str(get(row, 'rate')), share: str(get(row, 'share')), periodText },
      });
    }
  }
  if (!info) throw new FormatError('Не нашёл шапку SP Digital');
  const topRate = [...rates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (rates.size > 1) warnings.push(`В отчёте несколько ставок лицензиара: ${[...rates.keys()].join(', ')}`);
  const from = info.from;
  const to = info.to;
  const q = from ? quarterOf(Number(from.slice(0, 4)), Number(from.slice(5, 7))) : null;
  return {
    formatCode: 'sp_digital',
    distributorName: 'SP Digital',
    rightsScope: info.scope,
    defaultFlow: 'artists',
    licensorShare: topRate,
    quarter: q,
    quarterSource: q ? 'text' : null,
    periodFrom: from,
    periodTo: to,
    header: { job: jobs.join(' / '), contract: info.contract, licensor: info.licensor, delivered: info.delivered, licensorRate: topRate },
    totals: footerFound ? { royalty: footerRoyalty, revenue: footerRevenue, label: 'ИТОГО в подвале отчёта' } : null,
    lines,
    warnings,
  };
}
