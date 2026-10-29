import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackView } from '../../shared/api.ts';
import { call } from './api.ts';
import { dropAvatarCache } from './Avatar.tsx';
import { isImageName, matchCovers, type CoverTrack } from './coverMatch.ts';

const FULL = 512;
const THUMB = 96;

async function prepare(file: File): Promise<{ full: Uint8Array; thumb: Uint8Array }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('не открылась картинка')); im.src = url; });
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
    const png = async (size: number): Promise<Uint8Array> => {
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      c.getContext('2d')!.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('не получилось подготовить картинку');
      return new Uint8Array(await blob.arrayBuffer());
    };
    return { full: await png(FULL), thumb: await png(THUMB) };
  } finally { URL.revokeObjectURL(url); }
}

/** Массовая загрузка обложек: папка с файлами «Артисты - Название.jpg» → треки каталога. */
export function CoverImport({ onClose }: { onClose: (changed: boolean) => void }) {
  const [tracks, setTracks] = useState<TrackView[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ ok: number; fail: string[] } | null>(null);
  const [err, setErr] = useState('');
  const changed = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { void call('tracks:list', { q: '', onlyProblems: false }).then(setTracks).catch((e: Error) => setErr(e.message)); }, []);
  useEffect(() => { input.current?.setAttribute('webkitdirectory', ''); }, []);

  const ct: CoverTrack[] = useMemo(() => tracks.map((t) => ({ id: t.id, title: t.title, version: t.version, artists: t.participants.map((p) => p.artist), hasCover: !!t.cover })), [tracks]);
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const matches = useMemo(() => matchCovers(files.map((f) => f.name), ct), [files, ct]);
  const label = (id: string) => { const t = byId.get(id); return t ? `${t.participants.map((p) => p.artist).join(', ')} – ${t.title}${t.version ? ` (${t.version})` : ''}${t.isrc ? ` · ${t.isrc}` : ''}` : id; };

  // итоговая раскладка: файл → трек (или null, если пропускаем)
  const plan = matches.map((m, i) => {
    const id = m.status === 'ok' ? m.candidates[0]! : m.status === 'ambiguous' ? (pick[m.name] || '') : '';
    const skipHas = id && !replace && byId.get(id)?.cover;
    return { i, m, id, skip: !id || !!skipHas, has: !!skipHas };
  });
  // если два файла претендуют на один трек, второй пропускаем
  const taken = new Set<string>();
  for (const p of plan) { if (p.skip) continue; if (taken.has(p.id)) { p.skip = true; (p as { dup?: boolean }).dup = true; } else taken.add(p.id); }
  const toLoad = plan.filter((p) => !p.skip);

  const choose = (list: FileList | null) => {
    setDone(null); setPick({});
    setFiles([...(list ?? [])].filter((f) => isImageName(f.name)));
  };
  const run = async () => {
    setBusy(true); setErr('');
    let ok = 0; const fail: string[] = [];
    for (const p of toLoad) {
      try { const { full, thumb } = await prepare(files[p.i]!); await call('photo:set', { table: 'track', id: p.id, full, thumb }); ok++; changed.current = true; } catch (e) { fail.push(`${files[p.i]!.name}: ${(e as Error).message}`); }
    }
    dropAvatarCache();
    setDone({ ok, fail }); setBusy(false);
    void call('tracks:list', { q: '', onlyProblems: false }).then(setTracks);
  };
  const cnt = (s: string) => matches.filter((m) => m.status === s).length;

  return (
    <div className="modal"><div className="dialog" style={{ maxWidth: 820, width: '92vw' }}>
      <h2>Загрузка обложек из папки</h2>
      <p className="dim">Файлы должны называться «Артист, Артист - Название.jpg». Регистр, тире и порядок артистов не важны. Обложка обрезается по центру до квадрата.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <input ref={input} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={(e) => { choose(e.target.files); e.target.value = ''; }} />
        <button className="primary" disabled={busy} onClick={() => input.current?.click()}>Выбрать папку с обложками</button>
        {files.length > 0 && <label className="row" style={{ gap: 4 }}><input type="checkbox" style={{ width: 'auto' }} checked={replace} onChange={(e) => setReplace(e.target.checked)} />заменять уже загруженные обложки</label>}
      </div>
      {err && <div className="err">{err}</div>}
      {files.length > 0 && (
        <>
          <p>Файлов: {files.length} · найдено: <b>{cnt('ok')}</b> · спорных: <b>{cnt('ambiguous')}</b> · не найдено: <b>{cnt('none')}</b> · не по формату: <b>{cnt('bad')}</b></p>
          <div style={{ maxHeight: '45vh', overflow: 'auto' }}>
            <table>
              <thead><tr><th>Файл</th><th>Трек</th></tr></thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.i}>
                    <td>{p.m.name}</td>
                    <td>
                      {p.m.status === 'ok' && <>{label(p.id)}{p.has && <span className="badge"> уже есть, пропуск</span>}{(p as { dup?: boolean }).dup && <span className="badge bad"> дубль файла, пропуск</span>}</>}
                      {p.m.status === 'ambiguous' && (
                        <select value={pick[p.m.name] ?? ''} onChange={(e) => setPick({ ...pick, [p.m.name]: e.target.value })}>
                          <option value="">— выберите трек (или пропустить) —</option>
                          {p.m.candidates.map((id) => <option key={id} value={id}>{label(id)}</option>)}
                        </select>
                      )}
                      {p.m.status === 'none' && <span className="badge bad">трек не найден</span>}
                      {p.m.status === 'bad' && <span className="badge bad">нет « - » между артистом и названием</span>}
                    </td>
                  </tr>))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {done && <div className={done.fail.length ? 'warn' : 'okmsg'}>Загружено: {done.ok}.{done.fail.length > 0 && <> Не получилось: {done.fail.length}<ul className="plain">{done.fail.slice(0, 10).map((f) => <li key={f}>{f}</li>)}</ul></>}</div>}
      <div className="row end">
        <button disabled={busy} onClick={() => onClose(changed.current)}>{done ? 'Закрыть' : 'Отмена'}</button>
        <button className="primary" disabled={busy || toLoad.length === 0} onClick={() => void run()}>{busy ? 'Загружаю…' : `Загрузить обложки: ${toLoad.length}`}</button>
      </div>
    </div></div>
  );
}
