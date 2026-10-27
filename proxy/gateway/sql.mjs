// SQL adapters. Each answers in the shape of BangDB's JSON HTTP API so the
// app's grid, structure and console pages work unchanged:
//   query  -> { columns, types, rows: [[...]], rows_affected, last_insert_id, truncated }
//   tables -> [{ name, kind, columns, indexes, primaryKey, sql, rowid? }]
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { bindParams, decodeArg, encodeValue, returnsRows, splitStatements } from './params.mjs';

const encodeRow = (r) => r.map(encodeValue);

/** Storage class of a native column type, for the app's typed editors. */
export function affinityOf(decl) {
  const d = String(decl ?? '').toLowerCase();
  if (!d) return 'ANY';
  if (/bool|^bit$/.test(d)) return 'INTEGER';
  if (/int|serial/.test(d)) return 'INTEGER';
  if (/real|floa|doub|numeric|decimal|money/.test(d)) return 'REAL';
  if (/blob|bytea|binary|image/.test(d)) return 'BLOB';
  return 'TEXT';
}

const finish = (columns, types, rows, limit, extra = {}) => {
  const truncated = rows.length > limit;
  return { columns, types, rows: (truncated ? rows.slice(0, limit) : rows).map(encodeRow), rows_affected: 0, last_insert_id: 0, truncated, ...extra };
};

/** Group flat catalog rows into table objects keyed by (schema, table). */
function tableMap(defaultSchema) {
  const m = new Map();
  const qualify = (schema, name) => (!schema || schema === defaultSchema ? name : `${schema}.${name}`);
  return {
    get(schema, name, kind = 'table') {
      const k = qualify(schema, name);
      if (!m.has(k)) m.set(k, { name: k, schema, base: name, kind, columns: [], indexes: [], primaryKey: [], constraints: [] });
      return m.get(k);
    },
    has: (schema, name) => m.has(qualify(schema, name)),
    list: () => [...m.values()],
    qualify
  };
}

const strip = (t) => { const { schema, base, constraints, ...rest } = t; return rest; };

// ============================================================ PostgreSQL

export async function postgres(conn) {
  const pg = (await import('pg')).default;
  for (const oid of [1082, 1083, 1114, 1184, 1186, 1266]) pg.types.setTypeParser(oid, (v) => v);
  const typeName = Object.fromEntries(Object.entries(pg.types.builtins).map(([k, v]) => [v, k.toLowerCase()]));
  const pool = new pg.Pool(conn.uri ? { connectionString: conn.uri, max: 4 } : {
    host: conn.host || '127.0.0.1', port: Number(conn.port) || 5432, user: conn.user, password: conn.password,
    database: conn.database || 'postgres', ssl: tls(conn), max: 4, connectionTimeoutMillis: 8000
  });
  pool.on('error', () => {});
  const q = (text, values) => pool.query({ text, values, rowMode: 'array' });

  const toResult = (r, limit) => {
    if (r.fields?.length) return finish(r.fields.map((f) => f.name), r.fields.map((f) => typeName[f.dataTypeID] ?? String(f.dataTypeID)), r.rows, limit);
    return { columns: [], types: [], rows: [], rows_affected: r.rowCount ?? 0, last_insert_id: 0, truncated: false };
  };

  async function query(sql, args, { limit }) {
    const stmts = splitStatements(sql);
    if (stmts.length > 1 && !hasArgs(args)) {
      const res = [].concat(await pool.query({ text: sql, rowMode: 'array' }));
      const last = [...res].reverse().find((r) => r.fields?.length);
      const out = last ? toResult(last, limit) : toResult(res[res.length - 1], limit);
      out.rows_affected = res.reduce((n, r) => n + (r.fields?.length ? 0 : r.rowCount ?? 0), 0);
      return out;
    }
    const b = bindParams(sql, args, 'pg');
    return toResult(await q(b.sql, b.args.map(decodeArg)), limit);
  }

  async function batch(statements) {
    const client = await pool.connect();
    const results = [];
    try {
      await client.query('BEGIN');
      for (let i = 0; i < statements.length; i++) {
        const b = bindParams(statements[i].sql, statements[i].args, 'pg');
        try { results.push(toResult(await client.query({ text: b.sql, values: b.args.map(decodeArg), rowMode: 'array' }), 1000)); }
        catch (e) { e.statement = i; throw e; }
      }
      await client.query('COMMIT');
      return results;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }

  const SYS = `NOT IN ('pg_catalog','information_schema') AND n NOT LIKE 'pg_toast%' AND n NOT LIKE 'pg_temp%'`;
  async function tables(only) {
    const filter = only ? ` AND (CASE WHEN s = 'public' THEN t ELSE s || '.' || t END) = $1` : '';
    const args = only ? [only] : [];
    const tm = tableMap('public');
    const list = await pool.query(`SELECT * FROM (SELECT table_schema s, table_name t, table_type k, table_schema n FROM information_schema.tables) x WHERE n ${SYS}${filter} ORDER BY s, t`, args);
    for (const r of list.rows) tm.get(r.s, r.t, r.k === 'VIEW' ? 'view' : 'table');
    const cols = await pool.query(`SELECT * FROM (SELECT table_schema s, table_name t, table_schema n, column_name c, data_type dt, udt_name u, character_maximum_length len,
        numeric_precision p, numeric_scale sc, is_nullable nul, column_default d, is_identity ident, ordinal_position o FROM information_schema.columns) x WHERE n ${SYS}${filter} ORDER BY s, t, o`, args);
    for (const r of cols.rows) {
      if (!tm.has(r.s, r.t)) continue;
      const serial = /^nextval\(/i.test(r.d ?? '');
      const decl = pgDecl(r);
      tm.get(r.s, r.t).columns.push({ name: r.c, type: affinityOf(decl), decl: serial ? (decl === 'bigint' ? 'bigserial' : 'serial') : decl,
        notNull: r.nul === 'NO', autoinc: serial || r.ident === 'YES', identity: r.ident === 'YES', default: serial ? undefined : r.d ?? undefined });
    }
    const cons = await pool.query(`SELECT * FROM (SELECT n.nspname s, cl.relname t, n.nspname n, con.conname name, con.contype ty, pg_get_constraintdef(con.oid) def,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(i,o) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.i ORDER BY k.o) cols
        FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace) x WHERE n ${SYS}${filter}`, args);
    for (const r of cons.rows) {
      if (!tm.has(r.s, r.t)) continue;
      const t = tm.get(r.s, r.t);
      t.constraints.push(`CONSTRAINT ${pgq(r.name)} ${r.def}`);
      if (r.ty === 'p') { t.primaryKey = r.cols; r.cols.forEach((c) => { const col = t.columns.find((x) => x.name === c); if (col) col.pk = true; }); }
      if (r.ty === 'u' && r.cols.length === 1) { const col = t.columns.find((x) => x.name === r.cols[0]); if (col) col.unique = true; }
    }
    const idx = await pool.query(`SELECT * FROM (SELECT n.nspname s, t.relname t, n.nspname n, i.relname name, ix.indisunique uq, pg_get_indexdef(ix.indexrelid) def,
        ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(i,o) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.i ORDER BY k.o) cols,
        EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid AND c.conrelid = t.oid) con
        FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace) x WHERE n ${SYS}${filter} ORDER BY s, t, name`, args);
    const idxDefs = new Map();
    for (const r of idx.rows) {
      if (!tm.has(r.s, r.t)) continue;
      const t = tm.get(r.s, r.t);
      t.indexes.push({ name: r.s === 'public' ? r.name : `${r.s}.${r.name}`, table: t.name, columns: r.cols, unique: r.uq, auto: r.con });
      if (!r.con) idxDefs.set(t.name, [...(idxDefs.get(t.name) ?? []), `${r.def};`]);
    }
    const views = await pool.query(`SELECT * FROM (SELECT schemaname s, viewname t, schemaname n, definition d FROM pg_views) x WHERE n ${SYS}${filter}`, args);
    for (const r of views.rows) if (tm.has(r.s, r.t)) tm.get(r.s, r.t).sql = `CREATE VIEW ${pgName(r.s, r.t)} AS\n${r.d.trim()}`;
    for (const t of tm.list()) {
      if (t.kind !== 'table') continue;
      t.rowid = 'ctid';
      const defs = t.columns.map((c) => `${pgq(c.name)} ${c.decl}${c.identity ? ' GENERATED BY DEFAULT AS IDENTITY' : ''}${c.notNull && !/serial/.test(c.decl) ? ' NOT NULL' : ''}${c.default ? ` DEFAULT ${c.default}` : ''}`);
      t.sql = [`CREATE TABLE ${pgName(t.schema, t.base)} (\n  ${[...defs, ...t.constraints].join(',\n  ')}\n);`, ...(idxDefs.get(t.name) ?? [])].join('\n');
      t.columns.forEach((c) => delete c.identity);
    }
    return tm.list().map(strip);
  }

  return {
    dialect: 'postgres', query, batch, tables, close: () => pool.end(),
    async databases() {
      const r = await pool.query(`SELECT datname AS name, pg_database_size(datname) AS size FROM pg_database WHERE NOT datistemplate ORDER BY 1`);
      return r.rows.map((x) => ({ name: x.name, size: Number(x.size) }));
    },
    async stats() {
      const r = await pool.query(`SELECT version() AS version, current_database() AS database, pg_database_size(current_database()) AS size,
        now() - pg_postmaster_start_time() AS uptime, (SELECT count(*) FROM pg_stat_activity) AS connections,
        s.xact_commit, s.xact_rollback, s.blks_read, s.blks_hit, s.tup_inserted, s.tup_updated, s.tup_deleted, s.deadlocks
        FROM pg_stat_database s WHERE s.datname = current_database()`);
      return r.rows[0];
    }
  };
}

const pgq = (s) => `"${String(s).replace(/"/g, '""')}"`;
const pgName = (schema, name) => (schema && schema !== 'public' ? `${pgq(schema)}.${pgq(name)}` : pgq(name));
function pgDecl(r) {
  const dt = r.dt;
  if (dt === 'character varying') return r.len ? `varchar(${r.len})` : 'varchar';
  if (dt === 'character') return `char(${r.len ?? 1})`;
  if (dt === 'numeric') return r.p ? `numeric(${r.p},${r.sc ?? 0})` : 'numeric';
  if (dt === 'timestamp without time zone') return 'timestamp';
  if (dt === 'timestamp with time zone') return 'timestamptz';
  if (dt === 'time without time zone') return 'time';
  if (dt === 'time with time zone') return 'timetz';
  if (dt === 'ARRAY') return `${String(r.u).replace(/^_/, '')}[]`;
  if (dt === 'USER-DEFINED') return r.u;
  return dt;
}

/** TLS options: verified by default; `sslInsecure` accepts self-signed certificates. */
const tls = (conn) => (conn.ssl ? { rejectUnauthorized: !conn.sslInsecure } : undefined);

const hasArgs = (a) => a && (Array.isArray(a) ? a.length > 0 : Object.keys(a).length > 0);

// ============================================================ MySQL / MariaDB

export async function mysql(conn) {
  const my = (await import('mysql2/promise')).default;
  const Types = (await import('mysql2')).default.Types;
  const typeName = Object.fromEntries(Object.entries(Types).map(([k, v]) => [v, k.toLowerCase()]));
  const opts = { multipleStatements: true, dateStrings: true, supportBigNumbers: true, connectionLimit: 4, connectTimeout: 8000, charset: 'utf8mb4' };
  const pool = conn.uri ? my.createPool({ uri: conn.uri, ...opts }) : my.createPool({
    host: conn.host || '127.0.0.1', port: Number(conn.port) || 3306, user: conn.user, password: conn.password,
    database: conn.database || undefined, ssl: tls(conn), ...opts
  });

  const toResult = (rows, fields, limit) => {
    if (Array.isArray(rows) && fields) return finish(fields.map((f) => f.name), fields.map((f) => typeName[f.columnType ?? f.type] ?? ''), rows, limit);
    return { columns: [], types: [], rows: [], rows_affected: rows?.affectedRows ?? 0, last_insert_id: Number(rows?.insertId ?? 0), truncated: false };
  };
  const run = async (c, sql, args, limit = 1000) => {
    const b = bindParams(sql, args, 'mysql');
    const [rows, fields] = await c.query({ sql: b.sql, rowsAsArray: true }, b.args.map(decodeArg));
    const multi = Array.isArray(rows) && Array.isArray(fields) && fields.length > 0 && (fields[0] === undefined || Array.isArray(fields[0]));
    if (multi) {
      // one entry per statement: a row array with its fields, or a ResultSetHeader
      let out = null, affected = 0;
      rows.forEach((r, i) => {
        if (Array.isArray(r) && fields[i]) out = toResult(r, fields[i], limit);
        else affected += r?.affectedRows ?? 0;
      });
      return out ? { ...out, rows_affected: affected } : { columns: [], types: [], rows: [], rows_affected: affected, last_insert_id: 0, truncated: false };
    }
    return toResult(rows, fields, limit);
  };

  async function tables(only) {
    const db = (await pool.query('SELECT DATABASE() AS d'))[0][0].d;
    if (!db) return [];
    const tm = tableMap(db);
    const f = only ? ' AND TABLE_NAME = ?' : '';
    const a = only ? [db, only] : [db];
    const [list] = await pool.query(`SELECT TABLE_NAME t, TABLE_TYPE k FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?${f} ORDER BY TABLE_NAME`, a);
    for (const r of list) tm.get(db, r.t, r.k === 'VIEW' ? 'view' : 'table');
    const [cols] = await pool.query(`SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE nul, COLUMN_KEY k, COLUMN_DEFAULT d, EXTRA x
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?${f} ORDER BY TABLE_NAME, ORDINAL_POSITION`, a);
    for (const r of cols) {
      if (!tm.has(db, r.t)) continue;
      tm.get(db, r.t).columns.push({ name: r.c, type: r.ty === 'tinyint(1)' ? 'INTEGER' : affinityOf(r.ty), decl: r.ty === 'tinyint(1)' ? 'boolean' : r.ty,
        notNull: r.nul === 'NO', pk: r.k === 'PRI', unique: r.k === 'UNI', autoinc: /auto_increment/i.test(r.x), default: r.d ?? undefined });
    }
    const [idx] = await pool.query(`SELECT TABLE_NAME t, INDEX_NAME i, NON_UNIQUE nu, COLUMN_NAME c FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?${f} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, a);
    for (const r of idx) {
      if (!tm.has(db, r.t)) continue;
      const t = tm.get(db, r.t);
      let i = t.indexes.find((x) => x.name === r.i);
      if (!i) { i = { name: r.i, table: t.name, columns: [], unique: !Number(r.nu), auto: r.i === 'PRIMARY' }; t.indexes.push(i); }
      i.columns.push(r.c);
      if (r.i === 'PRIMARY') t.primaryKey.push(r.c);
    }
    for (const t of tm.list()) {
      try {
        const [[row]] = await pool.query(t.kind === 'view' ? `SHOW CREATE VIEW \`${t.base.replace(/`/g, '``')}\`` : `SHOW CREATE TABLE \`${t.base.replace(/`/g, '``')}\``);
        t.sql = `${row['Create View'] ?? row['Create Table']};`;
      } catch { t.sql = ''; }
    }
    return tm.list().map(strip);
  }

  return {
    dialect: 'mysql', tables, close: () => pool.end(),
    query: (sql, args, { limit }) => run(pool, sql, args, limit),
    async batch(statements) {
      const c = await pool.getConnection();
      const results = [];
      try {
        await c.beginTransaction();
        for (let i = 0; i < statements.length; i++) {
          try { results.push(await run(c, statements[i].sql, statements[i].args)); } catch (e) { e.statement = i; throw e; }
        }
        await c.commit();
        return results;
      } catch (e) { await c.rollback().catch(() => {}); throw e; } finally { c.release(); }
    },
    async databases() {
      const [rows] = await pool.query(`SELECT s.SCHEMA_NAME name, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) size FROM information_schema.SCHEMATA s
        LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME GROUP BY s.SCHEMA_NAME ORDER BY 1`);
      return rows.map((r) => ({ name: r.name, size: Number(r.size), system: ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(r.name) }));
    },
    async stats() {
      const [[v]] = await pool.query('SELECT VERSION() AS version, DATABASE() AS `database`');
      const [st] = await pool.query(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Questions','Slow_queries','Com_commit','Com_rollback','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Bytes_received','Bytes_sent')`);
      return { ...v, ...Object.fromEntries(st.map((r) => [r.Variable_name, Number(r.Value)])) };
    }
  };
}

// ============================================================ SQL Server

export async function mssql(conn) {
  const sql = (await import('mssql')).default;
  const cfg = conn.uri ? conn.uri : {
    server: conn.host || '127.0.0.1', port: Number(conn.port) || 1433, user: conn.user, password: conn.password, database: conn.database || undefined,
    options: { encrypt: !!conn.ssl, trustServerCertificate: !!conn.sslInsecure || !conn.ssl }, pool: { max: 4 }, connectionTimeout: 8000, requestTimeout: 30000
  };
  const pool = await new sql.ConnectionPool(cfg).connect();
  pool.on('error', () => {});

  const run = async (req, text, args, limit = 1000) => {
    const b = bindParams(text, args, 'mssql');
    b.args.forEach((v, i) => req.input(`p${i + 1}`, decodeArg(v)));
    req.arrayRowMode = true;
    const r = await req.query(b.sql);
    const sets = r.recordsets ?? [];
    const affected = (r.rowsAffected ?? []).reduce((a, n) => a + n, 0);
    const i = sets.length - 1;
    if (i >= 0) {
      const meta = Array.isArray(r.columns) ? r.columns[i] : sets[i].columns;
      const cols = Array.isArray(meta) ? meta : Object.values(meta ?? {}).sort((a, b) => a.index - b.index);
      const types = cols.map((c) => c.type?.declaration ?? '');
      const out = finish(cols.map((c) => c.name), types, sets[i], limit);
      // the driver turns DATE into a JS Date at midnight UTC; show it as the date it is
      const dates = types.map((t, j) => (t === 'date' ? j : -1)).filter((j) => j >= 0);
      if (dates.length) for (const row of out.rows) for (const j of dates) if (typeof row[j] === 'string') row[j] = row[j].slice(0, 10);
      return { ...out, rows_affected: affected };
    }
    return { columns: [], types: [], rows: [], rows_affected: affected, last_insert_id: 0, truncated: false };
  };

  async function tables(only) {
    const tm = tableMap('dbo');
    const req = () => { const r = pool.request(); if (only) r.input('only', only); return r; };
    const f = only ? ` AND (CASE WHEN s.name = 'dbo' THEN o.name ELSE s.name + '.' + o.name END) = @only` : '';
    const list = await req().query(`SELECT s.name sch, o.name tbl, o.type ty FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0${f} ORDER BY s.name, o.name`);
    for (const r of list.recordset) tm.get(r.sch, r.tbl, r.ty.trim() === 'V' ? 'view' : 'table');
    const cols = await req().query(`SELECT s.name sch, o.name tbl, c.name col, ty.name typ, c.max_length len, c.precision p, c.scale sc, c.is_nullable nul, c.is_identity ident, dc.definition dflt
      FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
      WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0${f} ORDER BY s.name, o.name, c.column_id`);
    for (const r of cols.recordset) {
      if (!tm.has(r.sch, r.tbl)) continue;
      const decl = msDecl(r);
      tm.get(r.sch, r.tbl).columns.push({ name: r.col, type: affinityOf(decl), decl, notNull: !r.nul, autoinc: r.ident, default: r.dflt ? unparen(r.dflt) : undefined });
    }
    const idx = await req().query(`SELECT s.name sch, o.name tbl, i.name idx, i.is_unique uq, i.is_primary_key pk, i.is_unique_constraint uc, i.type_desc kind, c.name col
      FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE o.type = 'U' AND o.is_ms_shipped = 0 AND i.name IS NOT NULL AND ic.is_included_column = 0${f} ORDER BY s.name, o.name, i.name, ic.key_ordinal`);
    for (const r of idx.recordset) {
      if (!tm.has(r.sch, r.tbl)) continue;
      const t = tm.get(r.sch, r.tbl);
      let i = t.indexes.find((x) => x.name === r.idx);
      if (!i) { i = { name: r.idx, table: t.name, columns: [], unique: r.uq, auto: r.pk || r.uc, pk: r.pk, uc: r.uc, kind: r.kind }; t.indexes.push(i); }
      i.columns.push(r.col);
      if (r.pk) { t.primaryKey.push(r.col); const c = t.columns.find((x) => x.name === r.col); if (c) c.pk = true; }
    }
    for (const t of tm.list()) for (const i of t.indexes) if (i.uc && i.columns.length === 1) { const c = t.columns.find((x) => x.name === i.columns[0]); if (c) c.unique = true; }
    const fks = await req().query(`SELECT s.name sch, o.name tbl, fk.name fk, pc.name col, rs.name rsch, ro.name rtbl, rc.name rcol, fk.delete_referential_action_desc od
      FROM sys.foreign_keys fk JOIN sys.objects o ON o.object_id = fk.parent_object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = fk.object_id JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
      JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = ro.schema_id JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
      WHERE 1 = 1${f} ORDER BY fk.name, fc.constraint_column_id`);
    const fkm = new Map();
    for (const r of fks.recordset) {
      if (!tm.has(r.sch, r.tbl)) continue;
      const k = `${r.sch}.${r.tbl}.${r.fk}`;
      if (!fkm.has(k)) fkm.set(k, { t: tm.get(r.sch, r.tbl), name: r.fk, cols: [], ref: msName(r.rsch, r.rtbl), rcols: [], od: r.od });
      fkm.get(k).cols.push(r.col); fkm.get(k).rcols.push(r.rcol);
    }
    for (const x of fkm.values()) x.t.constraints.push(`CONSTRAINT ${msq(x.name)} FOREIGN KEY (${x.cols.map(msq).join(', ')}) REFERENCES ${x.ref} (${x.rcols.map(msq).join(', ')})${x.od && x.od !== 'NO_ACTION' ? ` ON DELETE ${x.od.replace('_', ' ')}` : ''}`);
    const chk = await req().query(`SELECT s.name sch, o.name tbl, cc.name nm, cc.definition def FROM sys.check_constraints cc JOIN sys.objects o ON o.object_id = cc.parent_object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE 1 = 1${f}`);
    for (const r of chk.recordset) if (tm.has(r.sch, r.tbl)) tm.get(r.sch, r.tbl).constraints.push(`CONSTRAINT ${msq(r.nm)} CHECK ${r.def}`);
    const views = await req().query(`SELECT s.name sch, o.name tbl, m.definition def FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type = 'V'${f}`);
    for (const r of views.recordset) if (tm.has(r.sch, r.tbl)) tm.get(r.sch, r.tbl).sql = `${r.def.trim()};`;
    for (const t of tm.list()) {
      if (t.kind !== 'table') continue;
      const defs = t.columns.map((c) => `${msq(c.name)} ${c.decl}${c.autoinc ? ' IDENTITY(1,1)' : ''}${c.notNull ? ' NOT NULL' : ' NULL'}${c.default ? ` DEFAULT ${c.default}` : ''}`);
      const keys = t.indexes.filter((i) => i.auto).map((i) => `CONSTRAINT ${msq(i.name)} ${i.pk ? 'PRIMARY KEY' : 'UNIQUE'} (${i.columns.map(msq).join(', ')})`);
      const other = t.indexes.filter((i) => !i.auto).map((i) => `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${msq(i.name)} ON ${msName(t.schema, t.base)} (${i.columns.map(msq).join(', ')});`);
      t.sql = [`CREATE TABLE ${msName(t.schema, t.base)} (\n  ${[...defs, ...keys, ...t.constraints].join(',\n  ')}\n);`, ...other].join('\n');
      t.indexes.forEach((i) => { delete i.pk; delete i.uc; delete i.kind; });
    }
    return tm.list().map(strip);
  }

  return {
    dialect: 'mssql', tables, close: () => pool.close(),
    query: (text, args, { limit }) => run(pool.request(), text, args, limit),
    async batch(statements) {
      const tx = new sql.Transaction(pool);
      await tx.begin();
      const results = [];
      try {
        for (const g of identityGroups(statements)) {
          try { results.push(await run(new sql.Request(tx), g.sql, g.args)); } catch (e) { e.statement = g.first; throw e; }
        }
        await tx.commit();
        return results;
      } catch (e) { await tx.rollback().catch(() => {}); throw e; }
    },
    async databases() {
      const r = await pool.request().query(`SELECT d.name, d.database_id id, CAST(SUM(CAST(f.size AS bigint)) * 8192 AS bigint) size
        FROM sys.databases d LEFT JOIN sys.master_files f ON f.database_id = d.database_id GROUP BY d.name, d.database_id ORDER BY d.name`);
      return r.recordset.map((x) => ({ name: x.name, size: Number(x.size ?? 0), system: x.id <= 4 }));
    },
    async stats() {
      const r = await pool.request().query(`SELECT @@VERSION AS version, DB_NAME() AS [database],
        (SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE is_user_process = 1) AS connections,
        (SELECT sqlserver_start_time FROM sys.dm_os_sys_info) AS started,
        (SELECT CAST(SUM(CAST(size AS bigint)) * 8192 AS bigint) FROM sys.database_files) AS size`).catch(() => pool.request().query('SELECT @@VERSION AS version, DB_NAME() AS [database]'));
      const row = r.recordset[0];
      return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encodeValue(v)]));
    }
  };
}

/**
 * Requests run through sp_executesql, so a SET IDENTITY_INSERT … ON would end
 * with its own request. Join each ON … OFF block (parameter-free, as dumps
 * write it) into one T-SQL batch so the setting covers its INSERTs.
 */
export function identityGroups(statements) {
  const out = [];
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i];
    if (/^SET\s+IDENTITY_INSERT\b[\s\S]*\bON\s*;?$/i.test(s.sql.trim()) && !hasArgs(s.args)) {
      const parts = [s.sql];
      let j = i + 1;
      while (j < statements.length && !hasArgs(statements[j].args)) {
        parts.push(statements[j].sql);
        if (/^SET\s+IDENTITY_INSERT\b[\s\S]*\bOFF\s*;?$/i.test(statements[j].sql.trim())) break;
        j++;
      }
      out.push({ sql: parts.map((p) => p.trim().replace(/;$/, '')).join(';\n'), args: undefined, first: i });
      i = Math.min(j, statements.length - 1);
    } else out.push({ sql: s.sql, args: s.args, first: i });
  }
  return out;
}

const msq = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const msName = (schema, name) => (schema && schema !== 'dbo' ? `${msq(schema)}.${msq(name)}` : msq(name));
const unparen = (d) => { let s = String(d); while (/^\(.*\)$/s.test(s) && balanced(s.slice(1, -1))) s = s.slice(1, -1); return s; };
const balanced = (s) => { let n = 0; for (const ch of s) { if (ch === '(') n++; else if (ch === ')' && --n < 0) return false; } return n === 0; };
function msDecl(r) {
  const t = r.typ;
  if (/^(n?var)?char$|^n?char$|^(var)?binary$/.test(t)) {
    if (r.len === -1) return `${t}(max)`;
    return `${t}(${t.startsWith('n') ? r.len / 2 : r.len})`;
  }
  if (t === 'decimal' || t === 'numeric') return `${t}(${r.p},${r.sc})`;
  return t;
}

// ============================================================ SQLite (node:sqlite)

// a dedicated folder by default — never the working directory, which holds the served dist/
const SQLITE_ROOT = resolve(process.env.SQLITE_ROOT || join(process.cwd(), 'data'));
const SQLITE_EXT = /\.(db|sqlite|sqlite3|db3)$/i;

const outside = () => Object.assign(new Error(`SQLITE_ROOT(${SQLITE_ROOT}) 밖의 파일은 열 수 없습니다`), { status: 403 });
const inside = (root, p) => p === root || p.startsWith(root + sep);

/**
 * Resolve a SQLite file inside SQLITE_ROOT (the gateway never opens files
 * outside it). Symlinks are resolved first, so a link inside the root that
 * points elsewhere is refused too. Only .db / .sqlite / .sqlite3 / .db3 names.
 */
export function sqlitePath(file) {
  if (!file) throw Object.assign(new Error('SQLite 파일 경로를 지정하세요'), { status: 400 });
  if (file === ':memory:') return file;
  if (/^file:/i.test(file)) throw outside(); // URI filenames could name other files or options
  if (!SQLITE_EXT.test(file)) throw Object.assign(new Error('SQLite 파일은 .db, .sqlite, .sqlite3, .db3 이름만 열 수 있습니다'), { status: 403 });
  const p = resolve(SQLITE_ROOT, file);
  if (!inside(SQLITE_ROOT, p)) throw outside();
  mkdirSync(SQLITE_ROOT, { recursive: true });
  const root = realpathSync(SQLITE_ROOT);
  const real = existsSync(p) ? realpathSync(p) : resolve(realpathSync(existingParent(dirname(p))), relative(existingParent(dirname(p)), p));
  if (!inside(root, real)) throw outside();
  return real;
}
const existingParent = (d) => { let x = d; while (!existsSync(x) && dirname(x) !== x) x = dirname(x); return x; };

/**
 * Statements that would reach other files: ATTACH / DETACH and VACUUM INTO.
 * Checked on every statement because node:sqlite's authorizer is missing on
 * older Node releases; where it exists it is installed as well.
 */
const SQLITE_FILE_STMT = /^\s*(ATTACH|DETACH)\b|\bVACUUM\b[\s\S]*\bINTO\b/i;
export function checkSqliteStatement(sql) {
  for (const s of splitStatements(sql)) if (SQLITE_FILE_STMT.test(s)) throw Object.assign(new Error('ATTACH / DETACH / VACUUM INTO 는 게이트웨이에서 허용하지 않습니다'), { status: 403 });
}
export const sqliteRoot = () => SQLITE_ROOT;

export async function sqlite(conn) {
  const { DatabaseSync, constants } = await import('node:sqlite');
  const db = new DatabaseSync(sqlitePath(conn.file || conn.database), { allowExtension: false });
  if (typeof db.setAuthorizer === 'function' && constants?.SQLITE_ATTACH !== undefined) {
    db.setAuthorizer((action) => (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH ? constants.SQLITE_DENY : constants.SQLITE_OK));
  }
  db.exec('PRAGMA foreign_keys = ON');

  const one = (text, args, limit = 1000) => {
    checkSqliteStatement(text);
    const st = db.prepare(text);
    const a = args === undefined || args === null ? [] : args;
    const cols = st.columns();
    if (cols.length) {
      st.setReturnArrays(true);
      const rows = Array.isArray(a) ? st.all(...a.map(decodeArg)) : st.all(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, decodeArg(v)])));
      return finish(cols.map((c) => c.name), cols.map((c) => c.type ?? ''), rows, limit);
    }
    const r = Array.isArray(a) ? st.run(...a.map(decodeArg)) : st.run(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, decodeArg(v)])));
    return { columns: [], types: [], rows: [], rows_affected: Number(r.changes), last_insert_id: Number(r.lastInsertRowid), truncated: false };
  };

  function tables(only) {
    const list = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'${only ? ' AND name = ?' : ''} ORDER BY name`).all(...(only ? [only] : []));
    return list.map((t) => {
      const info = { name: t.name, kind: t.type, columns: [], indexes: [], primaryKey: [], sql: `${t.sql};` };
      const cols = db.prepare(`SELECT * FROM pragma_table_xinfo(?)`).all(t.name);
      const auto = /AUTOINCREMENT/i.test(t.sql ?? '');
      for (const c of cols) {
        if (c.hidden) continue;
        info.columns.push({ name: c.name, type: affinityOf(c.type), decl: c.type, notNull: !!c.notnull, pk: c.pk > 0, autoinc: c.pk > 0 && auto, default: c.dflt_value ?? undefined, _pk: c.pk });
      }
      info.primaryKey = info.columns.filter((c) => c._pk).sort((a, b) => a._pk - b._pk).map((c) => c.name);
      info.columns.forEach((c) => delete c._pk);
      if (t.type === 'table') {
        info.rowid = /WITHOUT\s+ROWID/i.test(t.sql ?? '') ? undefined : 'rowid';
        const idxSql = [];
        for (const i of db.prepare(`SELECT * FROM pragma_index_list(?)`).all(t.name)) {
          const cs = db.prepare(`SELECT name FROM pragma_index_info(?) ORDER BY seqno`).all(i.name).map((x) => x.name);
          info.indexes.push({ name: i.name, table: t.name, columns: cs, unique: !!i.unique, auto: i.origin !== 'c' });
          if (i.unique && i.origin === 'u' && cs.length === 1) { const c = info.columns.find((x) => x.name === cs[0]); if (c) c.unique = true; }
          if (i.origin === 'c') { const s = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(i.name)?.sql; if (s) idxSql.push(`${s};`); }
        }
        info.sql = [info.sql, ...idxSql].join('\n');
      }
      return info;
    });
  }

  return {
    dialect: 'sqlite', close: () => db.close(),
    async query(text, args, { limit }) {
      const stmts = splitStatements(text);
      if (stmts.length <= 1) return one(text, args, limit);
      let last, affected = 0;
      for (const s of stmts) { last = one(s, undefined, limit); affected += last.rows_affected; }
      return { ...last, rows_affected: affected };
    },
    async batch(statements) {
      db.exec('BEGIN');
      const results = [];
      try {
        statements.forEach((s, i) => { try { results.push(one(s.sql, s.args)); } catch (e) { e.statement = i; throw e; } });
        db.exec('COMMIT');
        return results;
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
    },
    tables: async (only) => tables(only),
    async databases() { return [{ name: 'main', file: conn.file || conn.database }]; },
    async stats() {
      const g = (s) => Object.values(db.prepare(s).get() ?? {})[0];
      return { version: `SQLite ${g('SELECT sqlite_version()')}`, file: sqlitePath(conn.file || conn.database), page_count: g('PRAGMA page_count'), page_size: g('PRAGMA page_size'),
        size: g('PRAGMA page_count') * g('PRAGMA page_size'), freelist_count: g('PRAGMA freelist_count'), journal_mode: g('PRAGMA journal_mode'), foreign_keys: g('PRAGMA foreign_keys') };
    }
  };
}

export { returnsRows };
