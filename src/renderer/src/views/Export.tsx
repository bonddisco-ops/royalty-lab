import { Fragment, useEffect, useMemo, useState } from 'react';
import type { TreePerson } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { useNav } from '../nav.tsx';

type Preview = { people: Array<{ personId: string; name: string; projects: string[]; tracks: number; missing: string[] }>; unassigned: string[] };

export function Export() {
  const nav = useNav();
  const [tree, setTree] = useState<TreePerson[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [onlyTracks, setOnlyTracks] = useState(false);
  const [pv, setPv] = useState<Preview | null>(null);
  const [res, setRes] = useState<{ path: string; people: number; tracks: number } | null>(null);
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void call('catalog:tree').then((t) => { setTree(t); setSel(new Set(t.filter((p) => p.personId).flatMap((p) => p.artists.map((a) => a.id)))); }).catch((e: Error) => setErr(e.message));
  }, []);
  const ids = useMemo(() => [...sel], [sel]);
  useEffect(() => {
    const h = setTimeout(() => { void call('catalog:preview', { artistIds: ids }).then(setPv).catch((e: Error) => setErr(e.message)); }, 150);
    return () => clearTimeout(h);
  }, [ids]);

  const needle = q.trim().toLowerCase();
  const shown = tree
    .map((p) => ({ ...p, artists: p.artists.filter((a) => (!onlyTracks || a.tracks > 0)) }))
    .filter((p) => p.artists.length > 0 && (!needle || p.name.toLowerCase().includes(needle) || p.artists.some((a) => a.name.toLowerCase().includes(needle))));
  const toggle = (id: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleMany = (list: string[], on: boolean) => setSel((s) => { const n = new Set(s); for (const id of list) { if (on) n.add(id); else n.delete(id); } return n; });
  const allIds = tree.flatMap((p) => p.artists.map((a) => a.id));
  const gaps = (pv?.people ?? []).filter((p) => p.missing.length > 0);
  const trackTotal = (pv?.people ?? []).reduce((a, p) => a + p.tracks, 0);

  const doExport = async () => {
    setErr(''); setAsk(false);
    try { setRes(await call('catalog:export', { artistIds: ids })); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div className="bar">
        <h1 style={{ margin: 0 }}>Экспорт</h1>
        <input style={{ maxWidth: 280 }} placeholder="Поиск по человеку или артисту…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={onlyTracks} onChange={(e) => setOnlyTracks(e.target.checked)} />только с треками</label>
        <button onClick={() => setSel(new Set(allIds))}>Выбрать всех</button>
        <button onClick={() => setSel(new Set())}>Снять всех</button>
        <div className="grow" />
        <span className="dim">{pv ? `Людей: ${pv.people.length} · треков в списках: ${trackTotal}` : ''}</span>
        <button className="primary" disabled={!pv || pv.people.length === 0} onClick={() => (gaps.length > 0 ? setAsk(true) : void doExport())}>Экспортировать в Excel</button>
      </div>
      {err && <div className="err">{err}</div>}
      {res && <div className="okmsg">Готово: {res.people} лист(ов), треков в списках: {res.tracks}. Файл: {res.path} <button className="link" onClick={() => void call('payouts:open', { path: res.path })}>Открыть файл</button> <button className="link" onClick={() => void call('payouts:reveal', { path: res.path })}>Показать в папке</button></div>}
      <p className="dim">Файл Excel: один лист на человека. На листе фамилия, имя, отчество, электронная почта, проекты и список треков в виде «Артисты – Название». Если у трека несколько людей, он есть на листе каждого. Снятый артист в файл не попадает.</p>

      {pv && (gaps.length > 0 || pv.unassigned.length > 0) && (
        <div className="warn" style={{ marginBottom: 12 }}>
          <b>Чего не хватает в выгрузке</b> <span className="dim">· пробелов: {gaps.reduce((a, p) => a + p.missing.length, 0)} у {gaps.length} чел.{pv.unassigned.length ? `; артистов без человека: ${pv.unassigned.length}` : ''}</span>
          <table style={{ marginTop: 6 }}>
            <tbody>
              {gaps.map((p) => (
                <tr key={p.personId}>
                  <td><b>{p.name}</b> <span className="dim">· проекты: {p.projects.join(', ')}</span></td>
                  <td>не хватает: {p.missing.join(', ')}</td>
                  <td><button className="link" onClick={() => nav.go('people', { personId: p.personId })}>открыть карточку</button></td>
                </tr>))}
              {pv.unassigned.length > 0 && <tr><td colSpan={3}>Не привязаны к человеку и в файл не попадут: {pv.unassigned.join(', ')} <button className="link" onClick={() => nav.go('artists', {})}>привязать →</button></td></tr>}
            </tbody>
          </table>
        </div>
      )}

      <table>
        <thead><tr><th style={{ width: 40 }} /><th>Человек / артист</th><th>Электронная почта</th><th>Треков</th></tr></thead>
        <tbody>
          {shown.map((p) => {
            const artistIds = p.artists.map((a) => a.id);
            const on = artistIds.filter((id) => sel.has(id)).length;
            const free = p.personId === null;
            return (
              <Fragment key={p.personId ?? 'free'}>
                <tr style={{ background: 'var(--panel)' }}>
                  <td><input type="checkbox" style={{ width: 'auto' }} disabled={free} checked={on === artistIds.length && on > 0} ref={(el) => { if (el) el.indeterminate = on > 0 && on < artistIds.length; }} onChange={(e) => toggleMany(artistIds, e.target.checked)} /></td>
                  <td><b>{p.name}</b></td>
                  <td>{free ? '' : p.email ? p.email : <span className="badge bad">нет почты</span>}</td>
                  <td className="dim">{p.artists.reduce((a, x) => a + x.tracks, 0)}</td>
                </tr>
                {p.artists.map((a) => (
                  <tr key={a.id}>
                    <td><input type="checkbox" style={{ width: 'auto' }} disabled={free} checked={sel.has(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} /></td>
                    <td style={{ paddingLeft: 24 }}>{a.name}</td><td /><td className="dim">{a.tracks}</td>
                  </tr>))}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {ask && (
        <div className="modal"><div className="dialog" style={{ maxWidth: 520 }}>
          <h2>Не все данные заполнены</h2>
          <p>У {gaps.length} чел. в файле будут пустые (подсвеченные) поля. Выгрузить всё равно?</p>
          <ul className="plain">{gaps.slice(0, 8).map((p) => <li key={p.personId}>{p.name}: {p.missing.join(', ')}</li>)}{gaps.length > 8 && <li className="dim">…и ещё {gaps.length - 8}</li>}</ul>
          <div className="row end"><button onClick={() => setAsk(false)}>Вернуться</button><button className="primary" onClick={() => void doExport()}>Выгрузить всё равно</button></div>
        </div></div>
      )}
    </>
  );
}

