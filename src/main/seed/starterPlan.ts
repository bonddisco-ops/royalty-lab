// Сборка плана загрузки стартовой базы (Схема_БД.md §11, ТЗ §10). Чистая функция: ничего не пишет в БД.
import { decEquals, formatDec, isWholeShare, parseDec, sumDec } from '../domain/dec.ts';
import { uuidv7 } from '../domain/ids.ts';
import { cleanText, normKey } from '../domain/normalize.ts';
import type { Row } from '../db/types.ts';
import {
  parseAppendix,
  parsePeople,
  parseProblems,
  parseSplit,
  type AppendixRow,
  type PersonRec,
  type StarterSheets,
} from './starterParse.ts';

/**
 * Псевдонимы, которые нельзя вывести из названия папки (Схема_БД.md §4, ТЗ §2):
 * - у ИП Рычагова (ОРГ) своего артиста нет: он получает часть процента FAVIA, делит заказчик в карточках;
 * - второй брат BONIIL — получатель, отдельного псевдонима нет.
 */
export const ARTIST_ALIAS_OVERRIDES: Record<string, string[]> = {
  'ПР-ИП/ОРГ/25': [],
  'ПР/БНК/25': [],
};

/** Известные опечатки в названиях артистов (ТЗ §10). */
export const NAME_VARIANTS: Array<{ variant: string; artist: string }> = [{ variant: 'Matvey Emersson', artist: 'Matvey Emerson' }];

export interface PlanOp {
  table: string;
  row: Row;
}

export interface PlanSummary {
  people: number;
  contracts: number;
  appendices: number;
  appendixItems: number;
  artists: number;
  artistsWithPerson: number;
  artistsWithoutPerson: number;
  tracks: number;
  tracksWithIsrc: number;
  tracksWithCodesOnly: number;
  tracksFromAppendixOnly: number;
  trackIdentifiers: number;
  participations: number;
  participationsFromContract: number;
  contractSharesApplied: number;
  contractSharesDiffer: number;
  contractSharesAmbiguous: number;
  duplicateSplitRowsMerged: number;
  issuesByKind: Record<string, number>;
  issuesAutoResolved: number;
  warnings: string[];
  unmatchedAppendixTracks: string[];
  ambiguousContractShares: string[];
  possibleNameTypos: string[];
}

export interface StarterPlan {
  ops: PlanOp[];
  summary: PlanSummary;
}

interface CpPlan {
  id: string;
  row: Row;
}
interface ArtistPlan {
  id: string;
  name: string;
  cpId: string | null;
  norm: string;
}
interface TrackPlan {
  id: string;
  title: string;
  isrc: string | null;
  codes: string[];
  fromAppendixOnly: boolean;
}
interface PartPlan {
  id: string;
  row: Row;
  trackId: string;
  artistId: string;
  split: { share: string | null; rate: string | null } | null;
  contractShareBy: string | null;
}
interface ContractPlan {
  id: string;
  rec: PersonRec;
  cpId: string;
  row: Row;
  appendixId: string;
  aliasIds: string[];
}

const nz = (s: string | null | undefined): string | null => (s && s.trim() ? s : null);

export function buildStarterPlan(sheets: StarterSheets): StarterPlan {
  const people = parsePeople(sheets.people);
  const appendixRows = parseAppendix(sheets.appendix);
  const splitRows = parseSplit(sheets.split);
  const problems = parseProblems(sheets.problems);

  const ops: PlanOp[] = [];
  const warnings: string[] = [];
  const summary: PlanSummary = {
    people: 0, contracts: 0, appendices: 0, appendixItems: 0, artists: 0, artistsWithPerson: 0, artistsWithoutPerson: 0,
    tracks: 0, tracksWithIsrc: 0, tracksWithCodesOnly: 0, tracksFromAppendixOnly: 0, trackIdentifiers: 0, participations: 0,
    participationsFromContract: 0, contractSharesApplied: 0, contractSharesDiffer: 0, contractSharesAmbiguous: 0,
    duplicateSplitRowsMerged: 0, issuesByKind: {}, issuesAutoResolved: 0, warnings, unmatchedAppendixTracks: [],
    ambiguousContractShares: [], possibleNameTypos: [],
  };

  // ------------------------------------------------------------ контрагенты
  const cps = new Map<string, CpPlan>();
  const cpByContractNo = new Map<string, string>();
  const cpByFolder = new Map<string, string>();
  const cpKeyOf = (p: PersonRec): string => p.inn || `${normKey(p.fioRaw)}|${p.birthDate ?? ''}`;

  for (const p of people) {
    const key = cpKeyOf(p);
    let cp = cps.get(key);
    const row: Row = {
      last_name: nz(p.lastName), first_name: nz(p.firstName), middle_name: nz(p.middleName), birth_date: p.birthDate,
      status: p.status, inn: nz(p.inn), ogrnip: p.ogrnip, passport_series: nz(p.passportSeries), passport_number: nz(p.passportNumber),
      passport_issued_by: nz(p.passportIssuedBy), passport_issued_date: p.passportIssuedDate, addr_raw: nz(p.address),
      bank_name: nz(p.bankName), bank_bik: nz(p.bik), bank_corr_account: nz(p.corr), bank_account: nz(p.account), email: nz(p.email),
      custom_json: JSON.stringify({ source: 'starter', fio_raw: p.fioRaw, passport_issued_raw: p.passportIssuedRaw || null }),
    };
    if (!cp) {
      cp = { id: uuidv7(), row };
      cps.set(key, cp);
    } else {
      for (const [k, v] of Object.entries(row)) if ((cp.row[k] === null || cp.row[k] === undefined || cp.row[k] === 'unknown') && v) cp.row[k] = v;
    }
    if (p.contractNo) cpByContractNo.set(p.contractNo, cp.id);
    cpByFolder.set(p.folder.toLowerCase() + '|' + (p.contractNo ?? ''), cp.id);
  }
  summary.people = cps.size;

  // ------------------------------------------------------------- артисты
  const artists = new Map<string, ArtistPlan>(); // norm -> artist
  const variantTargets = new Map<string, string>(); // norm(variant) -> norm(artist)
  for (const v of NAME_VARIANTS) variantTargets.set(normKey(v.variant), normKey(v.artist));
  const folderArtistIds = new Map<string, Set<string>>(); // folder -> artist ids

  const ensureArtist = (name: string, cpId: string | null): ArtistPlan => {
    let norm = normKey(name);
    norm = variantTargets.get(norm) ?? norm;
    let a = artists.get(norm);
    if (!a) {
      const display = variantTargets.has(normKey(name)) ? NAME_VARIANTS.find((v) => normKey(v.variant) === normKey(name))!.artist : cleanText(name);
      a = { id: uuidv7(), name: display, cpId, norm };
      artists.set(norm, a);
    } else if (!a.cpId && cpId) {
      a.cpId = cpId;
    }
    return a;
  };

  const contractAliasIds = new Map<string, string[]>();
  for (const p of people) {
    const cpId = cps.get(cpKeyOf(p))!.id;
    const aliases = p.contractNo && p.contractNo in ARTIST_ALIAS_OVERRIDES ? ARTIST_ALIAS_OVERRIDES[p.contractNo]! : p.aliases;
    const ids: string[] = [];
    for (const al of aliases) {
      const existing = artists.get(normKey(al));
      if (existing && existing.cpId && existing.cpId !== cpId) {
        warnings.push(`Псевдоним «${al}» уже закреплён за другим человеком, договор ${p.contractNo ?? '—'} не привязан к артисту.`);
        continue;
      }
      ids.push(ensureArtist(al, cpId).id);
    }
    if (p.contractNo) contractAliasIds.set(p.contractNo, ids);
    const f = folderArtistIds.get(p.folder) ?? new Set<string>();
    for (const al of p.aliases) {
      const a = artists.get(normKey(al));
      if (a) f.add(a.id);
    }
    folderArtistIds.set(p.folder, f);
  }

  // ---------------------------------------------- треки и участия из SPLIT
  const tracks = new Map<string, TrackPlan>();
  const tracksByIsrc = new Map<string, TrackPlan>();
  const tracksByCode = new Map<string, TrackPlan>();
  const normTitleToTracks = new Map<string, Set<string>>();
  const trackArtists = new Map<string, Set<string>>();
  const trackTitleNorm = new Map<string, string>();

  const addTrack = (t: TrackPlan): TrackPlan => {
    tracks.set(t.id, t);
    const n = normKey(t.title);
    trackTitleNorm.set(t.id, n);
    (normTitleToTracks.get(n) ?? normTitleToTracks.set(n, new Set()).get(n)!).add(t.id);
    return t;
  };

  // Внутренние коды (PRR…, ORPM…): одну песню в каталогах склеиваем по названию + общему артисту.
  const codeInfo = new Map<string, { normTitle: string; title: string; artists: Set<string> }>();
  const artistOfRow = new Map<number, ArtistPlan>();
  for (const r of splitRows) {
    const a = ensureArtist(r.artist, null);
    artistOfRow.set(r.line, a);
    if (r.isCode) {
      const ci = codeInfo.get(r.isrc) ?? { normTitle: normKey(r.title), title: r.title, artists: new Set<string>() };
      ci.artists.add(a.id);
      codeInfo.set(r.isrc, ci);
    }
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const c of codeInfo.keys()) parent.set(c, c);
  const codes = [...codeInfo.keys()];
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const a = codeInfo.get(codes[i]!)!;
      const b = codeInfo.get(codes[j]!)!;
      if (a.normTitle === b.normTitle && [...a.artists].some((x) => b.artists.has(x))) parent.set(find(codes[i]!), find(codes[j]!));
    }
  }

  const parts = new Map<string, PartPlan>();
  const splitBy = (trackId: string, artistId: string) => parts.get(`${trackId}|${artistId}`);
  const dupConflicts: Array<{ trackId: string; artistId: string; a: unknown; b: unknown }> = [];

  for (const r of splitRows) {
    const a = artistOfRow.get(r.line)!;
    let t: TrackPlan;
    if (!r.isCode) {
      t = tracksByIsrc.get(r.isrc) ?? addTrack({ id: uuidv7(), title: r.title, isrc: r.isrc, codes: [], fromAppendixOnly: false });
      tracksByIsrc.set(r.isrc, t);
    } else {
      const root = find(r.isrc);
      const known = tracksByCode.get(root);
      t = known ?? addTrack({ id: uuidv7(), title: codeInfo.get(root)!.title, isrc: null, codes: [], fromAppendixOnly: false });
      tracksByCode.set(root, t);
      if (!t.codes.includes(r.isrc)) t.codes.push(r.isrc);
    }
    (trackArtists.get(t.id) ?? trackArtists.set(t.id, new Set()).get(t.id)!).add(a.id);
    const existing = parts.get(`${t.id}|${a.id}`);
    if (existing) {
      const same = decEquals(existing.split?.share, r.share) && decEquals(existing.split?.rate, r.labelRate);
      if (same) summary.duplicateSplitRowsMerged++;
      else dupConflicts.push({ trackId: t.id, artistId: a.id, a: existing.split, b: { share: r.share, rate: r.labelRate } });
      continue;
    }
    const id = uuidv7();
    parts.set(`${t.id}|${a.id}`, {
      id, trackId: t.id, artistId: a.id, split: { share: r.share, rate: r.labelRate }, contractShareBy: null,
      row: { id, track_id: t.id, artist_id: a.id, share_authors: r.share ?? '0', share_related: r.share ?? '0', label_rate: r.labelRate, notes: null },
    });
  }

  const isActive = (p: PartPlan): boolean => {
    const s = parseDec(p.row.share_authors) ?? 0n;
    const s2 = parseDec(p.row.share_related) ?? 0n;
    const rt = parseDec(p.row.label_rate ?? '0') ?? 0n;
    return (s > 0n || s2 > 0n) && rt > 0n;
  };
  /** Явное «участник без выплат» (ставка лейбла 0): договорную долю сюда не пишем. */
  const explicitNoPay = (p: PartPlan): boolean => p.split !== null && parseDec(p.split.rate ?? '') === 0n;
  const tracksOfArtist = (artistId: string): string[] => [...trackArtists.entries()].filter(([, set]) => set.has(artistId)).map(([id]) => id);

  // -------------------------------------------------------------- договоры
  const templateIds = new Map<string, string>();
  const contracts = new Map<string, ContractPlan>();
  const rowsByContract = new Map<string, AppendixRow[]>();
  for (const r of appendixRows) (rowsByContract.get(r.contractNo) ?? rowsByContract.set(r.contractNo, []).get(r.contractNo)!).push(r);

  for (const p of people) {
    if (p.noContract || !p.contractNo) continue;
    if (contracts.has(p.contractNo)) {
      warnings.push(`Номер договора ${p.contractNo} встречается дважды, вторая строка пропущена.`);
      continue;
    }
    const cpId = cps.get(cpKeyOf(p))!.id;
    const rows = rowsByContract.get(p.contractNo) ?? [];
    const froms = rows.map((r) => r.termFrom).filter((x): x is string => !!x).sort();
    const tos = rows.map((r) => r.termTo).filter((x): x is string => !!x).sort();
    let date = p.contractDate;
    const noteParts = [p.fileName ? `Файл: ${p.fileName}` : ''];
    if (!date && froms[0]) {
      date = froms[0];
      noteParts.push('Дата договора взята из срока в приложении, проверить по PDF.');
      warnings.push(`Договор ${p.contractNo}: дата не указана, взята из приложения (${date}).`);
    } else if (p.contractDateSource === 'file') {
      noteParts.push('Дата договора взята из имени файла.');
    }
    if (!date) warnings.push(`Договор ${p.contractNo}: дату определить не удалось.`);
    if (p.template && !templateIds.has(p.template)) {
      const id = uuidv7();
      templateIds.set(p.template, id);
      ops.push({ table: 'contract_template', row: { id, code: p.template, name: `Шаблон ${p.template}`, version: 1, active: 1 } });
    }
    const id = uuidv7();
    const row: Row = {
      id, counterparty_id: cpId, template_id: p.template ? templateIds.get(p.template)! : null, number: p.contractNo, date,
      kind: p.template === 'C' ? 'alienation' : 'license', rate_default: p.rate, threshold_rub: p.thresholdKop, threshold_rule: null,
      recoup_amount: null, autoprolong: null, end_date: tos[tos.length - 1] ?? null, status_clause_50: 0, pdf_file: null, has_pdf: 0,
      notes: noteParts.filter(Boolean).join(' '),
    };
    contracts.set(p.contractNo, { id, rec: p, cpId, row, appendixId: uuidv7(), aliasIds: contractAliasIds.get(p.contractNo) ?? [] });
  }
  summary.contracts = contracts.size;

  // ------------------------------------------- приложения, привязка треков
  const knownNames = new Set(artists.keys());
  const performersOf = (raw: string): string[] | null => {
    if (!raw) return null;
    const paren = [...raw.matchAll(/\(([^)]+)\)/g)].map((m) => cleanText(m[1]));
    if (paren.length) return paren;
    if (raw.includes(',')) return raw.split(',').map(cleanText).filter(Boolean);
    const tok = raw.split(/\s+/).filter(Boolean);
    if (tok.length === 1) return [raw];
    const out: string[] = [];
    let i = 0;
    while (i < tok.length) {
      let hit = false;
      for (let k = Math.min(4, tok.length - i); k >= 1; k--) {
        const cand = tok.slice(i, i + k).join(' ');
        if (knownNames.has(variantTargets.get(normKey(cand)) ?? normKey(cand))) {
          out.push(cand);
          i += k;
          hit = true;
          break;
        }
      }
      if (!hit) return null;
    }
    return out;
  };

  const newTracksByNorm = new Map<string, TrackPlan>();
  const resolveTracks = (row: AppendixRow, folderIds: Set<string>): string[] => {
    const n = normKey(row.title);
    const own = [...folderIds].flatMap(tracksOfArtist).filter((id) => trackTitleNorm.get(id) === n);
    const uniqOwn = [...new Set(own)];
    if (uniqOwn.length) {
      const active = uniqOwn.filter((id) => [...folderIds].some((aid) => { const p = splitBy(id, aid); return p && !explicitNoPay(p); }));
      return active.length ? active : uniqOwn;
    }
    const global = normTitleToTracks.get(n);
    if (global && global.size === 1) return [...global];
    if (n.length >= 4) {
      const pref = [...new Set([...folderIds].flatMap(tracksOfArtist))].filter((id) => {
        const tn = trackTitleNorm.get(id)!;
        return tn.length >= 4 && (tn.startsWith(n) || n.startsWith(tn));
      });
      if (pref.length) return pref;
    }
    let t = newTracksByNorm.get(n);
    if (!t) {
      t = addTrack({ id: uuidv7(), title: row.title, isrc: null, codes: [], fromAppendixOnly: true });
      newTracksByNorm.set(n, t);
      summary.unmatchedAppendixTracks.push(`${row.folder}: «${row.title}»`);
    }
    return [t.id];
  };

  const itemOps: PlanOp[] = [];
  const appendixOps: PlanOp[] = [];
  const itemsSeen = new Set<string>();
  const createdPartIds: string[] = [];
  const ambiguousRaw: Array<{ text: string; partIds: string[] }> = [];

  for (const c of contracts.values()) {
    appendixOps.push({ table: 'appendix', row: { id: c.appendixId, contract_id: c.id, number: 1, date: c.row.date, status: 'signed' } });
    summary.appendices++;
    const rows = rowsByContract.get(c.rec.contractNo!) ?? [];
    const folderIds = folderArtistIds.get(c.rec.folder) ?? new Set<string>();
    const aliasSet = new Set(c.aliasIds);

    for (const row of rows) {
      const trackIds = resolveTracks(row, folderIds);
      const perf = performersOf(row.performersRaw);
      for (const trackId of trackIds) {
        const lp = c.aliasIds.map((aid) => splitBy(trackId, aid)).filter((x): x is PartPlan => !!x);

        // какая доля из договора относится к нашему лицензиару
        let authors: string | null = null;
        let related: string | null = null;
        let ambiguous = false;
        if (row.mode === 'rights') {
          authors = row.authors;
          related = row.related;
        } else if (row.shares.length === 1) {
          authors = related = row.shares[0]!;
        } else if (row.shares.length > 1) {
          const idx = perf && perf.length === row.shares.length ? perf.findIndex((nm) => aliasSet.has(artists.get(variantTargets.get(normKey(nm)) ?? normKey(nm))?.id ?? '')) : -1;
          if (idx >= 0) authors = related = row.shares[idx]!;
          else ambiguous = true;
        }
        if (ambiguous && c.aliasIds.length) {
          ambiguousRaw.push({ text: `${c.rec.contractNo}: «${row.title}» (${row.performersRaw || 'без исполнителей'} — ${row.sharesRaw})`, partIds: lp.map((x) => x.id) });
        }

        let targets = lp;
        if (targets.length === 0 && c.aliasIds.length === 1 && (authors !== null || related !== null)) {
          // доля есть в договоре, а в SPLIT строки нет: создаём участие из договора
          const id = uuidv7();
          const rt = c.row.rate_default as string | null;
          const np: PartPlan = {
            id, trackId, artistId: c.aliasIds[0]!, split: null, contractShareBy: null,
            row: { id, track_id: trackId, artist_id: c.aliasIds[0]!, share_authors: authors ?? related ?? '0', share_related: related ?? authors ?? '0', label_rate: rt, notes: 'Создано из договора (в SPLIT строки нет).' },
          };
          parts.set(`${trackId}|${np.artistId}`, np);
          (trackArtists.get(trackId) ?? trackArtists.set(trackId, new Set()).get(trackId)!).add(np.artistId);
          createdPartIds.push(id);
          summary.participationsFromContract++;
          targets = [np];
        }

        if (c.aliasIds.length) {
          const pick = targets.length > 1 ? targets.filter((p) => !explicitNoPay(p)) : targets;
          const tgt = pick.length === 1 ? pick[0]! : null;
          if (targets.length > 1 && !tgt && (authors !== null || related !== null)) {
            ambiguousRaw.push({ text: `${c.rec.contractNo}: «${row.title}» (несколько участников из одной папки)`, partIds: targets.map((x) => x.id) });
          }
          for (const p of targets) {
            p.row.contract_id = c.id;
            p.row.appendix_id = c.appendixId;
            if (row.termFrom) p.row.term_from = row.termFrom;
            if (row.termTo) p.row.term_to = row.termTo;
          }
          if (tgt && !explicitNoPay(tgt)) {
            const was = { a: tgt.row.share_authors as string, r: tgt.row.share_related as string };
            if (tgt.contractShareBy && tgt.contractShareBy !== c.rec.contractNo) {
              warnings.push(`Участие «${row.title}»: доля уже задана договором ${tgt.contractShareBy}, договор ${c.rec.contractNo} пропущен.`);
            } else if (tgt.contractShareBy === c.rec.contractNo && ((authors !== null && !decEquals(authors, tgt.row.share_authors)) || (related !== null && !decEquals(related, tgt.row.share_related)))) {
              warnings.push(`Договор ${c.rec.contractNo}, «${row.title}»: две строки приложения с разной долей, оставлена первая.`);
            } else {
              if (authors !== null) tgt.row.share_authors = authors;
              if (related !== null) tgt.row.share_related = related;
              if (authors !== null || related !== null) {
                if (tgt.contractShareBy === null) summary.contractSharesApplied++;
                tgt.contractShareBy = c.rec.contractNo;
                const differs = tgt.split !== null && (!decEquals(was.a, tgt.row.share_authors) || !decEquals(was.r, tgt.row.share_related));
                if (differs) {
                  summary.contractSharesDiffer++;
                  tgt.row.notes = `Доля по договору ${c.rec.contractNo}: авторские ${tgt.row.share_authors}, смежные ${tgt.row.share_related}; в SPLIT было ${was.a}. Приоритет у договора.`;
                }
              }
            }
          }
        }

        const key = `${c.id}|${trackId}`;
        if (itemsSeen.has(key)) continue;
        itemsSeen.add(key);
        const linkedPart = c.aliasIds.map((aid) => splitBy(trackId, aid)).find(Boolean) ?? null;
        itemOps.push({
          table: 'appendix_item',
          row: {
            appendix_id: c.appendixId, track_id: trackId, participation_id: linkedPart?.id ?? null, kind: 'works',
            payload_json: JSON.stringify({ title_raw: row.title, performers_raw: row.performersRaw, shares_raw: row.sharesRaw, term_raw: row.termRaw, mode: row.mode }),
          },
        });
        summary.appendixItems++;
      }
    }
  }

  // Неоднозначная доля считается нерешённой, только если ни одна другая строка приложения её не закрыла.
  const partsById = new Map([...parts.values()].map((p) => [p.id, p]));
  for (const a of ambiguousRaw) {
    if (a.partIds.length && a.partIds.every((id) => partsById.get(id)?.contractShareBy)) continue;
    summary.ambiguousContractShares.push(a.text);
  }
  summary.contractSharesAmbiguous = summary.ambiguousContractShares.length;

  // ------------------------------------------------------------- вывод строк
  const sortedCps = [...cps.values()];
  const sortedArtists = [...artists.values()];
  for (const cp of sortedCps) ops.push({ table: 'counterparty', row: { id: cp.id, ...cp.row } });
  for (const a of sortedArtists) {
    ops.push({ table: 'artist', row: { id: a.id, counterparty_id: a.cpId, name: a.name, notes: null } });
    ops.push({ table: 'artist_name_variant', row: { artist_id: a.id, variant_norm: a.norm } });
  }
  for (const v of NAME_VARIANTS) {
    const target = artists.get(normKey(v.artist));
    if (target && normKey(v.variant) !== target.norm) ops.push({ table: 'artist_name_variant', row: { artist_id: target.id, variant_norm: normKey(v.variant) } });
  }
  for (const t of tracks.values()) {
    ops.push({ table: 'track', row: { id: t.id, title: t.title, isrc: t.isrc, notes: t.fromAppendixOnly ? 'Есть в приложении договора, в SPLIT пары нет.' : null } });
    if (t.isrc) {
      ops.push({ table: 'track_identifier', row: { track_id: t.id, kind: 'isrc', value_norm: t.isrc } });
      summary.trackIdentifiers++;
    }
    for (const c of t.codes) {
      ops.push({ table: 'track_identifier', row: { track_id: t.id, kind: 'distributor_code', value_norm: c } });
      summary.trackIdentifiers++;
    }
  }
  for (const c of contracts.values()) ops.push({ table: 'contract', row: c.row });
  ops.push(...appendixOps);
  for (const p of parts.values()) ops.push({ table: 'participation', row: p.row });
  ops.push(...itemOps);

  summary.artists = artists.size;
  summary.artistsWithPerson = sortedArtists.filter((a) => a.cpId).length;
  summary.artistsWithoutPerson = artists.size - summary.artistsWithPerson;
  summary.tracks = tracks.size;
  summary.tracksWithIsrc = [...tracks.values()].filter((t) => t.isrc).length;
  summary.tracksWithCodesOnly = [...tracks.values()].filter((t) => !t.isrc && t.codes.length).length;
  summary.tracksFromAppendixOnly = [...tracks.values()].filter((t) => t.fromAppendixOnly).length;
  summary.participations = parts.size;

  // Возможные опечатки в псевдонимах: артист из SPLIT без человека, отличающийся на 1 символ от артиста с человеком.
  const lev1 = (a: string, b: string): boolean => {
    if (Math.abs(a.length - b.length) > 1 || a === b) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
    return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
  };
  for (const a of sortedArtists.filter((x) => !x.cpId && x.norm.length >= 5)) {
    for (const b of sortedArtists.filter((x) => x.cpId)) {
      if (lev1(a.norm, b.norm)) summary.possibleNameTypos.push(`«${a.name}» (из SPLIT) похож на «${b.name}» (есть договор)`);
    }
  }

  // ---------------------------------------------------------------- проблемы
  const issueOps: PlanOp[] = [];
  const addIssue = (kind: string, entityType: string | null, entityId: string | null, details: Row, status: 'open' | 'resolved' = 'open', resolution: Row | null = null): void => {
    issueOps.push({
      table: 'issue',
      row: { kind, entity_type: entityType, entity_id: entityId, details_json: JSON.stringify({ source: 'starter', ...details }), status, resolution_json: resolution ? JSON.stringify(resolution) : null },
    });
    summary.issuesByKind[kind] = (summary.issuesByKind[kind] ?? 0) + 1;
    if (status === 'resolved') summary.issuesAutoResolved++;
  };
  const cpRowById = new Map(sortedCps.map((c) => [c.id, c.row]));
  const trackByIsrcOrCode = (code: string): TrackPlan | undefined => tracksByIsrc.get(code) ?? [...tracks.values()].find((t) => t.codes.includes(code));
  const fieldOf: Record<string, string> = { 'дата рождения': 'birth_date', 'паспорт': 'passport_number', 'адрес': 'addr_raw', 'ИНН': 'inn', 'р/с': 'bank_account', 'БИК': 'bank_bik', 'email': 'email' };

  for (const pr of problems) {
    const skipsContract = ['gassan', 'lamedy'].includes(pr.who.toLowerCase());
    const base = { who: pr.who, subject: pr.subject, details: pr.details, original_kind: pr.kind };
    switch (pr.kind) {
      case 'нет данных': {
        const cpId = cpByContractNo.get(pr.subject) ?? cpByFolder.get(pr.who.toLowerCase() + '|' + pr.subject) ?? artists.get(normKey(pr.who))?.cpId ?? null;
        const f = fieldOf[pr.details];
        const filled = cpId && f ? !!cpRowById.get(cpId)?.[f] : false;
        addIssue('missing_pii', 'counterparty', cpId, { ...base, field: f ?? pr.details }, filled ? 'resolved' : 'open', filled ? { auto: 'поле заполнено при загрузке' } : null);
        break;
      }
      case 'статус не определён': {
        const cpId = cpByContractNo.get(pr.subject) ?? cpByFolder.get(pr.who.toLowerCase() + '|' + pr.subject) ?? artists.get(normKey(pr.who))?.cpId ?? null;
        const st = cpId ? cpRowById.get(cpId)?.status : 'unknown';
        const filled = !!cpId && st !== 'unknown';
        addIssue('missing_pii', 'counterparty', cpId, { ...base, field: 'status' }, filled ? 'resolved' : 'open', filled ? { auto: 'статус определён при загрузке' } : null);
        break;
      }
      case 'нет ставки в договоре': {
        if (skipsContract) break; // договор Gassan/Lamedy не привязываем (ТЗ §10)
        const c = contracts.get(pr.subject);
        const filled = !!c?.row.rate_default;
        addIssue('missing_rate', 'contract', c?.id ?? null, base, filled ? 'resolved' : 'open', filled ? { auto: 'ставка заполнена при загрузке' } : null);
        break;
      }
      case 'один ISRC у разных названий': {
        const t = trackByIsrcOrCode(pr.subject);
        addIssue('isrc_title_conflict', 'track', t?.id ?? null, base);
        break;
      }
      case 'лишние пробелы в названии': {
        const a = artists.get(normKey(pr.who));
        const t = [...tracks.values()].find((x) => trackTitleNorm.get(x.id) === normKey(pr.subject) && trackArtists.get(x.id)?.has(a?.id ?? ''));
        addIssue('whitespace', t ? 'track' : 'artist', t?.id ?? a?.id ?? null, base, 'resolved', { auto: 'пробелы убраны при загрузке' });
        break;
      }
      case 'артист из SPLIT без папки договора': {
        const a = artists.get(variantTargets.get(normKey(pr.who)) ?? normKey(pr.who));
        addIssue('no_contract', 'artist', a?.id ?? null, base, a?.cpId ? 'resolved' : 'open', a?.cpId ? { auto: 'артист связан с человеком' } : null);
        break;
      }
      case 'сумма долей ≠100%':
      case 'трек из SPLIT без приложения':
        break; // пересчитываем ниже по актуальным данным (после приоритета долей из договора)
      default:
        warnings.push(`Неизвестный вид проблемы в листе «Проблемы»: «${pr.kind}».`);
    }
  }

  // share_sum: сумма долей по треку (авторские и смежные отдельно), допуск 0.0001
  const partsByTrack = new Map<string, PartPlan[]>();
  for (const p of parts.values()) (partsByTrack.get(p.trackId) ?? partsByTrack.set(p.trackId, []).get(p.trackId)!).push(p);
  for (const [trackId, ps] of partsByTrack) {
    const sa = sumDec(ps.map((p) => p.row.share_authors));
    const sr = sumDec(ps.map((p) => p.row.share_related));
    if (!isWholeShare(sa) || !isWholeShare(sr)) {
      addIssue('share_sum', 'track', trackId, {
        title: tracks.get(trackId)!.title, authors: formatDec(sa), related: formatDec(sr),
        participants: ps.map((p) => ({ artist: [...artists.values()].find((a) => a.id === p.artistId)?.name, authors: p.row.share_authors, related: p.row.share_related })),
      });
    }
  }
  for (const c of dupConflicts) {
    addIssue('duplicate_participant', 'track', c.trackId, { artist: [...artists.values()].find((a) => a.id === c.artistId)?.name, first: c.a, second: c.b });
  }
  // no_appendix: участник с выплатами, у артиста есть человек и договор, а приложения нет
  const cpsWithContract = new Set([...contracts.values()].map((c) => c.cpId));
  for (const p of parts.values()) {
    const a = [...artists.values()].find((x) => x.id === p.artistId)!;
    if (a.cpId && cpsWithContract.has(a.cpId) && !p.row.appendix_id && isActive(p)) {
      addIssue('no_appendix', 'participation', p.id, { artist: a.name, track: tracks.get(p.trackId)!.title });
    }
  }
  ops.push(...issueOps);
  return { ops, summary };
}
