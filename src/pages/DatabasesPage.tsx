import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createDb, dropDb, extractTables, listTables, serverStats } from '../api/bangdb';
import type { ApiResult } from '../api/types';
import { TopBar } from '../components/Layout';
import { Field, JsonOut, Modal, ResultBadge, describeResult, useConfirm, useToast } from '../components/ui';
import { store, useConnection } from '../store/store';

export default function DatabasesPage() {
  const { connId } = useParams();
  const conn = useConnection(connId);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [adding, setAdding] = useState<null | 'create' | 'register'>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<string, number | 'err'>>({});
  const [stats, setStats] = useState<ApiResult | null | 'loading'>(null);

  if (!conn) return <div className="empty">Connection not found. <a href="#/connections">Server list</a></div>;

  async function refresh() {
    if (!conn) return;
    const out: Record<string, number | 'err'> = {};
    await Promise.all(conn.databases.map(async (db) => {
      const r = await listTables(conn, db);
      out[db] = r.ok ? extractTables(r.data).length : 'err';
    }));
    setCounts(out);
  }

  async function submit() {
    if (!conn || !name.trim()) return;
    const db = name.trim();
    setBusy(true);
    try {
      if (adding === 'create') {
        const r = await createDb(conn, db);
        if (!r.ok) { toast(`Failed to create DB: ${describeResult(r)}`, 'err'); return; }
        toast(`DB "${db}" created`, 'ok');
      }
      store.addDatabase(conn.id, db);
      setAdding(null); setName('');
    } finally { setBusy(false); }
  }

  async function drop(db: string) {
    if (!conn) return;
    if (!(await confirm(`This will DROP database "${db}" on the server. All tables and data will be lost. Continue?`))) return;
    const r = await dropDb(conn, db);
    if (!r.ok) { toast(`Delete failed: ${describeResult(r)}`, 'err'); return; }
    store.removeDatabase(conn.id, db);
    toast(`DB "${db}" deleted`, 'ok');
  }

  return (
    <>
      <TopBar title="Databases" crumbs={[{ to: '/connections', label: 'Servers' }, { label: conn.name }]}
        right={<><button className="btn sm ghost" onClick={async () => { setStats('loading'); setStats(await serverStats(conn)); }}>Server stats</button><button className="btn sm" onClick={refresh}>Refresh</button>{conn.kind === 'rest' && <button className="btn primary sm" onClick={() => setAdding('create')}>+ Create</button>}</>} />
      {conn.kind === 'go'
        ? <p className="muted small">A BangDB (Go) server serves a single file. Open the item below to manage its tables.</p>
        : <p className="muted small">A BangDB server usually serves the single DB set in bangdb.config. This list holds the DB names registered in this app; "Register" only adds a DB that already exists on the server to the list.</p>}
      <div className="list">
        {conn.databases.map((db) => (
          <div key={db} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}`)}>
              <div className="title">{db}{db === conn.defaultDb && <span className="badge" style={{ marginLeft: 8 }}>Default</span>}</div>
              <div className="sub">{counts[db] === undefined ? 'Table count: press Refresh' : counts[db] === 'err' ? <span className="danger">Load failed</span> : `${counts[db]} table(s)`}</div>
            </div>
            <button className="btn sm" onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}/query`)}>SQL</button>
            {conn.kind === 'rest' && <button className="btn sm ghost" title="Remove from the list only" onClick={() => store.removeDatabase(conn.id, db)}>Hide</button>}
            {conn.kind === 'rest' && <button className="btn sm danger" onClick={() => drop(db)}>DROP</button>}
          </div>
        ))}
      </div>
      {conn.kind === 'rest' && <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setAdding('register')}>Register existing DB name</button>}
      {conn.kind === 'rest' && <button className="fab" onClick={() => setAdding('create')} aria-label="Create DB">+</button>}
      {adding && (
        <Modal title={adding === 'create' ? 'Create DB' : 'Register existing DB'} onClose={() => setAdding(null)}>
          <Field label="DB name"><input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          {adding === 'create' && <p className="muted small">Calls the createDb endpoint (default PUT /db/{'{db}'}). If the server does not support it, an error is shown; use "Register existing DB" instead.</p>}
          <div className="actions">
            <button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>{adding === 'create' ? 'Create' : 'Register'}</button>
          </div>
        </Modal>
      )}
      {stats && (
        <Modal title="Server stats" onClose={() => setStats(null)}>
          {stats === 'loading' ? <p className="muted">Loading…</p> : (
            <>
              <div className="row" style={{ marginBottom: 8 }}><ResultBadge r={stats} /><span className="muted small">{conn.kind === 'go' ? 'GET /v1/stats' : 'GET serverStats (assumed path)'}</span></div>
              {!stats.ok && <p className="danger small">{describeResult(stats)}</p>}
              <JsonOut value={stats.data ?? ''} />
            </>
          )}
        </Modal>
      )}
      {confirmEl}
    </>
  );
}
