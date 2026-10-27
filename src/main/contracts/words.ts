// Числа прописью (русский), суммы в рублях и даты. Нужны для «10 (десяти) рабочих дней», «5 000 (пять тысяч) рублей».

type Case = 'nom' | 'gen';

const ONES_NOM = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_GEN = ['', 'одного', 'двух', 'трех', 'четырех', 'пяти', 'шести', 'семи', 'восьми', 'девяти'];
const TEENS_NOM = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TEENS_GEN = ['десяти', 'одиннадцати', 'двенадцати', 'тринадцати', 'четырнадцати', 'пятнадцати', 'шестнадцати', 'семнадцати', 'восемнадцати', 'девятнадцати'];
const TENS_NOM = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const TENS_GEN = ['', '', 'двадцати', 'тридцати', 'сорока', 'пятидесяти', 'шестидесяти', 'семидесяти', 'восьмидесяти', 'девяноста'];
const HUND_NOM = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const HUND_GEN = ['', 'ста', 'двухсот', 'трехсот', 'четырехсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];

/** Слова для 0..999 (мужской род; «одна/две тысячи» учитываются снаружи). */
function triple(n: number, c: Case, feminine = false): string[] {
  const o = c === 'nom' ? ONES_NOM : ONES_GEN;
  const out: string[] = [];
  out.push((c === 'nom' ? HUND_NOM : HUND_GEN)[Math.floor(n / 100)]!);
  const r = n % 100;
  if (r >= 10 && r < 20) out.push((c === 'nom' ? TEENS_NOM : TEENS_GEN)[r - 10]!);
  else {
    out.push((c === 'nom' ? TENS_NOM : TENS_GEN)[Math.floor(r / 10)]!);
    let one = o[r % 10]!;
    if (feminine) one = c === 'nom' ? (r % 10 === 1 ? 'одна' : r % 10 === 2 ? 'две' : one) : (r % 10 === 1 ? 'одной' : one);
    out.push(one);
  }
  return out.filter(Boolean);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

const THOUSAND: Record<Case, [string, string, string]> = { nom: ['тысяча', 'тысячи', 'тысяч'], gen: ['тысячи', 'тысяч', 'тысяч'] };
const MILLION: Record<Case, [string, string, string]> = { nom: ['миллион', 'миллиона', 'миллионов'], gen: ['миллиона', 'миллионов', 'миллионов'] };

/** Число прописью: 0 ≤ n < 1 000 000 000. */
export function numToWords(n: number, c: Case = 'nom'): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) throw new Error('Число вне допустимого диапазона');
  if (n === 0) return c === 'nom' ? 'ноль' : 'нуля';
  const parts: string[] = [];
  const mil = Math.floor(n / 1e6), th = Math.floor((n % 1e6) / 1000), rest = n % 1000;
  if (mil) parts.push(...triple(mil, c), c === 'nom' ? plural(mil, ...MILLION.nom) : plural(mil, ...MILLION.gen));
  if (th) parts.push(...triple(th, c, true), c === 'nom' ? plural(th, ...THOUSAND.nom) : plural(th, ...THOUSAND.gen));
  if (rest) parts.push(...triple(rest, c));
  return parts.join(' ');
}

export const capFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** 5000 → «5 000» (неразрывный пробел не нужен: Word сам не переносит цифры). */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** «10 (десяти)» / «90 (девяносто)». */
export function countWords(n: number, c: Case = 'gen', cap = false): string {
  // В действующих договорах «90 (девяносто) календарных дней» — сохраняем эту формулировку как есть.
  const w = n === 90 ? 'девяносто' : numToWords(n, c);
  return `${groupDigits(n)} (${cap ? capFirst(w) : w})`;
}

/** «5 000 (пять тысяч) рублей» — сумма в рублях, рубли согласуются с числом. */
export function rubWords(n: number, cap = false): string {
  const w = numToWords(n, 'nom');
  return `${groupDigits(n)} (${cap ? capFirst(w) : w}) ${plural(n, 'рубль', 'рубля', 'рублей')}`;
}

/** «6 (шести) месяцев». */
export function monthsWords(n: number): string {
  return `${groupDigits(n)} (${numToWords(n, 'gen')}) ${n % 10 === 1 && n % 100 !== 11 ? 'месяца' : 'месяцев'}`;
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** 2026-07-31 → «31.07.2026». */
export function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('Дата в виде 2026-07-31');
  return `${m[3]}.${m[2]}.${m[1]}`;
}
/** 2026-07-31 → «31 июля 2026 года». */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('Дата в виде 2026-07-31');
  return `${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]!} ${m[1]} года`;
}
