import { useState } from 'react';
import type { AuthStatus } from '../../../shared/api.ts';
import { call } from '../api.ts';

export function Login({ auth, onAuth }: { auth: AuthStatus; onAuth: (a: AuthStatus) => void }) {
  const first = !auth.initialized;
  const [login, setLogin] = useState(auth.users[0]?.login ?? '');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (first && password !== again) return setError('Пароли не совпадают');
    setBusy(true);
    try {
      onAuth(await call(first ? 'auth:init' : 'auth:login', { login: login.trim(), password }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1 style={{ color: 'var(--accent)' }}>Royalty Lab</h1>
      {first && <div className="dim">Первый запуск: создайте владельца. Пароль нигде не хранится — потеряете его, данные не восстановить.</div>}
      <input placeholder="Логин" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus={!login} />
      <input type="password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!login} />
      {first && <input type="password" placeholder="Пароль ещё раз (минимум 8 символов)" value={again} onChange={(e) => setAgain(e.target.value)} />}
      {error && <div className="err">{error}</div>}
      <button className="primary" disabled={busy || !login || !password}>{busy ? 'Проверяю…' : first ? 'Создать' : 'Войти'}</button>
    </form>
  );
}
