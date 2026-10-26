import { describe, expect, it, beforeEach } from 'vitest';
import { fillPath, resolveEndpoint, DEFAULT_ENDPOINTS } from './endpoints';
import { authHeaders, setFetchImpl } from './http';
import { createTable, extractRows, extractTables, extractToken, listTables, sql } from './bangdb';
import { normalize } from '../store/store';
import type { Connection } from './types';

const conn = (over: Partial<Connection> = {}): Connection =>
  normalize({ id: 'c1', name: 't', baseUrl: 'http://10.0.0.5:18080/', defaultDb: 'mydb', ...over });

describe('endpoints', () => {
  it('fills and encodes path params', () => {
    expect(fillPath('/db/{db}/{table}/doc/{key}', { db: 'my db', table: 't', key: 'a/b' })).toBe('/db/my%20db/t/doc/a%2Fb');
  });
  it('throws on missing params', () => {
    expect(() => fillPath('/db/{db}', {})).toThrow(/db/);
  });
  it('applies overrides on top of defaults', () => {
    const ep = resolveEndpoint('dropTable', { dropTable: { method: 'DELETE', path: '/db/{db}/table/{table}', verified: false } });
    expect(ep.path).toBe('/db/{db}/table/{table}');
    expect(resolveEndpoint('dropTable').path).toBe(DEFAULT_ENDPOINTS.dropTable.path);
  });
});

describe('auth headers', () => {
  it('api key', () => {
    const h = authHeaders(conn({ auth: { mode: 'apikey', apiKey: 'K', headerName: 'x-bang-api-key', tokenField: 'token' } }));
    expect(h['x-bang-api-key']).toBe('K');
  });
  it('basic', () => {
    const h = authHeaders(conn({ auth: { mode: 'basic', user: 'admin', pass: 'admin', headerName: '', tokenField: '' } }));
    expect(h.Authorization).toBe('Basic YWRtaW46YWRtaW4=');
  });
  it('login token', () => {
    const h = authHeaders(conn({ auth: { mode: 'login', token: 'T', headerName: 'x-bang-api-key', tokenField: 'token' } }));
    expect(h['x-bang-api-key']).toBe('T');
  });
});

describe('client calls', () => {
  let last: { url: string; init: RequestInit } | undefined;
  beforeEach(() => {
    last = undefined;
    setFetchImpl((async (url: string | URL | Request, init?: RequestInit) => {
      last = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ tables: ['_sys_user_tbl', 'orders'], num_tables: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch);
  });

  it('lists tables with the verified path', async () => {
    const res = await listTables(conn(), 'mydb');
    expect(last?.url).toBe('http://10.0.0.5:18080/db/mydb/list');
    expect(last?.init.method).toBe('GET');
    expect(res.ok).toBe(true);
    expect(extractTables(res.data)).toEqual(['_sys_user_tbl', 'orders']);
  });

  it('creates a table with a JSON body', async () => {
    await createTable(conn(), 'mydb', {
      table_name: 'orders', table_type: 'WIDE_TABLE', key_type: 'NORMAL_KEY', key_sz: 24,
      allow_duplicate: false, allow_rev_idx: false, version_type: 0
    });
    expect(last?.url).toBe('http://10.0.0.5:18080/db/mydb/table');
    expect(last?.init.method).toBe('POST');
    expect(JSON.parse(String(last?.init.body)).table_name).toBe('orders');
    expect((last?.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends sql to the query endpoint', async () => {
    await sql(conn(), 'mydb', 'select * from orders limit 5');
    expect(last?.url).toBe('http://10.0.0.5:18080/db/mydb/query');
    expect(JSON.parse(String(last?.init.body))).toEqual({ sql: 'select * from orders limit 5' });
  });

  it('routes through the local proxy when enabled', async () => {
    (globalThis as any).window = { location: { origin: 'http://localhost:5173' } };
    await listTables(conn({ useProxy: true }), 'mydb');
    expect(last?.url).toBe('http://localhost:5173/bangdb/db/mydb/list');
    expect((last?.init.headers as Record<string, string>)['x-bangdb-target']).toBe('http://10.0.0.5:18080');
    delete (globalThis as any).window;
  });

  it('reports network failures without throwing', async () => {
    setFetchImpl((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    const res = await listTables(conn(), 'mydb');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED');
  });
});

describe('response helpers', () => {
  it('extracts rows from common wrappers', () => {
    expect(extractRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(extractRows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractRows({ docs: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractRows({ count: 3 })).toEqual([{ count: 3 }]);
  });
  it('extracts token', () => {
    expect(extractToken({ token: 'abc' }, 'token')).toBe('abc');
    expect(extractToken({ api_key: 'k' }, 'token')).toBe('k');
    expect(extractToken('x', 'token')).toBeUndefined();
  });
  it('normalizes connections', () => {
    const c = normalize({ baseUrl: 'http://h:18080///', defaultDb: ' prod ', databases: ['prod', 'dev'] });
    expect(c.baseUrl).toBe('http://h:18080');
    expect(c.databases).toEqual(['prod', 'dev']);
    expect(c.auth.headerName).toBe('x-bang-api-key');
  });
});
