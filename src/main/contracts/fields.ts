// Редактируемые величины договора. Ключ = имя поля {{ключ|формат}} в шаблоне.
export type FieldKind = 'days' | 'money' | 'months' | 'percent';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  default: number;
  min: number;
  max: number;
  /** Группа в боковой панели. */
  group: 'money' | 'reports' | 'notice' | 'other';
}

export const FIELDS: FieldDef[] = [
  { key: 'threshold', label: 'Порог выплаты, ₽ (п. 4.5)', kind: 'money', default: 5000, min: 0, max: 10_000_000, group: 'money' },
  { key: 'fine', label: 'Штраф, ₽ (п. 4.12)', kind: 'money', default: 5000, min: 0, max: 10_000_000, group: 'money' },
  { key: 'cover_cost', label: 'Стоимость обложки, ₽ (п. 3.5)', kind: 'money', default: 500, min: 0, max: 10_000_000, group: 'money' },
  { key: 'rate_loss', label: 'Ставка при потере статуса, % (п. 4.13)', kind: 'percent', default: 50, min: 1, max: 100, group: 'money' },
  { key: 'report_days', label: 'Срок отчёта после квартала, календ. дн. (п. 4.3)', kind: 'days', default: 90, min: 1, max: 365, group: 'reports' },
  { key: 'pay_days', label: 'Срок выплаты после документов, раб. дн. (п. 4.2)', kind: 'days', default: 10, min: 1, max: 365, group: 'reports' },
  { key: 'objection_days', label: 'Возражения к отчёту, раб. дн. (п. 4.4)', kind: 'days', default: 5, min: 2, max: 365, group: 'reports' },
  { key: 'docs_days', label: 'Документы после приёмки отчёта, раб. дн. (п. 4.4)', kind: 'days', default: 3, min: 2, max: 365, group: 'reports' },
  { key: 'accept_days', label: 'Отчёт считается принятым через, раб. дн. (п. 4.4.1)', kind: 'days', default: 5, min: 2, max: 365, group: 'reports' },
  { key: 'sz_notice_days', label: 'Уведомление о потере статуса, раб. дн. (п. 4.10)', kind: 'days', default: 3, min: 2, max: 365, group: 'notice' },
  { key: 'sz_docs_days', label: 'Документы по смене статуса, дн. (п. 4.12)', kind: 'days', default: 10, min: 2, max: 365, group: 'notice' },
  { key: 'dispute_days', label: 'Срок на урегулирование разногласий, календ. дн. (п. 5.1)', kind: 'days', default: 30, min: 2, max: 365, group: 'notice' },
  { key: 'notice_days', label: 'Уведомление об отказе от договора, календ. дн. (п. 6.2)', kind: 'days', default: 60, min: 2, max: 365, group: 'notice' },
  { key: 'return_days', label: 'Возврат выплат при отказе, раб. дн. (п. 6.2)', kind: 'days', default: 10, min: 2, max: 365, group: 'notice' },
  { key: 'post_days', label: 'Расчёт после окончания, календ. дн. (п. 8.3)', kind: 'days', default: 60, min: 2, max: 365, group: 'notice' },
  { key: 'prolong_days', label: 'Отказ от автопролонгации за, календ. дн. (п. 1)', kind: 'days', default: 35, min: 2, max: 365, group: 'notice' },
  { key: 'approve_days', label: 'Молчание = согласие, раб. дн.', kind: 'days', default: 5, min: 2, max: 365, group: 'other' },
  { key: 'req_days', label: 'Копии документов по запросу, раб. дн.', kind: 'days', default: 2, min: 2, max: 365, group: 'other' },
  { key: 'rework_days', label: 'Уведомление о переработках, раб. дн.', kind: 'days', default: 2, min: 2, max: 365, group: 'other' },
  { key: 'release_months', label: 'Срок релиза, мес. (п. 6.3)', kind: 'months', default: 6, min: 2, max: 60, group: 'other' },
  { key: 'release_notice_days', label: 'Уведомление при отказе из-за релиза, календ. дн. (п. 6.3)', kind: 'days', default: 30, min: 2, max: 365, group: 'other' },
];

export const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export type Variant413 = 'rate' | 'nochange';
export interface ContractOptions { cover: boolean; release: boolean; p413: Variant413 }
export const DEFAULT_OPTIONS: ContractOptions = { cover: false, release: false, p413: 'rate' };

export interface Terms {
  fields: Record<string, number>;
  options: ContractOptions;
  okved: string | null;
}

export function defaultTerms(): Terms {
  return { fields: Object.fromEntries(FIELDS.map((f) => [f.key, f.default])), options: { ...DEFAULT_OPTIONS }, okved: null };
}

/** Значения полей с подстановкой умолчаний и проверкой границ. */
export function normalizeFields(input: Record<string, unknown> | undefined): { values: Record<string, number>; errors: string[] } {
  const values: Record<string, number> = {};
  const errors: string[] = [];
  for (const f of FIELDS) {
    const raw = input?.[f.key];
    let v = raw === undefined || raw === null || raw === '' ? f.default : Number(raw);
    if (!Number.isFinite(v) || !Number.isInteger(v)) { errors.push(`«${f.label}»: нужно целое число`); v = f.default; }
    else if (v < f.min || v > f.max) { errors.push(`«${f.label}»: допустимо от ${f.min} до ${f.max}`); v = f.default; }
    else if (f.kind === 'days' && v % 10 === 1 && v % 100 !== 11) { errors.push(`«${f.label}»: числа на 1 (21, 31…) нельзя — в тексте «рабочих дней», получится неверное склонение`); v = f.default; }
    values[f.key] = v;
  }
  return { values, errors };
}
