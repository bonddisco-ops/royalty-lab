// Синтетические данные, повторяющие странности настоящего файла. Реальные данные в репозиторий не кладём.
export const person = (o: Partial<Record<string, string>>): string[] => {
  const keys = ['folder', 'fio', 'status', 'no', 'date', 'tpl', 'birth', 'series', 'number', 'issued', 'addr', 'inn', 'bank', 'bik', 'corr', 'acc', 'email', 'rate', 'thr', 'file'];
  return keys.map((k) => o[k] ?? '');
};
export const PEOPLE_HEAD = person({});
export const sampleSheets = {
  people: [
    PEOPLE_HEAD,
    person({ folder: 'Alpha, Beta', fio: 'ИП Иванов Иван Иванович ОГРНИП: 321000000000001 ИНН: 525011482295 ОКВЭД: 9', status: 'ИП', no: 'ПР-ИП/А/26', date: '29', tpl: 'A', birth: '01.02.1990', issued: '27.07.2011 г. ОТДЕЛОМ УФМС', inn: '525011482295', thr: '5 000', file: 'Договор ПР-ИП-А-26 от 05.03.2026.docx' }),
    person({ folder: 'Gassan', fio: 'Казахстан Юсибов Гасан', status: '?', no: 'ПР-КЗ/ЛМД', date: '14.11.2025', tpl: 'C' }),
    person({ folder: 'Delta', fio: 'Петров Пётр Петрович', status: 'СЗ', no: 'ПР-СЗ/Д/26', date: '01.10.2025', tpl: 'B', rate: '70', thr: '5000', inn: '7707083893' }),
    person({ folder: 'Eps', fio: 'Сидоров Сидор', status: 'СЗ', no: 'ПР-СЗ/Е/26', date: '01.10.2025', tpl: 'B', rate: '80', thr: '5000' }),
    person({ folder: 'IMSOLO', fio: 'Лишний Человек', status: 'СЗ', no: 'ПР-СЗ/И/26', date: '01.10.2025', tpl: 'B' }),
  ],
  appendix: [
    ['Папка', 'Договор', 'Трек', 'Исполнитель', 'Доля', 'Срок'],
    ['Alpha, Beta', 'ПР-ИП/А/26', 'Song One (Remix)', '', '50%', '01.10.2025 - 01.10.2035'],
    ['Delta', 'ПР-СЗ/Д/26', 'Song Two', 'Delta, Zed', '50 50', 'до 01.10.2035'],
    ['Delta', 'ПР-СЗ/Д/26', 'Song Three', '', '', 'до 01.10.2035'],
    ['Delta', 'ПР-СЗ/Д/26', 'Missing Track', '', '100', 'до 01.10.2035'],
    ['Eps', 'ПР-СЗ/Е/26', 'Наименование Произведения', 'Исполнитель', 'Авторские права', 'Смежные права'],
    ['Eps', 'ПР-СЗ/Е/26', 'Song Four', 'Eps', '80%', '60%'],
  ],
  split: [
    ['Артист', 'Трек', 'ISRC', 'Ставка в треке', 'Ставка лейбла'],
    ['Alpha', 'Song One', 'AEA2Z2620508', '0.4', '0.8'],
    ['Beta', 'Song One', 'AEA2Z2620508', '0.6', '0.8'],
    ['Delta', 'Song Two', 'RUAGV2600001', '1', '0.7'],
    ['Zed', 'Song Two', 'RUAGV2600001', '0', '0'],
    ['Delta', 'Song Three', 'RUAGV2600002', '0.5', '0.7'],
    [' Eps ', 'Song  Four', 'RUAGV2600003', '1', '0.8'],
    ['Eps', 'Song Four', 'RUAGV2600003', '1', '0.8'],
    ['Alpha', 'Code Song', 'PRR00001', '1', '1'],
    ['Alpha', 'Code Song', 'ORPM00001', '1', '1'],
    ['Matvey Emerson', 'Typo Song', 'AEA2Z2699999', '0.5', '1'],
    ['Matvey Emersson', 'Typo Song', 'AEA2Z2699999', '0.5', '1'],
  ],
  problems: [
    ['Кто/что', 'Трек/договор', 'Проблема', 'Детали'],
    ['Gassan', 'ПР-КЗ/ЛМД', 'нет ставки в договоре', 'проверить вручную'],
    ['Alpha', 'ПР-ИП/А/26', 'нет данных', 'паспорт'],
    ['Eps', 'Song  Four', 'лишние пробелы в названии', ''],
    ['Zed', '', 'артист из SPLIT без папки договора', ''],
    ['Alpha', 'Song One', 'сумма долей ≠100%', '0.4'],
  ],
};

