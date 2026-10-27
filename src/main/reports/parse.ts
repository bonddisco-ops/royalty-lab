import { detectBuiltin } from './detect.ts';
import { parseEffective } from './parse/effective.ts';
import { parseFmk } from './parse/fmk.ts';
import { parseAlligator } from './parse/musicAlligator.ts';
import { parseSilk } from './parse/silk.ts';
import { parseSpDigital } from './parse/spDigital.ts';
import { FormatError, type BuiltinFormat, type ParsedReport, type WorkbookData } from './types.ts';

export function parseBuiltin(wb: WorkbookData, format: BuiltinFormat): ParsedReport {
  switch (format) {
    case 'sp_digital': return parseSpDigital(wb);
    case 'effective': return parseEffective(wb);
    case 'fmk': return parseFmk(wb);
    case 'music_alligator': return parseAlligator(wb);
    case 'silk': return parseSilk(wb);
  }
}

/** Определяет формат и разбирает. Незнакомый формат — FormatError (дальше мастер сопоставления). */
export function parseKnown(wb: WorkbookData): ParsedReport {
  const f = detectBuiltin(wb);
  if (!f) throw new FormatError('Незнакомый формат отчёта');
  return parseBuiltin(wb, f);
}
