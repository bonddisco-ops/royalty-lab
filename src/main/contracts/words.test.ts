import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords, dmy, longDate, monthsWords, numToWords, rubWords } from './words.ts';

test('числа прописью: родительный и именительный', () => {
  assert.equal(numToWords(10, 'gen'), 'десяти');
  assert.equal(numToWords(90, 'nom'), 'девяносто');
  assert.equal(numToWords(60, 'nom'), 'шестьдесят');
  assert.equal(numToWords(60, 'gen'), 'шестидесяти');
  assert.equal(numToWords(35, 'nom'), 'тридцать пять');
  assert.equal(numToWords(3, 'gen'), 'трех');
  assert.equal(numToWords(5000, 'nom'), 'пять тысяч');
  assert.equal(numToWords(21000, 'nom'), 'двадцать одна тысяча');
  assert.equal(numToWords(2500, 'nom'), 'две тысячи пятьсот');
  assert.equal(numToWords(1234567, 'nom'), 'один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь');
});
test('«N (слова)» как в договоре', () => {
  assert.equal(countWords(10, 'gen'), '10 (десяти)');
  assert.equal(countWords(60, 'nom', true), '60 (Шестьдесят)');
  assert.equal(countWords(5, 'gen'), '5 (пяти)');
  assert.equal(rubWords(5000), '5 000 (пять тысяч) рублей');
  assert.equal(rubWords(500, true), '500 (Пятьсот) рублей');
  assert.equal(rubWords(1000), '1 000 (одна тысяча) рублей');
  assert.equal(rubWords(1), '1 (один) рубль');
  assert.equal(monthsWords(6), '6 (шести) месяцев');
});
test('даты', () => {
  assert.equal(dmy('2026-07-31'), '31.07.2026');
  assert.equal(longDate('2026-07-31'), '31 июля 2026 года');
  assert.throws(() => dmy('31.07.2026'));
});
