import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import { applyTheme, savedTheme } from './themes.ts';

applyTheme(savedTheme());

createRoot(document.getElementById('root')!).render(<App />);
