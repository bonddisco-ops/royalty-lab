import { useEffect, useRef, useState } from 'react';
import type { PhotoTable } from '../../shared/api.ts';
import { call } from './api.ts';
import { Avatar, dropAvatarCache } from './Avatar.tsx';

const FULL = 512;
const THUMB = 96;
const VIEW = 300;

async function toPng(src: HTMLCanvasElement | OffscreenCanvas): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => (src as HTMLCanvasElement).toBlob(res, 'image/png'));
  if (!blob) throw new Error('Не удалось подготовить картинку');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Окно картинки: перетащить файл или выбрать, подвинуть/приблизить, обрезка под квадрат или круг,
 * «Сохранить», «Убрать», «Сохранить в файл». Круг — это только маска просмотра: файл всегда квадратный.
 */
export function PhotoEditor({ table, id, file, title, onClose }: { table: PhotoTable; id: string; file: string | null; title: string; onClose: (changed: boolean) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const [circle, setCircle] = useState(table !== 'track');
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const changed = useRef(false);

  const base = img ? VIEW / Math.min(img.width, img.height) : 1; // «вписать» меньшую сторону в квадрат
  function draw(target: HTMLCanvasElement, size: number) {
    if (!img) return;
    const ctx = target.getContext('2d')!;
    target.width = size; target.height = size;
    const k = (size / VIEW) * base * zoom;
    const w = img.width * k, h = img.height * k;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, size / 2 - w / 2 + off.x * (size / VIEW), size / 2 - h / 2 + off.y * (size / VIEW), w, h);
  }
  useEffect(() => { if (canvas.current) draw(canvas.current, VIEW); });

  function load(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith('image/')) return setErr('Это не картинка');
    if (f.size > 25 * 1024 * 1024) return setErr('Файл слишком большой (больше 25 МБ)');
    setErr('');
    const url = URL.createObjectURL(f);
    const im = new Image();
    im.onload = () => { setImg(im); setZoom(1); setOff({ x: 0, y: 0 }); };
    im.onerror = () => setErr('Не получилось открыть картинку');
    im.src = url;
  }

  async function save() {
    if (!img) return;
    setErr('');
    try {
      const big = document.createElement('canvas'); draw(big, FULL);
      const small = document.createElement('canvas'); draw(small, THUMB);
      await call('photo:set', { table, id, full: await toPng(big), thumb: await toPng(small) });
      dropAvatarCache(); changed.current = true; onClose(true);
    } catch (e) { setErr((e as Error).message); }
  }
  async function remove() {
    if (!confirm('Убрать картинку?')) return;
    try { await call('photo:remove', { table, id }); dropAvatarCache(); onClose(true); } catch (e) { setErr((e as Error).message); }
  }
  async function exportFile() {
    setErr(''); setMsg('');
    try { const p = await call('photo:export', { table, id }); if (p) setMsg(`Сохранено: ${p}`); } catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="modal" style={{ zIndex: 20 }}><div className="dialog" style={{ width: 460 }}>
      <h1>{table === 'track' ? 'Обложка' : 'Фото'}: {title}</h1>
      {!img && (
        <>
          {file && <div style={{ textAlign: 'center', marginBottom: 12 }}><Avatar file={file} big square={table === 'track'} /></div>}
          <div className={'drop' + (over ? ' over' : '')}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); load(e.dataTransfer.files[0]); }}>
            Перетащите картинку сюда или
            <div style={{ marginTop: 8 }}><label className="btnlike"><input type="file" accept="image/*" hidden onChange={(e) => load(e.target.files?.[0])} /><span className="primary" style={{ padding: '6px 12px', borderRadius: 6, background: 'var(--accent)', color: '#1a130a', cursor: 'pointer', fontWeight: 600 }}>{file ? 'Заменить…' : 'Выбрать файл…'}</span></label></div>
          </div>
        </>
      )}
      {img && (
        <>
          <div className={'crop' + (circle ? ' circle' : '')}
            onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; }}
            onPointerMove={(e) => { if (drag.current) setOff({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y }); }}
            onPointerUp={() => { drag.current = null; }}>
            <canvas ref={canvas} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="dim">Масштаб</span><input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            <label className="row"><input type="checkbox" style={{ width: 'auto' }} checked={circle} onChange={(e) => setCircle(e.target.checked)} />круг</label>
          </div>
          <div className="dim" style={{ marginTop: 6 }}>Двигайте картинку мышью. Сохраняется квадрат 512×512; круг — только вид в списках.</div>
        </>
      )}
      {err && <div className="err">{err}</div>}{msg && <div className="okmsg">{msg}</div>}
      <div className="row end">
        {file && !img && <><button onClick={exportFile}>Сохранить в файл</button><button onClick={remove}>Убрать</button></>}
        {img && <button onClick={() => setImg(null)}>Другая картинка</button>}
        <button onClick={() => onClose(changed.current)}>Закрыть</button>
        {img && <button className="primary" onClick={save}>Сохранить</button>}
      </div>
    </div></div>
  );
}
