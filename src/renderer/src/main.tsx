import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { call } from './api.ts';
import './styles.css';
import { applyTheme, savedTheme } from './themes.ts';

applyTheme(savedTheme());

// Системное «Подтвердить» в Electron отбирает у страницы клавиатурный фокус — после него просим окно вернуть его.
const nativeConfirm = window.confirm.bind(window);
window.confirm = (message?: string): boolean => {
  const r = nativeConfirm(message);
  void call('app:refocus').catch(() => {});
  return r;
};

createRoot(document.getElementById('root')!).render(<App />);
