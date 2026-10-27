import type ExcelJS from 'exceljs';
import { SHEET_NAMES, type Matrix, type StarterSheets } from './starterParse.ts';

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const d = v.getUTCDate().toString().padStart(2, '0');
    const m = (v.getUTCMonth() + 1).toString().padStart(2, '0');
    return `${d}.${m}.${v.getUTCFullYear()}`;
  }
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v && v.result !== undefined) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text);
    return '';
  }
  return String(v);
}

function sheetToMatrix(ws: ExcelJS.Worksheet): Matrix {
  const rows: Matrix = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, 20); c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  });
  return rows;
}

export async function readStarterWorkbook(path: string): Promise<StarterSheets> {
  // exceljs подгружаем только когда он нужен (тяжёлая библиотека; не должна ронять запуск программы)
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs');
  const wb = new (mod.default ?? mod).Workbook();
  await wb.xlsx.readFile(path);
  const get = (name: string): Matrix => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`В файле нет листа «${name}». Это точно Стартовая_база.xlsx?`);
    return sheetToMatrix(ws);
  };
  return {
    people: get(SHEET_NAMES.people),
    appendix: get(SHEET_NAMES.appendix),
    split: get(SHEET_NAMES.split),
    problems: get(SHEET_NAMES.problems),
  };
}
