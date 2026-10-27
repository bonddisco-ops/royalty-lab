// Маленький конфиг в профиле пользователя: где лежат данные и куда делать бэкапы.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface AppConfig {
  /** Папка RoyaltyLab/ с data.rldb. null = первый запуск. */
  dataRoot: string | null;
  /** Отдельная папка для бэкапов (лучше на другом диске). null = RoyaltyLab/backups. */
  backupDir: string | null;
}

export function readConfig(file: string): AppConfig {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppConfig>;
    return { dataRoot: typeof j.dataRoot === 'string' && j.dataRoot ? j.dataRoot : null, backupDir: typeof j.backupDir === 'string' && j.backupDir ? j.backupDir : null };
  } catch {
    return { dataRoot: null, backupDir: null };
  }
}

export function writeConfig(file: string, cfg: AppConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, file);
}

/** Из выбранной пользователем папки получаем корень данных: <выбранная>/RoyaltyLab. */
export function rootFromParent(parent: string): string {
  return join(parent, 'RoyaltyLab');
}

/** Для «Указать папку заново»: принимаем саму папку с данными или родителя, где внутри есть RoyaltyLab/data.rldb. */
export function findExistingRoot(picked: string): string | null {
  if (existsSync(join(picked, 'data.rldb'))) return picked;
  const inner = rootFromParent(picked);
  if (existsSync(join(inner, 'data.rldb'))) return inner;
  return null;
}

/** Предупреждение для папок в облаке / на сетевом диске. SQLite при синхронизации во время работы может повредиться. */
export function cloudWarning(path: string): string | null {
  const p = path.replace(/\\/g, '/').toLowerCase();
  let kind: string | null = null;
  if (p.startsWith('//') && !p.startsWith('//?/')) kind = 'сетевом диске';
  else if (/\/dropbox(\/|$)/.test(p)) kind = 'папке Dropbox';
  else if (/\/(yandexdisk|яндекс\.?диск|yandex\.disk)(\/|$)/.test(p)) kind = 'папке Яндекс.Диска';
  else if (/\/onedrive[^/]*(\/|$)/.test(p)) kind = 'папке OneDrive';
  else if (/\/(icloud drive|mobile documents|iclouddrive)(\/|$)/.test(p) || /com~apple~clouddocs/.test(p)) kind = 'папке iCloud';
  else if (/\/(google drive|googledrive|google диск)(\/|$)/.test(p) || p.includes('/cloudstorage/googledrive')) kind = 'папке Google Диска';
  else if (/\/(mega|nextcloud|owncloud)(\/|$)/.test(p)) kind = 'синхронизируемой папке';
  else if (/^\/(volumes|mnt|media)\/.+/.test(p) === false && /^smb:|^nfs:|^afp:/.test(p)) kind = 'сетевом диске';
  if (!kind) return null;
  return `Папка находится на ${kind}. Если облако синхронизирует файл базы, пока программа открыта, SQLite может повредиться. Рекомендую локальный диск (а облако — для копий). Запретить я не могу, решать вам.`;
}

export const SEP = sep;
