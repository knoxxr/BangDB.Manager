import type { EndpointDef, EndpointKey } from './types';

/**
 * BangDB 2.0 REST API endpoint templates.
 *
 * `verified: true` entries match the public BangDB REST docs (docs.bangdb.com/rest-api).
 * `verified: false` entries follow the same conventions but could not be confirmed;
 * every entry can be overridden per connection in the connection editor.
 */
export const DEFAULT_ENDPOINTS: Record<EndpointKey, EndpointDef> = {
  login: {
    method: 'POST',
    path: '/login',
    verified: false,
    note: 'Body {"user","pass"}; token read from the configured response field.'
  },
  serverStats: { method: 'GET', path: '/stats', verified: false, note: 'Server stats.' },
  createDb: {
    method: 'PUT',
    path: '/db/{db}',
    verified: false,
    note: 'BangDB servers normally host the DB named in bangdb.config; adjust if your build differs.'
  },
  dropDb: { method: 'DELETE', path: '/db/{db}', verified: false },
  listTables: {
    method: 'GET',
    path: '/db/{db}/list',
    verified: true,
    note: 'Response {"tables":[...],"num_tables":N}'
  },
  createTable: {
    method: 'POST',
    path: '/db/{db}/table',
    verified: true,
    note: 'Body {table_name, table_type, key_type, key_sz, allow_duplicate, allow_rev_idx, version_type}'
  },
  dropTable: { method: 'DELETE', path: '/db/{db}/{table}', verified: false },
  tableInfo: { method: 'GET', path: '/db/{db}/{table}/info', verified: false },
  rowCount: { method: 'GET', path: '/db/{db}/{table}/count', verified: true, note: 'Response {"count":N}' },
  addIndex: { method: 'POST', path: '/db/{db}/{table}/index', verified: true },
  dropIndex: { method: 'DELETE', path: '/db/{db}/{table}/index/{index}', verified: false },
  putDoc: {
    method: 'POST',
    path: '/db/{db}/{table}/doc',
    verified: true,
    note: 'Body is the JSON document; "_pk" is the primary key (string or long by key_type).'
  },
  getDoc: { method: 'GET', path: '/db/{db}/{table}/doc/{key}', verified: false },
  delDoc: { method: 'DELETE', path: '/db/{db}/{table}/doc/{key}', verified: false },
  scanDocs: {
    method: 'POST',
    path: '/db/{db}/{table}/scan',
    verified: false,
    note: 'Body {skey, ekey, query_json}. The SQL endpoint is the verified way to browse data.'
  },
  query: { method: 'POST', path: '/db/{db}/query', verified: true, note: 'Body {"sql":"select * from t limit 10"}' },
  // knoxxr/bangdb JSON HTTP API (bangdb -http :18081)
  goHealth: { method: 'GET', path: '/v1/health', verified: true, note: 'No authentication.' },
  goTables: { method: 'GET', path: '/v1/tables', verified: true, note: 'Tables and views with columns, indexes and SQL.' },
  goTable: { method: 'GET', path: '/v1/tables/{table}', verified: true },
  goQuery: { method: 'POST', path: '/v1/query', verified: true, note: 'Body {sql, args, mode, limit}' },
  goStats: { method: 'GET', path: '/v1/stats', verified: true }
};

export const GO_KEYS: EndpointKey[] = ['goHealth', 'goTables', 'goTable', 'goQuery', 'goStats'];
export const REST_KEYS: EndpointKey[] = (Object.keys(DEFAULT_ENDPOINTS) as EndpointKey[]).filter((k) => !GO_KEYS.includes(k));

export const ENDPOINT_KEYS = Object.keys(DEFAULT_ENDPOINTS) as EndpointKey[];

/** Replace {name} placeholders, URL-encoding each value. Throws if a placeholder is missing. */
export function fillPath(template: string, params: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || v === '') throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(String(v));
  });
}

export function resolveEndpoint(
  key: EndpointKey,
  overrides?: Partial<Record<EndpointKey, EndpointDef>>
): EndpointDef {
  const o = overrides?.[key];
  return o ? { ...DEFAULT_ENDPOINTS[key], ...o } : DEFAULT_ENDPOINTS[key];
}
