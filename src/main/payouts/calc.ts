// Расчёт «К выплате» (ТЗ §6, Схема_БД §8). Деньги: копейки целыми, доли и ставки — точные десятичные строки (BigInt, без float).
// К выплате по строке = Роялти × Ставка в треке × Ставка лейбла × (1 − скрытый вычет).
// Решение заказчика: строки НЕ округляются, итог по получателю (и договору) округляется ВНИЗ до копейки.
import { createHash } from 'node:crypto';
import { getSetting } from '../db/init.ts';
import type { Db } from '../db/types.ts';
import { DEC_ONE, decEquals, formatDec, parseDec } from '../domain/dec.ts';
import { filteredLines, type LineRow } from '../reports/lines.ts';

const SCALE3 = DEC_ONE * DEC_ONE * DEC_ONE; // три множителя масштаба 1e12

export interface AccrualRow {
  key: string;
  lineId: string;
  reportId: string;
  distributor: string;
  rights: string;
  upc: string | null;
  isrc: string | null;
  code: string | null;
  artistRaw: string | null;
  title: string | null;
  platform: string | null;
  usage: string | null;
  country: string | null;
  month: string | null;
  qty: number;
  royaltyKop: number;
  trackId: string;
  artistId: string;
  artistName: string;
  participationId: string;
  share: string;
  labelRate: string;
  groupKey: string;
  /** Начисление в «копейках × 1e36», без округления. */
  scaled: bigint;
}

export interface Problem {
  kind: 'no_track' | 'no_participation' | 'no_rate' | 'no_payee' | 'mixed_share_mismatch' | 'no_contract' | 'no_threshold_contract';
  text: string;
  rows: number;
  royaltyKop: number;
}

export interface GroupCalc {
  key: string;
  payeeId: string;
  payeeName: string;
  contractId: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  /** Доля получателя в роялти строк: Σ роялти × ставка в треке (до ставки лейбла и вычета). */
  royaltyKop: number;
  /** Начислено за квартал, вниз до копейки. */
  accruedKop: number;
  carriedInKop: number;
  payableKop: number;
  carriedOutKop: number;
  thresholdKop: number | null;
  thresholdRule: string | null;
  thresholdApplied: boolean;
  /** Что остаётся лейблу из доли получателя: доля − начислено. */
  marginKop: number;
  qty: number;
  rows: number;
  /** Средневзвешенная ставка лейбла, %, по роялти×доле. */
  labelRatePct: string;
  /** Отпечаток исходных данных: если изменится, выданные комплекты считаются устаревшими. */
  digest: string;
  artists: Array<{ artistId: string; name: string; rows: number; royaltyKop: number }>;
}

export interface QuarterCalc {
  quarter: string;
  groups: GroupCalc[];
  problems: Problem[];
  totals: { flowRoyaltyKop: number; allocatedKop: number; unallocatedKop: number; accruedKop: number; payableKop: number; marginKop: number };
}

const floorDiv = (a: bigint, b: bigint): bigint => (a >= 0n ? a / b : -((-a + b - 1n) / b));

/** Направление округления итога на получателя — выбирает пользователь перед формированием комплекта. */
export type RoundMode = 'down' | 'up' | 'nearest';
export const ROUND_MODES: RoundMode[] = ['down', 'up', 'nearest'];
export function roundDiv(a: bigint, b: bigint, mode: RoundMode): number {
  const f = floorDiv(a, b);
  if (mode === 'down') return Number(f);
  const rem = a - f * b;
  if (mode === 'up') return Number(rem > 0n ? f + 1n : f);
  return Number(rem * 2n >= b ? f + 1n : f); // «математически»: половина копейки — вверх
}

interface Part { id: string; track_id: string; artist_id: string; share_authors: string; share_related: string; label_rate: string | null; payee: string | null; contract_id: string | null; from: string | null; to: string | null }

function fullName(c: { last_name?: string | null; first_name?: string | null; middle_name?: string | null }): string {
  return [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ').trim();
}

/** Начисления по строкам квартала: строка × участник. Только отчёты с маршрутом «Приход лейбла». */
export function computeAccruals(db: Db, quarter: string): { rows: AccrualRow[]; problems: Problem[]; flowRoyaltyKop: number; allocatedKop: number } {
  const dedS = parseDec(getSetting(db, 'hidden_deduction')) ?? parseDec('0.06')!;
  const mult = DEC_ONE - dedS;
  const flows = new Map<string, string>();
  for (const r of db.prepare('SELECT id, flow FROM report WHERE quarter = ? AND deleted_at IS NULL AND current_version_id IS NOT NULL').all(quarter)) flows.set(r.id, r.flow);

  const parts = new Map<string, Part[]>();
  for (const p of db.prepare('SELECT * FROM participation WHERE deleted_at IS NULL').all()) {
    if (p.valid_from_quarter && quarter < p.valid_from_quarter) continue;
    if (p.valid_to_quarter && quarter > p.valid_to_quarter) continue;
    const a = parts.get(p.track_id) ?? [];
    a.push({ id: p.id, track_id: p.track_id, artist_id: p.artist_id, share_authors: p.share_authors, share_related: p.share_related, label_rate: p.label_rate, payee: p.payee_counterparty_id, contract_id: p.contract_id, from: p.valid_from_quarter, to: p.valid_to_quarter });
    parts.set(p.track_id, a);
  }
  const artists = new Map<string, { name: string; cp: string | null }>();
  for (const a of db.prepare('SELECT id, name, counterparty_id FROM artist WHERE deleted_at IS NULL').all()) artists.set(a.id, { name: a.name, cp: a.counterparty_id });
  const contractsOf = new Map<string, string[]>();
  for (const c of db.prepare('SELECT id, counterparty_id FROM contract WHERE deleted_at IS NULL').all()) {
    const a = contractsOf.get(c.counterparty_id) ?? [];
    a.push(c.id);
    contractsOf.set(c.counterparty_id, a);
  }

  const rows: AccrualRow[] = [];
  const probs = new Map<string, Problem>();
  const bump = (kind: Problem['kind'], text: string, royaltyKop: number): void => {
    const k = `${kind}|${text}`;
    const p = probs.get(k) ?? { kind, text, rows: 0, royaltyKop: 0 };
    p.rows++;
    p.royaltyKop += royaltyKop;
    probs.set(k, p);
  };
  let flowRoyalty = 0;
  let allocated = 0;
  const mixedSeen = new Set<string>();

  for (const l of filteredLines(db, { quarter }) as LineRow[]) {
    if (flows.get(l.reportId) !== 'artists') continue;
    flowRoyalty += l.royaltyKop;
    if (!l.trackId) { bump('no_track', 'Строки без трека в каталоге', l.royaltyKop); continue; }
    const ps = parts.get(l.trackId);
    if (!ps || ps.length === 0) { bump('no_participation', `Трек без участников: ${l.trackTitle ?? l.title ?? l.trackId}`, l.royaltyKop); continue; }
    let used = false;
    for (const p of ps) {
      const art = artists.get(p.artist_id);
      if (p.label_rate === null || p.label_rate === '') { bump('no_rate', `Нет ставки лейбла: ${art?.name ?? '?'} — ${l.trackTitle ?? l.title}`, l.royaltyKop); continue; }
      const payee = p.payee ?? art?.cp ?? null;
      if (!payee) { bump('no_payee', `У артиста нет получателя: ${art?.name ?? '?'}`, l.royaltyKop); continue; }
      let shareStr = p.share_related;
      if (l.rights === 'authors') shareStr = p.share_authors;
      else if (l.rights === 'mixed' && !decEquals(p.share_authors, p.share_related) && !mixedSeen.has(p.id)) {
        mixedSeen.add(p.id);
        bump('mixed_share_mismatch', `Доли авторские и смежные различаются у ${art?.name ?? '?'} (${l.trackTitle ?? l.title}): для «авт.+смеж.» взяты смежные`, 0);
      }
      const share = parseDec(shareStr), rate = parseDec(p.label_rate);
      if (share === null || rate === null) continue;
      const own = contractsOf.get(payee) ?? [];
      const contractId = p.contract_id ?? (own.length === 1 ? own[0]! : null);
      rows.push({
        key: l.key, lineId: l.lineId, reportId: l.reportId, distributor: l.distributor, rights: l.rights, upc: l.upc, isrc: l.isrc, code: l.code,
        artistRaw: l.artist, title: l.title ?? l.trackTitle, platform: l.platform, usage: l.usage ?? l.model, country: l.country, month: l.month,
        qty: l.qty, royaltyKop: l.royaltyKop, trackId: l.trackId, artistId: p.artist_id, artistName: art?.name ?? '', participationId: p.id,
        share: shareStr, labelRate: p.label_rate, groupKey: `${payee}|${contractId ?? ''}`,
        scaled: BigInt(l.royaltyKop) * share * rate * mult,
      });
      used = true;
    }
    if (used) allocated += l.royaltyKop;
  }
  return { rows, problems: [...probs.values()], flowRoyaltyKop: flowRoyalty, allocatedKop: allocated };
}

function prevQuarter(db: Db, quarter: string): string | null {
  const r = db.prepare("SELECT max(quarter) AS q FROM report WHERE quarter < ? AND deleted_at IS NULL AND flow = 'artists'").get(quarter);
  return r?.q ?? null;
}

interface RawGroup { key: string; payeeId: string; contractId: string | null; scaled: bigint; attr: bigint; qty: number; rows: AccrualRow[] }

function groupRows(rows: AccrualRow[]): RawGroup[] {
  const m = new Map<string, RawGroup>();
  for (const r of rows) {
    const [payeeId = '', c = ''] = r.groupKey.split('|');
    const g = m.get(r.groupKey) ?? { key: r.groupKey, payeeId, contractId: c || null, scaled: 0n, attr: 0n, qty: 0, rows: [] };
    g.scaled += r.scaled;
    g.attr += BigInt(r.royaltyKop) * parseDec(r.share)!;
    g.qty += r.qty;
    g.rows.push(r);
    m.set(r.groupKey, g);
  }
  return [...m.values()];
}

export function digestOf(rows: AccrualRow[], deduction: string): string {
  const h = createHash('sha256');
  h.update(deduction);
  for (const r of [...rows].sort((a, b) => (a.key + a.participationId < b.key + b.participationId ? -1 : 1))) h.update(`|${r.key}:${r.participationId}:${r.qty}:${r.royaltyKop}:${r.share}:${r.labelRate}`);
  return h.digest('hex').slice(0, 24);
}

/** Итоги квартала: по получателям и договорам, с переносом ниже порога из прошлых кварталов. */
export function computeQuarter(db: Db, quarter: string, mode: RoundMode = 'down', depth = 0): QuarterCalc {
  const { rows, problems, flowRoyaltyKop, allocatedKop } = computeAccruals(db, quarter);
  const ded = getSetting(db, 'hidden_deduction');
  const prev = depth < 40 ? prevQuarter(db, quarter) : null;
  const prevByKey = new Map<string, GroupCalc>();
  if (prev) for (const g of computeQuarter(db, prev, mode, depth + 1).groups) prevByKey.set(g.key, g);

  const cps = new Map<string, { last_name: string; first_name: string; middle_name: string }>();
  for (const c of db.prepare('SELECT * FROM counterparty').all()) cps.set(c.id, { last_name: c.last_name, first_name: c.first_name, middle_name: c.middle_name });
  const contracts = new Map<string, { number: string; date: string | null; threshold: number | null; rule: string | null }>();
  for (const c of db.prepare('SELECT * FROM contract').all()) contracts.set(c.id, { number: c.number, date: c.date, threshold: c.threshold_rub, rule: c.threshold_rule });

  const groups: GroupCalc[] = [];
  const raw = groupRows(rows);
  // получатели, у которых что-то перенесено с прошлых кварталов, но в этом начислений нет
  for (const [k, pg] of prevByKey) if (pg.carriedOutKop > 0 && !raw.some((g) => g.key === k)) raw.push({ key: k, payeeId: pg.payeeId, contractId: pg.contractId, scaled: 0n, attr: 0n, qty: 0, rows: [] });

  for (const g of raw) {
    const accrued = roundDiv(g.scaled, SCALE3, mode);
    const attrKop = Number(floorDiv(g.attr, DEC_ONE));
    const carriedIn = prevByKey.get(g.key)?.carriedOutKop ?? 0;
    const con = g.contractId ? contracts.get(g.contractId) : undefined;
    const threshold = con?.threshold ?? null;
    const total = accrued + carriedIn;
    const q4 = quarter.endsWith('Q4');
    const hold = threshold !== null && threshold > 0 && total < threshold && !(con?.rule === 'accumulate_year_end' && q4);
    const payable = hold ? 0 : total;
    const carriedOut = hold ? total : 0;
    // средневзвешенная ставка лейбла: Σ(роялти×доля×ставка) / Σ(роялти×доля)
    let num = 0n, den = 0n;
    for (const r of g.rows) {
      const base = BigInt(r.royaltyKop) * parseDec(r.share)!;
      num += base * parseDec(r.labelRate)!;
      den += base;
    }
    const pct = den > 0n ? formatDec((num * 100n) / den).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : '';
    const byArtist = new Map<string, { artistId: string; name: string; rows: number; royaltyKop: number }>();
    for (const r of g.rows) {
      const a = byArtist.get(r.artistId) ?? { artistId: r.artistId, name: r.artistName, rows: 0, royaltyKop: 0 };
      a.rows++;
      a.royaltyKop += r.royaltyKop;
      byArtist.set(r.artistId, a);
    }
    const cp = cps.get(g.payeeId);
    groups.push({
      key: g.key, payeeId: g.payeeId, payeeName: cp ? fullName(cp) : '(получатель не найден)', contractId: g.contractId, contractNumber: con?.number ?? null, contractDate: con?.date ?? null,
      royaltyKop: attrKop, accruedKop: accrued, carriedInKop: carriedIn, payableKop: payable, carriedOutKop: carriedOut, thresholdKop: threshold, thresholdRule: con?.rule ?? null,
      thresholdApplied: hold, marginKop: attrKop - accrued, qty: g.qty, rows: g.rows.length, labelRatePct: pct, digest: digestOf(g.rows, ded), artists: [...byArtist.values()],
    });
  }
  groups.sort((a, b) => a.payeeName.localeCompare(b.payeeName, 'ru'));

  const extra: Problem[] = [];
  for (const g of groups) {
    if (!g.contractId) extra.push({ kind: 'no_contract', text: `Нет договора у получателя: ${g.payeeName}`, rows: g.rows, royaltyKop: g.royaltyKop });
    else if (g.thresholdKop === null) extra.push({ kind: 'no_threshold_contract', text: `В договоре ${g.contractNumber} не задан порог выплаты: платим всё`, rows: 0, royaltyKop: 0 });
  }
  const accruedAll = groups.reduce((a, g) => a + g.accruedKop, 0);
  return {
    quarter,
    groups,
    problems: [...problems, ...extra],
    totals: {
      flowRoyaltyKop, allocatedKop, unallocatedKop: flowRoyaltyKop - allocatedKop, accruedKop: accruedAll,
      payableKop: groups.reduce((a, g) => a + g.payableKop, 0), marginKop: allocatedKop - accruedAll,
    },
  };
}

/** Строки одного получателя/договора для Excel и PDF. */
export function rowsOfGroup(db: Db, quarter: string, groupKey: string): AccrualRow[] {
  return computeAccruals(db, quarter).rows.filter((r) => r.groupKey === groupKey);
}
