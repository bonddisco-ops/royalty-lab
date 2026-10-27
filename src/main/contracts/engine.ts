// Сборка договора: подстановка полей в docx-шаблон, необязательные пункты, таблицы приложения, блоки для предпросмотра.
import { unzipAll } from '../export/zipReader.ts';
import { zipFiles } from '../export/zipWriter.ts';
import { FIELD_BY_KEY, normalizeFields, type ContractOptions } from './fields.ts';
import { CONTRACT_TEMPLATE_B64 } from './templateData.ts';
import { countWords, dmy, longDate, monthsWords, numToWords, plural, rubWords } from './words.ts';

export type LicensorKind = 'ip' | 'sz';

export interface Licensor {
  kind: LicensorKind;
  lastName: string; firstName: string; middleName: string;
  inn: string | null; ogrnip: string | null; okved: string | null;
  birthDate: string | null;
  passportSeries: string | null; passportNumber: string | null; passportIssuedBy: string | null; passportIssuedDate: string | null;
  address: string | null;
  bankName: string | null; bankAccount: string | null; bankCorrAccount: string | null; bankBik: string | null;
  email: string | null;
}

export interface ContractInput {
  number: string;
  /** Дата договора, 2026-07-31. */
  date: string;
  licensor: Licensor;
  fields: Record<string, number>;
  options: ContractOptions;
}

export interface TrackRow { title: string; performers: string; lyricists: string; composers: string; makers: string; year: string; shareAuthors: string; shareRelated: string; term: string; explicit: string; rate: string }
export interface VideoRow { title: string; workAuthors: string; performer: string; makers: string; share: string; year: string; duration: string; term: string; explicit: string; rate: string }
export interface ImageRow { workTitle: string; description: string; authors: string; performer: string; share: string; year: string; term: string }
export interface AppendixInput { no: number; date: string; tracks: TrackRow[]; videos: VideoRow[]; images: ImageRow[] }

const BLANK = '____________';

// ------------------------------------------------------------------ шаблон

let tplCache: Map<string, Buffer> | null = null;
function tpl(): Map<string, Buffer> {
  tplCache ??= unzipAll(Buffer.from(CONTRACT_TEMPLATE_B64, 'base64'));
  return tplCache;
}
const documentXml = (): string => tpl().get('word/document.xml')!.toString('utf8');

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Верхний уровень тела документа: абзацы, таблицы, sectPr. */
export function splitBody(xml: string): { head: string; elems: string[]; tail: string } {
  const bs = xml.indexOf('<w:body>') + '<w:body>'.length;
  const be = xml.lastIndexOf('</w:body>');
  const body = xml.slice(bs, be);
  const elems: string[] = [];
  const re = /<w:(p|tbl|sectPr)[ >]/g;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(body);
    if (!m) break;
    let end = body.length;
    if (m[1] === 'tbl') {
      let depth = 0;
      const tr = /<(\/?)w:tbl>/g;
      tr.lastIndex = m.index;
      for (let t = tr.exec(body); t; t = tr.exec(body)) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) { end = t.index + t[0].length; break; }
      }
    } else if (m[1] === 'p') end = body.indexOf('</w:p>', m.index) + 6;
    else end = body.indexOf('</w:sectPr>', m.index) + '</w:sectPr>'.length;
    elems.push(body.slice(m.index, end));
    pos = end;
  }
  return { head: xml.slice(0, bs), elems, tail: xml.slice(be) };
}

const textOf = (xml: string): string =>
  unesc(xml.replace(/<w:br\/>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')).replace(/ /g, ' ');

const hasSect = (e: string): boolean => e.startsWith('<w:p') && e.includes('<w:sectPr');

/** Индекс первого элемента приложения (после абзаца с концом раздела). */
function appendixStart(elems: string[]): number {
  const i = elems.findIndex((e, k) => k < elems.length - 1 && hasSect(e));
  if (i < 0) throw new Error('В шаблоне нет границы между договором и приложением');
  return i + 1;
}

// ------------------------------------------------------------------ значения

const fio = (l: Licensor): string => [l.lastName, l.firstName, l.middleName].map((x) => x.trim()).filter(Boolean).join(' ');

function isoToDmy(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return dmy(s.slice(0, 10));
  return s;
}

export interface Resolved { values: Record<string, string>; missing: string[] }

/** Текстовые (не числовые) поля подстановки. */
export function resolveTexts(input: ContractInput, appendix?: AppendixInput | null): Resolved {
  const l = input.licensor;
  const miss = new Set<string>();
  const need = (v: string | null | undefined, name: string): string => {
    const s = (v ?? '').trim();
    if (!s) { miss.add(name); return BLANK; }
    return s;
  };
  const name = need(fio(l), 'ФИО');
  const inn = need(l.inn, 'ИНН');
  const ip = l.kind === 'ip';
  const intro = ip
    ? `Индивидуальный предприниматель ${name} (ИНН: ${inn}, ОГРНИП: ${need(l.ogrnip, 'ОГРНИП')})`
    : `Плательщик Налога на профессиональный доход (самозанятое лицо) ${name} (ИНН: ${inn})`;
  const pass = `серия ${need(l.passportSeries, 'серия паспорта')} № ${need(l.passportNumber, 'номер паспорта')}, выдан ${need(isoToDmy(l.passportIssuedDate), 'дата выдачи паспорта')} г., ${need(l.passportIssuedBy, 'кем выдан паспорт')}`;
  const lines: string[] = [
    `Дата рождения: ${need(isoToDmy(l.birthDate), 'дата рождения')}`,
    'Паспорт гражданина РФ:',
    pass,
    'Адрес регистрации по месту жительства:',
    need(l.address, 'адрес'),
  ];
  if (ip) {
    lines.push(`ОГРНИП: ${need(l.ogrnip, 'ОГРНИП')}`, `ИНН: ${inn}`);
    if (l.okved) lines.push(`ОКВЭД: ${l.okved}`);
  } else lines.push(`ИНН: ${inn}`);
  lines.push(
    `Расчетный счет: № ${need(l.bankAccount, 'расчётный счёт')}`,
    `в ${need(l.bankName, 'банк')}`,
    `Корреспондентский счет банка: ${need(l.bankCorrAccount, 'корр. счёт')}`,
    `БИК: ${need(l.bankBik, 'БИК')}`,
    `Адрес электронной почты: ${need(l.email, 'e-mail')}`,
  );
  const pct = input.fields.rate_loss ?? 50;
  const p413 = input.options.p413 === 'rate'
    ? `С первого числа отчётного периода (календарного квартала года), в котором Лицензиату стало известно об утрате Лицензиаром статуса индивидуального предпринимателя, ставка вознаграждения Лицензиара (п. 4.1 Договора) как налогоплательщика - физического лица составит ${pctWords(pct)}.`
    : 'Утрата Лицензиаром статуса ИП не влияет на ставку вознаграждения и выплаты с учетом налогов.';
  const values: Record<string, string> = {
    number: need(input.number, 'номер договора'),
    date: dmy(input.date),
    licensor_intro: intro,
    licensor_email: need(l.email, 'e-mail'),
    status_gen: ip ? 'индивидуального предпринимателя' : 'самозанятого',
    and_not_sz: ip ? '' : ' и не имеющего статуса самозанятого',
    p413,
    licensor_req_head: `${ip ? 'ИП' : 'СЗ'} ${name}`,
    licensor_req_body: lines.join('\n'),
    licensor_sign: `${ip ? 'ИП' : 'СЗ'} ${name.toUpperCase()}`,
    app_no: String(appendix?.no ?? 1),
    app_date_long: longDate(appendix?.date ?? input.date),
  };
  return { values, missing: [...miss] };
}

export const pctWords = (n: number): string => `${n}% (${numToWords(n, 'nom')} ${plural(n, 'процент', 'процента', 'процентов')})`;

export function renderField(key: string, fmt: string | undefined, value: number): string {
  switch (fmt) {
    case 'gen': return countWords(value, 'gen');
    case 'nom': return countWords(value, 'nom');
    case 'nomCap': return countWords(value, 'nom', true);
    case 'rub': return rubWords(value);
    case 'rubCap': return rubWords(value, true);
    case 'genMonths': return monthsWords(value);
    default: throw new Error(`Неизвестный формат поля ${key}|${fmt ?? ''}`);
  }
}

const TOKEN = /\{\{(\??[a-z0-9_]+)(?:\|([A-Za-z]+))?\}\}/g;

// ------------------------------------------------------------------ подстановка

function substitute(xml: string, texts: Record<string, string>, nums: Record<string, number>): string {
  return xml.replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (whole, open: string, body: string, close: string) => {
    if (!body.includes('{{')) return whole;
    let multi = false;
    const out = body.replace(TOKEN, (_m, key: string, fmt: string | undefined) => {
      if (key.startsWith('?')) return '';
      if (key in texts) {
        const v = texts[key]!;
        if (v.includes('\n')) multi = true;
        return esc(v);
      }
      if (FIELD_BY_KEY.has(key) && key in nums) return esc(renderField(key, fmt, nums[key]!));
      throw new Error(`Поле шаблона «${key}» не заполнено`);
    });
    const withPre = open.includes('xml:space') ? open : open.replace('<w:t', '<w:t xml:space="preserve"');
    if (!multi) return withPre + out + close;
    return withPre + out.split('\n').join(`${close}<w:br/>${withPre}`) + close;
  });
}

function fillTable(table: string, rows: string[][], emptyRow: string[]): string {
  const trs = [...table.matchAll(/<w:tr[ >].*?<\/w:tr>/gs)];
  const pi = trs.findIndex((m) => m[0].includes('{{c0}}'));
  if (pi < 0) throw new Error('В таблице шаблона нет строки-образца');
  const proto = trs[pi]![0];
  const data = rows.length ? rows : [emptyRow];
  const built = data.map((cells, i) => proto.replace(/\{\{c(\d+)\}\}/g, (_m, k: string) => esc(k === '0' && rows.length ? String(i + 1) : cells[Number(k)] ?? '')));
  return table.slice(0, trs[pi]!.index) + built.join('') + table.slice(trs[pi]!.index! + proto.length);
}

export interface BuildParts { contract: boolean; appendix?: AppendixInput | null }

export function buildDocx(input: ContractInput, parts: BuildParts): Buffer {
  const { values: nums, errors } = normalizeFields(input.fields);
  if (errors.length) throw new Error(errors.join('; '));
  const { head, elems, tail } = splitBody(documentXml());
  const cut = appendixStart(elems);
  const finalSect = elems[elems.length - 1]!;
  const body = elems.slice(0, -1);
  const contractEls = body.slice(0, cut);
  let appendixEls = body.slice(cut);

  // необязательные пункты
  const keepOptional = (els: string[]): string[] =>
    els.filter((e) => {
      const m = /\{\{\?(cover|release)\}\}/.exec(e);
      if (!m) return true;
      return m[1] === 'cover' ? input.options.cover : input.options.release;
    });
  const contractKept = keepOptional(contractEls);

  const appendix = parts.appendix ?? null;
  if (appendix) {
    let ti = 0;
    appendixEls = appendixEls.map((e) => {
      if (!e.startsWith('<w:tbl>') || !e.includes('{{c0}}')) return e;
      const k = ti++;
      if (k === 0) return fillTable(e, appendix.tracks.map((t) => ['', t.title, t.performers, t.lyricists, t.composers, t.makers, t.year, t.shareAuthors, t.shareRelated, t.term, t.explicit, t.rate]), ['1', 'нет', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']);
      if (k === 1) return fillTable(e, appendix.videos.map((v) => ['', v.title, v.workAuthors, v.performer, v.makers, v.share, v.year, v.duration, v.term, v.explicit, v.rate]), ['1', 'нет', '-', '-', '-', '-', '-', '-', '-', '-', '-']);
      return fillTable(e, appendix.images.map((v) => ['', v.workTitle, v.description, v.authors, v.performer, v.share, v.year, v.term]), ['1', 'нет', '-', '-', '-', '-', '-', '-']);
    });
  }

  // Границы разделов: у договора книжная страница с колонтитулом, у приложения — альбомная.
  const sectPara = contractKept[contractKept.length - 1]!;
  const portrait = /<w:sectPr[ >].*?<\/w:sectPr>/s.exec(sectPara)![0];
  const refs = (portrait.match(/<w:(?:header|footer)Reference [^>]*\/>/g) ?? []).join('');
  const sectPlain = sectPara.replace(/<w:sectPr[ >].*?<\/w:sectPr>/s, '');
  let list: string[];
  let finalSectOut = finalSect;
  if (parts.contract && appendix) list = [...contractKept, ...appendixEls];
  else if (parts.contract) {
    list = [...contractKept.slice(0, -1), sectPlain];
    finalSectOut = portrait;
  } else if (appendix) {
    list = appendixEls;
    finalSectOut = finalSect.replace(/(<w:sectPr[^>]*>)/, `$1${refs}`);
  } else throw new Error('Нечего собирать: ни договора, ни приложения');

  const { values: texts } = resolveTexts(input, appendix);
  const xml = head + substitute(list.join('') + finalSectOut, texts, nums) + tail;

  const files = [...tpl().entries()].map(([name, data]) => ({ name, data: name === 'word/document.xml' ? Buffer.from(xml, 'utf8') : data }));
  // [Content_Types].xml первым — так принято в OPC
  files.sort((a, b) => (a.name === '[Content_Types].xml' ? -1 : b.name === '[Content_Types].xml' ? 1 : 0));
  return zipFiles(files);
}
