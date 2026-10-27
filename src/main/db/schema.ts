import type { Db } from './types.ts';

const STD = `created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  deleted_at TEXT`;

/** Таблицы данных: писать в них можно только через mutate(). */
export const DATA_TABLES = [
  'settings',
  'counterparty',
  'artist',
  'artist_name_variant',
  'track',
  'track_identifier',
  'participation',
  'contract_template',
  'contract',
  'appendix',
  'appendix_item',
  'distributor',
  'issue',
] as const;
export type DataTable = (typeof DATA_TABLES)[number];

// Этап 1 по Схема_БД.md: разделы 3-5, 9, 10 (+ distributor ради ссылки из track_identifier).
// Отчёты, строки, правки и расчёт добавятся миграциями следующих этапов.
const M001 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE settings (id TEXT PRIMARY KEY, value TEXT NOT NULL, ${STD});

CREATE TABLE counterparty (
  id TEXT PRIMARY KEY,
  last_name TEXT, first_name TEXT, middle_name TEXT, birth_date TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ip','sz','fl','unknown')),
  inn TEXT, ogrnip TEXT, snils TEXT,
  passport_series TEXT, passport_number TEXT, passport_issued_by TEXT, passport_issued_date TEXT, passport_division_code TEXT,
  addr_region TEXT, addr_city TEXT, addr_street TEXT, addr_house TEXT, addr_flat TEXT, addr_zip TEXT, addr_raw TEXT,
  bank_name TEXT, bank_bik TEXT, bank_corr_account TEXT, bank_account TEXT,
  email TEXT, phone TEXT, notes TEXT, custom_json TEXT,
  ${STD}
);
CREATE INDEX ix_counterparty_inn ON counterparty(inn);

CREATE TABLE artist (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT REFERENCES counterparty(id),
  name TEXT NOT NULL,
  notes TEXT,
  ${STD}
);
CREATE INDEX ix_artist_cp ON artist(counterparty_id);

CREATE TABLE artist_name_variant (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES artist(id),
  variant_norm TEXT NOT NULL,
  ${STD}
);
CREATE UNIQUE INDEX ux_variant ON artist_name_variant(variant_norm) WHERE deleted_at IS NULL;

CREATE TABLE track (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL, version TEXT, isrc TEXT, upc TEXT, release_date TEXT,
  explicit INTEGER, notes TEXT,
  ${STD}
);
CREATE UNIQUE INDEX ux_track_isrc ON track(isrc) WHERE isrc IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE distributor (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format_code TEXT, default_flow TEXT, licensor_share TEXT, contract_numbers_json TEXT,
  ${STD}
);

CREATE TABLE track_identifier (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES track(id),
  kind TEXT NOT NULL CHECK (kind IN ('isrc','upc','distributor_code','title_artist')),
  value_norm TEXT NOT NULL,
  distributor_id TEXT REFERENCES distributor(id),
  ${STD}
);
CREATE UNIQUE INDEX ux_track_identifier ON track_identifier(kind, value_norm, COALESCE(distributor_id, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX ix_track_identifier_track ON track_identifier(track_id);

CREATE TABLE contract_template (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK (code IN ('A','B','C')),
  name TEXT NOT NULL, docx_path TEXT, version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
  ${STD}
);

-- Деньги в копейках (INTEGER); доли и ставки — точные десятичные строки.
CREATE TABLE contract (
  id TEXT PRIMARY KEY,
  counterparty_id TEXT NOT NULL REFERENCES counterparty(id),
  template_id TEXT REFERENCES contract_template(id),
  number TEXT NOT NULL, date TEXT,
  kind TEXT NOT NULL DEFAULT 'license' CHECK (kind IN ('license','alienation')),
  rate_default TEXT,
  threshold_rub INTEGER,  -- порог выплаты в КОПЕЙКАХ (имя колонки из схемы)
  threshold_rule TEXT CHECK (threshold_rule IS NULL OR threshold_rule IN ('accumulate_year_end','carry_until_exceeded')),
  recoup_amount INTEGER, autoprolong INTEGER, end_date TEXT,
  status_clause_50 INTEGER NOT NULL DEFAULT 0,
  pdf_file TEXT, has_pdf INTEGER NOT NULL DEFAULT 0, notes TEXT,
  ${STD}
);
CREATE INDEX ix_contract_cp ON contract(counterparty_id);

CREATE TABLE appendix (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contract(id),
  number INTEGER NOT NULL, date TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  docx_file TEXT, pdf_file TEXT,
  ${STD}
);

CREATE TABLE participation (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES track(id),
  artist_id TEXT NOT NULL REFERENCES artist(id),
  share_authors TEXT NOT NULL, share_related TEXT NOT NULL,
  label_rate TEXT,
  payee_counterparty_id TEXT REFERENCES counterparty(id),
  contract_id TEXT REFERENCES contract(id),
  appendix_id TEXT REFERENCES appendix(id),
  term_from TEXT, term_to TEXT, valid_from_quarter TEXT, valid_to_quarter TEXT,
  notes TEXT,
  ${STD}
);
CREATE INDEX ix_participation_track ON participation(track_id);
CREATE INDEX ix_participation_artist ON participation(artist_id);

CREATE TABLE appendix_item (
  id TEXT PRIMARY KEY,
  appendix_id TEXT NOT NULL REFERENCES appendix(id),
  track_id TEXT REFERENCES track(id),
  participation_id TEXT REFERENCES participation(id),
  kind TEXT NOT NULL DEFAULT 'works' CHECK (kind IN ('works','recordings','video','images')),
  payload_json TEXT,
  ${STD}
);
CREATE INDEX ix_appendix_item_app ON appendix_item(appendix_id);

CREATE TABLE issue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_type TEXT, entity_id TEXT, report_version_id TEXT,
  details_json TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  resolution_json TEXT, resolved_by TEXT, resolved_at TEXT,
  ${STD}
);
CREATE INDEX ix_issue_status ON issue(status, kind);

CREATE TABLE change_log (
  id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL, ts TEXT NOT NULL,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert','update','delete')),
  field TEXT, old_value TEXT, new_value TEXT
);
CREATE UNIQUE INDEX ux_change_log_seq ON change_log(replica_id, seq);
CREATE INDEX ix_change_log_row ON change_log(table_name, row_id);

CREATE TABLE sync_state (replica_id TEXT PRIMARY KEY, last_seq_seen INTEGER NOT NULL);
`;

export const MIGRATIONS: Array<{ version: number; sql: string }> = [{ version: 1, sql: M001 }];

export function currentVersion(db: Db): number {
  const r = db.prepare('PRAGMA user_version').get();
  return Number(r?.user_version ?? 0);
}

export function migrate(db: Db): number {
  let v = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= v) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    run();
    v = m.version;
  }
  return v;
}

export function initMeta(db: Db, replicaId: string): void {
  const has = db.prepare("SELECT value FROM meta WHERE key = 'replica_id'").get();
  if (has) return;
  db.prepare("INSERT INTO meta (key, value) VALUES ('replica_id', ?)").run(replicaId);
  db.prepare("INSERT INTO meta (key, value) VALUES ('seq', '0')").run();
}
