import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Contracts } from './views/Contracts.tsx';
import { Logo } from './Logo.tsx';
import { NavContext, type NavParams, type Tab } from './nav.tsx';
import { THEMES, applyTheme, savedTheme } from './themes.ts';
import { Settings } from './views/Settings.tsx';

const TABS: Array<[Tab, string]> = [['home', 'Главная'], ['tracks', 'Треки'], ['people', 'Люди'], ['artists', 'Артисты'], ['reports', 'Отчёты'], ['lines', 'Строки'], ['payouts', 'Выплаты'], ['contracts', 'Договоры'], ['issues', 'Проверить'], ['settings', 'Настройки']];

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [openIssues, setOpenIssues] = useState(0);
  const [tick, setTick] = useState(0);
  const [theme, setTheme] = useState(savedTheme());
  const [params, setParams] = useState<NavParams>({});
  const go = useCallback((t: Tab, p?: NavParams) => { setParams(p ?? {}); setTab(t); }, []);
  const clear = useCallback(() => setParams({}), []);
  const navApi = useMemo(() => ({ go, params, clear }), [go, params, clear]);
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
    <NavContext.Provider value={navApi}>
    <div className="shell">
      <nav className="side">
        <div className="brand"><Logo size={26} /><span>Royalty Lab</span></div>
        {TABS.map(([id, label]) => (
          <button key={id} className={'nav' + (tab === id ? ' on' : '')} onClick={() => go(id)}>
            <span>{label}</span>
            {id === 'issues' && openIssues > 0 && <span className="badge bad">{openIssues}</span>}
          </button>
        ))}
        <div className="spacer" />
        <select className="themepick" title="Тема оформления" value={theme} onChange={(e) => { setTheme(e.target.value); applyTheme(e.target.value); }}>{THEMES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <div className="who">{auth.user?.login} · {auth.user?.role === 'owner' ? 'владелец' : 'бухгалтер'}</div>
        <button onClick={() => void call('auth:logout').then(setAuth)}>Заблокировать</button>
      </nav>
      <main className="main">
        {tab === 'home' && <Home tick={tick} onChanged={refresh} goto={(t) => go(t as Tab)} />}
        {tab === 'tracks' && <Tracks onChanged={refresh} />}
        {tab === 'people' && <People onChanged={refresh} />}
        {tab === 'artists' && <Artists onChanged={refresh} />}
        {tab === 'reports' && <Reports onChanged={refresh} />}
        {tab === 'lines' && <Lines onChanged={refresh} />}
        {tab === 'payouts' && <Payouts onChanged={refresh} />}
        {tab === 'contracts' && <Contracts onChanged={refresh} />}
        {tab === 'issues' && <Issues onChanged={refresh} />}
        {tab === 'settings' && <Settings auth={auth} onChanged={refresh} />}
      </main>
    </div>
    </NavContext.Provider>
  );
}
