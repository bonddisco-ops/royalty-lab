// Договор как список блоков для предпросмотра в программе и для PDF: текст шаблона с уже подставленными значениями.
// Поля, которые можно менять, отдаются отдельными сегментами — интерфейс рисует в них поля ввода.
import { splitBody, resolveTexts, renderField, type AppendixInput, type ContractInput } from './engine.ts';
import { FIELD_BY_KEY, normalizeFields, type FieldKind } from './fields.ts';
import { pctWords } from './engine.ts';
import { CONTRACT_TEMPLATE_B64 } from './templateData.ts';
import { unzipAll } from '../export/zipReader.ts';

export type Seg =
  | { k: 't'; v: string; b?: boolean }
  | { k: 'f'; key: string; kind: FieldKind; value: number; text: string; b?: boolean }
  | { k: 's'; key: string; v: string; b?: boolean };

export interface PBlock { kind: 'p'; segs: Seg[]; align: 'left' | 'center' | 'right' | 'both'; optional?: 'cover' | 'release'; included: boolean; heading: boolean }
export interface TBlock { kind: 'table'; rows: PBlock[][][] }
export type Block = PBlock | TBlock;

const unesc = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const TOKEN = /\{\{(\??[a-z0-9_]+)(?:\|([A-Za-z]+))?\}\}/g;

let docCache: string | null = null;
const docXml = (): string => (docCache ??= unzipAll(Buffer.from(CONTRACT_TEMPLATE_B64, 'base64')).get('word/document.xml')!.toString('utf8'));

function parseParagraph(p: string, input: ContractInput, nums: Record<string, number>, texts: Record<string, string>): PBlock {
  const align = (/<w:jc w:val="(left|center|right|both)"/.exec(p)?.[1] ?? 'left') as PBlock['align'];
  const segs: Seg[] = [];
  let optional: PBlock['optional'];
  const push = (s: Seg): void => {
    const last = segs[segs.length - 1];
    if (s.k === 't' && last && last.k === 't' && !!last.b === !!s.b) last.v += s.v;
    else segs.push(s);
  };
  for (const r of p.matchAll(/<w:r(?: [^>]*)?>(.*?)<\/w:r>/gs)) {
    const run = r[1]!;
    const rpr = /<w:rPr>(.*?)<\/w:rPr>/s.exec(run)?.[1] ?? '';
    const b = /<w:b\/>|<w:b w:val="(?!0|false)/.test(rpr) || undefined;
    let text = '';
    for (const m of run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      text += m[0] === '<w:tab/>' ? ' ' : m[0] === '<w:br/>' ? '\n' : unesc(m[1] ?? '');
    }
    let pos = 0;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index! > pos) push({ k: 't', v: text.slice(pos, m.index!), b });
      pos = m.index! + m[0].length;
      const key = m[1]!, fmt = m[2];
      if (key.startsWith('?')) { optional = key.slice(1) as 'cover' | 'release'; continue; }
      if (key === 'p413') {
        const pct = nums.rate_loss ?? 50;
        if (input.options.p413 === 'rate') {
          const full = texts.p413!;
          const i = full.indexOf(pctWords(pct));
          push({ k: 't', v: full.slice(0, i), b });
          push({ k: 'f', key: 'rate_loss', kind: 'percent', value: pct, text: pctWords(pct), b });
          push({ k: 't', v: full.slice(i + pctWords(pct).length), b });
        } else push({ k: 't', v: texts.p413!, b });
        continue;
      }
      if (key in texts) { push({ k: 's', key, v: texts[key]!, b }); continue; }
      const def = FIELD_BY_KEY.get(key);
      if (def) push({ k: 'f', key, kind: def.kind, value: nums[key]!, text: renderField(key, fmt, nums[key]!), b });
      else push({ k: 't', v: '', b });
    }
    if (pos < text.length) push({ k: 't', v: text.slice(pos), b });
  }
  const plain = segs.map((s) => (s.k === 't' ? s.v : s.k === 'f' ? s.text : s.v)).join('');
  const heading = /^\d+\.\s*[А-ЯЁ ]{4,}$/.test(plain.trim()) || /^(ЛИЦЕНЗИОННЫЙ ДОГОВОР|ПЕРЕЧЕНЬ ОБЪЕКТОВ)/.test(plain.trim());
  const included = optional === 'cover' ? input.options.cover : optional === 'release' ? input.options.release : true;
  return { kind: 'p', segs, align, optional, included, heading };
}

/** Тело договора (без приложения) со всеми значениями. Необязательные пункты отдаются с included=false, чтобы их можно было включить галочкой. */
export function renderBlocks(input: ContractInput): { blocks: Block[]; missing: string[]; errors: string[] } {
  const { values: nums, errors } = normalizeFields(input.fields);
  const { values: texts, missing } = resolveTexts(input);
  const { elems } = splitBody(docXml());
  const cut = elems.findIndex((e, k) => k < elems.length - 1 && e.startsWith('<w:p') && e.includes('<w:sectPr')) + 1;
  const blocks: Block[] = [];
  for (const e of elems.slice(0, cut)) {
    if (e.startsWith('<w:tbl>')) {
      const rows = [...e.matchAll(/<w:tr[ >].*?<\/w:tr>/gs)].map((tr) =>
        [...tr[0].matchAll(/<w:tc>.*?<\/w:tc>/gs)].map((tc) => [...tc[0].matchAll(/<w:p[ >].*?<\/w:p>/gs)].map((pp) => parseParagraph(pp[0], input, nums, texts))),
      );
      blocks.push({ kind: 'table', rows });
    } else if (e.startsWith('<w:p')) {
      const pb = parseParagraph(e, input, nums, texts);
      if (pb.segs.length || true) blocks.push(pb);
    }
  }
  return { blocks, missing, errors };
}

export type { AppendixInput };
