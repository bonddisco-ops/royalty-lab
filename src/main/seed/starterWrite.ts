import { mutate } from '../db/mutate.ts';
import type { Ctx, Db } from '../db/types.ts';
import type { StarterPlan } from './starterPlan.ts';

/** Стартовая база грузится один раз в пустой каталог: повторная загрузка создала бы дубли. */
export function catalogIsEmpty(db: Db): boolean {
  for (const t of ['counterparty', 'artist', 'track', 'contract']) {
    if (Number(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE deleted_at IS NULL`).get()?.n) > 0) return false;
  }
  return true;
}

export function writeStarterPlan(db: Db, ctx: Ctx, plan: StarterPlan): void {
  if (!catalogIsEmpty(db)) {
    throw new Error('В базе уже есть люди, артисты, треки или договоры. Стартовая база грузится только в пустой каталог.');
  }
  db.transaction(() => {
    for (const op of plan.ops) mutate(db, ctx, [{ kind: 'insert', table: op.table, row: op.row }]);
  })();
}
