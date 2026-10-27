// Темы оформления: те же пять, что в плагинах Primal Rage Lab (Crumble), и светлая «Paper».
export interface ThemeDef {
  id: string;
  name: string;
  vars: Record<string, string>;
  gloss?: boolean;
}

const base = (v: Record<string, string>): Record<string, string> => v;

export const THEMES: ThemeDef[] = [
  { id: 'asphalt', name: 'Asphalt', vars: base({ bg: '#18191c', panel: '#1f2024', panel2: '#2a2b31', line: '#3a3b42', text: '#ececf0', dim: '#a5a5ad', accent: '#ff73b2', 'on-accent': '#1a0a12', bad: '#ff6b7a', ok: '#7fd18b', logo: '#ff73b2', 'warn-bg': '#3a2f10', 'warn-fg': '#ffd98a' }) },
  { id: 'mango', name: 'Mango', vars: base({ bg: '#f2a42a', panel: '#f8be5a', panel2: '#e8961c', line: '#c68010', text: '#2b1a00', dim: '#6b4a10', accent: '#08899b', 'on-accent': '#ffffff', bad: '#a8200f', ok: '#0b6a2a', logo: '#5a3205', 'warn-bg': '#fff0c2', 'warn-fg': '#5a3205' }) },
  { id: 'rage', name: 'Rage', vars: base({ bg: '#100c0c', panel: '#1a1313', panel2: '#251a1a', line: '#432b2b', text: '#f2e6e2', dim: '#b09a96', accent: '#ff3045', 'on-accent': '#ffffff', bad: '#ff8a5a', ok: '#7fb56b', logo: '#ff3045', 'warn-bg': '#3a1d12', 'warn-fg': '#ffc9a8' }) },
  { id: 'ultraviolet', name: 'Ultraviolet', vars: base({ bg: '#22123a', panel: '#2c1948', panel2: '#38215a', line: '#523b7c', text: '#f3ecff', dim: '#b9a6d9', accent: '#ff8c3c', 'on-accent': '#1d0d00', bad: '#ff6a8a', ok: '#6fe0b0', logo: '#ff9d4d', 'warn-bg': '#3d2a5e', 'warn-fg': '#ffd9a8' }) },
  { id: 'luxe', name: 'Luxe', gloss: true, vars: base({ bg: '#0a0a0c', panel: '#121214', panel2: '#1c1b1e', line: '#463c26', text: '#f4eedc', dim: '#b8a77a', accent: '#d6af50', 'on-accent': '#1a1405', bad: '#e5645a', ok: '#8fc47a', logo: '#e8c46a', 'warn-bg': '#2c2410', 'warn-fg': '#f0d68a' }) },
  { id: 'paper', name: 'Paper (светлая)', vars: base({ bg: '#f4f2ee', panel: '#ffffff', panel2: '#ebe8e2', line: '#d6d1c8', text: '#1d1b18', dim: '#6f695f', accent: '#c2477f', 'on-accent': '#ffffff', bad: '#c0332b', ok: '#2f7d3a', logo: '#5f5c60', 'warn-bg': '#fff3d1', 'warn-fg': '#6b4a00' }) },
];

const KEY = 'rl-theme';
export const DEFAULT_THEME = 'asphalt';

export function savedTheme(): string {
  try { const v = localStorage.getItem(KEY); if (v && THEMES.some((t) => t.id === v)) return v; } catch { /* хранилище недоступно */ }
  return DEFAULT_THEME;
}

export function applyTheme(id: string): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0]!;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(`--${k}`, v);
  root.dataset.theme = t.id;
  root.dataset.gloss = t.gloss ? '1' : '0';
  try { localStorage.setItem(KEY, t.id); } catch { /* не страшно */ }
  window.dispatchEvent(new Event('rl-theme'));
}

export function themeVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}
