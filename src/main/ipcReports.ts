// IPC импорта отчётов: выбор файлов пачкой, предпросмотр, мастер незнакомого формата, запись, действия «Проверить».
import { dialog, shell, type BrowserWindow } from 'electron';
import { resolve, sep } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ApplyResult, ChannelMap, GenerateResult, ImportItem, WizardInfo } from '../shared/api.ts';
import { backupDb } from './db/backup.ts';
import { insertRow, updateRow } from './db/mutate.ts';
import { uuidv7 } from './domain/ids.ts';
import { accruedByPayee, computeAccruals } from './payouts/calc.ts';
import { commitOpening, deleteOpening, listOpening, matchOpeningName, parseOpeningXlsx, updateOpening } from './payouts/opening.ts';
import { addPayment, addReceipt, deletePayment, deleteReceipt, setParams, taxCsv, taxView } from './tax/store.ts';
import { generateStatement } from './payouts/generate.ts';
import { htmlToPdf } from './payouts/pdfRender.ts';
import { deleteLatestStatement, markPaid, payoutQuarters, payoutsView } from './payouts/store.ts';
import { applyBulk, listBatches, planBulk, revertBatch } from './reports/bulk.ts';
import { editLine, revertLine, splitLine } from './reports/edits.ts';
import { lineFacets, lineHistory, queryLines } from './reports/lines.ts';
import { aliasUnknownArtist, createArtistFromUnknown, createMissingTracks, createTrackFromUnmatched, linkUnmatchedToTrack } from './reports/resolve.ts';
import { CUSTOM_FIELDS, FIELD_TITLES, fingerprintOf, matchSavedFormat, parseCustom, proposeMapping, type CustomMapping, type Fingerprint } from './reports/custom.ts';
import { detectBuiltin } from './reports/detect.ts';
import { commitImport, previewImport, sha256Hex } from './reports/importer.ts';
import { parseBuiltin } from './reports/parse.ts';
import { listVersions } from './reports/replace.ts';
import { deleteReport, listReports, quarterPanel, setReportFlow } from './reports/queries.ts';
import type { Flow, ParsedReport, WorkbookData } from './reports/types.ts';
import { readXlsxBuffer } from './reports/xlsx.ts';
import * as repo from './repo.ts';
import { requireSession } from './session.ts';

type Handler<K extends keyof ChannelMap> = (req: ChannelMap[K][0]) => Promise<ChannelMap[K][1]> | ChannelMap[K][1];
export type HandleFn = <K extends keyof ChannelMap>(channel: K, fn: Handler<K>) => void;

interface Pending {
  id: string;
  fileName: string;
  filePath: string;
  sha: string;
  /** Книга держится в памяти только для незнакомого формата (нужна мастеру). */
  wb: WorkbookData | null;
  parsed: ParsedReport | null;
  flow: Flow;
  quarter: string;
  error?: string;
}

const pending = new Map<string, Pending>();

function savedFormats(): Array<{ id: string; name: string; fingerprint: Fingerprint; mapping: CustomMapping }> {
  const { db } = requireSession();
  return db.prepare('SELECT * FROM import_format WHERE deleted_at IS NULL').all().map((r) => ({
    id: r.id, name: r.name ?? '', fingerprint: JSON.parse(r.fingerprint_json) as Fingerprint, mapping: JSON.parse(r.mapping_json) as CustomMapping,
  }));
}

function view(p: Pending): ImportItem {
  const { db } = requireSession();
  if (p.error) return { id: p.id, fileName: p.fileName, state: 'error', error: p.error };
  if (!p.parsed) return { id: p.id, fileName: p.fileName, state: 'unknown' };
  return {
    id: p.id,
    fileName: p.fileName,
    state: 'ready',
    preview: previewImport(db, { parsed: p.parsed, fileName: p.fileName, fileSha: p.sha, flow: p.flow, quarter: p.quarter }),
  };
}

function load(path: string): Pending {
  const id = uuidv7();
  const fileName = basename(path);
  const bytes = readFileSync(path);
  const base = { id, fileName, filePath: path, sha: sha256Hex(bytes) };
  try {
    const wb = readXlsxBuffer(bytes, fileName);
    const builtin = detectBuiltin(wb);
    let parsed: ParsedReport | null = null;
    if (builtin) parsed = parseBuiltin(wb, builtin);
    else {
      const saved = matchSavedFormat(wb, savedFormats());
      if (saved) {
        const f = savedFormats().find((x) => x.id === saved.id)!;
        parsed = { ...parseCustom(wb, saved.mapping), formatCode: `custom:${saved.id}`, distributorName: f.name || saved.mapping.distributorName };
      }
    }
    if (!parsed) return { ...base, wb, parsed: null, flow: 'artists', quarter: '' };
    return { ...base, wb: null, parsed, flow: parsed.defaultFlow, quarter: parsed.quarter ?? '' };
  } catch (e) {
    return { ...base, wb: null, parsed: null, flow: 'artists', quarter: '', error: (e as Error).message };
  }
}

export function registerReportsIpc(handle: HandleFn, getWindow: () => BrowserWindow | null): void {
  handle('reports:pick', async (): Promise<ImportItem[]> => {
    requireSession();
    const win = getWindow();
    const opts = { title: 'Отчёты дистрибьюторов', properties: ['openFile' as const, 'multiSelections' as const], filters: [{ name: 'Excel', extensions: ['xlsx'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled) return [];
    const items: ImportItem[] = [];
    for (const f of res.filePaths) {
      const p = load(f);
      pending.set(p.id, p);
      items.push(view(p));
    }
    return items;
  });

  handle('reports:setOptions', ({ id, flow, quarter }) => {
    const p = pending.get(id);
    if (!p) throw new Error('Файл уже обработан или убран из списка');
    if (flow) p.flow = flow;
    if (quarter !== undefined) {
      if (quarter !== '' && !/^\d{4}Q[1-4]$/.test(quarter)) throw new Error('Квартал нужен в виде 2026Q3');
      p.quarter = quarter;
    }
    return view(p);
  });

  handle('reports:discard', ({ id }) => {
    pending.delete(id);
  });

  handle('reports:apply', ({ ids }): ApplyResult[] => {
    const s = requireSession();
    const out: ApplyResult[] = [];
    const todo = ids.map((id) => pending.get(id)).filter((p): p is Pending => !!p && !!p.parsed);
    if (todo.length > 0) backupDb(s.db, s.open.file, s.paths.backups, 'before-import');
    for (const p of todo) {
      try {
        if (!p.quarter) throw new Error('Укажите квартал');
        const r = commitImport(s.db, s.ctx, { parsed: p.parsed!, fileName: p.fileName, fileSha: p.sha, flow: p.flow, quarter: p.quarter }, { file: { sourcePath: p.filePath, reportsDir: s.paths.reports } });
        const code = p.parsed!.formatCode;
        if (code.startsWith('custom:')) {
          const fid = code.slice(7);
          const d = s.db.prepare('SELECT id FROM distributor WHERE format_code = ?').get(code);
          if (d) updateRow(s.db, s.ctx, 'import_format', fid, { distributor_id: d.id });
        }
        if (p.flow === 'artists') { try { createMissingTracks(s.db, s.ctx, s.db.prepare("SELECT id FROM issue WHERE kind = 'unmatched_track' AND status = 'open' AND report_version_id = ? AND deleted_at IS NULL").all(r.versionId).map((x) => String(x.id))); } catch (e) { console.error('Автосоздание треков:', e); } }
        pending.delete(p.id);
        out.push({ id: p.id, fileName: p.fileName, ok: true, lines: r.lines, rowsKop: r.rowsKop, issues: r.issues, versionNo: r.versionNo, carried: r.carried, lost: r.lost });
      } catch (e) {
        out.push({ id: p.id, fileName: p.fileName, ok: false, error: (e as Error).message });
      }
    }
    return out;
  });

  handle('reports:list', ({ quarter }) => { const s = requireSession(); repo.revalidateIssues(s.db, s.ctx); return listReports(s.db, quarter); });
  handle('reports:panel', ({ quarter }) => { const s = requireSession(); repo.revalidateIssues(s.db, s.ctx); return quarterPanel(s.db, quarter); });
  handle('reports:setFlow', ({ reportId, flow }) => {
    const s = requireSession();
    setReportFlow(s.db, s.ctx, reportId, flow);
  });

  handle('reports:versions', ({ reportId }) => listVersions(requireSession().db, reportId));
  handle('reports:delete', ({ reportId }) => {
    const s = requireSession();
    backupDb(s.db, s.open.file, s.paths.backups, 'before-report-delete');
    return deleteReport(s.db, s.ctx, reportId);
  });

  // ------------------------------------------------ таблица строк и правки (этап 3)
  handle('lines:query', ({ filter, sort, offset, limit }) => {
    const db = requireSession().db;
    const page = queryLines(db, filter, sort, offset ?? 0, Math.min(limit ?? 200, 500));
    if (filter.person && filter.person !== '__none' && filter.quarter) {
      page.personAccruedKop = accruedByPayee(computeAccruals(db, filter.quarter).rows, 'down').get(filter.person) ?? 0;
      page.personOrigAccruedKop = accruedByPayee(computeAccruals(db, filter.quarter, true).rows, 'down').get(filter.person) ?? 0;
    }
    return page;
  });
  handle('lines:history', ({ lineId }) => lineHistory(requireSession().db, lineId));
  handle('lines:facets', ({ quarter }) => lineFacets(requireSession().db, quarter));
  handle('lines:edit', ({ lineId, field, value, splitId }) => {
    const s = requireSession();
    editLine(s.db, s.ctx, lineId, field, value, splitId ?? null);
  });
  handle('lines:split', ({ lineId, qtyMoved, toKind, rate }) => {
    const s = requireSession();
    splitLine(s.db, s.ctx, lineId, qtyMoved, toKind, rate);
  });
  handle('lines:revert', ({ lineId }) => {
    const s = requireSession();
    return revertLine(s.db, s.ctx, lineId);
  });
  handle('bulk:plan', ({ filter, action }) => {
    const { items: _items, ...rest } = planBulk(requireSession().db, filter, action);
    return rest;
  });
  handle('bulk:apply', ({ filter, action }) => {
    const s = requireSession();
    backupDb(s.db, s.open.file, s.paths.backups, 'before-bulk-edit');
    return applyBulk(s.db, s.ctx, filter, action);
  });
  handle('bulk:list', () => listBatches(requireSession().db));
  handle('bulk:revert', ({ batchId }) => {
    const s = requireSession();
    return revertBatch(s.db, s.ctx, batchId);
  });

  // ------------------------------------------------ выплаты (этап 4)
  handle('payouts:view', ({ quarter }) => { const s = requireSession(); return payoutsView(s.db, quarter, s.paths.output); });
  handle('payouts:mark', ({ quarter, groupKey, status, paidKop, paidDate }) => {
    const s = requireSession();
    markPaid(s.db, s.ctx, quarter, groupKey, status, paidKop ?? null, paidDate ?? null);
  });

  handle('payouts:generate', async ({ quarter, groupKeys, city, date, round }): Promise<GenerateResult[]> => {
    const s = requireSession();
    const out: GenerateResult[] = [];
    const calcNames = new Map(payoutsView(s.db, quarter).rows.map((r) => [r.key, r.payeeName]));
    for (const key of groupKeys) {
      try {
        const g = await generateStatement(s.db, s.ctx, s.paths.output, quarter, key, { city: city ?? 'Санкт-Петербург', date: date ?? new Date().toISOString().slice(0, 10), round: round ?? 'down' }, htmlToPdf);
        out.push({ groupKey: key, payee: g.payee, ok: true, versionNo: g.versionNo, folder: g.folder, xlsx: g.xlsx, pdf: g.pdf });
      } catch (e) {
        out.push({ groupKey: key, payee: calcNames.get(key) ?? key, ok: false, error: (e as Error).message });
      }
    }
    return out;
  });
  handle('payouts:deleteStatement', ({ quarter, groupKey }) => {
    const s = requireSession();
    backupDb(s.db, s.open.file, s.paths.backups, 'before-delete-statement');
    return deleteLatestStatement(s.db, s.ctx, s.paths.output, quarter, groupKey);
  });
  // ------------------------------------------------ налоги ИП (УСН 6%)
  handle('tax:view', ({ year }) => taxView(requireSession().db, year));
  handle('tax:addReceipt', (r) => { const s = requireSession(); return addReceipt(s.db, s.ctx, r); });
  handle('tax:delReceipt', ({ id }) => { const s = requireSession(); deleteReceipt(s.db, s.ctx, id); });
  handle('tax:addPayment', (p) => { const s = requireSession(); return addPayment(s.db, s.ctx, p); });
  handle('tax:delPayment', ({ id }) => { const s = requireSession(); deletePayment(s.db, s.ctx, id); });
  handle('tax:setParams', ({ year, params }) => { const s = requireSession(); setParams(s.db, s.ctx, year, params); });
  handle('tax:export', ({ year }) => {
    const s = requireSession();
    const dir = resolve(s.paths.output, 'Налоги');
    mkdirSync(dir, { recursive: true });
    const name = `Налоги_${year}.csv`;
    writeFileSync(resolve(dir, name), taxCsv(taxView(s.db, year)), 'utf8');
    return `Налоги/${name}`;
  });
  handle('opening:pick', async () => {
    const s = requireSession();
    const win = getWindow();
    const opts = { title: 'Входящие остатки (Excel)', properties: ['openFile' as const], filters: [{ name: 'Excel', extensions: ['xlsx'] }] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    const f = res.filePaths[0];
    const parsed = parseOpeningXlsx(readXlsxBuffer(readFileSync(f), basename(f)));
    const existing = Number(s.db.prepare("SELECT count(*) AS n FROM opening_balance WHERE deleted_at IS NULL AND note = 'import'").get()?.n ?? 0);
    return { fileName: basename(f), sheet: parsed.sheet, quarterGuess: parsed.quarterGuess, quarters: payoutQuarters(s.db), totalKop: parsed.totalKop, existing, rows: parsed.rows.map((r) => ({ ...r, match: matchOpeningName(s.db, r.name) })) };
  });
  handle('opening:commit', ({ quarter, items }) => {
    const s = requireSession();
    backupDb(s.db, s.open.file, s.paths.backups, 'before-opening-balances');
    return commitOpening(s.db, s.ctx, quarter, items);
  });
  handle('opening:list', () => listOpening(requireSession().db));
  handle('opening:update', ({ id, artistId, kop }) => { const s = requireSession(); updateOpening(s.db, s.ctx, id, { artistId, kop }); });
  handle('opening:delete', ({ id }) => { const s = requireSession(); deleteOpening(s.db, s.ctx, id); });
  handle('payouts:open', async ({ path }) => {
    const s = requireSession();
    const root = resolve(s.paths.output);
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Файл вне папки данных');
    const err = await shell.openPath(abs);
    if (err) throw new Error(`Не удалось открыть файл: ${err}`);
  });

  handle('payouts:reveal', ({ path }) => {
    const s = requireSession();
    const root = resolve(s.paths.output);
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error('Файл вне папки данных');
    shell.showItemInFolder(abs);
  });

  // ------------------------------------------------ мастер незнакомого формата
  handle('wizard:info', ({ id, sheet, headerRow }): WizardInfo => {
    const p = pending.get(id);
    if (!p?.wb) throw new Error('Для этого файла мастер не нужен');
    const prop = proposeMapping(p.wb);
    const sheets = p.wb.sheets.map((s) => s.name);
    const sh = sheet ?? prop?.mapping.sheet ?? sheets[0]!;
    const hr = headerRow ?? (sheet && sheet !== prop?.mapping.sheet ? 0 : prop?.mapping.headerRow ?? 0);
    const rows = p.wb.sheets.find((s) => s.name === sh)?.rows ?? [];
    const headers = (rows[hr] ?? []).map((c) => (c === null ? '' : String(c)));
    const base: CustomMapping = prop?.mapping ?? { sheet: sh, headerRow: hr, columns: {}, distributorName: '', rightsType: 'mixed', flow: 'artists', licensorShare: 1 };
    const keep = sh === base.sheet && hr === base.headerRow;
    return {
      sheets, sheet: sh, headerRow: hr, headers, sample: rows.slice(hr + 1, hr + 6),
      mapping: { ...base, sheet: sh, headerRow: hr, columns: keep ? base.columns : {} }, fieldTitles: FIELD_TITLES,
    };
  });

  handle('wizard:apply', ({ id, mapping }): ImportItem => {
    const s = requireSession();
    const p = pending.get(id);
    if (!p?.wb) throw new Error('Для этого файла мастер не нужен');
    if (!mapping.distributorName.trim()) throw new Error('Назовите дистрибьютора');
    for (const k of Object.keys(mapping.columns)) if (!(CUSTOM_FIELDS as readonly string[]).includes(k)) throw new Error('Неизвестное поле сопоставления');
    const parsed = parseCustom(p.wb, mapping);
    const fp = fingerprintOf(p.wb, mapping.sheet, mapping.headerRow);
    const fid = insertRow(s.db, s.ctx, 'import_format', { name: mapping.distributorName.trim(), fingerprint_json: fp, mapping_json: mapping });
    p.parsed = { ...parsed, formatCode: `custom:${fid}`, distributorName: mapping.distributorName.trim() };
    p.flow = mapping.flow;
    p.quarter = parsed.quarter ?? '';
    p.wb = null;
    return view(p);
  });

  // ------------------------------------------------------ «Проверить»: действия
  handle('tracks:search', ({ q }) => repo.searchTracks(requireSession().db, q));
  handle('issues:linkTrack', ({ issueId, trackId }) => {
    const s = requireSession();
    return linkUnmatchedToTrack(s.db, s.ctx, issueId, trackId);
  });
  handle('issues:createTrack', ({ issueId }) => {
    const s = requireSession();
    return { trackId: createTrackFromUnmatched(s.db, s.ctx, issueId).trackId };
  });
  handle('issues:createMissing', ({ issueIds }) => {
    const s = requireSession();
    backupDb(s.db, s.open.file, s.paths.backups, 'before-create-tracks');
    return createMissingTracks(s.db, s.ctx, issueIds);
  });
  handle('issues:createArtist', ({ issueId, name }) => {
    const s = requireSession();
    return createArtistFromUnknown(s.db, s.ctx, issueId, name);
  });
  handle('issues:aliasArtist', ({ issueId, artistId }) => {
    const s = requireSession();
    aliasUnknownArtist(s.db, s.ctx, issueId, artistId);
  });
}
