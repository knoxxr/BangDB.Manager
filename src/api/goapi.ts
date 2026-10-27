/**
 * Adapter for knoxxr/bangdb's JSON HTTP API (`bangdb -http :18081`).
 * Everything is SQL; schema comes from /v1/tables.
 */
import type { ApiResult, ColumnInfo, Connection, CreateTableSpec, GoQueryResponse, GoTableInfo, IndexSpec, StorageSpec } from './types';
import { call } from './bangdb';

/** Quote an identifier for SQL. */
export const qi = (name: string) => `"${String(name).replace(/"/g, '""')}"`;

/** Literal for a JS value in SQL (used only for display; data goes through args). */
export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export const goQuery = (c: Connection, sql: string, args?: unknown[] | Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  call<GoQueryResponse>(c, 'goQuery', { body: { sql, args, ...extra } });

export const goTables = (c: Connection) => call<{ tables: GoTableInfo[]; count: number }>(c, 'goTables');
export const goTable = (c: Connection, table: string) => call<GoTableInfo>(c, 'goTable', { params: { table } });
export const goStats = (c: Connection) => call(c, 'goStats');
export const goHealth = (c: Connection) => call<{ ok: boolean; version: string }>(c, 'goHealth');

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
 * One column definition. `inTable` false is for ALTER TABLE ADD COLUMN, where
 * the engine refuses PRIMARY KEY/UNIQUE/CHECK/REFERENCES, so they are left out.
 * `pkInline` false leaves PRIMARY KEY to a table constraint (composite keys).
 */
export function columnDefSql(c: ColumnInfo, opts: { inTable?: boolean; pkInline?: boolean } = {}): string {
  const inTable = opts.inTable ?? true;
  const pkInline = opts.pkInline ?? true;
  const type = (c.decl ?? c.type ?? '').trim();
  let d = qi(c.name.trim()) + (type && type.toUpperCase() !== 'ANY' ? ` ${type}` : '');
  if (inTable && c.pk && pkInline) {
    d += ' PRIMARY KEY';
    if (c.autoinc) d += ' AUTOINCREMENT';
  }
  if (c.notNull && !(c.pk && pkInline && inTable)) d += ' NOT NULL';
  if (inTable && c.unique && !c.pk) d += ' UNIQUE';
  if (c.default?.trim()) d += ` DEFAULT ${defaultSql(c.default.trim())}`;
  if (c.collate) d += ` COLLATE ${c.collate}`;
  if (inTable && c.check?.trim()) d += ` CHECK (${c.check.trim()})`;
  if (inTable && c.refTable?.trim()) {
    d += ` REFERENCES ${qi(c.refTable.trim())}${c.refColumn?.trim() ? ` (${qi(c.refColumn.trim())})` : ''}`;
    if (c.onDelete) d += ` ON DELETE ${c.onDelete}`;
  }
  return d;
}

/**
 * DEFAULT value as typed by the user: numbers, quoted strings, NULL, keywords
 * like CURRENT_TIMESTAMP and parenthesized expressions pass through; bare
 * words become string literals.
 */
export function defaultSql(v: string): string {
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return v;
  if (/^'.*'$/s.test(v) || /^\(.*\)$/s.test(v)) return v;
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

export function createTableSql(spec: CreateTableSpec & CreateTableOptions): string {
  if (spec.sql?.trim()) return spec.sql.trim();
  if (!spec.table_name?.trim()) throw new Error('테이블 이름을 입력하세요');
  const cols = (spec.columns ?? []).filter((c) => c.name.trim());
  if (!cols.length) throw new Error('컬럼을 하나 이상 지정하세요');
  const pkCols = cols.filter((c) => c.pk);
  const composite = pkCols.length > 1;
  const defs = cols.map((c) => columnDefSql(c, { pkInline: !composite }));
  if (composite) defs.push(`PRIMARY KEY (${pkCols.map((c) => qi(c.name.trim())).join(', ')})`);
  for (const u of spec.uniques ?? []) if (u.length) defs.push(`UNIQUE (${u.map(qi).join(', ')})`);
  for (const ch of spec.checks ?? []) if (ch.trim()) defs.push(`CHECK (${ch.trim()})`);
  return `CREATE TABLE ${spec.ifNotExists ? 'IF NOT EXISTS ' : ''}${qi(spec.table_name.trim())} (\n  ${defs.join(',\n  ')}\n)${storageSql(spec.storage)}`;
}

const execSql = (c: Connection, sql: string, args?: unknown[]) => goQuery(c, sql, args, { mode: 'exec' });

export const createTable = (c: Connection, spec: CreateTableSpec & CreateTableOptions) => execSql(c, createTableSql(spec));
export const dropTable = (c: Connection, table: string) => execSql(c, `DROP TABLE ${qi(table)}`);
export const renameTable = (c: Connection, table: string, to: string) => execSql(c, `ALTER TABLE ${qi(table)} RENAME TO ${qi(to)}`);
export const addColumnSql = (table: string, col: ColumnInfo) => `ALTER TABLE ${qi(table)} ADD COLUMN ${columnDefSql(col, { inTable: false })}`;
export const addColumn = (c: Connection, table: string, col: ColumnInfo) => execSql(c, addColumnSql(table, col));
export const renameColumn = (c: Connection, table: string, from: string, to: string) =>
  execSql(c, `ALTER TABLE ${qi(table)} RENAME COLUMN ${qi(from)} TO ${qi(to)}`);
export const dropColumn = (c: Connection, table: string, col: string) => execSql(c, `ALTER TABLE ${qi(table)} DROP COLUMN ${qi(col)}`);

export const createViewSql = (name: string, select: string) => `CREATE VIEW ${qi(name)} AS ${select.trim().replace(/;\s*$/, '')}`;
export const createView = (c: Connection, name: string, select: string) => execSql(c, createViewSql(name, select));
export const dropView = (c: Connection, name: string) => execSql(c, `DROP VIEW ${qi(name)}`);

export function createIndexSql(table: string, columns: string[], opts: { name?: string; unique?: boolean } = {}): string {
  if (!columns.length) throw new Error('인덱스 컬럼을 하나 이상 선택하세요');
  const name = opts.name?.trim() || `idx_${table}_${columns.join('_')}`.replace(/[^\w]/g, '_');
  return `CREATE ${opts.unique ? 'UNIQUE ' : ''}INDEX ${qi(name)} ON ${qi(table)} (${columns.map(qi).join(', ')})`;
}

export function addIndex(c: Connection, table: string, spec: IndexSpec & { columns?: string[] }) {
  const cols = spec.columns ?? spec.idx_name.split(',').map((s) => s.trim()).filter(Boolean);
  return execSql(c, createIndexSql(table, cols, { name: spec.columns ? spec.idx_name : undefined, unique: spec.allow_duplicate === false }));
}

export const dropIndex = (c: Connection, index: string) => execSql(c, `DROP INDEX ${qi(index)}`);

// ---------- maintenance ----------

export const vacuum = (c: Connection) => execSql(c, 'VACUUM');
export const analyze = (c: Connection, table?: string) => execSql(c, table ? `ANALYZE ${qi(table)}` : 'ANALYZE');

// ---------- DML ----------

export async function rowCount(c: Connection, table: string): Promise<ApiResult<{ count?: number }>> {
  const r = await goQuery(c, `SELECT COUNT(*) AS count FROM ${qi(table)}`);
  const n = r.ok ? (goRows(r.data)[0]?.count as number | undefined) : undefined;
  return { ...r, data: { count: n } };
}

export function insertRow(c: Connection, table: string, doc: Record<string, unknown>) {
  const cols = Object.keys(doc);
  if (!cols.length) throw new Error('값을 하나 이상 입력하세요');
  const sql = `INSERT INTO ${qi(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return goQuery(c, sql, cols.map((k) => sqlValue(doc[k])), { mode: 'exec' });
}

export function updateRow(c: Connection, table: string, doc: Record<string, unknown>, original: Record<string, unknown>, pk: string[]) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블은 행을 수정할 수 없습니다. SQL 콘솔을 사용하세요.');
  const cols = Object.keys(doc).filter((k) => !pk.includes(k) || doc[k] !== original[k]);
  if (!cols.length) throw new Error('변경된 값이 없습니다');
  const sql = `UPDATE ${qi(table)} SET ${cols.map((k) => `${qi(k)} = ?`).join(', ')} WHERE ${pk.map((k) => `${qi(k)} = ?`).join(' AND ')}`;
  return goQuery(c, sql, [...cols.map((k) => sqlValue(doc[k])), ...pk.map((k) => sqlValue(original[k]))], { mode: 'exec' });
}

export function deleteRow(c: Connection, table: string, original: Record<string, unknown>, pk: string[]) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블은 행을 삭제할 수 없습니다. SQL 콘솔을 사용하세요.');
  const sql = `DELETE FROM ${qi(table)} WHERE ${pk.map((k) => `${qi(k)} = ?`).join(' AND ')}`;
  return goQuery(c, sql, pk.map((k) => sqlValue(original[k])), { mode: 'exec' });
}

export function getRow(c: Connection, table: string, pk: string[], key: string) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블입니다');
  return goQuery(c, `SELECT * FROM ${qi(table)} WHERE ${qi(pk[0])} = ?`, [coerceKey(key)], { limit: 1 });
}

export function deleteByKey(c: Connection, table: string, pk: string[], key: string) {
  if (!pk.length) throw new Error('기본 키가 없는 테이블입니다');
  return goQuery(c, `DELETE FROM ${qi(table)} WHERE ${qi(pk[0])} = ?`, [coerceKey(key)], { mode: 'exec' });
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
 * Every knoxxr/bangdb table (B+tree, memory, timeseries) has a hidden rowid,
 * so the grid edits and deletes rows by rowid: tables without a primary key,
 * composite keys and changed key values all work the same way.
 */
export const ROWID = '__rowid';

export interface PageSpec {
  where?: string;
  orderBy?: string;
  desc?: boolean;
  limit: number;
  offset: number;
}

export function pageSql(table: string, p: PageSpec, withRowid = true): string {
  let s = `SELECT ${withRowid ? `rowid AS ${qi(ROWID)}, ` : ''}* FROM ${qi(table)}`;
  if (p.where?.trim()) s += ` WHERE ${p.where.trim()}`;
  if (p.orderBy) s += ` ORDER BY ${p.orderBy === ROWID ? 'rowid' : qi(p.orderBy)}${p.desc ? ' DESC' : ''}`;
  else if (withRowid) s += ' ORDER BY rowid';
  return `${s} LIMIT ${Math.max(1, Math.floor(p.limit))} OFFSET ${Math.max(0, Math.floor(p.offset))}`;
}

export const countSql = (table: string, where?: string) =>
  `SELECT COUNT(*) AS count FROM ${qi(table)}${where?.trim() ? ` WHERE ${where.trim()}` : ''}`;

export async function countWhere(c: Connection, table: string, where?: string): Promise<number | undefined> {
  const r = await goQuery(c, countSql(table, where));
  return r.ok ? (goRows(r.data)[0]?.count as number | undefined) : undefined;
}

export type RowChange =
  | { kind: 'update'; rowid: number; values: Record<string, unknown> }
  | { kind: 'insert'; values: Record<string, unknown> }
  | { kind: 'delete'; rowid: number };

/** One transactional script for a set of grid edits, with ?N parameters. */
export function changeScript(table: string, changes: RowChange[]): { sql: string; args: unknown[] } {
  const args: unknown[] = [];
  const p = (v: unknown) => { args.push(sqlValue(v)); return `?${args.length}`; };
  const stmts: string[] = [];
  for (const ch of changes) {
    if (ch.kind === 'delete') {
      stmts.push(`DELETE FROM ${qi(table)} WHERE rowid = ${p(ch.rowid)}`);
    } else if (ch.kind === 'update') {
      const cols = Object.keys(ch.values);
      if (!cols.length) continue;
      stmts.push(`UPDATE ${qi(table)} SET ${cols.map((k) => `${qi(k)} = ${p(ch.values[k])}`).join(', ')} WHERE rowid = ${p(ch.rowid)}`);
    } else {
      const cols = Object.keys(ch.values);
      if (!cols.length) throw new Error('새 행에 값을 하나 이상 입력하세요');
      stmts.push(`INSERT INTO ${qi(table)} (${cols.map(qi).join(', ')}) VALUES (${cols.map((k) => p(ch.values[k])).join(', ')})`);
    }
  }
  if (!stmts.length) throw new Error('저장할 변경 사항이 없습니다');
  return { sql: `BEGIN;\n${stmts.join(';\n')};\nCOMMIT;`, args };
}

export function applyChanges(c: Connection, table: string, changes: RowChange[]) {
  const { sql, args } = changeScript(table, changes);
  return goQuery(c, sql, args, { mode: 'exec' });
}

// ---------- typed values ----------

export type Affinity = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'ANY';

/** Storage class of a column, as the engine derives it from the declared type. */
export function affinity(col: ColumnInfo | undefined): Affinity {
  const t = (col?.type ?? '').toUpperCase();
  if (t === 'INTEGER' || t === 'REAL' || t === 'TEXT' || t === 'BLOB') return t;
  const d = (col?.decl ?? '').toUpperCase();
  if (!d) return 'ANY';
  if (/INT|BOOL/.test(d)) return 'INTEGER';
  if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(d)) return 'REAL';
  if (/BLOB|BINARY|BYTEA/.test(d)) return 'BLOB';
  return 'TEXT';
}

export const isBoolColumn = (col: ColumnInfo | undefined) => /BOOL/i.test(col?.decl ?? '');
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

const toHex = (b64: string) => {
  const bin = atob(b64);
  let s = '';
  for (let i = 0; i < bin.length; i++) s += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return s;
};

/** SQL literal for dumps: like `literal`, with BLOBs as X'..'. */
export function dumpLiteral(v: unknown): string {
  if (isBlob(v)) return `X'${toHex(v.blob)}'`;
  return literal(v);
}

/** Tables ordered so that a table comes after the tables its foreign keys name. */
export function orderByDependencies(tables: GoTableInfo[]): GoTableInfo[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const out: GoTableInfo[] = [];
  const seen = new Set<string>();
  const visit = (t: GoTableInfo, stack: Set<string>) => {
    const k = t.name.toLowerCase();
    if (seen.has(k) || stack.has(k)) return;
    stack.add(k);
    for (const m of (t.sql ?? '').matchAll(/REFERENCES\s+("(?:[^"]|"")+"|\w+)/gi)) {
      const ref = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
      const dep = byName.get(ref.toLowerCase());
      if (dep && dep !== t) visit(dep, stack);
    }
    stack.delete(k);
    seen.add(k);
    out.push(t);
  };
  tables.forEach((t) => visit(t, new Set()));
  return out;
}

/** Read a whole table page by page (the server caps one answer at MaxRows). */
export async function readAll(c: Connection, table: string, onPage?: (n: number) => void, pageSize = 500, where?: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  let columns: string[] = [];
  const rows: unknown[][] = [];
  const cond = where?.trim() ? ` WHERE ${where.trim()}` : '';
  for (let offset = 0; ; offset += pageSize) {
    const r = await goQuery(c, `SELECT * FROM ${qi(table)}${cond} ORDER BY rowid LIMIT ${pageSize} OFFSET ${offset}`);
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
  const r = await goTables(c);
  if (!r.ok) throw new Error(errorText(r));
  const all = r.data.tables.filter((t) => !only || only.includes(t.name));
  const tables = orderByDependencies(all.filter((t) => t.kind === 'table'));
  const out: string[] = [`-- BangDB dump ${new Date().toISOString()}`, ''];
  for (const t of tables) {
    onProgress?.(`${t.name} 읽는 중…`);
    out.push(`-- ${t.name}`, endStmt(t.sql ?? ''));
    const { columns, rows } = await readAll(c, t.name, (n) => onProgress?.(`${t.name}: ${n}행`));
    const head = `INSERT INTO ${qi(t.name)} (${columns.map(qi).join(', ')}) VALUES`;
    for (let i = 0; i < rows.length; i += 100) {
      out.push(`${head}\n  ${rows.slice(i, i + 100).map((row) => `(${row.map(dumpLiteral).join(', ')})`).join(',\n  ')};`);
    }
    out.push('');
  }
  for (const v of all.filter((t) => t.kind === 'view')) out.push(`-- view ${v.name}`, endStmt(v.sql ?? ''), '');
  return out.join('\n');
}

const endStmt = (s: string) => (s.trim().endsWith(';') ? s.trim() : `${s.trim()};`);

/** Split a script at top-level semicolons, honouring quotes and comments. */
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
const SKIP = /^(PRAGMA|BEGIN|COMMIT|END|ROLLBACK)\b/i;

export interface ScriptProgress { done: number; total: number; error?: string; failedSql?: string }

/**
 * Run a script (e.g. a dump) in chunks small enough for the API's body limit,
 * each chunk in its own transaction. Stops at the first failing chunk.
 */
export async function runScript(c: Connection, script: string, onProgress?: (p: ScriptProgress) => void, chunkBytes = 256 * 1024, shouldStop?: () => boolean): Promise<ScriptProgress> {
  const stmts = splitSql(script).filter((s) => !SKIP.test(s));
  const p: ScriptProgress = { done: 0, total: stmts.length };
  let i = 0;
  while (i < stmts.length) {
    if (shouldStop?.()) break;
    const chunk: string[] = [];
    let size = 0;
    while (i < stmts.length && (chunk.length === 0 || size + stmts[i].length < chunkBytes)) {
      size += stmts[i].length + 2;
      chunk.push(stmts[i++]);
    }
    const r = await goQuery(c, `BEGIN;\n${chunk.join(';\n')};\nCOMMIT;`, undefined, { mode: 'exec' });
    if (!r.ok) {
      p.error = errorText(r);
      p.failedSql = chunk.length === 1 ? chunk[0] : `${chunk[0].slice(0, 200)} … (문장 ${chunk.length}개 묶음)`;
      onProgress?.({ ...p });
      return p;
    }
    p.done += chunk.length;
    onProgress?.({ ...p });
  }
  return p;
}

export type InsertMode = 'insert' | 'ignore' | 'replace';

export function insertBatchSql(table: string, cols: string[], rows: unknown[][], mode: InsertMode = 'insert'): { sql: string; args: unknown[] } {
  const verb = mode === 'ignore' ? 'INSERT OR IGNORE' : mode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT';
  const tuple = `(${cols.map(() => '?').join(', ')})`;
  return {
    sql: `${verb} INTO ${qi(table)} (${cols.map(qi).join(', ')}) VALUES ${rows.map(() => tuple).join(', ')}`,
    args: rows.flatMap((r) => r.map(sqlValue))
  };
}

export interface BulkProgress { done: number; total: number; inserted: number; error?: string }

/** Insert documents with multi-row INSERTs, `batch` rows per request (each atomic). */
export async function bulkInsert(c: Connection, table: string, docs: Record<string, unknown>[], opts: { mode?: InsertMode; batch?: number; onProgress?: (p: BulkProgress) => void; shouldStop?: () => boolean } = {}): Promise<BulkProgress> {
  const cols: string[] = [];
  docs.forEach((d) => Object.keys(d).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
  const p: BulkProgress = { done: 0, total: docs.length, inserted: 0 };
  if (!cols.length) return { ...p, error: '컬럼이 없습니다' };
  const batch = Math.max(1, opts.batch ?? 200);
  for (let i = 0; i < docs.length; i += batch) {
    if (opts.shouldStop?.()) break;
    const part = docs.slice(i, i + batch);
    const { sql, args } = insertBatchSql(table, cols, part.map((d) => cols.map((k) => (k in d ? d[k] : null))), opts.mode);
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

/** Error message of a failed /v1/query answer ({"error","code"}). */
export function errorText(r: ApiResult): string {
  if (r.error) return r.error;
  const d = r.data as { error?: string; code?: string } | null;
  if (d && typeof d === 'object' && d.error) return d.error.replace(/^bangdb: /, '');
  return `HTTP ${r.status} ${r.text.slice(0, 160)}`.trim();
}
