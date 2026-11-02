/**
 * SQL dialects of the databases the app manages. The grid, structure editor,
 * dump and console build their SQL through these.
 */
import type { ColumnInfo, Connection, GoTableInfo } from './types';

export type DialectId = 'bangdb' | 'postgres' | 'mysql' | 'mssql' | 'sqlite';

/** How the grid finds a row again for UPDATE / DELETE. */
export type Identity =
  | { kind: 'rowid'; expr: string }
  | { kind: 'ctid' }
  | { kind: 'pk'; columns: string[] }
  | null;

export interface Maintenance { label: string; desc: string; sql: string | ((tables: string[]) => string[]); confirm?: boolean }

export interface Dialect {
  id: DialectId;
  label: string;
  /** Quote one identifier. */
  q(name: string): string;
  /** Quote a table name that may be "schema.table" (schema-qualified only outside the default schema). */
  qt(name: string): string;
  /** Column types offered by the builders. */
  types: { decl: string; hint: string }[];
  /** Collations offered (empty: free text). */
  collations: string[];
  /** Storage engines (BangDB USING memory/timeseries). */
  storage: boolean;
  /** Clauses for ADD COLUMN that the database accepts. */
  addColumn: { unique: boolean; check: boolean; references: boolean; keyword: string };
  /** ALTER of an existing column's type / NOT NULL / DEFAULT. */
  alterColumn?: (table: string, col: ColumnInfo, prev: ColumnInfo) => string[];
  renameTable(table: string, to: string): string;
  renameColumn(table: string, from: string, to: string): string;
  dropIndex(table: string, index: string): string;
  /** CREATE OR REPLACE for views, or null (DROP + CREATE). */
  replaceView: ((name: string, select: string) => string) | null;
  /** Copy a table's structure and rows. */
  copyTable?: (from: string, to: string) => string[];
  /** SELECT … LIMIT/OFFSET (orderBy already quoted, may be empty). */
  page(select: string, orderBy: string, limit: number, offset: number): string;
  likeCI: string;
  autoIncrement(col: ColumnInfo): { typeSuffix: string; afterPk: string };
  explain: { plan: string; analyze?: string } | null;
  analyzeTable(table: string): string;
  maintenance: Maintenance[];
  literal(v: unknown): string;
  /** Statements wrapped around INSERTs of explicit auto-increment values in a dump. */
  dumpIdentity?: (table: string, cols: ColumnInfo[]) => { before: string[]; after: string[] };
  createDatabase?: (name: string) => string;
  dropDatabase?: (name: string) => string;
}

const dq = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const bq = (s: string) => `\`${String(s).replace(/`/g, '``')}\``;
const sq = (s: string) => `[${String(s).replace(/]/g, ']]')}]`;
const splitSchema = (q: (s: string) => string) => (name: string) => {
  const i = name.indexOf('.');
  return i > 0 ? `${q(name.slice(0, i))}.${q(name.slice(i + 1))}` : q(name);
};

/** Standard SQL literal: '' escaping, numbers as is, objects as JSON text. */
function stdLiteral(v: unknown, opts: { bool?: (b: boolean) => string; blob?: (hex: string) => string; str?: (s: string) => string } = {}): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return opts.bool ? opts.bool(v) : v ? '1' : '0';
  if (typeof v === 'object' && typeof (v as { blob?: unknown }).blob === 'string') {
    const bin = atob((v as { blob: string }).blob);
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return opts.blob ? opts.blob(hex) : `X'${hex}'`;
  }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return opts.str ? opts.str(s) : `'${s.replace(/'/g, "''")}'`;
}

const limitOffset = (select: string, orderBy: string, limit: number, offset: number) =>
  `${select}${orderBy ? ` ORDER BY ${orderBy}` : ''} LIMIT ${limit} OFFSET ${offset}`;

export const BANGDB: Dialect = {
  id: 'bangdb', label: 'BangDB',
  q: dq, qt: dq,
  types: [
    { decl: 'INTEGER', hint: 'integer (int64)' }, { decl: 'TEXT', hint: 'string' }, { decl: 'REAL', hint: 'float (float64)' }, { decl: 'BOOLEAN', hint: 'true/false (1/0)' },
    { decl: 'JSON', hint: 'JSON document (TEXT)' }, { decl: 'TIMESTAMP', hint: 'date & time (TEXT)' }, { decl: 'DATE', hint: 'date (TEXT)' }, { decl: 'VARCHAR(255)', hint: 'string' },
    { decl: 'NUMERIC', hint: 'number (REAL)' }, { decl: 'UUID', hint: 'UUID (TEXT)' }, { decl: 'BLOB', hint: 'binary' }, { decl: '', hint: 'ANY (no conversion)' }
  ],
  collations: ['NOCASE', 'RTRIM'],
  storage: true,
  addColumn: { unique: false, check: false, references: false, keyword: 'ADD COLUMN' },
  renameTable: (t, to) => `ALTER TABLE ${dq(t)} RENAME TO ${dq(to)}`,
  renameColumn: (t, a, b) => `ALTER TABLE ${dq(t)} RENAME COLUMN ${dq(a)} TO ${dq(b)}`,
  dropIndex: (_t, i) => `DROP INDEX ${dq(i)}`,
  replaceView: null,
  page: limitOffset,
  likeCI: 'LIKE',
  autoIncrement: () => ({ typeSuffix: '', afterPk: ' AUTOINCREMENT' }),
  explain: { plan: 'EXPLAIN ', analyze: 'EXPLAIN ANALYZE ' },
  analyzeTable: (t) => `ANALYZE ${dq(t)}`,
  maintenance: [
    { label: 'ANALYZE', desc: 'Collects index statistics to improve join order and index selection', sql: 'ANALYZE' },
    { label: 'VACUUM', desc: 'Rewrites the file to reclaim space freed by deletes (writes wait until it finishes)', sql: 'VACUUM', confirm: true }
  ],
  literal: (v) => stdLiteral(v)
};

export const SQLITE: Dialect = {
  ...BANGDB, id: 'sqlite', label: 'SQLite', storage: false,
  types: [
    { decl: 'INTEGER', hint: 'integer' }, { decl: 'TEXT', hint: 'string' }, { decl: 'REAL', hint: 'float' }, { decl: 'NUMERIC', hint: 'number' },
    { decl: 'BOOLEAN', hint: 'true/false (1/0)' }, { decl: 'DATE', hint: 'date (TEXT)' }, { decl: 'DATETIME', hint: 'date & time (TEXT)' }, { decl: 'JSON', hint: 'JSON (TEXT)' },
    { decl: 'BLOB', hint: 'binary' }, { decl: '', hint: 'no type' }
  ],
  collations: ['NOCASE', 'RTRIM'],
  addColumn: { unique: false, check: true, references: true, keyword: 'ADD COLUMN' },
  explain: { plan: 'EXPLAIN QUERY PLAN ' },
  maintenance: [
    { label: 'ANALYZE', desc: 'Refreshes query planner statistics', sql: 'ANALYZE' },
    { label: 'PRAGMA optimize', desc: 'Refreshes only the statistics that need it', sql: 'PRAGMA optimize' },
    { label: 'PRAGMA integrity_check', desc: 'Checks file integrity ("ok" means healthy)', sql: 'PRAGMA integrity_check' },
    { label: 'PRAGMA foreign_key_check', desc: 'Finds rows that violate foreign keys', sql: 'PRAGMA foreign_key_check' },
    { label: 'VACUUM', desc: 'Rewrites the file to reclaim free space', sql: 'VACUUM', confirm: true }
  ]
};

export const POSTGRES: Dialect = {
  id: 'postgres', label: 'PostgreSQL',
  q: dq, qt: splitSchema(dq),
  types: [
    { decl: 'integer', hint: 'integer' }, { decl: 'bigint', hint: 'big integer' }, { decl: 'text', hint: 'string' }, { decl: 'varchar(255)', hint: 'length-limited string' },
    { decl: 'boolean', hint: 'true/false' }, { decl: 'numeric(12,2)', hint: 'fixed-point decimal' }, { decl: 'double precision', hint: 'float' }, { decl: 'date', hint: 'date' },
    { decl: 'timestamp', hint: 'date & time' }, { decl: 'timestamptz', hint: 'with time zone' }, { decl: 'jsonb', hint: 'JSON (indexable)' }, { decl: 'uuid', hint: 'UUID' },
    { decl: 'bytea', hint: 'binary' }, { decl: 'text[]', hint: 'string array' }
  ],
  collations: [],
  storage: false,
  addColumn: { unique: true, check: true, references: true, keyword: 'ADD COLUMN' },
  alterColumn: (t, c, p) => {
    const out: string[] = [];
    const T = POSTGRES.qt(t), C = dq(c.name);
    if ((c.decl ?? '') !== (p.decl ?? '')) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} TYPE ${c.decl} USING ${C}::${c.decl}`);
    if (!!c.notNull !== !!p.notNull) out.push(`ALTER TABLE ${T} ALTER COLUMN ${C} ${c.notNull ? 'SET' : 'DROP'} NOT NULL`);
    if ((c.default ?? '') !== (p.default ?? '')) out.push(c.default?.trim() ? `ALTER TABLE ${T} ALTER COLUMN ${C} SET DEFAULT ${c.default}` : `ALTER TABLE ${T} ALTER COLUMN ${C} DROP DEFAULT`);
    return out;
  },
  renameTable: (t, to) => `ALTER TABLE ${POSTGRES.qt(t)} RENAME TO ${dq(to.includes('.') ? to.slice(to.indexOf('.') + 1) : to)}`,
  renameColumn: (t, a, b) => `ALTER TABLE ${POSTGRES.qt(t)} RENAME COLUMN ${dq(a)} TO ${dq(b)}`,
  dropIndex: (_t, i) => `DROP INDEX ${POSTGRES.qt(i)}`,
  replaceView: (n, s) => `CREATE OR REPLACE VIEW ${POSTGRES.qt(n)} AS ${s}`,
  copyTable: (a, b) => [`CREATE TABLE ${POSTGRES.qt(b)} (LIKE ${POSTGRES.qt(a)} INCLUDING ALL)`, `INSERT INTO ${POSTGRES.qt(b)} SELECT * FROM ${POSTGRES.qt(a)}`],
  page: limitOffset,
  likeCI: 'ILIKE',
  autoIncrement: () => ({ typeSuffix: ' GENERATED BY DEFAULT AS IDENTITY', afterPk: '' }),
  explain: { plan: 'EXPLAIN ', analyze: 'EXPLAIN ANALYZE ' },
  analyzeTable: (t) => `ANALYZE ${POSTGRES.qt(t)}`,
  maintenance: [
    { label: 'ANALYZE', desc: 'Refreshes statistics for all tables', sql: 'ANALYZE' },
    { label: 'VACUUM', desc: 'Cleans up dead rows so their space can be reused', sql: 'VACUUM' },
    { label: 'VACUUM FULL', desc: 'Rewrites tables to return space to the OS (locks tables)', sql: 'VACUUM FULL', confirm: true },
    { label: 'REINDEX', desc: 'Rebuilds the indexes of the current database', sql: 'REINDEX DATABASE CURRENT_DATABASE', confirm: true }
  ],
  literal: (v) => stdLiteral(v, { bool: (b) => (b ? 'TRUE' : 'FALSE'), blob: (h) => `'\\x${h}'::bytea` }),
  dumpIdentity: (t, cols) => ({
    before: [],
    after: cols.filter((c) => c.autoinc).map((c) => `SELECT setval(pg_get_serial_sequence('${POSTGRES.qt(t).replace(/'/g, "''")}', '${c.name.replace(/'/g, "''")}'), COALESCE(MAX(${dq(c.name)}), 0) + 1, false) FROM ${POSTGRES.qt(t)}`)
  }),
  createDatabase: (n) => `CREATE DATABASE ${dq(n)}`,
  dropDatabase: (n) => `DROP DATABASE ${dq(n)}`
};

export const MYSQL: Dialect = {
  id: 'mysql', label: 'MySQL',
  q: bq, qt: bq,
  types: [
    { decl: 'INT', hint: 'integer' }, { decl: 'BIGINT', hint: 'big integer' }, { decl: 'VARCHAR(255)', hint: 'string' }, { decl: 'TEXT', hint: 'long string' },
    { decl: 'BOOLEAN', hint: 'true/false (TINYINT(1))' }, { decl: 'DECIMAL(12,2)', hint: 'fixed-point decimal' }, { decl: 'DOUBLE', hint: 'float' }, { decl: 'DATE', hint: 'date' },
    { decl: 'DATETIME', hint: 'date & time' }, { decl: 'TIMESTAMP', hint: 'timestamp' }, { decl: 'JSON', hint: 'JSON' }, { decl: "ENUM('a','b')", hint: 'enum' }, { decl: 'BLOB', hint: 'binary' }
  ],
  collations: ['utf8mb4_general_ci', 'utf8mb4_unicode_ci', 'utf8mb4_bin', 'utf8mb4_0900_ai_ci'],
  storage: false,
  addColumn: { unique: true, check: true, references: true, keyword: 'ADD COLUMN' },
  alterColumn: (t, c) => [`ALTER TABLE ${bq(t)} MODIFY COLUMN ${bq(c.name)} ${c.decl}${c.notNull ? ' NOT NULL' : ' NULL'}${c.autoinc ? ' AUTO_INCREMENT' : ''}${c.default?.trim() ? ` DEFAULT ${c.default}` : ''}`],
  renameTable: (t, to) => `RENAME TABLE ${bq(t)} TO ${bq(to)}`,
  renameColumn: (t, a, b) => `ALTER TABLE ${bq(t)} RENAME COLUMN ${bq(a)} TO ${bq(b)}`,
  dropIndex: (t, i) => `DROP INDEX ${bq(i)} ON ${bq(t)}`,
  replaceView: (n, s) => `CREATE OR REPLACE VIEW ${bq(n)} AS ${s}`,
  copyTable: (a, b) => [`CREATE TABLE ${bq(b)} LIKE ${bq(a)}`, `INSERT INTO ${bq(b)} SELECT * FROM ${bq(a)}`],
  page: limitOffset,
  likeCI: 'LIKE',
  autoIncrement: () => ({ typeSuffix: ' AUTO_INCREMENT', afterPk: '' }),
  explain: { plan: 'EXPLAIN ', analyze: 'EXPLAIN ANALYZE ' },
  analyzeTable: (t) => `ANALYZE TABLE ${bq(t)}`,
  maintenance: [
    { label: 'ANALYZE TABLE', desc: 'Refreshes key distribution statistics for all tables', sql: (ts) => ts.map((t) => `ANALYZE TABLE ${bq(t)}`) },
    { label: 'CHECK TABLE', desc: 'Checks all tables for errors', sql: (ts) => ts.map((t) => `CHECK TABLE ${bq(t)}`) },
    { label: 'OPTIMIZE TABLE', desc: 'Rebuilds tables to reclaim space (takes locks)', sql: (ts) => ts.map((t) => `OPTIMIZE TABLE ${bq(t)}`), confirm: true }
  ],
  literal: (v) => stdLiteral(v, { str: (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` }),
  createDatabase: (n) => `CREATE DATABASE ${bq(n)} CHARACTER SET utf8mb4`,
  dropDatabase: (n) => `DROP DATABASE ${bq(n)}`
};

export const MSSQL: Dialect = {
  id: 'mssql', label: 'SQL Server',
  q: sq, qt: splitSchema(sq),
  types: [
    { decl: 'INT', hint: 'integer' }, { decl: 'BIGINT', hint: 'big integer' }, { decl: 'NVARCHAR(255)', hint: 'Unicode string' }, { decl: 'NVARCHAR(MAX)', hint: 'long string' },
    { decl: 'VARCHAR(255)', hint: 'string' }, { decl: 'BIT', hint: 'true/false' }, { decl: 'DECIMAL(12,2)', hint: 'fixed-point decimal' }, { decl: 'FLOAT', hint: 'float' },
    { decl: 'DATE', hint: 'date' }, { decl: 'DATETIME2', hint: 'date & time' }, { decl: 'UNIQUEIDENTIFIER', hint: 'GUID' }, { decl: 'VARBINARY(MAX)', hint: 'binary' }
  ],
  collations: ['Korean_Wansung_CI_AS', 'Latin1_General_CI_AS', 'Latin1_General_BIN2'],
  storage: false,
  addColumn: { unique: true, check: true, references: true, keyword: 'ADD' },
  alterColumn: (t, c) => [`ALTER TABLE ${MSSQL.qt(t)} ALTER COLUMN ${sq(c.name)} ${c.decl}${c.notNull ? ' NOT NULL' : ' NULL'}`],
  renameTable: (t, to) => `EXEC sp_rename '${t.replace(/'/g, "''")}', '${to.replace(/'/g, "''")}'`,
  renameColumn: (t, a, b) => `EXEC sp_rename '${`${t}.${a}`.replace(/'/g, "''")}', '${b.replace(/'/g, "''")}', 'COLUMN'`,
  dropIndex: (t, i) => `DROP INDEX ${sq(i)} ON ${MSSQL.qt(t)}`,
  replaceView: (n, s) => `CREATE OR ALTER VIEW ${MSSQL.qt(n)} AS ${s}`,
  copyTable: (a, b) => [`SELECT * INTO ${MSSQL.qt(b)} FROM ${MSSQL.qt(a)}`],
  page: (select, orderBy, limit, offset) => `${select} ORDER BY ${orderBy || '(SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  likeCI: 'LIKE',
  autoIncrement: () => ({ typeSuffix: ' IDENTITY(1,1)', afterPk: '' }),
  explain: null,
  analyzeTable: (t) => `UPDATE STATISTICS ${MSSQL.qt(t)}`,
  maintenance: [
    { label: 'sp_updatestats', desc: 'Refreshes statistics for all tables', sql: 'EXEC sp_updatestats' },
    { label: 'DBCC CHECKDB', desc: 'Checks the integrity of the current database', sql: 'DBCC CHECKDB WITH NO_INFOMSGS', confirm: true }
  ],
  literal: (v) => stdLiteral(v, { blob: (h) => `0x${h}`, str: (s) => `N'${s.replace(/'/g, "''")}'` }),
  dumpIdentity: (t, cols) => (cols.some((c) => c.autoinc) ? { before: [`SET IDENTITY_INSERT ${MSSQL.qt(t)} ON`], after: [`SET IDENTITY_INSERT ${MSSQL.qt(t)} OFF`] } : { before: [], after: [] }),
  createDatabase: (n) => `CREATE DATABASE ${sq(n)}`,
  dropDatabase: (n) => `DROP DATABASE ${sq(n)}`
};

const BY_KIND: Record<string, Dialect> = { go: BANGDB, postgres: POSTGRES, mysql: MYSQL, mssql: MSSQL, sqlite: SQLITE };

export const dialectOf = (c: Pick<Connection, 'kind'> | undefined): Dialect => BY_KIND[c?.kind ?? 'go'] ?? BANGDB;
export const isSqlKind = (k: string | undefined) => !!k && k in BY_KIND;

/** The SELECT of a view definition, whatever the database prefixes it with (ALGORITHM, DEFINER, schema, column list). */
export function viewSelect(sql: string): string {
  const id = '(?:"(?:[^"]|"")+"|`[^`]+`|\\[[^\\]]+\\]|[^\\s(.]+)';
  return sql.replace(new RegExp(`^[\\s\\S]*?\\bVIEW\\s+${id}(?:\\.${id})?\\s*(?:\\([^)]*\\)\\s*)?AS\\s+`, 'i'), '').replace(/;\s*$/, '').trim();
}

/** Row identity of a table: rowid / ctid where the database has one, else the primary key. */
export function identityOf(d: Dialect, info: GoTableInfo | undefined): Identity {
  if (!info || info.kind === 'view') return null;
  if (d.id === 'bangdb') return { kind: 'rowid', expr: 'rowid' };
  if (info.rowid === 'rowid') return { kind: 'rowid', expr: 'rowid' };
  const pk = info.primaryKey?.length ? info.primaryKey : (info.columns ?? []).filter((c) => c.pk).map((c) => c.name);
  if (pk.length) return { kind: 'pk', columns: pk };
  if (info.rowid === 'ctid') return { kind: 'ctid' };
  return null;
}
