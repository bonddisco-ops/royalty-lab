import { useEffect, useState } from 'react';
import type { ApplyResult, ImportItem, WizardInfo } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { FLOW_LABELS, SCOPE_LABELS, STREAM_LABELS, fmtInt, fmtKop } from '../util.ts';

/** Диалог «Загрузить отчёты»: файлы пачкой → проверка → запись. */
export function ReportImport({ initial, onClose }: { initial: ImportItem[]; onClose: (changed: boolean) => void }) {
  const [items, setItems] = useState<ImportItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [wizard, setWizard] = useState<string | null>(null);

  const replace = (it: ImportItem) => setItems((xs) => xs.map((x) => (x.id === it.id ? it : x)));
  const guard = async (fn: () => Promise<void>) => { setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } };
  const addMore = () => guard(async () => { const more = await call('reports:pick'); setItems((xs) => [...xs, ...more]); });
  const setOpt = (id: string, o: { flow?: 'artists' | 'personal' | 'ignore'; quarter?: string }) => guard(async () => replace(await call('reports:setOptions', { id, ...o })));
  const drop = (id: string) => { void call('reports:discard', { id }); setItems((xs) => xs.filter((x) => x.id !== id)); };

  const ready = items.filter((i) => i.state === 'ready' && i.preview && !i.preview.duplicateOf && /^\d{4}Q[1-4]$/.test(i.preview.quarter));
  const apply = () => guard(async () => {
    setBusy(true);
    try {
      const res = await call('reports:apply', { ids: ready.map((i) => i.id) });
      setResults(res);
      const okIds = new Set(res.filter((r) => r.ok).map((r) => r.id));
      setItems((xs) => xs.filter((x) => !okIds.has(x.id)));
    } finally { setBusy(false); }
  });

  if (wizard) {
    return <Wizard id={wizard} onCancel={() => setWizard(null)} onDone={(it) => { replace(it); setWizard(null); }} />;
  }
  return (
    <div className="modal"><div className="dialog">
      <div className="row"><h1 style={{ margin: 0 }}>Загрузка отчётов</h1><div className="grow" style={{ flex: 1 }} /><button onClick={addMore}>Добавить файлы…</button></div>
      {err && <div className="err">{err}</div>}
      {results && (
        <div style={{ margin: '10px 0' }}>
          {results.map((r) => r.ok
            ? <div key={r.id} className="okmsg">✓ {r.fileName}: {fmtInt(r.lines ?? 0)} строк, {fmtKop(r.rowsKop)}, версия {r.versionNo}{r.issues ? `, в «Проверить»: ${r.issues}` : ''}</div>
            : <div key={r.id} className="err">✗ {r.fileName}: {r.error}</div>)}
        </div>
      )}
      {items.length === 0 && !results && <div className="drop">Файлов нет. Нажмите «Добавить файлы…»</div>}
      {items.map((it) => <ItemCard key={it.id} it={it} setOpt={setOpt} drop={drop} openWizard={() => setWizard(it.id)} />)}
      <div className="row end">
        <button onClick={() => onClose(!!results?.some((r) => r.ok))}>{results ? 'Закрыть' : 'Отмена'}</button>
        <button className="primary" disabled={busy || ready.length === 0} onClick={apply}>{busy ? 'Записываю…' : `Загрузить (${ready.length})`}</button>
      </div>
    </div></div>
  );
}

function ItemCard({ it, setOpt, drop, openWizard }: { it: ImportItem; setOpt: (id: string, o: { flow?: 'artists' | 'personal' | 'ignore'; quarter?: string }) => void; drop: (id: string) => void; openWizard: () => void }) {
  const p = it.preview;
  const personal = p?.flow !== 'artists';
  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <div className="row"><b style={{ flex: 1 }}>{it.fileName}</b><button className="link" onClick={() => drop(it.id)}>убрать</button></div>
      {it.state === 'error' && <div className="err">{it.error}</div>}
      {it.state === 'unknown' && (
        <div style={{ marginTop: 8 }}>
          <div className="dim">Формат не узнан. Можно показать программе, где какие колонки — формат запомнится.</div>
          <button className="primary" style={{ marginTop: 8 }} onClick={openWizard}>Настроить колонки…</button>
        </div>
      )}
      {p && (
        <>
          <div className="dim" style={{ margin: '4px 0 8px' }}>{p.distributorName} · {SCOPE_LABELS[p.rightsScope]}{p.licensorShare ? ` · ставка лицензиара ${Math.round(Number(p.licensorShare) * 100)}%` : ''}{p.periodFrom ? ` · ${p.periodFrom} — ${p.periodTo}` : ''}</div>
          <div className="grid2">
            <label className="f">Квартал{p.quarterSource === 'periods' || p.quarterSource === 'filename' ? ' (угадан — проверьте)' : ''}
              <input defaultValue={p.quarter} placeholder="2026Q3" onBlur={(e) => e.target.value !== p.quarter && setOpt(it.id, { quarter: e.target.value.trim().toUpperCase() })} />
            </label>
            <label className="f">Куда идут деньги
              <select value={p.flow} onChange={(e) => setOpt(it.id, { flow: e.target.value as 'artists' | 'personal' | 'ignore' })}>
                {Object.entries(FLOW_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            Строк в файле {fmtInt(p.srcRows)} → после сложения дублей {fmtInt(p.aggRows)} · сумма <b>{fmtKop(p.rowsKop)}</b>
            {p.footerKop !== null && (p.footerOk
              ? <span className="badge ok">итог в файле сошёлся ✓</span>
              : <span className="badge bad">итог в файле {fmtKop(p.footerKop)}, разница {fmtKop(p.footerDiffKop)}</span>)}
          </div>
          <div className="dim" style={{ marginTop: 4 }}>{Object.entries(p.byStreamKind).map(([k, v]) => `${STREAM_LABELS[k] ?? k}: ${fmtKop(v.kop)}`).join(' · ')}</div>
          {!personal && (
            <div style={{ marginTop: 4 }}>
              Не найдено треков: {p.match.unmatchedTracks} ({fmtKop(p.match.unmatchedKop)}) · новых артистов: {p.match.unknownArtists}
              {p.match.notReportedKop > 0 && <> · Not reported: {fmtKop(p.match.notReportedKop)}</>}
              {p.match.isrcTwoDistributors > 0 && <> · ISRC у двух дистрибьюторов: {p.match.isrcTwoDistributors}</>}
            </div>
          )}
          {p.duplicateOf && <div className="err">Этот файл уже загружен: {p.duplicateOf.distributor}, {p.duplicateOf.quarter}, версия {p.duplicateOf.versionNo}. Он будет пропущен.</div>}
          {p.replaces && <div className="badge bad" style={{ marginTop: 6 }}>Заменит версию {p.replaces.versionNo} ({fmtInt(p.replaces.aggRows)} строк, {fmtKop(p.replaces.rowsKop)}) — старая уйдёт в архив</div>}
          {p.warnings.map((w, i) => <div key={i} className="dim">⚠ {w}</div>)}
        </>
      )}
    </div>
  );
}

function Wizard({ id, onCancel, onDone }: { id: string; onCancel: () => void; onDone: (it: ImportItem) => void }) {
  const [info, setInfo] = useState<WizardInfo | null>(null);
  const [err, setErr] = useState('');
  const load = (o: { sheet?: string; headerRow?: number }) => { setErr(''); call('wizard:info', { id, ...o }).then(setInfo).catch((e: Error) => setErr(e.message)); };
  useEffect(() => { load({}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return <div className="modal"><div className="dialog"><div className="err">{err}</div><button onClick={onCancel}>Назад</button></div></div>;
  const m = info.mapping;
  const setM = (patch: Partial<typeof m>) => setInfo({ ...info, mapping: { ...m, ...patch } });
  const setCol = (f: string, v: string) => {
    const cols = { ...m.columns } as Record<string, number>;
    if (v === '') delete cols[f]; else cols[f] = Number(v);
    setM({ columns: cols });
  };
  const save = async () => { setErr(''); try { onDone(await call('wizard:apply', { id, mapping: m })); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="modal"><div className="dialog">
      <h1>Новый формат отчёта</h1>
      <div className="grid2">
        <label className="f">Дистрибьютор (название)<input value={m.distributorName} onChange={(e) => setM({ distributorName: e.target.value })} /></label>
        <label className="f">Лист<select value={info.sheet} onChange={(e) => load({ sheet: e.target.value })}>{info.sheets.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label className="f">Строка с заголовками (номер)<input type="number" min={1} value={info.headerRow + 1} onChange={(e) => load({ sheet: info.sheet, headerRow: Math.max(0, Number(e.target.value) - 1) })} /></label>
        <label className="f">Права<select value={m.rightsType} onChange={(e) => setM({ rightsType: e.target.value as typeof m.rightsType })}>{Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f">Куда идут деньги<select value={m.flow} onChange={(e) => setM({ flow: e.target.value as typeof m.flow })}>{Object.entries(FLOW_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="f">Доля лицензиара от «Роялти» (1 = вся сумма, 0.7 = 70%)<input value={m.licensorShare} onChange={(e) => setM({ licensorShare: Number(e.target.value.replace(',', '.')) || 0 })} /></label>
      </div>
      <h3>Какая колонка что значит</h3>
      <div className="grid2">
        {Object.entries(info.fieldTitles).map(([f, title]) => (
          <label key={f} className="f">{title}{f === 'royalty' ? ' *' : ''}
            <select value={(m.columns as Record<string, number | undefined>)[f] ?? ''} onChange={(e) => setCol(f, e.target.value)}>
              <option value="">— нет —</option>
              {info.headers.map((h, i) => <option key={i} value={i}>{i + 1}. {h || '(пусто)'}</option>)}
            </select>
          </label>
        ))}
      </div>
      <h3>Первые строки</h3>
      <div style={{ overflow: 'auto', maxHeight: 200 }}>
        <table><thead><tr>{info.headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
          <tbody>{info.sample.map((r, i) => <tr key={i}>{info.headers.map((_, j) => <td key={j} className="dim">{r[j] === null || r[j] === undefined ? '' : String(r[j])}</td>)}</tr>)}</tbody></table>
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row end"><button onClick={onCancel}>Назад</button><button className="primary" onClick={save}>Запомнить формат и показать итог</button></div>
    </div></div>
  );
}
