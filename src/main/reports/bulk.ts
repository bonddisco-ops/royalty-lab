// Массовые правки по фильтру (Схема_БД §7, edit_batch): предпросмотр «было → станет», применение партией, откат одной кнопкой.
import { insertRow, updateRow } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import { parseDec, DEC_ONE } from '../domain/dec.ts';
import { effectivePieces, parseRateRub, rateToRubString, roundFrac, type EditRec, type Frac, type SplitRec } from './effective.ts';
import { planEdit, rubToKop, type UiField } from './edits.ts';
import { filteredLines, invalidateLines, lineSrc, type LineFilter, type LineRow } from './lines.ts';
import type { StreamKind } from './types.ts';

export type BulkAction =
  | { type: 'set'; field: UiField; value: string }
  | { type: 'change'; field: 'qty' | 'royalty' | 'rate'; mode: 'percent' | 'amount'; value: string }
  | { type: 'move'; by: 'qty' | 'percent'; value: string; toKind: StreamKind; rate?: string | null };

export interface BulkSample {
  lineId: string;
  title: string | null;
  platform: string | null;
  before: { qty: number; royaltyKop: number; streamKind: string; rate: string | null };
  after: { qty: number; royaltyKop: number; streamKind: string; rate: string | null };
}
export interface BulkPlan {
  affected: number;
  skipped: { hasSplit: number; noChange: number; invalid: number };
  deltaKop: number;
  sample: BulkSample[];
  /** Для применения: что записать по каждой строке. */
  items: Array<{ lineId: string; edits: Array<{ field: EditRec['field']; value: string | null }>; split?: { qtyMoved: number; toKind: StreamKind; rate: string | null } }>;
}

/** Целое число из десятичной дроби процента: cur × (100 + p) / 100, к ближайшему. */
function scaleInt(cur: bigint, pctScaled: bigint): bigint {
  return roundFrac(cur * (100n * DEC_ONE + pctScaled), 100n * DEC_ONE);
}

function pctOf(value: string): bigint {
  const p = parseDec(value);
  if (p === null) throw new Error('Процент — число, например 10 или -5,5');
  return p;
}

export function planBulk(db: Db, filter: LineFilter, action: BulkAction): BulkPlan {
  const plan: BulkPlan = { affected: 0, skipped: { hasSplit: 0, noChange: 0, invalid: 0 }, deltaKop: 0, sample: [], items: [] };
  const rows = filteredLines(db, filter).filter((r: LineRow) => r.splitId === null);
  // валидируем действие один раз
  if (action.type === 'change' && action.mode === 'percent') pctOf(action.value);
  if (action.type === 'move' && action.by === 'percent') {
    const p = pctOf(action.value);
    if (p <= 0n || p > 100n * DEC_ONE) throw new Error('Процент переноса: от 0 до 100');
  }
  if (action.type === 'move' && action.by === 'qty' && !/^\d+$/.test(action.value.trim())) throw new Error('Сколько переносить: целое число');
  if (action.type === 'move' && action.rate && !parseRateRub(action.rate)) throw new Error('Ставка — число в рублях за прослушивание');
  if (action.type === 'change' && action.mode === 'amount') {
    if (action.field === 'royalty') rubToKop(action.value);
    else if (action.field === 'rate') { if (!parseRateRub(action.value)) throw new Error('Ставка — число в рублях'); }
    else if (!/^-?\d+$/.test(action.value.trim())) throw new Error('Тираж меняется на целое число');
  }
  for (const r of rows) {
    const s = lineSrc(db, r.lineId);
    if (!s) { plan.skipped.invalid++; continue; }
    if (s.src.splits.length > 0) { plan.skipped.hasSplit++; continue; }
    const cur = s.src.pieces[0]!;
    let edits: BulkPlan['items'][number]['edits'] = [];
    let split: BulkPlan['items'][number]['split'];
    try {
      if (action.type === 'set') {
        edits = planEdit(db, r.lineId, action.field, action.value);
      } else if (action.type === 'change') {
        if (action.field === 'qty') {
          const q = action.mode === 'percent' ? scaleInt(BigInt(cur.qty), pctOf(action.value)) : BigInt(cur.qty) + BigInt(action.value.trim());
          if (q < 0n) { plan.skipped.invalid++; continue; }
          edits = planEdit(db, r.lineId, 'qty', String(q));
        } else if (action.field === 'royalty') {
          const k = action.mode === 'percent' ? scaleInt(BigInt(cur.royaltyKop), pctOf(action.value)) : BigInt(cur.royaltyKop) + BigInt(rubToKop(action.value));
          edits = [{ field: 'royalty_kop', value: String(k) }];
        } else {
          const f = cur.rateFrac;
          if (!f) { plan.skipped.invalid++; continue; }
          let nf: Frac;
          if (action.mode === 'percent') {
            const p = pctOf(action.value);
            nf = { n: f.n * (100n * DEC_ONE + p), d: f.d * 100n * DEC_ONE };
          } else {
            const a = parseRateRub(action.value)!;
            nf = { n: f.n * a.d + a.n * f.d, d: f.d * a.d };
          }
          const str = rateToRubString(nf, 12);
          if (str === null) { plan.skipped.invalid++; continue; }
          edits = [{ field: 'rate_per_stream', value: str }];
        }
      } else {
        const n = action.by === 'qty' ? BigInt(action.value.trim()) : roundFrac(BigInt(cur.qty) * pctOf(action.value), 100n * DEC_ONE);
        const q = Number(n > BigInt(cur.qty) ? BigInt(cur.qty) : n);
        if (q <= 0) { plan.skipped.noChange++; continue; }
        split = { qtyMoved: q, toKind: action.toKind, rate: action.rate ? action.rate.replace(',', '.') : null };
      }
    } catch {
      plan.skipped.invalid++;
      continue;
    }
    const extraEdits: EditRec[] = edits.map((e, i) => ({ id: `~${i}`, lineId: r.lineId, field: e.field, newValue: e.value }));
    const extraSplits: SplitRec[] = split ? [{ id: '~s', lineId: r.lineId, qtyMoved: split.qtyMoved, toStreamKind: split.toKind, toUsageType: null, ratePerStream: split.rate }] : [];
    const after = effectivePieces(s.src.base, [...s.src.edits, ...extraEdits], extraSplits);
    const aRoy = after.reduce((a, p) => a + p.royaltyKop, 0);
    const same = after.length === 1 && after[0]!.qty === cur.qty && after[0]!.royaltyKop === cur.royaltyKop && after[0]!.streamKind === cur.streamKind
      && after[0]!.usageType === cur.usageType && after[0]!.trackId === cur.trackId && after[0]!.rate === cur.rate;
    if (same) { plan.skipped.noChange++; continue; }
    plan.affected++;
    plan.deltaKop += aRoy - cur.royaltyKop;
    plan.items.push({ lineId: r.lineId, edits, split });
    if (plan.sample.length < 12) {
      const a0 = after[0]!;
      plan.sample.push({
        lineId: r.lineId, title: r.title, platform: r.platform,
        before: { qty: cur.qty, royaltyKop: cur.royaltyKop, streamKind: cur.streamKind, rate: cur.rate },
        after: { qty: a0.qty, royaltyKop: a0.royaltyKop, streamKind: a0.streamKind, rate: a0.rate },
      });
    }
  }
  return plan;
}

export function applyBulk(db: Db, ctx: Ctx, filter: LineFilter, action: BulkAction): { batchId: string; affected: number; deltaKop: number } {
  return db.transaction(() => {
    const plan = planBulk(db, filter, action);
    if (plan.affected === 0) throw new Error('Под условия не попало ни одной строки, которую можно изменить');
    const batchId = insertRow(db, ctx, 'edit_batch', { filter_json: filter, action_json: action, summary_delta_kop: plan.deltaKop, affected: plan.affected });
    for (const it of plan.items) {
      for (const e of it.edits) insertRow(db, ctx, 'line_edit', { line_id: it.lineId, field: e.field, new_value: e.value, batch_id: batchId });
      if (it.split) insertRow(db, ctx, 'line_split', { line_id: it.lineId, qty_moved: it.split.qtyMoved, to_stream_kind: it.split.toKind, to_usage_type: null, rate_per_stream: it.split.rate, batch_id: batchId });
    }
    invalidateLines(db);
    return { batchId, affected: plan.affected, deltaKop: plan.deltaKop };
  })();
}

export interface BatchItem { id: string; createdAt: string; createdBy: string | null; affected: number; deltaKop: number; revertedAt: string | null; filter: LineFilter; action: BulkAction }

export function listBatches(db: Db): BatchItem[] {
  return db.prepare('SELECT * FROM edit_batch WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 100').all().map((b) => ({
    id: b.id, createdAt: b.created_at, createdBy: b.updated_by ?? null, affected: b.affected, deltaKop: b.summary_delta_kop, revertedAt: b.reverted_at,
    filter: JSON.parse(b.filter_json) as LineFilter, action: JSON.parse(b.action_json) as BulkAction,
  }));
}

export function revertBatch(db: Db, ctx: Ctx, batchId: string): number {
  return db.transaction(() => {
    const b = db.prepare('SELECT * FROM edit_batch WHERE id = ? AND deleted_at IS NULL').get(batchId);
    if (!b) throw new Error('Партия не найдена');
    if (b.reverted_at) throw new Error('Эта партия уже откатана');
    const now = new Date().toISOString();
    let n = 0;
    for (const e of db.prepare('SELECT id FROM line_edit WHERE batch_id = ? AND reverted_at IS NULL AND deleted_at IS NULL').all(batchId)) { updateRow(db, ctx, 'line_edit', e.id, { reverted_at: now }); n++; }
    for (const s of db.prepare('SELECT id FROM line_split WHERE batch_id = ? AND reverted_at IS NULL AND deleted_at IS NULL').all(batchId)) { updateRow(db, ctx, 'line_split', s.id, { reverted_at: now }); n++; }
    updateRow(db, ctx, 'edit_batch', batchId, { reverted_at: now });
    invalidateLines(db);
    return n;
  })();
}
