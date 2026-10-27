// Excel артисту по образцу Shtain.xlsx: лист на псевдоним, умная таблица, «К выплате» = J*K*L*0.94, итоги через SUBTOTAL.
// Колонки «Ставка за прослушивание» и «Дистрибьютор» в файл артисту не попадают (ТЗ §6, Схема_БД §12).
import { zipFiles } from '../export/zipWriter.ts';
import { DEC_ONE, formatDec, parseDec } from '../domain/dec.ts';
import { roundDiv, type AccrualRow, type RoundMode } from './calc.ts';

const XL_ROUND: Record<RoundMode, string> = { down: 'ROUNDDOWN', up: 'ROUNDUP', nearest: 'ROUND' };
const MODE_TEXT: Record<RoundMode, string> = { down: 'вниз до копейки', up: 'вверх до копейки', nearest: 'до копейки математически' };

export interface XlsxSheetInput { name: string; rows: AccrualRow[] }
export interface XlsxResult { buffer: Buffer; /** Итог по всем листам, вниз до копейки — то же число, что в ведомости. */ totalKop: number; sheetNames: string[] }

const HEAD = ['UPC', 'ISRC', 'Артист', 'Артист (для сопоставления)', 'Название трека', 'Платформа', 'Тип стрима', 'Страна', 'Тираж', 'Роялти', 'Ставка трека', 'Ставка лейбла', 'К выплате'];
const WIDTHS = [15, 15, 26, 28, 24, 24, 40, 30, 10, 12, 14, 16, 14];
const SCALE3 = DEC_ONE * DEC_ONE * DEC_ONE;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const col = (i: number): string => String.fromCharCode(65 + i);

function sheetName(raw: string, used: Set<string>): string {
  let n = raw.replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Лист';
  let k = 2;
  const base = n;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${k++}`;
  used.add(n.toLowerCase());
  return n;
}

const numStr = (v: number): string => (Number.isFinite(v) ? String(v) : '0');
const decNum = (s: string): number => Number(s.replace(',', '.'));

/** Множитель «1 − вычет» строкой для формулы: '0.94'. */
export function multiplierText(deduction: string): string {
  const d = parseDec(deduction) ?? 0n;
  return formatDec(DEC_ONE - d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function buildStatementXlsx(sheets: XlsxSheetInput[], deduction: string, mode: RoundMode = 'down'): XlsxResult {
  const FN = XL_ROUND[mode];
  const mult = multiplierText(deduction);
  const multN = Number(mult);
  const sst: string[] = [];
  const sstIdx = new Map<string, number>();
  const s = (t: string | null | undefined): number => {
    const v = t ?? '';
    let i = sstIdx.get(v);
    if (i === undefined) { i = sst.length; sst.push(v); sstIdx.set(v, i); }
    return i;
  };
  const used = new Set<string>();
  const names = sheets.map((x) => sheetName(x.name, used));
  const files: Array<{ name: string; data: string | Buffer }> = [];
  let grandScaled = 0n;
  const totals: Array<{ name: string; table: string; qty: number; sum: number }> = [];

  sheets.forEach((sh, si) => {
    const rows = [...sh.rows].sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'ru') || (a.platform ?? '').localeCompare(b.platform ?? '', 'ru') || (a.month ?? '').localeCompare(b.month ?? '') || (a.country ?? '').localeCompare(b.country ?? '', 'ru') || (a.usage ?? '').localeCompare(b.usage ?? '', 'ru'));
    const table = `Таблица${si + 1}`;
    const n = rows.length;
    const last = n + 1; // последняя строка данных
    const totalRow = n + 2;
    let qty = 0, sum = 0;
    const xml: string[] = [];
    xml.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`);
    xml.push(`<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>`);
    xml.push(`<cols>${WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>`);
    xml.push(`<row r="1">${HEAD.map((h, i) => `<c r="${col(i)}1" t="s"><v>${s(h)}</v></c>`).join('')}</row>`);
    rows.forEach((r, i) => {
      const rn = i + 2;
      const roy = r.royaltyKop / 100;
      const sh_ = decNum(r.share), lr = decNum(r.labelRate);
      const pay = roy * sh_ * lr * multN;
      qty += r.qty; sum += pay; grandScaled += r.scaled;
      const txt = (c: number, v: string | null): string => `<c r="${col(c)}${rn}" t="s" s="1"><v>${s(v)}</v></c>`;
      xml.push(
        `<row r="${rn}">${txt(0, r.upc)}${txt(1, r.isrc ?? r.code)}${txt(2, r.artistRaw)}${txt(3, r.artistName)}${txt(4, r.title)}${txt(5, r.platform)}${txt(6, r.usage)}${txt(7, r.country)}` +
        `<c r="I${rn}" s="2"><v>${r.qty}</v></c><c r="J${rn}" s="2"><v>${numStr(roy)}</v></c><c r="K${rn}" s="2"><v>${numStr(sh_)}</v></c><c r="L${rn}" s="2"><v>${numStr(lr)}</v></c>` +
        `<c r="M${rn}" s="2"><f>J${rn}*K${rn}*L${rn}*${mult}</f><v>${numStr(pay)}</v></c></row>`,
      );
    });
    // итоговая строка таблицы: тираж — SUBTOTAL; «К выплате» — SUBTOTAL, округлённый вниз до копейки
    const subtotalFloor = (mode === 'down' ? Math.floor(sum * 100 + 1e-7) : mode === 'up' ? Math.ceil(sum * 100 - 1e-7) : Math.round(sum * 100)) / 100;
    xml.push(
      `<row r="${totalRow}"><c r="A${totalRow}" t="s"><v>${s('Итог')}</v></c>` +
      `<c r="I${totalRow}" s="2"><f>SUBTOTAL(109,${table}[Тираж])</f><v>${qty}</v></c>` +
      `<c r="M${totalRow}" s="2"><f>${FN}(SUBTOTAL(109,${table}[К выплате]),2)</f><v>${numStr(subtotalFloor)}</v></c></row>`,
    );
    xml.push(`</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`);
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: xml.join('') });
    files.push({ name: `xl/worksheets/_rels/sheet${si + 1}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${si + 1}.xml"/></Relationships>` });
    const cols = HEAD.map((h, i) => {
      const id = i + 1;
      if (i === 0) return `<tableColumn id="${id}" name="${esc(h)}" totalsRowLabel="Итог"/>`;
      if (i === 8) return `<tableColumn id="${id}" name="${esc(h)}" totalsRowFunction="sum"/>`;
      if (i === 12) return `<tableColumn id="${id}" name="${esc(h)}" totalsRowFunction="custom"><calculatedColumnFormula>J2*K2*L2*${mult}</calculatedColumnFormula><totalsRowFormula>${FN}(SUBTOTAL(109,${table}[К выплате]),2)</totalsRowFormula></tableColumn>`;
      return `<tableColumn id="${id}" name="${esc(h)}"/>`;
    }).join('');
    files.push({
      name: `xl/tables/table${si + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${si + 1}" name="${table}" displayName="${table}" ref="A1:M${totalRow}" totalsRowCount="1"><autoFilter ref="A1:M${last}"/><tableColumns count="13">${cols}</tableColumns><tableStyleInfo name="TableStyleMedium9" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
    });
    totals.push({ name: names[si]!, table, qty, sum });
  });

  // сводный лист: итог по псевдонимам и общий итог = число в ведомости
  const totalKop = roundDiv(grandScaled, SCALE3, mode);
  if (sheets.length > 1) {
    const si = sheets.length;
    const rowsX: string[] = [`<row r="1"><c r="A1" t="s"><v>${s('Псевдоним')}</v></c><c r="B1" t="s"><v>${s('Тираж')}</v></c><c r="C1" t="s"><v>${s('К выплате')}</v></c></row>`];
    totals.forEach((t, i) => {
      const rn = i + 2;
      rowsX.push(`<row r="${rn}"><c r="A${rn}" t="s"><v>${s(t.name)}</v></c><c r="B${rn}" s="2"><f>SUBTOTAL(109,${t.table}[Тираж])</f><v>${t.qty}</v></c><c r="C${rn}" s="2"><f>SUBTOTAL(109,${t.table}[К выплате])</f><v>${numStr(t.sum)}</v></c></row>`);
    });
    const tr = totals.length + 2;
    rowsX.push(`<row r="${tr}"><c r="A${tr}" t="s"><v>${s(`Итого к выплате (${MODE_TEXT[mode]})`)}</v></c><c r="B${tr}" s="2"><f>SUM(B2:B${tr - 1})</f><v>${totals.reduce((a, t) => a + t.qty, 0)}</v></c><c r="C${tr}" s="2"><f>${FN}(SUM(C2:C${tr - 1}),2)</f><v>${totalKop / 100}</v></c></row>`);
    files.push({
      name: `xl/worksheets/sheet${si + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="36" customWidth="1"/><col min="2" max="3" width="16" customWidth="1"/></cols><sheetData>${rowsX.join('')}</sheetData></worksheet>`,
    });
    names.push('Итого');
  }

  const n = names.length;
  files.unshift(
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}${sheets.map((_, i) => `<Override PartName="/xl/tables/table${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
  );
  files.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>` });
  return { buffer: zipFiles(files), totalKop, sheetNames: names };
}
