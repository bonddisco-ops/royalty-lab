import { useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, PersonListItem } from '../../../shared/api.ts';
import { call } from '../api.ts';

export function Artists({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<ArtistListItem[]>([]);
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [name, setName] = useState('');
  const [variant, setVariant] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const load = useCallback(() => { void call('artists:list', { q }).then(setRows); }, [q]);
  useEffect(() => { const h = setTimeout(load, 150); return () => clearTimeout(h); }, [load]);
  useEffect(() => { void call('people:list', {}).then(setPeople); }, []);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  return (
    <>
      <h1>Артисты</h1>
      <div className="bar">
        <input placeholder="Поиск по имени и написаниям…" value={q} onChange={(e) => setQ(e.target.value)} /><div className="grow" /><span className="dim">{rows.length}</span>
        <input style={{ maxWidth: 200 }} placeholder="Новый артист" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim()} onClick={() => run(async () => { await call('artists:create', { name }); setName(''); })}>+ Артист</button>
      </div>
      {err && <div className="err">{err}</div>}
      <table>
        <thead><tr><th>Артист</th><th>Человек (получатель)</th><th>Написания</th><th>Треков</th></tr></thead>
        <tbody>{rows.map((a) => (
          <tr key={a.id}>
            <td>{a.name}{a.withoutContract && <span className="badge bad">нет договора</span>}</td>
            <td><select value={a.counterpartyId ?? ''} onChange={(e) => run(() => call('artists:update', { id: a.id, patch: { counterparty_id: e.target.value || null } }))}>
              <option value="">— не привязан —</option>{people.map((p) => <option key={p.id} value={p.id}>{p.display}</option>)}</select></td>
            <td>{a.variants.map((v) => <span key={v} className="badge">{v}</span>)}
              <input style={{ width: 150 }} placeholder="+ написание" value={variant[a.id] ?? ''} onChange={(e) => setVariant({ ...variant, [a.id]: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter' && variant[a.id]?.trim()) void run(async () => { await call('artists:addVariant', { id: a.id, text: variant[a.id]! }); setVariant({ ...variant, [a.id]: '' }); }); }} /></td>
            <td className="dim">{a.tracks}</td>
          </tr>))}</tbody>
      </table>
    </>
  );
}
