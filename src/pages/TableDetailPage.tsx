import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { addIndex, delDoc, dropIndex, extractRows, getDoc, putDoc, rowCount, sql, tableInfo } from '../api/bangdb';
import { docKey, downloadText, parseDocuments, toCsv } from '../api/data';
import type { ApiResult, GoTableInfo, IndexSpec } from '../api/types';
import { deleteRow, primaryKeyColumns, updateRow } from '../api/goapi';
import { TopBar } from '../components/Layout';
import { DataTable, Field, JsonOut, Modal, ResultBadge, describeResult, useConfirm, useToast } from '../components/ui';
import { useConnection } from '../store/store';

type Tab = 'browse' | 'put' | 'import' | 'key' | 'index' | 'info';

export default function TableDetailPage() {
  const { connId, db = '', table = '' } = useParams();
  const conn = useConnection(connId);
  const [tab, setTab] = useState<Tab>('browse');
  const [count, setCount] = useState<ApiResult<{ count?: number }> | null>(null);
  const [info, setInfo] = useState<GoTableInfo | undefined>(undefined);

  const loadCount = useCallback(async () => { if (conn) setCount(await rowCount(conn, db, table)); }, [conn, db, table]);
  useEffect(() => { loadCount(); }, [loadCount]);
  useEffect(() => {
    if (conn?.kind === 'go') tableInfo(conn, db, table).then((r) => setInfo(r.ok ? (r.data as GoTableInfo) : undefined));
  }, [conn, db, table]);

  if (!conn) return <div className="empty">Connection not found.</div>;
  const pk = primaryKeyColumns(info);
  const n = count?.ok && count.data && typeof count.data === 'object' ? (count.data as { count?: number }).count : undefined;

  return (
    <>
      <TopBar title={table} crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: `/c/${conn.id}/db/${encodeURIComponent(db)}`, label: db }, { label: 'Table' }]}
        right={<span className="badge">{count ? (count.ok ? `${n ?? '?'} rows` : 'Count failed') : '…'}</span>} />
      <div className="tabs">
        {([['browse', 'Browse'], ['put', conn.kind === 'go' ? 'Insert row' : 'Insert document'], ['import', 'Import'], ['key', 'Lookup / delete by key'], ['index', 'Indexes'], ['info', 'Info']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'browse' && <Browse conn={conn} db={db} table={table} onDone={loadCount} pk={pk} />}
      {tab === 'put' && <PutDoc conn={conn} db={db} table={table} onDone={loadCount} pk={pk} info={info} />}
      {tab === 'import' && <ImportDocs conn={conn} db={db} table={table} onDone={loadCount} pk={pk} />}
      {tab === 'key' && <KeyOps conn={conn} db={db} table={table} onDone={loadCount} pk={pk} />}
      {tab === 'index' && <IndexOps conn={conn} db={db} table={table} pk={pk} info={info} onDone={() => tableInfo(conn, db, table).then((r) => setInfo(r.ok ? (r.data as GoTableInfo) : undefined))} />}
      {tab === 'info' && <Info conn={conn} db={db} table={table} pk={pk} info={info} />}
    </>
  );
}

type P = { conn: NonNullable<ReturnType<typeof useConnection>>; db: string; table: string; onDone?: () => void; pk: string[]; info?: GoTableInfo };

function Browse({ conn, db, table, onDone, pk }: P) {
  const [limit, setLimit] = useState(50);
  const [where, setWhere] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Record<string, unknown> | null>(null);
  const toast = useToast();
  async function run() {
    setBusy(true);
    const stmt = `select * from ${table}${where.trim() ? ` where ${where.trim()}` : ''} limit ${limit}`;
    setRes(await sql(conn, db, stmt));
    setBusy(false);
  }
  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);
  const rows = res?.ok ? extractRows(res.data) : [];
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <input className="grow mono" placeholder="WHERE condition (optional), e.g. age > 30" value={where} onChange={(e) => setWhere(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} style={inp} />
        <input type="number" className="mono" value={limit} min={1} max={10000} onChange={(e) => setLimit(Number(e.target.value) || 50)} style={{ ...inp, width: 90 }} />
        <button className="btn primary sm" onClick={run} disabled={busy}>{busy ? '…' : 'Load'}</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> JSON</label>
        <ResultBadge r={res} />
        {rows.length > 0 && (
          <>
            <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.json`, JSON.stringify(rows, null, 2))}>Save JSON</button>
            <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.csv`, '﻿' + toCsv(rows), 'text/csv')}>Save CSV</button>
          </>
        )}
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res?.ok && (raw ? <JsonOut value={res.data} /> : <DataTable rows={rows} onRowClick={(r) => setSel(r)} />)}
      {res?.ok && !raw && rows.length > 0 && <p className="muted small">{conn.kind === 'go' && !pk.length ? 'This table has no primary key; edit or delete rows in the SQL console.' : 'Click a row to edit or delete it.'}</p>}
      {res?.ok && (res.data as { truncated?: boolean })?.truncated && <p className="warn small">Results were truncated by the server row limit.</p>}
      {sel && (
        <RowModal doc={sel} onClose={() => setSel(null)} keyLabel={conn.kind === 'go' ? (pk.length ? sel[pk[0]] : undefined) : undefined} canDelete={conn.kind === 'rest' || pk.length > 0}
          onSave={async (doc) => {
            try {
              const r = conn.kind === 'go' ? await updateRow(conn, table, doc, sel, pk) : await putDoc(conn, db, table, doc);
              toast(r.ok ? 'Saved' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
              if (r.ok) { setSel(null); run(); onDone?.(); }
            } catch (e) { toast((e as Error).message, 'err'); }
          }}
          onDelete={async (key) => {
            try {
              const r = conn.kind === 'go' ? await deleteRow(conn, table, sel, pk) : await delDoc(conn, db, table, key);
              toast(r.ok ? 'Deleted' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
              if (r.ok) { setSel(null); run(); onDone?.(); }
            } catch (e) { toast((e as Error).message, 'err'); }
          }} />
      )}
    </>
  );
}

function RowModal({ doc, onClose, onSave, onDelete, keyLabel, canDelete = true }: { doc: Record<string, unknown>; onClose: () => void; onSave: (d: Record<string, unknown>) => Promise<void>; onDelete: (key: string) => Promise<void>; keyLabel?: unknown; canDelete?: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [busy, setBusy] = useState(false);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();
  const key = keyLabel !== undefined ? String(keyLabel) : docKey(doc);
  return (
    <Modal title={key !== undefined ? `Row ${key}` : 'Row'} onClose={onClose}>
      <Field label="JSON (saving updates the row by its primary key)"><textarea className="mono" value={text} rows={12} spellCheck={false} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="actions">
        {key !== undefined && canDelete && (
          <button className="btn danger" disabled={busy} onClick={async () => {
            if (!(await confirm(`Delete the document with key "${key}"?`))) return;
            setBusy(true); try { await onDelete(key); } finally { setBusy(false); }
          }}>Delete</button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          let d: Record<string, unknown>;
          try { d = parseDocuments(text)[0]; if (!d) throw new Error('Empty'); } catch (e) { toast(`JSON error: ${(e as Error).message}`, 'err'); return; }
          setBusy(true); try { await onSave(d); } finally { setBusy(false); }
        }}>Save</button>
      </div>
      {confirmEl}
    </Modal>
  );
}

function ImportDocs({ conn, db, table, onDone }: P) {
  const needsPk = conn.kind === 'rest';
  const [text, setText] = useState('');
  const [stopOnError, setStopOnError] = useState(true);
  const [prog, setProg] = useState<{ done: number; total: number; failed: number; running: boolean; errors: string[] } | null>(null);
  const toast = useToast();
  const stopRef = useState({ stop: false })[0];

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
    e.target.value = '';
  }

  async function run() {
    let docs: Record<string, unknown>[];
    try { docs = parseDocuments(text); } catch (e) { toast(`Parse error: ${(e as Error).message}`, 'err'); return; }
    if (!docs.length) { toast('No documents to import', 'err'); return; }
    const missing = needsPk ? docs.findIndex((d) => docKey(d) === undefined) : -1;
    if (missing >= 0) { toast(`Document ${missing + 1} has no _pk`, 'err'); return; }
    stopRef.stop = false;
    const st = { done: 0, total: docs.length, failed: 0, running: true, errors: [] as string[] };
    setProg({ ...st });
    for (const d of docs) {
      if (stopRef.stop) break;
      const r = await putDoc(conn, db, table, d);
      st.done++;
      if (!r.ok) {
        st.failed++;
        if (st.errors.length < 20) st.errors.push(`${docKey(d) ?? st.done}: ${describeResult(r)}`);
        if (stopOnError) break;
      }
      setProg({ ...st });
    }
    st.running = false;
    setProg({ ...st });
    onDone?.();
    toast(st.failed ? `Done: ${st.done - st.failed} succeeded, ${st.failed} failed` : `${st.done} imported`, st.failed ? 'err' : 'ok');
  }

  return (
    <>
      <p className="muted small">Paste a JSON array, one object per line (JSON Lines), or a single object, or choose a file. {needsPk ? <>Each document must have a <code>_pk</code>; documents are sent one at a time via POST doc.</> : 'Object keys become column names; rows are inserted one at a time.'}</p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="btn sm">Choose file<input type="file" accept=".json,.jsonl,.ndjson,.txt,application/json" style={{ display: 'none' }} onChange={pick} /></label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> Stop on error</label>
      </div>
      <Field label="Documents"><textarea className="mono" value={text} rows={10} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={'[{"_pk":"u1","name":"a"},{"_pk":"u2","name":"b"}]'} /></Field>
      <div className="row">
        <button className="btn primary" disabled={prog?.running || !text.trim()} onClick={run}>Import</button>
        {prog?.running && <button className="btn" onClick={() => { stopRef.stop = true; }}>Stop</button>}
        {prog && <span className="small">{prog.done}/{prog.total} processed, {prog.failed} failed</span>}
      </div>
      {prog && prog.total > 0 && (
        <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, margin: '10px 0', overflow: 'hidden' }}>
          <div style={{ width: `${(prog.done / prog.total) * 100}%`, height: '100%', background: prog.failed ? 'var(--warn)' : 'var(--accent)' }} />
        </div>
      )}
      {prog && prog.errors.length > 0 && <pre className="out">{prog.errors.join('\n')}</pre>}
    </>
  );
}

function PutDoc({ conn, db, table, onDone, info }: P) {
  const [text, setText] = useState(() => {
    if (conn.kind === 'go' && info?.columns?.length) {
      const o: Record<string, unknown> = {};
      info.columns.forEach((c) => { if (!(c.pk && (c.autoinc || (c.decl ?? c.type ?? '').toUpperCase().startsWith('INT')))) o[c.name] = (c.type === 'INTEGER' || c.type === 'REAL') ? 0 : ''; });
      return JSON.stringify(o, null, 2);
    }
    return '{\n  "_pk": "key1",\n  "name": "example"\n}';
  });
  const [res, setRes] = useState<ApiResult | null>(null);
  const toast = useToast();
  async function submit() {
    let body: unknown;
    try { body = JSON.parse(text); } catch (e) { toast(`JSON error: ${(e as Error).message}`, 'err'); return; }
    const r = await putDoc(conn, db, table, body);
    setRes(r);
    toast(r.ok ? 'Saved' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
    if (r.ok) onDone?.();
  }
  return (
    <>
      {conn.kind === 'go'
        ? <p className="muted small">JSON object keys become column names (INSERT). Leave auto-increment primary keys out. Nested objects/arrays are stored as JSON strings.</p>
        : <p className="muted small">"_pk" is the primary key. Use a string for NORMAL_KEY tables and an integer for NORMAL_KEY_LONG tables.</p>}
      <Field label="Document (JSON)"><textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></Field>
      <div className="row"><button className="btn primary" onClick={submit}>{conn.kind === 'go' ? 'Save (INSERT)' : 'Save (POST doc)'}</button><ResultBadge r={res} /></div>
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

function KeyOps({ conn, db, table, onDone, pk }: P) {
  const [key, setKey] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();
  return (
    <>
      <Field label={conn.kind === 'go' ? `Primary key (${pk[0] ?? 'none'})` : 'Primary key (_pk)'}><input className="mono" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
      <div className="row wrap">
        <button className="btn" disabled={!key || (conn.kind === 'go' && !pk.length)} onClick={async () => { try { setRes(await getDoc(conn, db, table, key, pk)); } catch (e) { toast((e as Error).message, 'err'); } }}>Lookup (GET)</button>
        <button className="btn danger" disabled={!key || (conn.kind === 'go' && !pk.length)} onClick={async () => {
          if (!(await confirm(`Delete the row with key "${key}"?`))) return;
          try {
            const r = await delDoc(conn, db, table, key, pk); setRes(r);
            toast(r.ok ? 'Deleted' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onDone?.();
          } catch (e) { toast((e as Error).message, 'err'); }
        }}>Delete (DELETE)</button>
        <ResultBadge r={res} />
      </div>
      {conn.kind === 'go'
        ? <p className="muted small">{pk.length ? `Runs as SELECT/DELETE … WHERE ${pk[0]} = ?.` : 'This table has no primary key. Use the SQL console.'}</p>
        : <p className="muted small">The key-based GET/DELETE paths are assumptions not confirmed by the documentation. If you get a 404, adjust the getDoc/delDoc paths under Edit server → Advanced. You can also look up a row with SQL (where _pk = '...') on the "Browse" tab.</p>}
      {res && (conn.kind === 'go' && res.ok && extractRows(res.data).length ? <DataTable rows={extractRows(res.data)} /> : <JsonOut value={res.data ?? res.error} />)}
      {confirmEl}
    </>
  );
}

function IndexOps({ conn, db, table, info, onDone }: P) {
  const [s, setS] = useState<IndexSpec>({ idx_name: '', idx_type: 'SIMPLE', key_type: 'NORMAL_KEY', allow_duplicate: true });
  const [dropName, setDropName] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const toast = useToast();
  const up = (p: Partial<IndexSpec>) => setS((x) => ({ ...x, ...p }));
  if (conn.kind === 'go') {
    const idx = (info?.indexes ?? []);
    return (
      <>
        <div className="card">
          <b>Indexes ({idx.length})</b>
          <div className="list" style={{ marginTop: 8 }}>
            {idx.map((i) => (
              <div key={i.name} className="item">
                <div className="grow"><div className="title mono">{i.name}{i.unique && <span className="badge" style={{ marginLeft: 6 }}>UNIQUE</span>}{i.auto && <span className="badge" style={{ marginLeft: 6 }}>auto</span>}</div><div className="sub mono">{(i.columns ?? [i.column]).join(', ')}</div></div>
                {!i.auto && <button className="btn sm danger" onClick={async () => { const r = await dropIndex(conn, db, table, i.name); setRes(r); toast(r.ok ? 'Deleted' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onDone?.(); }}>Delete</button>}
              </div>
            ))}
            {!idx.length && <div className="muted small">No indexes</div>}
          </div>
        </div>
        <div className="card">
          <b>Add index</b>
          <Field label="Columns (comma-separated for multiple)"><input className="mono" value={s.idx_name} placeholder="age or city, age" onChange={(e) => up({ idx_name: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={s.allow_duplicate === false} onChange={(e) => up({ allow_duplicate: !e.target.checked })} /> UNIQUE</label>
          <button className="btn primary" disabled={!s.idx_name.trim()} onClick={async () => { const r = await addIndex(conn, db, table, s); setRes(r); toast(r.ok ? 'Index added' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) { up({ idx_name: '' }); onDone?.(); } }}>CREATE INDEX</button>
        </div>
        <ResultBadge r={res} />
        {res && !res.ok && <JsonOut value={res.data ?? res.error} />}
      </>
    );
  }
  return (
    <>
      <div className="card">
        <b>Add index</b>
        <div className="grid2" style={{ marginTop: 8 }}>
          <Field label="Field / index name (e.g. name or addr.city)"><input className="mono" value={s.idx_name} onChange={(e) => up({ idx_name: e.target.value })} /></Field>
          <Field label="Type"><select value={s.idx_type} onChange={(e) => up({ idx_type: e.target.value as IndexSpec['idx_type'] })}><option>SIMPLE</option><option>NESTED</option><option>COMPOSITE</option><option>GEO</option></select></Field>
          <Field label="Key type"><select value={s.key_type} onChange={(e) => up({ key_type: e.target.value as IndexSpec['key_type'] })}><option value="NORMAL_KEY">NORMAL_KEY (string)</option><option value="NORMAL_KEY_LONG">NORMAL_KEY_LONG (integer)</option></select></Field>
        </div>
        <label className="check"><input type="checkbox" checked={s.allow_duplicate} onChange={(e) => up({ allow_duplicate: e.target.checked })} /> Allow duplicates</label>
        <button className="btn primary" disabled={!s.idx_name.trim()} onClick={async () => { const r = await addIndex(conn, db, table, { ...s, idx_name: s.idx_name.trim() }); setRes(r); toast(r.ok ? 'Index added' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); }}>Add (POST index)</button>
      </div>
      <div className="card">
        <b>Delete index</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="grow mono" placeholder="Index name" value={dropName} onChange={(e) => setDropName(e.target.value)} style={inp} />
          <button className="btn danger sm" disabled={!dropName.trim()} onClick={async () => { const r = await dropIndex(conn, db, table, dropName.trim()); setRes(r); toast(r.ok ? 'Deleted' : `Failed: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); }}>Delete</button>
        </div>
      </div>
      <ResultBadge r={res} />
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

function Info({ conn, db, table, info, pk }: P) {
  const [res, setRes] = useState<ApiResult | null>(null);
  useEffect(() => { if (conn.kind === 'rest') tableInfo(conn, db, table).then(setRes); }, [conn, db, table]);
  if (conn.kind === 'go') {
    if (!info) return <div className="empty">Could not load table info.</div>;
    return (
      <>
        <div className="row wrap" style={{ marginBottom: 8 }}><span className="badge">{info.kind === 'view' ? 'View' : 'Table'}</span>{pk.length > 0 && <span className="badge">PK: {pk.join(', ')}</span>}</div>
        {info.columns && <DataTable rows={info.columns.map((c) => ({ Column: c.name, Type: c.decl ?? c.type ?? '', 'NOT NULL': c.notNull ? '✔' : '', PK: c.pk ? '✔' : '', UNIQUE: c.unique ? '✔' : '', DEFAULT: c.default ?? '' }))} />}
        <div className="muted small" style={{ margin: '12px 0 4px' }}>Definition</div>
        <pre className="out">{info.sql}</pre>
      </>
    );
  }
  return (
    <>
      <div className="row"><ResultBadge r={res} /><span className="muted small">GET tableInfo (assumed path; may be unsupported by the server)</span></div>
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

const inp: React.CSSProperties = { padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)' };
