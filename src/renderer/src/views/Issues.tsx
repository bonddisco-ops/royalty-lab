import { useCallback, useEffect, useState } from 'react';
import type { IssueView } from '../../../shared/api.ts';
import { call, issueLabel } from '../api.ts';

export function Issues({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<'open' | 'resolved' | 'ignored'>('open');
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState<IssueView[]>([]);
  const load = useCallback(() => { void call('issues:list', { status, kind: kind || undefined }).then(setRows); }, [status, kind]);
  useEffect(load, [load]);
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const set = async (id: string, st: 'open' | 'resolved' | 'ignored') => { await call('issues:resolve', { id, status: st }); load(); onChanged(); };
  return (
    <>
      <h1>Проблемы</h1>
      <div className="bar">
        <select style={{ maxWidth: 180 }} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="open">Открытые</option><option value="resolved">Решённые</option><option value="ignored">Игнорируемые</option></select>
        <select style={{ maxWidth: 240 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Все виды</option>{kinds.map((k) => <option key={k} value={k}>{issueLabel(k)}</option>)}</select>
        <div className="grow" /><span className="dim">{rows.length}</span>
      </div>
      <table>
        <thead><tr><th>Вид</th><th>Что</th><th>Подробности</th><th /></tr></thead>
        <tbody>{rows.map((i) => (
          <tr key={i.id}>
            <td><span className="badge">{issueLabel(i.kind)}</span></td><td>{i.label}</td>
            <td className="dim">{Object.entries(i.details).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; ')}</td>
            <td>{status === 'open' ? <><button className="link" onClick={() => set(i.id, 'resolved')}>решено</button><button className="link" onClick={() => set(i.id, 'ignored')}>игнор</button></> : <button className="link" onClick={() => set(i.id, 'open')}>вернуть</button>}</td>
          </tr>))}</tbody>
      </table>
    </>
  );
}
