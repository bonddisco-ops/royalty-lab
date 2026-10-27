import { useEffect, useState } from 'react';
import { call } from './api.ts';

const cache = new Map<string, string | null>();
/** Сбрасывает кэш миниатюр (после замены/удаления картинки). */
export function dropAvatarCache(): void { cache.clear(); }

/** Маленькая миниатюра. Нет файла — заглушка с гориллой. */
export function Avatar({ file, square = false, big = false, onClick, title }: { file: string | null | undefined; square?: boolean; big?: boolean; onClick?: () => void; title?: string }) {
  const [src, setSrc] = useState<string | null>(file ? cache.get(file) ?? null : null);
  useEffect(() => {
    if (!file) { setSrc(null); return; }
    if (cache.has(file)) { setSrc(cache.get(file) ?? null); return; }
    let live = true;
    void call('photo:get', { file, thumb: !big }).then((d) => { cache.set(file, d); if (live) setSrc(d); }).catch(() => {});
    return () => { live = false; };
  }, [file, big]);
  return (
    <span className={'av' + (square ? ' sq' : '') + (big ? ' big' : '') + (onClick ? ' btn' : '')} onClick={onClick} title={title}>
      {src ? <img src={src} alt="" /> : '🦍'}
    </span>
  );
}
