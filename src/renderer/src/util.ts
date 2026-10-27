import { formatDec, parseDec, pctToShare } from '../../main/domain/dec.ts';

/** Доля "0.5" → "50" (проценты для показа). */
export function shareToPct(share: string | null | undefined): string {
  const v = parseDec(share);
  return v === null ? '' : formatDec(v * 100n);
}
export const pctInput = (s: string): string | null => pctToShare(s);

const RUB = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Копейки → «633 222,50 ₽» (только показ; в расчётах деньги всегда целые копейки). */
export const fmtKop = (kop: number | null | undefined): string => (kop === null || kop === undefined ? '—' : `${RUB.format(kop / 100)} ₽`);
export const fmtInt = (n: number): string => new Intl.NumberFormat('ru-RU').format(n);
export const FLOW_LABELS: Record<string, string> = { artists: 'Артистам', personal: 'Личный доход', ignore: 'Игнор' };
export const SCOPE_LABELS: Record<string, string> = { authors: 'Авторские', related: 'Смежные', mixed: 'Авторские + смежные' };
export const STREAM_LABELS: Record<string, string> = { paid: 'Платные стримы', ad: 'Рекламные стримы', other: 'Загрузки и прочее', nonstream: 'Без стримов' };
export const quarterLabel = (q: string): string => (/^\d{4}Q[1-4]$/.test(q) ? `${q.slice(5)} кв. ${q.slice(0, 4)}` : q || '—');
