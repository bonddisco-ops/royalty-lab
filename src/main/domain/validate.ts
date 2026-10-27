import { digitsOnly } from './normalize.ts';

// Контрольные суммы ИНН / БИК / р/с / корр. счёта (алгоритмы ЦБ и ФНС).
// Проверено на всех строках стартовой базы.

export function validateInn(raw: unknown): boolean {
  const s = digitsOnly(raw);
  const d = [...s].map(Number);
  if (s.length === 10) {
    const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    return (sum(d, w) % 11) % 10 === d[9];
  }
  if (s.length === 12) {
    const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    const w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
    return (sum(d, w1) % 11) % 10 === d[10] && (sum(d, w2) % 11) % 10 === d[11];
  }
  return false;
}

function sum(d: number[], w: number[]): number {
  let t = 0;
  for (let i = 0; i < w.length; i++) t += d[i]! * w[i]!;
  return t;
}

export function validateBik(raw: unknown): boolean {
  const s = digitsOnly(raw);
  return s.length === 9 && s.startsWith('04');
}

function accountChecksum(prefix: string, account: string): boolean {
  const s = prefix + account;
  if (account.length !== 20 || !/^\d+$/.test(s)) return false;
  const w = [7, 1, 3];
  let t = 0;
  for (let i = 0; i < s.length; i++) t += (Number(s[i]) * w[i % 3]!) % 10;
  return t % 10 === 0;
}

/** Расчётный счёт проверяется вместе с БИК (последние 3 цифры БИК). */
export function validateAccount(account: unknown, bik: unknown): boolean {
  const a = digitsOnly(account);
  const b = digitsOnly(bik);
  if (b.length !== 9) return false;
  return accountChecksum(b.slice(-3), a);
}

/** Корр. счёт: '0' + 5-6 цифры БИК. */
export function validateCorrAccount(corr: unknown, bik: unknown): boolean {
  const c = digitsOnly(corr);
  const b = digitsOnly(bik);
  if (b.length !== 9) return false;
  return accountChecksum('0' + b.slice(4, 6), c);
}

export interface PersonCheck {
  field: string;
  message: string;
}

/** Проверки карточки человека. Пустые поля не ошибка (их подсвечивает индикатор полноты). */
export function checkPerson(p: Record<string, unknown>): PersonCheck[] {
  const out: PersonCheck[] = [];
  if (p.inn && !validateInn(p.inn)) out.push({ field: 'inn', message: 'ИНН: не сходится контрольная сумма' });
  if (p.bank_bik && !validateBik(p.bank_bik)) out.push({ field: 'bank_bik', message: 'БИК: нужно 9 цифр, начинается с 04' });
  if (p.bank_account && p.bank_bik && !validateAccount(p.bank_account, p.bank_bik))
    out.push({ field: 'bank_account', message: 'Расчётный счёт: не сходится контрольная сумма с БИК' });
  if (p.bank_corr_account && p.bank_bik && !validateCorrAccount(p.bank_corr_account, p.bank_bik))
    out.push({ field: 'bank_corr_account', message: 'Корр. счёт: не сходится контрольная сумма с БИК' });
  return out;
}

/** Поля, которые считаются полными данными для выплаты (индикатор полноты). */
export const COMPLETENESS_FIELDS: Array<[string, string]> = [
  ['last_name', 'Фамилия'],
  ['first_name', 'Имя'],
  ['birth_date', 'Дата рождения'],
  ['passport_series', 'Серия паспорта'],
  ['passport_number', 'Номер паспорта'],
  ['passport_issued_by', 'Кем выдан'],
  ['inn', 'ИНН'],
  ['addr_raw', 'Адрес'],
  ['bank_name', 'Банк'],
  ['bank_bik', 'БИК'],
  ['bank_account', 'Расчётный счёт'],
  ['email', 'Email'],
];

export function completeness(p: Record<string, unknown>): { filled: number; total: number; missing: string[] } {
  const missing: string[] = [];
  for (const [f, label] of COMPLETENESS_FIELDS) {
    const v = p[f];
    if (v === null || v === undefined || String(v).trim() === '') missing.push(label);
  }
  return { filled: COMPLETENESS_FIELDS.length - missing.length, total: COMPLETENESS_FIELDS.length, missing };
}

/** PII: маскируются в интерфейсе, по умолчанию не попадают в файл обновления. */
export const PII_FIELDS = [
  'birth_date',
  'inn',
  'snils',
  'passport_series',
  'passport_number',
  'passport_issued_by',
  'passport_issued_date',
  'passport_division_code',
  'addr_region',
  'addr_city',
  'addr_street',
  'addr_house',
  'addr_flat',
  'addr_zip',
  'addr_raw',
  'bank_name',
  'bank_bik',
  'bank_corr_account',
  'bank_account',
  'phone',
  'email',
] as const;

export function maskValue(v: unknown): string {
  const s = String(v ?? '');
  if (!s) return '';
  const tail = s.replace(/\s+/g, '').slice(-4);
  return '••••' + (s.length > 4 ? tail : '');
}
