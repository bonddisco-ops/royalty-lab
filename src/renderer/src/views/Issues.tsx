import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, IssueView, TrackHit } from '../../../shared/api.ts';
import { call, issueLabel } from '../api.ts';
import { useNav, type NavParams, type Tab } from '../nav.tsx';
import { useSort } from '../sort.tsx';
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
    case 'edit_lost_on_replace':
      return `${d.title ?? ''} · ${d.platform ?? ''} · ${d.month ?? ''} ${d.country ?? ''} — в новой версии отчёта такой строки нет. Правки: ${[...(Array.isArray(d.edits) ? d.edits : []), ...(Array.isArray(d.splits) ? d.splits : [])].join(', ')}`;
    case 'new_track': return `${d.artist ? `артист из отчёта: ${d.artist}. ` : ''}${Array.isArray(d.notes) ? (d.notes as string[]).join('; ') : ''}`;
    case 'no_contract': return typeof d.note === 'string' ? d.note : '';
    case 'isrc_two_distributors': return `ISRC ${d.isrc}; также у: ${Array.isArray(d.other_distributors) ? d.other_distributors.join(', ') : ''}`;
    default: return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; ');
  }
}

/** Куда вести по красной пометке: к месту, где проблему можно решить. */
export function fixTarget(i: IssueView): { label: string; tab: Tab; params: NavParams } | null {
  const id = i.entityId ?? undefined;
  switch (i.kind) {
    case 'missing_pii': return id ? { label: 'Заполнить данные', tab: 'people', params: { personId: id } } : null;
    case 'no_contract':
      if (i.entityType === 'counterparty' && id) return { label: 'Создать договор', tab: 'contracts', params: { contractFor: id } };
      return { label: 'Привязать к человеку', tab: 'artists', params: { query: i.label } };
    case 'missing_rate': return id ? { label: 'Открыть договор', tab: 'contracts', params: { contractId: id } } : { label: 'Открыть треки', tab: 'tracks', params: {} };
    case 'share_sum': case 'duplicate_participant': case 'isrc_title_conflict': case 'whitespace': case 'new_track':
      return id ? { label: i.kind === 'new_track' ? 'Проверить доли' : 'Исправить в треке', tab: 'tracks', params: { trackId: id, query: i.label } } : null;
    case 'no_appendix': return { label: 'Открыть трек', tab: 'tracks', params: { query: String((i.details as Record<string, unknown>).track ?? '') } };
    case 'footer_mismatch': case 'not_reported_platform': case 'isrc_two_distributors': return { label: 'Открыть отчёты', tab: 'reports', params: {} };
    case 'edit_lost_on_replace': return { label: 'Открыть строки', tab: 'lines', params: {} };
    default: return null;
  }
}

export function Issues({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [status, setStatus] = useState<Status>('open');
  const [kind, setKind] = useState(nav.params.issueKind ?? '');
  const [versionId, setVersionId] = useState<string | undefined>(nav.params.reportVersionId);
  const [rows, setRows] = useState<IssueView[]>([]);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [pick, setPick] = useState<IssueView | null>(null);
  useEffect(() => { if (nav.params.reportVersionId || nav.params.issueKind) nav.clear(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(() => { void call('issues:list', { status, kind: kind || undefined, reportVersionId: versionId }).then(setRows); }, [status, kind, versionId]);
  useEffect(load, [load]);
  const kinds = [...new Set([...rows.map((r) => r.kind), ...(kind ? [kind] : [])])];
  const { sorted, th } = useSort(rows, { kind: (r) => issueLabel(r.kind), what: (r) => r.label, details: (r) => details(r) });
  const missing = rows.filter((r) => r.kind === 'unmatched_track');
  const done = () => { setPick(null); load(); onChanged(); };
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); done(); } catch (e) { setErr((e as Error).message); } };
  const set = (id: string, st: Status) => run(() => call('issues:resolve', { id, status: st }));
  return (
    <>
      <h1>Проверить</h1>
      <div className="bar">
        <select style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value as Status)}><option value="open">Открытые</option><option value="resolved">Решённые</option><option value="ignored">Игнорируемые</option></select>
        <select style={{ maxWidth: 260 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Все виды</option>{kinds.map((k) => <option key={k} value={k}>{issueLabel(k)}</option>)}</select>
        {versionId && <button className="badge" onClick={() => setVersionId(undefined)} title="Показать проблемы по всем отчётам">только один отчёт ✕</button>}
        <div className="grow" />
        {status === 'open' && missing.length > 0 && (
          <button className="primary" title="Для каждого трека из отчёта заводит карточку, подставляет артиста и ставку из договора, остальное подсвечивает" onClick={() => {
            if (!confirm(`Создать в каталоге треки, которых там нет (${missing.length})? Артист и ставка из договора подставятся, где их можно определить, остальное попадёт в «Проверить».`)) return;
            void run(async () => { const r = await call('issues:createMissing', { issueIds: missing.map((m) => m.id) }); setInfo(`Создано треков: ${r.created}, с артистом: ${r.withArtist}, со ставкой из договора: ${r.withRate}${r.skipped ? `, пропущено: ${r.skipped}` : ''}. Проверьте доли в новых треках.`); });
          }}>Создать все недостающие треки ({missing.length})</button>
        )}
        <span className="dim">{rows.length}</span>
      </div>
      {err && <div className="err">{err}</div>}{info && <div className="okmsg">{info}</div>}
      <table>
        <thead><tr>{th('kind', 'Вид')}{th('what', 'Что')}{th('details', 'Подробности')}<th /></tr></thead>
        <tbody>{sorted.map((i) => (
          <tr key={i.id}>
            <td><span className="badge bad">{issueLabel(i.kind)}</span></td><td>{i.label}</td>
            <td className="dim">{details(i)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{status === 'open' ? <>
              {(() => { const t = fixTarget(i); return t ? <button className="link" style={{ fontWeight: 600 }} onClick={() => nav.go(t.tab, t.params)}>{t.label} →</button> : null; })()}
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
