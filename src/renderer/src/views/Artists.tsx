import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, PersonListItem } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { PhotoEditor } from '../PhotoEditor.tsx';
import { useNav } from '../nav.tsx';
import { SearchSelect } from '../SearchSelect.tsx';
import { useSort } from '../sort.tsx';

export function Artists({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [q, setQ] = useState(nav.params.query ?? '');
  useEffect(() => { if (nav.params.query) nav.clear(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<ArtistListItem[]>([]);
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [name, setName] = useState('');
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [photoFor, setPhotoFor] = useState<ArtistListItem | null>(null);
  const load = useCallback(() => { void call('artists:list', { q }).then(setRows); }, [q]);
  useEffect(() => { const h = setTimeout(load, 150); return () => clearTimeout(h); }, [load]);
  useEffect(() => { void call('people:list', {}).then(setPeople); }, []);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const { sorted, th } = useSort(rows, { name: (a) => a.name, person: (a) => a.person, tracks: (a) => a.tracks, nocontract: (a) => (a.withoutContract ? 0 : 1) });
  const opts = people.map((p) => ({ value: p.id, label: p.display, hint: p.artists.join(', ') }));
  return (
    <>
      <h1>Артисты</h1>
      <div className="bar">
        <input placeholder="Поиск по имени и другим написаниям…" value={q} onChange={(e) => setQ(e.target.value)} /><div className="grow" /><span className="dim">{rows.length}</span>
        <input style={{ maxWidth: 200 }} placeholder="Новый артист" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => run(async () => { await call('artists:create', { name }); setName(''); })}>+ Артист</button>
      </div>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr>{th('name', 'Артист')}{th('person', 'Человек (получатель)')}<th title="Как этого артиста могут назвать в отчётах дистрибьюторов: «Shtain», «ШТАЙН», «Shtain feat. X». Если имя из отчёта совпадёт с одним из написаний — строка сама привяжется к этому артисту.">Другие написания имени ⓘ</th>{th('tracks', 'Треков')}<th /></tr></thead>
        <tbody>{sorted.map((a) => (
          <tr key={a.id}>
            <td><div className="nameCell"><Avatar file={a.photo} onClick={() => setPhotoFor(a)} title="Фото артиста" />{a.name}{a.withoutContract && <button className="badge bad" title="Создать договор" onClick={() => a.counterpartyId ? nav.go('contracts', { contractFor: a.counterpartyId }) : undefined}>{a.counterpartyId ? 'нет договора — создать' : 'не привязан к человеку'}</button>}</div></td>
            <td><SearchSelect options={opts} value={a.counterpartyId ?? ''} empty="— не привязан —" placeholder="Фамилия…" onChange={(v) => run(() => call('artists:update', { id: a.id, patch: { counterparty_id: v || null } }))} /></td>
            <td>{a.variants.map((v) => <span key={v} className="badge">{v}</span>)}
              <input style={{ width: 150 }} placeholder="+ другое написание" value={variant[a.id] ?? ''} onChange={(e) => setVariant({ ...variant, [a.id]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && variant[a.id]?.trim()) void run(async () => { await call('artists:addVariant', { id: a.id, text: variant[a.id]! }); setVariant({ ...variant, [a.id]: '' }); }); }} /></td>
            <td className="dim">{a.tracks}</td>
            <td><button className="link" onClick={() => { if (confirm(`Удалить артиста «${a.name}»?${a.tracks ? ' У него есть треки, программа не даст удалить.' : ''}`)) void run(() => call('artists:delete', { id: a.id })); }}>удалить</button></td>
          </tr>))}</tbody>
      </table>
      {photoFor && <PhotoEditor table="artist" id={photoFor.id} file={photoFor.photo} title={photoFor.name} onClose={(ch) => { setPhotoFor(null); if (ch) load(); }} />}
    </>
  );
}
