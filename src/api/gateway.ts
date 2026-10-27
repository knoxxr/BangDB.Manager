/**
 * Client for the app's database gateway (proxy/gateway): every call is
 * POST /gw/<op> with the connection's database settings in the body.
 */
import { raw } from './bangdb';
import type { ApiResult, Connection } from './types';

export function gw<T = unknown>(c: Connection, op: string, body: Record<string, unknown> = {}): Promise<ApiResult<T>> {
  return raw(c, 'POST', `/gw/${op}`, { conn: { kind: c.kind, ...(c.db ?? {}) }, ...body }) as Promise<ApiResult<T>>;
}

export interface DatabaseInfo { name: string; size?: number; system?: boolean; keys?: number; file?: string; empty?: boolean }

export const gwDatabases = (c: Connection) => gw<{ databases: DatabaseInfo[] }>(c, 'databases');
export const gwStats = (c: Connection) => gw<Record<string, unknown>>(c, 'stats');
export const gwSqliteFiles = (c: Connection) => gw<{ root: string; files: { file: string; size: number }[] }>(c, 'sqlite/files');
