import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { countWhere, dropTable, dropView, errorText, goQuery, goRows, goTables } from '../api/goapi';
import type { GoTableInfo } from '../api/types';
import { TopBar } from '../components/Layout';
import { Icons } from '../components/kinds';
import { CreateTableModal, CreateViewModal } from '../components/SchemaForms';
import { DataTable, Modal, useConfirm, useToast } from '../components/ui';
import { useDbConnection } from '../store/store';
import { dialectOf, viewSelect } from '../api/dialect';

/** Tables and views of a SQL database (BangDB or one reached through the gateway). */
export default function GoTablesPage() {
  const { connId, db = '' } = useParams();
  const conn = useDbConnection(connId, db);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [tables, setTables] = useState<GoTableInfo[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<'table' | 'view' | null>(null);
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    const r = await goTables(conn);
    setLoading(false);
    if (!r.ok) { setErr(errorText(r)); setTables([]); return; }
    setErr('');
    setTables(r.data.tables);
    const out: Record<string, number | undefined> = {};
    await Promise.all(r.data.tables.filter((t) => t.kind === 'table').map(async (t) => { out[t.name] = await countWhere(conn, t.name); }));
    setCounts(out);
  }, [conn]);
  useEffect(() => { load(); }, [load]);

  if (!conn) return <div className="empty">Connection not found.</div>;
  const base = `/c/${conn.id}/db/${encodeURIComponent(db)}`;
  const shown = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const nT = tables.filter((t) => t.kind === 'table').length;

  async function drop(t: GoTableInfo) {
    if (!conn) return;
    const view = t.kind === 'view';
    if (!(await confirm(view ? `Drop view "${t.name}".` : `Drop table "${t.name}". All data will be lost.`))) return;
    const r = view ? await dropView(conn, t.name) : await dropTable(conn, t.name);
    if (r.ok) { toast(`"${t.name}" deleted`, 'ok'); load(); } else toast(`Delete failed: ${errorText(r)}`, 'err');
  }

  async function create(sql: string, name: string): Promise<boolean> {
    if (!conn) return false;
    const r = await goQuery(conn, sql, undefined, { mode: 'exec' });
    if (!r.ok) { toast(`Failed: ${errorText(r)}`, 'err'); return false; }
    toast(`"${name}" created`, 'ok');
    await load();
    if (name) nav(`${base}/t/${encodeURIComponent(name)}`);
    return true;
  }

  return (
    <>
      <TopBar title={conn.db && conn.kind !== 'sqlite' ? db : 'Tables'} crumbs={[{ to: '/connections', label: 'Servers' }, { to: `/c/${conn.id}/dbs`, label: conn.name }]}
        right={<>
          <button className="btn sm" onClick={() => nav(`${base}/query`)}>SQL</button>
          <button className="btn sm" onClick={() => setCreating('view')}>+ View</button>
          <button className="btn primary sm" onClick={() => setCreating('table')}>+ Table</button>
        </>} />
      <div className="toolbar">
        <input className="inp filter" placeholder="Search tables and views" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted small">{nT} tables · {tables.length - nT} views</span>
        <button className="btn ghost icon sm" onClick={load} disabled={loading} title="Refresh" aria-label="Refresh">{loading ? <span className="spin" /> : Icons.refresh}</button>
      </div>
      {err && <div className="card danger">{err}</div>}
      {!err && !loading && tables.length === 0 && (
        <div className="card">
          <p><b>No tables.</b></p>
          <p className="muted small">Create one with "+ Table" by choosing columns and constraints, or restore a dump with "Run SQL script" on the server page.</p>
          <button className="btn primary" onClick={() => setCreating('table')}>+ Create table</button>
        </div>
      )}
      <div className="list">
        {shown.map((t) => (
          <div key={t.name} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`${base}/t/${encodeURIComponent(t.name)}`)}>
              <div className="title mono">
                {t.name}
                {t.kind === 'view' && <span className="badge accent" style={{ marginLeft: 8 }}>View</span>}
                {t.store === 'memory' && <span className="badge accent" style={{ marginLeft: 8 }}>In-memory</span>}
                {t.store === 'timeseries' && <span className="badge accent" style={{ marginLeft: 8 }}>Time series</span>}
              </div>
              <div className="sub">
                {t.kind === 'view'
                  ? viewSelect(t.sql ?? '').replace(/\s+/g, ' ').slice(0, 120)
                  : `${t.columns?.length ?? 0} columns · ${(t.indexes ?? []).filter((i) => !i.auto).length} indexes · ${counts[t.name] === undefined ? '…' : `${counts[t.name]!.toLocaleString()} rows`} — ${(t.columns ?? []).map((c) => c.name).join(', ')}`}
              </div>
            </div>
            <button className="btn ghost icon sm danger" onClick={() => drop(t)} title="Delete" aria-label="Delete">{Icons.trash}</button>
            <span className="chev" onClick={() => nav(`${base}/t/${encodeURIComponent(t.name)}`)}>{Icons.chevron}</span>
          </div>
        ))}
      </div>
      <button className="fab" onClick={() => setCreating('table')} aria-label="Create table">+</button>
      {creating === 'table' && <CreateTableModal tables={tables} d={dialectOf(conn)} onClose={() => setCreating(null)} onCreate={create} />}
      {creating === 'view' && (
        <CreateViewModal d={dialectOf(conn)} onClose={() => setCreating(null)} onCreate={create}
          onPreview={async (s) => { const r = await goQuery(conn, s, undefined, { limit: 5 }); if (r.ok) setPreview(goRows(r.data)); else toast(errorText(r), 'err'); }} />
      )}
      {preview && <Modal title="Preview (5 rows)" onClose={() => setPreview(null)} wide><DataTable rows={preview} /></Modal>}
      {confirmEl}
    </>
  );
}
