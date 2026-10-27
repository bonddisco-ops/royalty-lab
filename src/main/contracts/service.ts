// Договоры: список, создание, правка условий, приложения (черновик из участий), выгрузка в Word и PDF.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEC_ONE, formatDec, parseDec } from '../domain/dec.ts';
import { insertRow, updateRow, deleteRow } from '../db/mutate.ts';
import { closeNoContractIssue } from '../repo.ts';
import type { Ctx, Db, Row } from '../db/types.ts';
import { safeName } from '../payouts/generate.ts';
import { renderBlocks, type Block } from './blocks.ts';
import { buildDocx, type AppendixInput, type ContractInput, type ImageRow, type Licensor, type TrackRow, type VideoRow } from './engine.ts';
import { defaultTerms, normalizeFields, type ContractOptions, type Terms } from './fields.ts';
import { contractHtml } from './pdfHtml.ts';
import { dmy } from './words.ts';

export type PdfRenderer = (html: string) => Promise<Buffer>;

// ------------------------------------------------------------------ лицензиар

function addressOf(c: Row): string | null {
  if (c.addr_raw) return String(c.addr_raw);
  const parts = [c.addr_zip, c.addr_region, c.addr_city, c.addr_street, c.addr_house && `д. ${c.addr_house}`, c.addr_flat && `кв. ${c.addr_flat}`].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function licensorOf(db: Db, counterpartyId: string, okved: string | null): Licensor {
  const c = db.prepare('SELECT * FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(counterpartyId);
  if (!c) throw new Error('Человек не найден');
  if (c.status !== 'ip' && c.status !== 'sz') throw new Error('У человека не указан статус: ИП или самозанятый (в карточке «Люди»). С физлицами договоры не заключаем.');
  return {
    kind: c.status, lastName: c.last_name ?? '', firstName: c.first_name ?? '', middleName: c.middle_name ?? '',
    inn: c.inn ?? null, ogrnip: c.ogrnip ?? null, okved, birthDate: c.birth_date ?? null,
    passportSeries: c.passport_series ?? null, passportNumber: c.passport_number ?? null, passportIssuedBy: c.passport_issued_by ?? null, passportIssuedDate: c.passport_issued_date ?? null,
    address: addressOf(c), bankName: c.bank_name ?? null, bankAccount: c.bank_account ?? null, bankCorrAccount: c.bank_corr_account ?? null, bankBik: c.bank_bik ?? null, email: c.email ?? null,
  };
}

const personName = (c: Row): string => [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ') || '(без имени)';

// ------------------------------------------------------------------ договор

export interface ContractEdit {
  id: string | null;
  counterpartyId: string;
  number: string;
  /** 2026-07-31 */
  date: string;
  fields: Record<string, number>;
  options: ContractOptions;
  okved: string | null;
}

export interface AppendixListItem { id: string; number: number; date: string | null; status: string; items: number }
export interface ContractDetail extends ContractEdit {
  person: string;
  kind: 'ip' | 'sz' | null;
  appendices: AppendixListItem[];
}
export interface ContractListItem { id: string; counterpartyId: string; person: string; kind: string | null; number: string; date: string | null; thresholdRub: number | null; appendices: number; hasTerms: boolean }
export interface ContractPreview { blocks: Block[]; missing: string[]; errors: string[]; kind: 'ip' | 'sz' }

const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function listContracts(db: Db): ContractListItem[] {
  const rows = db.prepare(
    `SELECT k.*, c.last_name, c.first_name, c.middle_name, c.status AS cp_status,
            (SELECT count(*) FROM appendix a WHERE a.contract_id = k.id AND a.deleted_at IS NULL) AS app_count
       FROM contract k JOIN counterparty c ON c.id = k.counterparty_id
      WHERE k.deleted_at IS NULL ORDER BY k.date DESC, k.number`,
  ).all();
  return rows.map((r) => ({
    id: r.id, counterpartyId: r.counterparty_id, person: personName(r), kind: r.cp_status ?? null, number: r.number, date: r.date ?? null,
    thresholdRub: r.threshold_rub === null || r.threshold_rub === undefined ? null : Number(r.threshold_rub) / 100, appendices: Number(r.app_count), hasTerms: !!r.terms_json,
  }));
}

export interface MissingContractItem { id: string; person: string; status: string }
/** Люди без договора: показываются в «Договорах» красными строками. */
export function listPeopleWithoutContract(db: Db): MissingContractItem[] {
  return db.prepare(
    `SELECT c.* FROM counterparty c WHERE c.deleted_at IS NULL AND c.status != 'fl'
       AND NOT EXISTS (SELECT 1 FROM contract k WHERE k.counterparty_id = c.id AND k.deleted_at IS NULL) ORDER BY c.last_name, c.first_name`,
  ).all().map((r) => ({ id: r.id, person: personName(r), status: r.status }));
}

function readTerms(r: Row): Terms {
  const base = defaultTerms();
  let t: Partial<Terms> = {};
  try { t = r.terms_json ? (JSON.parse(r.terms_json) as Partial<Terms>) : {}; } catch { t = {}; }
  const fields = { ...base.fields, ...(t.fields ?? {}) };
  // порог живёт в колонке договора (его читает расчёт выплат)
  if (r.threshold_rub !== null && r.threshold_rub !== undefined) fields.threshold = Math.round(Number(r.threshold_rub) / 100);
  return { fields, options: { ...base.options, ...(t.options ?? {}) }, okved: t.okved ?? null };
}

export function newContract(db: Db, counterpartyId: string): ContractDetail {
  const c = db.prepare('SELECT * FROM counterparty WHERE id = ? AND deleted_at IS NULL').get(counterpartyId);
  if (!c) throw new Error('Человек не найден');
  const kind = c.status === 'ip' || c.status === 'sz' ? (c.status as 'ip' | 'sz') : null;
  const t = defaultTerms();
  return { id: null, counterpartyId, number: suggestNumber(db, c), date: todayIso(), fields: t.fields, options: t.options, okved: null, person: personName(c), kind, appendices: [] };
}

/** Подсказка номера: ПР-ИП/КОД/ГГ или ПР-СЗ/КОД/ГГ. Код — из латинских букв псевдонима артиста либо инициалов. */
export function suggestNumber(db: Db, c: Row): string {
  const art = db.prepare('SELECT name FROM artist WHERE counterparty_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 1').get(c.id);
  const src = String(art?.name ?? `${c.last_name ?? ''}${c.first_name ?? ''}`);
  const letters = src.replace(/[^A-Za-zА-Яа-яЁё]/g, '').toUpperCase();
  const code = (letters.length > 4 ? letters.slice(0, 3) : letters) || 'XX';
  const yy = String(new Date().getFullYear()).slice(2);
  return `ПР-${c.status === 'ip' ? 'ИП' : 'СЗ'}/${code}/${yy}`;
}

export function getContract(db: Db, id: string): ContractDetail {
  const r = db.prepare('SELECT * FROM contract WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!r) throw new Error('Договор не найден');
  const c = db.prepare('SELECT * FROM counterparty WHERE id = ?').get(r.counterparty_id)!;
  const t = readTerms(r);
  const apps = db.prepare(
    `SELECT a.*, (SELECT count(*) FROM appendix_item i WHERE i.appendix_id = a.id AND i.deleted_at IS NULL) AS n
       FROM appendix a WHERE a.contract_id = ? AND a.deleted_at IS NULL ORDER BY a.number`,
  ).all(id);
  return {
    id, counterpartyId: r.counterparty_id, number: r.number, date: r.date ?? todayIso(), fields: t.fields, options: t.options, okved: t.okved,
    person: personName(c), kind: c.status === 'ip' || c.status === 'sz' ? c.status : null,
    appendices: apps.map((a) => ({ id: a.id, number: Number(a.number), date: a.date ?? null, status: a.status, items: Number(a.n) })),
  };
}

function toInput(db: Db, e: ContractEdit): ContractInput {
  return { number: e.number.trim(), date: e.date, licensor: licensorOf(db, e.counterpartyId, e.okved), fields: e.fields, options: e.options };
}

export function previewContract(db: Db, e: ContractEdit): ContractPreview {
  const input = toInput(db, e);
  const r = renderBlocks(input);
  return { ...r, kind: input.licensor.kind };
}

export function saveContract(db: Db, ctx: Ctx, e: ContractEdit): string {
  if (!e.number.trim()) throw new Error('Укажите номер договора');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error('Дата договора в виде 2026-07-31');
  licensorOf(db, e.counterpartyId, e.okved); // проверка статуса
  const { values, errors } = normalizeFields(e.fields);
  if (errors.length) throw new Error(errors.join('\n'));
  const dup = db.prepare('SELECT id FROM contract WHERE number = ? AND deleted_at IS NULL AND id <> ?').get(e.number.trim(), e.id ?? '');
  if (dup) throw new Error(`Договор с номером «${e.number.trim()}» уже есть`);
  const terms: Terms = { fields: values, options: e.options, okved: e.okved };
  const row: Row = {
    counterparty_id: e.counterpartyId, number: e.number.trim(), date: e.date, kind: 'license',
    threshold_rub: values.threshold! * 100, threshold_rule: 'carry_until_exceeded', status_clause_50: e.options.p413 === 'rate' ? 1 : 0, terms_json: terms,
  };
  return db.transaction(() => {
    if (e.id) { updateRow(db, ctx, 'contract', e.id, row); return e.id; }
    const nid = insertRow(db, ctx, 'contract', row);
    closeNoContractIssue(db, ctx, String(row.counterparty_id));
    return nid;
  })();
}

export function deleteContract(db: Db, ctx: Ctx, id: string): void {
  db.transaction(() => {
    for (const a of db.prepare('SELECT id FROM appendix WHERE contract_id = ? AND deleted_at IS NULL').all(id)) deleteAppendix(db, ctx, a.id);
    deleteRow(db, ctx, 'contract', id);
  })();
}

// ------------------------------------------------------------------ приложения

export interface DraftTrack { trackId: string | null; participationId: string | null; row: TrackRow }
export interface AppendixDraft { appendixId: string | null; no: number; date: string; tracks: DraftTrack[]; videos: VideoRow[]; images: ImageRow[] }

const pct = (dec: string | null | undefined): string => {
  const v = parseDec(dec);
  if (v === null) return '';
  return formatDec(v * 100n).replace('.', ',') + '%';
};
const plusYears = (iso: string, n: number): string => `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`;
const rangeOf = (from: string | null, to: string | null, appDate: string): string => `${dmy((from ?? appDate).slice(0, 10))} - ${dmy((to ?? plusYears(appDate, 10)).slice(0, 10))}`;

/** Строка таблицы по треку: что есть в базе — подставляем, авторов/изготовителя берём из прошлых приложений по этому треку. */
export function trackRow(db: Db, contractId: string, trackId: string, appDate: string): DraftTrack {
  const t = db.prepare('SELECT * FROM track WHERE id = ? AND deleted_at IS NULL').get(trackId);
  if (!t) throw new Error('Трек не найден');
  const k = db.prepare('SELECT counterparty_id FROM contract WHERE id = ?').get(contractId);
  const parts = db.prepare(
    `SELECT p.*, a.name AS artist_name, a.counterparty_id AS a_cp FROM participation p JOIN artist a ON a.id = p.artist_id
      WHERE p.track_id = ? AND p.deleted_at IS NULL ORDER BY a.name`,
  ).all(trackId);
  const mine = parts.find((p) => p.contract_id === contractId) ?? parts.find((p) => (p.payee_counterparty_id ?? p.a_cp) === k?.counterparty_id) ?? null;
  const prev = db.prepare(
    `SELECT payload_json FROM appendix_item WHERE track_id = ? AND kind = 'works' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  ).get(trackId);
  let old: Partial<TrackRow> = {};
  try { old = prev?.payload_json ? (JSON.parse(prev.payload_json) as Partial<TrackRow>) : {}; } catch { old = {}; }
  const year = t.release_date ? String(t.release_date).slice(0, 4) : '';
  const row: TrackRow = {
    title: t.title + (t.version ? ` (${t.version})` : ''),
    performers: parts.map((p) => p.artist_name).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    lyricists: old.lyricists ?? '', composers: old.composers ?? '', makers: old.makers ?? '',
    year: old.year ?? year,
    shareAuthors: mine ? pct(mine.share_authors) : '', shareRelated: mine ? pct(mine.share_related) : '',
    term: rangeOf(mine?.term_from ?? null, mine?.term_to ?? null, appDate),
    explicit: t.explicit ? 'да' : 'нет',
    rate: mine?.label_rate ? pct(mine.label_rate) : '',
  };
  return { trackId, participationId: mine?.id ?? null, row };
}

function parseJson<T>(s: unknown, fallback: T): T {
  try { return s ? (JSON.parse(String(s)) as T) : fallback; } catch { return fallback; }
}

/**
 * Строка приложения для таблицы. Приложения, загруженные из стартовой базы, хранят «сырые» поля (title_raw, performers_raw, term_raw…) —
 * их достраиваем по каталогу так же, как для нового приложения, а недостающие поля всегда заполняем пустыми строками.
 */
function normalizeTrackRow(db: Db, contractId: string, item: Row, appDate: string): TrackRow {
  const p = parseJson<Record<string, unknown>>(item.payload_json, {});
  if (typeof p.title === 'string' || typeof p.performers === 'string') return { ...emptyTrack(), ...(p as Partial<TrackRow>) };
  let base: TrackRow = emptyTrack();
  if (item.track_id) { try { base = { ...emptyTrack(), ...trackRow(db, contractId, String(item.track_id), appDate).row }; } catch { /* трека уже нет — оставляем сырые поля */ } }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return { ...base, title: base.title || str(p.title_raw), performers: base.performers || str(p.performers_raw), term: str(p.term_raw) || base.term };
}

export function draftAppendix(db: Db, contractId: string, appendixId: string | null): AppendixDraft {
  if (appendixId) {
    const a = db.prepare('SELECT * FROM appendix WHERE id = ? AND contract_id = ? AND deleted_at IS NULL').get(appendixId, contractId);
    if (!a) throw new Error('Приложение не найдено');
    const items = db.prepare('SELECT * FROM appendix_item WHERE appendix_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(appendixId);
    const appDate: string = a.date ?? todayIso();
    return {
      appendixId, no: Number(a.number), date: appDate,
      tracks: items.filter((i) => i.kind === 'works').map((i) => ({ trackId: i.track_id ?? null, participationId: i.participation_id ?? null, row: normalizeTrackRow(db, contractId, i, appDate) })),
      videos: items.filter((i) => i.kind === 'video').map((i) => ({ ...emptyVideo(), ...parseJson<Partial<VideoRow>>(i.payload_json, {}) })),
      images: items.filter((i) => i.kind === 'images').map((i) => ({ ...emptyImage(), ...parseJson<Partial<ImageRow>>(i.payload_json, {}) })),
    };
  }
  const no = Number(db.prepare('SELECT max(number) AS m FROM appendix WHERE contract_id = ? AND deleted_at IS NULL').get(contractId)?.m ?? 0) + 1;
  const date = todayIso();
  const trackIds = db.prepare(
    `SELECT DISTINCT p.track_id FROM participation p JOIN track t ON t.id = p.track_id
      WHERE p.contract_id = ? AND p.appendix_id IS NULL AND p.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY t.title`,
  ).all(contractId).map((r) => r.track_id as string);
  return { appendixId: null, no, date, tracks: trackIds.map((id) => trackRow(db, contractId, id, date)), videos: [], images: [] };
}

const emptyTrack = (): TrackRow => ({ title: '', performers: '', lyricists: '', composers: '', makers: '', year: '', shareAuthors: '', shareRelated: '', term: '', explicit: 'нет', rate: '' });
const emptyVideo = (): VideoRow => ({ title: '', workAuthors: '', performer: '', makers: '', share: '', year: '', duration: '', term: '', explicit: 'нет', rate: '' });
const emptyImage = (): ImageRow => ({ workTitle: '', description: 'Обложка трека', authors: '', performer: '', share: '100%', year: '', term: '' });
export { emptyTrack, emptyVideo, emptyImage };

export function saveAppendix(db: Db, ctx: Ctx, contractId: string, d: AppendixDraft): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error('Дата приложения в виде 2026-07-31');
  if (!Number.isInteger(d.no) || d.no < 1) throw new Error('Номер приложения — целое число от 1');
  const clash = db.prepare('SELECT id FROM appendix WHERE contract_id = ? AND number = ? AND deleted_at IS NULL AND id <> ?').get(contractId, d.no, d.appendixId ?? '');
  if (clash) throw new Error(`Приложение № ${d.no} уже есть в этом договоре`);
  return db.transaction(() => {
    let id = d.appendixId;
    if (id) {
      updateRow(db, ctx, 'appendix', id, { number: d.no, date: d.date });
      for (const i of db.prepare('SELECT id FROM appendix_item WHERE appendix_id = ? AND deleted_at IS NULL').all(id)) deleteRow(db, ctx, 'appendix_item', i.id);
    } else id = insertRow(db, ctx, 'appendix', { contract_id: contractId, number: d.no, date: d.date, status: 'draft' });
    for (const t of d.tracks) {
      insertRow(db, ctx, 'appendix_item', { appendix_id: id, track_id: t.trackId, participation_id: t.participationId, kind: 'works', payload_json: t.row });
      if (t.participationId) updateRow(db, ctx, 'participation', t.participationId, { appendix_id: id, contract_id: contractId });
    }
    for (const v of d.videos) insertRow(db, ctx, 'appendix_item', { appendix_id: id, kind: 'video', payload_json: v });
    for (const v of d.images) insertRow(db, ctx, 'appendix_item', { appendix_id: id, kind: 'images', payload_json: v });
    return id!;
  })();
}

export function deleteAppendix(db: Db, ctx: Ctx, id: string): void {
  db.transaction(() => {
    for (const p of db.prepare('SELECT id FROM participation WHERE appendix_id = ? AND deleted_at IS NULL').all(id)) updateRow(db, ctx, 'participation', p.id, { appendix_id: null });
    for (const i of db.prepare('SELECT id FROM appendix_item WHERE appendix_id = ? AND deleted_at IS NULL').all(id)) deleteRow(db, ctx, 'appendix_item', i.id);
    deleteRow(db, ctx, 'appendix', id);
  })();
}

// ------------------------------------------------------------------ выгрузка

export interface ExportRequest { contractId: string; format: 'docx' | 'pdf'; part: 'contract' | 'appendix' | 'both'; appendixId?: string | null }

function appendixInput(draft: AppendixDraft): AppendixInput {
  return { no: draft.no, date: draft.date, tracks: draft.tracks.map((t) => t.row), videos: draft.videos, images: draft.images };
}

/** Несохранённые условия можно передать как `edit` — тогда файл собирается ровно из того, что на экране. */
export async function exportContractFile(db: Db, outputDir: string, req: ExportRequest, edit: ContractEdit | null, draft: AppendixDraft | null, renderPdf: PdfRenderer): Promise<string> {
  const detail = getContract(db, req.contractId);
  const input = toInput(db, edit ?? detail);
  const needApp = req.part === 'appendix' || req.part === 'both';
  const appx = needApp ? appendixInput(draft ?? draftAppendix(db, req.contractId, req.appendixId ?? detail.appendices[0]?.id ?? null)) : null;
  const folder = join(outputDir, 'Договоры', safeName(detail.person));
  mkdirSync(folder, { recursive: true });
  const num = safeName(input.number.replace(/\//g, '-'));
  const stem = req.part === 'appendix' ? `Приложение ${appx!.no} к договору ${num}` : `Договор ${num} от ${dmy(input.date)}`;
  let name = `${stem}.${req.format}`, k = 2;
  while (existsSync(join(folder, name))) name = `${stem} (${k++}).${req.format}`;
  const parts = { contract: req.part !== 'appendix', appendix: appx };
  const data = req.format === 'docx' ? buildDocx(input, parts) : await renderPdf(contractHtml(input, parts));
  writeFileSync(join(folder, name), data);
  return `Договоры/${safeName(detail.person)}/${name}`;
}
