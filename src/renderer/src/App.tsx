import { useCallback, useEffect, useState } from 'react';
import type { AuthStatus } from '../../shared/api.ts';
import { call } from './api.ts';
import { DataGate } from './views/DataGate.tsx';
import { Login } from './views/Login.tsx';
import { Home } from './views/Home.tsx';
import { Tracks } from './views/Tracks.tsx';
import { People } from './views/People.tsx';
import { Artists } from './views/Artists.tsx';
import { Issues } from './views/Issues.tsx';
import { Reports } from './views/Reports.tsx';
import { Lines } from './views/Lines.tsx';
import { Payouts } from './views/Payouts.tsx';
import { Settings } from './views/Settings.tsx';

type Tab = 'home' | 'tracks' | 'people' | 'artists' | 'reports' | 'lines' | 'payouts' | 'issues' | 'settings';
const TABS: Array<[Tab, string]> = [['home', 'Главная'], ['tracks', 'Треки'], ['people', 'Люди'], ['artists', 'Артисты'], ['reports', 'Отчёты'], ['lines', 'Строки'], ['payouts', 'Выплаты'], ['issues', 'Проверить'], ['settings', 'Настройки']];

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [openIssues, setOpenIssues] = useState(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    void call('auth:status').then(setAuth);
    return window.rl.onLocked(() => void call('auth:status').then(setAuth));
  }, []);

  useEffect(() => {
    if (!auth?.unlocked) return;
    void call('dash:get').then((d) => setOpenIssues(Object.values(d.openIssues).reduce((a, b) => a + b, 0))).catch(() => {});
  }, [auth?.unlocked, tick, tab]);

  if (!auth) return <div className="main dim">Загрузка…</div>;
  if (auth.data.state !== 'ok') return <DataGate auth={auth} onAuth={setAuth} />;
  if (!auth.unlocked) return <Login auth={auth} onAuth={setAuth} />;

  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">Royalty Lab</div>
        {TABS.map(([id, label]) => (
          <button key={id} className={'nav' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <span>{label}</span>
            {id === 'issues' && openIssues > 0 && <span className="badge bad">{openIssues}</span>}
          </button>
        ))}
        <div className="spacer" />
        <div className="who">{auth.user?.login} · {auth.user?.role === 'owner' ? 'владелец' : 'бухгалтер'}</div>
        <button onClick={() => void call('auth:logout').then(setAuth)}>Заблокировать</button>
      </nav>
      <main className="main">
        {tab === 'home' && <Home tick={tick} onChanged={refresh} goto={(t) => setTab(t as Tab)} />}
        {tab === 'tracks' && <Tracks onChanged={refresh} />}
        {tab === 'people' && <People onChanged={refresh} />}
        {tab === 'artists' && <Artists onChanged={refresh} />}
        {tab === 'reports' && <Reports onChanged={refresh} />}
        {tab === 'lines' && <Lines onChanged={refresh} />}
        {tab === 'payouts' && <Payouts onChanged={refresh} goto={(t) => setTab(t as Tab)} />}
        {tab === 'issues' && <Issues onChanged={refresh} />}
        {tab === 'settings' && <Settings auth={auth} onChanged={refresh} />}
      </main>
    </div>
  );
}
