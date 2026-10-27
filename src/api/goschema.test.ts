import { describe, expect, it } from 'vitest';
import {
  addColumnSql, changeScript, columnDefSql, createIndexSql, createTableSql, defaultSql, dumpLiteral, insertBatchSql,
  orderByDependencies, pageSql, parseInput, splitSql, storageSql
} from './goapi';
import { csvToDocs, parseCsv } from './data';
import { withScheme } from '../store/store';

const base = { table_name: 't', table_type: 'NORMAL_TABLE', key_type: 'NORMAL_KEY', key_sz: 0, allow_duplicate: false, allow_rev_idx: false, version_type: 0 } as const;

describe('DDL builders', () => {
  it('column definitions with every constraint', () => {
    expect(columnDefSql({ name: 'dept_id', decl: 'INT', notNull: true, check: 'dept_id > 0', refTable: 'dept', refColumn: 'id', onDelete: 'CASCADE' }))
      .toBe('"dept_id" INT NOT NULL CHECK (dept_id > 0) REFERENCES "dept" ("id") ON DELETE CASCADE');
    expect(columnDefSql({ name: 'code', decl: 'TEXT', unique: true, collate: 'NOCASE', default: 'x' })).toBe('"code" TEXT UNIQUE DEFAULT \'x\' COLLATE NOCASE');
    expect(columnDefSql({ name: 'id', decl: 'INTEGER', pk: true, autoinc: true, notNull: true })).toBe('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(columnDefSql({ name: 'any', decl: '' })).toBe('"any"');
  });
  it('defaults: numbers, keywords and expressions pass, words are quoted', () => {
    expect(defaultSql('0')).toBe('0');
    expect(defaultSql('current_timestamp')).toBe('CURRENT_TIMESTAMP');
    expect(defaultSql("'a'")).toBe("'a'");
    expect(defaultSql("(datetime('now'))")).toBe("(datetime('now'))");
    expect(defaultSql("it's")).toBe("'it''s'");
  });
  it('ADD COLUMN leaves out constraints ALTER refuses', () => {
    expect(addColumnSql('t', { name: 'c', decl: 'INT', notNull: true, default: '5', unique: true, check: 'c > 0', refTable: 'x' }))
      .toBe('ALTER TABLE "t" ADD COLUMN "c" INT NOT NULL DEFAULT 5');
  });
  it('composite primary key, table constraints and storage', () => {
    const s = createTableSql({ ...base, table_name: 'm', columns: [{ name: 'a', decl: 'INT', pk: true }, { name: 'b', decl: 'TEXT', pk: true }], uniques: [['a', 'b']], checks: ['a > 0'], storage: { using: 'memory', persist: true } });
    expect(s).toBe('CREATE TABLE "m" (\n  "a" INT,\n  "b" TEXT,\n  PRIMARY KEY ("a", "b"),\n  UNIQUE ("a", "b"),\n  CHECK (a > 0)\n) USING memory WITH (persist = true)');
  });
  it('timeseries options', () => {
    expect(storageSql({ using: 'timeseries', timeColumn: 'ts', timeUnit: 'ms', retention: '30 days', blockRows: 512 }))
      .toBe(` USING timeseries WITH (time_column = "ts", time_unit = 'ms', retention = '30 days', block_rows = 512)`);
    expect(() => storageSql({ using: 'timeseries' })).toThrow();
  });
  it('index names', () => {
    expect(createIndexSql('emp', ['dept_id', 'email'], { unique: true })).toBe('CREATE UNIQUE INDEX "idx_emp_dept_id_email" ON "emp" ("dept_id", "email")');
    expect(createIndexSql('emp', ['x'], { name: 'my' })).toBe('CREATE INDEX "my" ON "emp" ("x")');
  });
});

describe('grid SQL', () => {
  it('pages by rowid with filters and sorting', () => {
    expect(pageSql('t', { limit: 50, offset: 100 })).toBe('SELECT rowid AS "__rowid", * FROM "t" ORDER BY rowid LIMIT 50 OFFSET 100');
    expect(pageSql('t', { where: 'a > 1', orderBy: 'a', desc: true, limit: 10, offset: 0 }, false)).toBe('SELECT * FROM "t" WHERE a > 1 ORDER BY "a" DESC LIMIT 10 OFFSET 0');
  });
  it('change script numbers parameters across statements', () => {
    const { sql, args } = changeScript('t', [
      { kind: 'delete', rowid: 3 },
      { kind: 'update', rowid: 1, values: { a: 'x', j: { k: 1 } } },
      { kind: 'insert', values: { a: 'y', ok: true } }
    ]);
    expect(sql).toBe('BEGIN;\nDELETE FROM "t" WHERE rowid = ?1;\nUPDATE "t" SET "a" = ?2, "j" = ?3 WHERE rowid = ?4;\nINSERT INTO "t" ("a", "ok") VALUES (?5, ?6);\nCOMMIT;');
    expect(args).toEqual([3, 'x', '{"k":1}', 1, 'y', 1]);
    expect(() => changeScript('t', [{ kind: 'insert', values: {} }])).toThrow();
    expect(() => changeScript('t', [])).toThrow();
  });
  it('typed input', () => {
    expect(parseInput('42', { name: 'a', type: 'INTEGER' })).toBe(42);
    expect(parseInput('', { name: 'a', type: 'INTEGER' })).toBeNull();
    expect(() => parseInput('4.2', { name: 'a', type: 'INTEGER' })).toThrow(/정수/);
    expect(parseInput('9007199254740993', { name: 'a', type: 'INTEGER' })).toBe('9007199254740993');
    expect(parseInput('1.5', { name: 'r', decl: 'DOUBLE' })).toBe(1.5);
    expect(parseInput(' 007 ', { name: 's', type: 'TEXT' })).toBe(' 007 ');
    expect(parseInput('12', { name: 'x' })).toBe(12);
  });
  it('multi-row insert', () => {
    expect(insertBatchSql('t', ['a', 'b'], [[1, 'x'], [2, null]], 'ignore'))
      .toEqual({ sql: 'INSERT OR IGNORE INTO "t" ("a", "b") VALUES (?, ?), (?, ?)', args: [1, 'x', 2, null] });
  });
});

describe('dump and scripts', () => {
  it('splits statements outside quotes and comments', () => {
    expect(splitSql("INSERT INTO t VALUES ('a;b'); -- c;\nSELECT \"x;y\" /* ; */ FROM t;;\n")).toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT "x;y"   FROM t']);
    expect(splitSql("SELECT 'it''s; ok'")).toEqual(["SELECT 'it''s; ok'"]);
  });
  it('orders tables after the tables they reference', () => {
    const t = (name: string, sql: string) => ({ name, kind: 'table' as const, sql });
    const out = orderByDependencies([t('emp', 'CREATE TABLE emp (d INT REFERENCES dept)'), t('x', 'CREATE TABLE x (e INT REFERENCES "emp" (id))'), t('dept', 'CREATE TABLE dept (id INT)')]);
    expect(out.map((x) => x.name)).toEqual(['dept', 'emp', 'x']);
  });
  it('dump literals', () => {
    expect(dumpLiteral({ blob: 'QUI=' })).toBe("X'4142'");
    expect(dumpLiteral("it's")).toBe("'it''s'");
    expect(dumpLiteral(null)).toBe('NULL');
  });
});

describe('CSV and URLs', () => {
  it('parses quoted fields and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n1,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
    expect(csvToDocs('﻿a\tb\n1\t\n')).toEqual([{ a: '1', b: null }]);
    expect(csvToDocs('a,b\n1,\n', { emptyAsNull: false })).toEqual([{ a: '1', b: '' }]);
  });
  it('adds a missing scheme', () => {
    expect(withScheme('localhost:7432')).toBe('http://localhost:7432');
    expect(withScheme('https://x')).toBe('https://x');
  });
});
