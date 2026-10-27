// Контейнер файла обновления .rlab: "RLAB1" | соль(16) | iv(12) | тег(16) | шифртекст (AES-256-GCM).
// Ключ из пароля обмена через argon2id (Схема_БД.md §10).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type DeriveKey = (password: string, salt: Buffer) => Promise<Buffer>;
const MAGIC = Buffer.from('RLAB1');
export const MIN_EXCHANGE_PASSWORD = 6;

export const argonKey: DeriveKey = async (password, salt) => {
  const { argon2id } = await import('hash-wasm');
  return Buffer.from(await argon2id({ password, salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'binary' }));
};

export async function sealRlab(zip: Buffer, password: string, derive: DeriveKey = argonKey): Promise<Buffer> {
  if (password.length < MIN_EXCHANGE_PASSWORD) throw new Error(`Пароль обмена короче ${MIN_EXCHANGE_PASSWORD} символов`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await derive(password, salt), iv);
  c.setAAD(MAGIC);
  const ct = Buffer.concat([c.update(zip), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct]);
}

export async function openRlab(file: Buffer, password: string, derive: DeriveKey = argonKey): Promise<Buffer> {
  if (file.length < 49 || !file.subarray(0, 5).equals(MAGIC)) throw new Error('Это не файл обновления Royalty Lab (.rlab)');
  const salt = file.subarray(5, 21);
  const d = createDecipheriv('aes-256-gcm', await derive(password, salt), file.subarray(21, 33));
  d.setAAD(MAGIC);
  d.setAuthTag(file.subarray(33, 49));
  try {
    return Buffer.concat([d.update(file.subarray(49)), d.final()]);
  } catch {
    throw new Error('Неверный пароль обмена или файл повреждён');
  }
}
