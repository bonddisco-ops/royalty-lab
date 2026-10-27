import { useEffect, useState } from 'react';
import type { BatchItem, BulkAction, BulkPlan, LineFilter, StreamKind, UiField } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { STREAM_SHORT, fmtInt, fmtKop } from '../util.ts';

type Kind = 'set' | 'change' | 'move';
const SET_FIELDS: Array<[UiField, string]> = [['stream_kind', 'Тип стрима'], ['usage_type', 'Вид использования'], ['qty', 'Тираж'], ['royalty', 'Роялти, ₽'], ['rate', 'Ставка, ₽ за прослушивание']];
const CHANGE_FIELDS: Array<['qty' | 'royalty' | 'rate', string]> = [['royalty', 'Роялти'], ['qty', 'Тираж'], ['rate', 'Ставка за прослушивание']];

export function describeAction(a: BulkAction): string {
  if (a.type === 'set') return `Задать «${SET_FIELDS.find(([k]) => k === a.field)?.[1] ?? a.field}» = ${a.field === 'stream_kind' ? STREAM_SHORT[a.value] ?? a.value : a.value}`;
  if (a.type === 'change') return `${CHANGE_FIELDS.find(([k]) => k === a.field)?.[1]}: ${a.mode === 'percent' ? `${a.value}%` : `${a.value.trim().startsWith('-') ? '' : '+'}${a.value.trim()}`}`;
  return `Перенести ${a.value}${a.by === 'percent' ? '%' : ' шт.'} прослушиваний в «${STREAM_SHORT[a.toKind]}»${a.rate ? ` по ${a.rate} ₽` : ''}`;
}

export function BulkDialog({ filter, total, onClose }: { filter: LineFilter; total: number; onClose: (changed: boolean) => void }) {
  const [kind, setKind] = useState<Kind>('change');
  const [setField, setSetField] = useState<UiField>('stream_kind');
  const [setValue, setSetValue] = useState('ad');
  const [chField, setChField] = useState<'qty' | 'royalty' | 'rate'>('royalty');
  const [chMode, setChMode] = useState<'percent' | 'amount'>('percent');
  const [chValue, setChValue] = useState('');
  const [mvBy, setMvBy] = useState<'qty' | 'percent'>('percent');
  const [mvValue, setMvValue] = useState('');
  const [mvKind, setMvKind] = useState<StreamKind>('ad');
  const [mvRate, setMvRate] = useState('');
  const [plan, setPlan] = useState<Omit<BulkPlan, 'items'> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const action: BulkAction | null =
    kind === 'set' ? (setValue.trim() || setField === 'usage_type' ? { type: 'set', field: setField, value: setValue } : null)
    : kind === 'change' ? (chValue.trim() ? { type: 'change', field: chField, mode: chMode, value: chValue } : null)
    : mvValue.trim() ? { type: 'move', by: mvBy, value: mvValue, toKind: mvKind, rate: mvRate.trim() || null } : null;
  const sig = JSON.stringify(action);

  useEffect(() => {
    setPlan(null); setErr('');
    if (!action) return;
    const t = setTimeout(() => { call('bulk:plan', { filter, action }).then(setPlan).catch((e: Error) => setErr(e.message)); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const apply = async () => {
    if (!action) return;
    setBusy(true); setErr('');
    try { await call('bulk:apply', { filter, action }); onClose(true); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="modal"><div className="dialog">
      <h1>Массовая правка</h1>
      <div className="dim">Применится ко всем строкам, которые сейчас показаны по фильтрам: <b>{fmtInt(total)}</b>. Измените фильтры, чтобы сузить выбор.</div>
      <div className="row" style={{ margin: '12px 0' }}>
        {([['change', 'Изменить на % или сумму'], ['set', 'Задать значение'], ['move', 'Перенести часть в другой тип']] as Array<[Kind, string]>).map(([k, l]) => (
          <button key={k} className={kind === k ? 'primary' : ''} onClick={() => setKind(k)}>{l}</button>
        ))}
      </div>
      {kind === 'set' && (
        <div className="grid2">
          <label className="f">Что задать<select value={setField} onChange={(e) => { setSetField(e.target.value as UiField); setSetValue(e.target.value === 'stream_kind' ? 'ad' : ''); }}>{SET_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {setField === 'stream_kind'
            ? <label className="f">Значение<select value={setValue} onChange={(e) => setSetValue(e.target.value)}>{Object.entries(STREAM_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            : <label className="f">Значение<input value={setValue} onChange={(e) => setSetValue(e.target.value)} /></label>}
        </div>
      )}
      {kind === 'change' && (
        <div className="grid2">
          <label className="f">Что менять<select value={chField} onChange={(e) => setChField(e.target.value as typeof chField)}>{CHANGE_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="f">Как<select value={chMode} onChange={(e) => setChMode(e.target.value as typeof chMode)}><option value="percent">на процент</option><option value="amount">на сумму (прибавить или вычесть)</option></select></label>
          <label className="f">{chMode === 'percent' ? 'Процент (−10 уменьшит на 10%)' : chField === 'qty' ? 'Штук (например −100)' : 'Рублей (например −0,5)'}<input autoFocus value={chValue} onChange={(e) => setChValue(e.target.value)} /></label>
        </div>
      )}
      {kind === 'move' && (
        <div className="grid2">
          <label className="f">Сколько<select value={mvBy} onChange={(e) => setMvBy(e.target.value as typeof mvBy)}><option value="percent">процент прослушиваний каждой строки</option><option value="qty">штук из каждой строки</option></select></label>
          <label className="f">{mvBy === 'percent' ? 'Процент (1–100)' : 'Штук'}<input autoFocus value={mvValue} onChange={(e) => setMvValue(e.target.value)} /></label>
          <label className="f">В какой тип<select value={mvKind} onChange={(e) => setMvKind(e.target.value as StreamKind)}>{Object.entries(STREAM_SHORT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f">Ставка части, ₽ (необязательно)<input value={mvRate} onChange={(e) => setMvRate(e.target.value)} placeholder="как у исходной" /></label>
        </div>
      )}
      {err && <div className="err">{err}</div>}
      {plan && (
        <>
          <h3>Предпросмотр</h3>
          <div>Изменится строк: <b>{fmtInt(plan.affected)}</b> · разница в роялти: <b className={plan.deltaKop < 0 ? 'sum bad' : ''}>{plan.deltaKop > 0 ? '+' : ''}{fmtKop(plan.deltaKop)}</b>
            {(plan.skipped.hasSplit + plan.skipped.noChange + plan.skipped.invalid) > 0 && <span className="dim"> · пропущено: {plan.skipped.hasSplit > 0 && `с переносом ${plan.skipped.hasSplit} `}{plan.skipped.noChange > 0 && `без изменений ${plan.skipped.noChange} `}{plan.skipped.invalid > 0 && `не подходят ${plan.skipped.invalid}`}</span>}
          </div>
          {plan.sample.length > 0 && (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Трек</th><th>Площадка</th><th style={{ textAlign: 'right' }}>Тираж</th><th style={{ textAlign: 'right' }}>Роялти</th><th>Тип</th></tr></thead>
              <tbody>{plan.sample.map((s) => (
                <tr key={s.lineId}>
                  <td>{s.title}</td><td>{s.platform}</td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(s.before.qty)}{s.after.qty !== s.before.qty && <> → <b>{fmtInt(s.after.qty)}</b></>}</td>
                  <td style={{ textAlign: 'right' }}>{fmtKop(s.before.royaltyKop)}{s.after.royaltyKop !== s.before.royaltyKop && <> → <b>{fmtKop(s.after.royaltyKop)}</b></>}</td>
                  <td>{STREAM_SHORT[s.before.streamKind]}{s.after.streamKind !== s.before.streamKind && <> → <b>{STREAM_SHORT[s.after.streamKind]}</b></>}</td>
                </tr>))}</tbody>
            </table>
          )}
          {plan.affected > plan.sample.length && <div className="dim">…и ещё {fmtInt(plan.affected - plan.sample.length)}</div>}
        </>
      )}
      <div className="dim" style={{ marginTop: 10 }}>Перед применением программа делает бэкап. Откатить партию можно одной кнопкой в «Истории правок».</div>
      <div className="row end"><button onClick={() => onClose(false)}>Отмена</button><button className="primary" disabled={!plan || plan.affected === 0 || busy} onClick={apply}>{busy ? 'Применяю…' : `Применить к ${plan ? fmtInt(plan.affected) : 0} строкам`}</button></div>
    </div></div>
  );
}

export function HistoryDialog({ onClose }: { onClose: (changed: boolean) => void }) {
  const [items, setItems] = useState<BatchItem[]>([]);
  const [changed, setChanged] = useState(false);
  const [err, setErr] = useState('');
  const load = () => { void call('bulk:list').then(setItems); };
  useEffect(load, []);
  const revert = async (id: string) => {
    setErr('');
    try { await call('bulk:revert', { batchId: id }); setChanged(true); load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="modal"><div className="dialog">
      <h1>История массовых правок</h1>
      {err && <div className="err">{err}</div>}
      {items.length === 0 && <div className="dim">Массовых правок ещё не было.</div>}
      <table>
        <tbody>{items.map((b) => (
          <tr key={b.id} style={b.revertedAt ? { opacity: 0.5 } : undefined}>
            <td>{new Date(b.createdAt).toLocaleString('ru-RU')}</td>
            <td>{describeAction(b.action)}</td>
            <td className="dim">{fmtInt(b.affected)} строк · {b.deltaKop > 0 ? '+' : ''}{fmtKop(b.deltaKop)}</td>
            <td>{b.revertedAt ? <span className="badge">откатана</span> : <button className="link" onClick={() => revert(b.id)}>откатить</button>}</td>
          </tr>))}</tbody>
      </table>
      <div className="row end"><button onClick={() => onClose(changed)}>Закрыть</button></div>
    </div></div>
  );
}
