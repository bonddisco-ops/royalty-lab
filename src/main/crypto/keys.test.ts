import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Требует hash-wasm и better-sqlite3-multiple-ciphers: гоняется в CI (локально без npm пропускается).
let hasDeps = true;
try {
  await import('hash-wasm');
  await import('better-sqlite3-multiple-ciphers');
} catch {
  hasDeps = false;
}

test('два пароля открывают один ключ данных, смена пароля не меняет ключ', { skip: !hasDeps }, async () => {
  const { initVault, addUser, unlock, changePassword } = await import('./keys.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rl-keys-'));
  const f = join(dir, 'users.json');
  try {
    const owner = await initVault(f, 'owner', 'correct horse battery');
    await addUser(f, owner.dk, 'accountant', 'staple battery horse', 'accountant');
    const a = await unlock(f, 'owner', 'correct horse battery');
    const b = await unlock(f, 'accountant', 'staple battery horse');
    assert.ok(a.dk.equals(owner.dk) && b.dk.equals(owner.dk));
    assert.equal(a.replicaId, b.replicaId);
    await assert.rejects(() => unlock(f, 'owner', 'wrong password!'), /Неверный логин или пароль/);
    await assert.rejects(() => unlock(f, 'nobody', 'whatever123'), /Неверный логин или пароль/);
    await changePassword(f, 'owner', 'correct horse battery', 'brand new password');
    assert.ok((await unlock(f, 'owner', 'brand new password')).dk.equals(owner.dk));
    await assert.rejects(() => unlock(f, 'owner', 'correct horse battery'));
    await assert.rejects(() => initVault(f, 'x', 'longenough1'), /уже создано/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('короткий пароль отклоняется', { skip: !hasDeps }, async () => {
  const { initVault } = await import('./keys.ts');
  const dir = mkdtempSync(join(tmpdir(), 'rl-keys-'));
  try {
    await assert.rejects(() => initVault(join(dir, 'u.json'), 'owner', 'short'), /короче/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('зашифрованная БД: открывается верным ключом, с чужим ключом и без ключа — нет', { skip: !hasDeps }, async () => {
  const { openEncryptedDb } = await import('../db/open.ts');
  const { insertRow } = await import('../db/mutate.ts');
  const { randomBytes } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'rl-db-'));
  const file = join(dir, 'data.rldb');
  const dk = randomBytes(32);
  try {
    const h = openEncryptedDb(file, dk, 'rep-1');
    insertRow(h.db, { userId: 'owner', replicaId: 'rep-1' }, 'artist', { name: 'Секрет' });
    h.close();
    const again = openEncryptedDb(file, dk, 'rep-1');
    assert.equal(again.db.prepare('SELECT name FROM artist').get()!.name, 'Секрет');
    again.close();
    assert.throws(() => openEncryptedDb(file, randomBytes(32), 'rep-1'), /неверный ключ/);
    const { readFileSync } = await import('node:fs');
    assert.ok(!readFileSync(file).includes(Buffer.from('Секрет')), 'в файле не должно быть открытого текста');
    writeFileSync(join(dir, 'plain.txt'), 'x');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
