import { useCallback, useEffect, useState } from 'react';
import type { TaxView } from '../../../main/tax/store.ts';
import type { TaxParams } from '../../../main/tax/calc.ts';
import { call } from '../api.ts';

const rub = (k: number): string => (k / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toKop = (v: string): number => Math.round(Number(v.replace(/[\s ]/g, '').replace(',', '.')) * 100);
const dmy = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const today = (): string => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const KIND = { fixed: 'Фиксированные взносы', extra: 'Взносы 1% свыше порога', usn: 'Налог УСН (аванс / год)' } as const;
const PER: Record<string, string> = { Q1: '1 квартал', H1: 'Полугодие', M9: '9 месяцев', Y: 'Год' };
const PARAM_LABELS: Array<[keyof TaxParams, string, 'rub' | 'pct']> = [
  ['ratePct', 'Ставка УСН, %', 'pct'], ['fixedKop', 'Фиксированные взносы за год, ₽', 'rub'], ['opsFixedKop', 'из них пенсионная часть, ₽ (нужна для потолка «1%»)', 'rub'],
  ['capKop', 'Предельный размер пенсионных взносов за год, ₽', 'rub'], ['extraFromKop', 'Порог дохода для «1%», ₽', 'rub'], ['extraPct', 'Ставка свыше порога, %', 'pct'],
];

export function Tax() {
  const [year, setYear] = useState<number | undefined>(undefined);
  const [v, setV] = useState<TaxView | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => { void call('tax:view', { year }).then(setV).catch((e: Error) => setErr(e.message)); }, [year]);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); setMsg(''); try { await fn(); load(); } catch (e) { setErr((e as Error).message); } };

  // поступление
  const [rDate, setRDate] = useState(today());
  const [rSum, setRSum] = useState('');
  const [rSrc, setRSrc] = useState('');
  const [rNote, setRNote] = useState('');
  // платёж
  const [pKind, setPKind] = useState<'fixed' | 'extra' | 'usn'>('usn');
  const [pPer, setPPer] = useState('Q1');
  const [pDate, setPDate] = useState(today());
  const [pSum, setPSum] = useState('');
  const [pNote, setPNote] = useState('');
  // параметры
  const [showParams, setShowParams] = useState(false);
  const [pr, setPr] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!v) return;
    setPr(Object.fromEntries(PARAM_LABELS.map(([k, , t]) => [k, t === 'rub' ? String(v.params[k] / 100) : String(v.params[k])])));
  }, [v]);

  if (!v) return <div className="dim">{err || 'Загрузка…'}</div>;
  const c = v.calc.contribs;
  const t = today();
  const prefillPay = (kind: 'fixed' | 'extra' | 'usn', per: string, kop: number) => { setPKind(kind); setPPer(per); setPSum((kop / 100).toFixed(2)); setPDate(t); document.getElementById('tax-pay')?.scrollIntoView({ behavior: 'smooth' }); };
  const quarterSums = [1, 2, 3, 4].map((q) => v.receipts.filter((r) => Math.ceil(Number(r.date.slice(5, 7)) / 3) === q).reduce((a, r) => a + r.kop, 0));

  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Налоги</h1>
        <select style={{ maxWidth: 120 }} value={v.year} onChange={(e) => setYear(Number(e.target.value))}>{v.years.map((y) => <option key={y} value={y}>{y} год</option>)}</select>
        <div className="grow" />
        <button onClick={() => void run(async () => { const p = await call('tax:export', { year: v.year }); await call('payouts:open', { path: p }); setMsg(`Файл для бухгалтера: ${p}`); })}>Выгрузить для бухгалтера</button>
      </div>
      <div className="warn">Расчёт для ИП на УСН «Доходы» {v.params.ratePct}% без работников: налог уменьшается на взносы вплоть до нуля. Доход считается по дате получения денег — поступления вносятся вручную, в том числе за прошлые кварталы. Перед уплатой сверяйте цифры с бухгалтером.</div>
      {err && <div className="err">{err}</div>}{msg && <div className="okmsg">{msg}</div>}

      <div className="cards">
        <div className="card"><div className="n" style={{ fontSize: 20 }}>{rub(v.calc.totalIncomeKop)} ₽</div><div className="l">Доход за {v.year} год</div></div>
        <div className="card"><div className="n" style={{ fontSize: 20 }}>{rub(v.calc.periods[3]!.taxKop)} ₽</div><div className="l">Налог {v.params.ratePct}% до зачёта взносов</div></div>
        <div className="card"><div className="n" style={{ fontSize: 20 }}>{rub(v.calc.periods[3]!.netKop)} ₽</div><div className="l">Налог за год после зачёта</div></div>
        <div className="card"><div className="n" style={{ fontSize: 20 }}>{rub(c.fixedLeftKop + c.extraLeftKop)} ₽</div><div className="l">Взносов осталось уплатить</div></div>
      </div>

      <h3>Налог УСН по периодам</h3>
      <table>
        <thead><tr><th>Период</th><th style={{ textAlign: 'right' }}>Доход нарастающим</th><th style={{ textAlign: 'right' }}>Налог</th><th style={{ textAlign: 'right' }}>Зачтено взносов</th><th style={{ textAlign: 'right' }}>К уплате за период</th><th style={{ textAlign: 'right' }}>Уплачено</th><th style={{ textAlign: 'right' }}>Осталось</th><th>Срок</th><th /></tr></thead>
        <tbody>{v.calc.periods.map((p) => {
          const late = p.leftKop > 0 && p.due < t;
          return (
            <tr key={p.key} className={late ? 'redrow' : undefined}>
              <td>{p.label}</td><td style={{ textAlign: 'right' }}>{rub(p.incomeKop)}</td><td style={{ textAlign: 'right' }}>{rub(p.taxKop)}</td><td style={{ textAlign: 'right' }}>{rub(p.deductKop)}</td>
              <td style={{ textAlign: 'right' }}><b>{rub(p.toPayKop)}</b>{p.overKop > 0 && <div className="dim" style={{ fontSize: 11 }}>к уменьшению {rub(p.overKop)}</div>}</td>
              <td style={{ textAlign: 'right' }}>{rub(p.paidKop)}</td><td style={{ textAlign: 'right' }}>{p.leftKop > 0 ? <span className={'badge' + (late ? ' bad' : '')}>{rub(p.leftKop)}</span> : <span className="badge ok">✓</span>}</td>
              <td>{dmy(p.due)}{late && <div className="badge bad">просрочено</div>}</td>
              <td>{p.leftKop > 0 && <button className="link" onClick={() => prefillPay('usn', p.key, p.leftKop)}>отметить уплату</button>}</td>
            </tr>
          );
        })}</tbody>
      </table>

      <h3>Взносы за себя</h3>
      <table>
        <thead><tr><th>Вид</th><th style={{ textAlign: 'right' }}>Начислено</th><th style={{ textAlign: 'right' }}>Уплачено</th><th style={{ textAlign: 'right' }}>Осталось</th><th>Срок</th><th /></tr></thead>
        <tbody>
          <tr><td>Фиксированные</td><td style={{ textAlign: 'right' }}>{rub(c.fixedKop)}</td><td style={{ textAlign: 'right' }}>{rub(c.fixedPaidKop)}</td><td style={{ textAlign: 'right' }}>{rub(c.fixedLeftKop)}</td><td>{dmy(c.fixedDue)}</td><td>{c.fixedLeftKop > 0 && <button className="link" onClick={() => prefillPay('fixed', '', c.fixedLeftKop)}>отметить уплату</button>}</td></tr>
          <tr><td>{v.params.extraPct}% с дохода свыше {rub(v.params.extraFromKop)} ₽<div className="dim" style={{ fontSize: 11 }}>не больше {rub(c.extraCapKop)} ₽</div></td><td style={{ textAlign: 'right' }}>{rub(c.extraKop)}</td><td style={{ textAlign: 'right' }}>{rub(c.extraPaidKop)}</td><td style={{ textAlign: 'right' }}>{rub(c.extraLeftKop)}</td><td>{dmy(c.extraDue)}</td><td>{c.extraLeftKop > 0 && <button className="link" onClick={() => prefillPay('extra', '', c.extraLeftKop)}>отметить уплату</button>}</td></tr>
        </tbody>
      </table>
      <p className="dim">Платёж записывается в год, выбранный вверху, и уменьшает налог этого года. Например, «1%» за прошлый год, уплаченный в июле, вносите в год, в котором хотите его зачесть.</p>

      <h3>Поступления {v.year} года</h3>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="f" style={{ width: 150 }}>Дата получения<input type="date" value={rDate} onChange={(e) => setRDate(e.target.value)} /></label>
        <label className="f" style={{ width: 150 }}>Сумма, ₽<input value={rSum} onChange={(e) => setRSum(e.target.value)} placeholder="0,00" /></label>
        <label className="f" style={{ width: 200 }}>Откуда<input list="tax-src" value={rSrc} onChange={(e) => setRSrc(e.target.value)} placeholder="дистрибьютор" /></label>
        <datalist id="tax-src">{v.sources.map((s) => <option key={s} value={s} />)}</datalist>
        <label className="f" style={{ width: 220 }}>Примечание<input value={rNote} onChange={(e) => setRNote(e.target.value)} /></label>
        <button className="primary" disabled={!rSum.trim()} onClick={() => void run(async () => { await call('tax:addReceipt', { date: rDate, kop: toKop(rSum), source: rSrc, note: rNote }); setRSum(''); setRNote(''); })}>Добавить поступление</button>
      </div>
      <div className="dim" style={{ marginBottom: 6 }}>По кварталам: {quarterSums.map((k, i) => `${i + 1} кв. — ${rub(k)} ₽`).join(' · ')}</div>
      {v.receipts.length === 0 ? <div className="drop">Поступлений за {v.year} год нет. Внесите деньги, которые лейбл получил от дистрибьюторов (по дате зачисления на счёт).</div> : (
        <table>
          <thead><tr><th>Дата</th><th style={{ textAlign: 'right' }}>Сумма, ₽</th><th>Откуда</th><th>Примечание</th><th /></tr></thead>
          <tbody>{v.receipts.map((r) => (
            <tr key={r.id}><td>{dmy(r.date)}</td><td style={{ textAlign: 'right' }}>{rub(r.kop)}</td><td>{r.source}</td><td className="dim">{r.note}</td>
              <td><button className="link" onClick={() => { if (confirm(`Удалить поступление ${rub(r.kop)} ₽ от ${dmy(r.date)}?`)) void run(() => call('tax:delReceipt', { id: r.id })); }}>удалить</button></td></tr>))}</tbody>
        </table>
      )}

      <h3 id="tax-pay">Платежи по налогу и взносам</h3>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="f" style={{ width: 230 }}>Что оплачено<select value={pKind} onChange={(e) => setPKind(e.target.value as typeof pKind)}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {pKind === 'usn' && <label className="f" style={{ width: 150 }}>За период<select value={pPer} onChange={(e) => setPPer(e.target.value)}>{Object.entries(PER).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
        <label className="f" style={{ width: 150 }}>Дата платежа<input type="date" value={pDate} onChange={(e) => setPDate(e.target.value)} /></label>
        <label className="f" style={{ width: 150 }}>Сумма, ₽<input value={pSum} onChange={(e) => setPSum(e.target.value)} placeholder="0,00" /></label>
        <label className="f" style={{ width: 200 }}>Примечание<input value={pNote} onChange={(e) => setPNote(e.target.value)} /></label>
        <button className="primary" disabled={!pSum.trim()} onClick={() => void run(async () => { await call('tax:addPayment', { year: v.year, kind: pKind, period: pKind === 'usn' ? pPer : null, date: pDate, kop: toKop(pSum), note: pNote }); setPSum(''); setPNote(''); })}>Добавить платёж</button>
      </div>
      {v.payments.length === 0 ? <div className="dim">Платежей за {v.year} год пока нет.</div> : (
        <table>
          <thead><tr><th>Дата</th><th>Вид</th><th>Период</th><th style={{ textAlign: 'right' }}>Сумма, ₽</th><th>Примечание</th><th /></tr></thead>
          <tbody>{v.payments.map((p) => (
            <tr key={p.id}><td>{dmy(p.date)}</td><td>{KIND[p.kind]}</td><td>{p.period ? PER[p.period] : ''}</td><td style={{ textAlign: 'right' }}>{rub(p.kop)}</td><td className="dim">{p.note}</td>
              <td><button className="link" onClick={() => { if (confirm(`Удалить платёж ${rub(p.kop)} ₽ от ${dmy(p.date)}?`)) void run(() => call('tax:delPayment', { id: p.id })); }}>удалить</button></td></tr>))}</tbody>
        </table>
      )}

      <h3><button className="link" onClick={() => setShowParams(!showParams)}>{showParams ? '▾' : '▸'} Параметры {v.year} года</button>{v.defaults && <span className="badge" style={{ marginLeft: 8 }}>стандартные, проверьте</span>}</h3>
      {showParams && (
        <>
          <div className="grid2">{PARAM_LABELS.map(([k, label]) => <label key={k} className="f">{label}<input value={pr[k] ?? ''} onChange={(e) => setPr({ ...pr, [k]: e.target.value })} /></label>)}</div>
          <div className="row end"><button className="primary" onClick={() => void run(async () => {
            const params = Object.fromEntries(PARAM_LABELS.map(([k, , tp]) => [k, tp === 'rub' ? toKop(pr[k] ?? '') : Number((pr[k] ?? '').replace(',', '.'))])) as unknown as TaxParams;
            await call('tax:setParams', { year: v.year, params }); setMsg('Параметры сохранены');
          })}>Сохранить параметры</button></div>
          <p className="dim">Размеры взносов и пороги меняются каждый год — при смене правил поправьте здесь, обновлять программу не нужно. Пенсионная часть фиксированных взносов по умолчанию принята как 1/8 от предельного размера — сверьте с бухгалтером.</p>
        </>
      )}
    </>
  );
}
