import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from '../../test/nodeSqliteDb.ts';
import { spDigital, spRelRow } from '../../test/sampleReports.ts';
import { ensureDefaultSettings } from '../db/init.ts';
import { editLine, splitLine } from './edits.ts';
import { commitImport, previewImport, sha256Hex } from './importer.ts';
import { queryLines } from './lines.ts';
import { parseKnown } from './parse.ts';
import { listVersions } from './replace.ts';

const ctx = { userId: 'owner', replicaId: 'r1' };
const Q = { quarter: '2026Q2' };

const input = (rows: ReturnType<typeof spRelRow>[], tot: [number, number], sha: string) => ({
  parsed: parseKnown(spDigital('related', rows, tot)), fileName: sha + '.xlsx', fileSha: sha256Hex(Buffer.from(sha)), flow: 'artists' as const, quarter: '2026Q2',
});

test('замена отчёта: сравнение, перенос правок по row_key, потерянные правки → «Проверить»', () => {
  const db = freshDb();
  ensureDefaultSettings(db, ctx);
  const v1 = input([
    spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 1000, 50, 35),
    spRelRow('RUAAA2600002', 'Song B', 'Artist B', 'VK Music', 200, 10, 7),
  ], [60, 42], 'v1');
  const r1 = commitImport(db, ctx, v1);
  const a = queryLines(db, { ...Q, q: 'song a' }).rows[0]!;
  const b = queryLines(db, { ...Q, q: 'song b' }).rows[0]!;
  editLine(db, ctx, a.lineId, 'qty', '2000');
  splitLine(db, ctx, b.lineId, 50, 'ad');

  const v2 = input([
    spRelRow('RUAAA2600001', 'Song A', 'Artist A', 'Yandex Music', 1100, 55, 38.5),
    spRelRow('RUAAA2600003', 'Song C', 'Artist C', 'VK Music', 100, 5, 3.5),
  ], [60, 42], 'v2');
  const pv = previewImport(db, v2);
  assert.equal(pv.replaces?.versionNo, 1);
  assert.deepEqual([pv.diff!.added, pv.diff!.removed, pv.diff!.changed, pv.diff!.unchanged], [1, 1, 1, 0]);
  assert.equal(pv.diff!.deltaKop, 3850 - 3500 + 350 - 700);
  assert.equal(pv.diff!.carriedLines, 1);
  assert.equal(pv.diff!.lostLines, 1);

  const r2 = commitImport(db, ctx, v2);
  assert.equal(r2.versionNo, 2);
  assert.equal(r2.carried, 1);
  assert.equal(r2.lost, 1);
  const rows = queryLines(db, Q).rows;
  const newA = rows.find((r) => r.title === 'Song A')!;
  assert.equal(newA.qty, 2000);
  assert.equal(newA.royaltyKop, 7000); // ставка новой версии 3850/1100 за прослушивание
  assert.equal(newA.origQty, 1100);
  assert.equal(rows.some((r) => r.title === 'Song B'), false);
  const lost = db.prepare("SELECT details_json FROM issue WHERE kind = 'edit_lost_on_replace' AND status = 'open'").all();
  assert.equal(lost.length, 1);
  assert.match(String(lost[0]!.details_json), /Song B/);
  const vs = listVersions(db, r2.reportId);
  assert.deepEqual(vs.map((v) => [v.versionNo, v.status, v.current]), [[2, 'active', true], [1, 'superseded', false]]);
  assert.equal(r1.reportId, r2.reportId);
});
