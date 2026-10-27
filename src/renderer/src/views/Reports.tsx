import { useCallback, useEffect, useState } from 'react';
import type { ImportItem, QuarterPanel, ReportListItem } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { FLOW_LABELS, SCOPE_LABELS, fmtInt, fmtKop, quarterLabel } from '../util.ts';
import { ReportImport } from './ReportImport.tsx';

export function Reports({ onChanged }: { onChanged: () => void }) {
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<QuarterPanel | null>(null);
  const [list, setList] = useState<ReportListItem[]>([]);
  const [importing, setImporting] = useState<ImportItem[] | null>(null);
  const [err, setErr] = useState('');
  const [del, setDel] = useState<ReportListItem | null>(null);

  const load = useCallback(() => {
    void call('reports:panel', { quarter }).then((p) => {
      setPanel(p);
      return call('reports:list', { quarter: p.quarter || undefined }).then(setList);
    }).catch((e: Error) => setErr(e.message));
  }, [quarter]);
  useEffect(load, [load]);

  const start = async () => {
    setErr('');
    try { const items = await call('reports:pick'); if (items.length > 0) setImporting(items); } catch (e) { setErr((e as Error).message); }
  };
  const setFlow = async (reportId: string, flow: 'artists' | 'personal' | 'ignore') => {
    try { await call('reports:setFlow', { reportId, flow }); load(); onChanged(); } catch (e) { setErr((e as Error).message); }
  };

  const remove = async () => {
    if (!del) return;
    try { await call('reports:delete', { reportId: del.reportId }); setDel(null); load(); onChanged(); } catch (e) { setErr((e as Error).message); setDel(null); }
  };

  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Отчёты</h1>
        {panel && panel.quarters.length > 0 && (
          <select style={{ maxWidth: 180 }} value={panel.quarter} onChange={(e) => setQuarter(e.target.value)}>
            {panel.quarters.map((q) => <option key={q} value={q}>{quarterLabel(q)}</option>)}
          </select>
        )}
        <div className="grow" />
        <button className="primary" onClick={start}>Загрузить отчёты…</button>
      </div>
      {err && <div className="err">{err}</div>}
      {panel && panel.quarters.length === 0 && <div className="drop">Отчётов ещё нет. Нажмите «Загрузить отчёты…» и выберите файлы дистрибьюторов (можно сразу все).</div>}
      {panel && panel.quarters.length > 0 && (
        <>
          <div className="cards">
            {(['artists', 'personal', 'ignore'] as const).map((f) => (
              <div key={f} className="card"><div className="n" style={{ fontSize: 20 }}>{fmtKop(panel.totalsByFlow[f])}</div><div className="l">{FLOW_LABELS[f]}</div></div>
            ))}
            <div className="card"><div className="n">{panel.openIssues}</div><div className="l">вопросов в «Проверить»</div></div>
          </div>
          <h3>Дистрибьюторы за {quarterLabel(panel.quarter)}</h3>
          <div className="cards">
            {panel.distributors.map((d) => (
              <div key={d.id} className="card">
                <b>{d.name}</b>
                <div>{d.loaded ? <span className="badge ok">загружен</span> : <span className="badge bad">нет отчёта</span>}</div>
                {d.loaded && <div className="dim">{fmtInt(d.rows)} строк · {fmtKop(d.rowsKop)}</div>}
              </div>
            ))}
          </div>
          <h3>Загруженные отчёты</h3>
          <table>
            <thead><tr><th>Дистрибьютор</th><th>Права</th><th>Версия</th><th>Строк</th><th>Сумма</th><th>Итог в файле</th><th>Куда</th><th>Файл</th><th /></tr></thead>
            <tbody>{list.map((r) => (
              <tr key={r.reportId}>
                <td>{r.distributor}</td><td>{SCOPE_LABELS[r.scope] ?? r.scope}</td>
                <td>{r.versionNo}{r.versions > 1 && <span className="dim"> из {r.versions}</span>}</td>
                <td>{fmtInt(r.rows)}</td><td>{fmtKop(r.rowsKop)}</td>
                <td>{r.footerKop === null ? <span className="dim">нет</span> : r.footerOk ? <span className="badge ok">✓</span> : <span className="badge bad">{fmtKop(r.footerKop)}</span>}</td>
                <td><select value={r.flow} onChange={(e) => setFlow(r.reportId, e.target.value as 'artists' | 'personal' | 'ignore')}>{Object.entries(FLOW_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                <td className="dim">{r.fileName}{r.openIssues > 0 && <span className="badge bad">{r.openIssues}</span>}</td>
                <td><button className="link" onClick={() => setDel(r)}>удалить</button></td>
              </tr>))}</tbody>
          </table>
        </>
      )}
      {del && (
        <div className="modal"><div className="dialog" style={{ maxWidth: 520 }}>
          <h2>Удалить отчёт?</h2>
          <p>{del.distributor} · {SCOPE_LABELS[del.scope] ?? del.scope} · {quarterLabel(del.quarter)}<br />{fmtInt(del.rows)} строк на {fmtKop(del.rowsKop)}{del.versions > 1 ? `, версий: ${del.versions} (удалятся все)` : ''}</p>
          <p className="dim">Перед удалением программа сделает бэкап. Вопросы из «Проверить» по этому отчёту закроются. Потом этот же файл можно загрузить заново.</p>
          <div className="row end"><button onClick={() => setDel(null)}>Отмена</button><button className="primary" onClick={remove}>Удалить</button></div>
        </div></div>
      )}
      {importing && <ReportImport initial={importing} onClose={(changed) => { setImporting(null); if (changed) { load(); onChanged(); } }} />}
    </>
  );
}
