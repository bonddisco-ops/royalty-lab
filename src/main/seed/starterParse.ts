// Разбор листов Стартовая_база.xlsx в типизированные записи. Чистые функции, без БД.
import { normDecString, pctToShare } from '../domain/dec.ts';
import { cleanText, digitsOnly, isIsrc, normIsrc, parseRuDate } from '../domain/normalize.ts';

export type Matrix = string[][];
export interface StarterSheets {
  people: Matrix;
  appendix: Matrix;
  split: Matrix;
  problems: Matrix;
}

export const SHEET_NAMES = {
  people: 'Люди и договоры',
  appendix: 'Приложения (треки)',
  split: 'SPLIT',
  problems: 'Проблемы',
} as const;

/** По решению заказчика (ТЗ §10): не загружать. */
const EXCLUDED = ['IMSOLO'];
/** Gassan и Lamedy: обычные артисты по лицензии, договор не привязывать (ТЗ §10). */
const NO_CONTRACT_FOLDERS = ['gassan', 'lamedy'];

const cell = (r: string[], i: number): string => cleanText(r[i] ?? '');

export type PersonStatus = 'ip' | 'sz' | 'fl' | 'unknown';

export interface PersonRec {
  folder: string;
  aliases: string[];
  fioRaw: string;
  lastName: string;
  firstName: string;
  middleName: string;
  ogrnip: string | null;
  status: PersonStatus;
  contractNo: string | null;
  contractDate: string | null;
  contractDateSource: 'sheet' | 'file' | null;
  template: 'A' | 'B' | 'C' | null;
  birthDate: string | null;
  passportSeries: string;
  passportNumber: string;
  passportIssuedBy: string;
  passportIssuedDate: string | null;
  passportIssuedRaw: string;
  address: string;
  inn: string;
  bankName: string;
  bik: string;
  corr: string;
  account: string;
  email: string;
  rate: string | null;
  thresholdKop: number | null;
  fileName: string;
  noContract: boolean;
}

export function splitAliases(folder: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of folder.split(/\s*,\s*|\s+&\s+/)) {
    const a = cleanText(part);
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      out.push(a);
    }
  }
  return out;
}

function parseStatus(raw: string): PersonStatus {
  const s = raw.toUpperCase();
  if (s === 'ИП') return 'ip';
  if (s === 'СЗ') return 'sz';
  if (s === 'ФЛ') return 'fl';
  return 'unknown';
}

/** "ИП Рычагов Георгий Михайлович ОГРНИП: 320... ИНН: ... ОКВЭД: 9" -> ФИО без служебного хвоста. */
export function parseFio(raw: string): { last: string; first: string; middle: string; ogrnip: string | null; statusHint: PersonStatus } {
  let s = cleanText(raw);
  let ogrnip: string | null = null;
  const og = /ОГРНИП:?\s*(\d{13,15})/i.exec(s);
  if (og) ogrnip = og[1]!;
  s = s.replace(/ОГРНИП:?\s*\d+/i, '').replace(/ИНН:?\s*\d+/i, '').replace(/ОКВЭД:?\s*\S*/i, '');
  let statusHint: PersonStatus = 'unknown';
  const prefix = /^(ИП|СЗ|ФЛ)\s+/i.exec(s);
  if (prefix) {
    statusHint = parseStatus(prefix[1]!);
    s = s.slice(prefix[0].length);
  }
  s = s.replace(/^Казахстан\s+/i, '');
  const t = cleanText(s).split(' ').filter(Boolean);
  return { last: t[0] ?? '', first: t[1] ?? '', middle: t.slice(2).join(' '), ogrnip, statusHint };
}

/** "УВД ... 08.08.2003" / "27.07.2011 г. ОТДЕЛОМ ..." -> орган и дата отдельно. */
export function splitPassportIssued(raw: string): { issuedBy: string; date: string | null } {
  const s = cleanText(raw);
  const m = /(\d{2}\.\d{2}\.\d{4})\s*(?:г\.?|года)?/i.exec(s);
  if (!m) return { issuedBy: s, date: null };
  const rest = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^[\s,.;]+|[\s,.;]+$/g, '');
  return { issuedBy: rest, date: parseRuDate(m[1]) };
}

export function parseThresholdKop(raw: string): number | null {
  const d = digitsOnly(raw);
  return d ? Number(d) * 100 : null;
}

export function parsePeople(rows: Matrix): PersonRec[] {
  const out: PersonRec[] = [];
  for (const r of rows.slice(1)) {
    const folder = cell(r, 0);
    if (!folder || !cell(r, 1)) continue;
    if (EXCLUDED.some((x) => folder.toUpperCase().includes(x))) continue;
    const fio = parseFio(cell(r, 1));
    const statusCol = parseStatus(cell(r, 2));
    const issued = splitPassportIssued(cell(r, 9));
    const fileName = cell(r, 19);
    const sheetDate = parseRuDate(cell(r, 4));
    const fileDate = parseRuDate(/от\s+(\d{2}\.\d{2}\.\d{4})/i.exec(fileName)?.[1] ?? '');
    const tpl = cell(r, 5).toUpperCase();
    const rateRaw = cell(r, 17);
    out.push({
      folder,
      aliases: splitAliases(folder),
      fioRaw: cell(r, 1),
      lastName: fio.last,
      firstName: fio.first,
      middleName: fio.middle,
      ogrnip: fio.ogrnip,
      status: statusCol !== 'unknown' ? statusCol : fio.statusHint,
      contractNo: cell(r, 3) || null,
      contractDate: sheetDate ?? fileDate,
      contractDateSource: sheetDate ? 'sheet' : fileDate ? 'file' : null,
      template: tpl === 'A' || tpl === 'B' || tpl === 'C' ? tpl : null,
      birthDate: parseRuDate(cell(r, 6)),
      passportSeries: digitsOnly(cell(r, 7)),
      passportNumber: digitsOnly(cell(r, 8)),
      passportIssuedBy: issued.issuedBy,
      passportIssuedDate: issued.date,
      passportIssuedRaw: cell(r, 9),
      address: cell(r, 10),
      inn: digitsOnly(cell(r, 11)),
      bankName: cell(r, 12),
      bik: digitsOnly(cell(r, 13)),
      corr: digitsOnly(cell(r, 14)),
      account: digitsOnly(cell(r, 15)),
      email: cell(r, 16),
      rate: rateRaw ? pctToShare(rateRaw) : null,
      thresholdKop: parseThresholdKop(cell(r, 18)),
      fileName,
      noContract: NO_CONTRACT_FOLDERS.includes(folder.toLowerCase()),
    });
  }
  return out;
}

// ---------------------------------------------------------------- Приложения

export interface AppendixRow {
  folder: string;
  contractNo: string;
  title: string;
  performersRaw: string;
  sharesRaw: string;
  termRaw: string;
  /** 'rights' = в листе встроена шапка «Авторские права / Смежные права». */
  mode: 'plain' | 'rights';
  /** Доли по порядку (plain): ["0.5","0.5"]. */
  shares: string[];
  /** Доли по авторским и смежным (rights). */
  authors: string | null;
  related: string | null;
  termFrom: string | null;
  termTo: string | null;
}

export function parseTerm(raw: string): { from: string | null; to: string | null } {
  const dates = [...raw.matchAll(/\d{2}\.\d{2}\.\d{4}/g)].map((m) => parseRuDate(m[0]));
  if (dates.length >= 2) return { from: dates[0]!, to: dates[dates.length - 1]! };
  if (dates.length === 1) return /до/i.test(raw) ? { from: null, to: dates[0]! } : { from: dates[0]!, to: null };
  return { from: null, to: null };
}

export function parseShareList(raw: string): string[] {
  const out: string[] = [];
  for (const tok of raw.replace(/%/g, ' ').split(/\s+/).filter(Boolean)) {
    const v = pctToShare(tok);
    if (v !== null) out.push(v);
  }
  return out;
}

export function parseAppendix(rows: Matrix): AppendixRow[] {
  const rightsContracts = new Set<string>();
  const out: AppendixRow[] = [];
  for (const r of rows.slice(1)) {
    const folder = cell(r, 0);
    const contractNo = cell(r, 1);
    const title = cell(r, 2);
    if (!folder || !contractNo) continue;
    if (EXCLUDED.some((x) => folder.toUpperCase().includes(x))) continue;
    if (title === 'Наименование Произведения') {
      rightsContracts.add(contractNo);
      continue;
    }
    if (!title) continue;
    const mode = rightsContracts.has(contractNo) ? 'rights' : 'plain';
    const performersRaw = cell(r, 3);
    const sharesRaw = cell(r, 4);
    const termRaw = cell(r, 5);
    const base = { folder, contractNo, title, performersRaw, sharesRaw, termRaw, mode } as const;
    if (mode === 'rights') {
      out.push({
        ...base,
        shares: [],
        authors: sharesRaw ? pctToShare(sharesRaw.replace('%', '')) : null,
        related: termRaw ? pctToShare(termRaw.replace('%', '')) : null,
        termFrom: null,
        termTo: null,
      });
    } else {
      const t = parseTerm(termRaw);
      out.push({ ...base, shares: parseShareList(sharesRaw), authors: null, related: null, termFrom: t.from, termTo: t.to });
    }
  }
  return out;
}

// ---------------------------------------------------------------------- SPLIT

export interface SplitRow {
  line: number;
  artistRaw: string;
  artist: string;
  title: string;
  isrc: string;
  isCode: boolean;
  share: string | null;
  labelRate: string | null;
  cleaned: boolean;
}

export function parseSplit(rows: Matrix): SplitRow[] {
  const out: SplitRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const artistRaw = r[0] ?? '';
    const titleRaw = r[1] ?? '';
    const artist = cleanText(artistRaw);
    const title = cleanText(titleRaw);
    const isrc = normIsrc(r[2] ?? '');
    if (!artist || !title || !isrc) return;
    if (EXCLUDED.some((x) => artist.toUpperCase().includes(x))) return;
    out.push({
      line: i + 2,
      artistRaw,
      artist,
      title,
      isrc,
      isCode: !isIsrc(isrc),
      share: normDecString(r[3] ?? ''),
      labelRate: normDecString(r[4] ?? ''),
      cleaned: artist !== artistRaw || title !== titleRaw,
    });
  });
  return out;
}

// ------------------------------------------------------------------- Проблемы

export interface ProblemRow {
  who: string;
  subject: string;
  kind: string;
  details: string;
}

export function parseProblems(rows: Matrix): ProblemRow[] {
  return rows
    .slice(1)
    .map((r) => ({ who: cleanText(r[0] ?? ''), subject: cleanText(r[1] ?? ''), kind: cleanText(r[2] ?? ''), details: cleanText(r[3] ?? '') }))
    .filter((p) => p.kind);
}
