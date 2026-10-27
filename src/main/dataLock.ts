// Защита от двойного запуска на одних данных: файл-замок в папке данных.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

interface LockInfo { pid: number; host: string; since: string }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(file: string): void {
  if (existsSync(file)) {
    let info: LockInfo | null = null;
    try { info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo; } catch { /* битый замок считаем устаревшим */ }
    if (info && info.pid !== process.pid) {
      if (info.host !== hostname()) throw new Error(`Эти данные уже открыты на другом компьютере (${info.host}) с ${info.since}. Закройте программу там.`);
      if (alive(info.pid)) throw new Error('Эти данные уже открыты в другом окне программы.');
    }
  }
  const info: LockInfo = { pid: process.pid, host: hostname(), since: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(info));
}

export function releaseLock(file: string): void {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    if (info.pid === process.pid && info.host === hostname()) rmSync(file, { force: true });
  } catch { /* замка нет */ }
}
