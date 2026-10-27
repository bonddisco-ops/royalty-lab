import { useMemo, useState } from 'react';

type Key = string | number | null | undefined;
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

/** Сортировка таблицы по клику на заголовок: алфавит, числа, даты. Повторный клик меняет направление. */
export function useSort<T>(rows: T[], keys: Record<string, (r: T) => Key>, initial?: { key: string; dir?: 1 | -1 }) {
  const [state, setState] = useState<{ key: string; dir: 1 | -1 } | null>(initial ? { key: initial.key, dir: initial.dir ?? 1 } : null);
  const sorted = useMemo(() => {
    if (!state || !keys[state.key]) return rows;
    const f = keys[state.key]!;
    return [...rows].sort((a, b) => {
      const x = f(a), y = f(b);
      if (x == null || x === '') return y == null || y === '' ? 0 : 1; // пустые всегда внизу
      if (y == null || y === '') return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      return c * state.dir;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, state]);
  const th = (key: string, label: string, style?: React.CSSProperties) => (
    <th className="sortable" style={style} onClick={() => setState((s) => (s && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }))}>
      {label}{state?.key === key ? (state.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return { sorted, th };
}
