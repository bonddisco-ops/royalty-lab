// HTML «ОТЧЁТНАЯ ВЕДОМОСТЬ» (A4 альбомная) по образцу Shtain_Q2_2026.pdf. Чистая функция: печатается в PDF через Electron (printToPDF).
import { LOGO_PNG_BASE64 } from './logo.ts';

export interface StatementData {
  quarter: string; // 2026Q2
  city: string;
  /** Дата ведомости, ГГГГ-ММ-ДД. */
  date: string;
  streams: number;
  /** Генеральная ставка роялти (средневзвешенная ставка лейбла), %, например '70'. */
  ratePct: string;
  /** Чистый доход лицензиара за период, копейки. */
  netKop: number;
  /** Накопительный итог за предыдущие периоды, копейки. */
  accumulatedKop: number;
  /** Итого к выплате, копейки. */
  payableKop: number;
  payeeName: string;
  inn: string | null;
  contractNumber: string;
  licensee: string;
  /** Сумма ниже порога и переносится. */
  heldNote?: string | null;
}

const NB = ' ';
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function fmtRubPdf(kop: number): string {
  const neg = kop < 0;
  const a = Math.abs(kop);
  const rub = String(Math.trunc(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NB);
  return `${neg ? '−' : ''}${rub},${String(a % 100).padStart(2, '0')}${NB}₽`;
}
export const fmtIntPdf = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, NB);

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]} г.`;
}

const ORD = ['1-ый', '2-ий', '3-ий', '4-ый'];
export function quarterTitle(q: string): string {
  const m = /^(\d{4})Q([1-4])$/.exec(q);
  return m ? `за ${ORD[Number(m[2]) - 1]} квартал ${m[1]} года` : `за ${q}`;
}

export function ratePctText(p: string): string {
  const n = Number(p.replace(',', '.'));
  return Number.isFinite(n) && p !== '' ? `${n.toFixed(2).replace('.', ',')}%` : '—';
}

export function statementHtml(d: StatementData): string {
  const css = `
@page { size: A4 landscape; margin: 0 }
* { box-sizing: border-box; margin: 0; padding: 0 }
html, body { width: 841.9pt; height: 595.3pt }
body { font-family: 'Bahnschrift Condensed', 'Bahnschrift', 'Avenir Next Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif; font-stretch: condensed; font-size: 10pt; color: #000; position: relative; overflow: hidden }
.abs { position: absolute }
.logo { left: 70pt; top: 58pt; height: 88pt }
h1 { font-size: 15pt; font-weight: 700; text-decoration: underline; text-align: center }
.sub { font-size: 12pt; text-align: center }
table { border-collapse: collapse }
td, th { border: 1.6pt solid #000; text-align: center; vertical-align: middle; padding: 3pt 5pt; font-weight: 400 }
th { font-weight: 700 }
.t1 td, .t1 th { height: 24pt }
.t2 td { height: 20pt }
.t2 td:first-child { width: 60pt }
.right { text-align: right }
.box { border: 1.6pt solid #000; padding: 3pt 8pt; text-align: center; white-space: nowrap; font-size: 10.5pt }
.line { border-top: 0.8pt solid #000 }
.note { font-size: 9pt; font-style: italic }
`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчётная ведомость</title><style>${css}</style></head><body>
<img class="abs logo" alt="" src="data:image/png;base64,${LOGO_PNG_BASE64}">
<div class="abs" style="left:0;width:841.9pt;top:70pt"><h1>ОТЧЁТНАЯ ВЕДОМОСТЬ</h1><div class="sub">${esc(quarterTitle(d.quarter))}</div></div>
<div class="abs" style="left:112pt;top:155pt;font-size:11pt">г. ${esc(d.city)}</div>
<div class="abs" style="right:105pt;top:155pt;font-size:11pt">${esc(longDate(d.date))}</div>
<table class="abs t1" style="left:150pt;top:224pt;width:325pt">
  <tr><th style="width:80pt">Общее количество стримов</th><th style="width:90pt">Генеральная ставка роялти</th><th>Чистый доход лицензиара</th></tr>
  <tr><td>${fmtIntPdf(d.streams)}</td><td>${esc(ratePctText(d.ratePct))}</td><td>${fmtRubPdf(d.netKop)}</td></tr>
</table>
<table class="abs t2" style="left:512pt;top:224pt;width:228pt">
  <tr><td>Контрагент</td><td>${esc(d.payeeName)}</td></tr>
  <tr><td>ИНН</td><td>${esc(d.inn ?? '—')}</td></tr>
  <tr><td>Договор</td><td>${esc(d.contractNumber)}</td></tr>
</table>
<div class="abs right" style="left:40pt;width:348pt;top:322pt">Накопительный итог за предыдущие Отчётные периоды:</div>
<div class="abs" style="left:419pt;top:322pt">${fmtRubPdf(d.accumulatedKop)}</div>
<div class="abs right" style="left:40pt;width:348pt;top:342pt">Итого за Отчётный период сумма к выплате Лицензиару составляет (без${NB}НДС):</div>
<div class="abs box" style="left:390pt;top:336pt;width:82pt">${fmtRubPdf(d.payableKop)}</div>
${d.heldNote ? `<div class="abs note" style="left:112pt;top:372pt">${esc(d.heldNote)}</div>` : ''}
<div class="abs" style="left:154pt;top:407pt">Лицензиар</div>
<div class="abs" style="left:154pt;top:424pt">${esc(d.payeeName)}</div>
<div class="abs" style="left:537pt;top:407pt">Лицензиат</div>
<div class="abs" style="left:537pt;top:424pt">${esc(d.licensee)}</div>
<div class="abs line" style="left:154pt;top:485pt;width:150pt"></div>
<div class="abs line" style="left:537pt;top:485pt;width:150pt"></div>
</body></html>`;
}
