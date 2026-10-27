import { useEffect, useMemo, useRef, useState } from 'react';
import { norm } from './sort.tsx';

export interface Opt { value: string; label: string; hint?: string }

/** Выпадающий список с поиском: начинаешь печатать — список сам сужается. Enter выбирает первый подходящий. */
export function SearchSelect({ options, value, onChange, placeholder = 'Начните печатать…', empty, width }: { options: Opt[]; value: string; onChange: (v: string) => void; placeholder?: string; empty?: string; width?: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  const list = useMemo(() => {
    const n = norm(q.trim());
    const all = empty !== undefined ? [{ value: '', label: empty }, ...options] : options;
    if (!n) return all;
    return all.filter((o) => o.value !== '' && norm(`${o.label} ${o.hint ?? ''}`).includes(n)).sort((a, b) => Number(!norm(a.label).startsWith(n)) - Number(!norm(b.label).startsWith(n)));
  }, [options, q, empty]);
  useEffect(() => { setHi(0); }, [q, open]);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); };
  return (
    <div className="ss" ref={box} style={width ? { width } : undefined}>
      <input
        value={open ? q : cur?.label ?? ''}
        placeholder={cur ? cur.label : (empty ?? placeholder)}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter' && list[hi]) { e.preventDefault(); pick(list[hi]!.value); }
          else if (e.key === 'Escape') { setOpen(false); setQ(''); }
        }}
      />
      {open && (
        <div className="ss-list">
          {list.length === 0 && <div className="dim" style={{ padding: 8 }}>Ничего не найдено</div>}
          {list.slice(0, 80).map((o, i) => (
            <div key={o.value + i} className={'ss-opt' + (i === hi ? ' on' : '')} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
              {o.label}{o.hint && <span className="dim"> · {o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
