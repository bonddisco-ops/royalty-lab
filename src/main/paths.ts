import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Папки программы.
 * - profileDir: профиль пользователя (маленький config.json и users.json с обёрнутым ключом).
 * - root: папка данных RoyaltyLab/, выбирается пользователем (по умолчанию = profileDir).
 */
export interface DataPaths {
  profileDir: string;
  configFile: string;
  usersFile: string;
  root: string;
  dbFile: string;
  reports: string;
  output: string;
  backups: string;
  photos: string;
  templates: string;
  lockFile: string;
}

export function dataPaths(root: string, profileDir: string, backupDir?: string | null): DataPaths {
  return {
    profileDir,
    configFile: join(profileDir, 'config.json'),
    usersFile: join(profileDir, 'users.json'),
    root,
    dbFile: join(root, 'data.rldb'),
    reports: join(root, 'reports'),
    output: join(root, 'output'),
    backups: backupDir || join(root, 'backups'),
    photos: join(root, 'photos'),
    templates: join(root, 'templates'),
    lockFile: join(root, '.rl-lock'),
  };
}

export function ensureDataDirs(p: DataPaths): void {
  for (const d of [p.profileDir, p.root, p.reports, p.output, p.photos, p.templates]) mkdirSync(d, { recursive: true });
  try {
    mkdirSync(p.backups, { recursive: true });
  } catch {
    // отдельная папка бэкапов может быть на отключённом диске — это не должно мешать запуску
  }
}
