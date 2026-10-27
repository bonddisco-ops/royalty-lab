import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, TrackView } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { PhotoEditor } from '../PhotoEditor.tsx';
import { ContractLink } from '../ContractViewer.tsx';
import { useNav } from '../nav.tsx';
import { SearchSelect } from '../SearchSelect.tsx';
import { useSort } from '../sort.tsx';
import { pctInput, shareToPct } from '../util.ts';

function Participant({ p, trackId, bad, reload }: { p: TrackView['participants'][number]; trackId: string; bad: boolean; reload: () => void }) {
  const [a, setA] = useState(shareToPct(p.shareAuthors));
  const [r, setR] = useState(shareToPct(p.shareRelated));
  const [rate, setRate] = useState(shareToPct(p.labelRate));
  const [err, setErr] = useState('');
  const dirty = a !== shareToPct(p.shareAuthors) || r !== shareToPct(p.shareRelated) || rate !== shareToPct(p.labelRate);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <>
      <div className="part">
        <div>{p.artist}{p.duplicate && <span className="badge bad">дубль</span>}<div className="dim" style={{ fontSize: 12 }}>{p.contractId ? <ContractLink id={p.contractId} opts={{ trackId, artist: p.artist }}>{p.contract}</ContractLink> : (p.contract ?? 'нет договора')}{p.payee ? ` · получатель: ${p.payee}` : ''}</div></div>
        <input value={a} onChange={(e) => setA(e.target.value)} title="Авторские, %" />
        <input value={r} onChange={(e) => setR(e.target.value)} title="Смежные, %" />
        <input value={rate} onChange={(e) => setRate(e.target.value)} title="Ставка лейбла, %" placeholder="ставка" />
        <div>
          {dirty && <button className="primary" onClick={() => run(() => call('parts:update', { id: p.id, patch: { share_authors: pctInput(a), share_related: pctInput(r), label_rate: rate.trim() === '' ? null : pctInput(rate) } }))}>Сохранить</button>}
          {bad && <button onClick={() => run(() => call('parts:fix', { trackId, participationId: p.id }))} title="Дописать остаток до 100% этому участнику">Исправить</button>}
        </div>
        <button className="link" onClick={() => { if (confirm(`Убрать «${p.artist}» из трека?`)) void run(() => call('parts:remove', { id: p.id })); }}>убрать</button>
      </div>
      {err && <div className="err">{err}</div>}
    </>
  );
}

function TrackRow({ t, artists, reload, startOpen }: { t: TrackView; artists: ArtistListItem[]; reload: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!startOpen);
  const [add, setAdd] = useState('');
  const [err, setErr] = useState('');
  const [cover, setCover] = useState(false);
  const addPart = async () => {
    setErr('');
    try { await call('parts:add', { trackId: t.id, artistId: add, shareAuthors: '0', shareRelated: '0', labelRate: null }); setAdd(''); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <tr className="click" onClick={() => setOpen(!open)}>
        <td><div className="nameCell"><Avatar square file={t.cover} />{t.title}</div></td>
        <td className="mono">{t.isrc ?? <span className="dim">{t.codes.join(', ') || '—'}</span>}</td>
        <td>{t.participants.map((p) => p.artist).join(', ')}</td>
        <td className={t.shareSumBad ? 'sum bad' : 'dim'}>{shareToPct(t.sumAuthors)}% / {shareToPct(t.sumRelated)}%</td>
        <td>{t.hasDuplicates && <span className="badge bad">дубли</span>}</td>
      </tr>
      {open && (
        <tr><td colSpan={5} style={{ background: 'var(--panel)' }}>
          <div className="row" style={{ marginBottom: 8 }}><Avatar big square file={t.cover} onClick={() => setCover(true)} title="Обложка: заменить, убрать, сохранить в файл" /><span className="dim">Обложка трека (в Excel и PDF не попадает)</span></div>
          {cover && <PhotoEditor table="track" id={t.id} file={t.cover} title={t.title} onClose={(ch) => { setCover(false); if (ch) reload(); }} />}
          <div className="part dim" style={{ fontSize: 12 }}><div>Участник</div><div>Автор., %</div><div>Смеж., %</div><div>Ставка, %</div><div /><div /></div>
          {t.participants.map((p) => <Participant key={p.id + p.shareAuthors + p.shareRelated + p.labelRate} p={p} trackId={t.id} bad={t.shareSumBad} reload={reload} />)}
          <div className="row" style={{ marginTop: 8 }}>
            <SearchSelect width={320} options={artists.filter((a) => !t.participants.some((p) => p.artist === a.name)).map((a) => ({ value: a.id, label: a.name, hint: a.person ?? undefined }))} value={add} onChange={setAdd} placeholder="+ добавить участника (печатайте имя)…" />
            {add && <button onClick={addPart}>Добавить</button>}
          </div>
          {err && <div className="err">{err}</div>}
        </td></tr>
      )}
    </>
  );
}

export function Tracks({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [q, setQ] = useState(nav.params.query ?? '');
  const [focusId] = useState(nav.params.trackId);
  useEffect(() => { if (nav.params.query || nav.params.trackId) nav.clear(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [rows, setRows] = useState<TrackView[]>([]);
  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [isrc, setIsrc] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => { void call('tracks:list', { q, onlyProblems }).then(setRows); }, [q, onlyProblems]);
  useEffect(() => { const h = setTimeout(load, 150); return () => clearTimeout(h); }, [load]);
  useEffect(() => { void call('artists:list', {}).then(setArtists); }, []);
  const reload = () => { load(); onChanged(); };
  const { sorted, th } = useSort(rows, { title: (t) => t.title, isrc: (t) => t.isrc ?? t.codes[0], artists: (t) => t.participants.map((p) => p.artist).join(', '), shares: (t) => Number(t.sumAuthors) + Number(t.sumRelated), bad: (t) => (t.shareSumBad || t.hasDuplicates ? 0 : 1) });

  async function create() {
    setErr('');
    try { await call('tracks:create', { title, isrc: isrc.trim() || null }); setAdding(false); setTitle(''); setIsrc(''); reload(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <>
      <h1>Треки</h1>
      <div className="bar">
        <input placeholder="Поиск по названию, ISRC, артисту, коду…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />только с проблемами</label>
        <div className="grow" />
        <span className="dim">{rows.length}</span>
        <button onClick={() => setAdding(!adding)}>+ Трек</button>
      </div>
      {adding && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="grid2"><label className="f">Название<input value={title} onChange={(e) => setTitle(e.target.value)} /></label><label className="f">ISRC (необязательно)<input value={isrc} onChange={(e) => setIsrc(e.target.value)} /></label></div>
          {err && <div className="err">{err}</div>}
          <div className="row end"><button onClick={() => setAdding(false)}>Отмена</button><button className="primary" disabled={!title.trim()} onClick={create}>Создать</button></div>
        </div>
      )}
      <table>
        <thead><tr>{th('title', 'Название')}{th('isrc', 'ISRC / коды')}{th('artists', 'Артисты')}{th('shares', 'Сумма долей (авт. / смеж.)')}{th('bad', 'Проблемы')}</tr></thead>
        <tbody>{sorted.map((t) => <TrackRow key={t.id} t={t} artists={artists} reload={reload} startOpen={t.id === focusId} />)}</tbody>
      </table>
    </>
  );
}
