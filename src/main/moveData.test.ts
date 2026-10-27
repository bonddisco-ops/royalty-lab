import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveDataRoot } from './moveData.ts';

test('перенос данных: копирует всё, замок не берёт, старое остаётся', () => {
  const t = mkdtempSync(join(tmpdir(), 'mv-'));
  const a = join(t, 'A'), b = join(t, 'B');
  mkdirSync(join(a, 'photos'), { recursive: true });
  writeFileSync(join(a, 'data.rldb'), 'DB'); writeFileSync(join(a, 'photos', 'x.img'), 'P'); writeFileSync(join(a, '.rl-lock'), '{}');
  const r = moveDataRoot(a, b);
  assert.equal(r.files, 2);
  assert.equal(readFileSync(join(b, 'photos', 'x.img'), 'utf8'), 'P');
  assert.equal(existsSync(join(b, '.rl-lock')), false);
  assert.equal(existsSync(join(a, 'data.rldb')), true);
  assert.throws(() => moveDataRoot(a, b), /уже есть data.rldb/);
  assert.throws(() => moveDataRoot(a, join(a, 'in')), /внутри/);
});
