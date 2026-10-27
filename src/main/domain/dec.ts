// Точные десятичные числа без float: BigInt с масштабом 1e12.
// Для долей и ставок. Деньги (копейки) в этом модуле не считаем.
const SCALE = 12;
export const DEC_ONE = 10n ** BigInt(SCALE);

/** "0.3333" | "0,3333" | "1" | " 50 " -> масштабированное BigInt, либо null если не число. */
export function parseDec(input: unknown): bigint | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[\s ]/g, '').replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [intPart = '0', fracPart = ''] = body.split('.');
  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE);
  const v = BigInt(intPart || '0') * DEC_ONE + BigInt(frac);
  return neg ? -v : v;
}

export function formatDec(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / DEC_ONE;
  const frac = (a % DEC_ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + int.toString() + (frac ? '.' + frac : '');
}

/** Проценты ("9,99%", "50", "33,34") -> доля строкой ("0.0999", "0.5", "0.3334"). */
export function pctToShare(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace('%', '');
  const v = parseDec(s);
  if (v === null) return null;
  return formatDec(v / 100n);
}

export function normDecString(input: unknown): string | null {
  const v = parseDec(input);
  return v === null ? null : formatDec(v);
}

export function sumDec(list: Array<string | null | undefined>): bigint {
  let t = 0n;
  for (const x of list) {
    const v = parseDec(x ?? '0');
    if (v !== null) t += v;
  }
  return t;
}

export const SHARE_TOLERANCE = parseDec('0.0001') as bigint;

export function isWholeShare(sum: bigint): boolean {
  const d = sum - DEC_ONE;
  return (d < 0n ? -d : d) <= SHARE_TOLERANCE;
}

export function decEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseDec(a ?? '');
  const y = parseDec(b ?? '');
  return x !== null && y !== null && x === y;
}
