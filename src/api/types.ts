export type AuthMode = 'none' | 'apikey' | 'basic' | 'login';

/**
 * Which server the connection talks to: BangDB 2.0 REST (bangdb.com),
 * knoxxr/bangdb's JSON HTTP API, or a database reached through the app's
 * gateway (proxy/gateway): SQL databases and MongoDB / Redis.
 */
export type ServerKind = 'rest' | 'go' | GatewayKind;
export type SqlGatewayKind = 'postgres' | 'mysql' | 'mssql' | 'sqlite';
export type GatewayKind = SqlGatewayKind | 'mongodb' | 'redis';

/** Connection settings the gateway uses to open the database. */
export interface DbParams {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Default database (PostgreSQL / MySQL / SQL Server / MongoDB) or Redis DB number. */
  database?: string;
  /** Connection string instead of the fields above (postgres://, mysql://, mongodb://, redis://). */
  uri?: string;
  /** SQLite file, relative to the gateway's SQLITE_ROOT. */
  file?: string;
  ssl?: boolean;
  /** Accept self-signed certificates. */
  sslInsecure?: boolean;
  /** MongoDB authSource. */
  authSource?: string;
}

export interface AuthConfig {
  mode: AuthMode;
  /** Header name used for API key / login token. BangDB docs use x-bang-api-key. */
  headerName: string;
  apiKey?: string;
  user?: string;
  pass?: string;
  /** JSON field in the login response that carries the token. */
  tokenField: string;
  /** Token obtained from the login endpoint (runtime, persisted for convenience). */
  token?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface EndpointDef {
  method: HttpMethod;
  /** Path template, e.g. /db/{db}/{table}/count */
  path: string;
  /** true when the shape was confirmed against the BangDB 2.0 REST docs. */
  verified: boolean;
  note?: string;
}

export type EndpointKey =
  | 'login'
  | 'serverStats'
  | 'createDb'
  | 'dropDb'
  | 'listTables'
  | 'createTable'
  | 'dropTable'
  | 'tableInfo'
  | 'rowCount'
  | 'addIndex'
  | 'dropIndex'
  | 'putDoc'
  | 'getDoc'
  | 'delDoc'
  | 'scanDocs'
  | 'query'
  | 'goHealth'
  | 'goTables'
  | 'goTable'
  | 'goQuery'
  | 'goStats';

export interface Connection {
  id: string;
  name: string;
  kind: ServerKind;
  /** e.g. http://192.168.0.10:18080 */
  baseUrl: string;
  defaultDb: string;
  /** Known database names on this server (BangDB has no verified "list databases" call). */
  databases: string[];
  auth: AuthConfig;
  /** Route requests through the app's own /bangdb proxy (dev server or proxy/server.mjs). */
  useProxy: boolean;
  endpointOverrides: Partial<Record<EndpointKey, EndpointDef>>;
  createdAt: number;
  /** Gateway kinds: database settings. `baseUrl` is then the gateway (empty: the server that serves this app). */
  db?: DbParams;
  /** Gateway kinds: value of the gateway's GATEWAY_TOKEN. */
  gatewayToken?: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  text: string;
  url: string;
  method: HttpMethod;
  durationMs: number;
  error?: string;
}

export interface RequestLogEntry extends ApiResult {
  id: string;
  at: number;
  connectionId: string;
  requestBody?: string;
}

export type TableType = 'NORMAL_TABLE' | 'WIDE_TABLE' | 'INDEX_TABLE' | 'PRIMITIVE_TABLE';
export type KeyType = 'NORMAL_KEY' | 'NORMAL_KEY_LONG' | 'COMPOSITE_KEY';

export interface CreateTableSpec {
  table_name: string;
  table_type: TableType;
  key_type: KeyType;
  key_sz: number;
  allow_duplicate: boolean;
  allow_rev_idx: boolean;
  version_type: number;
}

export interface IndexSpec {
  idx_name: string;
  idx_type: 'SIMPLE' | 'COMPOSITE' | 'NESTED' | 'GEO';
  key_type: 'NORMAL_KEY' | 'NORMAL_KEY_LONG';
  allow_duplicate: boolean;
  idx_scope?: string;
}

/** Column of a knoxxr/bangdb table as /v1/tables reports it. */
export interface ColumnInfo {
  name: string;
  type?: string;
  decl?: string;
  notNull?: boolean;
  pk?: boolean;
  unique?: boolean;
  autoinc?: boolean;
  /** NOCASE, RTRIM or empty (binary). */
  collate?: string;
  default?: string;
  /** Builder-only fields (not reported by /v1/tables): column CHECK and REFERENCES. */
  check?: string;
  refTable?: string;
  refColumn?: string;
  onDelete?: string;
}

/** Storage of a knoxxr/bangdb table: B+tree (default), memory or timeseries. */
export interface StorageSpec {
  using: '' | 'memory' | 'timeseries';
  persist?: boolean;
  timeColumn?: string;
  timeUnit?: 's' | 'ms' | 'us';
  retention?: string;
  blockRows?: number;
}

export interface GoTableInfo {
  name: string;
  kind: 'table' | 'view';
  columns?: ColumnInfo[];
  indexes?: { name: string; table: string; columns?: string[]; column?: string; unique?: boolean; auto?: boolean }[];
  primaryKey?: string[];
  /** "memory", "timeseries" or absent (B+tree). */
  store?: string;
  sql?: string;
  /** Hidden row identifier the gateway reports (SQLite rowid, PostgreSQL ctid). */
  rowid?: 'rowid' | 'ctid';
}

export interface GoQueryResponse {
  columns: string[];
  types: string[];
  rows: unknown[][];
  rows_affected: number;
  last_insert_id: number;
  truncated: boolean;
  ms: number;
}
