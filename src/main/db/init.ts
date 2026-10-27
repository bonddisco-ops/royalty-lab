import { insertRow } from './mutate.ts';
import type { Ctx, Db } from './types.ts';

export const DEFAULT_SETTINGS: Record<string, string> = {
  hidden_deduction: '0.06', // множитель 0.94 (Схема_БД.md §8)
  rate_change_mode: 'keep_rate', // при смене тиража ставка за прослушивание остаётся
  auto_lock_minutes: '15',
};

export function ensureDefaultSettings(db: Db, ctx: Ctx): void {
  db.transaction(() => {
    for (const [id, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!db.prepare('SELECT 1 FROM settings WHERE id = ?').get(id)) insertRow(db, ctx, 'settings', { id, value });
    }
  })();
}

export function getSetting(db: Db, id: string): string {
  const r = db.prepare('SELECT value FROM settings WHERE id = ? AND deleted_at IS NULL').get(id);
  return String(r?.value ?? DEFAULT_SETTINGS[id] ?? '');
}
