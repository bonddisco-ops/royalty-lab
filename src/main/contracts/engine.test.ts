import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipAll } from '../export/zipReader.ts';
import { buildDocx, resolveTexts, splitBody, type AppendixInput, type ContractInput, type Licensor } from './engine.ts';
import { defaultTerms } from './fields.ts';

const lic = (kind: 'ip' | 'sz'): Licensor => ({
  kind, lastName: 'Тестов', firstName: 'Тест', middleName: 'Тестович', inn: '123456789012', ogrnip: kind === 'ip' ? '312345678901234' : null, okved: kind === 'ip' ? '90.01' : null,
  birthDate: '1990-01-02', passportSeries: '4500', passportNumber: '123456', passportIssuedBy: 'ОВД ТЕСТОВЫЙ', passportIssuedDate: '2010-03-04',
  address: 'г. Москва, ул. Тестовая, д. 1', bankName: 'АО "Банк"', bankAccount: '40817810000000000001', bankCorrAccount: '30101810000000000002', bankBik: '044525000', email: 'test@example.com',
});
const input = (kind: 'ip' | 'sz', over: Partial<ContractInput> = {}): ContractInput => {
  const t = defaultTerms();
  return { number: 'ПР-СЗ/ТТ/26', date: '2026-10-27', licensor: lic(kind), fields: t.fields, options: t.options, ...over };
};
const appx: AppendixInput = {
  no: 1, date: '2026-10-27',
  tracks: [
    { title: 'Трек А', performers: 'Артист', lyricists: 'Тестов Т.Т.', composers: 'Тестов Т.Т.', makers: 'Тестов Т.Т.', year: '2026', shareAuthors: '50%', shareRelated: '35%', term: '27.10.2026 - 27.10.2036', explicit: 'нет', rate: '80%' },
    { title: 'Трек Б & <b>', performers: 'Артист', lyricists: '-', composers: '-', makers: '-', year: '2026', shareAuthors: '0%', shareRelated: '35%', term: '27.10.2026 - 27.10.2036', explicit: 'нет', rate: '80%' },
  ],
  videos: [], images: [],
};
const docText = (buf: Buffer): string => unzipAll(buf).get('word/document.xml')!.toString('utf8');
const plain = (xml: string): string => xml.replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

test('договор самозанятого: поля подставлены, токенов не осталось, ПД шаблона нет', () => {
  const x = docText(buildDocx(input('sz'), { contract: true, appendix: appx }));
  assert.ok(!x.includes('{{'), 'остались неподставленные поля');
  const t = plain(x);
  assert.ok(t.includes('ЛИЦЕНЗИОННЫЙ ДОГОВОР № ПР-СЗ/ТТ/26'));
  assert.ok(t.includes('Плательщик Налога на профессиональный доход (самозанятое лицо) Тестов Тест Тестович (ИНН: 123456789012)'));
  assert.ok(t.includes('«Лицензиар», с другой стороны,'));
  assert.ok(t.includes('менее 5 000 (пять тысяч) рублей'));
  assert.ok(t.includes('статуса самозанятого по любому основанию'));
  assert.ok(t.includes('в течение 90 (девяносто) календарных дней'));
  assert.ok(t.includes('составит 50% (пятьдесят процентов)'));
  assert.ok(t.includes('Трек Б & <b>'));
  assert.ok(!t.includes('Обложк') || false);
  assert.ok(!t.includes('3.5 ') && !t.includes('6.3 '), 'необязательные пункты включились сами');
  for (const bad of ['Поняев', 'Шевченко', 'DENISRUBLEV', '773270260432']) assert.ok(!t.includes(bad), bad);
});

test('договор ИП: статус, ОГРНИП, ОКВЭД', () => {
  const t = plain(docText(buildDocx(input('ip'), { contract: true })));
  assert.ok(t.includes('Индивидуальный предприниматель Тестов Тест Тестович (ИНН: 123456789012, ОГРНИП: 312345678901234)'));
  assert.ok(t.includes('статуса индивидуального предпринимателя по любому основанию'));
  assert.ok(!t.includes('самозанятого'));
  assert.ok(t.includes('ОКВЭД: 90.01'));
});

test('необязательные пункты 3.5 и 6.3, вариант 4.13, поля с прописью', () => {
  const base = input('sz');
  const t = plain(docText(buildDocx({ ...base, fields: { ...base.fields, threshold: 3000, cover_cost: 700, report_days: 45 }, options: { cover: true, release: true, p413: 'nochange' } }, { contract: true })));
  assert.ok(t.includes('3.5'));
  assert.ok(t.includes('700 (Семьсот) рублей'));
  assert.ok(t.includes('6.3'));
  assert.ok(t.includes('6 (шести) месяцев'));
  assert.ok(t.includes('менее 3 000 (три тысячи) рублей'));
  assert.ok(t.includes('45 (сорока пяти)'));
  assert.ok(t.includes('Утрата Лицензиаром статуса ИП не влияет'));
  assert.ok(!t.includes('составит 50%'));
});

test('частичная сборка: только договор / только приложение, структура docx цела', () => {
  const only = buildDocx(input('sz'), { contract: true });
  const body = splitBody(docText(only)).elems.map((e) => plain(e)).join('');
  assert.ok(!body.includes('ПЕРЕЧЕНЬ ОБЪЕКТОВ'));
  const app = buildDocx(input('sz'), { contract: false, appendix: appx });
  const bx = docText(app);
  const ab = plain(bx);
  assert.ok(ab.startsWith('ПЕРЕЧЕНЬ ОБЪЕКТОВ') || ab.trimStart().startsWith('ПЕРЕЧЕНЬ'));
  assert.ok(!ab.includes('ПРЕДМЕТ ДОГОВОРА'));
  assert.ok(bx.includes('w:orient="landscape"') && bx.includes('w:headerReference'));
  assert.ok(ab.includes('Приложение № 1 к Лицензионному договору № ПР-СЗ/ТТ/26 от 27.10.2026 года'));
  assert.ok(ab.includes('27 октября 2026 года'));
  for (const name of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/header1.xml']) assert.ok(unzipAll(app).has(name), name);
  // нумерация строк
  assert.ok(/1Трек А/.test(ab) && /2Трек Б/.test(ab));
});

test('неверные значения полей и пустые данные: понятные ошибки / пометки', () => {
  const base = input('sz');
  assert.throws(() => buildDocx({ ...base, fields: { ...base.fields, pay_days: 21 } }, { contract: true }), /21|1 \(21/);
  assert.throws(() => buildDocx({ ...base, fields: { ...base.fields, threshold: -5 } }, { contract: true }), /Порог/);
  const r = resolveTexts({ ...base, licensor: { ...base.licensor, inn: null, bankAccount: '' } });
  assert.deepEqual(r.missing.sort(), ['ИНН', 'расчётный счёт'].sort());
  assert.ok(r.values.licensor_intro.includes('____'));
});
