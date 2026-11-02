import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gw, gwDatabases, type DatabaseInfo } from '../api/gateway';
import { errorText } from '../api/goapi';
import type { ApiResult, Connection } from '../api/types';
import { TopBar } from '../components/Layout';
import { Field, JsonOut, Modal, useConfirm, usePrompt, useToast } from '../components/ui';
import { useConnection, useDbConnection } from '../store/store';

type KeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream';
interface KeyMeta { key: string; type: string; ttl: number }
interface KeyValue { key: string; type: KeyType; ttl: number; length: number; value: unknown }

const redis = <T = unknown>(c: Connection, op: string, body: Record<string, unknown> = {}) => gw<T>(c, `redis/${op}`, body);
const cmd = (c: Connection, ...args: (string | number)[]) => redis<{ result: unknown }>(c, 'command', { args: args.map(String) });
const ttlText = (ms: number) => (ms < 0 ? '' : ms < 60000 ? `${Math.ceil(ms / 1000)}s` : ms < 3600000 ? `${Math.round(ms / 60000)}m` : ms < 86400000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`);
const TYPE_COLOR: Record<string, string> = { string: '#38bdf8', hash: '#a78bfa', list: '#4ade80', set: '#fbbf24', zset: '#f472b6', stream: '#fb923c' };

/** Redis: key browser and editor, console, INFO. */
export default function RedisPage() {
  const { connId, db } = useParams();
  const base = useConnection(connId);
  const conn = useDbConnection(connId, db ?? base?.defaultDb);
  const nav = useNavigate();
  const [tab, setTab] = useState<'keys' | 'console' | 'info'>('keys');
  const [dbs, setDbs] = useState<DatabaseInfo[]>([]);
  useEffect(() => { if (conn) gwDatabases(conn).then((r) => r.ok && setDbs(r.data.databases)); }, [conn]);
  if (!conn) return <div className="empty">Connection not found.</div>;
  const cur = conn.db?.database ?? '0';
  return (
    <>
      <TopBar title={conn.name} crumbs={[{ to: '/connections', label: 'Servers' }, { label: 'Redis' }]}
        right={<select className="inp" value={cur} onChange={(e) => nav(`/c/${conn.id}/db/${e.target.value}`)}>
          {(dbs.length ? dbs : [{ name: cur, keys: undefined }]).map((x) => <option key={x.name} value={x.name}>DB {x.name}{x.keys ? ` (${x.keys})` : ''}</option>)}
        </select>} />
      <div className="tabs">
        {([['keys', 'Keys'], ['console', 'Command'], ['info', 'Server info']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'keys' && <KeysTab key={cur} conn={conn} />}
      {tab === 'console' && <ConsoleTab conn={conn} />}
      {tab === 'info' && <InfoTab conn={conn} />}
    </>
  );
}

// ---------------------------------------------------------------- keys

function KeysTab({ conn }: { conn: Connection }) {
  const toast = useToast();
  const [pattern, setPattern] = useState('*');
  const [type, setType] = useState('');
  const [keys, setKeys] = useState<KeyMeta[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const scan = useCallback(async (more = false) => {
    setBusy(true);
    let c = more ? cursor ?? '0' : '0';
    const found: KeyMeta[] = more ? [...keys] : [];
    // SCAN may return few keys per call; keep going until a page is filled or the scan ends
    for (let i = 0; i < 20; i++) {
      const r = await redis<{ cursor: string; keys: KeyMeta[] }>(conn, 'scan', { cursor: c, pattern: pattern || '*', type: type || undefined, count: 500 });
      if (!r.ok) { toast(errorText(r), 'err'); break; }
      found.push(...r.data.keys);
      c = r.data.cursor;
      if (c === '0' || found.length >= (more ? keys.length + 200 : 200)) break;
    }
    setKeys(found.sort((a, b) => a.key.localeCompare(b.key)));
    setCursor(c === '0' ? null : c);
    setBusy(false);
  }, [conn, pattern, type, cursor, keys, toast]);
  useEffect(() => { scan(); }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(240px, 340px) 1fr' }}>
      <div>
        <div className="toolbar">
          <input className="inp mono grow" value={pattern} placeholder="Pattern user:*" onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && scan()} />
          <select className="inp" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <button className="btn sm primary" onClick={() => scan()} disabled={busy}>{busy ? '…' : 'Find'}</button>
          <button className="btn sm" onClick={() => setCreating(true)}>+ Key</button>
        </div>
        <div className="schema" style={{ maxHeight: '65vh' }}>
          {keys.map((k) => (
            <div key={k.key} className="colname" style={{ padding: '5px 6px', color: sel === k.key ? 'var(--accent)' : undefined, cursor: 'pointer' }} onClick={() => setSel(k.key)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span className="badge" style={{ color: TYPE_COLOR[k.type], borderColor: TYPE_COLOR[k.type], marginRight: 6, fontSize: 10 }}>{k.type}</span>{k.key}</span>
              <span>{ttlText(k.ttl)}</span>
            </div>
          ))}
          {!keys.length && !busy && <div className="muted small" style={{ padding: 8 }}>No keys</div>}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted small grow">{keys.length.toLocaleString()} key(s){cursor ? ' (more)' : ''}</span>
          {cursor && <button className="btn sm" disabled={busy} onClick={() => scan(true)}>Load more</button>}
        </div>
      </div>
      <div>
        {sel ? <KeyView key={sel} conn={conn} k={sel} onGone={() => { setSel(null); scan(); }} onRenamed={(to) => { setSel(to); scan(); }} /> : <div className="empty">Select a key on the left</div>}
      </div>
      {creating && <NewKeyModal conn={conn} onClose={() => setCreating(false)} onCreated={(k) => { setSel(k); scan(); }} />}
    </div>
  );
}

function KeyView({ conn, k, onGone, onRenamed }: { conn: Connection; k: string; onGone: () => void; onRenamed: (to: string) => void }) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const [v, setV] = useState<KeyValue | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    const r = await redis<KeyValue>(conn, 'get', { key: k });
    if (r.ok) { setV(r.data); setErr(''); } else setErr(errorText(r));
  }, [conn, k]);
  useEffect(() => { load(); }, [load]);

  /** Run commands in one MULTI; reload on success. */
  async function run(commands: (string | number)[][], ok = 'Saved'): Promise<boolean> {
    const r = await redis(conn, 'multi', { commands: commands.map((c) => c.map(String)) });
    if (!r.ok) { toast(errorText(r), 'err'); return false; }
    toast(ok, 'ok'); load(); return true;
  }

  if (err) return <div className="card danger">{err}</div>;
  if (!v) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="card">
        <div className="row wrap">
          <span className="badge" style={{ color: TYPE_COLOR[v.type], borderColor: TYPE_COLOR[v.type] }}>{v.type}</span>
          <b className="mono grow" style={{ wordBreak: 'break-all' }}>{v.key}</b>
          <span className="small muted">Length {v.length.toLocaleString()} · TTL {v.ttl < 0 ? 'None' : ttlText(v.ttl)}</span>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={async () => {
            const s = await prompt('Expiry (TTL)', 'Seconds (0 = no expiry)', v.ttl > 0 ? String(Math.ceil(v.ttl / 1000)) : '');
            if (s === null) return;
            const n = Number(s);
            if (!Number.isFinite(n) || n < 0) { toast('Enter a number', 'err'); return; }
            run([n === 0 ? ['PERSIST', k] : ['EXPIRE', k, Math.floor(n)]], 'TTL updated');
          }}>TTL</button>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('Rename key', `${k} →`, k);
            if (!to || to === k) return;
            const r = await cmd(conn, 'RENAMENX', k, to);
            if (!r.ok) toast(errorText(r), 'err'); else if (r.data.result === 0) toast('A key with that name already exists', 'err'); else { toast('Renamed', 'ok'); onRenamed(to); }
          }}>Rename</button>
          <button className="btn sm ghost" onClick={load}>↻</button>
          <span className="grow" />
          <button className="btn sm danger" onClick={async () => { if (await confirm(`Delete key "${k}"?`)) { const r = await cmd(conn, 'DEL', k); if (r.ok) { toast('Deleted', 'ok'); onGone(); } else toast(errorText(r), 'err'); } }}>Delete</button>
        </div>
      </div>
      {v.type === 'string' && <StringEditor value={String(v.value ?? '')} onSave={(s) => run([['SET', k, s, 'KEEPTTL']])} />}
      {v.type === 'hash' && <PairsEditor rows={(v.value as { field: string; value: string }[]).map((x) => [x.field, x.value])} labels={['Field', 'Value']} truncated={v.length > (v.value as unknown[]).length}
        onSet={(a, b, old) => run([...(old !== undefined && old !== a ? [['HDEL', k, old]] : []), ['HSET', k, a, b]])} onDel={(a) => run([['HDEL', k, a]], 'Deleted')} />}
      {v.type === 'zset' && <PairsEditor rows={(v.value as { member: string; score: number }[]).map((x) => [x.member, String(x.score)])} labels={['Member', 'Score']} truncated={v.length > (v.value as unknown[]).length}
        onSet={(a, b, old) => { if (!Number.isFinite(Number(b))) { toast('Score must be a number', 'err'); return Promise.resolve(false); } return run([...(old !== undefined && old !== a ? [['ZREM', k, old]] : []), ['ZADD', k, Number(b), a]]); }}
        onDel={(a) => run([['ZREM', k, a]], 'Deleted')} />}
      {v.type === 'list' && <ListEditor items={v.value as string[]} total={v.length}
        onSet={(i, s) => run([['LSET', k, i, s]])}
        onDel={(i, s) => run([['LSET', k, i, '__bdbm_deleted__'], ['LREM', k, 1, '__bdbm_deleted__']], `"${s.slice(0, 20)}" deleted`)}
        onPush={(s, left) => run([[left ? 'LPUSH' : 'RPUSH', k, s]], 'Added')} />}
      {v.type === 'set' && <SetEditor items={v.value as string[]} total={v.length} onAdd={(s) => run([['SADD', k, s]], 'Added')} onDel={(s) => run([['SREM', k, s]], 'Deleted')} />}
      {v.type === 'stream' && <StreamEditor entries={v.value as { id: string; fields: Record<string, string> }[]} total={v.length}
        onAdd={(fields) => run([['XADD', k, '*', ...Object.entries(fields).flat()]], 'Added')} onDel={(id) => run([['XDEL', k, id]], 'Deleted')} />}
      {confirmEl}{promptEl}
    </>
  );
}

function StringEditor({ value, onSave }: { value: string; onSave: (s: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  const isJson = (() => { try { const x = JSON.parse(value); return typeof x === 'object' && x !== null; } catch { return false; } })();
  return (
    <div className="card">
      <textarea className="inp mono" style={{ width: '100%', minHeight: 200 }} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 6 }}>
        {isJson && <button className="btn sm ghost" onClick={() => { try { setText(JSON.stringify(JSON.parse(text), null, 2)); } catch { /* keep */ } }}>Format JSON</button>}
        <span className="grow" />
        <button className="btn sm" disabled={text === value} onClick={() => setText(value)}>Revert</button>
        <button className="btn sm primary" disabled={text === value} onClick={() => onSave(text)}>Save (SET)</button>
      </div>
    </div>
  );
}

/** Field/value (hash) or member/score (zset) rows with inline edit. */
function PairsEditor({ rows, labels, truncated, onSet, onDel }: { rows: [string, string][]; labels: [string, string]; truncated: boolean; onSet: (a: string, b: string, old?: string) => Promise<boolean>; onDel: (a: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ old?: string; a: string; b: string } | null>(null);
  const [filter, setFilter] = useState('');
  const shown = rows.filter(([a, b]) => !filter || a.includes(filter) || b.includes(filter));
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="inp grow" placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn sm primary" onClick={() => setEditing({ a: '', b: '' })}>+ Add</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="coltable">
          <thead><tr><th>{labels[0]}</th><th>{labels[1]}</th><th /></tr></thead>
          <tbody>
            {editing && editing.old === undefined && <EditRow e={editing} set={setEditing} onSave={async () => { if (await onSet(editing.a, editing.b)) setEditing(null); }} />}
            {shown.map(([a, b]) => (editing?.old === a
              ? <EditRow key={a} e={editing} set={setEditing} onSave={async () => { if (await onSet(editing.a, editing.b, a)) setEditing(null); }} />
              : (
                <tr key={a}>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>{a}</td>
                  <td className="mono" style={{ wordBreak: 'break-all' }}>{b}</td>
                  <td className="acts"><button className="btn sm ghost" onClick={() => setEditing({ old: a, a, b })}>Edit</button><button className="btn sm danger" onClick={() => onDel(a)}>Delete</button></td>
                </tr>
              )))}
          </tbody>
        </table>
      </div>
      {truncated && <p className="warn small">Showing only the first {rows.length} entries.</p>}
    </div>
  );
}

function EditRow({ e, set, onSave }: { e: { old?: string; a: string; b: string }; set: (x: { old?: string; a: string; b: string } | null) => void; onSave: () => void }) {
  return (
    <tr>
      <td><input className="inp mono" style={{ width: '100%' }} autoFocus value={e.a} onChange={(x) => set({ ...e, a: x.target.value })} /></td>
      <td><input className="inp mono" style={{ width: '100%' }} value={e.b} onChange={(x) => set({ ...e, b: x.target.value })} onKeyDown={(x) => x.key === 'Enter' && onSave()} /></td>
      <td className="acts"><button className="btn sm" onClick={() => set(null)}>Cancel</button><button className="btn sm primary" disabled={!e.a} onClick={onSave}>Save</button></td>
    </tr>
  );
}

function ListEditor({ items, total, onSet, onDel, onPush }: { items: string[]; total: number; onSet: (i: number, s: string) => Promise<boolean>; onDel: (i: number, s: string) => Promise<boolean>; onPush: (s: string, left: boolean) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ i: number; s: string } | null>(null);
  const [add, setAdd] = useState('');
  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <input className="inp mono grow" placeholder="New value" value={add} onChange={(e) => setAdd(e.target.value)} />
        <button className="btn sm" disabled={!add} onClick={async () => { if (await onPush(add, true)) setAdd(''); }}>Front (LPUSH)</button>
        <button className="btn sm primary" disabled={!add} onClick={async () => { if (await onPush(add, false)) setAdd(''); }}>Back (RPUSH)</button>
      </div>
      <table className="coltable">
        <thead><tr><th>#</th><th>Value</th><th /></tr></thead>
        <tbody>
          {items.map((s, i) => (
            <tr key={i}>
              <td className="muted">{i}</td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{editing?.i === i ? <input className="inp mono" style={{ width: '100%' }} autoFocus value={editing.s} onChange={(e) => setEditing({ i, s: e.target.value })} onKeyDown={async (e) => { if (e.key === 'Enter' && await onSet(i, editing.s)) setEditing(null); }} /> : s}</td>
              <td className="acts">{editing?.i === i
                ? <><button className="btn sm" onClick={() => setEditing(null)}>Cancel</button><button className="btn sm primary" onClick={async () => { if (await onSet(i, editing.s)) setEditing(null); }}>Save</button></>
                : <><button className="btn sm ghost" onClick={() => setEditing({ i, s })}>Edit</button><button className="btn sm danger" onClick={() => onDel(i, s)}>Delete</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > items.length && <p className="warn small">Showing only the first {items.length} of {total.toLocaleString()} items.</p>}
    </div>
  );
}

function SetEditor({ items, total, onAdd, onDel }: { items: string[]; total: number; onAdd: (s: string) => Promise<boolean>; onDel: (s: string) => Promise<boolean> }) {
  const [add, setAdd] = useState('');
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="inp mono grow" placeholder="New member" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter' && add && await onAdd(add)) setAdd(''); }} />
        <button className="btn sm primary" disabled={!add} onClick={async () => { if (await onAdd(add)) setAdd(''); }}>SADD</button>
      </div>
      <div className="chips">{items.sort().map((s) => <span key={s} className="chip">{s}<span style={{ color: 'var(--danger)', marginLeft: 4 }} onClick={() => onDel(s)} title="SREM">✕</span></span>)}</div>
      {total > items.length && <p className="warn small">Showing only {items.length} of {total.toLocaleString()} members.</p>}
    </div>
  );
}

function StreamEditor({ entries, total, onAdd, onDel }: { entries: { id: string; fields: Record<string, string> }[]; total: number; onAdd: (f: Record<string, string>) => Promise<boolean>; onDel: (id: string) => Promise<boolean> }) {
  const [text, setText] = useState('{"type": "event"}');
  const toast = useToast();
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="inp mono grow" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn sm primary" onClick={async () => {
          let f: Record<string, string>;
          try { f = Object.fromEntries(Object.entries(JSON.parse(text)).map(([a, b]) => [a, typeof b === 'string' ? b : JSON.stringify(b)])); } catch (e) { toast(`JSON error: ${(e as Error).message}`, 'err'); return; }
          if (!Object.keys(f).length) { toast('Enter at least one field', 'err'); return; }
          onAdd(f);
        }}>XADD *</button>
      </div>
      <table className="coltable">
        <thead><tr><th>ID</th><th>Fields</th><th /></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td className="mono small">{e.id}</td><td className="mono small" style={{ wordBreak: 'break-all' }}>{JSON.stringify(e.fields)}</td><td className="acts"><button className="btn sm danger" onClick={() => onDel(e.id)}>XDEL</button></td></tr>)}</tbody>
      </table>
      {total > entries.length && <p className="muted small">Latest {entries.length} of {total.toLocaleString()} entries</p>}
    </div>
  );
}

function NewKeyModal({ conn, onClose, onCreated }: { conn: Connection; onClose: () => void; onCreated: (k: string) => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [type, setType] = useState<KeyType>('string');
  const [value, setValue] = useState('');
  const [ttl, setTtl] = useState(0);
  const help: Record<KeyType, string> = {
    string: 'Value', hash: 'field=value (one per line)', list: 'Items (one per line, in order)', set: 'Members (one per line)', zset: 'score member (one per line, e.g. 10 kim)', stream: 'field=value (one per line, first entry)'
  };
  async function create() {
    const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
    const kv = () => lines.flatMap((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, '']; });
    const c: Record<KeyType, (string | number)[]> = {
      string: ['SET', key, value], hash: ['HSET', key, ...kv()], list: ['RPUSH', key, ...lines], set: ['SADD', key, ...lines],
      zset: ['ZADD', key, ...lines.flatMap((l) => { const [s, ...m] = l.split(/\s+/); return [s, m.join(' ')]; })], stream: ['XADD', key, '*', ...kv()]
    };
    if (type !== 'string' && !lines.length) { toast('Enter at least one value', 'err'); return; }
    const exists = await cmd(conn, 'EXISTS', key);
    if (exists.ok && exists.data.result === 1) { toast('A key with that name already exists', 'err'); return; }
    const commands = [c[type], ...(ttl > 0 ? [['EXPIRE', key, ttl]] : [])];
    const r: ApiResult = await redis(conn, 'multi', { commands: commands.map((x) => x.map(String)) });
    if (!r.ok) { toast(errorText(r), 'err'); return; }
    toast('Key created', 'ok'); onCreated(key); onClose();
  }
  return (
    <Modal title="New key" onClose={onClose}>
      <div className="grid2">
        <Field label="Key name"><input className="mono" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="user:1" /></Field>
        <Field label="Type"><select value={type} onChange={(e) => setType(e.target.value as KeyType)}>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => <option key={t}>{t}</option>)}</select></Field>
      </div>
      <Field label={help[type]}><textarea className="mono" rows={5} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      <Field label="TTL (seconds, 0 = none)"><input type="number" min={0} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!key} onClick={create}>Create</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- console / info

/** Split a command line into arguments, honouring "double" and 'single' quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const HIST_KEY = 'bangdb-manager.redis-history';

function ConsoleTab({ conn }: { conn: Connection }) {
  const [line, setLine] = useState('');
  const [log, setLog] = useState<{ cmd: string; out: unknown; err?: boolean }[]>([]);
  const [hist, setHist] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } });
  const [hi, setHi] = useState(-1);
  async function run() {
    const args = splitArgs(line);
    if (!args.length) return;
    const r = await redis<{ result: unknown }>(conn, 'command', { args });
    setLog((l) => [{ cmd: line, out: r.ok ? r.data.result : errorText(r), err: !r.ok }, ...l].slice(0, 100));
    const h = [line, ...hist.filter((x) => x !== line)].slice(0, 50);
    setHist(h); setHi(-1); setLine('');
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* ignore */ }
  }
  return (
    <>
      <div className="row">
        <input className="inp mono grow" autoFocus value={line} placeholder='e.g. HGETALL user:1   ·   SET greeting "hello world" EX 60' onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
            else if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const i = Math.min(hi + 1, hist.length - 1); setHi(i); setLine(hist[i]); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(hi - 1, -1); setHi(i); setLine(i < 0 ? '' : hist[i]); }
          }} />
        <button className="btn primary" onClick={run}>Run</button>
      </div>
      <p className="muted small">↑↓ for history. Any Redis command is run as-is — be careful, this includes FLUSHDB and FLUSHALL.</p>
      {log.map((x, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div className="mono small">&gt; {x.cmd}</div>
          <pre className={`out ${x.err ? 'danger' : ''}`}>{typeof x.out === 'string' ? x.out : JSON.stringify(x.out, null, 2)}</pre>
        </div>
      ))}
    </>
  );
}

function InfoTab({ conn }: { conn: Connection }) {
  const [info, setInfo] = useState<Record<string, Record<string, string>> | null>(null);
  useEffect(() => { gw<Record<string, Record<string, string>>>(conn, 'stats').then((r) => r.ok && setInfo(r.data)); }, [conn]);
  if (!info) return <div className="empty">Loading…</div>;
  const s = info.server ?? {}, m = info.memory ?? {}, c = info.clients ?? {}, st = info.stats ?? {};
  const hits = Number(st.keyspace_hits), miss = Number(st.keyspace_misses);
  const tiles: [string, string | undefined][] = [
    ['Version', s.redis_version], ['Uptime', s.uptime_in_days ? `${s.uptime_in_days}d` : undefined], ['Mode', s.redis_mode], ['Memory', m.used_memory_human],
    ['Max memory', m.maxmemory_human], ['Clients', c.connected_clients], ['Ops/sec', st.instantaneous_ops_per_sec], ['Hit rate', hits + miss ? `${((hits / (hits + miss)) * 100).toFixed(1)}%` : '-'],
    ['Keys in DB', String((info as unknown as { dbsize?: number }).dbsize ?? '')], ['Expired keys', st.expired_keys], ['Role', info.replication?.role]
  ];
  return (
    <>
      <div className="stats">{tiles.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v" style={{ fontSize: 15 }}>{v ?? '-'}</div></div>)}</div>
      {Object.entries(info).filter(([, v]) => v && typeof v === 'object').map(([sec, kv]) => (
        <details key={sec} className="adv"><summary>{sec}</summary><JsonOut value={kv} /></details>
      ))}
    </>
  );
}
