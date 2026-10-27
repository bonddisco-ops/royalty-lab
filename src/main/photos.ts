// Фото людей и артистов, обложки треков. Файлы лежат в папке данных (photos/), зашифрованы ключом данных
// (AES-256-GCM: iv(12) | tag(16) | шифртекст). В базе только имя файла; уменьшенная копия — рядом, с суффиксом .thumb.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from './domain/ids.ts';

const NAME_RE = /^[0-9a-f-]{36}\.img$/;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function encryptBuf(dk: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dk, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptBuf(dk: Buffer, blob: Uint8Array): Buffer {
  const b = Buffer.from(blob);
  if (b.length < 28) throw new Error('Файл картинки повреждён');
  const d = createDecipheriv('aes-256-gcm', dk, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  try {
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  } catch {
    throw new Error('Не удалось расшифровать картинку (неверный ключ или повреждённый файл)');
  }
}

const thumbName = (file: string): string => file.replace(/\.img$/, '.thumb');
function checkName(file: string): void {
  if (!NAME_RE.test(file)) throw new Error('Недопустимое имя файла картинки');
}

/** Сохраняет картинку и миниатюру, возвращает имя файла для колонки photo_file / cover_file. */
export function savePhoto(dir: string, dk: Buffer, full: Uint8Array, thumb: Uint8Array): string {
  if (full.length === 0 || full.length > MAX_IMAGE_BYTES) throw new Error('Картинка пустая или больше 8 МБ');
  if (thumb.length === 0 || thumb.length > MAX_IMAGE_BYTES) throw new Error('Миниатюра пустая или слишком большая');
  mkdirSync(dir, { recursive: true });
  const file = `${uuidv7()}.img`;
  writeFileSync(join(dir, file), encryptBuf(dk, full));
  writeFileSync(join(dir, thumbName(file)), encryptBuf(dk, thumb));
  return file;
}

export function readPhoto(dir: string, dk: Buffer, file: string, thumb: boolean): Buffer | null {
  checkName(file);
  const p = join(dir, thumb ? thumbName(file) : file);
  return existsSync(p) ? decryptBuf(dk, readFileSync(p)) : null;
}

export function removePhoto(dir: string, file: string | null | undefined): void {
  if (!file) return;
  checkName(file);
  rmSync(join(dir, file), { force: true });
  rmSync(join(dir, thumbName(file)), { force: true });
}
