import { useCallback, useEffect, useRef, useState } from 'react';
import type { Facets, LineHistory, PersonListItem, LineFilter, LinePage, LineRow, LineSort, StreamKind, UiField } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { useNav } from '../nav.tsx';
import { SearchSelect } from '../SearchSelect.tsx';
import { RIGHTS_SHORT, STREAM_SHORT, fmtInt, fmtKop, kopToInput, quarterLabel } from '../util.ts';
import { BulkDialog, HistoryDialog } from './LinesBulk.tsx';

const PAGE = 200;
type FacetKey = keyof Facets;
const FACET_TITLES: Array<[FacetKey, string]> = [
  ['distributor', 'Дистрибьютор'], ['rights', 'Права'], ['platform', 'Площадка'], ['usage', 'Вид использования'], ['model', 'Способ'],
  ['country', 'Страна'], ['month', 'Месяц'], ['streamKind', 'Тип стрима'],
];
const facetLabel = (k: FacetKey, v: string): string => (v === '' ? '(пусто)' : k === 'streamKind' ? STREAM_SHORT[v] ?? v : k === 'rights' ? RIGHTS_SHORT[v] ?? v : v);

function MultiFilter({ title, options, value, label, onChange }: { title: string; options: string[]; value: string[]; label: (v: string) => string; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const shown = options.filter((o) => label(o).toLowerCase().includes(q.toLowerCase()));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className={value.length > 0 ? 'primary' : ''} onClick={() => setOpen(!open)}>{title}{value.length > 0 ? ` (${value.length})` : ''} ▾</button>
      {open && (
        <div className="card" style={{ position: 'absolute', zIndex: 5, top: '110%', left: 0, minWidth: 240, maxHeight: 320, overflow: 'auto', padding: 8 }}>
          {options.length > 8 && <input autoFocus placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />}
          <div className="row" style={{ marginBottom: 4 }}><button className="link" onClick={() => onChange([])}>сбросить</button></div>
          {shown.map((o) => (
            <label key={o} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0', cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={value.includes(o)} onChange={(e) => onChange(e.target.checked ? [...value, o] : value.filter((x) => x !== o))} />
              <span>{label(o)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function EditCell({ text, initial, editable, numeric, options, orig, changed, onCommit }: {
  text: string; initial: string; editable: boolean; numeric?: boolean; options?: Array<[string, string]>; orig?: string | null; changed: boolean; onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const done = (commit: boolean) => { setEditing(false); if (commit && v !== initial) onCommit(v); };
  return (
    <td className={numeric ? 'num' : undefined} style={{ textAlign: numeric ? 'right' : undefined, background: changed ? '#e0a45822' : undefined, cursor: editable ? 'text' : undefined }}
      onDoubleClick={() => { if (editable) { setV(initial); setEditing(true); } }}>
      {editing ? (
        options ? (
          <select autoFocus value={v} onChange={(e) => { setV(e.target.value); setEditing(false); if (e.target.value !== initial) onCommit(e.target.value); }} onBlur={() => setEditing(false)}>
            {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        ) : (
          <input autoFocus value={v} style={{ minWidth: 80, textAlign: numeric ? 'right' : undefined }} onChange={(e) => setV(e.target.value)} onBlur={() => done(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); }} />
        )
      ) : (
        <>{text}{changed && orig != null && <div className="dim" style={{ fontSize: 11 }}>было {orig}</div>}</>
      )}
    </td>
  );
}

const COLS: Array<{ key: LineSort['key'] | null; title: string; num?: boolean }> = [
  { key: 'distributor', title: 'Дистрибьютор' }, { key: null, title: 'Права' }, { key: 'artist', title: 'Артист' }, { key: 'title', title: 'Трек' }, { key: null, title: 'Получатель' }, { key: null, title: 'ISRC / код' },
  { key: 'platform', title: 'Площадка' }, { key: 'usage', title: 'Вид использования' }, { key: null, title: 'Способ' }, { key: 'country', title: 'Страна' }, { key: 'month', title: 'Месяц' },
  { key: 'qty', title: 'Тираж', num: true }, { key: 'royalty', title: 'Роялти', num: true }, { key: 'rate', title: 'Ставка за прослуш.', num: true }, { key: 'streamKind', title: 'Тип стрима' }, { key: null, title: '' },
];
const EMPTY: LineFilter = {};

export function Lines({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [people, setPeople] = useState<PersonListItem[]>([]);
  useEffect(() => { void call('people:list', {}).then(setPeople); }, []);
  const [quarters, setQuarters] = useState<string[]>([]);
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [f, setF] = useState<LineFilter>(EMPTY);
  const [sort, setSort] = useState<LineSort>({ key: 'royalty', dir: 'desc' });
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LinePage | null>(null);
  const [err, setErr] = useState('');
  const [bulk, setBulk] = useState(false);
  const [history, setHistory] = useState(false);
  const [split, setSplit] = useState<LineRow | null>(null);
  const [hist, setHist] = useState<LineRow | null>(null);

  const filter: LineFilter = { ...f, quarter };
  const key = JSON.stringify([filter, sort, offset]);
  const load = useCallback(() => {
    void call('lines:query', { filter, sort, offset, limit: PAGE }).then(setPage).catch((e: Error) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(load, [load]);
  useEffect(() => {
    void call('reports:panel', {}).then((p) => { setQuarters(p.quarters); setQuarter((q) => q ?? p.quarter); });
  }, []);
  useEffect(() => { if (quarter) void call('lines:facets', { quarter }).then(setFacets); }, [quarter]);

  const setFilter = (patch: Partial<LineFilter>) => { setF((x) => ({ ...x, ...patch })); setOffset(0); };
  const after = () => { load(); onChanged(); };
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); after(); } catch (e) { setErr((e as Error).message); } };
  const edit = (r: LineRow, field: UiField, value: string) => run(() => call('lines:edit', { lineId: r.lineId, field, value, splitId: r.splitId }));
  const toggleSort = (k: LineSort['key']) => { setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'qty' || k === 'royalty' || k === 'rate' ? 'desc' : 'asc' })); setOffset(0); };
  const active = Object.entries(f).some(([, v]) => (Array.isArray(v) ? v.length > 0 : !!v));

  const delta = page ? page.totals.royaltyKop - page.totals.origRoyaltyKop : 0;
  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Строки</h1>
        <select style={{ maxWidth: 170 }} value={quarter ?? ''} onChange={(e) => { setQuarter(e.target.value); setOffset(0); }}>
          {quarters.map((q) => <option key={q} value={q}>{quarterLabel(q)}</option>)}
        </select>
        <input placeholder="Поиск: артист, трек, ISRC, код, UPC" value={f.q ?? ''} onChange={(e) => setFilter({ q: e.target.value })} />
        <div className="grow" />
        {page && page.personAccruedKop != null && page.personOrigAccruedKop != null && (() => {
          const was = page.personOrigAccruedKop, now = page.personAccruedKop, d = now - was;
          return (
            <div className="row" style={{ gap: 10 }} title="Начислено этому человеку по расчёту выплат за квартал (до переноса и порога)">
              <div className="card" style={{ padding: '6px 14px' }}><div className="l">Было (по отчёту дистрибьютора)</div><div className="n" style={{ fontSize: 18 }}>{fmtKop(was)}</div></div>
              <div className="card" style={{ padding: '6px 14px' }}><div className="l">Стало{d !== 0 && <b style={{ color: d < 0 ? 'var(--bad)' : 'var(--accent)', marginLeft: 6 }}>{d > 0 ? '+' : '−'}{fmtKop(Math.abs(d))}</b>}</div><div className="n" style={{ fontSize: 18 }}>{fmtKop(now)}</div></div>
            </div>
          );
        })()}
        <button onClick={() => setHistory(true)}>История правок</button>
        <button className="primary" disabled={!page || page.total === 0} onClick={() => setBulk(true)}>Массовая правка…</button>
      </div>
      <div className="bar" style={{ flexWrap: 'wrap' }}>
        {facets && FACET_TITLES.map(([k, title]) => (
          <MultiFilter key={k} title={title} options={facets[k]} value={(f[k] as string[] | undefined) ?? []} label={(v) => facetLabel(k, v)} onChange={(v) => setFilter({ [k]: v } as Partial<LineFilter>)} />
        ))}
        <SearchSelect width={250} options={[{ value: '__none', label: '⚠ Без получателя (нет человека или трека)' }, ...people.map((p) => ({ value: p.id, label: p.display, hint: p.artists.join(', ') }))]} value={f.person ?? ''} empty="Все получатели" onChange={(v) => setFilter({ person: v || undefined })} />
        <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f.edited} onChange={(e) => setFilter({ edited: e.target.checked })} />Изменённые</label>
        <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f.unmatched} onChange={(e) => setFilter({ unmatched: e.target.checked })} />Без трека</label>
        {active && <button className="link" onClick={() => { setF(EMPTY); setOffset(0); }}>сбросить всё</button>}
      </div>
      {err && <div className="err">{err}</div>}
      {page && (
        <div className="dim" style={{ marginBottom: 8 }}>
          Строк: <b>{fmtInt(page.total)}</b> · тираж {fmtInt(page.totals.qty)} · роялти <b>{fmtKop(page.totals.royaltyKop)}</b>
          {page.totals.edited > 0 && <> · изменено строк: {fmtInt(page.totals.edited)}{delta !== 0 && <>, разница {delta > 0 ? '+' : ''}{fmtKop(delta)}</>}</>}
          {page.personAccruedKop != null && <> · <button className="link" onClick={() => nav.go('payouts', {})}>к выплатам →</button></>}
          {' · '}двойной щелчок по ячейке — правка
        </div>
      )}
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 270px)' }}>
        <table>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--bg)' }}>
            <tr>{COLS.map((c, i) => (
              <th key={i} style={{ cursor: c.key ? 'pointer' : undefined, textAlign: c.num ? 'right' : undefined, whiteSpace: 'nowrap' }} onClick={() => c.key && toggleSort(c.key)}>
                {c.title}{c.key && sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>))}</tr>
          </thead>
          <tbody>{page?.rows.map((r) => {
            const moved = r.splitId !== null;
            // у строки с переносом: перенесённая часть правится целиком, основная — только тираж (если перенос один)
            const qtyOk = !r.hasSplit || moved || r.splitCount === 1;
            const lock = r.hasSplit && !moved;
            const ch = (k: string) => r.changed.includes(k);
            return (
              <tr key={r.key} style={moved ? { background: '#7fb56b14' } : undefined} title={r.changed.length > 0 ? `Строка изменена${r.lastEditBy ? `: ${r.lastEditBy}` : ''}${r.lastEditAt ? `, ${new Date(r.lastEditAt).toLocaleString('ru-RU')}` : ''}. Исходные значения — в ячейках «было» и в истории (🕘)` : undefined}>
                <td>{r.distributor}</td><td className="dim">{RIGHTS_SHORT[r.rights]}</td><td>{r.artist}</td>
                <td>{r.title}{moved && <span className="badge ok" title="Перенесённая часть">перенос</span>}{!r.trackId && <button className="badge bad" title="Трек не найден в каталоге — привязать в «Проверить»" onClick={() => nav.go('issues', { issueKind: 'unmatched_track' })}>нет трека</button>}</td>
                <td>{(r.payees ?? []).map((p, i) => (
                  <div key={i} style={{ whiteSpace: 'nowrap' }}>
                    {p.personId ? <button className="link" style={{ padding: 0 }} title="Показать только строки этого человека" onClick={() => setFilter({ person: p.personId! })}>{p.name}</button> : <button className="badge bad" title={`У артиста «${p.artist}» нет человека — привязать`} onClick={() => nav.go('artists', { query: p.artist })}>{p.artist}: нет человека</button>}
                    {p.sharePct && <span className="dim"> · {p.sharePct}</span>}
                  </div>))}{(r.payees ?? []).length === 0 && <span className="dim">—</span>}</td>
                <td className="mono dim">{r.isrc ?? r.code}</td><td>{r.platform}</td>
                <EditCell text={r.usage ?? ''} initial={r.usage ?? ''} editable={!lock} changed={ch('usage_type')} orig={r.origUsage} onCommit={(v) => edit(r, 'usage_type', v)} />
                <td className="dim">{r.model}</td><td>{r.country}</td><td className="dim">{r.month}</td>
                <EditCell numeric text={fmtInt(r.qty)} initial={String(r.qty)} editable={qtyOk} changed={ch('qty')} orig={fmtInt(r.origQty)} onCommit={(v) => edit(r, 'qty', v)} />
                <EditCell numeric text={fmtKop(r.royaltyKop)} initial={kopToInput(r.royaltyKop)} editable={!lock} changed={ch('royalty')} orig={fmtKop(r.origRoyaltyKop)} onCommit={(v) => edit(r, 'royalty', v)} />
                <EditCell numeric text={r.rate ?? '—'} initial={r.rate ?? ''} editable={!lock && r.qty > 0} changed={ch('rate')} orig={r.origRate} onCommit={(v) => edit(r, 'rate', v)} />
                <EditCell text={STREAM_SHORT[r.streamKind] ?? r.streamKind} initial={r.streamKind} editable={!lock} changed={ch('stream_kind')} orig={STREAM_SHORT[r.origStreamKind]}
                  options={Object.entries(STREAM_SHORT)} onCommit={(v) => edit(r, 'stream_kind', v)} />
                <td style={{ whiteSpace: 'nowrap' }}>
                  {!moved && !r.hasSplit && r.qty > 1 && <button className="link" title="Перенести часть прослушиваний в другой тип" onClick={() => setSplit(r)}>⇄</button>}
                  {r.changed.length > 0 && <button className="link" title="Что было исходно, кто и когда менял" onClick={() => setHist(r)}>🕘</button>}
                  {!moved && r.changed.length > 0 && <button className="link" title="Вернуть исходные значения" onClick={() => run(() => call('lines:revert', { lineId: r.lineId }))}>↩</button>}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {page && page.total > PAGE && (
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Назад</button>
          <span className="dim">{fmtInt(offset + 1)}–{fmtInt(Math.min(offset + PAGE, page.total))} из {fmtInt(page.total)}</span>
          <button disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>Дальше →</button>
        </div>
      )}
      {page && page.total === 0 && <div className="drop" style={{ marginTop: 12 }}>{quarters.length === 0 ? 'Сначала загрузите отчёты во вкладке «Отчёты».' : 'Под фильтры ничего не попало.'}</div>}
      {bulk && page && <BulkDialog filter={filter} total={page.total} onClose={(changed) => { setBulk(false); if (changed) after(); }} />}
      {history && <HistoryDialog onClose={(changed) => { setHistory(false); if (changed) after(); }} />}
      {hist && <HistoryOfLine row={hist} onClose={() => setHist(null)} />}
      {split && <SplitDialog row={split} onClose={() => setSplit(null)} onDone={() => { setSplit(null); after(); }} />}
    </>
  );
}

function SplitDialog({ row, onClose, onDone }: { row: LineRow; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState('');
  const [kind, setKind] = useState<StreamKind>(row.streamKind === 'paid' ? 'ad' : 'paid');
  const [rate, setRate] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    try {
      const n = Number(qty.replace(/[\s ]/g, ''));
      await call('lines:split', { lineId: row.lineId, qtyMoved: n, toKind: kind, rate: rate.trim() || null });
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 520 }}>
      <h2>Перенести прослушивания</h2>
      <div className="dim">{row.title} · {row.platform} · сейчас {fmtInt(row.qty)} прослушиваний, {fmtKop(row.royaltyKop)}</div>
      <div className="grid2" style={{ marginTop: 10 }}>
        <label className="f">Сколько перенести<input autoFocus value={qty} onChange={(e) => setQty(e.target.value)} placeholder={`до ${fmtInt(row.qty)}`} /></label>
        <label className="f">В какой тип<select value={kind} onChange={(e) => setKind(e.target.value as StreamKind)}>{Object.entries(STREAM_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f">Ставка перенесённой части, ₽ за прослушивание<input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="пусто — как у исходной, 0 — бесплатные" /></label>
      </div>
      <p className="dim">Если ставку не указать, сумма строки не меняется. Если указать (в том числе 0), перенесённая часть считается по ней, остаток — по прежней ставке, и общая сумма строки уменьшится: эти деньги дистрибьютор не платил.</p>
      {err && <div className="err">{err}</div>}
      <div className="row end"><button onClick={onClose}>Отмена</button><button className="primary" onClick={go}>Перенести</button></div>
    </div></div>
  );
}


function HistoryOfLine({ row, onClose }: { row: LineRow; onClose: () => void }) {
  const [h, setH] = useState<LineHistory | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { void call('lines:history', { lineId: row.lineId }).then(setH).catch((e: Error) => setErr(e.message)); }, [row.lineId]);
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 720 }}>
      <h2>История строки</h2>
      {err && <div className="err">{err}</div>}
      {h && (
        <>
          <div className="card">
            <b>Как пришло от дистрибьютора (не меняется никогда)</b>
            <div>{h.original.title} · {h.original.platform} · {h.original.usage}</div>
            <div>Тираж {fmtInt(h.original.qty)} · роялти <b>{fmtKop(h.original.royaltyKop)}</b> · ставка {h.original.rate ?? '—'} ₽ · {STREAM_SHORT[h.original.streamKind]}</div>
          </div>
          <h3>Правки по порядку</h3>
          {h.steps.length === 0 && <div className="dim">Правок нет.</div>}
          <table><tbody>{h.steps.map((s) => (
            <tr key={s.id} style={s.active ? undefined : { opacity: 0.5, textDecoration: 'line-through' }}>
              <td>{new Date(s.at).toLocaleString('ru-RU')}</td><td>{s.by ?? '—'}</td><td>{s.what}</td><td className="mono">{s.value}</td>
              <td className="dim">{s.batchId ? 'массовая правка' : ''}{s.active ? '' : ' · отменена'}</td>
            </tr>))}</tbody></table>
        </>
      )}
      <div className="row end"><button onClick={onClose}>Закрыть</button></div>
    </div></div>
  );
}
