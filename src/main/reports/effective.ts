// Эффективные строки: исходная строка → правки по порядку → переносы. Чистые функции, без базы.
// Деньги — целые копейки. Ставка хранится как точная дробь «копеек за прослушивание», float нигде не участвует.
import type { StreamKind } from './types.ts';

export type EditField = 'qty' | 'royalty_kop' | 'rate_per_stream' | 'stream_kind' | 'usage_type' | 'track_id';

export interface BaseLine {
  id: string;
  qty: number;
  royaltyKop: number;
  /** Точная сумма в копейках (десятичная строка), если известна. */
  exactKop?: string | null;
  streamKind: StreamKind;
  usageType: string | null;
  trackId: string | null;
}
export interface EditRec { id: string; lineId: string; field: EditField; newValue: string | null }
export interface SplitRec { id: string; lineId: string; qtyMoved: number; toStreamKind: StreamKind; toUsageType: string | null; ratePerStream: string | null }

export interface Frac { n: bigint; d: bigint }

export interface EffPiece {
  /** Ключ части: id строки, а для перенесённой части — `<id>#<id переноса>`. */
  key: string;
  lineId: string;
  splitId: string | null;
  qty: number;
  royaltyKop: number;
  /** Точная сумма в копейках: у нетронутой строки — как в отчёте, у правленой/разбитой — целые копейки. */
  exactKop: string;
  /** Ставка за прослушивание в рублях, 8 знаков; null если тираж 0. */
  rate: string | null;
  /** Та же ставка точной дробью (копейки за прослушивание) — для массовых расчётов. */
  rateFrac: Frac | null;
  streamKind: StreamKind;
  usageType: string | null;
  trackId: string | null;
  /** Какие поля отличаются от исходной строки. */
  changed: string[];
}

/** Округление дроби до целого: к ближайшему, половина — от нуля. */
export function roundFrac(n: bigint, d: bigint): bigint {
  if (d < 0n) { n = -n; d = -d; }
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return neg ? -q : q;
}

/** «0,0123» / «0.0123» (рубли за прослушивание) → дробь в копейках. */
export function parseRateRub(input: unknown): Frac | null {
  const s = String(input ?? '').replace(/[\s ]/g, '').replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  const n = BigInt(m[2]! + frac) * 100n;
  return { n: m[1] ? -n : n, d: 10n ** BigInt(frac.length) };
}

export function rateToRubString(r: Frac | null, digits = 8): string | null {
  if (!r || r.d === 0n) return null;
  const scale = 10n ** BigInt(digits);
  const v = roundFrac(r.n * scale, r.d * 100n);
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(digits + 1, '0');
  const s = `${a.slice(0, -digits)}.${a.slice(-digits)}`.replace(/0+$/, '').replace(/\.$/, '');
  return neg ? `-${s}` : s;
}

const royFromRate = (qty: number, r: Frac): number => Number(roundFrac(BigInt(qty) * r.n, r.d));

interface State { qty: number; roy: number; rate: Frac | null; kind: StreamKind; usage: string | null; track: string | null }

function applyEdit(st: State, e: EditRec): State {
  switch (e.field) {
    case 'qty': {
      const q = Number(e.newValue);
      if (!Number.isInteger(q) || q < 0) return st;
      return { ...st, qty: q, roy: st.rate ? royFromRate(q, st.rate) : st.roy };
    }
    case 'royalty_kop': {
      const v = Number(e.newValue);
      if (!Number.isInteger(v)) return st;
      return { ...st, roy: v, rate: st.qty > 0 ? { n: BigInt(v), d: BigInt(st.qty) } : null };
    }
    case 'rate_per_stream': {
      const r = parseRateRub(e.newValue);
      return r ? { ...st, rate: r, roy: royFromRate(st.qty, r) } : st;
    }
    case 'stream_kind': return { ...st, kind: e.newValue as StreamKind };
    case 'usage_type': return { ...st, usage: e.newValue };
    case 'track_id': return { ...st, track: e.newValue };
  }
}

/** Части одной строки: правки по порядку, затем переносы. `edits` и `splits` уже без откатанных, в порядке создания. */
export function effectivePieces(base: BaseLine, edits: EditRec[], splits: SplitRec[]): EffPiece[] {
  let st: State = {
    qty: base.qty, roy: base.royaltyKop, rate: base.qty > 0 ? { n: BigInt(base.royaltyKop), d: BigInt(base.qty) } : null,
    kind: base.streamKind, usage: base.usageType, track: base.trackId,
  };
  for (const e of edits) st = applyEdit(st, e);
  const changedOf = (s: State): string[] => {
    const c: string[] = [];
    if (s.qty !== base.qty) c.push('qty');
    if (s.roy !== base.royaltyKop) c.push('royalty');
    if (s.kind !== base.streamKind) c.push('stream_kind');
    if (s.usage !== base.usageType) c.push('usage_type');
    if (s.track !== base.trackId) c.push('track');
    // ставка изменена, если она не равна исходной дроби
    const o = base.qty > 0 ? { n: BigInt(base.royaltyKop), d: BigInt(base.qty) } : null;
    if ((o === null) !== (s.rate === null) || (o && s.rate && o.n * s.rate.d !== s.rate.n * o.d)) c.push('rate');
    return c;
  };
  const out: EffPiece[] = [];
  let rem: State = st;
  const moved: EffPiece[] = [];
  for (const sp of splits) {
    const m = Math.min(Math.max(0, sp.qtyMoved), rem.qty);
    if (m <= 0) continue;
    const mRate = sp.ratePerStream ? parseRateRub(sp.ratePerStream) : rem.rate;
    const mRoyRaw = mRate ? royFromRate(m, mRate) : 0;
    const mRoy = mRoyRaw;
    const piece: State = { qty: m, roy: mRoy, rate: mRate, kind: sp.toStreamKind, usage: sp.toUsageType ?? rem.usage, track: rem.track };
    moved.push({
      key: `${base.id}#${sp.id}`, lineId: base.id, splitId: sp.id, qty: m, royaltyKop: mRoy, exactKop: String(mRoy), rate: rateToRubString(mRate), rateFrac: mRate,
      streamKind: piece.kind, usageType: piece.usage, trackId: piece.track, changed: [...new Set([...changedOf(piece), 'split'])],
    });
    const left = rem.qty - m;
    // Своя ставка у части: остаток считается по прежней ставке, общая сумма строки меняется (деньги по перерасчёту не придут).
    // Ставка не задана: часть и остаток по прежней ставке, сумма строки сохраняется до копейки.
    const leftRoy = sp.ratePerStream && rem.rate ? royFromRate(left, rem.rate) : rem.roy - mRoy;
    rem = { ...rem, qty: left, roy: leftRoy, rate: sp.ratePerStream ? rem.rate : left > 0 ? { n: BigInt(leftRoy), d: BigInt(left) } : null };
  }
  out.push({
    key: base.id, lineId: base.id, splitId: null, qty: rem.qty, royaltyKop: rem.roy, exactKop: String(rem.roy), rate: rateToRubString(rem.rate), rateFrac: rem.rate,
    streamKind: rem.kind, usageType: rem.usage, trackId: rem.track, changed: [...changedOf(rem), ...(splits.length ? ['split'] : [])],
  });
  const touched = out[0]!.changed.length > 0;
  if (!touched && base.exactKop) out[0]!.exactKop = base.exactKop;
  return [...out, ...moved];
}
