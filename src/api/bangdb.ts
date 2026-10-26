import { fillPath, resolveEndpoint } from './endpoints';
import { rawRequest } from './http';
import type { ApiResult, Connection, CreateTableSpec, EndpointKey, IndexSpec, RequestLogEntry } from './types';

type Listener = (entry: RequestLogEntry) => void;
const listeners = new Set<Listener>();
export function onRequest(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

let seq = 0;
function emit(conn: Connection, res: ApiResult, body?: unknown) {
  const entry: RequestLogEntry = {
    ...res,
    id: `${Date.now()}-${seq++}`,
    at: Date.now(),
    connectionId: conn.id,
    requestBody: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  };
  listeners.forEach((l) => l(entry));
}

export interface CallOptions {
  params?: Record<string, string | number | undefined>;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** Call a named endpoint (default template or the connection's override). */
export async function call<T = unknown>(conn: Connection, key: EndpointKey, opts: CallOptions = {}): Promise<ApiResult<T>> {
  const ep = resolveEndpoint(key, conn.endpointOverrides);
  let path: string;
  try {
    path = fillPath(ep.path, opts.params ?? {});
  } catch (e) {
    const res: ApiResult<T> = {
      ok: false, status: 0, data: null as T, text: '', url: ep.path, method: ep.method, durationMs: 0,
      error: e instanceof Error ? e.message : String(e)
    };
    emit(conn, res, opts.body);
    return res;
  }
  if (opts.query) {
    const qs = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) path += (path.includes('?') ? '&' : '?') + qs;
  }
  const res = (await rawRequest(conn, { method: ep.method, path, body: opts.body })) as ApiResult<T>;
  emit(conn, res, opts.body);
  return res;
}

/** Free-form request used by the REST console. */
export async function raw(conn: Connection, method: ApiResult['method'], path: string, body?: unknown): Promise<ApiResult> {
  const res = await rawRequest(conn, { method, path, body });
  emit(conn, res, body);
  return res;
}

// ---------- typed helpers ----------

export interface TableList { tables: string[]; num_tables?: number }

export function extractTables(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const list = (d.tables ?? d.table_list ?? d.list) as unknown;
  if (Array.isArray(list)) {
    return list.map((t) => (typeof t === 'string' ? t : (t as Record<string, unknown>).table_name ?? (t as Record<string, unknown>).name)).filter(Boolean) as string[];
  }
  return [];
}

export const isSystemTable = (name: string) => name.startsWith('_sys_') || name.startsWith('_');

export async function login(conn: Connection): Promise<ApiResult<Record<string, unknown>>> {
  return call(conn, 'login', { body: { user: conn.auth.user ?? '', pass: conn.auth.pass ?? '' } });
}

export function extractToken(data: unknown, field: string): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const v = d[field] ?? d.token ?? d.api_key ?? d.apikey;
  return typeof v === 'string' ? v : undefined;
}

export const listTables = (c: Connection, db: string) => call<TableList>(c, 'listTables', { params: { db } });
export const createDb = (c: Connection, db: string) => call(c, 'createDb', { params: { db }, body: { db_name: db } });
export const dropDb = (c: Connection, db: string) => call(c, 'dropDb', { params: { db } });
export const createTable = (c: Connection, db: string, spec: CreateTableSpec) =>
  call(c, 'createTable', { params: { db }, body: spec });
export const dropTable = (c: Connection, db: string, table: string) => call(c, 'dropTable', { params: { db, table } });
export const tableInfo = (c: Connection, db: string, table: string) => call(c, 'tableInfo', { params: { db, table } });
export const rowCount = (c: Connection, db: string, table: string) =>
  call<{ count?: number }>(c, 'rowCount', { params: { db, table } });
export const addIndex = (c: Connection, db: string, table: string, spec: IndexSpec) =>
  call(c, 'addIndex', { params: { db, table }, body: spec });
export const dropIndex = (c: Connection, db: string, table: string, index: string) =>
  call(c, 'dropIndex', { params: { db, table, index } });
export const putDoc = (c: Connection, db: string, table: string, doc: unknown) =>
  call(c, 'putDoc', { params: { db, table }, body: doc });
export const getDoc = (c: Connection, db: string, table: string, key: string) =>
  call(c, 'getDoc', { params: { db, table, key } });
export const delDoc = (c: Connection, db: string, table: string, key: string) =>
  call(c, 'delDoc', { params: { db, table, key } });
export const scanDocs = (c: Connection, db: string, table: string, body: Record<string, unknown>) =>
  call(c, 'scanDocs', { params: { db, table }, body });
export const sql = (c: Connection, db: string, statement: string) =>
  call(c, 'query', { params: { db }, body: { sql: statement } });

/** Rows from a query/scan response, whatever wrapper BangDB used. */
export function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  for (const k of ['rows', 'docs', 'data', 'result', 'results', 'records']) {
    const v = d[k];
    if (Array.isArray(v)) return v.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : { value: r }));
  }
  return [d];
}
