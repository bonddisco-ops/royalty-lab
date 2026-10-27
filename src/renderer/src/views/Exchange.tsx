import { useState } from 'react';
import type { UpdatePreview } from '../../../shared/api.ts';
import { call } from '../api.ts';
import { FIELD_LABELS } from '../api.ts';
import { fmtKop } from '../util.ts';

const KIND_RU = { insert: 'новое', update: 'изменено', delete: 'удалено' } as const;
const fmt = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
const short = (v: string | null): string => (v === null || v === '' ? '—' : v.length > 60 ? v.slice(0, 60) + '…' : v);

export function Exchange({ onChanged }: { onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [pw, setPw] = useState('');
  const [pii, setPii] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [data, setData] = useState<{ token: string; preview: UpdatePreview } | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => { setErr(''); setMsg(''); setBusy(true); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const toggle = (s: Set<string>, k: string): Set<string> => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; };

  const doSave = () => run(async () => {
    const r = await call('sync:save', { password: pw, includePii: pii });
    if (r) { setMsg(`Обновление сохранено: ${r.path} (${r.events} изменений, ${(r.bytes / 1024 / 1024).toFixed(1)} МБ). Пароль передайте отдельно от файла.`); setSaving(false); setPw(''); }
  });
  const doOpen = () => run(async () => {
    const r = await call('sync:open', { password: pw });
    if (r) { setData(r); setSkip(new Set()); setMine(new Set()); setOpening(false); setPw(''); }
  });
  const apply = () => run(async () => {
    const r = await call('sync:apply', { token: data!.token, skipGroups: [...skip], keepMine: [...mine] });
    setMsg(`Применено правок: ${r.applied}, пропущено: ${r.skipped}${r.lines ? `, строк отчётов: ${r.lines}` : ''}${r.files ? `, файлов: ${r.files}` : ''}. Перед этим сделана копия базы.`);
    setData(null); onChanged();
  });
  const cancel = () => { void call('sync:cancel'); setData(null); };

  return (
    <>
      <h2>Обмен обновлениями</h2>
      <div className="dim">Один файл .rlab содержит все правки, фото, обложки и файлы отчётов. Защищён паролем обмена. Паспорта и банк — только по галочке.</div>
      {msg && <div className="okmsg">{msg}</div>}{err && !saving && !opening && <div className="err">{err}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => { setSaving(true); setErr(''); setPw(''); }}>Сохранить обновление…</button>
        <button onClick={() => { setOpening(true); setErr(''); setPw(''); }}>Загрузить обновление…</button>
      </div>

      {(saving || opening) && (
        <div className="modal"><div className="dialog" style={{ maxWidth: 480 }}>
          <h2>{saving ? 'Сохранить обновление' : 'Загрузить обновление'}</h2>
          <label className="f">Пароль обмена<input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          {saving && <label className="chk"><input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} /> Включить паспорта, ИНН, адреса и банк. Заодно отправятся все данные заново.</label>}
          {saving && <div className="dim">Придумайте пароль (от 6 символов) и скажите его получателю другим способом.</div>}
          {err && <div className="err">{err}</div>}
          <div className="row end">
            <button onClick={() => { setSaving(false); setOpening(false); }}>Отмена</button>
            <button className="primary" disabled={busy || pw.length < 1} onClick={() => void (saving ? doSave() : doOpen())}>{saving ? 'Выбрать, куда сохранить' : 'Выбрать файл'}</button>
          </div>
        </div></div>
      )}

      {data && (
        <div className="modal"><div className="dialog" style={{ maxWidth: 900, maxHeight: '88vh', overflow: 'auto' }}>
          <h2>Что изменилось</h2>
          <div className="dim">От {data.preview.author}, {fmt(data.preview.ts)}. {data.preview.fresh === 0 ? 'Всё из этого файла у вас уже есть.' : `Новых правок: ${data.preview.fresh}.`}{data.preview.includePii ? ' Файл содержит паспорта и банк.' : ''}</div>
          {data.preview.reports.length > 0 && (
            <div className="card" style={{ margin: '8px 0' }}>
              <b>Отчёты в файле</b>
              {data.preview.reports.map((r, i) => <div key={i}>{r.label}: {r.lines} строк, {fmtKop(r.rowsKop)}</div>)}
            </div>
          )}
          {data.preview.conflicts > 0 && <div className="warn">Пересечений: {data.preview.conflicts}. Одно и то же поле изменено у обоих. По каждому выберите «моё» или «его».</div>}
          {data.preview.groups.map((g) => {
            const off = skip.has(g.key);
            return (
              <div key={g.key} style={{ borderTop: '1px solid var(--line)', padding: '6px 0', opacity: off ? 0.45 : 1 }}>
                <label className="chk"><input type="checkbox" checked={!off} onChange={() => setSkip(toggle(skip, g.key))} />
                  <b>{g.title}</b> <span className="badge">{KIND_RU[g.kind]}</span> <span className="dim">{g.users.join(', ')} · {fmt(g.to)}</span></label>
                {g.changes.filter((c) => c.field).map((c) => (
                  <div key={c.eventId} style={{ marginLeft: 26 }}>
                    {FIELD_LABELS[c.field!] ?? c.field}: <span className="dim">{short(c.was)}</span> → <b>{short(c.now)}</b>
                    {c.conflict && (
                      <span style={{ marginLeft: 8 }}>
                        <label><input type="radio" style={{ width: 'auto' }} checked={!mine.has(c.eventId)} onChange={() => setMine(new Set([...mine].filter((x) => x !== c.eventId)))} /> его</label>{' '}
                        <label><input type="radio" style={{ width: 'auto' }} checked={mine.has(c.eventId)} onChange={() => setMine(new Set([...mine, c.eventId]))} /> моё ({short(c.mine)})</label>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {err && <div className="err">{err}</div>}
          <div className="row end" style={{ marginTop: 10 }}>
            <button onClick={cancel}>Не применять</button>
            <button className="primary" disabled={busy || data.preview.fresh === 0} onClick={() => void apply()}>Применить{skip.size ? ` (кроме ${skip.size})` : ''}</button>
          </div>
        </div></div>
      )}
    </>
  );
}
