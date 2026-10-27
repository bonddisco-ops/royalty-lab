import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppendixDraft, ContractDetail, ContractListItem, ContractPreview, FieldDef } from '../../shared/api.ts';
import { call } from './api.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { useNav } from './nav.tsx';
import { BlockView, ReadOnly } from './views/Contracts.tsx';

export interface ViewerOpts { tab?: 'terms' | 'text' | 'appendix'; trackId?: string; artist?: string }
const Ctx = createContext<(contractId: string, opts?: ViewerOpts) => void>(() => {});
/** Открыть договор в отдельном окне поверх любой страницы: условия, текст, приложения. */
export const useContractViewer = (): ((contractId: string, opts?: ViewerOpts) => void) => useContext(Ctx);

export function ContractViewerProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<{ id: string; opts: ViewerOpts } | null>(null);
  const open = useCallback((id: string, opts: ViewerOpts = {}) => setSt({ id, opts }), []);
  return (
    <Ctx.Provider value={open}>
      {children}
      {st && <ErrorBoundary label="Договор не открылся" onReset={() => setSt(null)}><ContractViewer key={st.id} id={st.id} opts={st.opts} onClose={() => setSt(null)} /></ErrorBoundary>}
    </Ctx.Provider>
  );
}

/** Номер договора как ссылка: везде, где виден договор. */
export function ContractLink({ id, children, opts, className }: { id: string | null | undefined; children: ReactNode; opts?: ViewerOpts; className?: string }) {
  const open = useContractViewer();
  if (!id) return <>{children}</>;
  return <button className={'link ' + (className ?? '')} style={{ padding: 0, textDecoration: 'underline' }} title="Открыть договор" onClick={(e) => { e.stopPropagation(); open(id, opts); }}>{children}</button>;
}

const fmtDate = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso ?? '');
const KIND: Record<string, string> = { ip: 'ИП', sz: 'самозанятый' };
const APP_COLS: Array<[string, string]> = [['title', 'Произведение'], ['performers', 'Исполнитель'], ['shareAuthors', 'Доля авт.'], ['shareRelated', 'Доля смеж.'], ['term', 'Срок'], ['rate', 'Ставка']];

function ContractViewer({ id, opts, onClose }: { id: string; opts: ViewerOpts; onClose: () => void }) {
  const nav = useNav();
  const [det, setDet] = useState<ContractDetail | null>(null);
  const [info, setInfo] = useState<ContractListItem | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [pv, setPv] = useState<ContractPreview | null>(null);
  const [tab, setTab] = useState<'terms' | 'text' | 'appendix'>(opts.tab ?? 'terms');
  const [appId, setAppId] = useState<string | null>(null);
  const [app, setApp] = useState<AppendixDraft | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const d = await call('contracts:get', { id });
        setDet(d);
        setAppId(d.appendices[0]?.id ?? null);
        setFields(await call('contracts:fields'));
        setInfo((await call('contracts:list')).find((c) => c.id === id) ?? null);
        setPv(await call('contracts:preview', { id: d.id, counterpartyId: d.counterpartyId, number: d.number, date: d.date, fields: d.fields, options: d.options, okved: d.okved }));
        if (opts.trackId && d.appendices.length > 0) {
          // если открыли «из трека» — сразу показываем то приложение, где этот трек есть
          for (const a of d.appendices) {
            const dr = await call('appendix:draft', { contractId: id, appendixId: a.id });
            if (dr.tracks.some((t) => t.trackId === opts.trackId)) { setAppId(a.id); break; }
          }
        }
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [id, opts.trackId]);
  useEffect(() => {
    if (!appId) { setApp(null); return; }
    void call('appendix:draft', { contractId: id, appendixId: appId }).then(setApp).catch((e: Error) => setErr(e.message));
  }, [id, appId]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const grouped = useMemo(() => {
    const names: Record<FieldDef['group'], string> = { money: 'Суммы и ставки', reports: 'Отчёты и выплаты', notice: 'Уведомления и сроки', other: 'Прочее' };
    return (Object.keys(names) as Array<FieldDef['group']>).map((g) => [names[g], fields.filter((f) => f.group === g)] as const).filter(([, fs]) => fs.length > 0);
  }, [fields]);
  const mine = (t: AppendixDraft['tracks'][number]): boolean => (!!opts.trackId && t.trackId === opts.trackId) || (!!opts.artist && (t.row.performers ?? '').toLowerCase().includes(opts.artist.toLowerCase()));

  return (
    <div className="modal" style={{ zIndex: 30 }}><div className="dialog" style={{ width: 'min(1100px, 94vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Договор {det?.number ?? ''}</h2>
        {det && <span className="dim">{det.person} · {det.kind ? KIND[det.kind] : ''} · от {fmtDate(det.date)}</span>}
        <div className="grow" />
        <button className={tab === 'terms' ? 'primary' : ''} onClick={() => setTab('terms')}>Условия</button>
        <button className={tab === 'text' ? 'primary' : ''} onClick={() => setTab('text')}>Текст договора</button>
        <button className={tab === 'appendix' ? 'primary' : ''} onClick={() => setTab('appendix')}>Приложения{det?.appendices.length ? ` (${det.appendices.length})` : ''}</button>
      </div>
      {err && <div className="err">{err}</div>}
      <div style={{ overflow: 'auto', flex: 1, minHeight: 200 }}>
        {tab === 'terms' && det && (
          <>
            <div className="cards" style={{ marginBottom: 8 }}>
              <div className="card"><div className="n" style={{ fontSize: 18 }}>{info?.thresholdRub == null ? 'не задан' : `${info.thresholdRub.toLocaleString('ru-RU')} ₽`}</div><div className="l">Порог выплаты</div></div>
              <div className="card"><div className="n" style={{ fontSize: 18 }}>{det.appendices.length}</div><div className="l">Приложений</div></div>
            </div>
            <div className="grid2">
              {grouped.map(([title, fs]) => (
                <div key={title}>
                  <h3 style={{ marginTop: 0 }}>{title}</h3>
                  <table><tbody>{fs.map((f) => <tr key={f.key}><td>{f.label}</td><td style={{ textAlign: 'right' }}><b>{det.fields[f.key] ?? f.default}</b></td></tr>)}</tbody></table>
                </div>
              ))}
              <div>
                <h3 style={{ marginTop: 0 }}>Пункты</h3>
                <table><tbody>
                  <tr><td>П. 3.5: обложка от лейбла</td><td style={{ textAlign: 'right' }}><b>{det.options.cover ? 'да' : 'нет'}</b></td></tr>
                  <tr><td>П. 6.3: отказ, если релиза нет</td><td style={{ textAlign: 'right' }}><b>{det.options.release ? 'да' : 'нет'}</b></td></tr>
                  <tr><td>П. 4.13 при потере статуса</td><td style={{ textAlign: 'right' }}><b>{det.options.p413 === 'rate' ? 'ставка снижается' : 'ставка не меняется'}</b></td></tr>
                </tbody></table>
              </div>
            </div>
            <p className="dim">Ставки по каждому треку — во вкладке «Приложения» (колонка «Ставка»).</p>
          </>
        )}
        {tab === 'text' && (
          <article className="ctr-doc" style={{ maxHeight: 'none' }}>
            {!pv && <div className="dim">Собираю текст…</div>}
            <ReadOnly.Provider value={true}>{pv?.blocks.map((b, i) => <BlockView key={i} b={b} fields={fields} onField={() => {}} onToggle={() => {}} />)}</ReadOnly.Provider>
          </article>
        )}
        {tab === 'appendix' && det && (
          <>
            {det.appendices.length === 0 && <div className="drop">К этому договору приложений пока нет.</div>}
            {det.appendices.length > 0 && (
              <>
                <div className="row" style={{ marginBottom: 8 }}>
                  {det.appendices.map((a) => <button key={a.id} className={appId === a.id ? 'primary' : ''} onClick={() => setAppId(a.id)}>Приложение № {a.number}{a.date ? ` · ${fmtDate(a.date)}` : ''}</button>)}
                </div>
                {!app && <div className="dim">Загрузка…</div>}
                {app && (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead><tr><th>№</th>{APP_COLS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
                      <tbody>{app.tracks.map((t, i) => (
                        <tr key={i} style={mine(t) ? { background: 'color-mix(in srgb, var(--accent) 18%, transparent)' } : undefined}>
                          <td>{i + 1}</td>{APP_COLS.map(([k]) => <td key={k}>{t.row[k as keyof typeof t.row] ?? ''}</td>)}
                        </tr>))}</tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="row end" style={{ marginTop: 8 }}>
        <button onClick={() => { onClose(); nav.go('contracts', { contractId: id }); }} title="Открыть договор в конструкторе: править условия, делать Word и PDF">Редактировать в «Договорах»</button>
        <button className="primary" onClick={onClose}>Закрыть</button>
      </div>
    </div></div>
  );
}
