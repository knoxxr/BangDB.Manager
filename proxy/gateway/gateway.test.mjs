import { describe, expect, it } from 'vitest';
import { bindParams, decodeArg, encodeValue, returnsRows, splitStatements } from './params.mjs';
import { affinityOf, checkSqliteStatement, identityGroups, sqlitePath, sqliteRoot } from './sql.mjs';
import { parseInfo } from './redis.mjs';

describe('bindParams', () => {
  it('numbers ? for PostgreSQL and SQL Server, keeps MySQL positional', () => {
    expect(bindParams('SELECT * FROM t WHERE a = ? AND b = ?', [1, 'x'], 'pg')).toEqual({ sql: 'SELECT * FROM t WHERE a = $1 AND b = $2', args: [1, 'x'] });
    expect(bindParams('SELECT * FROM t WHERE a = ? AND b = ?', [1, 'x'], 'mssql')).toEqual({ sql: 'SELECT * FROM t WHERE a = @p1 AND b = @p2', args: [1, 'x'] });
    expect(bindParams('SELECT ?', [1], 'mysql')).toEqual({ sql: 'SELECT ?', args: [1] });
  });
  it('?N reuses a slot (pg) or repeats the value (mysql)', () => {
    expect(bindParams('SELECT ?2, ?1, ?2', ['a', 'b'], 'pg')).toEqual({ sql: 'SELECT $1, $2, $1', args: ['b', 'a'] });
    expect(bindParams('SELECT ?2, ?1, ?2', ['a', 'b'], 'mysql')).toEqual({ sql: 'SELECT ?, ?, ?', args: ['b', 'a', 'b'] });
  });
  it(':name with an object, ignoring ::casts, quotes and comments', () => {
    expect(bindParams("SELECT :id::text, ':no', \"x?\" -- ? :c\n WHERE n = :id", { id: 7 }, 'pg')).toEqual({ sql: "SELECT $1::text, ':no', \"x?\" -- ? :c\n WHERE n = $1", args: [7] });
    expect(bindParams('SELECT [a?] , ?', [1], 'mssql').sql).toBe('SELECT [a?] , @p1');
    expect(bindParams('DO $$ BEGIN PERFORM ?; END $$; SELECT ?', [5], 'pg').sql).toBe('DO $$ BEGIN PERFORM ?; END $$; SELECT $1');
  });
  it('no args leaves the SQL alone', () => {
    expect(bindParams('SELECT 1 WHERE a = ?', undefined, 'pg')).toEqual({ sql: 'SELECT 1 WHERE a = ?', args: [] });
  });
});

describe('statements and values', () => {
  it('splits scripts with $$ bodies, quotes and comments', () => {
    expect(splitStatements("CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 'a;b'; -- x;\nSELECT 2")).toEqual([
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql', "SELECT 'a;b'", 'SELECT 2'
    ]);
  });
  it('detects row-returning statements', () => {
    expect(returnsRows('  -- c\n  select 1')).toBe(true);
    expect(returnsRows('SHOW TABLES')).toBe(true);
    expect(returnsRows('UPDATE t SET a = 1')).toBe(false);
  });
  it('encodes driver values for JSON and decodes blobs', () => {
    expect(encodeValue(Buffer.from('AB'))).toEqual({ blob: 'QUI=' });
    expect(encodeValue(12n)).toBe(12);
    expect(encodeValue(2n ** 60n)).toBe('1152921504606846976');
    expect(encodeValue(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02 03:04:05Z');
    expect(decodeArg({ blob: 'QUI=' })).toEqual(Buffer.from('AB'));
  });
  it('maps native types to storage classes', () => {
    expect(['integer', 'bigint', 'tinyint(1)', 'bit', 'numeric(12,2)', 'money', 'bytea', 'varbinary(max)', 'timestamptz', ''].map(affinityOf))
      .toEqual(['INTEGER', 'INTEGER', 'INTEGER', 'INTEGER', 'REAL', 'REAL', 'BLOB', 'BLOB', 'TEXT', 'ANY']);
  });
});

describe('SQLite sandbox', () => {
  it('refuses paths outside SQLITE_ROOT and file: URIs', () => {
    expect(() => sqlitePath('../outside.db')).toThrow(/SQLITE_ROOT/);
    expect(() => sqlitePath('file:/etc/passwd?mode=ro')).toThrow(/SQLITE_ROOT/);
    expect(sqlitePath('sub/new.db').startsWith(sqliteRoot())).toBe(true);
    expect(() => sqlitePath('index.html')).toThrow(/\.db/);
    expect(sqliteRoot().endsWith('data')).toBe(true);
  });
  it('refuses statements that reach other files', () => {
    expect(() => checkSqliteStatement("SELECT 1; ATTACH DATABASE '/tmp/x.db' AS x")).toThrow(/ATTACH/);
    expect(() => checkSqliteStatement("VACUUM INTO '/tmp/copy.db'")).toThrow();
    expect(() => checkSqliteStatement('detach x')).toThrow();
    expect(() => checkSqliteStatement("VACUUM; SELECT 'attach' AS word")).not.toThrow();
  });
});

describe('SQL Server identity blocks', () => {
  it('joins SET IDENTITY_INSERT ON … OFF into one batch', () => {
    const g = identityGroups([
      { sql: 'CREATE TABLE t (id int IDENTITY)' },
      { sql: 'SET IDENTITY_INSERT [t] ON' }, { sql: 'INSERT INTO t (id) VALUES (1)' }, { sql: 'SET IDENTITY_INSERT [t] OFF' },
      { sql: 'SELECT ?', args: [1] }
    ]);
    expect(g.map((x) => [x.first, x.sql])).toEqual([
      [0, 'CREATE TABLE t (id int IDENTITY)'],
      [1, 'SET IDENTITY_INSERT [t] ON;\nINSERT INTO t (id) VALUES (1);\nSET IDENTITY_INSERT [t] OFF'],
      [4, 'SELECT ?']
    ]);
  });
});

describe('redis INFO', () => {
  it('parses sections', () => {
    expect(parseInfo('# Server\r\nredis_version:7.4.1\r\n# Keyspace\r\ndb0:keys=3,expires=0\r\n')).toEqual({ server: { redis_version: '7.4.1' }, keyspace: { db0: 'keys=3,expires=0' } });
  });
});
