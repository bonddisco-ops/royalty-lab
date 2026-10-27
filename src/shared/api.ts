// Контракт между окном (renderer) и ядром (main): каналы IPC и их типы. [запрос, ответ]
import type { Row } from '../main/db/types.ts';
import type { Role } from '../main/crypto/keys.ts';
import type { ArtistListItem, Dashboard, IssueView, PersonDetail, PersonListItem, TrackView } from '../main/repo.ts';
import type { PlanSummary } from '../main/seed/starterPlan.ts';

export type { Role, ArtistListItem, Dashboard, IssueView, PersonDetail, PersonListItem, TrackView, PlanSummary, Row };

export interface AuthStatus {
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
export interface Credentials {
  login: string;
  password: string;
}

export interface ChannelMap {
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
  'issues:list': [{ status?: 'open' | 'resolved' | 'ignored'; kind?: string }, IssueView[]];
  'issues:resolve': [{ id: string; status: 'open' | 'resolved' | 'ignored'; note?: string }, void];
  'history:get': [{ table: string; id: string }, Row[]];
  'settings:get': [void, Record<string, string>];
  'settings:set': [{ id: string; value: string }, void];
  'starter:pick': [void, StarterPreview | null];
  'starter:apply': [{ token: string }, StarterResult];
  'backup:now': [void, string];
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface RlBridge {
  invoke(channel: string, req?: unknown): Promise<IpcResult<unknown>>;
  onLocked(cb: () => void): () => void;
}
