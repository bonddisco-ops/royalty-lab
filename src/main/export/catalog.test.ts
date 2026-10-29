import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { sampleSheets } from '../../test/sampleStarter.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { buildStarterPlan } from '../seed/starterPlan.ts';
import { writeStarterPlan } from '../seed/starterWrite.ts';
import { catalogPeople, catalogTree, exportCatalog } from './catalog.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
function loaded() {
  const db = freshDb('r1');
  ensureDefaultSettings(db, ctx);
  writeStarterPlan(db, ctx, buildStarterPlan(sampleSheets));
  return db;
}

test('экспорт: дерево, люди с треками, пробелы и файл', () => {
  const db = loaded();
  const tree = catalogTree(db);
  const all = tree.flatMap((p) => p.artists.map((a) => a.id));
  assert.ok(all.length > 0);
  const { people } = catalogPeople(db, all);
  assert.ok(people.length > 0);
  for (const p of people) assert.ok(p.tracks.every((t) => t.includes(' – ')));
  const none = catalogPeople(db, []);
  assert.equal(none.people.length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'rl-exp-'));
  const r = exportCatalog(db, dir, all);
  assert.ok(existsSync(r.path) && statSync(r.path).size > 200);
  assert.equal(r.people, people.length);
  assert.throws(() => exportCatalog(db, dir, []));
});
