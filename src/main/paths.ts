import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Папка данных (Схема_БД.md §1). Root для программы: <AppData | Application Support>/RoyaltyLab. */
export interface DataPaths {
  root: string;
  dbFile: string;
  usersFile: string;
  reports: string;
  output: string;
  backups: string;
  templates: string;
}

export function dataPaths(root: string): DataPaths {
  return {
    root,
    dbFile: join(root, 'data.rldb'),
    usersFile: join(root, 'users.json'),
    reports: join(root, 'reports'),
    output: join(root, 'output'),
    backups: join(root, 'backups'),
    templates: join(root, 'templates'),
  };
}

export function ensureDataDirs(p: DataPaths): void {
  for (const d of [p.root, p.reports, p.output, p.backups, p.templates]) mkdirSync(d, { recursive: true });
}
