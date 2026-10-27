/**
 * SQL access for knoxxr/bangdb's JSON HTTP API (`bangdb -http :18081`) and for
 * the SQL databases reached through the app's gateway (PostgreSQL, MySQL,
 * SQL Server, SQLite), which answer in the same shape. Builders take a
 * Dialect and default to BangDB's.
 */
import type { ApiResult, ColumnInfo, Connection, CreateTableSpec, GoQueryResponse, GoTableInfo, IndexSpec, StorageSpec } from './types';
import { call } from './bangdb';
import { BANGDB, dialectOf, type Dialect, type Identity } from './dialect';
import { gw } from './gateway';

/** Quote an identifier for BangDB SQL. */
export const qi = (name: string) => `"${String(name).replace(/"/g, '""')}"`;

/** BangDB literal for a JS value (other databases: Dialect.literal). */
export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ---------- transport ----------

export const goQuery = (c: Connection, sql: string, args?: unknown[] | Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  c.db ? gw<GoQueryResponse>(c, 'query', { sql, args, ...extra }) : call<GoQueryResponse>(c, 'goQuery', { body: { sql, args, ...extra } });

export const goTables = (c: Connection) =>
  c.db ? gw<{ tables: GoTableInfo[]; count: number }>(c, 'tables') : call<{ tables: GoTableInfo[]; count: number }>(c, 'goTables');
export const goTable = (c: Connection, table: string) => (c.db ? gw<GoTableInfo>(c, 'table', { table }) : call<GoTableInfo>(c, 'goTable', { params: { table } }));
export const goStats = (c: Connection) => (c.db ? gw(c, 'stats') : call(c, 'goStats'));
export const goHealth = (c: Connection) => (c.db ? gw<{ ok: boolean; version: string }>(c, 'health') : call<{ ok: boolean; version: string }>(c, 'goHealth'));

export interface Stmt { sql: string; args?: unknown[] }
const EMPTY: GoQueryResponse = { columns: [], types: [], rows: [], rows_affected: 0, last_insert_id: 0, truncated: false, ms: 0 };

/**
 * Run statements in one transaction: the gateway's /batch, or one BangDB
 * script (BEGIN … COMMIT, parameters renumbered to ?N). The answer is the
 * last statement's result.
 */
export async function execStatements(c: Connection, stmts: (string | Stmt)[]): Promise<ApiResult<GoQueryResponse>> {
  const list = stmts.map((s) => (typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: s.args ?? [] }));
  if (c.db) {
    const r = await gw<{ results: GoQueryResponse[] }>(c, 'batch', { statements: list });
    const results = r.ok ? r.data.results : [];
    return { ...r, data: (r.ok ? { ...(results[results.length - 1] ?? EMPTY), rows_affected: results.reduce((n, x) => n + (x.rows_affected ?? 0), 0) } : r.data) as GoQueryResponse };
  }
  if (list.length === 1) return goQuery(c, list[0].sql, list[0].args.length ? list[0].args : undefined, { mode: 'exec' });
  const { sql, args } = toScript(list);
  return goQuery(c, sql, args.length ? args : undefined, { mode: 'exec' });
}

/** Statements with `?` → one BEGIN … COMMIT script with ?N parameters (BangDB). */
export function toScript(stmts: Stmt[]): { sql: string; args: unknown[] } {
  const args: unknown[] = [];
  const body = stmts.map((s) => {
    let i = 0;
    return renumber(s.sql, () => { args.push((s.args ?? [])[i++]); return `?${args.length}`; });
  });
  return { sql: `BEGIN;\n${body.join(';\n')};\nCOMMIT;`, args };
}

/** Replace bare `?` outside quotes. */
function renumber(sql: string, next: () => string): string {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length && sql[j] !== close) j++;
      out += sql.slice(i, j + 1);
      i = j;
    } else if (ch === '?' && !/\d/.test(sql[i + 1] ?? '')) out += next();
    else out += ch;
  }
  return out;
}

/** Rows of a /v1/query answer as objects keyed by column name. */
export function goRows(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Partial<GoQueryResponse>;
  if (!Array.isArray(d.columns) || !Array.isArray(d.rows)) return [];
  const cols = d.columns;
  return d.rows.map((r) => {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
}

/** Primary key columns of a table (INTEGER PRIMARY KEY, column flags or a composite key). */
export function primaryKeyColumns(info: GoTableInfo | undefined): string[] {
  if (!info) return [];
  if (info.primaryKey?.length) return info.primaryKey;
  return (info.columns ?? []).filter((c) => c.pk).map((c) => c.name);
}

// ---------- DDL ----------

/**
 * One column definition. `inTable` false is for ALTER TABLE ADD COLUMN: the
 * clauses the dialect refuses there are left out. `pkInline` false leaves
 * PRIMARY KEY to a table constraint (composite keys).
 */
export function columnDefSql(c: ColumnInfo, opts: { inTable?: boolean; pkInline?: boolean } = {}, d: Dialect = BANGDB): string {
  const inTable = opts.inTable ?? true;
  const pkInline = opts.pkInline ?? true;
  const type = (c.decl ?? c.type ?? '').trim();
  const ai = c.autoinc && c.pk ? d.autoIncrement(c) : null;
  let s = d.q(c.name.trim()) + (type && type.toUpperCase() !== 'ANY' ? ` ${type}` : '') + (ai ? ai.typeSuffix : '');
  if (inTable && c.pk && pkInline) s += ` PRIMARY KEY${ai ? ai.afterPk : ''}`;
  if (c.notNull && !(c.pk && pkInline && inTable)) s += ' NOT NULL';
  if (c.unique && !c.pk && (inTable || d.addColumn.unique)) s += ' UNIQUE';
  if (c.default?.trim()) s += ` DEFAULT ${defaultSql(c.default.trim())}`;
  if (c.collate) s += ` COLLATE ${c.collate}`;
  if (c.check?.trim() && (inTable || d.addColumn.check)) s += ` CHECK (${c.check.trim()})`;
  if (c.refTable?.trim() && (inTable || d.addColumn.references)) {
    s += ` REFERENCES ${d.qt(c.refTable.trim())}${c.refColumn?.trim() ? ` (${d.q(c.refColumn.trim())})` : ''}`;
    if (c.onDelete) s += ` ON DELETE ${c.onDelete}`;
  }
  return s;
}

/**
 * DEFAULT value as typed by the user: numbers, quoted strings, NULL, keywords
 * like CURRENT_TIMESTAMP, function calls and parenthesized expressions pass
 * through; bare words become string literals.
 */
export function defaultSql(v: string): string {
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  if (/^N?'.*'$/s.test(v) || /^\(.*\)$/s.test(v) || /^\w+\(.*\)$/s.test(v)) return v;
  if (/^(NULL|TRUE|FALSE|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(v)) return v.toUpperCase();
  return `'${v.replace(/'/g, "''")}'`;
}

export function storageSql(s: StorageSpec | undefined): string {
  if (!s?.using) return '';
  const opts: string[] = [];
  if (s.using === 'memory' && s.persist) opts.push('persist = true');
  if (s.using === 'timeseries') {
    if (!s.timeColumn?.trim()) throw new Error('시계열 테이블은 시간 컬럼을 지정해야 합니다');
    opts.push(`time_column = ${qi(s.timeColumn.trim())}`);
    if (s.timeUnit) opts.push(`time_unit = '${s.timeUnit}'`);
    if (s.retention?.trim()) opts.push(`retention = '${s.retention.trim().replace(/'/g, "''")}'`);
    if (s.blockRows) opts.push(`block_rows = ${Math.floor(s.blockRows)}`);
  }
  return ` USING ${s.using}${opts.length ? ` WITH (${opts.join(', ')})` : ''}`;
}

export interface CreateTableOptions {
  columns?: ColumnInfo[];
  sql?: string;
  storage?: StorageSpec;
  ifNotExists?: boolean;
  /** Table-level UNIQUE (a, b) constraints. */
  uniques?: string[][];
  /** Table-level CHECK expressions. */
  checks?: string[];
}

export function createTableSql(spec: CreateTableSpec & CreateTableOptions, d: Dialect = BANGDB): string {
  if (spec.sql?.trim()) return spec.sql.trim();
  if (!spec.table_name?.trim()) throw new Error('테이블 이름을 입력하세요');
  const cols = (spec.columns ?? []).filter((c) => c.name.trim());
  if (!cols.length) throw new Error('컬럼을 하나 이상 지정하세요');
  const pkCols = cols.filter((c) => c.pk);
  const composite = pkCols.length > 1;
  const defs = cols.map((c) => columnDefSql(c, { pkInline: !composite }, d));
  if (composite) defs.push(`PRIMARY KEY (${pkCols.map((c) => d.q(c.name.trim())).join(', ')})`);
  for (const u of spec.uniques ?? []) if (u.length) defs.push(`UNIQUE (${u.map(d.q).join(', ')})`);
  for (const ch of spec.checks ?? []) if (ch.trim()) defs.push(`CHECK (${ch.trim()})`);
  const ine = spec.ifNotExists && d.id !== 'mssql' ? 'IF NOT EXISTS ' : '';
  return `CREATE TABLE ${ine}${d.qt(spec.table_name.trim())} (\n  ${defs.join(',\n  ')}\n)${d.storage ? storageSql(spec.storage) : ''}`;
}

const execSql = (c: Connection, sql: string, args?: unknown[]) => goQuery(c, sql, args, { mode: 'exec' });

export const createTable = (c: Connection, spec: CreateTableSpec & CreateTableOptions) => execSql(c, createTableSql(spec, dialectOf(c)));
export const dropTable = (c: Connection, table: string) => execSql(c, `DROP TABLE ${dialectOf(c).qt(table)}`);
export const renameTable = (c: Connection, table: string, to: string) => execSql(c, dialectOf(c).renameTable(table, to));
export const addColumnSql = (table: string, col: ColumnInfo, d: Dialect = BANGDB) => `ALTER TABLE ${d.qt(table)} ${d.addColumn.keyword} ${columnDefSql(col, { inTable: false }, d)}`;
export const addColumn = (c: Connection, table: string, col: ColumnInfo) => execSql(c, addColumnSql(table, col, dialectOf(c)));
export const renameColumn = (c: Connection, table: string, from: string, to: string) => execSql(c, dialectOf(c).renameColumn(table, from, to));
export const dropColumn = (c: Connection, table: string, col: string) => { const d = dialectOf(c); return execSql(c, `ALTER TABLE ${d.qt(table)} DROP COLUMN ${d.q(col)}`); };

export const createViewSql = (name: string, select: string, d: Dialect = BANGDB) => `CREATE VIEW ${d.qt(name)} AS ${select.trim().replace(/;\s*$/, '')}`;
export const createView = (c: Connection, name: string, select: string) => execSql(c, createViewSql(name, select, dialectOf(c)));
export const dropView = (c: Connection, name: string) => execSql(c, `DROP VIEW ${dialectOf(c).qt(name)}`);

export function createIndexSql(table: string, columns: string[], opts: { name?: string; unique?: boolean } = {}, d: Dialect = BANGDB): string {
  if (!columns.length) throw new Error('인덱스 컬럼을 하나 이상 선택하세요');
  const base = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  const name = opts.name?.trim() || `idx_${base}_${columns.join('_')}`.replace(/[^\w]/g, '_');
  return `CREATE ${opts.unique ? 'UNIQUE ' : ''}INDEX ${d.q(name)} ON ${d.qt(table)} (${columns.map(d.q).join(', ')})`;
}

export function addIndex(c: Connection, table: string, spec: IndexSpec & { columns?: string[] }) {
  const cols = spec.columns ?? spec.idx_name.split(',').map((s) => s.trim()).filter(Boolean);
  return execSql(c, createIndexSql(table, cols, { name: spec.columns ? spec.idx_name : undefined, unique: spec.allow_duplicate === false }, dialectOf(c)));
}

export const dropIndex = (c: Connection, index: string, table = '') => execSql(c, dialectOf(c).dropIndex(table, index));

// ---------- maintenance ----------

export const vacuum = (c: Connection) => execSql(c, 'VACUUM');
export const analyze = (c: Connection, table?: string) => execSql(c, table ? dialectOf(c).analyzeTable(table) : 'ANALYZE');

// ---------- DML ----------

export async function rowCount(c: Connection, table: string): Promise<ApiResult<{ count?: number }>> {
  const r = await goQuery(c, countSql(table, undefined, dialectOf(c)));
  const n = r.ok ? (goRows(r.data)[0]?.count as number | undefined) : undefined;
  return { ...r, data: { count: n } };
}

export function insertRow(c: Connection, table: string, doc: Record<string, unknown>) {
  const d = dialectOf(c);
  const cols = Object.keys(doc);
  if (!cols.length) throw new Error('값을 하나 이상 입력하세요');
  const sql = `INSERT INTO ${d.qt(table)} (${cols.map(d.q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return goQuery(c, sql, cols.map((k) => sqlValue(doc[k])), { mode: 'exec' });
}

export function updateRow(c: Connection, table: string, doc: Record<string, unknown>, original: Record<string, unknown>, pk: string[]) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블은 행을 수정할 수 없습니다. SQL 콘솔을 사용하세요.');
  const d = dialectOf(c);
  const cols = Object.keys(doc).filter((k) => !pk.includes(k) || doc[k] !== original[k]);
  if (!cols.length) throw new Error('변경된 값이 없습니다');
  const sql = `UPDATE ${d.qt(table)} SET ${cols.map((k) => `${d.q(k)} = ?`).join(', ')} WHERE ${pk.map((k) => `${d.q(k)} = ?`).join(' AND ')}`;
  return goQuery(c, sql, [...cols.map((k) => sqlValue(doc[k])), ...pk.map((k) => sqlValue(original[k]))], { mode: 'exec' });
}

export function deleteRow(c: Connection, table: string, original: Record<string, unknown>, pk: string[]) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블은 행을 삭제할 수 없습니다. SQL 콘솔을 사용하세요.');
  const d = dialectOf(c);
  const sql = `DELETE FROM ${d.qt(table)} WHERE ${pk.map((k) => `${d.q(k)} = ?`).join(' AND ')}`;
  return goQuery(c, sql, pk.map((k) => sqlValue(original[k])), { mode: 'exec' });
}

export function getRow(c: Connection, table: string, pk: string[], key: string) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블입니다');
  const d = dialectOf(c);
  return goQuery(c, `SELECT * FROM ${d.qt(table)} WHERE ${d.q(pk[0])} = ?`, [coerceKey(key)], { limit: 1 });
}

export function deleteByKey(c: Connection, table: string, pk: string[], key: string) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블입니다');
  const d = dialectOf(c);
  return goQuery(c, `DELETE FROM ${d.qt(table)} WHERE ${d.q(pk[0])} = ?`, [coerceKey(key)], { mode: 'exec' });
}

/** A typed key from user input: integers stay numbers, everything else is text. */
export function coerceKey(key: string): unknown {
  return /^-?\d{1,15}$/.test(key.trim()) ? Number(key) : key;
}

/** JSON value → SQL argument: nested objects/arrays are stored as JSON text. */
export function sqlValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && !('blob' in (v as object))) return JSON.stringify(v);
  return v;
}

// ---------- browsing and editing ----------

/**
 * Column alias of the hidden row identifier the grid selects: BangDB and
 * SQLite rowid, PostgreSQL ctid. Tables without one are edited by primary key.
 */
export const ROWID = '__rowid';

export interface PageSpec {
  where?: string;
  orderBy?: string;
  desc?: boolean;
  limit: number;
  offset: number;
}

/** Default ORDER BY for stable paging. */
export function identityOrder(ident: Identity, d: Dialect): string {
  if (!ident) return '';
  if (ident.kind === 'rowid') return ident.expr;
  if (ident.kind === 'ctid') return 'ctid';
  return ident.columns.map(d.q).join(', ');
}

/** One page of a table; `ident` true means BangDB's rowid, false a view. */
export function pageSql(table: string, p: PageSpec, ident: Identity | boolean = true, d: Dialect = BANGDB): string {
  const id: Identity = ident === true ? { kind: 'rowid', expr: 'rowid' } : ident === false ? null : ident;
  const sel = id?.kind === 'rowid' ? `${id.expr} AS ${d.q(ROWID)}, *` : id?.kind === 'ctid' ? `ctid::text AS ${d.q(ROWID)}, *` : '*';
  let s = `SELECT ${sel} FROM ${d.qt(table)}`;
  if (p.where?.trim()) s += ` WHERE ${p.where.trim()}`;
  let order = '';
  if (p.orderBy) order = `${p.orderBy === ROWID ? identityOrder(id, d) || d.q(p.orderBy) : d.q(p.orderBy)}${p.desc ? ' DESC' : ''}`;
  else order = identityOrder(id, d);
  return d.page(s, order, Math.max(1, Math.floor(p.limit)), Math.max(0, Math.floor(p.offset)));
}

export const countSql = (table: string, where?: string, d: Dialect = BANGDB) =>
  `SELECT COUNT(*) AS count FROM ${d.qt(table)}${where?.trim() ? ` WHERE ${where.trim()}` : ''}`;

export async function countWhere(c: Connection, table: string, where?: string): Promise<number | undefined> {
  const r = await goQuery(c, countSql(table, where, dialectOf(c)));
  if (!r.ok) return undefined;
  const v = Object.values(goRows(r.data)[0] ?? {})[0];
  return v === undefined || v === null ? undefined : Number(v);
}

/** Where a changed row is: its rowid / ctid, or its primary key values. */
export type RowRef = { rowid: number | string } | { pk: Record<string, unknown> };

export type RowChange =
  | ({ kind: 'update'; values: Record<string, unknown> } & RowRef)
  | { kind: 'insert'; values: Record<string, unknown> }
  | ({ kind: 'delete' } & RowRef);

function whereOf(ref: RowRef, ident: Identity, d: Dialect): { sql: string; args: unknown[] } {
  if ('pk' in ref) {
    const cols = Object.keys(ref.pk);
    return { sql: cols.map((k) => `${d.q(k)} = ?`).join(' AND '), args: cols.map((k) => sqlValue(ref.pk[k])) };
  }
  if (ident?.kind === 'ctid') return { sql: 'ctid = ?::tid', args: [ref.rowid] };
  return { sql: `${ident?.kind === 'rowid' ? ident.expr : 'rowid'} = ?`, args: [ref.rowid] };
}

/** Grid edits as parameterized statements (`?`), in order: the caller runs them in one transaction. */
export function changeStatements(table: string, changes: RowChange[], d: Dialect = BANGDB, ident: Identity = { kind: 'rowid', expr: 'rowid' }): Stmt[] {
  const T = d.qt(table);
  const out: Stmt[] = [];
  for (const ch of changes) {
    if (ch.kind === 'delete') {
      const w = whereOf(ch, ident, d);
      out.push({ sql: `DELETE FROM ${T} WHERE ${w.sql}`, args: w.args });
    } else if (ch.kind === 'update') {
      const cols = Object.keys(ch.values);
      if (!cols.length) continue;
      const w = whereOf(ch, ident, d);
      out.push({ sql: `UPDATE ${T} SET ${cols.map((k) => `${d.q(k)} = ?`).join(', ')} WHERE ${w.sql}`, args: [...cols.map((k) => sqlValue(ch.values[k])), ...w.args] });
    } else {
      const cols = Object.keys(ch.values);
      if (!cols.length) throw new Error('새 행에 값을 하나 이상 입력하세요');
      out.push({ sql: `INSERT INTO ${T} (${cols.map(d.q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, args: cols.map((k) => sqlValue(ch.values[k])) });
    }
  }
  if (!out.length) throw new Error('저장할 변경 사항이 없습니다');
  return out;
}

/** BangDB: grid edits as one transactional script with ?N parameters. */
export function changeScript(table: string, changes: RowChange[]): { sql: string; args: unknown[] } {
  return toScript(changeStatements(table, changes));
}

export function applyChanges(c: Connection, table: string, changes: RowChange[], ident?: Identity) {
  return execStatements(c, changeStatements(table, changes, dialectOf(c), ident ?? { kind: 'rowid', expr: 'rowid' }));
}

// ---------- typed values ----------

export type Affinity = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'ANY';

/** Storage class of a column, as the engine derives it from the declared type. */
export function affinity(col: ColumnInfo | undefined): Affinity {
  const t = (col?.type ?? '').toUpperCase();
  if (t === 'INTEGER' || t === 'REAL' || t === 'TEXT' || t === 'BLOB') return t;
  const d = (col?.decl ?? '').toUpperCase();
  if (!d) return 'ANY';
  if (/INT|BOOL|^BIT$/.test(d)) return 'INTEGER';
  if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL|MONEY/.test(d)) return 'REAL';
  if (/BLOB|BINARY|BYTEA|IMAGE/.test(d)) return 'BLOB';
  return 'TEXT';
}

export const isBoolColumn = (col: ColumnInfo | undefined) => /BOOL|^BIT$/i.test(col?.decl ?? '');
export const isJsonColumn = (col: ColumnInfo | undefined) => /JSON/i.test(col?.decl ?? '');
export const isBlob = (v: unknown): v is { blob: string } => !!v && typeof v === 'object' && typeof (v as { blob?: unknown }).blob === 'string';

/** Text typed into an editor → value for the column; throws on a bad number. */
export function parseInput(text: string, col: ColumnInfo | undefined): unknown {
  const a = affinity(col);
  const t = text.trim();
  if (a === 'INTEGER') {
    if (!t) return null;
    if (!/^[-+]?\d+$/.test(t)) throw new Error(`${col?.name ?? '값'}: 정수가 아닙니다`);
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : t;
  }
  if (a === 'REAL') {
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`${col?.name ?? '값'}: 숫자가 아닙니다`);
    return n;
  }
  if (a === 'ANY' && /^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  return text;
}

/** Value → text for an editor input. */
export function editText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (isBlob(v)) return v.blob;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---------- dump and import ----------

/** SQL literal for dumps (BangDB). */
export const dumpLiteral = (v: unknown) => BANGDB.literal(v);

/** Tables ordered so that a table comes after the tables its foreign keys name. */
export function orderByDependencies(tables: GoTableInfo[]): GoTableInfo[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const out: GoTableInfo[] = [];
  const seen = new Set<string>();
  const visit = (t: GoTableInfo, stack: Set<string>) => {
    const k = t.name.toLowerCase();
    if (seen.has(k) || stack.has(k)) return;
    stack.add(k);
    for (const m of (t.sql ?? '').matchAll(/REFERENCES\s+((?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\.(?:"(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|\w+))?)/gi)) {
      const parts = m[1].split('.').map((p) => p.replace(/^["`[]|["`\]]$/g, '').replace(/""/g, '"'));
      const dep = byName.get(parts.join('.').toLowerCase()) ?? byName.get(parts[parts.length - 1].toLowerCase());
      if (dep && dep !== t) visit(dep, stack);
    }
    stack.delete(k);
    seen.add(k);
    out.push(t);
  };
  tables.forEach((t) => visit(t, new Set()));
  return out;
}

/** Read a whole table page by page (servers cap one answer). */
export async function readAll(c: Connection, table: string, onPage?: (n: number) => void, pageSize = 500, where?: string, orderBy?: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const d = dialectOf(c);
  let columns: string[] = [];
  const rows: unknown[][] = [];
  const base = `SELECT * FROM ${d.qt(table)}${where?.trim() ? ` WHERE ${where.trim()}` : ''}`;
  const order = orderBy ?? (d.id === 'bangdb' ? 'rowid' : '');
  for (let offset = 0; ; offset += pageSize) {
    const r = await goQuery(c, d.page(base, order, pageSize, offset), undefined, { limit: pageSize });
    if (!r.ok) throw new Error(`${table}: ${errorText(r)}`);
    columns = r.data.columns;
    rows.push(...r.data.rows);
    onPage?.(rows.length);
    if (r.data.rows.length < pageSize) break;
  }
  return { columns, rows };
}

/** SQL script with the schema and data of every table (or `only`), then the views. */
export async function dumpSql(c: Connection, onProgress?: (msg: string) => void, only?: string[]): Promise<string> {
  const d = dialectOf(c);
  const r = await goTables(c);
  if (!r.ok) throw new Error(errorText(r));
  const all = r.data.tables.filter((t) => !only || only.includes(t.name));
  const tables = orderByDependencies(all.filter((t) => t.kind === 'table'));
  const out: string[] = [`-- ${d.label} dump ${new Date().toISOString()}`, ''];
  for (const t of tables) {
    onProgress?.(`${t.name} 읽는 중…`);
    out.push(`-- ${t.name}`, endStmt(t.sql ?? ''));
    const ident = d.id === 'bangdb' || t.rowid === 'rowid' ? 'rowid' : primaryKeyColumns(t).map(d.q).join(', ');
    const { columns, rows } = await readAll(c, t.name, (n) => onProgress?.(`${t.name}: ${n}행`), 500, undefined, ident);
    const wrap = d.dumpIdentity?.(t.name, t.columns ?? []) ?? { before: [], after: [] };
    if (rows.length) out.push(...wrap.before.map(endStmt));
    const head = `INSERT INTO ${d.qt(t.name)} (${columns.map(d.q).join(', ')}) VALUES`;
    for (let i = 0; i < rows.length; i += 100) {
      out.push(`${head}\n  ${rows.slice(i, i + 100).map((row) => `(${row.map(d.literal).join(', ')})`).join(',\n  ')};`);
    }
    if (rows.length) out.push(...wrap.after.map(endStmt));
    out.push('');
  }
  for (const v of all.filter((t) => t.kind === 'view')) out.push(`-- view ${v.name}`, endStmt(v.sql ?? ''), '');
  return out.join('\n');
}

const endStmt = (s: string) => (s.trim().endsWith(';') ? s.trim() : `${s.trim()};`);

/** Split a script at top-level semicolons, honouring quotes, comments and $$ bodies. */
export function splitSql(script: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (script[j] === ch) {
          if (script[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += script.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '$' && /^\$(?:[A-Za-z_]\w*)?\$/.test(script.slice(i, i + 64))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(script.slice(i, i + 64))![0];
      const end = script.indexOf(tag, i + tag.length);
      const e = end < 0 ? n : end + tag.length;
      cur += script.slice(i, e);
      i = e;
    } else if (ch === '-' && next === '-') {
      const j = script.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
      cur += '\n';
    } else if (ch === '/' && next === '*') {
      const j = script.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      cur += ' ';
    } else if (ch === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Statements an import skips: SQLite dump boilerplate and transaction control. */
const SKIP = /^(PRAGMA\s+foreign_keys|BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION)\b/i;
const SKIP_BANGDB = /^(PRAGMA|BEGIN|COMMIT|END|ROLLBACK|START\s+TRANSACTION)\b/i;

export interface ScriptProgress { done: number; total: number; error?: string; failedSql?: string }

/**
 * Run a script (e.g. a dump) in chunks small enough for one request, each
 * chunk in its own transaction. Stops at the first failing chunk.
 * SQL Server's SET IDENTITY_INSERT … ON/OFF pairs stay in one chunk.
 */
export async function runScript(c: Connection, script: string, onProgress?: (p: ScriptProgress) => void, chunkBytes = 256 * 1024, shouldStop?: () => boolean): Promise<ScriptProgress> {
  const stmts = splitSql(script).filter((s) => !(c.db ? SKIP : SKIP_BANGDB).test(s));
  const p: ScriptProgress = { done: 0, total: stmts.length };
  let i = 0;
  while (i < stmts.length) {
    if (shouldStop?.()) break;
    const chunk: string[] = [];
    let size = 0;
    let identity = false;
    while (i < stmts.length && (chunk.length === 0 || identity || size + stmts[i].length < chunkBytes)) {
      if (/^SET\s+IDENTITY_INSERT\b[\s\S]*\bON$/i.test(stmts[i])) identity = true;
      if (/^SET\s+IDENTITY_INSERT\b[\s\S]*\bOFF$/i.test(stmts[i])) identity = false;
      size += stmts[i].length + 2;
      chunk.push(stmts[i++]);
    }
    const r = c.db ? await execStatements(c, chunk) : await goQuery(c, `BEGIN;\n${chunk.join(';\n')};\nCOMMIT;`, undefined, { mode: 'exec' });
    if (!r.ok) {
      const at = (r.data as { statement?: number } | null)?.statement;
      p.error = errorText(r);
      p.failedSql = at !== undefined && chunk[at] ? chunk[at].slice(0, 500) : chunk.length === 1 ? chunk[0] : `${chunk[0].slice(0, 200)} … (문장 ${chunk.length}개 묶음)`;
      onProgress?.({ ...p });
      return p;
    }
    p.done += chunk.length;
    onProgress?.({ ...p });
  }
  return p;
}

export type InsertMode = 'insert' | 'ignore' | 'replace';

/** Duplicate handling each dialect supports for bulk inserts. */
export const insertModes = (d: Dialect): InsertMode[] =>
  d.id === 'mssql' ? ['insert'] : d.id === 'postgres' ? ['insert', 'ignore'] : ['insert', 'ignore', 'replace'];

export function insertBatchSql(table: string, cols: string[], rows: unknown[][], mode: InsertMode = 'insert', d: Dialect = BANGDB): { sql: string; args: unknown[] } {
  if (!insertModes(d).includes(mode)) throw new Error(`${d.label} 는 이 중복 처리 방식을 지원하지 않습니다`);
  const verb = mode === 'insert' ? 'INSERT'
    : d.id === 'mysql' ? (mode === 'ignore' ? 'INSERT IGNORE' : 'REPLACE')
    : d.id === 'postgres' ? 'INSERT'
    : mode === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
  const tuple = `(${cols.map(() => '?').join(', ')})`;
  return {
    sql: `${verb} INTO ${d.qt(table)} (${cols.map(d.q).join(', ')}) VALUES ${rows.map(() => tuple).join(', ')}${d.id === 'postgres' && mode === 'ignore' ? ' ON CONFLICT DO NOTHING' : ''}`,
    args: rows.flatMap((r) => r.map(sqlValue))
  };
}

export interface BulkProgress { done: number; total: number; inserted: number; error?: string }

/** Insert documents with multi-row INSERTs, `batch` rows per request (each atomic). */
export async function bulkInsert(c: Connection, table: string, docs: Record<string, unknown>[], opts: { mode?: InsertMode; batch?: number; onProgress?: (p: BulkProgress) => void; shouldStop?: () => boolean } = {}): Promise<BulkProgress> {
  const d = dialectOf(c);
  const cols: string[] = [];
  docs.forEach((doc) => Object.keys(doc).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const p: BulkProgress = { done: 0, total: docs.length, inserted: 0 };
  if (!cols.length) return { ...p, error: '컬럼이 없습니다' };
  // SQL Server takes at most 2100 parameters and 1000 rows per VALUES
  const batch = Math.max(1, Math.min(opts.batch ?? 200, d.id === 'mssql' ? Math.floor(2000 / cols.length) : 1000));
  for (let i = 0; i < docs.length; i += batch) {
    if (opts.shouldStop?.()) break;
    const part = docs.slice(i, i + batch);
    const { sql, args } = insertBatchSql(table, cols, part.map((doc) => cols.map((k) => (k in doc ? doc[k] : null))), opts.mode, d);
    const r = await goQuery(c, sql, args, { mode: 'exec' });
    if (!r.ok) {
      p.error = `${i + 1}~${i + part.length}번째 행: ${errorText(r)}`;
      opts.onProgress?.({ ...p });
      return p;
    }
    p.done += part.length;
    p.inserted += r.data.rows_affected ?? part.length;
    opts.onProgress?.({ ...p });
  }
  return p;
}

/** Error message of a failed answer ({"error","code"}). */
export function errorText(r: ApiResult): string {
  if (r.error) return r.error;
  const d = r.data as { error?: string; code?: string } | null;
  if (d && typeof d === 'object' && d.error) return d.error.replace(/^bangdb: /, '');
  return `HTTP ${r.status} ${r.text.slice(0, 160)}`.trim();
}
