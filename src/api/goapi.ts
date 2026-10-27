/**
 * Adapter for knoxxr/bangdb's JSON HTTP API (`bangdb -http :18081`).
 * Everything is SQL; schema comes from /v1/tables.
 */
import type { ApiResult, ColumnInfo, Connection, CreateTableSpec, GoQueryResponse, GoTableInfo, IndexSpec } from './types';
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

export function createTableSql(spec: CreateTableSpec & { columns?: ColumnInfo[]; sql?: string }): string {
  if (spec.sql?.trim()) return spec.sql.trim();
  const cols = (spec.columns ?? []).filter((c) => c.name.trim());
  if (!cols.length) throw new Error('컬럼을 하나 이상 지정하세요');
  const defs = cols.map((c) => {
    let d = `${qi(c.name.trim())} ${c.decl || c.type || 'TEXT'}`;
    if (c.pk) d += ' PRIMARY KEY';
    if (c.autoinc) d += ' AUTOINCREMENT';
    if (c.notNull && !c.pk) d += ' NOT NULL';
    if (c.unique && !c.pk) d += ' UNIQUE';
    if (c.default) d += ` DEFAULT ${c.default}`;
    return d;
  });
  return `CREATE TABLE ${qi(spec.table_name)} (\n  ${defs.join(',\n  ')}\n)`;
}

export const createTable = (c: Connection, spec: CreateTableSpec & { columns?: ColumnInfo[]; sql?: string }) =>
  goQuery(c, createTableSql(spec), undefined, { mode: 'exec' });

export const dropTable = (c: Connection, table: string) => goQuery(c, `DROP TABLE ${qi(table)}`, undefined, { mode: 'exec' });

export function addIndex(c: Connection, table: string, spec: IndexSpec) {
  const cols = spec.idx_name.split(',').map((s) => s.trim()).filter(Boolean);
  const name = `idx_${table}_${cols.join('_')}`.replace(/[^\w]/g, '_');
  const sql = `CREATE ${spec.allow_duplicate === false ? 'UNIQUE ' : ''}INDEX ${qi(name)} ON ${qi(table)} (${cols.map(qi).join(', ')})`;
  return goQuery(c, sql, undefined, { mode: 'exec' });
}

export const dropIndex = (c: Connection, index: string) => goQuery(c, `DROP INDEX ${qi(index)}`, undefined, { mode: 'exec' });

// ---------- DML ----------

export async function rowCount(c: Connection, table: string): Promise<ApiResult<{ count?: number }>> {
  const r = await goQuery(c, `SELECT COUNT(*) AS count FROM ${qi(table)}`);
  const n = r.ok ? (goRows(r.data)[0]?.count as number | undefined) : undefined;
  return { ...r, data: { count: n } };
}

export function insertRow(c: Connection, table: string, doc: Record<string, unknown>) {
  const cols = Object.keys(doc);
  if (!cols.length) return goQuery(c, `INSERT INTO ${qi(table)} DEFAULT VALUES`, undefined, { mode: 'exec' });
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
