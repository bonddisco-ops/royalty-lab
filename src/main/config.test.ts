import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, writeFileSync as w } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudWarning, findExistingRoot, readConfig, rootFromParent, writeConfig } from './config.ts';
import { acquireLock, releaseLock } from './dataLock.ts';

test('конфиг: чтение/запись и пустой по умолчанию', () => {
  const d = mkdtempSync(join(tmpdir(), 'rl-'));
  const f = join(d, 'sub', 'config.json');
  assert.deepEqual(readConfig(f), { dataRoot: null, backupDir: null });
  writeConfig(f, { dataRoot: 'D:\\RoyaltyLab', backupDir: 'E:\\bk' });
  assert.deepEqual(readConfig(f), { dataRoot: 'D:\\RoyaltyLab', backupDir: 'E:\\bk' });
  w(f, '{битый');
  assert.equal(readConfig(f).dataRoot, null);
});

test('findExistingRoot принимает корень данных и родителя', () => {
  const d = mkdtempSync(join(tmpdir(), 'rl-'));
  assert.equal(findExistingRoot(d), null);
  const root = rootFromParent(d);
  mkdirSync(root);
  writeFileSync(join(root, 'data.rldb'), '');
  assert.equal(findExistingRoot(d), root);
  assert.equal(findExistingRoot(root), root);
});

test('предупреждение об облаке и сети', () => {
  assert.ok(cloudWarning('C:\\Users\\a\\Dropbox\\Music'));
  assert.ok(cloudWarning('C:\\Users\\a\\YandexDisk\\x'));
  assert.ok(cloudWarning('C:\\Users\\a\\Яндекс.Диск\\x'));
  assert.ok(cloudWarning('C:\\Users\\a\\OneDrive - Фирма\\Документы'));
  assert.ok(cloudWarning('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/x'));
  assert.ok(cloudWarning('\\\\nas\\share\\rl'));
  assert.equal(cloudWarning('D:\\Music\\RoyaltyLab'), null);
  assert.equal(cloudWarning('/Users/a/Documents'), null);
});

test('замок: свой процесс проходит, чужой живой — нет', () => {
  const d = mkdtempSync(join(tmpdir(), 'rl-'));
  const f = join(d, '.rl-lock');
  acquireLock(f);
  acquireLock(f); // повторно тем же процессом — ок
  writeFileSync(f, JSON.stringify({ pid: process.ppid, host: require_host(), since: 'x' }));
  assert.throws(() => acquireLock(f), /другом окне/);
  writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, host: require_host(), since: 'x' }));
  acquireLock(f); // мёртвый pid — замок устарел
  releaseLock(f);
});

import { hostname } from 'node:os';
function require_host(): string { return hostname(); }
