import { beforeEach, describe, expect, it } from 'vitest';
import { setFetchImpl } from './http';
import { createTableSql, goRows, primaryKeyColumns, sqlValue, coerceKey, updateRow, deleteRow, insertRow } from './goapi';
import { extractRows, extractTables, listTables, rowCount, sql } from './bangdb';
import { normalize } from '../store/store';
import type { Connection } from './types';

const conn = (): Connection => normalize({ id: 'g', name: 'go', kind: 'go', baseUrl: 'http://10.0.0.5:18081', auth: { mode: 'basic', user: 'app', pass: 'pw', headerName: '', tokenField: '' } });
const base = { table_name: 't', table_type: 'NORMAL_TABLE', key_type: 'NORMAL_KEY', key_sz: 0, allow_duplicate: false, allow_rev_idx: false, version_type: 0 } as const;

describe('createTableSql', () => {
  it('builds column definitions', () => {
    const s = createTableSql({ ...base, table_name: 'users', columns: [
      { name: 'id', decl: 'INTEGER', pk: true }, { name: 'name', decl: 'TEXT', notNull: true, unique: true }, { name: 'age', decl: 'INT', default: '0' }, { name: '', decl: 'TEXT' }
    ] });
    expect(s).toBe('CREATE TABLE "users" (\n  "id" INTEGER PRIMARY KEY,\n  "name" TEXT NOT NULL UNIQUE,\n  "age" INT DEFAULT 0\n)');
  });
  it('prefers raw sql and rejects empty columns', () => {
    expect(createTableSql({ ...base, sql: ' CREATE TABLE x (a) ' })).toBe('CREATE TABLE x (a)');
    expect(() => createTableSql({ ...base, columns: [] })).toThrow();
  });
});

describe('response helpers', () => {
  it('goRows zips columns and rows', () => {
    expect(goRows({ columns: ['a', 'b'], rows: [[1, 'x'], [2, null]] })).toEqual([{ a: 1, b: 'x' }, { a: 2, b: null }]);
    expect(extractRows({ columns: ['n'], rows: [[3]], types: [] })).toEqual([{ n: 3 }]);
  });
  it('primary key from flags or composite list', () => {
    expect(primaryKeyColumns({ name: 't', kind: 'table', columns: [{ name: 'id', pk: true }, { name: 'x' }] })).toEqual(['id']);
    expect(primaryKeyColumns({ name: 't', kind: 'table', primaryKey: ['a', 'b'], columns: [] })).toEqual(['a', 'b']);
    expect(primaryKeyColumns(undefined)).toEqual([]);
  });
  it('sqlValue and coerceKey', () => {
    expect(sqlValue(true)).toBe(1);
    expect(sqlValue({ a: 1 })).toBe('{"a":1}');
    expect(sqlValue(undefined)).toBeNull();
    expect(coerceKey('42')).toBe(42);
    expect(coerceKey('u1')).toBe('u1');
  });
});

describe('Go adapter requests', () => {
  let calls: { url: string; init: RequestInit }[] = [];
  beforeEach(() => {
    calls = [];
    setFetchImpl((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = String(url);
      const body = u.endsWith('/v1/tables')
        ? { tables: [{ name: 'users', kind: 'table', columns: [{ name: 'id', pk: true }] }], count: 1 }
        : { columns: ['count'], types: ['INTEGER'], rows: [[7]], rows_affected: 1, last_insert_id: 0, truncated: false, ms: 0.1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);
  });
  const lastBody = () => JSON.parse(String(calls[calls.length - 1].init.body));

  it('lists tables with basic auth', async () => {
    const r = await listTables(conn(), 'main');
    expect(calls[0].url).toBe('http://10.0.0.5:18081/v1/tables');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Basic YXBwOnB3');
    expect(extractTables(r.data)).toEqual(['users']);
  });
  it('counts rows through SQL', async () => {
    const r = await rowCount(conn(), 'main', 'users');
    expect(lastBody().sql).toBe('SELECT COUNT(*) AS count FROM "users"');
    expect(r.data.count).toBe(7);
  });
  it('runs sql on /v1/query', async () => {
    await sql(conn(), 'main', 'SELECT 1');
    expect(calls[0].url).toBe('http://10.0.0.5:18081/v1/query');
    expect(lastBody()).toEqual({ sql: 'SELECT 1' });
  });
  it('insert, update and delete use parameters', async () => {
    await insertRow(conn(), 'users', { name: 'kim', tags: ['a'], ok: true });
    expect(lastBody()).toMatchObject({ sql: 'INSERT INTO "users" ("name", "tags", "ok") VALUES (?, ?, ?)', args: ['kim', '["a"]', 1], mode: 'exec' });
    await updateRow(conn(), 'users', { id: 1, name: 'new' }, { id: 1, name: 'old' }, ['id']);
    expect(lastBody()).toMatchObject({ sql: 'UPDATE "users" SET "name" = ? WHERE "id" = ?', args: ['new', 1] });
    await deleteRow(conn(), 'users', { id: 1, name: 'old' }, ['id']);
    expect(lastBody()).toMatchObject({ sql: 'DELETE FROM "users" WHERE "id" = ?', args: [1] });
    expect(() => updateRow(conn(), 'users', { a: 1 }, { a: 2 }, [])).toThrow(/기본 키/);
  });
});
