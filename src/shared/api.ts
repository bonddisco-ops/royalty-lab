// Контракт между окном (renderer) и ядром (main): каналы IPC и их типы. [запрос, ответ]
import type { Row } from '../main/db/types.ts';
import type { Role } from '../main/crypto/keys.ts';
import type { ArtistListItem, Dashboard, IssueView, PersonDetail, PersonListItem, TrackView } from '../main/repo.ts';
import type { PlanSummary } from '../main/seed/starterPlan.ts';
import type { ImportPreview } from '../main/reports/importer.ts';
import type { CustomField, CustomMapping } from '../main/reports/custom.ts';
import type { QuarterPanel, ReportListItem } from '../main/reports/queries.ts';
import type { Flow, StreamKind } from '../main/reports/types.ts';
import type { GroupCalc, Problem, QuarterCalc } from '../main/payouts/calc.ts';
import type { PayoutRow, PayoutsView, StatementInfo } from '../main/payouts/store.ts';
import type { VersionItem } from '../main/reports/replace.ts';
import type { BatchItem, BulkAction, BulkPlan } from '../main/reports/bulk.ts';
import type { UiField } from '../main/reports/edits.ts';
import type { AppendixDraft, AppendixListItem, ContractDetail, ContractEdit, ContractListItem, ContractPreview, DraftTrack, ExportRequest } from '../main/contracts/service.ts';
import type { Block, PBlock, Seg } from '../main/contracts/blocks.ts';
import type { FieldDef } from '../main/contracts/fields.ts';
import type { UpdatePreview } from '../main/sync/exchange.ts';
import type { Facets, LineFilter, LineHistory, LinePage, LineRow, LineSort } from '../main/reports/lines.ts';

export type { UpdatePreview };
export type { AppendixDraft, AppendixListItem, ContractDetail, ContractEdit, ContractListItem, ContractPreview, DraftTrack, ExportRequest, Block, PBlock, Seg, FieldDef };
export type { GroupCalc, Problem, QuarterCalc, PayoutRow, PayoutsView, StatementInfo };
export type { LineHistory, VersionItem, BatchItem, BulkAction, BulkPlan, UiField, Facets, LineFilter, LinePage, LineRow, LineSort, StreamKind };
export type { ImportPreview, CustomField, CustomMapping, QuarterPanel, ReportListItem, Flow };
export type { Role, ArtistListItem, Dashboard, IssueView, PersonDetail, PersonListItem, TrackView, PlanSummary, Row };

export type DataState = 'setup' | 'missing' | 'busy' | 'ok';
export interface DataStatus {
  state: DataState;
  /** Папка данных (RoyaltyLab/) — для окна «Данные не найдены по пути …». */
  path: string | null;
  /** Стандартная папка данных в профиле пользователя — вариант «по умолчанию» в мастере. */
  defaultRoot: string;
  backupDir: string | null;
  message?: string;
}
export interface FolderPick {
  path: string;
  warning: string | null;
}
export type PhotoTable = 'counterparty' | 'artist' | 'track';

export interface AuthStatus {
  data: DataStatus;
  initialized: boolean;
  unlocked: boolean;
  user: { login: string; role: Role } | null;
  users: Array<{ login: string; role: Role }>;
}
export interface StarterPreview {
  token: string;
  fileName: string;
  summary: PlanSummary;
}
export interface StarterResult {
  summary: PlanSummary;
  backup: string;
}
export interface ImportItem {
  id: string;
  fileName: string;
  state: 'ready' | 'unknown' | 'error';
  error?: string;
  preview?: ImportPreview;
}
export interface WizardInfo {
  sheets: string[];
  sheet: string;
  headerRow: number;
  headers: string[];
  sample: Array<Array<string | number | boolean | null>>;
  mapping: CustomMapping;
  fieldTitles: Record<CustomField, string>;
}
export interface GenerateResult {
  groupKey: string;
  payee: string;
  ok: boolean;
  error?: string;
  versionNo?: number;
  folder?: string;
  xlsx?: string;
  pdf?: string;
}
export interface ApplyResult {
  id: string;
  fileName: string;
  ok: boolean;
  error?: string;
  lines?: number;
  rowsKop?: number;
  issues?: number;
  versionNo?: number;
  carried?: number;
  lost?: number;
}
export interface TrackHit {
  id: string;
  title: string;
  isrc: string | null;
  artists: string[];
}

export interface Credentials {
  login: string;
  password: string;
}

export interface ChannelMap {
  'reports:pick': [void, ImportItem[]];
  'reports:setOptions': [{ id: string; flow?: Flow; quarter?: string }, ImportItem];
  'reports:apply': [{ ids: string[] }, ApplyResult[]];
  'reports:discard': [{ id: string }, void];
  'reports:list': [{ quarter?: string }, ReportListItem[]];
  'reports:panel': [{ quarter?: string }, QuarterPanel];
  'reports:setFlow': [{ reportId: string; flow: Flow }, void];
  'reports:versions': [{ reportId: string }, VersionItem[]];
  'reports:delete': [{ reportId: string }, { versions: number; closedIssues: number }];
  'wizard:info': [{ id: string; sheet?: string; headerRow?: number }, WizardInfo];
  'wizard:apply': [{ id: string; mapping: CustomMapping }, ImportItem];
  'lines:query': [{ filter: LineFilter; sort?: LineSort; offset?: number; limit?: number }, LinePage];
  'lines:history': [{ lineId: string }, LineHistory];
  'lines:facets': [{ quarter?: string }, Facets];
  'lines:edit': [{ lineId: string; field: UiField; value: string | null; splitId?: string | null }, void];
  'lines:split': [{ lineId: string; qtyMoved: number; toKind: StreamKind; rate?: string | null }, void];
  'lines:revert': [{ lineId: string }, number];
  'bulk:plan': [{ filter: LineFilter; action: BulkAction }, Omit<BulkPlan, 'items'>];
  'bulk:apply': [{ filter: LineFilter; action: BulkAction }, { batchId: string; affected: number; deltaKop: number }];
  'bulk:list': [void, BatchItem[]];
  'bulk:revert': [{ batchId: string }, number];
  'payouts:view': [{ quarter?: string }, PayoutsView];
  'payouts:mark': [{ quarter: string; groupKey: string; status: 'draft' | 'ready' | 'paid'; paidKop?: number | null; paidDate?: string | null }, void];
  'payouts:generate': [{ quarter: string; groupKeys: string[]; city?: string; date?: string; round?: 'down' | 'up' | 'nearest' }, GenerateResult[]];
  'payouts:deleteStatement': [{ quarter: string; groupKey: string }, { versionNo: number; files: number }];
  'payouts:open': [{ path: string }, void];
  'contracts:list': [void, ContractListItem[]];
  'contracts:missing': [void, Array<{ id: string; person: string; status: string }>];
  'contracts:fields': [void, FieldDef[]];
  'contracts:new': [{ counterpartyId: string }, ContractDetail];
  'contracts:get': [{ id: string }, ContractDetail];
  'contracts:preview': [ContractEdit, ContractPreview];
  'contracts:save': [ContractEdit, string];
  'contracts:delete': [{ id: string }, void];
  'contracts:export': [{ req: ExportRequest; edit: ContractEdit | null; draft: AppendixDraft | null }, { path: string }];
  'appendix:draft': [{ contractId: string; appendixId?: string | null }, AppendixDraft];
  'appendix:track': [{ contractId: string; trackId: string; date: string }, DraftTrack];
  'appendix:save': [{ contractId: string; draft: AppendixDraft }, string];
  'appendix:delete': [{ id: string }, void];
  'tracks:search': [{ q: string }, TrackHit[]];
  'issues:linkTrack': [{ issueId: string; trackId: string }, { lines: number }];
  'issues:createTrack': [{ issueId: string }, { trackId: string }];
  'issues:createMissing': [{ issueIds?: string[] }, { created: number; withArtist: number; withRate: number; skipped: number; lines: number }];
  'issues:createArtist': [{ issueId: string; name?: string }, string];
  'issues:aliasArtist': [{ issueId: string; artistId: string }, void];
  'data:pick': [void, FolderPick | null];
  'data:setup': [{ parent: string | null }, AuthStatus];
  'data:relocate': [void, AuthStatus];
  'data:retry': [void, AuthStatus];
  'data:quit': [void, void];
  'data:pickBackupDir': [void, FolderPick | null];
  'photo:set': [{ table: PhotoTable; id: string; full: Uint8Array; thumb: Uint8Array }, string];
  'photo:remove': [{ table: PhotoTable; id: string }, void];
  'photo:get': [{ file: string; thumb: boolean }, string | null];
  'photo:export': [{ table: PhotoTable; id: string }, string | null];
  'auth:status': [void, AuthStatus];
  'auth:init': [Credentials, AuthStatus];
  'auth:login': [Credentials, AuthStatus];
  'auth:logout': [void, AuthStatus];
  'auth:addUser': [{ login: string; password: string; role: Role }, void];
  'auth:changePassword': [{ oldPassword: string; newPassword: string }, void];
  'dash:get': [void, Dashboard];
  'people:list': [{ q?: string }, PersonListItem[]];
  'people:get': [{ id: string; reveal?: boolean }, PersonDetail];
  'people:create': [Row, string];
  'people:addArtist': [{ personId: string; artistId?: string; name?: string }, string];
  'people:update': [{ id: string; patch: Row }, void];
  'artists:list': [{ q?: string }, ArtistListItem[]];
  'artists:create': [{ name: string; counterparty_id?: string | null }, string];
  'artists:update': [{ id: string; patch: { name?: string; counterparty_id?: string | null; notes?: string | null } }, void];
  'artists:addVariant': [{ id: string; text: string }, void];
  'tracks:list': [{ q?: string; onlyProblems?: boolean }, TrackView[]];
  'tracks:create': [{ title: string; isrc?: string | null }, string];
  'tracks:update': [{ id: string; patch: { title?: string; isrc?: string | null; version?: string | null; notes?: string | null } }, void];
  'parts:add': [{ trackId: string; artistId: string; shareAuthors: string; shareRelated: string; labelRate: string | null; payeeCounterpartyId?: string | null }, string];
  'parts:update': [{ id: string; patch: Row }, void];
  'parts:remove': [{ id: string }, void];
  'parts:fix': [{ trackId: string; participationId: string }, void];
  'issues:list': [{ status?: 'open' | 'resolved' | 'ignored'; kind?: string; reportVersionId?: string }, IssueView[]];
  'issues:resolve': [{ id: string; status: 'open' | 'resolved' | 'ignored'; note?: string }, void];
  'history:get': [{ table: string; id: string }, Row[]];
  'settings:get': [void, Record<string, string>];
  'settings:set': [{ id: string; value: string }, void];
  'starter:pick': [void, StarterPreview | null];
  'starter:apply': [{ token: string }, StarterResult];
  'backup:now': [void, string];
  'data:move': [void, { path: string; oldPath: string; files: number; warning: string | null; status: AuthStatus } | null];
  'sync:save': [{ password: string; includePii: boolean }, { path: string; events: number; bytes: number } | null];
  'sync:open': [{ password: string }, { token: string; preview: UpdatePreview } | null];
  'sync:apply': [{ token: string; skipGroups: string[]; keepMine: string[] }, { applied: number; skipped: number; lines: number; files: number }];
  'sync:cancel': [void, void];
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface RlBridge {
  invoke(channel: string, req?: unknown): Promise<IpcResult<unknown>>;
  onLocked(cb: () => void): () => void;
}
