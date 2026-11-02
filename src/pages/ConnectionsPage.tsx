import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { extractTables, extractToken, login, ping } from '../api/bangdb';
import { Capacitor } from '@capacitor/core';
import { errorText, goHealth } from '../api/goapi';
import { gw, gwSqliteFiles } from '../api/gateway';
import { DEFAULT_ENDPOINTS, GO_KEYS, REST_KEYS } from '../api/endpoints';
import type { AuthMode, Connection, DbParams, EndpointDef, EndpointKey, HttpMethod, ServerKind } from '../api/types';
import { TopBar } from '../components/Layout';
import { EmptyState, Field, Modal, describeResult, useConfirm, useToast } from '../components/ui';
import { Icons, KindBadge } from '../components/kinds';
import { isGatewayKind, newId, normalize, store, useStore } from '../store/store';
import { isElectron } from '../platform';

export default function ConnectionsPage() {
  const { connections } = useStore();
  const [editing, setEditing] = useState<{ conn: Connection; isNew: boolean } | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const blank = (): Connection => ({ ...normalize({ id: newId(), name: '', kind: 'go', baseUrl: 'http://192.168.0.10:18081', auth: { mode: 'basic', headerName: 'x-bang-api-key', tokenField: 'token' } }), name: '' });

  const [status, setStatus] = useState<Record<string, 'ok' | 'err' | 'pending'>>({});
  useEffect(() => {
    // one quick health check per saved connection, so the list shows what is reachable
    let alive = true;
    const ids = connections.map((c) => c.id).join(',');
    if (!ids) return;
    setStatus((s) => Object.fromEntries(connections.map((c) => [c.id, s[c.id] ?? 'pending'])));
    connections.forEach(async (c) => {
      const r = c.db || c.kind === 'go' ? await goHealth(c) : await ping(c, c.defaultDb);
      if (alive) setStatus((s) => ({ ...s, [c.id]: r.ok ? 'ok' : 'err' }));
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.map((c) => c.id + c.baseUrl + JSON.stringify(c.db ?? null)).join('|')]);

  return (
    <>
      <TopBar title="Connections" right={<button className="btn primary" onClick={() => setEditing({ conn: blank(), isNew: true })}>{Icons.plus}Add</button>} />
      {connections.length === 0 && (
        <>
          <EmptyState icon={Icons.server} title="No servers yet"
            action={<button className="btn primary" onClick={() => setEditing({ conn: blank(), isNew: true })}>{Icons.plus}Add your first server</button>}>
            Pick a server type, enter its address and credentials, and you can work with tables, data and SQL right here.
          </EmptyState>
          <div className="guide">
            <div className="g"><b><KindBadge kind="go" small />BangDB (Go)</b>Run knoxxr/bangdb with <code>bangdb -http :18081 -password …</code> and it connects directly, no proxy needed.</div>
            <div className="g"><b><KindBadge kind="postgres" small />PostgreSQL · MySQL · SQL Server · SQLite</b>Connects through the DB gateway on the server that hosts this app. The desktop app has the gateway built in.</div>
            <div className="g"><b><KindBadge kind="mongodb" small />MongoDB · Redis</b>Dedicated collection/document and key browser views. Also goes through the gateway.</div>
            <div className="g"><b><KindBadge kind="rest" small />BangDB 2.0 REST</b>Port 18080 of a bangdb.com server. If the browser reports a CORS error, turn on "Via proxy".</div>
          </div>
        </>
      )}
      <div className="list">
        {connections.map((c) => (
          <div key={c.id} className="conn" onClick={() => nav(`/c/${c.id}/dbs`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/c/${c.id}/dbs`)}>
            <KindBadge kind={c.kind} />
            <div className="meta">
              <div className="title"><span className={`dot ${status[c.id] ?? ''}`} title={status[c.id] === 'ok' ? 'Connected' : status[c.id] === 'err' ? 'Unreachable' : 'Checking'} /><span className="name">{c.name}</span></div>
              <div className="sub">{connTarget(c)}</div>
              <div className="tags">
                <span className="badge">{kindLabel(c.kind)}</span>
                {c.kind === 'rest' && <span className="badge">{c.databases.length} DBs</span>}
                {!c.db && <span className="badge">{authLabel(c.auth.mode)}</span>}
                {c.useProxy && <span className="badge accent">Proxy</span>}
                {status[c.id] === 'err' && <span className="badge err">Unreachable</span>}
              </div>
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <button className="btn ghost icon sm" title="Edit" aria-label="Edit" onClick={() => setEditing({ conn: c, isNew: false })}>{Icons.edit}</button>
              <button className="btn ghost icon sm danger" title="Delete" aria-label="Delete" onClick={async () => { if (await confirm(`Delete the connection "${c.name}"? (Server data is not deleted)`)) { store.removeConnection(c.id); toast('Connection deleted'); } }}>{Icons.trash}</button>
            </div>
            <span className="chev">{Icons.chevron}</span>
          </div>
        ))}
      </div>
      {editing && (
        <ConnectionForm
          initial={editing.conn}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={(c) => { store.upsertConnection(c); setEditing(null); toast('Saved', 'ok'); }}
        />
      )}
      {confirmEl}
    </>
  );
}

export const KIND_LABEL: Record<ServerKind, string> = {
  go: 'BangDB (Go)', rest: 'BangDB 2.0 REST', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mssql: 'SQL Server', sqlite: 'SQLite', mongodb: 'MongoDB', redis: 'Redis'
};
export const kindLabel = (k: ServerKind) => KIND_LABEL[k] ?? k;
const DEFAULT_PORT: Partial<Record<ServerKind, number>> = { postgres: 5432, mysql: 3306, mssql: 1433, mongodb: 27017, redis: 6379 };
const DEFAULT_USER: Partial<Record<ServerKind, string>> = { postgres: 'postgres', mysql: 'root', mssql: 'sa' };

/** One line describing where a connection points. */
export function connTarget(c: Connection): string {
  if (!c.db) return c.baseUrl;
  const d = c.db;
  const where = d.uri ? d.uri.replace(/\/\/[^@/]*@/, '//***@') : c.kind === 'sqlite' ? d.file ?? '' : `${d.host || '127.0.0.1'}:${d.port || DEFAULT_PORT[c.kind] || ''}${d.database ? `/${d.database}` : ''}`;
  return `${where} · gateway ${c.baseUrl || '(this app server)'}`;
}
const authLabel = (m: AuthMode) => ({ none: 'None', apikey: 'API key', basic: 'Basic', login: 'Login' }[m]);

function ConnectionForm({ initial, isNew, onClose, onSave }: { initial: Connection; isNew: boolean; onClose: () => void; onSave: (c: Connection) => void }) {
  const [c, setC] = useState<Connection>(initial);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const toast = useToast();
  const up = (p: Partial<Connection>) => setC((x) => ({ ...x, ...p }));
  const upAuth = (p: Partial<Connection['auth']>) => setC((x) => ({ ...x, auth: { ...x.auth, ...p } }));

  async function doLogin(conn: Connection): Promise<Connection> {
    const r = await login(conn);
    if (!r.ok) throw new Error(`Login failed: ${describeResult(r)}`);
    const token = extractToken(r.data, conn.auth.tokenField);
    if (!token) throw new Error(`The login response has no "${conn.auth.tokenField}" field`);
    return { ...conn, auth: { ...conn.auth, token } };
  }

  async function test() {
    setTesting(true); setTestMsg(null);
    try {
      let conn = normalize(c);
      if (conn.db) {
        const h = await gw<{ ok: boolean; version?: string }>(conn, 'health');
        if (h.ok) setTestMsg(`Connected: ${h.data.version ?? kindLabel(conn.kind)} (${h.durationMs}ms)`);
        else setTestMsg(`Failed: ${errorText(h)}${h.status === 0 || h.status === 404 ? ' — could not reach the gateway. Check that this app was started with proxy/server.mjs or npm run dev, and that the gateway URL is correct.' : ''}`);
        return;
      }
      if (conn.auth.mode === 'login') { conn = await doLogin(conn); setC(conn); }
      if (conn.kind === 'go') {
        const h = await goHealth(conn);
        if (!h.ok) { setTestMsg(`Failed: ${describeResult(h)} — check that bangdb was started with the -http option and that the address/port is correct.`); return; }
      }
      const r = await ping(conn, conn.defaultDb);
      if (r.ok) setTestMsg(`Connected: ${extractTables(r.data).length} tables (${r.durationMs}ms)`);
      else setTestMsg(`Failed: ${describeResult(r)}${r.status === 0 && !conn.useProxy ? ' — in a browser this may be a CORS or network problem. Try turning on "Via proxy".' : ''}`);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : String(e));
    } finally { setTesting(false); }
  }

  async function save() {
    if (isGatewayKind(c.kind)) {
      const d = c.db ?? {};
      if (c.kind === 'sqlite' ? !d.file?.trim() : !(d.uri?.trim() || d.host?.trim())) { toast(c.kind === 'sqlite' ? 'Specify the SQLite file' : 'Enter a host or a connection string', 'err'); return; }
    } else if (!c.baseUrl.trim()) { toast('Enter the server URL', 'err'); return; }
    onSave(normalize(c));
  }
  const gateway = isGatewayKind(c.kind);

  return (
    <Modal title={isNew ? 'Add connection' : 'Edit connection'} onClose={onClose}>
      <Field label="Server type">
        <select value={c.kind} onChange={(e) => {
          const kind = e.target.value as ServerKind;
          if (isGatewayKind(kind)) {
            up({ kind, baseUrl: isGatewayKind(c.kind) ? c.baseUrl : '', db: { ...(c.db ?? {}), port: DEFAULT_PORT[kind], user: DEFAULT_USER[kind] } });
            return;
          }
          const was = isGatewayKind(c.kind) || !c.baseUrl;
          up({ kind, db: undefined, baseUrl: was ? (kind === 'go' ? 'http://192.168.0.10:18081' : 'http://192.168.0.10:18080') : c.baseUrl.replace(/:1808[01](\/|$)/, kind === 'go' ? ':18081$1' : ':18080$1'), useProxy: kind === 'rest' && isElectron, defaultDb: kind === 'rest' ? (!c.defaultDb || c.defaultDb === 'main' ? 'mydb' : c.defaultDb) : 'main' });
          if (kind === 'go') upAuth({ mode: 'basic' });
        }}>
          <optgroup label="BangDB">
            <option value="go">BangDB (Go) HTTP API — bangdb -http (port 18081)</option>
            <option value="rest">BangDB 2.0 REST — bangdb.com server (port 18080)</option>
          </optgroup>
          <optgroup label="Relational DB (via gateway)">
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="mssql">Microsoft SQL Server</option>
            <option value="sqlite">SQLite (file on the gateway PC)</option>
          </optgroup>
          <optgroup label="NoSQL (via gateway)">
            <option value="mongodb">MongoDB</option>
            <option value="redis">Redis</option>
          </optgroup>
        </select>
      </Field>
      <Field label="Name"><input value={c.name} onChange={(e) => up({ name: e.target.value })} placeholder={gateway ? `e.g. Production ${kindLabel(c.kind)}` : 'e.g. Office BangDB'} /></Field>
      {gateway && <GatewayFields c={c} up={up} />}
      {!gateway && <><Field label={c.kind === 'go' ? 'Server URL (bangdb -http address, default port 18081)' : 'Server URL (REST port, default 18080)'}><input className="mono" value={c.baseUrl} inputMode="url" onChange={(e) => up({ baseUrl: e.target.value })} placeholder={c.kind === 'go' ? 'http://192.168.0.10:18081' : 'http://192.168.0.10:18080'} /></Field>
      {c.kind === 'rest' && <Field label="Default database (BANGDB_DATABASE_NAME in bangdb.config)"><input className="mono" value={c.defaultDb} onChange={(e) => up({ defaultDb: e.target.value })} placeholder="mydb" /></Field>}
      {c.kind === 'go' && (
        <Field label="Password (the bangdb -password value; leave empty if none)">
          <input type="password" autoComplete="current-password" value={c.auth.pass ?? ''} onChange={(e) => upAuth({ mode: 'basic', user: c.auth.user || 'app', pass: e.target.value })} />
        </Field>
      )}
      {c.kind === 'rest' && <Field label="Authentication">
        <select value={c.auth.mode} onChange={(e) => upAuth({ mode: e.target.value as AuthMode })}>
          <option value="none">None</option>
          <option value="apikey">API key header</option>
          <option value="login">Login (user/password → token)</option>
          <option value="basic">HTTP Basic</option>
        </select>
      </Field>}
      {c.kind === 'rest' && c.auth.mode === 'apikey' && (
        <div className="grid2">
          <Field label="Header name"><input className="mono" value={c.auth.headerName} onChange={(e) => upAuth({ headerName: e.target.value })} /></Field>
          <Field label="API key"><input className="mono" type="password" value={c.auth.apiKey ?? ''} onChange={(e) => upAuth({ apiKey: e.target.value })} /></Field>
        </div>
      )}
      {c.kind === 'rest' && (c.auth.mode === 'login' || c.auth.mode === 'basic') && (
        <div className="grid2">
          <Field label="User"><input value={c.auth.user ?? ''} autoComplete="username" onChange={(e) => upAuth({ user: e.target.value })} /></Field>
          <Field label="Password"><input type="password" autoComplete="current-password" value={c.auth.pass ?? ''} onChange={(e) => upAuth({ pass: e.target.value })} /></Field>
        </div>
      )}
      {c.kind === 'rest' && c.auth.mode === 'login' && (
        <div className="grid2">
          <Field label="Token header name"><input className="mono" value={c.auth.headerName} onChange={(e) => upAuth({ headerName: e.target.value })} /></Field>
          <Field label="Token field in response"><input className="mono" value={c.auth.tokenField} onChange={(e) => upAuth({ tokenField: e.target.value })} /></Field>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={c.useProxy} onChange={(e) => up({ useProxy: e.target.checked })} /> Via proxy (requests go to /bangdb on the app's host, avoids CORS{isElectron ? ' · built into the desktop app' : ''})</label>
      </>}

      {!gateway && <details className="adv">
        <summary>Advanced: override REST endpoint templates</summary>
        <p className="muted small">{c.kind === 'go' ? 'knoxxr/bangdb HTTP API paths. Change them here if your server version differs.' : 'Entries verified against the BangDB docs are marked ✔; the rest are unverified guesses based on convention. Change the path/method here if your server version differs.'}</p>
        {(c.kind === 'go' ? GO_KEYS : REST_KEYS).map((k) => <EndpointRow key={k} k={k} value={c.endpointOverrides[k]} onChange={(v) => up({ endpointOverrides: { ...c.endpointOverrides, [k]: v } })} />)}
      </details>}

      {testMsg && <p className={`small ${testMsg.startsWith('Connected') ? 'ok' : 'danger'}`}>{testMsg}</p>}
      <div className="actions">
        <button className="btn" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

/** Database settings of a gateway connection. */
function GatewayFields({ c, up }: { c: Connection; up: (p: Partial<Connection>) => void }) {
  const d = c.db ?? {};
  const set = (p: Partial<DbParams>) => up({ db: { ...d, ...p } });
  const [files, setFiles] = useState<{ root: string; files: { file: string; size: number }[] } | null>(null);
  const [useUri, setUseUri] = useState(!!d.uri);
  const native = Capacitor.isNativePlatform();
  const uriHint: Partial<Record<ServerKind, string>> = {
    postgres: 'postgres://user:pass@host:5432/db?sslmode=require', mysql: 'mysql://user:pass@host:3306/db',
    mongodb: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true', redis: 'redis://:pass@host:6379/0',
    mssql: 'Server=host,1433;Database=db;User Id=sa;Password=…;Encrypt=true'
  };
  const dbHint: Partial<Record<ServerKind, string>> = { postgres: 'postgres', mysql: '(optional)', mssql: 'master', mongodb: 'test', redis: '0' };
  return (
    <>
      {c.kind === 'sqlite' ? (
        <>
          <Field label="SQLite file (path relative to the gateway's SQLITE_ROOT)">
            <div className="row">
              <input className="mono grow" value={d.file ?? ''} placeholder="app.db" onChange={(e) => set({ file: e.target.value })} />
              <button className="btn sm" onClick={async () => { const r = await gwSqliteFiles(normalize(c)); if (r.ok) setFiles(r.data); }}>Browse</button>
            </div>
          </Field>
          {files && (
            <div className="card" style={{ padding: 8 }}>
              <div className="muted small">SQLITE_ROOT: <span className="mono">{files.root}</span> — a file name that does not exist yet will be created</div>
              <div className="chips" style={{ marginTop: 6 }}>
                {files.files.map((f) => <span key={f.file} className={`chip ${d.file === f.file ? 'on' : ''}`} onClick={() => set({ file: f.file })}>{f.file} <span className="muted">{fmtBytes(f.size)}</span></span>)}
                {!files.files.length && <span className="muted small">No .db / .sqlite files</span>}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="check"><input type="checkbox" checked={useUri} onChange={(e) => { setUseUri(e.target.checked); if (!e.target.checked) set({ uri: undefined }); }} /> Enter as a connection string (URI)</label>
          {useUri ? (
            <Field label="Connection string"><input className="mono" value={d.uri ?? ''} placeholder={uriHint[c.kind]} onChange={(e) => set({ uri: e.target.value })} /></Field>
          ) : (
            <>
              <div className="grid2">
                <Field label="Host"><input className="mono" value={d.host ?? ''} placeholder="192.168.0.10" inputMode="url" onChange={(e) => set({ host: e.target.value })} /></Field>
                <Field label="Port"><input className="mono" type="number" value={d.port ?? ''} placeholder={String(DEFAULT_PORT[c.kind] ?? '')} onChange={(e) => set({ port: Number(e.target.value) || undefined })} /></Field>
                <Field label={c.kind === 'redis' ? 'User (ACL; leave empty if none)' : 'User'}><input value={d.user ?? ''} autoComplete="username" onChange={(e) => set({ user: e.target.value })} /></Field>
                <Field label="Password"><input type="password" autoComplete="current-password" value={d.password ?? ''} onChange={(e) => set({ password: e.target.value })} /></Field>
                <Field label={c.kind === 'redis' ? 'DB index (0–15)' : 'Default database'}>
                  <input className="mono" value={d.database ?? ''} placeholder={dbHint[c.kind]} onChange={(e) => set({ database: e.target.value })} />
                </Field>
                {c.kind === 'mongodb' && <Field label="authSource (optional)"><input className="mono" value={d.authSource ?? ''} placeholder="admin" onChange={(e) => set({ authSource: e.target.value })} /></Field>}
              </div>
              <label className="check"><input type="checkbox" checked={!!d.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> Use TLS/SSL</label>
              {d.ssl && <label className="check"><input type="checkbox" checked={!!d.sslInsecure} onChange={(e) => set({ sslInsecure: e.target.checked })} /> <span className="warn">Skip TLS verification</span> <span className="muted small">(for self-signed certificates; exposes you to man-in-the-middle attacks)</span></label>}
            </>
          )}
        </>
      )}
      <details className="adv" open={native || !!c.baseUrl}>
        <summary>Gateway {c.baseUrl ? `— ${c.baseUrl}` : '— the server hosting this app'}</summary>
        <p className="muted small">Browsers and phones cannot connect to a database directly, so requests go through a gateway (<code>node proxy/server.mjs</code> or <code>npm run dev</code>) running on a PC that can reach the database. {native ? 'In the phone app the gateway URL is required.' : 'Leave empty to use the server that hosts this app.'}</p>
        <div className="grid2">
          <Field label="Gateway URL"><input className="mono" value={c.baseUrl} placeholder="http://192.168.0.5:8080" inputMode="url" onChange={(e) => up({ baseUrl: e.target.value })} /></Field>
          <Field label="Gateway token (GATEWAY_TOKEN)"><input className="mono" type="password" value={c.gatewayToken ?? ''} onChange={(e) => up({ gatewayToken: e.target.value })} /></Field>
        </div>
      </details>
    </>
  );
}

export const fmtBytes = (n: number | undefined) =>
  n === undefined || n === null || isNaN(n) ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`;

function EndpointRow({ k, value, onChange }: { k: EndpointKey; value?: EndpointDef; onChange: (v: EndpointDef | undefined) => void }) {
  const d = DEFAULT_ENDPOINTS[k];
  const cur = value ?? d;
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <span className="small mono" style={{ width: 92 }}>{d.verified ? '✔ ' : ''}{k}</span>
      <select value={cur.method} style={{ width: 84 }} onChange={(e) => onChange({ ...cur, method: e.target.value as HttpMethod })}>
        {(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as HttpMethod[]).map((m) => <option key={m}>{m}</option>)}
      </select>
      <input className="mono grow" value={cur.path} onChange={(e) => onChange({ ...cur, path: e.target.value })} title={d.note} />
      {value && <button className="btn sm ghost" onClick={() => onChange(undefined)} title="Reset to default">↺</button>}
    </div>
  );
}
