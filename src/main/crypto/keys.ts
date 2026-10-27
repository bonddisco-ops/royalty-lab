import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { uuidv7 } from '../domain/ids.ts';

// Схема_БД.md §2: один случайный ключ данных (DK) шифрует базу и файлы отчётов.
// У каждого пользователя свой пароль → argon2id → ключ, которым зашифрована копия DK.
// Два пароля открывают одну базу; смена пароля не требует перешифровки базы.

export type Role = 'owner' | 'accountant';
export interface KdfParams { t: number; m: number; p: number }
export interface UserRecord {
  login: string;
  role: Role;
  salt: string; // base64
  wrapped_dk: string; // base64: iv(12) | tag(16) | ciphertext
  kdf: KdfParams;
  created_at: string;
}
export interface UsersFile {
  version: 1;
  replica_id: string;
  users: UserRecord[];
}

export const DEFAULT_KDF: KdfParams = { t: 3, m: 65536, p: 1 };
export const MIN_PASSWORD_LENGTH = 8;
const BAD_CREDENTIALS = 'Неверный логин или пароль';

async function deriveKek(password: string, saltB64: string, kdf: KdfParams): Promise<Buffer> {
  const { argon2id } = await import('hash-wasm');
  const out = await argon2id({
    password,
    salt: Buffer.from(saltB64, 'base64'),
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

function wrap(dk: Buffer, kek: Buffer, login: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(Buffer.from(login, 'utf8'));
  const ct = Buffer.concat([c.update(dk), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function unwrap(wrapped: string, kek: Buffer, login: string): Buffer {
  const b = Buffer.from(wrapped, 'base64');
  const d = createDecipheriv('aes-256-gcm', kek, b.subarray(0, 12));
  d.setAAD(Buffer.from(login, 'utf8'));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

export function readUsers(file: string): UsersFile | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as UsersFile;
}

function writeUsers(file: string, data: UsersFile): void {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

function checkNewCredentials(login: string, password: string): void {
  if (!login.trim()) throw new Error('Логин не может быть пустым');
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Пароль короче ${MIN_PASSWORD_LENGTH} символов`);
}

async function makeRecord(dk: Buffer, login: string, password: string, role: Role): Promise<UserRecord> {
  const salt = randomBytes(16).toString('base64');
  const kek = await deriveKek(password, salt, DEFAULT_KDF);
  return { login, role, salt, wrapped_dk: wrap(dk, kek, login), kdf: DEFAULT_KDF, created_at: new Date().toISOString() };
}

/** Первый запуск: создаёт DK, идентификатор установки и первого пользователя (владельца). */
export async function initVault(usersFile: string, login: string, password: string): Promise<{ dk: Buffer; replicaId: string; user: UserRecord }> {
  if (existsSync(usersFile)) throw new Error('Хранилище уже создано');
  checkNewCredentials(login, password);
  const dk = randomBytes(32);
  const user = await makeRecord(dk, login.trim(), password, 'owner');
  const replicaId = uuidv7();
  writeUsers(usersFile, { version: 1, replica_id: replicaId, users: [user] });
  return { dk, replicaId, user };
}

export async function addUser(usersFile: string, dk: Buffer, login: string, password: string, role: Role): Promise<void> {
  const file = readUsers(usersFile);
  if (!file) throw new Error('Хранилище не создано');
  checkNewCredentials(login, password);
  if (file.users.some((u) => u.login.toLowerCase() === login.trim().toLowerCase())) throw new Error('Пользователь с таким логином уже есть');
  file.users.push(await makeRecord(dk, login.trim(), password, role));
  writeUsers(usersFile, file);
}

export async function unlock(usersFile: string, login: string, password: string): Promise<{ dk: Buffer; replicaId: string; user: UserRecord }> {
  const file = readUsers(usersFile);
  const user = file?.users.find((u) => u.login.toLowerCase() === login.trim().toLowerCase());
  if (!file || !user) throw new Error(BAD_CREDENTIALS);
  const kek = await deriveKek(password, user.salt, user.kdf);
  try {
    return { dk: unwrap(user.wrapped_dk, kek, user.login), replicaId: file.replica_id, user };
  } catch {
    throw new Error(BAD_CREDENTIALS);
  }
}

export async function changePassword(usersFile: string, login: string, oldPassword: string, newPassword: string): Promise<void> {
  const { dk } = await unlock(usersFile, login, oldPassword);
  checkNewCredentials(login, newPassword);
  const file = readUsers(usersFile)!;
  const idx = file.users.findIndex((u) => u.login.toLowerCase() === login.trim().toLowerCase());
  const old = file.users[idx]!;
  file.users[idx] = { ...(await makeRecord(dk, old.login, newPassword, old.role)), created_at: old.created_at };
  writeUsers(usersFile, file);
}

export function listUsers(usersFile: string): Array<{ login: string; role: Role }> {
  return (readUsers(usersFile)?.users ?? []).map((u) => ({ login: u.login, role: u.role }));
}
