import { Fragment, useCallback, useEffect, useState } from 'react';
import type { GenerateResult, PayoutRow, PayoutsView, Problem } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { fmtInt, fmtKop, kopToInput, quarterLabel } from '../util.ts';

const PROBLEM_TITLES: Record<Problem['kind'], string> = {
  no_track: 'Строки без трека', no_participation: 'Трек без участников', no_rate: 'Нет ставки лейбла', no_payee: 'Нет получателя',
  mixed_share_mismatch: 'Разные доли авт./смеж.', no_contract: 'Нет договора', no_threshold_contract: 'Нет порога выплаты',
};
const STATUS: Record<PayoutRow['status'], string> = { draft: 'черновик', ready: 'готово', paid: 'выплачено' };
const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function Payouts({ onChanged, goto }: { onChanged: () => void; goto: (t: string) => void }) {
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const [view, setView] = useState<PayoutsView | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayoutRow | null>(null);
  const [gen, setGen] = useState<PayoutRow[] | null>(null);
  const load = useCallback(() => { void call('payouts:view', { quarter }).then(setView).catch((e: Error) => setErr(e.message)); }, [quarter]);
  useEffect(load, [load]);
  if (!view) return <div className="dim">Загрузка…</div>;
  const t = view.calc.totals;
  const after = () => { load(); onChanged(); };
  const ready = view.rows.filter((r) => r.contractId);
  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Выплаты</h1>
        {view.quarters.length > 0 && (
          <select style={{ maxWidth: 170 }} value={view.quarter} onChange={(e) => setQuarter(e.target.value)}>
            {view.quarters.map((q) => <option key={q} value={q}>{quarterLabel(q)}</option>)}
          </select>
        )}
        <div className="grow" />
        <button className="primary" disabled={ready.length === 0} onClick={() => setGen(ready)}>Сформировать комплекты для всех ({ready.length})</button>
      </div>
      {err && <div className="err">{err}</div>}
      {view.quarters.length === 0 && <div className="drop">Нет отчётов с маршрутом «Приход лейбла». Загрузите отчёты во вкладке «Отчёты».</div>}
      {view.quarters.length > 0 && (
        <>
          <div className="cards">
            <div className="card"><div className="n" style={{ fontSize: 20 }}>{fmtKop(t.flowRoyaltyKop)}</div><div className="l">Приход лейбла (роялти по отчётам)</div></div>
            <div className="card"><div className="n" style={{ fontSize: 20 }}>{fmtKop(t.accruedKop)}</div><div className="l">Начислено получателям</div></div>
            <div className="card"><div className="n" style={{ fontSize: 20 }}>{fmtKop(t.payableKop)}</div><div className="l">К выплате в этом квартале</div></div>
            <div className="card"><div className="n" style={{ fontSize: 20 }}>{fmtKop(t.marginKop)}</div><div className="l">Остаётся лейблу (с распределённого)</div></div>
            <div className="card" style={t.unallocatedKop > 0 ? { borderColor: 'var(--bad)' } : undefined}>
              <div className="n" style={{ fontSize: 20, color: t.unallocatedKop > 0 ? 'var(--bad)' : undefined }}>{fmtKop(t.unallocatedKop)}</div><div className="l">Не распределено (нет трека, участника или ставки)</div>
            </div>
          </div>
          {view.calc.problems.length > 0 && (
            <>
              <h3>Что мешает посчитать полностью</h3>
              <table><tbody>{view.calc.problems.map((p, i) => (
                <tr key={i}><td><span className="badge bad">{PROBLEM_TITLES[p.kind]}</span></td><td>{p.text}</td>
                  <td className="dim">{p.rows > 0 ? `${fmtInt(p.rows)} строк, ${fmtKop(p.royaltyKop)}` : ''}</td>
                  <td>{(p.kind === 'no_track') && <button className="link" onClick={() => goto('issues')}>в «Проверить»</button>}</td></tr>))}</tbody></table>
            </>
          )}
          <h3>Получатели за {quarterLabel(view.quarter)}</h3>
          <table>
            <thead><tr><th>Получатель</th><th>Договор</th><th style={{ textAlign: 'right' }}>Начислено</th><th style={{ textAlign: 'right' }}>Перенос с прошлых</th><th style={{ textAlign: 'right' }}>К выплате</th><th style={{ textAlign: 'right' }}>Переносится дальше</th><th>Статус</th><th>Комплект</th><th /></tr></thead>
            <tbody>{view.rows.map((r) => (
              <Fragment key={r.key}>
                <tr>
                  <td><button className="link" style={{ padding: 0 }} onClick={() => setOpen(open === r.key ? null : r.key)}>{open === r.key ? '▾' : '▸'}</button> {r.payeeName}</td>
                  <td>{r.contractNumber ?? <span className="badge bad">нет договора</span>}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKop(r.accruedKop)}</td>
                  <td style={{ textAlign: 'right' }} className="dim">{r.carriedInKop ? fmtKop(r.carriedInKop) : ''}</td>
                  <td style={{ textAlign: 'right' }}><b>{fmtKop(r.payableKop)}</b></td>
                  <td style={{ textAlign: 'right' }}>{r.thresholdApplied && <span className="badge" title={`Ниже порога ${fmtKop(r.thresholdKop)}`}>{fmtKop(r.carriedOutKop)}</span>}</td>
                  <td><span className={'badge' + (r.status === 'paid' ? ' ok' : '')}>{STATUS[r.status]}</span>{r.status === 'paid' && <div className="dim" style={{ fontSize: 11 }}>{fmtKop(r.paidKop)} · {r.paidDate}</div>}</td>
                  <td>{r.statement ? <><span className={'badge' + (r.statement.stale ? ' bad' : ' ok')}>v{r.statement.versionNo}{r.statement.stale ? ' · устарел' : ''}</span>
                    {r.statement.pdfFile && <button className="link" onClick={() => void call('payouts:open', { path: r.statement!.pdfFile! })}>PDF</button>}
                    {r.statement.xlsxFile && <button className="link" onClick={() => void call('payouts:open', { path: r.statement!.xlsxFile! })}>Excel</button>}</> : <span className="dim">не выдан</span>}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="link" disabled={!r.contractId} title={r.contractId ? '' : 'Нужен договор у получателя'} onClick={() => setGen([r])}>{r.statement ? (r.statement.stale ? 'пересоздать' : 'ещё версия') : 'сформировать'}</button>
                    <button className="link" onClick={() => setPaying(r)}>выплата</button>
                  </td>
                </tr>
                {open === r.key && (
                  <tr><td colSpan={9} style={{ background: 'var(--panel)' }}>
                    <div className="dim">Строк в комплекте: {fmtInt(r.rows)} · стримов {fmtInt(r.qty)} · доля получателя в роялти {fmtKop(r.royaltyKop)} · средняя ставка лейбла {r.labelRatePct || '—'}% · остаётся лейблу {fmtKop(r.marginKop)}</div>
                    <div style={{ marginTop: 4 }}>{r.artists.map((a) => <span key={a.artistId} className="badge">{a.name}: {fmtInt(a.rows)} строк</span>)}</div>
                  </td></tr>
                )}
              </Fragment>
            ))}</tbody>
          </table>
        </>
      )}
      {paying && <PayDialog row={paying} quarter={view.quarter} onClose={(ch) => { setPaying(null); if (ch) after(); }} />}
      {gen && <GenDialog rows={gen} quarter={view.quarter} onClose={(ch) => { setGen(null); if (ch) after(); }} />}
    </>
  );
}

function PayDialog({ row, quarter, onClose }: { row: PayoutRow; quarter: string; onClose: (changed: boolean) => void }) {
  const [status, setStatus] = useState<PayoutRow['status']>(row.status);
  const [amount, setAmount] = useState(kopToInput(row.paidKop ?? row.payableKop));
  const [date, setDate] = useState(row.paidDate ?? today());
  const [err, setErr] = useState('');
  const save = async () => {
    try {
      const kop = Math.round(Number(amount.replace(/[\s ]/g, '').replace(',', '.')) * 100);
      await call('payouts:mark', { quarter, groupKey: row.key, status, paidKop: status === 'paid' ? kop : null, paidDate: status === 'paid' ? date : null });
      onClose(true);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 480 }}>
      <h2>Выплата: {row.payeeName}</h2>
      <div className="dim">К выплате по расчёту {fmtKop(row.payableKop)}</div>
      <div className="grid2" style={{ marginTop: 10 }}>
        <label className="f">Статус<select value={status} onChange={(e) => setStatus(e.target.value as PayoutRow['status'])}><option value="draft">Черновик</option><option value="ready">Готово к выплате</option><option value="paid">Выплачено</option></select></label>
        {status === 'paid' && <label className="f">Выплачено, ₽<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
        {status === 'paid' && <label className="f">Дата выплаты<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row end"><button onClick={() => onClose(false)}>Отмена</button><button className="primary" onClick={save}>Сохранить</button></div>
    </div></div>
  );
}

function GenDialog({ rows, quarter, onClose }: { rows: PayoutRow[]; quarter: string; onClose: (changed: boolean) => void }) {
  const [city, setCity] = useState('Санкт-Петербург');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<GenerateResult[] | null>(null);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { setRes(await call('payouts:generate', { quarter, groupKeys: rows.map((r) => r.key), city, date })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 640 }}>
      <h2>Комплект: Excel + PDF-ведомость</h2>
      <div className="dim">{rows.length === 1 ? rows[0]!.payeeName : `Получателей: ${rows.length}`} · {quarterLabel(quarter)}</div>
      {!res && (
        <div className="grid2" style={{ margin: '10px 0' }}>
          <label className="f">Город в ведомости<input value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <label className="f">Дата ведомости<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {res && res.map((r) => (
        <div key={r.groupKey} className={r.ok ? 'okmsg' : 'err'}>
          {r.ok ? '✓' : '✗'} {r.payee}{r.ok ? ` — версия ${r.versionNo}` : `: ${r.error}`}
          {r.ok && r.pdf && <button className="link" onClick={() => void call('payouts:open', { path: r.pdf! })}>PDF</button>}
          {r.ok && r.xlsx && <button className="link" onClick={() => void call('payouts:open', { path: r.xlsx! })}>Excel</button>}
        </div>
      ))}
      <p className="dim">Файлы лягут в папку «output» по кварталам. Старые версии комплекта остаются.</p>
      <div className="row end">
        <button onClick={() => onClose(!!res)}>{res ? 'Закрыть' : 'Отмена'}</button>
        {!res && <button className="primary" disabled={busy} onClick={go}>{busy ? 'Формирую…' : 'Сформировать'}</button>}
      </div>
    </div></div>
  );
}
