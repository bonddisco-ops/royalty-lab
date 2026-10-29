// Сопоставление файлов обложек с треками по имени: «Артист1, Артист2 - Название.jpg».
export interface CoverTrack { id: string; title: string; version: string | null; artists: string[]; hasCover: boolean }
export interface CoverMatch { name: string; status: 'ok' | 'ambiguous' | 'none' | 'bad'; candidates: string[] }

export const isImageName = (n: string): boolean => /\.(jpe?g|png|webp|bmp|gif)$/i.test(n);

export const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const aKey = (names: string[]): string => names.map(norm).filter(Boolean).sort().join('|');

export function matchCovers(fileNames: string[], tracks: CoverTrack[]): CoverMatch[] {
  const index = new Map<string, Set<string>>();
  const add = (k: string, id: string) => { const s = index.get(k) ?? new Set<string>(); s.add(id); index.set(k, s); };
  for (const t of tracks) {
    const a = aKey(t.artists);
    add(`${a}||${norm(t.title)}`, t.id);
    if (t.version) add(`${a}||${norm(`${t.title} ${t.version}`)}`, t.id);
  }
  return fileNames.map((name): CoverMatch => {
    const base = name.replace(/\.[^.]+$/, '').replace(/[–—−]/g, '-');
    const seps = [...base.matchAll(/\s-\s/g)].map((m) => m.index ?? 0);
    if (seps.length === 0) return { name, status: 'bad', candidates: [] };
    const found = new Set<string>();
    for (const i of seps) {
      const left = base.slice(0, i), right = base.slice(i + 3);
      for (const id of index.get(`${aKey(left.split(','))}||${norm(right)}`) ?? []) found.add(id);
    }
    if (found.size === 0) return { name, status: 'none', candidates: [] };
    return { name, status: found.size === 1 ? 'ok' : 'ambiguous', candidates: [...found] };
  });
}
