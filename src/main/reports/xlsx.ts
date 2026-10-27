// Лёгкое чтение .xlsx без внешних библиотек: zip (node:zlib) + разбор XML листов.
// Нужно для отчётов на десятки тысяч строк (Music Alligator, ~48 тыс.): полная модель exceljs съела бы гигабайты памяти.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Cell, SheetData, WorkbookData } from './types.ts';

// ------------------------------------------------------------------ zip

interface ZipEntry {
  method: number;
  compSize: number;
  localOffset: number;
}

function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не файл .xlsx (нет оглавления zip)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждено оглавление zip');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    out.set(buf.toString('utf8', p + 46, p + 46 + nameLen), { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Повреждена запись zip');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`Неподдерживаемое сжатие в xlsx (${e.method})`);
}

// ------------------------------------------------------------------ xml

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function unesc(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g: string) => {
    if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    return ENT[m.toLowerCase()] ?? m;
  }).replace(/_x([0-9a-f]{4})_/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unesc(m[1]!) : null;
};
/** Весь текст внутри <t>…</t> (в том числе в форматированном тексте <r>). */
function textOf(xml: string): string {
  let out = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += m[1] ? unesc(m[1]) : '';
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function isDateFormat(code: string): boolean {
  const c = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dmyhs]/i.test(c) && !/^(general|0|0\.0+|#,##0.*|0%|0\.0+%)$/i.test(c.trim());
}

/** Какие индексы стилей (cellXfs) — даты. */
function parseDateStyles(xml: string | null): Set<number> {
  const dateXf = new Set<number>();
  if (!xml) return dateXf;
  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = attr(m[0], 'numFmtId');
    const code = attr(m[0], 'formatCode');
    if (id && code) custom.set(Number(id), code);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? 0);
    if (BUILTIN_DATE.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) dateXf.add(i);
    i++;
  }
  return dateXf;
}

function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

const colIndex = (ref: string): number => {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

function parseSheet(xml: string, shared: string[], dateXf: Set<number>): Cell[][] {
  const rows: Cell[][] = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;
  let auto = 0;
  while ((rm = rowRe.exec(xml))) {
    const rn = attr(rm[1]!, 'r');
    const rowIdx = rn ? Number(rn) - 1 : auto;
    auto = rowIdx + 1;
    const row: Cell[] = [];
    const body = rm[2] ?? '';
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;
    let next = 0;
    while ((cm = cellRe.exec(body))) {
      const ref = attr(cm[1]!, 'r');
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = attr(cm[1]!, 't');
      const inner = cm[2] ?? '';
      let v: Cell = null;
      if (t === 'inlineStr') v = textOf(inner);
      else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm && vm[1] !== '') {
          const raw = vm[1]!;
          if (t === 's') v = shared[Number(raw)] ?? null;
          else if (t === 'str') v = unesc(raw);
          else if (t === 'b') v = raw === '1';
          else if (t === 'e') v = null;
          else {
            const n = Number(raw);
            v = Number.isFinite(n) ? n : unesc(raw);
            const s = attr(cm[1]!, 's');
            if (typeof v === 'number' && s !== null && dateXf.has(Number(s))) v = excelDate(v);
          }
        }
      }
      if (v === '') v = null;
      while (row.length < ci) row.push(null);
      row[ci] = v;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = row;
  }
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === null)) rows.pop();
  return rows;
}

export function readXlsxBuffer(buf: Buffer, fileName: string): WorkbookData {
  const dir = readZipDirectory(buf);
  const get = (name: string): string | null => {
    const e = dir.get(name);
    return e ? readEntry(buf, e).toString('utf8') : null;
  };
  const wbXml = get('xl/workbook.xml');
  if (!wbXml) throw new Error('Это не книга Excel (.xlsx): нет xl/workbook.xml');
  const rels = new Map<string, string>();
  for (const m of (get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const shared = parseSharedStrings(get('xl/sharedStrings.xml') ?? '');
  const dateXf = parseDateStyles(get('xl/styles.xml'));
  const sheets: SheetData[] = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? 'Лист';
    const rid = attr(m[0], 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    const xml = path ? get(path) : null;
    if (xml === null) continue;
    sheets.push({ name, rows: parseSheet(xml, shared, dateXf) });
  }
  return { fileName, sheets };
}

export function readXlsxFile(path: string): WorkbookData {
  return readXlsxBuffer(readFileSync(path), basename(path));
}
