// Общие типы импорта отчётов дистрибьюторов (ТЗ §5, Схема_БД §6). Чистые данные, без БД.
export type Cell = string | number | boolean | null;
export type Rows = Cell[][];
export interface SheetData {
  name: string;
  rows: Rows;
}
export interface WorkbookData {
  fileName: string;
  sheets: SheetData[];
}

export type RightsType = 'authors' | 'related' | 'mixed';
export type StreamKind = 'paid' | 'ad' | 'other' | 'nonstream';
export type Flow = 'artists' | 'personal' | 'ignore';
export type BuiltinFormat = 'sp_digital' | 'effective' | 'fmk' | 'music_alligator' | 'silk';
export type FormatCode = BuiltinFormat | `custom:${string}`;

/** Одна строка отчёта в едином виде. Сумма royalty — в рублях, как в отчёте (до копейки округляется при записи). */
export interface ParsedLine {
  rightsType: RightsType;
  artistRaw: string | null;
  titleRaw: string | null;
  isrcRaw: string | null;
  upcRaw: string | null;
  codeRaw: string | null;
  platform: string | null;
  usageType: string | null;
  usageModel: string | null;
  streamKind: StreamKind;
  country: string | null;
  /** 'YYYY-MM' | 'YYYY-Qn' | 'YYYY' | null */
  periodMonth: string | null;
  qty: number;
  royalty: number;
  currencyOrig: string | null;
  amountOrig: number | null;
  /** Номер строки в файле (с 1) — для сообщений об ошибках. */
  srcRow: number;
  raw: Record<string, unknown>;
}

export interface ReportTotals {
  /** Итог из подвала отчёта (руб.), если он там есть. */
  royalty: number | null;
  revenue: number | null;
  /** Где нашли итог — для сообщения пользователю. */
  label: string;
  /** Допуск при сверке, копейки (итог в подвале может быть округлён до рубля). */
  toleranceKop?: number;
}

export interface ParsedReport {
  formatCode: FormatCode;
  distributorName: string;
  rightsScope: RightsType;
  defaultFlow: Flow;
  /** Ставка лицензиара, прочитанная из отчёта: '0.7' | '0.75' | null. */
  licensorShare: string | null;
  quarter: string | null;
  quarterSource: 'text' | 'filename' | 'periods' | null;
  periodFrom: string | null;
  periodTo: string | null;
  header: Record<string, unknown>;
  totals: ReportTotals | null;
  lines: ParsedLine[];
  warnings: string[];
}

export class FormatError extends Error {}
