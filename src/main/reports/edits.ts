// Запись правок строк (Схема_БД §7). Исходные строки не трогаем: только line_edit / line_split.
import { insertRow, updateRow } from '../db/mutate.ts';
import { getSetting } from '../db/init.ts';
import type { Ctx, Db } from '../db/types.ts';
import { parseRateRub } from './effective.ts';
import { findLine, invalidateLines } from './lines.ts';
import type { StreamKind } from './types.ts';

export type UiField = 'qty' | 'royalty' | 'rate' | 'stream_kind' | 'usage_type' | 'track_id';
const KINDS: StreamKind[] = ['paid', 'ad', 'other', 'nonstream'];

/** Рубли «12,34» → копейки (к ближайшей); отрицательные допустимы (корректировки). */
export function rubToKop(input: unknown): number {
  const s = String(input ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('Нужна сумма в рублях, например 125,40');
  const neg = s.startsWith('-');
  const [i = '0', f = ''] = s.replace('-', '').split('.');
  const frac = (f + '000').slice(0, 3);
  const k = BigInt(i) * 100n + BigInt(frac.slice(0, 2)) + (frac[2]! >= '5' ? 1n : 0n);
  return Number(neg ? -k : k);
}

interface PlannedEdit { field: 'qty' | 'royalty_kop' | 'rate_per_stream' | 'stream_kind' | 'usage_type' | 'track_id'; value: string | null }

function hasActiveSplit(db: Db, lineId: string): boolean {
  return !!db.prepare('SELECT 1 FROM line_split WHERE line_id = ? AND reverted_at IS NULL AND deleted_at IS NULL').get(lineId);
}

function assertEditable(db: Db, lineId: string): { versionId: string } {
  const l = db.prepare(
    `SELECT l.report_version_id AS v, r.current_version_id AS cur FROM statement_line l JOIN report_version v ON v.id = l.report_version_id
       JOIN report r ON r.id = v.report_id WHERE l.id = ? AND v.deleted_at IS NULL AND r.deleted_at IS NULL`,
  ).get(lineId);
  if (!l) throw new Error('Строка не найдена');
  if (l.cur !== l.v) throw new Error('Эта строка из старой версии отчёта, править можно только текущую');
  return { versionId: l.v };
}

/** Что записать в line_edit для правки поля из интерфейса. Единицы интерфейса: рубли, штуки. */
export function planEdit(db: Db, lineId: string, field: UiField, value: string | null): PlannedEdit[] {
  const v = value === null ? '' : String(value).trim();
  switch (field) {
    case 'qty': {
      if (!/^\d+$/.test(v.replace(/[\s ]/g, ''))) throw new Error('Тираж — целое число не меньше 0');
      const q = v.replace(/[\s ]/g, '');
      const out: PlannedEdit[] = [{ field: 'qty', value: q }];
      if (getSetting(db, 'rate_change_mode') === 'keep_royalty') {
        const cur = findLine(db, lineId)[0];
        if (cur) out.push({ field: 'royalty_kop', value: String(cur.royaltyKop) });
      }
      return out;
    }
    case 'royalty': return [{ field: 'royalty_kop', value: String(rubToKop(v)) }];
    case 'rate': {
      if (!parseRateRub(v)) throw new Error('Ставка — число в рублях за прослушивание, например 0,0123');
      return [{ field: 'rate_per_stream', value: v.replace(',', '.') }];
    }
    case 'stream_kind':
      if (!KINDS.includes(v as StreamKind)) throw new Error('Неизвестный тип стрима');
      return [{ field: 'stream_kind', value: v }];
    case 'usage_type': return [{ field: 'usage_type', value: v || null }];
    case 'track_id':
      if (v && !db.prepare('SELECT 1 FROM track WHERE id = ? AND deleted_at IS NULL').get(v)) throw new Error('Трек не найден');
      return [{ field: 'track_id', value: v || null }];
  }
}

export function editLine(db: Db, ctx: Ctx, lineId: string, field: UiField, value: string | null): void {
  db.transaction(() => {
    const { versionId } = assertEditable(db, lineId);
    if (hasActiveSplit(db, lineId)) throw new Error('У строки есть перенос прослушиваний. Сначала верните строку к исходной');
    for (const e of planEdit(db, lineId, field, value)) {
      insertRow(db, ctx, 'line_edit', { line_id: lineId, field: e.field, new_value: e.value, batch_id: null });
    }
    invalidateLines(db, versionId);
  })();
}

export function splitLine(db: Db, ctx: Ctx, lineId: string, qtyMoved: number, toKind: StreamKind, rateRub?: string | null, toUsage?: string | null): void {
  db.transaction(() => {
    const { versionId } = assertEditable(db, lineId);
    if (!Number.isInteger(qtyMoved) || qtyMoved <= 0) throw new Error('Сколько прослушиваний переносить: целое число больше 0');
    if (!KINDS.includes(toKind)) throw new Error('Неизвестный тип стрима');
    const rem = findLine(db, lineId).find((r) => r.splitId === null);
    if (!rem) throw new Error('Строка не найдена');
    if (qtyMoved > rem.qty) throw new Error(`В строке осталось ${rem.qty} прослушиваний, переносить ${qtyMoved} нельзя`);
    if (rateRub && !parseRateRub(rateRub)) throw new Error('Ставка — число в рублях за прослушивание');
    insertRow(db, ctx, 'line_split', { line_id: lineId, qty_moved: qtyMoved, to_stream_kind: toKind, to_usage_type: toUsage ?? null, rate_per_stream: rateRub ? rateRub.replace(',', '.') : null, batch_id: null });
    invalidateLines(db, versionId);
  })();
}

/** Вернуть строку к исходной: гасим все её действующие правки и переносы (в истории остаются). */
export function revertLine(db: Db, ctx: Ctx, lineId: string): number {
  return db.transaction(() => {
    const { versionId } = assertEditable(db, lineId);
    const now = new Date().toISOString();
    let n = 0;
    for (const e of db.prepare('SELECT id FROM line_edit WHERE line_id = ? AND reverted_at IS NULL AND deleted_at IS NULL').all(lineId)) { updateRow(db, ctx, 'line_edit', e.id, { reverted_at: now }); n++; }
    for (const s of db.prepare('SELECT id FROM line_split WHERE line_id = ? AND reverted_at IS NULL AND deleted_at IS NULL').all(lineId)) { updateRow(db, ctx, 'line_split', s.id, { reverted_at: now }); n++; }
    invalidateLines(db, versionId);
    return n;
  })();
}
