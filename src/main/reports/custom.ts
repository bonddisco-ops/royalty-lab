// Мастер незнакомого формата (ТЗ §5): пользователь сопоставляет колонки, формат запоминается по отпечатку заголовков.
import { FormatError, type Cell, type Flow, type ParsedLine, type ParsedReport, type RightsType, type StreamKind, type WorkbookData } from './types.ts';
import { cleanIsrc, lab, num, quarterFromFileName, quarterFromPeriod, str } from './util.ts';

export const CUSTOM_FIELDS = ['title', 'artist', 'isrc', 'upc', 'code', 'platform', 'usageType', 'usageModel', 'country', 'period', 'qty', 'royalty', 'rightsType'] as const;
export type CustomField = (typeof CUSTOM_FIELDS)[number];

export interface CustomMapping {
  sheet: string;
  /** Индекс строки заголовков (с 0). */
  headerRow: number;
  columns: Partial<Record<CustomField, number>>;
  distributorName: string;
  rightsType: RightsType;
  flow: Flow;
  /** Множитель к колонке «Роялти» (например 0.7, если в отчёте доход лицензиата, а лицензиару идёт 70%). */
  licensorShare: number;
}

export interface Fingerprint {
  sheet: string;
  labels: string[];
}

export const FIELD_TITLES: Record<CustomField, string> = {
  title: 'Название трека', artist: 'Артист', isrc: 'ISRC', upc: 'UPC', code: 'Код (если нет ISRC)', platform: 'Платформа', usageType: 'Вид использования',
  usageModel: 'Модель / способ', country: 'Страна', period: 'Период (месяц)', qty: 'Тираж (прослушивания)', royalty: 'Роялти / сумма (руб.)', rightsType: 'Тип прав (в строке)',
};

const GUESS: Array<[CustomField, RegExp]> = [
  ['isrc', /^isrc/],
  ['upc', /upc|ean|баркод/],
  ['title', /track title|название трека|наименование|фонограмма|произведение|^title$|^track$|трек/],
  ['artist', /артист|исполнитель|^artist/],
  ['platform', /платформа|площадка|витрина|^dsp$|^store|сервис|провайдер|^platform/],
  ['usageType', /вид использования|тип использования|способ использования|sale type|usage/],
  ['usageModel', /модель|subscription/],
  ['country', /страна|территория|territory|country/],
  ['period', /^период|^period|месяц|sale date|month/],
  ['qty', /тираж|количество|кол-во|streams|plays|quantity|qty/],
  ['royalty', /роялти|вознаграждение|^сумма|amount|royalty|revenue|доход/],
  ['rightsType', /тип прав/],
  ['code', /^код|code|идентификатор/],
];

export function fingerprintOf(wb: WorkbookData, sheet: string, headerRow: number): Fingerprint {
  const s = wb.sheets.find((x) => x.name === sheet);
  return { sheet, labels: (s?.rows[headerRow] ?? []).map(lab).filter(Boolean) };
}

/** Автодогадка: строка заголовков и колонки по ключевым словам. Пользователь поправит в мастере. */
export function proposeMapping(wb: WorkbookData): { mapping: CustomMapping; headers: string[]; sample: Cell[][] } | null {
  let best: { sheet: string; row: number; score: number } | null = null;
  for (const s of wb.sheets) {
    for (let i = 0; i < Math.min(40, s.rows.length); i++) {
      const cells = s.rows[i]!.filter((c) => typeof c === 'string' && str(c) !== null);
      if (cells.length < 4) continue;
      const score = cells.reduce((a, c) => a + (GUESS.some(([, re]) => re.test(lab(c as string))) ? 1 : 0), 0) + (s.rows.length > 20 ? 1 : 0);
      if (!best || score > best.score) best = { sheet: s.name, row: i, score };
      break; // первая «похожая на шапку» строка листа
    }
  }
  if (!best) return null;
  const s = wb.sheets.find((x) => x.name === best!.sheet)!;
  const headers = s.rows[best.row]!.map((c) => str(c) ?? '');
  const columns: Partial<Record<CustomField, number>> = {};
  headers.forEach((h, i) => {
    const l = lab(h);
    for (const [f, re] of GUESS) if (!(f in columns) && re.test(l)) { columns[f] = i; break; }
  });
  return {
    mapping: { sheet: best.sheet, headerRow: best.row, columns, distributorName: '', rightsType: 'mixed', flow: 'artists', licensorShare: 1 },
    headers,
    sample: s.rows.slice(best.row + 1, best.row + 6),
  };
}

export function streamKindGuess(usage: string | null, model: string | null): StreamKind {
  const t = `${usage ?? ''} ${model ?? ''}`.toLowerCase();
  if (/синхрон|публичн|ugc|breakage|рсп|носител|механич|текст|lyric|public|sync|ringback|рбт/.test(t)) return 'nonstream';
  if (/реклам|ad-supported|ad supported|free|бесплатн/.test(t)) return 'ad';
  if (/загрузк|download|облач|cloud|видео|video/.test(t)) return 'other';
  return 'paid';
}

function rightsOf(v: string | null, dflt: RightsType): RightsType {
  const t = (v ?? '').toLowerCase();
  if (!t) return dflt;
  if (t.includes('авторск') && t.includes('смежн')) return 'mixed';
  if (t.includes('авторск') || t.startsWith('author') || t.startsWith('publish')) return 'authors';
  if (t.includes('смежн') || t.startsWith('related') || t.startsWith('master')) return 'related';
  return dflt;
}

export function parseCustom(wb: WorkbookData, m: CustomMapping): ParsedReport {
  const s = wb.sheets.find((x) => x.name === m.sheet);
  if (!s) throw new FormatError(`В файле нет листа «${m.sheet}»`);
  if (m.columns.royalty === undefined) throw new FormatError('Не выбрана колонка с суммой роялти');
  if (m.columns.isrc === undefined && m.columns.code === undefined && m.columns.title === undefined) throw new FormatError('Нужна хотя бы одна колонка: ISRC, код или название трека');
  const c = m.columns;
  const g = (row: Cell[], f: CustomField): Cell | null => (c[f] === undefined ? null : row[c[f]!] ?? null);
  const lines: ParsedLine[] = [];
  const warnings: string[] = [];
  for (let i = m.headerRow + 1; i < s.rows.length; i++) {
    const row = s.rows[i]!;
    if (row.every((x) => x === null || str(x) === null)) continue;
    if (row.some((x) => typeof x === 'string' && /^(итого|итог|total)\b/i.test(x.trim()))) continue; // строка итогов
    const royalty = num(g(row, 'royalty'));
    if (royalty === null) {
      warnings.push(`Строка ${i + 1}: нет числа в колонке суммы, пропущена`);
      continue;
    }
    const usage = str(g(row, 'usageType'));
    const model = str(g(row, 'usageModel'));
    const period = str(g(row, 'period'));
    lines.push({
      rightsType: rightsOf(str(g(row, 'rightsType')), m.rightsType),
      artistRaw: str(g(row, 'artist')),
      titleRaw: str(g(row, 'title')),
      isrcRaw: cleanIsrc(g(row, 'isrc')),
      upcRaw: str(g(row, 'upc')),
      codeRaw: str(g(row, 'code')),
      platform: str(g(row, 'platform')),
      usageType: usage,
      usageModel: model,
      streamKind: streamKindGuess(usage, model),
      country: str(g(row, 'country')),
      periodMonth: period && /^\d{4}-\d{2}/.test(period) ? period.slice(0, 7) : period,
      qty: num(g(row, 'qty')) ?? 0,
      royalty: royalty * m.licensorShare,
      currencyOrig: 'RUB',
      amountOrig: royalty,
      srcRow: i + 1,
      raw: {},
    });
  }
  if (lines.length === 0) throw new FormatError('По этому сопоставлению не нашлось ни одной строки с суммой');
  let quarter = quarterFromFileName(wb.fileName);
  let source: 'filename' | 'periods' | null = quarter ? 'filename' : null;
  if (!quarter) {
    const months = lines.map((l) => l.periodMonth).filter((p): p is string => !!p && /^\d{4}-\d{2}$/.test(p)).sort();
    quarter = quarterFromPeriod(months[months.length - 1] ?? null);
    source = quarter ? 'periods' : null;
  }
  return {
    formatCode: 'custom:pending',
    distributorName: m.distributorName || 'Новый дистрибьютор',
    rightsScope: m.rightsType,
    defaultFlow: m.flow,
    licensorShare: m.licensorShare === 1 ? null : String(m.licensorShare),
    quarter,
    quarterSource: source,
    periodFrom: null,
    periodTo: null,
    header: { custom: true },
    totals: null,
    lines,
    warnings: [...warnings, 'У нестандартного формата нет итога для сверки'],
  };
}

/** Сохранённый формат подходит, если лист и подписи колонок совпали. */
export function matchSavedFormat(wb: WorkbookData, saved: Array<{ id: string; fingerprint: Fingerprint; mapping: CustomMapping }>): { id: string; mapping: CustomMapping } | null {
  for (const f of saved) {
    const got = fingerprintOf(wb, f.fingerprint.sheet, f.mapping.headerRow).labels;
    if (got.length === f.fingerprint.labels.length && got.every((x, i) => x === f.fingerprint.labels[i])) return { id: f.id, mapping: f.mapping };
  }
  return null;
}
