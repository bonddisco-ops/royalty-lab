// Входящие остатки из прежнего учёта (Excel «Артист → входящий остаток»).
// Остаток хранится на артисте (или сразу на человеке), а в выплатах уходит человеку, к которому артист привязан сейчас.
import { insertRow, updateRow, deleteRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import { normKey } from '../domain/normalize.ts';
import type { WorkbookData } from '../reports/types.ts';

export interface OpeningParsedRow { name: string; fileKop: number; q1Kop: number | null; accruedKop: number | null; paidKop: number | null; formulaKop: number | null; mismatch: boolean }
export interface OpeningParsed { quarterGuess: string | null; rows: OpeningParsedRow[]; totalKop: number; sheet: string }

const kop = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : null);
const txt = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));

export function parseOpeningXlsx(wb: WorkbookData): OpeningParsed {
  for (const sh of wb.sheets) {
    const rows = sh.rows;
    let h = -1;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const cells = (rows[i] ?? []).map(txt);
      if (cells.some((c) => /^артист$/i.test(c)) && cells.some((c) => /остаток/i.test(c))) { h = i; break; }
    }
    if (h < 0) continue;
    const head = (rows[h] ?? []).map(txt);
    const nameCol = head.findIndex((c) => /^артист$/i.test(c));
    const balCols = head.map((c, i) => (/остаток/i.test(c) ? i : -1)).filter((i) => i >= 0);
    const balCol = balCols[balCols.length - 1]!;
    const q1Col = balCols.length > 1 ? balCols[0]! : -1;
    const accCol = head.findIndex((c) => /^начислено/i.test(c));
    const paidCol = head.findIndex((c) => /^к выплате/i.test(c));
    let quarterGuess: string | null = null;
    for (let i = 0; i < h && !quarterGuess; i++) for (const c of rows[i] ?? []) { const m = /(\d{4})\s*Q\s*([1-4])/i.exec(txt(c)); if (m) { quarterGuess = `${m[1]}Q${m[2]}`; break; } }
    const out: OpeningParsedRow[] = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i] ?? [];
      const name = txt(r[nameCol]);
      if (!name) continue;
      if (/^итого/i.test(name)) break;
      const bal = kop(r[balCol]);
      if (bal === null) continue;
      const q1 = q1Col >= 0 ? kop(r[q1Col]) : null, acc = accCol >= 0 ? kop(r[accCol]) : null, paid = paidCol >= 0 ? kop(r[paidCol]) : null;
      const formula = q1 !== null && acc !== null && paid !== null ? q1 + acc - paid : null;
      out.push({ name, fileKop: bal, q1Kop: q1, accruedKop: acc, paidKop: paid, formulaKop: formula, mismatch: formula !== null && Math.abs(formula - bal) > 1 });
    }
    return { quarterGuess, rows: out, totalKop: out.reduce((a, r) => a + r.fileKop, 0), sheet: sh.name };
  }
  throw new Error('Не нашёл таблицу: нужны колонки «Артист» и «Входящий остаток»');
}

export interface OpeningMatch { artistId: string | null; artist: string | null; personId: string | null; person: string | null; note: string }

/** Сопоставление имени из Excel с артистом: по имени и «другим написаниям»; «A, B» / «A/B» — если все части ведут к одному человеку. */
export function matchOpeningName(db: Db, name: string): OpeningMatch {
  const variants = db.prepare('SELECT v.variant_norm AS n, a.id AS id, a.name AS name, a.counterparty_id AS cp FROM artist_name_variant v JOIN artist a ON a.id = v.artist_id WHERE v.deleted_at IS NULL AND a.deleted_at IS NULL').all();
  const byNorm = new Map<string, Array<{ id: string; name: string; cp: string | null }>>();
  for (const v of variants) { const l = byNorm.get(String(v.n)) ?? []; if (!l.some((x) => x.id === v.id)) l.push({ id: String(v.id), name: String(v.name), cp: v.cp ? String(v.cp) : null }); byNorm.set(String(v.n), l); }
  const personName = (id: string | null): string | null => {
    if (!id) return null;
    const c = db.prepare('SELECT last_name, first_name, middle_name FROM counterparty WHERE id = ?').get(id);
    return c ? [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ') : null;
  };
  const mk = (a: { id: string; name: string; cp: string | null }, note = ''): OpeningMatch => ({ artistId: a.id, artist: a.name, personId: a.cp, person: personName(a.cp), note });
  const whole = byNorm.get(normKey(name));
  if (whole?.length === 1) return mk(whole[0]!);
  if (whole && whole.length > 1) return { artistId: null, artist: null, personId: null, person: null, note: 'Имя подходит нескольким артистам' };
  const parts = name.split(/[,;/]|\s+и\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const found = parts.map((p) => byNorm.get(normKey(p))).map((l) => (l?.length === 1 ? l[0]! : null));
    if (found.every(Boolean)) {
      const cps = new Set(found.map((f) => f!.cp ?? `a:${f!.id}`));
      if (cps.size === 1) return mk(found[0]!, 'Несколько имён в одной строке — все ведут к одному получателю');
      return { artistId: found[0]!.id, artist: found[0]!.name, personId: null, person: null, note: 'Несколько артистов в одной строке разных получателей — выберите вручную' };
    }
  }
  return { artistId: null, artist: null, personId: null, person: null, note: 'Артист не найден в каталоге' };
}

export interface OpeningItem { name: string; kop: number; artistId: string | null; personId?: string | null }

export function commitOpening(db: Db, ctx: Ctx, quarter: string, items: OpeningItem[]): { saved: number; replaced: number; totalKop: number } {
  if (!/^\d{4}Q[1-4]$/.test(quarter)) throw new Error('Укажите квартал, с которого действует остаток');
  let saved = 0, replaced = 0, totalKop = 0;
  db.transaction(() => {
    for (const o of db.prepare("SELECT id FROM opening_balance WHERE quarter = ? AND deleted_at IS NULL AND note = 'import'").all(quarter)) { deleteRow(db, ctx, 'opening_balance', String(o.id)); replaced++; }
    for (const it of items) {
      if (!Number.isInteger(it.kop) || it.kop === 0) continue;
      insertRow(db, ctx, 'opening_balance', { quarter, artist_id: it.artistId, counterparty_id: it.personId ?? null, source_name: it.name, amount_kop: it.kop, note: 'import' });
      saved++; totalKop += it.kop;
    }
  })();
  return { saved, replaced, totalKop };
}

export interface OpeningListItem { id: string; quarter: string; name: string; artistId: string | null; artist: string | null; personId: string | null; person: string | null; kop: number }

export function listOpening(db: Db): OpeningListItem[] {
  return db.prepare(
    `SELECT o.id, o.quarter, o.source_name, o.amount_kop, o.artist_id, a.name AS artist, ifnull(o.counterparty_id, a.counterparty_id) AS pid,
            c.last_name, c.first_name, c.middle_name
       FROM opening_balance o LEFT JOIN artist a ON a.id = o.artist_id AND a.deleted_at IS NULL
       LEFT JOIN counterparty c ON c.id = ifnull(o.counterparty_id, a.counterparty_id)
      WHERE o.deleted_at IS NULL ORDER BY o.quarter DESC, o.source_name`,
  ).all().map((r) => ({
    id: String(r.id), quarter: String(r.quarter), name: String(r.source_name), artistId: r.artist_id ? String(r.artist_id) : null, artist: r.artist ? String(r.artist) : null,
    personId: r.pid ? String(r.pid) : null, person: r.pid ? [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ') : null, kop: Number(r.amount_kop),
  }));
}

export function updateOpening(db: Db, ctx: Ctx, id: string, patch: { artistId?: string | null; personId?: string | null; kop?: number }): void {
  const p: Record<string, unknown> = {};
  if (patch.artistId !== undefined) p.artist_id = patch.artistId;
  if (patch.personId !== undefined) p.counterparty_id = patch.personId;
  if (patch.kop !== undefined) { if (!Number.isInteger(patch.kop)) throw new Error('Сумма должна быть в копейках'); p.amount_kop = patch.kop; }
  if (Object.keys(p).length) db.transaction(() => updateRow(db, ctx, 'opening_balance', id, p))();
}

export function deleteOpening(db: Db, ctx: Ctx, id: string): void {
  db.transaction(() => deleteRow(db, ctx, 'opening_balance', id))();
}
