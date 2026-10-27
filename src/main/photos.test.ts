import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { decryptBuf, readPhoto, removePhoto, savePhoto } from './photos.ts';

test('фото: шифруется, читается, миниатюра отдельно, удаляется', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-ph-'));
  const dk = randomBytes(32);
  const full = Buffer.from('FULL-IMAGE-BYTES');
  const thumb = Buffer.from('thumb');
  const f = savePhoto(dir, dk, full, thumb);
  assert.match(f, /^[0-9a-f-]{36}\.img$/);
  assert.ok(!readFileSync(join(dir, f)).includes(full), 'на диске не открытый текст');
  assert.deepEqual(readPhoto(dir, dk, f, false), full);
  assert.deepEqual(readPhoto(dir, dk, f, true), thumb);
  assert.throws(() => decryptBuf(randomBytes(32), readFileSync(join(dir, f))), /расшифровать/);
  removePhoto(dir, f);
  assert.equal(readPhoto(dir, dk, f, false), null);
});

test('фото: защита от выхода из папки и пустых файлов', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-ph-'));
  assert.throws(() => readPhoto(dir, randomBytes(32), '../../etc/passwd', false), /Недопустимое/);
  assert.throws(() => savePhoto(dir, randomBytes(32), new Uint8Array(0), new Uint8Array(1)), /пустая/);
});
