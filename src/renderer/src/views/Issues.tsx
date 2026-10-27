import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, IssueView, TrackHit } from '../../../shared/api.ts';
import { call, issueLabel } from '../api.ts';
import { fmtKop } from '../util.ts';

type Status = 'open' | 'resolved' | 'ignored';

function details(i: IssueView): string {
  const d = i.details as Record<string, unknown>;
  const money = (k: string) => (typeof d[k] === 'number' ? fmtKop(d[k] as number) : null);
  switch (i.kind) {
    case 'unmatched_track':
      return [d.isrc && `ISRC ${d.isrc}`, d.code && `код ${d.code}`, d.artist && `артист ${d.artist}`, `строк ${d.lines}`, money('royalty_kop')].filter(Boolean).join(' · ');
    case 'unknown_artist': return `строк ${d.lines} · ${money('royalty_kop')}`;
    case 'not_reported_platform': return `строк ${d.lines} · ${money('royalty_kop')} — площадка не указана дистрибьютором`;
    case 'footer_mismatch': return `в файле ${money('footer_kop')}, по строкам ${money('rows_kop')}, разница ${money('diff_kop')}`;
    case 'isrc_two_distributors': return `ISRC ${d.isrc}; также у: ${Array.isArray(d.other_distributors) ? d.other_distributors.join(', ') : ''}`;
    default: return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; ');
  }
}

export function Issues({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<Status>('open');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState<IssueView[]>([]);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<IssueView | null>(null);
  const load = useCallback(() => { void call('issues:list', { status, kind: kind || undefined }).then(setRows); }, [status, kind]);
  useEffect(load, [load]);
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const done = () => { setPick(null); load(); onChanged(); };
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); done(); } catch (e) { setErr((e as Error).message); } };
  const set = (id: string, st: Status) => run(() => call('issues:resolve', { id, status: st }));
  return (
    <>
      <h1>Проверить</h1>
      <div className="bar">
        <select style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value as Status)}><option value="open">Открытые</option><option value="resolved">Решённые</option><option value="ignored">Игнорируемые</option></select>
        <select style={{ maxWidth: 260 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Все виды</option>{kinds.map((k) => <option key={k} value={k}>{issueLabel(k)}</option>)}</select>
        <div className="grow" /><span className="dim">{rows.length}</span>
      </div>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr><th>Вид</th><th>Что</th><th>Подробности</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}>
            <td><span className="badge">{issueLabel(i.kind)}</span></td><td>{i.label}</td>
            <td className="dim">{details(i)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{status === 'open' ? <>
              {i.kind === 'unmatched_track' && <><button className="link" onClick={() => setPick(i)}>привязать к треку</button><button className="link" onClick={() => run(() => call('issues:createTrack', { issueId: i.id }))}>создать трек</button></>}
              {i.kind === 'unknown_artist' && <><button className="link" onClick={() => run(() => call('issues:createArtist', { issueId: i.id }))}>создать артиста</button><button className="link" onClick={() => setPick(i)}>это псевдоним</button></>}
              <button className="link" onClick={() => set(i.id, 'resolved')}>решено</button><button className="link" onClick={() => set(i.id, 'ignored')}>игнор</button>
            </> : <button className="link" onClick={() => set(i.id, 'open')}>вернуть</button>}</td>
          </tr>))}</tbody>
      </table>
      {pick?.kind === 'unmatched_track' && <TrackPicker issue={pick} onCancel={() => setPick(null)} onPick={(t) => run(() => call('issues:linkTrack', { issueId: pick.id, trackId: t }))} />}
      {pick?.kind === 'unknown_artist' && <ArtistPicker issue={pick} onCancel={() => setPick(null)} onPick={(a) => run(() => call('issues:aliasArtist', { issueId: pick.id, artistId: a }))} />}
    </>
  );
}

function TrackPicker({ issue, onCancel, onPick }: { issue: IssueView; onCancel: () => void; onPick: (id: string) => void }) {
  const d = issue.details as Record<string, unknown>;
  const [q, setQ] = useState(String(d.title ?? ''));
  const [hits, setHits] = useState<TrackHit[]>([]);
  useEffect(() => { const t = setTimeout(() => void call('tracks:search', { q }).then(setHits).catch(() => setHits([])), 200); return () => clearTimeout(t); }, [q]);
  return (
    <div className="modal"><div className="dialog">
      <h2>К какому треку относится «{String(d.title ?? d.isrc ?? d.code)}»?</h2>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или ISRC" />
      <table><tbody>{hits.map((h) => (
        <tr key={h.id} className="click" onClick={() => onPick(h.id)}><td>{h.title}</td><td className="dim">{h.artists.join(', ')}</td><td className="mono dim">{h.isrc}</td></tr>))}</tbody></table>
      {hits.length === 0 && <div className="dim">Ничего не найдено. Если трека нет в каталоге, закройте окно и нажмите «создать трек».</div>}
      <div className="row end"><button onClick={onCancel}>Отмена</button></div>
    </div></div>
  );
}

function ArtistPicker({ issue, onCancel, onPick }: { issue: IssueView; onCancel: () => void; onPick: (id: string) => void }) {
  const d = issue.details as Record<string, unknown>;
  const [q, setQ] = useState('');
  const [list, setList] = useState<ArtistListItem[]>([]);
  useEffect(() => { void call('artists:list', { q }).then(setList); }, [q]);
  return (
    <div className="modal"><div className="dialog">
      <h2>«{String(d.artist)}» — это другое написание какого артиста?</h2>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск артиста" />
      <table><tbody>{list.slice(0, 40).map((a) => (
        <tr key={a.id} className="click" onClick={() => onPick(a.id)}><td>{a.name}</td></tr>))}</tbody></table>
      <div className="row end"><button onClick={onCancel}>Отмена</button></div>
    </div></div>
  );
}
