import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtRubPdf, longDate, quarterTitle, ratePctText, statementHtml } from './statementHtml.ts';

test('форматы PDF: рубли, дата, квартал, ставка', () => {
  assert.equal(fmtRubPdf(1577436), '15 774,36 ₽');
  assert.equal(fmtRubPdf(0), '0,00 ₽');
  assert.equal(fmtRubPdf(5), '0,05 ₽');
  assert.equal(longDate('2026-09-21'), '21 сентября 2026 г.');
  assert.equal(quarterTitle('2026Q2'), 'за 2-ий квартал 2026 года');
  assert.equal(ratePctText('70'), '70,00%');
  assert.equal(ratePctText('66.66'), '66,66%');
  assert.equal(ratePctText(''), '—');
});

test('ведомость: все поля образца на месте, текст экранируется', () => {
  const h = statementHtml({
    quarter: '2026Q2', city: 'Санкт-Петербург', date: '2026-09-21', streams: 1417612, ratePct: '70', netKop: 1577436, accumulatedKop: 0, payableKop: 1577436,
    payeeName: 'Брянский Андрей <Николаевич>', inn: '504407626681', contractNumber: 'ПР-ИП/ССЮТ/25', licensee: 'ИП Федотов Иван Васильевич',
  });
  for (const t of ['ОТЧЁТНАЯ ВЕДОМОСТЬ', 'за 2-ий квартал 2026 года', 'г. Санкт-Петербург', '21 сентября 2026 г.', '1 417 612', '70,00%', '15 774,36 ₽', 'Брянский Андрей &lt;Николаевич&gt;', '504407626681', 'ПР-ИП/ССЮТ/25', 'ИП Федотов Иван Васильевич', 'Накопительный итог за предыдущие Отчётные периоды', '0,00 ₽', 'Лицензиар', 'Лицензиат']) {
    assert.ok(h.includes(t), t);
  }
  assert.ok(!h.includes('<Николаевич>'));
});
