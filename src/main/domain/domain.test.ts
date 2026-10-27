import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDec, isWholeShare, parseDec, pctToShare, sumDec } from './dec.ts';
import { uuidv7 } from './ids.ts';
import { cleanText, isIsrc, normKey, parseRuDate } from './normalize.ts';
import { checkPerson, completeness, maskValue, validateAccount, validateBik, validateCorrAccount, validateInn } from './validate.ts';

test('доли хранятся точно и без float', () => {
  assert.equal(pctToShare('9,99%'), '0.0999');
  assert.equal(pctToShare('33,34'), '0.3334');
  assert.equal(pctToShare('100'), '1');
  assert.equal(formatDec(parseDec('0.6666')!), '0.6666');
  assert.equal(parseDec('abc'), null);
  assert.ok(isWholeShare(sumDec(['0.3333', '0.3333', '0.3334'])));
  assert.ok(isWholeShare(sumDec(['0.3333', '0.3333', '0.3333']))); // допуск 0.0001
  assert.ok(!isWholeShare(sumDec(['0.5', '0.4'])));
});

test('нормализация имён: регистр, пробелы, ё=е, диакритика; «й» сохраняется', () => {
  assert.equal(normKey('Vladis Cue'), normKey('VladisCue'));
  assert.equal(normKey('ARRÉ'), 'arre');
  assert.equal(normKey('Señorita'), 'senorita');
  assert.equal(normKey('Её'), normKey('ее'));
  assert.notEqual(normKey('май'), normKey('маи'));
  assert.equal(cleanText('  Squad  Techno  (Extended Mix) '), 'Squad Techno (Extended Mix)');
});

test('ISRC против внутренних кодов', () => {
  assert.ok(isIsrc('AEA2Z2620508'));
  assert.ok(isIsrc('ru agv 26 10043'.replace(/ /g, '')));
  assert.ok(!isIsrc('PRR00025'));
  assert.ok(!isIsrc('ORPM04848'));
});

test('даты ДД.ММ.ГГГГ', () => {
  assert.equal(parseRuDate('08.08.2003'), '2003-08-08');
  assert.equal(parseRuDate('29'), null);
  assert.equal(parseRuDate('31.13.2020'), null);
});

test('контрольные суммы ИНН / БИК / р/с / корр. счёта', () => {
  assert.ok(validateInn('7707083893')); // Сбербанк, ИНН юрлица (10)
  assert.ok(!validateInn('7707083894'));
  assert.ok(validateInn('525011482295')); // ИНН физлица (12) из тестового набора
  assert.ok(validateBik('044525225'));
  assert.ok(!validateBik('123456789'));
  assert.ok(validateCorrAccount('30101810400000000225', '044525225'));
  assert.ok(!validateCorrAccount('30101810400000000226', '044525225'));
  assert.ok(!validateAccount('40817810900004466593', '044525974'));
});

test('карточка человека: проверки и индикатор полноты', () => {
  assert.equal(checkPerson({ inn: '123' }).length, 1);
  assert.equal(checkPerson({}).length, 0);
  const c = completeness({ last_name: 'Иванов', first_name: 'Иван' });
  assert.equal(c.filled, 2);
  assert.ok(c.missing.includes('ИНН'));
  assert.equal(maskValue('4011 113154'), '••••3154');
});

test('uuidv7 монотонен и корректен', () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7());
  assert.ok(ids.every((x) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x)));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
  assert.equal(new Set(ids).size, ids.length);
});
