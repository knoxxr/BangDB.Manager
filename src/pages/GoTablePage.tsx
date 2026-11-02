import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ROWID, affinity, analyze, applyChanges, bulkInsert, countWhere, dropColumn, dropIndex, dropTable, dropView, dumpSql, errorText, execStatements,
  goQuery, goRows, goTable, insertModes, pageSql, readAll, renameTable, type BulkProgress, type InsertMode, type RowChange, type RowRef
} from '../api/goapi';
import { csvToDocs, downloadText, parseDocuments, toCsv } from '../api/data';
import { dialectOf, identityOf, viewSelect, type Dialect, type Identity } from '../api/dialect';
import type { ColumnInfo, Connection, GoQueryResponse, GoTableInfo } from '../api/types';
import { DataGrid, type GridRow } from '../components/DataGrid';
import { TopBar } from '../components/Layout';
import { RowForm } from '../components/RowForm';
import { AddColumnModal, AlterColumnModal, CreateIndexForm, CreateViewModal } from '../components/SchemaForms';
import { DataTable, Modal, useConfirm, usePrompt, useToast } from '../components/ui';
import { useDbConnection } from '../store/store';

type Tab = 'data' | 'structure' | 'index' | 'transfer' | 'ddl';

/** Table / view page for SQL connections: BangDB (Go) and the gateway's PostgreSQL, MySQL, SQL Server, SQLite. */
export default function GoTablePage() {
  const { connId, db = '', table = '' } = useParams();
  const conn = useDbConnection(connId, db);
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('data');
  // metadata is kept with the table it describes: after navigating to another
  // table nothing may run with the previous table's key columns
  const [loaded, setLoaded] = useState<{ at: string; info: GoTableInfo | null; err: string } | null>(null);
  const [counted, setCounted] = useState<{ at: string; n: number | undefined } | null>(null);
  const at = `${db}/${table}`;
  const info = loaded?.at === at ? loaded.info : undefined;
  const infoErr = loaded?.at === at ? loaded.err : '';
  const total = counted?.at === at ? counted.n : undefined;

  useEffect(() => { setTab('data'); }, [at]);
  const loadInfo = useCallback(async () => {
    if (!conn) return;
    const r = await goTable(conn, table);
    setLoaded({ at, info: r.ok ? r.data : null, err: r.ok ? '' : errorText(r) });
  }, [conn, table, at]);
  const loadCount = useCallback(async () => { if (conn) { const n = await countWhere(conn, table); setCounted({ at, n }); } }, [conn, table, at]);
  useEffect(() => { loadInfo(); loadCount(); }, [loadInfo, loadCount]);

  if (!conn) return <div className="empty">Connection not found.</div>;
  const d = dialectOf(conn);
  const base = `/c/${conn.id}/db/${encodeURIComponent(db)}`;
  const isView = info?.kind === 'view';
  const tabs: [Tab, string][] = isView
    ? [['data', 'Data'], ['transfer', 'Export'], ['ddl', 'Definition']]
    : [['data', 'Data'], ['structure', 'Schema'], ['index', `Indexes${info?.indexes?.length ? ` (${info.indexes.length})` : ''}`], ['transfer', 'Import & export'], ['ddl', 'DDL']];

  return (
    <>
      <TopBar title={table} crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: base, label: conn.db && conn.kind !== 'sqlite' ? db : 'Tables' }]}
        right={<>
          {isView && <span className="badge accent">View</span>}
          {info?.store && <span className="badge accent">{info.store === 'memory' ? 'In-memory' : info.store === 'timeseries' ? 'Time series' : info.store}</span>}
          <span className="badge">{total === undefined ? '…' : `${total.toLocaleString()} rows`}</span>
          <button className="btn sm" onClick={() => nav(`${base}/query`, { state: { sql: d.page(`SELECT * FROM ${d.qt(table)}`, '', 100, 0) } })}>SQL</button>
        </>} />
      {info === null && <div className="card danger">{infoErr || 'Could not load table info.'}</div>}
      {info && (
        <div key={`${db}/${table}`}>
          <div className="tabs">
            {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'data' && <DataTab conn={conn} table={table} info={info} onChanged={loadCount} />}
          {tab === 'structure' && <StructureTab conn={conn} table={table} info={info} base={base} onChanged={() => { loadInfo(); loadCount(); }} />}
          {tab === 'index' && <IndexTab conn={conn} table={table} info={info} onChanged={loadInfo} />}
          {tab === 'transfer' && <TransferTab conn={conn} table={table} info={info} onChanged={loadCount} />}
          {tab === 'ddl' && <DdlTab conn={conn} table={table} info={info} base={base} onChanged={loadInfo} />}
        </div>
      )}
    </>
  );
}

type TabProps = { conn: Connection; table: string; info: GoTableInfo; onChanged: () => void };

// ---------------------------------------------------------------- data

interface PageState { where: string; search: string; orderBy?: string; desc: boolean; limit: number; offset: number }
let newSeq = 0;

function DataTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isView = info.kind === 'view';
  const d = dialectOf(conn);
  const ident: Identity = useMemo(() => identityOf(d, info), [d, info]);
  const [pg, setPg] = useState<PageState>({ where: '', search: '', desc: false, limit: 50, offset: 0 });
  const [whereIn, setWhereIn] = useState('');
  const [searchIn, setSearchIn] = useState('');
  const [data, setData] = useState<GoQueryResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [matched, setMatched] = useState<number | undefined>();
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [inserts, setInserts] = useState<string[]>([]);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ key?: string; isNew: boolean; values: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);

  const columns: ColumnInfo[] = useMemo(() => {
    if (!isView && info.columns?.length) return info.columns;
    return (data?.columns ?? []).filter((c) => c !== ROWID).map((name, i) => ({ name, decl: data?.types[i] ?? '' }));
  }, [info, data, isView]);

  const cond = useMemo(() => {
    const parts: string[] = [];
    if (pg.where.trim()) parts.push(`(${pg.where.trim()})`);
    if (pg.search.trim()) {
      const text = columns.filter((c) => ['TEXT', 'ANY'].includes(affinity(c)));
      const like = d.literal(`%${pg.search.trim()}%`);
      const targets = text.length ? text : columns;
      if (targets.length) parts.push(`(${targets.map((c) => `${d.q(c.name)} ${d.likeCI} ${like}`).join(' OR ')})`);
    }
    return parts.join(' AND ');
  }, [pg.where, pg.search, columns, d]);

  const load = useCallback(async () => {
    setBusy(true);
    const sql = pageSql(table, { where: cond, orderBy: pg.orderBy, desc: pg.desc, limit: pg.limit, offset: pg.offset }, isView ? false : ident ?? false, d);
    const [r, n] = await Promise.all([goQuery(conn, sql, undefined, { limit: pg.limit }), countWhere(conn, table, cond)]);
    setBusy(false);
    if (r.ok) { setData(r.data); setErr(''); } else { setData(null); setErr(errorText(r)); }
    setMatched(n);
  }, [conn, table, cond, pg.orderBy, pg.desc, pg.limit, pg.offset, isView, ident, d]);
  useEffect(() => { load(); }, [load]);

  const rawRows = useMemo(() => (data ? goRows(data) : []), [data]);
  const unsafeIds = ident?.kind === 'rowid' && rawRows.some((r) => !Number.isSafeInteger(r[ROWID]));
  const readOnly = isView || !ident || unsafeIds;
  const rows: GridRow[] = useMemo(() => {
    const existing = rawRows.map((r, i) => {
      const { [ROWID]: id, ...values } = r;
      const key = !ident ? `v${i}` : ident.kind === 'pk' ? JSON.stringify(ident.columns.map((c) => values[c])) : String(id);
      return { key, values };
    });
    return [...inserts.map((k) => ({ key: k, values: {}, isNew: true })), ...existing];
  }, [rawRows, inserts, ident]);

  /** Where an existing grid row is, from its key and original values. */
  const refOf = (key: string): RowRef => {
    if (ident?.kind === 'pk') {
      const row = rows.find((r) => r.key === key)?.values ?? {};
      return { pk: Object.fromEntries(ident.columns.map((c) => [c, row[c]])) };
    }
    return { rowid: ident?.kind === 'rowid' ? Number(key) : key };
  };

  const nEdits = Object.keys(edits).filter((k) => !k.startsWith('new:') && !deleted.has(k)).length;
  const pending = nEdits + inserts.length + deleted.size;
  const reset = () => { setEdits({}); setInserts([]); setDeleted(new Set()); setSelected(new Set()); };

  useEffect(() => {
    if (!pending) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [pending]);

  async function guard(): Promise<boolean> {
    return !pending || confirm(`Discard ${pending} unsaved change(s) and leave?`, 'Discard').then((ok) => { if (ok) reset(); return ok; });
  }
  async function go(p: Partial<PageState>) { if (await guard()) setPg((x) => ({ ...x, ...p })); }

  function onEdit(key: string, col: string, value: unknown) {
    setEdits((e) => {
      const row = { ...(e[key] ?? {}) };
      const orig = rows.find((r) => r.key === key)?.values[col];
      if (!key.startsWith('new:') && (value === orig || (value !== null && orig !== null && typeof orig === 'object' && JSON.stringify(value) === JSON.stringify(orig)))) delete row[col];
      else row[col] = value;
      const next = { ...e };
      if (Object.keys(row).length) next[key] = row; else delete next[key];
      return next;
    });
  }

  const addRow = () => { const k = `new:${++newSeq}`; setInserts((l) => [k, ...l]); };

  function deleteSelected() {
    const keys = [...selected];
    const allDeleted = keys.every((k) => deleted.has(k) || k.startsWith('new:'));
    setInserts((l) => l.filter((k) => !selected.has(k)));
    setDeleted((d) => {
      const n = new Set(d);
      keys.filter((k) => !k.startsWith('new:')).forEach((k) => (allDeleted ? n.delete(k) : n.add(k)));
      return n;
    });
    setSelected(new Set());
  }

  async function commit(changes: RowChange[], msg: string): Promise<boolean> {
    try {
      const r = await applyChanges(conn, table, changes, ident);
      if (!r.ok) { toast(`Save failed — nothing was applied: ${errorText(r)}`, 'err'); return false; }
      toast(msg, 'ok');
      return true;
    } catch (e) { toast((e as Error).message, 'err'); return false; }
  }

  async function saveAll() {
    const changes: RowChange[] = [
      ...[...deleted].map((k): RowChange => ({ kind: 'delete', ...refOf(k) })),
      ...Object.entries(edits).filter(([k]) => !k.startsWith('new:') && !deleted.has(k)).map(([k, v]): RowChange => ({ kind: 'update', ...refOf(k), values: v })),
      ...[...inserts].reverse().map((k) => ({ kind: 'insert' as const, values: edits[k] ?? {} }))
    ];
    setSaving(true);
    const ok = await commit(changes, `Saved — ${nEdits} edited · ${inserts.length} added · ${deleted.size} deleted`);
    setSaving(false);
    if (ok) { reset(); load(); onChanged(); }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && pending) { e.preventDefault(); saveAll(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  function sortBy(col: string) {
    if (pg.orderBy !== col) go({ orderBy: col, desc: false, offset: 0 });
    else if (!pg.desc) go({ desc: true, offset: 0 });
    else go({ orderBy: undefined, desc: false, offset: 0 });
  }

  const from = matched === 0 ? 0 : pg.offset + 1;
  const to = pg.offset + rawRows.length;
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const shownRows = rawRows.map(({ [ROWID]: _, ...v }) => v);

  return (
    <>
      <div className="toolbar">
        <input className="inp filter" placeholder="Quick search (text columns)" value={searchIn} onChange={(e) => setSearchIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go({ search: searchIn, offset: 0 })} />
        <input className="inp filter mono" placeholder="WHERE clause  e.g. age > 30 AND name LIKE 'k%'" value={whereIn} onChange={(e) => setWhereIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go({ where: whereIn, offset: 0 })} />
        <button className="btn sm primary" onClick={() => go({ where: whereIn, search: searchIn, offset: 0 })} disabled={busy}>{busy ? '…' : 'Load'}</button>
        {(pg.where || pg.search) && <button className="btn sm ghost" onClick={() => { setWhereIn(''); setSearchIn(''); go({ where: '', search: '', offset: 0 }); }}>Clear filters</button>}
      </div>
      <div className="toolbar">
        {!readOnly && <button className="btn sm primary" onClick={addRow}>+ Add row</button>}
        {!readOnly && <button className="btn sm" onClick={() => setForm({ isNew: true, values: {} })}>+ Add with form</button>}
        {!readOnly && selected.size > 0 && <button className="btn sm danger" onClick={deleteSelected}>{[...selected].every((k) => deleted.has(k)) ? `Undo delete (${selected.size})` : `Delete selected (${selected.size})`}</button>}
        <span className="grow" />
        <div className="pager">
          <span>{matched === undefined ? '' : `${from.toLocaleString()}–${to.toLocaleString()} / ${matched.toLocaleString()} rows`}</span>
          <button className="btn sm ghost" disabled={pg.offset === 0} onClick={() => go({ offset: 0 })} title="First">«</button>
          <button className="btn sm ghost" disabled={pg.offset === 0} onClick={() => go({ offset: Math.max(0, pg.offset - pg.limit) })} title="Previous">‹</button>
          <button className="btn sm ghost" disabled={matched !== undefined ? to >= matched : rawRows.length < pg.limit} onClick={() => go({ offset: pg.offset + pg.limit })} title="Next">›</button>
          <button className="btn sm ghost" disabled={matched === undefined || to >= matched} onClick={() => matched && go({ offset: Math.floor((matched - 1) / pg.limit) * pg.limit })} title="Last">»</button>
          <select className="inp" value={pg.limit} onChange={(e) => go({ limit: Number(e.target.value), offset: 0 })} style={{ minHeight: 32, padding: '4px 6px' }}>
            {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
          <button className="btn sm ghost" onClick={async () => { if (await guard()) load(); }} title="Refresh">↻</button>
          {shownRows.length > 0 && <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.csv`, '﻿' + toCsv(shownRows), 'text/csv')} title="Current page as CSV">CSV</button>}
        </div>
      </div>
      {err && <div className="card danger">{err}</div>}
      {unsafeIds && <p className="warn small">rowid exceeds the JavaScript integer range, so rows cannot be edited here. Use the SQL console.</p>}
      {!isView && !ident && <p className="warn small">This table has no primary key, so rows cannot be identified and it is read-only. Add a primary key (or a UNIQUE NOT NULL column) in the Schema tab, or use the SQL console.</p>}
      {!err && (
        <DataGrid columns={columns} rows={rows} readOnly={readOnly} edits={edits} deleted={deleted} selected={selected}
          sort={pg.orderBy ? { col: pg.orderBy, desc: pg.desc } : undefined} onSort={sortBy}
          onEdit={onEdit} onError={(m) => toast(m, 'err')}
          onToggleSelect={(k) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
          onToggleAll={() => setSelected((s) => (rows.every((r) => s.has(r.key)) ? new Set() : new Set(rows.map((r) => r.key))))}
          onOpenRow={(r) => setForm({ key: r.key, isNew: !!r.isNew, values: { ...r.values, ...(edits[r.key] ?? {}) } })} />
      )}
      {!readOnly && !pending && rows.length > 0 && <p className="muted small">Click a cell to edit in place — Enter: next row, Tab: next cell, Esc: cancel. Changes are saved together in one transaction. ✎ opens the form editor.</p>}
      {data?.truncated && <p className="warn small">Results were truncated by the server row limit. Reduce the page size.</p>}
      {pending > 0 && (
        <div className="savebar">
          <span className="grow">Unsaved changes: <b>{nEdits} edited</b> · <b className="ok">{inserts.length} added</b> · <b className="danger">{deleted.size} deleted</b></span>
          <button className="btn sm" onClick={reset} disabled={saving}>Discard all</button>
          <button className="btn sm primary" onClick={saveAll} disabled={saving}>{saving ? 'Saving…' : 'Save changes (Ctrl+S)'}</button>
        </div>
      )}
      {form && (
        <RowForm columns={columns} values={form.values} isNew={form.isNew} readOnly={readOnly}
          title={form.isNew ? 'New row' : readOnly ? 'View row' : ident?.kind === 'pk' ? `Edit row (${ident.columns.join(', ')} = ${JSON.parse(form.key!).join(', ')})` : `Edit row (${ident?.kind === 'ctid' ? 'ctid' : 'rowid'} ${form.key})`}
          onClose={() => setForm(null)}
          onSubmit={readOnly ? undefined : async (values) => {
            if (form.isNew) {
              const ok = await commit([{ kind: 'insert', values }], 'Row added');
              if (ok) {
                if (form.key) { setInserts((l) => l.filter((k) => k !== form.key)); setEdits((e) => { const n = { ...e }; delete n[form.key!]; return n; }); }
                load(); onChanged();
              }
              return ok;
            }
            const ok = await commit([{ kind: 'update', ...refOf(form.key!), values }], 'Saved');
            if (ok) { setEdits((e) => { const n = { ...e }; delete n[form.key!]; return n; }); load(); }
            return ok;
          }}
          onDelete={readOnly || form.isNew ? undefined : async () => {
            const ok = await commit([{ kind: 'delete', ...refOf(form.key!) }], 'Row deleted');
            if (ok) { load(); onChanged(); }
            return ok;
          }}
          onDuplicate={readOnly ? undefined : (values) => setForm({ isNew: true, values })} />
      )}
      {confirmEl}
    </>
  );
}

// ---------------------------------------------------------------- structure

function StructureTab({ conn, table, info, base, onChanged }: TabProps & { base: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const [adding, setAdding] = useState(false);
  const [altering, setAltering] = useState<ColumnInfo | null>(null);
  const d = dialectOf(conn);
  const constraints = useMemo(() => tableConstraints(info.sql ?? ''), [info.sql]);
  const storage = d.storage ? /\)\s*(USING\s+[\s\S]+?);?\s*(?:\n|$)/i.exec((info.sql ?? '').split(/;\s*\n/)[0])?.[1] : undefined;

  async function run(sql: string | string[], ok: string): Promise<boolean> {
    const r = await execStatements(conn, Array.isArray(sql) ? sql : [sql]);
    if (!r.ok) { toast(`Failed: ${errorText(r)}`, 'err'); return false; }
    toast(ok, 'ok'); onChanged(); return true;
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="grow">Columns ({info.columns?.length ?? 0})</b>
          <button className="btn sm primary" onClick={() => setAdding(true)}>+ Add column</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="coltable">
            <thead><tr><th>#</th><th>Name</th><th>Declared type</th><th>Storage</th><th>Constraints</th><th /></tr></thead>
            <tbody>
              {(info.columns ?? []).map((c, i) => (
                <tr key={c.name}>
                  <td className="muted">{i + 1}</td>
                  <td className="mono">{c.pk && <span className="pk-ico">🔑</span>}{c.name}</td>
                  <td className="mono">{c.decl || <span className="muted">ANY</span>}</td>
                  <td className="muted small">{c.type || 'ANY'}</td>
                  <td>
                    <div className="chips">
                      {c.pk && <span className="badge warn">PRIMARY KEY</span>}
                      {c.autoinc && <span className="badge">{d.id === 'mysql' ? 'AUTO_INCREMENT' : d.id === 'mssql' || d.id === 'postgres' ? 'IDENTITY' : 'AUTOINCREMENT'}</span>}
                      {c.notNull && <span className="badge">NOT NULL</span>}
                      {c.unique && <span className="badge">UNIQUE</span>}
                      {c.collate && <span className="badge">COLLATE {c.collate}</span>}
                      {c.default && <span className="badge mono">DEFAULT {c.default}</span>}
                    </div>
                  </td>
                  <td className="acts">
                    {d.alterColumn && <button className="btn sm ghost" onClick={() => setAltering(c)}>Edit</button>}
                    <button className="btn sm ghost" onClick={async () => {
                      const to = await prompt('Rename column', `${c.name} →`, c.name);
                      if (to && to !== c.name) run(d.renameColumn(table, c.name, to), `Column renamed: ${c.name} → ${to}`);
                    }}>Rename</button>
                    <button className="btn sm danger" onClick={async () => {
                      if (!(await confirm(`Delete column "${c.name}" and all of its values.`))) return;
                      const r = await dropColumn(conn, table, c.name);
                      if (r.ok) { toast(`Column "${c.name}" deleted`, 'ok'); onChanged(); } else toast(`Delete failed: ${errorText(r)}`, 'err');
                    }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(constraints.length > 0 || storage) && (
        <div className="card">
          <b>Table constraints · storage</b>
          <div className="list" style={{ marginTop: 8 }}>
            {storage && <div className="mono small">{storage}</div>}
            {constraints.map((c, i) => <div key={i} className="mono small">{c}</div>)}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>{d.id === 'bangdb' || d.id === 'sqlite'
            ? 'To change constraints, create a new table from the definition in the DDL tab and move the data over (INSERT INTO new SELECT * FROM old).'
            : 'Constraints can be added or dropped in the SQL console with ALTER TABLE … ADD / DROP CONSTRAINT.'}</p>
        </div>
      )}

      <div className="card">
        <b>Table actions</b>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('Rename table', `${table} →`, table);
            if (!to || to === table) return;
            const r = await renameTable(conn, table, to);
            if (r.ok) { toast(`Renamed to ${to}`, 'ok'); nav(`${base}/t/${encodeURIComponent(to)}`, { replace: true }); } else toast(`Failed: ${errorText(r)}`, 'err');
          }}>Rename</button>
          <button className="btn sm" onClick={async () => { const r = await analyze(conn, table); toast(r.ok ? 'ANALYZE complete — index statistics updated' : `Failed: ${errorText(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onChanged(); }}>ANALYZE (update stats)</button>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('Duplicate table', d.copyTable ? 'New table name (copies schema and data)' : 'New table name (schema from the definition SQL, data via INSERT … SELECT)', `${table}_copy`);
            if (!to) return;
            const stmts = d.copyTable ? d.copyTable(table, to) : [...copyDdl(info.sql ?? '', table, to, d), `INSERT INTO ${d.qt(to)} SELECT * FROM ${d.qt(table)}`];
            if (await run(stmts, `Duplicated as "${to}"${d.id === 'mssql' ? ' (SELECT INTO in SQL Server does not copy constraints or indexes)' : ''}`)) nav(`${base}/t/${encodeURIComponent(to)}`);
          }}>Duplicate</button>
          <span className="grow" />
          <button className="btn sm danger" onClick={async () => {
            if (!(await confirm(`Delete all rows of "${table}" (DELETE FROM). The schema is kept.`, 'Delete all'))) return;
            run(`DELETE FROM ${d.qt(table)}`, 'All rows deleted');
          }}>Delete all rows</button>
          <button className="btn sm danger" onClick={async () => {
            if (!(await confirm(`Drop table "${table}". All data and indexes will be lost.`))) return;
            const r = await dropTable(conn, table);
            if (r.ok) { toast(`"${table}" deleted`, 'ok'); nav(base, { replace: true }); } else toast(`Delete failed: ${errorText(r)}`, 'err');
          }}>DROP TABLE</button>
        </div>
      </div>
      {adding && <AddColumnModal table={table} d={d} onClose={() => setAdding(false)} onAdd={(sqls) => run(sqls, 'Column added')} />}
      {altering && <AlterColumnModal table={table} col={altering} d={d} onClose={() => setAltering(null)} onRun={(sqls) => run(sqls, `Column "${altering.name}" updated`)} />}
      {confirmEl}{promptEl}
    </>
  );
}

/** Table-level constraint lines of a CREATE TABLE statement. */
function tableConstraints(sql: string): string[] {
  const create = sql.split(/;\s*\n/)[0];
  return create.split('\n').map((l) => l.trim().replace(/,$/, '')).filter((l) => /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/i.test(l));
}

/** The table's CREATE TABLE / CREATE INDEX statements renamed for a copy (BangDB, SQLite). */
function copyDdl(sql: string, from: string, to: string, d: Dialect): string[] {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean).map((s, i) => {
    if (i === 0) return s.replace(new RegExp(`^CREATE TABLE\\s+("?${esc}"?)`, 'i'), `CREATE TABLE ${d.qt(to)}`);
    return s.replace(new RegExp(`^CREATE (UNIQUE )?INDEX\\s+("?)([^"\\s]+)\\2\\s+ON\\s+("?${esc}"?)`, 'i'), (_m, u, _q, name) => `CREATE ${u ?? ''}INDEX ${d.q(`${name}_${to}`)} ON ${d.qt(to)}`);
  });
}

// ---------------------------------------------------------------- indexes

function IndexTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const idx = info.indexes ?? [];
  const ts = info.store === 'timeseries';
  return (
    <>
      <div className="card">
        <b>Indexes ({idx.length})</b>
        <div className="list" style={{ marginTop: 8 }}>
          {idx.map((i) => (
            <div key={i.name} className="item">
              <div className="grow">
                <div className="title mono">{i.name}{i.unique && <span className="badge warn" style={{ marginLeft: 6 }}>UNIQUE</span>}{i.auto && <span className="badge" style={{ marginLeft: 6 }}>Auto (PK/UNIQUE constraint)</span>}</div>
                <div className="sub mono">({(i.columns ?? [i.column]).join(', ')}){(i as { stats?: number[] }).stats?.length ? ` · Stats: ${(i as { stats?: number[] }).stats!.map((s) => s.toFixed(1)).join(' / ')}` : ''}</div>
              </div>
              {!i.auto && <button className="btn sm danger" onClick={async () => {
                if (!(await confirm(`Delete index "${i.name}"?`))) return;
                const r = await dropIndex(conn, i.name, table);
                toast(r.ok ? 'Index deleted' : `Failed: ${errorText(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onChanged();
              }}>Delete</button>}
            </div>
          ))}
          {!idx.length && <div className="muted small">No indexes</div>}
        </div>
      </div>
      {ts ? <p className="muted small">Time-series tables do not support secondary indexes — time conditions are handled by a time-range scan.</p> : (
        <CreateIndexForm table={table} columns={info.columns ?? []} d={dialectOf(conn)} onCreate={async (sql) => {
          const r = await goQuery(conn, sql, undefined, { mode: 'exec' });
          toast(r.ok ? 'Index created' : `Failed: ${errorText(r)}`, r.ok ? 'ok' : 'err');
          if (r.ok) onChanged();
          return r.ok;
        }} />
      )}
      <p className="muted small">Check whether an index is used with EXPLAIN in the SQL console. Indexes are recommended on foreign key columns.</p>
      {confirmEl}
    </>
  );
}

// ---------------------------------------------------------------- import / export

function TransferTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const isView = info.kind === 'view';
  const [fmt, setFmt] = useState<'csv' | 'json' | 'jsonl' | 'sql'>('csv');
  const [where, setWhere] = useState('');
  const [exporting, setExporting] = useState('');

  async function doExport() {
    setExporting('Reading…');
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      if (fmt === 'sql' && !where.trim()) {
        downloadText(`${table}-${stamp}.sql`, await dumpSql(conn, setExporting, [table]), 'application/sql');
      } else {
        const d = dialectOf(conn);
        const ident = identityOf(d, info);
        const order = ident?.kind === 'rowid' ? ident.expr : ident?.kind === 'pk' ? ident.columns.map(d.q).join(', ') : undefined;
        const { columns, rows } = await readAll(conn, table, (n) => setExporting(`${n} rows read…`), 500, where, order);
        const docs = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
        if (fmt === 'csv') downloadText(`${table}-${stamp}.csv`, '﻿' + toCsv(docs), 'text/csv');
        else if (fmt === 'json') downloadText(`${table}-${stamp}.json`, JSON.stringify(docs, null, 2));
        else if (fmt === 'jsonl') downloadText(`${table}-${stamp}.jsonl`, docs.map((x) => JSON.stringify(x)).join('\n'));
        else downloadText(`${table}-${stamp}.sql`, rows.map((r) => `INSERT INTO ${d.qt(table)} (${columns.map(d.q).join(', ')}) VALUES (${r.map(d.literal).join(', ')});`).join('\n'), 'application/sql');
        toast(`${docs.length} rows exported`, 'ok');
      }
    } catch (e) { toast((e as Error).message, 'err'); } finally { setExporting(''); }
  }

  return (
    <>
      <div className="card">
        <b>Export</b>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <div className="seg">
            {(['csv', 'json', 'jsonl', 'sql'] as const).map((f) => <button key={f} className={fmt === f ? 'on' : ''} onClick={() => setFmt(f)}>{f.toUpperCase()}</button>)}
          </div>
          <input className="inp mono grow" placeholder="WHERE clause (optional, blank for all rows)" value={where} onChange={(e) => setWhere(e.target.value)} />
          <button className="btn primary sm" disabled={!!exporting} onClick={doExport}>{exporting || 'Export'}</button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>{fmt === 'sql' ? (where.trim() ? 'Generates INSERT statements for the matching rows.' : `Generates the CREATE TABLE and index definitions plus INSERT statements for all rows. It can be restored on another ${dialectOf(conn).label} with "Run SQL script".`) : 'Reads everything in batches of 500 rows, regardless of the server row limit.'}</p>
      </div>
      {!isView && <ImportCard conn={conn} table={table} info={info} onChanged={onChanged} />}
    </>
  );
}

function ImportCard({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [emptyNull, setEmptyNull] = useState(true);
  const [dropUnknown, setDropUnknown] = useState(true);
  const [mode, setMode] = useState<InsertMode>('insert');
  const [prog, setProg] = useState<(BulkProgress & { running: boolean }) | null>(null);
  const stop = useRef(false);

  const parsed = useMemo((): { docs: Record<string, unknown>[]; kind: string; error?: string } => {
    const t = text.trim();
    if (!t) return { docs: [], kind: '' };
    try {
      if (t.startsWith('[') || t.startsWith('{')) return { docs: parseDocuments(t), kind: 'JSON' };
      return { docs: csvToDocs(t, { emptyAsNull: emptyNull }), kind: t.split(/\r?\n/, 1)[0].includes('\t') ? 'TSV' : 'CSV' };
    } catch (e) { return { docs: [], kind: '', error: (e as Error).message }; }
  }, [text, emptyNull]);

  const known = new Set((info.columns ?? []).map((c) => c.name.toLowerCase()));
  const keys = useMemo(() => { const s = new Set<string>(); parsed.docs.forEach((d) => Object.keys(d).forEach((k) => s.add(k))); return [...s]; }, [parsed.docs]);
  const unknown = keys.filter((k) => !known.has(k.toLowerCase()));

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) setText(await f.text());
  }

  async function run() {
    let docs = parsed.docs;
    if (dropUnknown && unknown.length) docs = docs.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => known.has(k.toLowerCase()))));
    stop.current = false;
    setProg({ done: 0, total: docs.length, inserted: 0, running: true });
    const p = await bulkInsert(conn, table, docs, { mode, batch: 200, onProgress: (x) => setProg({ ...x, running: true }), shouldStop: () => stop.current });
    setProg({ ...p, running: false });
    onChanged();
    toast(p.error ? `Stopped after ${p.done} rows: ${p.error}` : `${p.inserted.toLocaleString()} rows imported`, p.error ? 'err' : 'ok');
  }

  return (
    <div className="card">
      <b>Import</b>
      <p className="muted small">Paste CSV/TSV (first line = column names), a JSON array or JSON Lines, or choose a file. Rows are sent as multi-row INSERTs in batches of 200; each batch is applied atomically.</p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="btn sm">Choose file<input type="file" accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson" style={{ display: 'none' }} onChange={pick} /></label>
        <div className="seg">
          {([['insert', 'INSERT'], ['ignore', 'Skip duplicates'], ['replace', 'Overwrite duplicates']] as [InsertMode, string][])
            .filter(([m]) => insertModes(dialectOf(conn)).includes(m))
            .map(([m, l]) => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{l}</button>)}
        </div>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} /> Empty cells as NULL</label>
      </div>
      <textarea className="inp mono" style={{ width: '100%', minHeight: 120 }} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
        placeholder={`${(info.columns ?? []).filter((c) => !(c.pk && affinity(c) === 'INTEGER')).map((c) => c.name).join(',')}\n...`} />
      {parsed.error && <p className="danger small">{parsed.error}</p>}
      {parsed.docs.length > 0 && (
        <>
          <p className="small">{parsed.kind} · <b>{parsed.docs.length.toLocaleString()} rows</b> · {keys.length} columns — preview (first 5 rows)</p>
          <DataTable rows={parsed.docs.slice(0, 5)} />
          {unknown.length > 0 && (
            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={dropUnknown} onChange={(e) => setDropUnknown(e.target.checked)} />
              <span className="warn small">Skip columns not in the table: {unknown.join(', ')}</span></label>
          )}
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={!parsed.docs.length || prog?.running} onClick={run}>Import</button>
        {prog?.running && <button className="btn" onClick={() => { stop.current = true; }}>Stop</button>}
        {prog && <span className="small">{prog.done.toLocaleString()}/{prog.total.toLocaleString()} processed · {prog.inserted.toLocaleString()} inserted</span>}
      </div>
      {prog && prog.total > 0 && <div className="progress"><div style={{ width: `${(prog.done / prog.total) * 100}%`, background: prog.error ? 'var(--warn)' : undefined }} /></div>}
      {prog?.error && <pre className="out">{prog.error}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- DDL

function DdlTab({ conn, table, info, base, onChanged }: TabProps & { base: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const { confirm, confirmEl } = useConfirm();
  const [editView, setEditView] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null);
  const isView = info.kind === 'view';
  const d = dialectOf(conn);
  const select = isView ? viewSelect(info.sql ?? '') : '';
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(info.sql ?? ''); toast('Copied', 'ok'); }}>Copy</button>
        {isView && <button className="btn sm" onClick={() => setEditView(true)}>Edit view</button>}
        {isView && <button className="btn sm danger" onClick={async () => {
          if (!(await confirm(`Drop view "${table}"? (The underlying data is not affected.)`))) return;
          const r = await dropView(conn, table);
          if (r.ok) { toast('View dropped', 'ok'); nav(base, { replace: true }); } else toast(`Failed: ${errorText(r)}`, 'err');
        }}>DROP VIEW</button>}
      </div>
      <pre className="out">{info.sql}</pre>
      {editView && (
        <CreateViewModal replace initialName={table} initialSelect={select} d={d} onClose={() => setEditView(false)}
          onPreview={async (s) => { const r = await goQuery(conn, s, undefined, { limit: 5 }); if (r.ok) setPreview(goRows(r.data)); else toast(errorText(r), 'err'); }}
          onCreate={async (sql) => {
            const r = await execStatements(conn, d.replaceView ? [sql] : [`DROP VIEW ${d.qt(table)}`, sql]);
            if (!r.ok) { toast(`Failed: ${errorText(r)}`, 'err'); return false; }
            toast('View saved', 'ok'); onChanged(); return true;
          }} />
      )}
      {preview && <Modal title="Preview (5 rows)" onClose={() => setPreview(null)} wide><DataTable rows={preview} /></Modal>}
      {confirmEl}
    </>
  );
}

