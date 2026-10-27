import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppendixDraft, AppendixListItem, Block, ContractDetail, ContractEdit, ContractListItem, ContractPreview, DraftTrack, FieldDef, PBlock, PersonListItem, Seg, TrackHit } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { useNav } from '../nav.tsx';
import { norm, useSort } from '../sort.tsx';

type TrackRowT = DraftTrack['row'];
const GROUPS: Array<[FieldDef['group'], string]> = [['money', 'Суммы и ставки'], ['reports', 'Отчёты и выплаты'], ['notice', 'Уведомления и сроки'], ['other', 'Прочее']];
const KIND: Record<string, string> = { ip: 'ИП', sz: 'самозанятый' };
const fmtDate = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso ?? '');

export function Contracts({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [list, setList] = useState<ContractListItem[] | null>(null);
  const [missing, setMissing] = useState<Array<{ id: string; person: string; status: string }>>([]);
  const [editing, setEditing] = useState<ContractDetail | null>(null);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    void call('contracts:list').then(setList).catch((e: Error) => setErr(e.message));
    void call('contracts:missing').then(setMissing).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const open = (id: string) => { setErr(''); void call('contracts:get', { id }).then(setEditing).catch((e: Error) => setErr(e.message)); };
  const create = (counterpartyId: string) => { setPicking(false); setErr(''); void call('contracts:new', { counterpartyId }).then(setEditing).catch((e: Error) => setErr(e.message)); };
  useEffect(() => {
    const { contractFor, contractId } = nav.params;
    if (contractFor) create(contractFor);
    else if (contractId) open(contractId);
    if (contractFor || contractId) nav.clear();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = norm(q.trim());
  const shown = (list ?? []).filter((c) => !needle || norm(`${c.person} ${c.number} ${c.date ?? ''}`).includes(needle));
  const shownMissing = missing.filter((m) => !needle || norm(m.person).includes(needle));
  const { sorted, th } = useSort(shown, { number: (c) => c.number, date: (c) => c.date, person: (c) => c.person, kind: (c) => c.kind, threshold: (c) => c.thresholdRub, apps: (c) => c.appendices });
  if (editing) return <Editor detail={editing} onClose={() => { setEditing(null); load(); onChanged(); }} />;
  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Договоры</h1>
        <input style={{ maxWidth: 300 }} placeholder="Поиск по имени, фамилии, номеру…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="grow" />
        <button className="primary" onClick={() => setPicking(true)}>Новый договор</button>
      </div>
      {err && <div className="err">{err}</div>}
      {list && list.length === 0 && missing.length === 0 && <div className="drop">Договоров пока нет. «Новый договор» — выберите человека (ИП или самозанятый) и откроется текст договора с полями, которые можно править.</div>}
      {list && (list.length > 0 || missing.length > 0) && (
        <table>
          <thead><tr>{th('number', 'Номер')}{th('date', 'Дата')}{th('person', 'Человек')}{th('kind', 'Статус')}{th('threshold', 'Порог, ₽')}{th('apps', 'Приложений')}<th /></tr></thead>
          <tbody>
            {shownMissing.map((m) => {
              const ok = m.status === 'ip' || m.status === 'sz';
              return (
                <tr key={'m' + m.id} className="redrow">
                  <td colSpan={2}><span className="badge bad">договор не создан</span></td><td>{m.person}</td><td>{ok ? KIND[m.status] : '—'}</td><td colSpan={2} className="dim">{ok ? '' : 'сначала укажите статус ИП/самозанятый в карточке человека'}</td>
                  <td>{ok ? <button className="primary" onClick={() => create(m.id)}>Создать договор</button> : <button onClick={() => nav.go('people', { personId: m.id })}>Открыть человека</button>}</td>
                </tr>
              );
            })}
            {sorted.map((c) => (
              <tr key={c.id}>
                <td>{c.number}</td><td>{fmtDate(c.date)}</td><td>{c.person}</td><td>{c.kind ? KIND[c.kind] ?? c.kind : '—'}</td>
                <td>{c.thresholdRub === null ? '—' : c.thresholdRub.toLocaleString('ru-RU')}</td><td>{c.appendices}</td>
                <td><button onClick={() => open(c.id)}>Открыть</button></td>
              </tr>))}
          </tbody>
        </table>
      )}
      {picking && <PersonPicker onPick={create} onClose={() => setPicking(false)} />}
    </>
  );
}

function PersonPicker({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PersonListItem[]>([]);
  useEffect(() => { void call('people:list', { q }).then(setRows); }, [q]);
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 560 }}>
      <h2>С кем договор?</h2>
      <input autoFocus placeholder="Поиск по фамилии, имени, артисту" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
        {rows.map((r) => {
          const ok = r.status === 'ip' || r.status === 'sz';
          return (
            <div key={r.id} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="grow">{r.display} <span className="dim">{r.artists.join(', ')}</span></div>
              <span className={'badge' + (ok ? ' ok' : ' bad')}>{ok ? KIND[r.status] : 'нет статуса ИП/СЗ'}</span>
              <button disabled={!ok} onClick={() => onPick(r.id)}>Выбрать</button>
            </div>
          );
        })}
      </div>
      <p className="dim">Договоры заключаем только с ИП и самозанятыми. Если нужного статуса нет — поставьте его в карточке человека.</p>
      <div className="row end"><button onClick={onClose}>Отмена</button></div>
    </div></div>
  );
}

// ------------------------------------------------------------------ конструктор договора

function toEdit(d: ContractDetail): ContractEdit {
  return { id: d.id, counterpartyId: d.counterpartyId, number: d.number, date: d.date, fields: d.fields, options: d.options, okved: d.okved };
}

function Editor({ detail, onClose }: { detail: ContractDetail; onClose: () => void }) {
  const [edit, setEdit] = useState<ContractEdit>(toEdit(detail));
  const [kind] = useState(detail.kind);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [pv, setPv] = useState<ContractPreview | null>(null);
  const [tab, setTab] = useState<'contract' | 'appendix'>('contract');
  const [apps, setApps] = useState<AppendixListItem[]>(detail.appendices);
  const [openApp, setOpenApp] = useState<{ id: string | null } | null>(null);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(!detail.id);
  useEffect(() => { void call('contracts:fields').then(setFields); }, []);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const t = setTimeout(() => {
      void call('contracts:preview', edit).then((p) => { if (n === seq.current) { setPv(p); setErr(''); } }).catch((e: Error) => { if (n === seq.current) setErr(e.message); });
    }, 150);
    return () => clearTimeout(t);
  }, [edit]);
  const change = (patch: Partial<ContractEdit>) => { setEdit((e) => ({ ...e, ...patch })); setDirty(true); setInfo(''); };
  const setField = (key: string, value: number) => change({ fields: { ...edit.fields, [key]: value } });

  const save = async (): Promise<string | null> => {
    setBusy(true); setErr('');
    try {
      const id = await call('contracts:save', edit);
      setEdit((e) => ({ ...e, id })); setDirty(false); setInfo('Сохранено');
      const d = await call('contracts:get', { id }); setApps(d.appendices);
      return id;
    } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(false); }
  };
  const doExport = async (format: 'docx' | 'pdf', part: 'contract' | 'both') => {
    const id = edit.id && !dirty ? edit.id : await save();
    if (!id) return;
    setBusy(true); setErr(''); setInfo('');
    try {
      const r = await call('contracts:export', { req: { contractId: id, format, part }, edit: { ...edit, id }, draft: null });
      setInfo(`Готово: ${r.path}`); setOpened(r.path);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const [opened, setOpened] = useState('');

  const grouped = useMemo(() => GROUPS.map(([g, title]) => [title, fields.filter((f) => f.group === g)] as const), [fields]);
  const missing = pv?.missing ?? [];

  return (
    <>
      <div className="bar">
        <button onClick={onClose}>← К списку</button>
        <h1 style={{ margin: 0 }}>{detail.person}</h1>
        <span className="badge">{kind ? KIND[kind] : ''}</span>
        <div className="grow" />
        <button className={tab === 'contract' ? 'primary' : ''} onClick={() => setTab('contract')}>Договор</button>
        <button className={tab === 'appendix' ? 'primary' : ''} onClick={() => setTab('appendix')}>Приложения{apps.length ? ` (${apps.length})` : ''}</button>
      </div>
      {tab === 'contract' && (
        <>
          <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
            <label className="f" style={{ width: 200 }}>Номер договора<input value={edit.number} onChange={(e) => change({ number: e.target.value })} /></label>
            <label className="f" style={{ width: 160 }}>Дата<input type="date" value={edit.date} onChange={(e) => change({ date: e.target.value })} /></label>
            {kind === 'ip' && <label className="f" style={{ width: 120 }}>ОКВЭД<input value={edit.okved ?? ''} onChange={(e) => change({ okved: e.target.value || null })} /></label>}
            <div className="grow" />
            <button disabled={busy} onClick={() => void save()}>Сохранить</button>
            <button disabled={busy} className="primary" onClick={() => void doExport('docx', 'contract')}>Создать Word</button>
            <button disabled={busy} className="primary" onClick={() => void doExport('pdf', 'contract')}>Создать PDF</button>
          </div>
          {err && <div className="err" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}
          {info && <div className="okmsg">{info}{opened && info.startsWith('Готово') && <button className="link" onClick={() => void call('payouts:open', { path: opened })}>Открыть файл</button>}</div>}
          {pv && pv.errors.length > 0 && <div className="err">{pv.errors.map((x, i) => <div key={i}>{x}</div>)}</div>}
          {missing.length > 0 && <div className="warn">В карточке человека не хватает: {missing.join(', ')}. В договоре они пока «____». <span className="dim">Заполните в «Люди» и откройте договор заново.</span></div>}
          <div className="ctr">
            <aside className="ctr-side">
              <h3 style={{ marginTop: 0 }}>Условия</h3>
              {grouped.map(([title, fs]) => (
                <div key={title}>
                  <div className="dim" style={{ margin: '10px 0 4px' }}>{title}</div>
                  {fs.map((f) => (
                    <label key={f.key} className="f" style={{ marginBottom: 6 }}>{f.label}
                      <input type="number" min={f.min} max={f.max} value={edit.fields[f.key] ?? f.default} onChange={(e) => setField(f.key, e.target.value === '' ? f.default : Number(e.target.value))} />
                    </label>
                  ))}
                </div>
              ))}
              <div className="dim" style={{ margin: '10px 0 4px' }}>Пункты</div>
              <label className="chk"><input type="checkbox" checked={edit.options.cover} onChange={(e) => change({ options: { ...edit.options, cover: e.target.checked } })} /> П. 3.5: обложка от лейбла</label>
              <label className="chk"><input type="checkbox" checked={edit.options.release} onChange={(e) => change({ options: { ...edit.options, release: e.target.checked } })} /> П. 6.3: отказ, если релиза нет</label>
              <label className="f" style={{ marginTop: 6 }}>П. 4.13 при потере статуса
                <select value={edit.options.p413} onChange={(e) => change({ options: { ...edit.options, p413: e.target.value as 'rate' | 'nochange' } })}>
                  <option value="rate">ставка снижается</option><option value="nochange">ставка не меняется</option>
                </select>
              </label>
            </aside>
            <article className="ctr-doc">
              {!pv && <div className="dim">Собираю текст…</div>}
              {pv && pv.blocks.map((b, i) => <BlockView key={i} b={b} fields={fields} onField={setField} onToggle={(k, v) => change({ options: { ...edit.options, [k]: v } })} />)}
            </article>
          </div>
        </>
      )}
      {tab === 'appendix' && (
        edit.id
          ? openApp
            ? <AppendixEditor contractId={edit.id} appendixId={openApp.id} number={edit.number} onBack={(changed) => { setOpenApp(null); if (changed) void call('contracts:get', { id: edit.id! }).then((d) => setApps(d.appendices)); }} />
            : (
              <>
                <div className="bar"><div className="grow" /><button className="primary" onClick={() => setOpenApp({ id: null })}>Новое приложение</button></div>
                {apps.length === 0 && <div className="drop">Приложений нет. «Новое приложение» подтянет треки, у которых в «Треки → участие» выбран этот договор.</div>}
                {apps.length > 0 && <table><thead><tr><th>№</th><th>Дата</th><th>Строк в таблице треков</th><th /></tr></thead><tbody>{apps.map((a) => (
                  <tr key={a.id}><td>Приложение № {a.number}</td><td>{fmtDate(a.date)}</td><td>{a.items}</td><td><button onClick={() => setOpenApp({ id: a.id })}>Открыть</button></td></tr>))}</tbody></table>}
                {apps.length > 0 && (
                  <div className="row" style={{ marginTop: 12 }}>
                    <span className="dim">Договор вместе с приложением № 1:</span>
                    <button onClick={() => void (async () => { try { const r = await call('contracts:export', { req: { contractId: edit.id!, format: 'docx', part: 'both', appendixId: apps[0]!.id }, edit: null, draft: null }); setInfo(`Готово: ${r.path}`); setOpened(r.path); } catch (e) { setErr((e as Error).message); } })()}>Word</button>
                    <button onClick={() => void (async () => { try { const r = await call('contracts:export', { req: { contractId: edit.id!, format: 'pdf', part: 'both', appendixId: apps[0]!.id }, edit: null, draft: null }); setInfo(`Готово: ${r.path}`); setOpened(r.path); } catch (e) { setErr((e as Error).message); } })()}>PDF</button>
                    {info.startsWith('Готово') && <button className="link" onClick={() => void call('payouts:open', { path: opened })}>Открыть файл</button>}
                  </div>
                )}
                {err && <div className="err">{err}</div>}
              </>
            )
          : <div className="drop">Сначала сохраните договор — тогда можно добавлять приложения.</div>
      )}
    </>
  );
}

function BlockView({ b, fields, onField, onToggle }: { b: Block; fields: FieldDef[]; onField: (k: string, v: number) => void; onToggle: (k: 'cover' | 'release', v: boolean) => void }) {
  if (b.kind === 'table') {
    return (
      <table className="ctr-t"><tbody>{b.rows.map((r, i) => (
        <tr key={i}>{r.map((c, j) => <td key={j}>{c.map((p, k) => <ParaView key={k} p={p} fields={fields} onField={onField} onToggle={onToggle} />)}</td>)}</tr>))}</tbody></table>
    );
  }
  return <ParaView p={b} fields={fields} onField={onField} onToggle={onToggle} />;
}

function ParaView({ p, fields, onField, onToggle }: { p: PBlock; fields: FieldDef[]; onField: (k: string, v: number) => void; onToggle: (k: 'cover' | 'release', v: boolean) => void }) {
  if (!p.segs.length) return <div style={{ height: 8 }} />;
  return (
    <p className={`cp a-${p.align}${p.heading ? ' h' : ''}${p.included ? '' : ' off'}`}>
      {p.optional && (
        <label className="opt"><input type="checkbox" checked={p.included} onChange={(e) => onToggle(p.optional!, e.target.checked)} /> включить пункт</label>
      )}
      {p.segs.map((s, i) => <SegView key={i} s={s} def={s.k === 'f' ? fields.find((f) => f.key === s.key) : undefined} onField={onField} />)}
    </p>
  );
}

function SegView({ s, def, onField }: { s: Seg; def: FieldDef | undefined; onField: (k: string, v: number) => void }) {
  if (s.k === 't') return <span style={s.b ? { fontWeight: 700 } : undefined}>{s.v}</span>;
  if (s.k === 's') return <span className="sys" style={s.b ? { fontWeight: 700 } : undefined} title="Берётся из карточки человека и настроек договора">{s.v}</span>;
  return <FieldChip s={s} def={def} onField={onField} />;
}

function FieldChip({ s, def, onField }: { s: Extract<Seg, { k: 'f' }>; def: FieldDef | undefined; onField: (k: string, v: number) => void }) {
  const [on, setOn] = useState(false);
  const [v, setV] = useState(String(s.value));
  useEffect(() => { setV(String(s.value)); }, [s.value]);
  const commit = () => { setOn(false); const n = Number(v); if (v !== '' && Number.isFinite(n) && n !== s.value) onField(s.key, n); };
  if (on) {
    return <input className="chip-in" autoFocus type="number" min={def?.min} max={def?.max} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setV(String(s.value)); setOn(false); } }} />;
  }
  return <button className="chip" title={def?.label ?? ''} onClick={() => setOn(true)}>{s.text}</button>;
}

// ------------------------------------------------------------------ приложения

const TRACK_COLS: Array<[keyof TrackRowT, string, number]> = [
  ['title', 'Наименование Произведения', 170], ['performers', 'Исполнитель', 150], ['lyricists', 'Авторы текста', 150], ['composers', 'Авторы музыки', 150], ['makers', 'Изготовитель Фонограммы', 170],
  ['year', 'Год', 60], ['shareAuthors', 'Доля авт. права', 80], ['shareRelated', 'Доля смеж. права', 80], ['term', 'Срок', 190], ['explicit', 'Нецензурная лексика', 90], ['rate', 'Ставка', 70],
];
type VideoT = AppendixDraft['videos'][number];
type ImageT = AppendixDraft['images'][number];
const VIDEO_COLS: Array<[keyof VideoT, string, number]> = [['title', 'Наименование Видеоматериала', 170], ['workAuthors', 'Авторы Произведения', 140], ['performer', 'Исполнитель', 130], ['makers', 'Авторы/Изготовители', 150], ['share', 'Доля', 70], ['year', 'Год', 60], ['duration', 'Продолжительность', 100], ['term', 'Срок', 190], ['explicit', 'Нецензурная лексика', 90], ['rate', 'Ставка', 70]];
const IMAGE_COLS: Array<[keyof ImageT, string, number]> = [['workTitle', 'Наименование Произведения', 170], ['description', 'Описание объекта', 150], ['authors', 'Авторы объекта', 150], ['performer', 'Исполнитель', 140], ['share', 'Доля', 70], ['year', 'Год', 60], ['term', 'Срок', 190]];

function Grid<T extends object>({ rows, cols, onChange, onRemove }: { rows: T[]; cols: Array<[keyof T & string, string, number]>; onChange: (i: number, key: keyof T & string, v: string) => void; onRemove: (i: number) => void }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="ag">
        <thead><tr><th>№</th>{cols.map(([k, l, w]) => <th key={k} style={{ minWidth: w }}>{l}</th>)}<th /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}><td>{i + 1}</td>{cols.map(([k]) => <td key={k}><input className={String(r[k as keyof T]) === '' ? 'empty' : ''} value={String(r[k as keyof T])} onChange={(e) => onChange(i, k, e.target.value)} /></td>)}<td><button className="link" onClick={() => onRemove(i)}>убрать</button></td></tr>))}
        </tbody>
      </table>
    </div>
  );
}

function AppendixEditor({ contractId, appendixId, number, onBack }: { contractId: string; appendixId: string | null; number: string; onBack: (changed: boolean) => void }) {
  const [d, setD] = useState<AppendixDraft | null>(null);
  const [id, setId] = useState<string | null>(appendixId);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [opened, setOpened] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<TrackHit[]>([]);
  const [changed, setChanged] = useState(false);
  useEffect(() => { void call('appendix:draft', { contractId, appendixId }).then(setD).catch((e: Error) => setErr(e.message)); }, [contractId, appendixId]);
  useEffect(() => { if (q.trim().length < 2) { setHits([]); return; } void call('tracks:search', { q }).then(setHits); }, [q]);
  if (!d) return <div className="dim">{err || 'Загрузка…'}</div>;
  const upd = (f: (x: AppendixDraft) => AppendixDraft) => { setD((x) => (x ? f(x) : x)); setInfo(''); };
  const save = async (): Promise<string | null> => {
    setErr('');
    try { const nid = await call('appendix:save', { contractId, draft: { ...d, appendixId: id } }); setId(nid); setChanged(true); setInfo('Сохранено'); setD((x) => (x ? { ...x, appendixId: nid } : x)); return nid; } catch (e) { setErr((e as Error).message); return null; }
  };
  const exp = async (format: 'docx' | 'pdf') => {
    const nid = await save(); if (!nid) return;
    try { const r = await call('contracts:export', { req: { contractId, format, part: 'appendix', appendixId: nid }, edit: null, draft: { ...d, appendixId: nid } }); setInfo(`Готово: ${r.path}`); setOpened(r.path); } catch (e) { setErr((e as Error).message); }
  };
  const addTrack = (t: TrackHit) => {
    setQ(''); setHits([]);
    void call('appendix:track', { contractId, trackId: t.id, date: d.date }).then((row) => upd((x) => ({ ...x, tracks: [...x.tracks, row] }))).catch((e: Error) => setErr(e.message));
  };
  const incomplete = d.tracks.filter((t) => !t.row.lyricists || !t.row.composers || !t.row.makers || !t.row.shareAuthors || !t.row.shareRelated || !t.row.rate).length;
  return (
    <>
      <div className="bar">
        <button onClick={() => onBack(changed)}>← К приложениям</button>
        <h2 style={{ margin: 0 }}>Приложение № {d.no} к договору {number}</h2>
        <div className="grow" />
        <button onClick={() => void save()}>Сохранить</button>
        <button className="primary" onClick={() => void exp('docx')}>Создать Word</button>
        <button className="primary" onClick={() => void exp('pdf')}>Создать PDF</button>
      </div>
      <div className="row" style={{ marginBottom: 8 }}>
        <label className="f" style={{ width: 90 }}>№<input type="number" min={1} value={d.no} onChange={(e) => upd((x) => ({ ...x, no: Number(e.target.value) }))} /></label>
        <label className="f" style={{ width: 160 }}>Дата<input type="date" value={d.date} onChange={(e) => upd((x) => ({ ...x, date: e.target.value }))} /></label>
      </div>
      {err && <div className="err" style={{ whiteSpace: 'pre-wrap' }}>{err}</div>}
      {info && <div className="okmsg">{info}{opened && info.startsWith('Готово') && <button className="link" onClick={() => void call('payouts:open', { path: opened })}>Открыть файл</button>}</div>}
      {incomplete > 0 && <div className="warn">В {incomplete} строках не заполнены авторы, изготовитель, доли или ставка (пустые поля подсвечены). Введённое запоминается на трек и подставится в следующих приложениях.</div>}
      <h3>1. Произведения, Исполнения, Фонограммы</h3>
      <Grid rows={d.tracks.map((t) => t.row)} cols={TRACK_COLS} onChange={(i, k, v) => upd((x) => ({ ...x, tracks: x.tracks.map((t, j) => (j === i ? { ...t, row: { ...t.row, [k]: v } } : t)) }))} onRemove={(i) => upd((x) => ({ ...x, tracks: x.tracks.filter((_, j) => j !== i) }))} />
      <div className="row" style={{ margin: '8px 0', position: 'relative' }}>
        <input style={{ maxWidth: 320 }} placeholder="Добавить трек из каталога (название или ISRC)" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && <div className="pop">{hits.slice(0, 8).map((h) => <button key={h.id} className="link" onClick={() => addTrack(h)}>{h.title} <span className="dim">{h.artists.join(', ')}{h.isrc ? ` · ${h.isrc}` : ''}</span></button>)}</div>}
      </div>
      <h3>2. Видеоматериалы <span className="dim">(если нет — таблица напечатается с «нет»)</span></h3>
      <Grid rows={d.videos} cols={VIDEO_COLS} onChange={(i, k, v) => upd((x) => ({ ...x, videos: x.videos.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }))} onRemove={(i) => upd((x) => ({ ...x, videos: x.videos.filter((_, j) => j !== i) }))} />
      <button style={{ margin: '8px 0' }} onClick={() => upd((x) => ({ ...x, videos: [...x.videos, { title: '', workAuthors: '', performer: '', makers: '', share: '', year: '', duration: '', term: '', explicit: 'нет', rate: '' }] }))}>+ видеоматериал</button>
      <h3>3. Изобразительные объекты (обложки)</h3>
      <Grid rows={d.images} cols={IMAGE_COLS} onChange={(i, k, v) => upd((x) => ({ ...x, images: x.images.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }))} onRemove={(i) => upd((x) => ({ ...x, images: x.images.filter((_, j) => j !== i) }))} />
      <button style={{ margin: '8px 0' }} onClick={() => upd((x) => ({ ...x, images: [...x.images, { workTitle: '', description: 'Обложка трека', authors: '', performer: '', share: '100%', year: '', term: '' }] }))}>+ обложка</button>
    </>
  );
}
