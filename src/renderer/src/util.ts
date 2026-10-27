import { formatDec, parseDec, pctToShare } from '../../main/domain/dec.ts';

/** Доля "0.5" → "50" (проценты для показа). */
export function shareToPct(share: string | null | undefined): string {
  const v = parseDec(share);
  return v === null ? '' : formatDec(v * 100n);
}
export const pctInput = (s: string): string | null => pctToShare(s);
