import { useCallback, useEffect, useState } from 'react';
import type { PersonDetail, PersonListItem } from '../../../shared/api.ts';
import { call, FIELD_GROUPS, FIELD_LABELS } from '../api.ts';

function PersonDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [det, setDet] = useState<PersonDetail | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (rv: boolean) => {
    if (!id) return;
    const d = await call('people:get', { id, reveal: rv });
    setDet(d);
    setEdit(Object.fromEntries(Object.entries(d.fields).map(([k, v]) => [k, v == null ? '' : String(v)])));
  }, [id]);
  useEffect(() => { void load(false); }, [load]);

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
      <h1>{id ? 'Карточка человека' : 'Новый человек'}</h1>
      {id && det?.masked && <div className="row" style={{ marginBottom: 8 }}><span className="dim">Паспорт, ИНН, счета скрыты.</span><button onClick={() => { setReveal(true); void load(true); }}>Показать и редактировать</button></div>}
      {det && <div style={{ marginBottom: 8 }}><span className="badge">Заполнено {det.completeness.filled} из {det.completeness.total}</span>{det.checks.map((c, i) => <span key={i} className="badge bad">{c.message}</span>)}</div>}
      {FIELD_GROUPS.map(([g, fields]) => (
        <div key={g}><h3>{g}</h3><div className="grid2">{fields.map((f) => (
          <label key={f} className={'f' + (badFields.has(f) ? ' bad' : '')}>{FIELD_LABELS[f]}
            <input value={edit[f] ?? ''} disabled={!editable} onChange={(e) => setEdit({ ...edit, [f]: e.target.value })} />
          </label>))}</div></div>
      ))}
      {det && det.artists.length > 0 && (<><h3>Артисты</h3><div>{det.artists.map((a) => <span key={a.id} className="badge">{a.name}</span>)}</div></>)}
      {det && det.contracts.length > 0 && (<><h3>Договоры</h3><ul className="plain">{det.contracts.map((c) => <li key={c.id}>{c.number} <span className="dim">{c.date ?? 'без даты'} · {c.kind}{c.has_pdf ? '' : ' · PDF не приложен'}</span></li>)}</ul></>)}
      {err && <div className="err">{err}</div>}
      <div className="row end"><button onClick={onClose}>Закрыть</button>{editable && <button className="primary" onClick={save}>Сохранить</button>}</div>
    </div></div>
  );
}

export function People({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PersonListItem[]>([]);
  const [sel, setSel] = useState<string | null | undefined>(undefined);
  const load = useCallback(() => { void call('people:list', { q }).then(setRows); }, [q]);
  useEffect(() => { const h = setTimeout(load, 150); return () => clearTimeout(h); }, [load]);
  return (
    <>
      <h1>Люди</h1>
      <div className="bar"><input placeholder="Поиск по ФИО, артисту, номеру договора…" value={q} onChange={(e) => setQ(e.target.value)} /><div className="grow" /><span className="dim">{rows.length}</span><button onClick={() => setSel(null)}>+ Человек</button></div>
      <table>
        <thead><tr><th>ФИО</th><th>Статус</th><th>Артисты</th><th>Договоры</th><th>Данные</th></tr></thead>
        <tbody>{rows.map((p) => (
          <tr key={p.id} className="click" onClick={() => setSel(p.id)}>
            <td>{p.display}</td><td className="dim">{p.status}</td><td>{p.artists.join(', ')}</td><td className="mono">{p.contracts.join(', ')}</td>
            <td><span className={'badge ' + (p.problems ? 'bad' : 'ok')}>{p.filled}/{p.total}{p.problems ? ` · ошибок ${p.problems}` : ''}</span></td>
          </tr>))}</tbody>
      </table>
      {sel !== undefined && <PersonDialog id={sel} onClose={() => { setSel(undefined); load(); onChanged(); }} />}
    </>
  );
}
