import { useState } from 'react';
import type { StarterPreview, StarterResult } from '../../../shared/api.ts';
import { call, issueLabel } from '../api.ts';

export function StarterDialog({ onClose }: { onClose: () => void }) {
  const [pv, setPv] = useState<StarterPreview | null>(null);
  const [res, setRes] = useState<StarterResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function pick() {
    setError(''); setBusy(true);
    try { setPv(await call('starter:pick')); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function apply() {
    if (!pv) return;
    setError(''); setBusy(true);
    try { setRes(await call('starter:apply', { token: pv.token })); setPv(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const s = (res?.summary ?? pv?.summary) ?? null;
  return (
    <div className="modal"><div className="dialog">
      <h1>Стартовая база</h1>
      {!s && <div className="dim">Выберите файл Стартовая_база.xlsx. Сначала покажу, что будет создано; в базу ничего не пишется, пока вы не нажмёте «Загрузить».</div>}
      {pv && <div className="dim">Файл: {pv.fileName}</div>}
      {res && <div className="okmsg">Готово. Копия базы до загрузки: {res.backup}</div>}
      {s && (
        <>
          <div className="cards" style={{ marginTop: 12 }}>
            {([['Люди', s.people], ['Договоры', s.contracts], ['Приложения', s.appendices], ['Артисты', s.artists], ['Треки', s.tracks], ['Участия', s.participations]] as Array<[string, number]>).map(([l, n]) => (
              <div className="card" key={l}><div className="n">{n}</div><div className="l">{l}</div></div>
            ))}
          </div>
          <div className="dim">Артистов без человека: {s.artistsWithoutPerson}. Треков с ISRC: {s.tracksWithIsrc}, только с внутренними кодами: {s.tracksWithCodesOnly}, из приложений без ISRC: {s.tracksFromAppendixOnly}. Доли по договору применены: {s.contractSharesApplied}, расходятся со SPLIT: {s.contractSharesDiffer}.</div>
          <h3>Проблемы, которые попадут во вкладку</h3>
          <div>{Object.entries(s.issuesByKind).map(([k, n]) => <span className="badge" key={k}>{issueLabel(k)}: {n}</span>)}</div>
          {(['warnings', 'possibleNameTypos', 'ambiguousContractShares', 'unmatchedAppendixTracks'] as const).map((k) => s[k].length > 0 && (
            <details key={k} style={{ marginTop: 10 }}>
              <summary>{{ warnings: 'Предупреждения', possibleNameTypos: 'Возможные опечатки в именах', ambiguousContractShares: 'Неоднозначные доли по договору', unmatchedAppendixTracks: 'Треки из приложений без пары в SPLIT' }[k]} ({s[k].length})</summary>
              <ul className="plain">{s[k].slice(0, 80).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </details>
          ))}
        </>
      )}
      {error && <div className="err">{error}</div>}
      <div className="row end">
        <button onClick={onClose}>{res ? 'Закрыть' : 'Отмена'}</button>
        {!res && <button onClick={pick} disabled={busy}>{pv ? 'Выбрать другой файл' : 'Выбрать файл…'}</button>}
        {pv && !res && <button className="primary" onClick={apply} disabled={busy}>{busy ? 'Загружаю…' : 'Загрузить'}</button>}
      </div>
    </div></div>
  );
}
