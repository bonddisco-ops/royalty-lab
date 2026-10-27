import type { ChannelMap, RlBridge } from '../../shared/api.ts';

declare global {
  interface Window {
    rl: RlBridge;
  }
}

/** Типизированный вызов ядра. Ошибка ядра приходит как обычное исключение с русским текстом. */
export async function call<K extends keyof ChannelMap>(channel: K, ...req: ChannelMap[K][0] extends void ? [] : [ChannelMap[K][0]]): Promise<ChannelMap[K][1]> {
  const res = await window.rl.invoke(channel, req[0]);
  if (!res.ok) throw new Error(res.error);
  return res.data as ChannelMap[K][1];
}

export const FIELD_LABELS: Record<string, string> = {
  last_name: 'Фамилия', first_name: 'Имя', middle_name: 'Отчество', birth_date: 'Дата рождения', status: 'Статус',
  inn: 'ИНН', ogrnip: 'ОГРНИП', snils: 'СНИЛС', passport_series: 'Паспорт, серия', passport_number: 'Паспорт, номер',
  passport_issued_by: 'Кем выдан', passport_issued_date: 'Дата выдачи', passport_division_code: 'Код подразделения',
  addr_zip: 'Индекс', addr_region: 'Регион', addr_city: 'Город', addr_street: 'Улица', addr_house: 'Дом', addr_flat: 'Квартира',
  addr_raw: 'Адрес (как в базе)', bank_name: 'Банк', bank_bik: 'БИК', bank_corr_account: 'Корр. счёт', bank_account: 'Расчётный счёт',
  email: 'E-mail', phone: 'Телефон', notes: 'Заметки',
};
export const FIELD_GROUPS: Array<[string, string[]]> = [
  ['Личные данные', ['last_name', 'first_name', 'middle_name', 'birth_date', 'status']],
  ['Документы', ['inn', 'ogrnip', 'snils', 'passport_series', 'passport_number', 'passport_issued_by', 'passport_issued_date', 'passport_division_code']],
  ['Адрес', ['addr_zip', 'addr_region', 'addr_city', 'addr_street', 'addr_house', 'addr_flat', 'addr_raw']],
  ['Банк', ['bank_name', 'bank_bik', 'bank_corr_account', 'bank_account']],
  ['Связь', ['email', 'phone', 'notes']],
];
export const ISSUE_LABELS: Record<string, string> = {
  no_contract: 'Нет договора', missing_pii: 'Не хватает данных', missing_rate: 'Нет ставки', whitespace: 'Лишние пробелы',
  isrc_title_conflict: 'Конфликт ISRC/названия', share_sum: 'Сумма долей ≠ 100%', no_appendix: 'Нет приложения',
};
export const issueLabel = (k: string): string => ISSUE_LABELS[k] ?? k;
