// Перенос папки данных на другой диск/в другую папку: копируем, проверяем, старую НЕ удаляем.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function moveDataRoot(oldRoot: string, newRoot: string): { files: number; bytes: number } {
  const a = resolve(oldRoot), b = resolve(newRoot);
  if (a === b) throw new Error('Это та же самая папка');
  if (b.startsWith(a + sep) || a.startsWith(b + sep)) throw new Error('Новая папка не может лежать внутри старой (и наоборот)');
  if (existsSync(join(b, 'data.rldb'))) throw new Error('В новой папке уже есть data.rldb. Выберите другое место, чтобы ничего не затереть.');
  if (!existsSync(join(a, 'data.rldb'))) throw new Error('В старой папке нет data.rldb');
  cpSync(a, b, { recursive: true, filter: (src) => !/[\\/](\.rl-lock|\.rl-write-test)$/.test(src) && !/data\.rldb-(wal|shm)$/.test(src) });
  let files = 0, bytes = 0;
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (!/(\.rl-lock|data\.rldb-(wal|shm))$/.test(n)) {
        files++; bytes += st.size;
        const rel = relative(b, p);
        if (!existsSync(join(a, rel)) || statSync(join(a, rel)).size !== st.size) throw new Error(`Копия «${rel}» не совпала с оригиналом. Старые данные не тронуты.`);
      }
    }
  };
  walk(b);
  return { files, bytes };
}
