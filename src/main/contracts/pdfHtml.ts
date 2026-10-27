// PDF договора и приложения: HTML для печати в Electron (printToPDF). Разметка проще, чем в Word, текст тот же.
import { renderBlocks, type Block, type PBlock, type Seg } from './blocks.ts';
import { resolveTexts, type AppendixInput, type ContractInput } from './engine.ts';
import { LICENSEE_INTRO } from './licensee.ts';
import { longDate } from './words.ts';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function segHtml(s: Seg): string {
  const text = s.k === 't' ? s.v : s.k === 'f' ? s.text : s.v;
  const h = esc(text).replace(/\n/g, '<br>');
  return s.b ? `<b>${h}</b>` : h;
}
function pHtml(p: PBlock): string {
  if (!p.included) return '';
  const inner = p.segs.map(segHtml).join('');
  if (!inner.trim()) return '<p class="e">&nbsp;</p>';
  return `<p class="${p.heading ? 'h ' : ''}a-${p.align}">${inner}</p>`;
}
function blockHtml(b: Block): string {
  if (b.kind === 'p') return pHtml(b);
  const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${c.map(pHtml).join('')}</td>`).join('')}</tr>`).join('');
  return `<table class="t">${rows}</table>`;
}

const cell = (s: string): string => `<td>${esc(s)}</td>`;

function appendixHtml(input: ContractInput, a: AppendixInput): string {
  const { values } = resolveTexts(input, a);
  const rows = <T,>(items: T[], f: (t: T, i: number) => string[], cols: number): string =>
    (items.length ? items.map((t, i) => f(t, i)) : [['1', 'нет', ...Array(cols - 2).fill('-')]])
      .map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('');
  const th = (a: string[]): string => `<tr>${a.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>`;
  return `
<section class="appx">
<p class="a-center"><b>ПЕРЕЧЕНЬ ОБЪЕКТОВ</b></p>
<p class="a-center"><b>Приложение № ${a.no} к Лицензионному договору № ${esc(values.number!)} от ${esc(values.date!)} года</b><br>(далее – «Договор»)</p>
<table class="plain"><tr><td><b>г. Санкт-Петербург</b></td><td class="r"><b>${esc(longDate(a.date))}</b></td></tr></table>
<p class="a-both"><b>${esc(LICENSEE_INTRO.bold)}</b> ${esc(LICENSEE_INTRO.rest)}</p>
<p class="a-both"><b>${esc(values.licensor_intro!)}</b> в дальнейшем именуемый «Лицензиар», с другой стороны,</p>
<p>в дальнейшем совместно именуемые «Стороны»,</p>
<p>в соответствии с Договором подписали настоящее Приложение.</p>
<p class="h">1. Лицензиар предоставил Лицензиату на условиях Договора право использования следующих Произведений, Исполнений, Фонограмм:</p>
<table class="g"><thead>
<tr><th rowspan="2">№</th><th rowspan="2">Наименование Произведения</th><th rowspan="2">Исполнитель</th><th rowspan="2">Авторы текста</th><th rowspan="2">Авторы музыки</th><th rowspan="2">Изготовитель Фонограммы</th><th rowspan="2">Год</th><th colspan="2">Доля Лицензиара (%)</th><th rowspan="2">Срок</th><th rowspan="2">Наличие нецензурной лексики</th><th rowspan="2">Ставка вознаграждения</th></tr>
<tr><th>Авторские права</th><th>Смежные права</th></tr></thead><tbody>
${rows(a.tracks, (t, i) => [String(i + 1), t.title, t.performers, t.lyricists, t.composers, t.makers, t.year, t.shareAuthors, t.shareRelated, t.term, t.explicit, t.rate], 12)}
</tbody></table>
<p class="h">2. Лицензиар предоставил Лицензиату на условиях Договора право использования следующих Видеоматериалов:</p>
<table class="g"><thead>${th(['№', 'Наименование Видеоматериала', 'Авторы Произведения', 'Исполнитель', 'Авторы /Изготовители Видеоматериала', 'Доля Лицензиара', 'Год', 'Продолжительность', 'Срок', 'Наличие нецензурной лексики', 'Ставка вознаграждения'])}</thead><tbody>
${rows(a.videos, (v, i) => [String(i + 1), v.title, v.workAuthors, v.performer, v.makers, v.share, v.year, v.duration, v.term, v.explicit, v.rate], 11)}
</tbody></table>
<p class="h">3. Лицензиар предоставил Лицензиату на условиях Договора право использования следующих Изобразительных объектов:</p>
<table class="g"><thead>${th(['№', 'Наименование Произведения', 'Описание Изобразительного Объекта', 'Авторы Изобразительного Объекта', 'Исполнитель, к творчеству которого имеет отношение Изобразительный Объект', 'Доля Лицензиара', 'Год', 'Срок'])}</thead><tbody>
${rows(a.images, (v, i) => [String(i + 1), v.workTitle, v.description, v.authors, v.performer, v.share, v.year, v.term], 8)}
</tbody></table>
<p>4. Лицензиар передал, а Лицензиат принял экземпляры Объектов, а также отдельно их тексты в виде цифровых файлов по сети Интернет.</p>
<p>5. Возрастная категория для указанных выше Объектов – без ограничений. При этом Лицензиат вправе по своему усмотрению, руководствуясь действующим законодательством, изменять указанную возрастную категорию.</p>
<p>6. Настоящее Приложение вступает в силу с момента его подписания Сторонами.</p>
<table class="plain sig"><tr><td><b>ЛИЦЕНЗИАР</b><br>${esc(values.licensor_sign!)}<br><br>________________________</td><td><b>ЛИЦЕНЗИАТ</b><br>ИП ФЕДОТОВ ИВАН ВАСИЛЬЕВИЧ<br><br>________________________</td></tr></table>
</section>`;
}

export interface PdfParts { contract: boolean; appendix?: AppendixInput | null }

export function contractHtml(input: ContractInput, parts: PdfParts): string {
  const body = parts.contract ? renderBlocks(input).blocks.map(blockHtml).join('\n') : '';
  const app = parts.appendix ? appendixHtml(input, parts.appendix) : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
@page main { size: A4 portrait; margin: 22mm 15mm 18mm 20mm; }
@page appx { size: A4 landscape; margin: 22mm 14mm 16mm 15mm; }
body { font-family: Cambria, "Times New Roman", serif; font-size: 10pt; line-height: 1.25; margin: 0; }
main.c { page: main; }
section.appx { page: appx; ${parts.contract ? 'break-before: page;' : ''} }
p { margin: 0 0 4pt; } p.e { margin: 0; height: 6pt; }
p.h { font-weight: bold; margin-top: 6pt; }
.a-both { text-align: justify; } .a-center { text-align: center; } .a-right { text-align: right; }
table.t { width: 100%; border-collapse: collapse; margin: 4pt 0; } table.t td { vertical-align: top; padding: 2pt 6pt 2pt 0; }
table.g { width: 100%; border-collapse: collapse; margin: 4pt 0 8pt; font-size: 8pt; text-align: center; }
table.g th, table.g td { border: 0.6pt solid #000; padding: 3pt 3pt; } table.g th { font-weight: normal; }
table.plain { width: 100%; margin: 4pt 0; } table.plain td { vertical-align: top; } td.r { text-align: right; }
table.sig td { width: 50%; padding-top: 14pt; }
</style></head><body>${parts.contract ? `<main class="c">${body}</main>` : ''}${app}</body></html>`;
}
