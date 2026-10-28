import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, PersonDetail, PersonListItem } from '../../../shared/api.ts';
import { call, FIELD_GROUPS, FIELD_LABELS } from '../api.ts';
import { Avatar } from '../Avatar.tsx';
import { PhotoEditor } from '../PhotoEditor.tsx';
import { ContractLink } from '../ContractViewer.tsx';
import { useNav } from '../nav.tsx';
import { SearchSelect } from '../SearchSelect.tsx';
import { useSort } from '../sort.tsx';

function PersonDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const nav = useNav();
  const [allArtists, setAllArtists] = useState<ArtistListItem[]>([]);
  const [newArtist, setNewArtist] = useState('');
  const [det, setDet] = useState<PersonDetail | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);

  const load = useCallback(async (rv: boolean) => {
    if (!id) return;
    const d = await call('people:get', { id, reveal: rv });
    setDet(d);
    setEdit(Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, v == null ? '' : String(v)])));
  }, [id]);
  useEffect(() => { void load(false); }, [load]);
  useEffect(() => { if (id) void call('artists:list', { q: '' }).then(setAllArtists); }, [id]);
  const addArtist = async (arg: { artistId?: string; name?: string }) => {
    if (!id) return;
    setErr('');
    try { await call('people:addArtist', { personId: id, ...arg }); setNewArtist(''); await load(reveal); setAllArtists(await call('artists:list', { q: '' })); } catch (e) { setErr((e as Error).message); }
  };

  const badFields = new Set((det?.checks ?? []).map((c) => c.field));
  async function save() {
    setErr('');
    try {
      const patch: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(edit)) if (k in FIELD_LABELS) patch[k] = v;
      if (id) await call('people:update', { id, patch });
      else { await call('people:create', patch); }
      onClose();
    } catch (e) { setErr((e as Error).message); }
  }
  const editable = !id || reveal;
  return (
    <div className="modal"><div className="dialog">
      <div className="row" style={{ marginBottom: 8 }}>
        {id && <Avatar big file={det?.fields.photo_file as string | null} onClick={() => setPhotoOpen(true)} title="Фото: заменить, убрать, сохранить в файл" />}
        <h1 style={{ margin: 0 }}>{id ? 'Карточка человека' : 'Новый человек'}</h1>
      </div>
      {id && det?.masked && <div className="row" style={{ marginBottom: 8 }}><span className="dim">Паспорт, ИНН, счета скрыты.</span><button onClick={() => { setReveal(true); void load(true); }}>Показать и редактировать</button></div>}
      {id && det && editable && <label className="chk" style={{ marginBottom: 8 }} title="Выплаты этому человеку не считаются и не попадают в итоги «Выплат». Остаётся в строках и коллабах."><input type="checkbox" checked={det.isOwner} onChange={(e) => { setErr(''); void call('people:setOwner', { id, owner: e.target.checked }).then(() => load(reveal)).catch((x: Error) => setErr(x.message)); }} /> Это владелец лейбла, себе не выплачиваем</label>}
      {det && <div style={{ marginBottom: 8 }}><span className="badge">Заполнено {det.completeness.filled} из {det.completeness.total}</span>{det.checks.map((c, i) => <span key={i} className="badge bad">{c.message}</span>)}</div>}
      {FIELD_GROUPS.map(([g, fields]) => (
        <div key={g}><h3>{g}</h3><div className="grid2">{fields.map((f) => (
          <label key={f} className={'f' + (badFields.has(f) ? ' bad' : '')}>{FIELD_LABELS[f]}
            <input value={edit[f] ?? ''} disabled={!editable} onChange={(e) => setEdit({ ...edit, [f]: e.target.value })} />
          </label>))}</div></div>
      ))}
      {id && det && (<>
        <h3>Артисты</h3>
        <div>{det.artists.map((a) => <span key={a.id} className="badge">{a.name}</span>)}</div>
        <div className="row" style={{ marginTop: 6 }}>
          <SearchSelect width={260} options={allArtists.filter((a) => a.counterpartyId !== id).map((a) => ({ value: a.id, label: a.name, hint: a.person ?? 'свободный' }))} value="" placeholder="+ существующий артист…" onChange={(v) => v && void addArtist({ artistId: v })} />
          <input style={{ maxWidth: 200 }} placeholder="или новый артист" value={newArtist} onChange={(e) => setNewArtist(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && newArtist.trim()) void addArtist({ name: newArtist.trim() }); }} />
          <button disabled={!newArtist.trim()} onClick={() => void addArtist({ name: newArtist.trim() })}>+ артист</button>
        </div>
      </>)}
      {id && det && (<>
        <h3>Договоры</h3>
        {det.contracts.length === 0 && <div className="row"><span className="badge bad">договор не создан</span><button className="primary" onClick={() => { onClose(); nav.go('contracts', { contractFor: id }); }}>Создать договор</button></div>}
        <ul className="plain">{det.contracts.map((c) => <li key={c.id}><ContractLink id={c.id}>{c.number}</ContractLink> <span className="dim">{c.date ?? 'без даты'} · {c.kind}{c.has_pdf ? '' : ' · PDF не приложен'}</span></li>)}</ul>
      </>)}
      {err && <div className="err">{err}</div>}
      {photoOpen && id && <PhotoEditor table="counterparty" id={id} file={(det?.fields.photo_file as string | null) ?? null} title={det ? [det.fields.last_name, det.fields.first_name].filter(Boolean).join(' ') : ''} onClose={(ch) => { setPhotoOpen(false); if (ch) void load(reveal); }} />}
      <div className="row end">{id && <button className="link" onClick={() => { if (confirm('Удалить этого человека? Это возможно, только если за ним нет артистов, договора и расчётов.')) { setErr(''); void call('people:delete', { id }).then(onClose).catch((e: Error) => setErr(e.message)); } }}>Удалить человека</button>}<div className="grow" /><button onClick={onClose}>Закрыть</button>{editable && <button className="primary" onClick={save}>Сохранить</button>}</div>
    </div></div>
  );
}

export function People({ onChanged }: { onChanged: () => void }) {
  const nav = useNav();
  const [q, setQ] = useState(nav.params.query ?? '');
  const [rows, setRows] = useState<PersonListItem[]>([]);
  const [sel, setSel] = useState<string | null | undefined>(nav.params.personId);
  useEffect(() => { if (nav.params.personId || nav.params.query) nav.clear(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(() => { void call('people:list', { q }).then(setRows); }, [q]);
  useEffect(() => { const h = setTimeout(load, 150); return () => clearTimeout(h); }, [load]);
  const { sorted, th } = useSort(rows, { name: (p) => p.display, status: (p) => p.status, artists: (p) => p.artists.join(', '), contracts: (p) => p.contracts.length ? p.contracts.join(', ') : null, filled: (p) => p.filled / Math.max(1, p.total) });
  return (
    <>
      <h1>Люди</h1>
      <div className="bar"><input placeholder="Поиск по ФИО, артисту, номеру договора…" value={q} onChange={(e) => setQ(e.target.value)} /><div className="grow" /><span className="dim">{rows.length}</span><button onClick={() => setSel(null)}>+ Человек</button></div>
      <table>
        <thead><tr>{th('name', 'ФИО')}{th('status', 'Статус')}{th('artists', 'Артисты')}{th('contracts', 'Договоры')}{th('filled', 'Данные')}</tr></thead>
        <tbody>{sorted.map((p) => (
          <tr key={p.id} className="click" onClick={() => setSel(p.id)}>
            <td><div className="nameCell"><Avatar file={p.photo} />{p.display}</div></td><td className="dim">{p.status}</td><td>{p.artists.join(', ')}</td><td className="mono">{p.contracts.length ? p.contracts.join(', ') : <button className="badge bad" title="Создать договор" onClick={(e) => { e.stopPropagation(); nav.go('contracts', { contractFor: p.id }); }}>договор не создан</button>}</td>
            <td><span className={'badge ' + (p.problems ? 'bad' : 'ok')}>{p.filled}/{p.total}{p.problems ? ` · ошибок ${p.problems}` : ''}</span></td>
          </tr>))}</tbody>
      </table>
      {sel !== undefined && <PersonDialog id={sel} onClose={() => { setSel(undefined); load(); onChanged(); }} />}
    </>
  );
}
