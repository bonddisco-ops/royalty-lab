import { useEffect, useState } from 'react';
import type { AuthStatus } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { StarterDialog as StarterLazy } from './StarterDialog.tsx';

const LABELS: Record<string, string> = {
  hidden_deduction: 'Скрытый вычет (доля)', rate_change_mode: 'Смена ставки: keep_rate / …', auto_lock_minutes: 'Автоблокировка, минут (0 — выкл.)',
};

export function Settings({ auth, onChanged }: { auth: AuthStatus; onChanged: () => void }) {
  const [s, setS] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [nu, setNu] = useState({ login: '', password: '' });
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '' });
  const [starter, setStarter] = useState(false);
  useEffect(() => { void call('settings:get').then(setS); }, []);
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); onChanged(); } catch (e) { setErr((e as Error).message); } };
  const owner = auth.user?.role === 'owner';
  return (
    <>
      <h1>Настройки</h1>
      {msg && <div className="okmsg">{msg}</div>}{err && <div className="err">{err}</div>}
      <h2>Параметры</h2>
      <div className="grid2">{Object.keys(LABELS).filter((k) => k in s).map((k) => (
        <label className="f" key={k}>{LABELS[k]}
          <input value={s[k] ?? ''} disabled={!owner} onChange={(e) => setS({ ...s, [k]: e.target.value })} onBlur={() => run(() => call('settings:set', { id: k, value: s[k] ?? '' }), 'Сохранено')} />
        </label>))}</div>
      <h2>Резервная копия</h2>
      <button onClick={() => run(async () => { const f = await call('backup:now'); setMsg(`Копия: ${f}`); }, '')}>Сделать копию сейчас</button>
      <span className="dim"> Копия делается и при закрытии программы (хранится 30 последних).</span>
      <h2>Папки</h2>
      <div className="dim">Данные: <span className="mono">{auth.data.path}</span></div>
      <div className="dim">Копии: <span className="mono">{auth.data.backupDir ?? 'внутри папки данных (backups)'}</span></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => run(async () => { const p = await call('data:pickBackupDir'); if (p) setMsg(`Копии будут в: ${p.path}${p.warning ? '. ⚠ ' + p.warning : ''}`); }, '')}>Выбрать папку для копий…</button>
      </div>
      <div className="dim" style={{ marginTop: 6 }}>Перенос данных в другую папку будет отдельной кнопкой («Переместить данные») — делаю следом.</div>
      <h2>Мой пароль</h2>
      <div className="grid2">
        <label className="f">Старый<input type="password" value={pw.oldPassword} onChange={(e) => setPw({ ...pw, oldPassword: e.target.value })} /></label>
        <label className="f">Новый (от 8 символов)<input type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></label>
      </div>
      <div className="row" style={{ marginTop: 8 }}><button onClick={() => run(async () => { await call('auth:changePassword', pw); setPw({ oldPassword: '', newPassword: '' }); }, 'Пароль изменён')}>Сменить пароль</button></div>
      {owner && (<>
        <h2>Бухгалтер</h2>
        <div className="dim">Пользователи: {auth.users.map((u) => `${u.login} (${u.role === 'owner' ? 'владелец' : 'бухгалтер'})`).join(', ')}</div>
        <div className="grid2" style={{ marginTop: 8 }}>
          <label className="f">Логин<input value={nu.login} onChange={(e) => setNu({ ...nu, login: e.target.value })} /></label>
          <label className="f">Пароль<input type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} /></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}><button onClick={() => run(async () => { await call('auth:addUser', { ...nu, role: 'accountant' }); setNu({ login: '', password: '' }); }, 'Бухгалтер добавлен (войдёт после перезапуска окна входа)')}>Добавить бухгалтера</button></div>
        <h2>Стартовая база</h2>
        <button onClick={() => setStarter(true)}>Загрузить стартовую базу…</button> <span className="dim">Работает только пока каталог пуст.</span>
      </>)}
      {starter && <StarterLazy onClose={() => { setStarter(false); onChanged(); }} />}
    </>
  );
}
