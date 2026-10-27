import { useState } from 'react';
import type { AuthStatus, FolderPick } from '../../../shared/api.ts';
import { call } from '../api.ts';

/** Показывается до входа, пока папка данных не выбрана / не найдена / занята. */
export function DataGate({ auth, onAuth }: { auth: AuthStatus; onAuth: (a: AuthStatus) => void }) {
  const d = auth.data;
  const [pick, setPick] = useState<FolderPick | null>(null);
  const [useDefault, setUseDefault] = useState(true);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<AuthStatus | void>) => { setError(''); try { const r = await fn(); if (r) onAuth(r); } catch (e) { setError((e as Error).message); } };

  if (d.state === 'setup') {
    const target = useDefault ? d.defaultRoot : pick ? `${pick.path}\\RoyaltyLab` : '';
    return (
      <div className="login" style={{ maxWidth: 560 }}>
        <h1 style={{ color: 'var(--accent)' }}>Где хранить данные?</h1>
        <div className="dim">В выбранной папке создам RoyaltyLab с базой, отчётами, фото, шаблонами и копиями. Можно любой диск, в том числе внешний.</div>
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={useDefault} onChange={() => setUseDefault(true)} />Стандартное место: <span className="mono">{d.defaultRoot}</span></label>
        <label className="row"><input type="radio" style={{ width: 'auto' }} checked={!useDefault} onChange={() => { setUseDefault(false); if (!pick) void run(async () => { setPick(await call('data:pick')); }); }} />Другая папка{pick && !useDefault ? <span className="mono">: {pick.path}</span> : null}</label>
        {!useDefault && <button onClick={() => run(async () => { const p = await call('data:pick'); if (p) setPick(p); })}>Выбрать папку…</button>}
        {!useDefault && pick?.warning && <div className="err">⚠ {pick.warning}</div>}
        {error && <div className="err">{error}</div>}
        <button className="primary" disabled={!useDefault && !pick} onClick={() => run(() => call('data:setup', { parent: useDefault ? null : pick!.path }))}>Дальше{target ? '' : ''}</button>
      </div>
    );
  }

  if (d.state === 'missing') {
    return (
      <div className="login" style={{ maxWidth: 560 }}>
        <h1 style={{ color: 'var(--bad)' }}>Данные не найдены</h1>
        <div>Данные не найдены по пути:</div>
        <div className="mono" style={{ wordBreak: 'break-all' }}>{d.path}</div>
        <div className="dim">Возможно, отключён диск или папку переименовали. Заново я ничего не создаю, чтобы не затереть вашу базу.</div>
        {error && <div className="err">{error}</div>}
        <div className="row">
          <button className="primary" onClick={() => run(() => call('data:relocate'))}>Указать папку заново</button>
          <button onClick={() => run(() => call('data:retry'))}>Проверить ещё раз</button>
          <button onClick={() => void call('data:quit')}>Выйти</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login" style={{ maxWidth: 560 }}>
      <h1 style={{ color: 'var(--bad)' }}>Данные заняты</h1>
      <div>{d.message}</div>
      <div className="row"><button className="primary" onClick={() => run(() => call('data:retry'))}>Повторить</button><button onClick={() => void call('data:quit')}>Выйти</button></div>
    </div>
  );
}
