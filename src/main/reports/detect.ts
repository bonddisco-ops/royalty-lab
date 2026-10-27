import type { BuiltinFormat, WorkbookData } from './types.ts';
import { detectEffective } from './parse/effective.ts';
import { detectFmk } from './parse/fmk.ts';
import { detectAlligator } from './parse/musicAlligator.ts';
import { detectSilk } from './parse/silk.ts';
import { detectSpDigital } from './parse/spDigital.ts';

/** Формат по содержимому, не по имени файла. null = незнакомый формат (мастер сопоставления). */
export function detectBuiltin(wb: WorkbookData): BuiltinFormat | null {
  if (detectSpDigital(wb)) return 'sp_digital';
  if (detectEffective(wb)) return 'effective';
  if (detectFmk(wb)) return 'fmk';
  if (detectAlligator(wb)) return 'music_alligator';
  if (detectSilk(wb)) return 'silk';
  return null;
}
