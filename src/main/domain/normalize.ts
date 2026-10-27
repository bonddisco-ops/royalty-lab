// Нормализация для сопоставления: нижний регистр, без пробелов, пунктуации и диакритики, ё = е.
// Кириллическое «й» сохраняется (его нельзя разбирать на «и» + знак).
export function normKey(input: unknown): string {
  let s = String(input ?? '');
  s = s.replace(/[À-ɏ]/g, (ch) => ch.normalize('NFD').replace(/\p{M}/gu, ''));
  s = s.toLowerCase().replace(/ё/g, 'е');
  return s.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Обрезать края и схлопнуть повторные пробелы (включая неразрывные). */
export function cleanText(input: unknown): string {
  return String(input ?? '').replace(/[\s ]+/g, ' ').trim();
}

export function digitsOnly(input: unknown): string {
  return String(input ?? '').replace(/\D+/g, '');
}

export function hasMessyWhitespace(input: unknown): boolean {
  const s = String(input ?? '');
  return s !== cleanText(s);
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
export function normIsrc(input: unknown): string {
  return String(input ?? '').replace(/[\s-]+/g, '').toUpperCase();
}
export function isIsrc(input: unknown): boolean {
  return ISRC_RE.test(normIsrc(input));
}

/** "21.03.1982" -> "1982-03-21"; мусор -> null. */
export function parseRuDate(input: unknown): string | null {
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(cleanText(input));
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
