import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ArtistListItem, GenerateResult, OpeningPreview, PayoutRow, PayoutsView, Problem } from '../../../shared/api.ts';
import type { OpeningListItem } from '../../../main/payouts/opening.ts';
import { SearchSelect } from '../SearchSelect.tsx';
import { call } from '../api.ts';
import { useNav } from '../nav.tsx';
import { norm, useSort } from '../sort.tsx';
import { fmtInt, fmtKop, kopToInput, quarterLabel } from '../util.ts';

const PROBLEM_TITLES: Record<Problem['kind'], string> = {
  no_track: 'Строки без трека', no_participation: 'Трек без участников', no_rate: 'Нет ставки лейбла', no_payee: 'Нет получателя',
  mixed_share_mismatch: 'Разные доли авт./смеж.', opening_unassigned: 'Остаток без человека', no_contract: 'Нет договора', no_threshold_contract: 'Нет порога выплаты',
};
const STATUS: Record<PayoutRow['status'], string> = { draft: 'черновик', ready: 'готово', paid: 'выплачено' };
const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function Payouts({ onChanged }: { onChanged: () => void }) {
  const [quarter, setQuarter] = useState<string | undefined>(undefined);
  const [view, setView] = useState<PayoutsView | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<PayoutRow | null>(null);
  const [gen, setGen] = useState<PayoutRow[] | null>(null);
  const [fq, setFq] = useState('');
  const [opening, setOpening] = useState(false);
  const [delRow, setDelRow] = useState<PayoutRow | null>(null);
  const nav = useNav();
  const filtered = (view?.rows ?? []).filter((r) => !fq.trim() || norm(`${r.payeeName} ${r.contractNumber ?? ''} ${r.artists.map((a) => a.name).join(' ')}`).includes(norm(fq.trim())));
  const { sorted, th } = useSort(filtered, { payee: (r) => r.payeeName, contract: (r) => r.contractNumber, accrued: (r) => r.accruedKop, carriedIn: (r) => r.carriedInKop, payable: (r) => r.payableKop, carriedOut: (r) => r.carriedOutKop, status: (r) => r.status, stmt: (r) => r.statement?.versionNo ?? 0 });
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
        <input style={{ maxWidth: 260 }} placeholder="Поиск по ФИО, договору, артисту…" value={fq} onChange={(e) => setFq(e.target.value)} />
        <div className="grow" />
        <button onClick={() => setOpening(true)} title="Остатки по артистам из прежнего учёта: войдут в выплаты человека и в порог">Входящие остатки…</button>
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
                  <td>{(p.kind === 'no_track') && <button className="link" onClick={() => nav.go('issues', {})}>Исправить в «Проверить» →</button>}
                  {(p.kind === 'no_contract') && <button className="link" onClick={() => nav.go('contracts', {})}>Создать договор →</button>}
                  {(p.kind === 'opening_unassigned') && <button className="link" onClick={() => setOpening(true)}>Привязать остаток →</button>}
                  {(p.kind === 'no_payee') && <button className="link" onClick={() => nav.go('artists', {})}>Привязать артиста к человеку →</button>}
                  {(p.kind === 'no_participation' || p.kind === 'no_rate' || p.kind === 'mixed_share_mismatch') && <button className="link" onClick={() => nav.go('tracks', {})}>Открыть треки →</button>}
                  {(p.kind === 'no_threshold_contract') && <button className="link" onClick={() => nav.go('contracts', {})}>Открыть договоры →</button>}</td></tr>))}</tbody></table>
            </>
          )}
          <h3>Получатели за {quarterLabel(view.quarter)}</h3>
          <table>
            <thead><tr>{th('payee', 'Получатель')}{th('contract', 'Договор')}{th('accrued', 'Начислено', { textAlign: 'right' })}{th('carriedIn', 'Перенос с прошлых', { textAlign: 'right' })}{th('payable', 'К выплате', { textAlign: 'right' })}{th('carriedOut', 'Переносится дальше', { textAlign: 'right' })}{th('status', 'Статус')}{th('stmt', 'Комплект')}<th /></tr></thead>
            <tbody>{sorted.map((r) => (
              <Fragment key={r.key}>
                <tr>
                  <td><button className="link" style={{ padding: 0 }} onClick={() => setOpen(open === r.key ? null : r.key)}>{open === r.key ? '▾' : '▸'}</button> {r.payeeName}</td>
                  <td>{r.contractNumber ?? <button className="badge bad" title="Создать договор для этого получателя" onClick={() => nav.go('contracts', { contractFor: r.payeeId })}>нет договора — создать</button>}</td>
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
                    {r.statement && <button className="link" title="Удалить последний выданный комплект (файлы тоже)" onClick={() => setDelRow(r)}>удалить комплект</button>}
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
      {opening && <OpeningDialog onClose={(ch) => { setOpening(false); if (ch) after(); }} />}
      {delRow && (
        <div className="modal"><div className="dialog" style={{ maxWidth: 520 }}>
          <h2>Удалить комплект?</h2>
          <p>{delRow.payeeName} · {quarterLabel(view.quarter)} · версия {delRow.statement!.versionNo}<br />Файлы PDF и Excel этой версии будут стёрты. Если была более ранняя версия, она снова станет текущей. Потом можно сформировать комплект заново.</p>
          <div className="row end"><button onClick={() => setDelRow(null)}>Отмена</button><button className="primary" onClick={async () => {
            try { await call('payouts:deleteStatement', { quarter: view.quarter, groupKey: delRow.key }); setDelRow(null); after(); } catch (e) { setErr((e as Error).message); setDelRow(null); }
          }}>Удалить</button></div>
        </div></div>
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
  const [round, setRound] = useState<'down' | 'up' | 'nearest'>('down');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<GenerateResult[] | null>(null);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { setRes(await call('payouts:generate', { quarter, groupKeys: rows.map((r) => r.key), city, date, round })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 640 }}>
      <h2>Комплект: Excel + PDF-ведомость</h2>
      <div className="dim">{rows.length === 1 ? rows[0]!.payeeName : `Получателей: ${rows.length}`} · {quarterLabel(quarter)}</div>
      {!res && (
        <div className="grid2" style={{ margin: '10px 0' }}>
          <label className="f">Город в ведомости<input value={city} onChange={(e) => setCity(e.target.value)} /></label>
          <label className="f">Дата ведомости<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="f">Округление итога
            <select value={round} onChange={(e) => setRound(e.target.value as typeof round)}>
              <option value="down">Вниз до копейки</option>
              <option value="up">Вверх до копейки</option>
              <option value="nearest">Математически</option>
            </select>
          </label>
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
      <p className="dim">Все расчёты идут без округления; итог на получателя округляется один раз, при формировании. Файлы лягут в папку «output» по кварталам. Старые версии комплекта остаются.</p>
      <div className="row end">
        <button onClick={() => onClose(!!res)}>{res ? 'Закрыть' : 'Отмена'}</button>
        {!res && <button className="primary" disabled={busy} onClick={go}>{busy ? 'Формирую…' : 'Сформировать'}</button>}
      </div>
    </div></div>
  );
}

const rub = (kop: number): string => (kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toKop = (v: string): number => Math.round(Number(v.replace(/[\s\u00a0]/g, '').replace(',', '.')) * 100);

function OpeningDialog({ onClose }: { onClose: (changed: boolean) => void }) {
  const nav = useNav();
  const [list, setList] = useState<OpeningListItem[]>([]);
  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [pv, setPv] = useState<OpeningPreview | null>(null);
  const [vals, setVals] = useState<string[]>([]);
  const [arts, setArts] = useState<Array<string | null>>([]);
  const [quarter, setQuarter] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [changed, setChanged] = useState(false);
  const load = useCallback(() => { void call('opening:list').then(setList); void call('artists:list', {}).then(setArtists); }, []);
  useEffect(load, [load]);
  const opts = artists.map((a) => ({ value: a.id, label: a.name, hint: a.person ?? 'без человека' }));
  const pick = async () => {
    setErr(''); setMsg('');
    try {
      const r = await call('opening:pick');
      if (!r) return;
      setPv(r); setVals(r.rows.map((x) => (x.fileKop / 100).toFixed(2))); setArts(r.rows.map((x) => x.match.artistId));
      setQuarter(r.quarterGuess ?? r.quarters[0] ?? '');
    } catch (e) { setErr((e as Error).message); }
  };
  const total = pv ? pv.rows.reduce((a, _r, i) => a + (Number.isFinite(toKop(vals[i] ?? '')) ? toKop(vals[i] ?? '') : 0), 0) : 0;
  const save = async () => {
    if (!pv) return;
    setErr('');
    try {
      const items = pv.rows.map((r, i) => ({ name: r.name, kop: toKop(vals[i] ?? ''), artistId: arts[i] ?? null })).filter((x) => Number.isFinite(x.kop) && x.kop !== 0);
      const r = await call('opening:commit', { quarter, items });
      setMsg(`Загружено остатков: ${r.saved} на ${rub(r.totalKop)} ₽${r.replaced ? `, заменено прежних: ${r.replaced}` : ''}`);
      setPv(null); setChanged(true); load();
    } catch (e) { setErr((e as Error).message); }
  };
  const quarters = pv ? [...new Set([...(pv.quarterGuess ? [pv.quarterGuess] : []), ...pv.quarters])] : [];
  const unassigned = list.filter((l) => !l.personId);
  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 980 }}>
      <h2>Входящие остатки</h2>
      <p className="dim">Остаток считается на человека: артист из файла сопоставляется по имени и «другим написаниям», выплата идёт человеку, к которому артист привязан (сейчас или позже). Остаток входит в перенос квартала и в проверку порога выплаты.</p>
      {err && <div className="err">{err}</div>}{msg && <div className="okmsg">{msg}</div>}
      {!pv && (<>
        <div className="row"><button className="primary" onClick={pick}>Загрузить Excel…</button><div className="grow" />{unassigned.length > 0 && <span className="badge bad">без человека: {unassigned.length}</span>}</div>
        {list.length > 0 && (
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>Квартал</th><th>Из файла</th><th>Артист</th><th>Получатель</th><th style={{ textAlign: 'right' }}>Сумма, ₽</th><th /></tr></thead>
            <tbody>{list.map((l) => (
              <tr key={l.id} className={l.personId ? undefined : 'redrow'}>
                <td>{quarterLabel(l.quarter)}</td><td>{l.name}</td>
                <td><SearchSelect width={200} options={opts} value={l.artistId ?? ''} empty="— не выбран —" onChange={(v) => void call('opening:update', { id: l.id, artistId: v || null }).then(() => { setChanged(true); load(); }).catch((e: Error) => setErr(e.message))} /></td>
                <td>{l.person ?? <button className="badge bad" onClick={() => { onClose(changed); nav.go('artists', { query: l.artist ?? l.name }); }}>привязать артиста к человеку</button>}</td>
                <td style={{ textAlign: 'right' }}>{rub(l.kop)}</td>
                <td><button className="link" onClick={() => { if (confirm(`Удалить остаток «${l.name}»?`)) void call('opening:delete', { id: l.id }).then(() => { setChanged(true); load(); }); }}>удалить</button></td>
              </tr>))}</tbody>
          </table>
        )}
        {list.length === 0 && <div className="drop" style={{ marginTop: 10 }}>Остатков пока нет. Загрузите Excel: лист с колонками «Артист» и «Входящий остаток».</div>}
      </>)}
      {pv && (<>
        <div className="row" style={{ marginBottom: 8 }}>
          <b>{pv.fileName}</b><span className="dim">лист «{pv.sheet}», в файле {rub(pv.totalKop)} ₽</span><div className="grow" />
          <label className="row">Остаток действует с квартала:<select value={quarter} onChange={(e) => setQuarter(e.target.value)}>{quarters.map((q) => <option key={q} value={q}>{quarterLabel(q)}</option>)}</select></label>
        </div>
        {pv.existing > 0 && <div className="err">Уже загружено остатков: {pv.existing}. Остатки за выбранный квартал, загруженные ранее из файла, будут заменены.</div>}
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table>
            <thead><tr><th>Артист в файле</th><th>Артист в каталоге</th><th>Получатель</th><th style={{ textAlign: 'right' }}>Остаток, ₽</th><th /></tr></thead>
            <tbody>{pv.rows.map((r, i) => {
              const bad = !arts[i] || (r.match.artistId === arts[i] && !r.match.personId && arts[i] === r.match.artistId);
              const person = arts[i] === r.match.artistId ? r.match.person : artists.find((a) => a.id === arts[i])?.person ?? null;
              return (
                <tr key={i} className={r.mismatch || (!person && Number(vals[i]) !== 0) ? 'redrow' : undefined}>
                  <td>{r.name}{r.match.note && <div className="dim" style={{ fontSize: 11 }}>{r.match.note}</div>}</td>
                  <td><SearchSelect width={210} options={opts} value={arts[i] ?? ''} empty="— не выбран —" onChange={(v) => setArts(arts.map((x, j) => (j === i ? v || null : x)))} /></td>
                  <td>{person ?? <span className={'badge' + (bad ? ' bad' : '')}>{arts[i] ? 'артист без человека — привяжете позже' : 'не найден'}</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <input style={{ width: 100, textAlign: 'right' }} value={vals[i] ?? ''} onChange={(e) => setVals(vals.map((x, j) => (j === i ? e.target.value : x)))} />
                    {r.mismatch && r.formulaKop !== null && <div style={{ fontSize: 11 }}><span className="dim">по формуле файла: </span><button className="link" onClick={() => setVals(vals.map((x, j) => (j === i ? (r.formulaKop! / 100).toFixed(2) : x)))}>{rub(r.formulaKop)}</button></div>}
                  </td>
                  <td>{r.mismatch && <span className="badge bad" title="Остаток в файле не равен «входящий + начислено − к выплате»">не сходится</span>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 8 }}><span>Будет загружено: <b>{rub(total)} ₽</b></span><div className="grow" /><span className="dim">нулевые строки пропускаются; строки без человека сохранятся и будут подсвечены</span></div>
        <div className="row end"><button onClick={() => setPv(null)}>Назад</button><button className="primary" disabled={!quarter} onClick={save}>Загрузить остатки</button></div>
      </>)}
      {!pv && <div className="row end"><button onClick={() => onClose(changed)}>Закрыть</button></div>}
    </div></div>
  );
}
