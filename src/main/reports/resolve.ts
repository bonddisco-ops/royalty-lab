// Решения из очереди «Проверить» по отчётам: привязать строки к треку, завести трек/артиста, запомнить написание.
import { insertRow, updateRow } from '../db/mutate.ts';
import type { Ctx, Db, Row } from '../db/types.ts';
import { normKey } from '../domain/normalize.ts';
import { addArtistVariant, createArtist, createTrack } from '../repo.ts';
import { isIsrcLike } from './util.ts';

function openIssue(db: Db, id: string, kind: string): Row {
  const r = db.prepare('SELECT * FROM issue WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!r) throw new Error('Вопрос не найден');
  if (r.kind !== kind) throw new Error('Это действие не подходит к такому виду вопроса');
  return r;
}
const details = (r: Row): Record<string, any> => (typeof r.details_json === 'string' ? JSON.parse(r.details_json) : r.details_json ?? {});

function closeIssue(db: Db, ctx: Ctx, id: string, status: 'resolved' | 'ignored', resolution: Record<string, unknown>): void {
  updateRow(db, ctx, 'issue', id, { status, resolved_by: ctx.userId, resolved_at: new Date().toISOString(), resolution_json: resolution });
}

/** Привязать строки отчёта к существующему треку; решение запоминается (track_identifier), следующий отчёт узнает строку сам. */
export function linkUnmatchedToTrack(db: Db, ctx: Ctx, issueId: string, trackId: string): { lines: number; closed: number } {
  return db.transaction(() => {
    const issue = openIssue(db, issueId, 'unmatched_track');
    const d = details(issue);
    const track = db.prepare('SELECT * FROM track WHERE id = ? AND deleted_at IS NULL').get(trackId);
    if (!track) throw new Error('Трек не найден');
    const isrc: string | null = d.isrc ?? null;
    const code: string | null = d.code ?? null;
    const titleKey = `${normKey(d.title)}|${normKey(d.artist)}`;
    const addIdent = (kind: string, value: string) => {
      const ex = db.prepare("SELECT 1 FROM track_identifier WHERE kind = ? AND value_norm = ? AND deleted_at IS NULL").get(kind, value);
      if (!ex) insertRow(db, ctx, 'track_identifier', { track_id: trackId, kind, value_norm: value });
    };
    if (isrc) {
      if (!track.isrc && isIsrcLike(isrc)) updateRow(db, ctx, 'track', trackId, { isrc });
      else if (track.isrc !== isrc) addIdent('isrc', isrc);
    }
    if (code) addIdent('distributor_code', code);
    if (!isrc && !code) addIdent('title_artist', titleKey);

    let lines = 0;
    const cands = db.prepare(
      `SELECT l.id, l.isrc_raw, l.code_raw, l.title_raw, l.artist_raw FROM statement_line l
        JOIN report_version v ON v.id = l.report_version_id
       WHERE l.track_id IS NULL AND v.status = 'active' AND v.deleted_at IS NULL`,
    ).all();
    const upd = db.prepare('UPDATE statement_line SET track_id = ? WHERE id = ?');
    for (const l of cands) {
      const same = isrc ? l.isrc_raw === isrc : code ? String(l.code_raw ?? '') === code : `${normKey(l.title_raw)}|${normKey(l.artist_raw)}` === titleKey;
      if (same) {
        upd.run(trackId, l.id);
        lines++;
      }
    }
    // тот же трек мог попасть в очередь из других отчётов квартала — закрываем и их
    let closed = 0;
    for (const o of db.prepare("SELECT * FROM issue WHERE kind = 'unmatched_track' AND status = 'open' AND deleted_at IS NULL").all()) {
      const od = details(o);
      const same = isrc ? od.isrc === isrc : code ? od.code === code : `${normKey(od.title)}|${normKey(od.artist)}` === titleKey;
      if (same) {
        closeIssue(db, ctx, o.id, 'resolved', { action: 'link', track_id: trackId });
        closed++;
      }
    }
    return { lines, closed };
  })();
}

/** Завести новый трек по строке отчёта и привязать к нему. Артистов у такого трека нет — он попадёт в доработку в карточке трека. */
export function createTrackFromUnmatched(db: Db, ctx: Ctx, issueId: string): { trackId: string; lines: number; closed: number } {
  return db.transaction(() => {
    const d = details(openIssue(db, issueId, 'unmatched_track'));
    const title = String(d.title ?? d.isrc ?? d.code ?? '').trim();
    if (!title) throw new Error('У строки нет названия — создайте трек вручную во вкладке «Треки»');
    const isrc = d.isrc && isIsrcLike(d.isrc) && !db.prepare('SELECT 1 FROM track WHERE isrc = ? AND deleted_at IS NULL').get(d.isrc) ? d.isrc : null;
    const trackId = createTrack(db, ctx, { title, isrc });
    const r = linkUnmatchedToTrack(db, ctx, issueId, trackId);
    return { trackId, ...r };
  })();
}

/** Новый артист по написанию из отчёта. */
export function createArtistFromUnknown(db: Db, ctx: Ctx, issueId: string, name?: string): string {
  return db.transaction(() => {
    const d = details(openIssue(db, issueId, 'unknown_artist'));
    const id = createArtist(db, ctx, { name: (name ?? String(d.artist)).trim() });
    closeIssue(db, ctx, issueId, 'resolved', { action: 'create_artist', artist_id: id });
    return id;
  })();
}

/** Это уже известный артист, просто другое написание: запоминаем. */
export function aliasUnknownArtist(db: Db, ctx: Ctx, issueId: string, artistId: string, text?: string): void {
  db.transaction(() => {
    const d = details(openIssue(db, issueId, 'unknown_artist'));
    addArtistVariant(db, ctx, artistId, (text ?? String(d.artist)).trim());
    closeIssue(db, ctx, issueId, 'resolved', { action: 'alias', artist_id: artistId });
  })();
}

/** Закрыть вопрос отчёта без действий (игнор) — для not_reported_platform, footer_mismatch, isrc_two_distributors и т.п. */
export function dismissReportIssue(db: Db, ctx: Ctx, issueId: string, status: 'resolved' | 'ignored', note?: string): void {
  const r = db.prepare('SELECT 1 FROM issue WHERE id = ? AND deleted_at IS NULL').get(issueId);
  if (!r) throw new Error('Вопрос не найден');
  closeIssue(db, ctx, issueId, status, { note: note ?? null });
}
