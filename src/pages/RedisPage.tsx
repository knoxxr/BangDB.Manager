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
const ttlText = (ms: number) => (ms < 0 ? '' : ms < 60000 ? `${Math.ceil(ms / 1000)}초` : ms < 3600000 ? `${Math.round(ms / 60000)}분` : ms < 86400000 ? `${Math.round(ms / 3600000)}시간` : `${Math.round(ms / 86400000)}일`);
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
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const cur = conn.db?.database ?? '0';
  return (
    <>
      <TopBar title={conn.name} crumbs={[{ to: '/connections', label: '서버' }, { label: 'Redis' }]}
        right={<select className="inp" value={cur} onChange={(e) => nav(`/c/${conn.id}/db/${e.target.value}`)}>
          {(dbs.length ? dbs : [{ name: cur, keys: undefined }]).map((x) => <option key={x.name} value={x.name}>DB {x.name}{x.keys ? ` (${x.keys})` : ''}</option>)}
        </select>} />
      <div className="tabs">
        {([['keys', '키'], ['console', '명령'], ['info', '서버 정보']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
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
          <input className="inp mono grow" value={pattern} placeholder="패턴 user:*" onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && scan()} />
          <select className="inp" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">모든 타입</option>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => <option key={t}>{t}</option>)}
          </select>
          <button className="btn sm primary" onClick={() => scan()} disabled={busy}>{busy ? '…' : '찾기'}</button>
          <button className="btn sm" onClick={() => setCreating(true)}>+ 키</button>
        </div>
        <div className="schema" style={{ maxHeight: '65vh' }}>
          {keys.map((k) => (
            <div key={k.key} className="colname" style={{ padding: '5px 6px', color: sel === k.key ? 'var(--accent)' : undefined, cursor: 'pointer' }} onClick={() => setSel(k.key)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><span className="badge" style={{ color: TYPE_COLOR[k.type], borderColor: TYPE_COLOR[k.type], marginRight: 6, fontSize: 10 }}>{k.type}</span>{k.key}</span>
              <span>{ttlText(k.ttl)}</span>
            </div>
          ))}
          {!keys.length && !busy && <div className="muted small" style={{ padding: 8 }}>키가 없습니다</div>}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span className="muted small grow">{keys.length.toLocaleString()}개{cursor ? ' (더 있음)' : ''}</span>
          {cursor && <button className="btn sm" disabled={busy} onClick={() => scan(true)}>더 보기</button>}
        </div>
      </div>
      <div>
        {sel ? <KeyView key={sel} conn={conn} k={sel} onGone={() => { setSel(null); scan(); }} onRenamed={(to) => { setSel(to); scan(); }} /> : <div className="empty">왼쪽에서 키를 고르세요</div>}
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
  async function run(commands: (string | number)[][], ok = '저장됨'): Promise<boolean> {
    const r = await redis(conn, 'multi', { commands: commands.map((c) => c.map(String)) });
    if (!r.ok) { toast(errorText(r), 'err'); return false; }
    toast(ok, 'ok'); load(); return true;
  }

  if (err) return <div className="card danger">{err}</div>;
  if (!v) return <div className="empty">읽는 중…</div>;
  return (
    <>
      <div className="card">
        <div className="row wrap">
          <span className="badge" style={{ color: TYPE_COLOR[v.type], borderColor: TYPE_COLOR[v.type] }}>{v.type}</span>
          <b className="mono grow" style={{ wordBreak: 'break-all' }}>{v.key}</b>
          <span className="small muted">길이 {v.length.toLocaleString()} · TTL {v.ttl < 0 ? '없음' : ttlText(v.ttl)}</span>
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={async () => {
            const s = await prompt('만료 시간 (TTL)', '초 (0 이면 만료 없음)', v.ttl > 0 ? String(Math.ceil(v.ttl / 1000)) : '');
            if (s === null) return;
            const n = Number(s);
            if (!Number.isFinite(n) || n < 0) { toast('숫자를 입력하세요', 'err'); return; }
            run([n === 0 ? ['PERSIST', k] : ['EXPIRE', k, Math.floor(n)]], 'TTL 변경됨');
          }}>TTL</button>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('키 이름 변경', `${k} →`, k);
            if (!to || to === k) return;
            const r = await cmd(conn, 'RENAMENX', k, to);
            if (!r.ok) toast(errorText(r), 'err'); else if (r.data.result === 0) toast('같은 이름의 키가 이미 있습니다', 'err'); else { toast('이름 변경됨', 'ok'); onRenamed(to); }
          }}>이름 변경</button>
          <button className="btn sm ghost" onClick={load}>↻</button>
          <span className="grow" />
          <button className="btn sm danger" onClick={async () => { if (await confirm(`키 "${k}" 를 삭제할까요?`)) { const r = await cmd(conn, 'DEL', k); if (r.ok) { toast('삭제됨', 'ok'); onGone(); } else toast(errorText(r), 'err'); } }}>삭제</button>
        </div>
      </div>
      {v.type === 'string' && <StringEditor value={String(v.value ?? '')} onSave={(s) => run([['SET', k, s, 'KEEPTTL']])} />}
      {v.type === 'hash' && <PairsEditor rows={(v.value as { field: string; value: string }[]).map((x) => [x.field, x.value])} labels={['필드', '값']} truncated={v.length > (v.value as unknown[]).length}
        onSet={(a, b, old) => run([...(old !== undefined && old !== a ? [['HDEL', k, old]] : []), ['HSET', k, a, b]])} onDel={(a) => run([['HDEL', k, a]], '삭제됨')} />}
      {v.type === 'zset' && <PairsEditor rows={(v.value as { member: string; score: number }[]).map((x) => [x.member, String(x.score)])} labels={['멤버', '점수']} truncated={v.length > (v.value as unknown[]).length}
        onSet={(a, b, old) => { if (!Number.isFinite(Number(b))) { toast('점수는 숫자여야 합니다', 'err'); return Promise.resolve(false); } return run([...(old !== undefined && old !== a ? [['ZREM', k, old]] : []), ['ZADD', k, Number(b), a]]); }}
        onDel={(a) => run([['ZREM', k, a]], '삭제됨')} />}
      {v.type === 'list' && <ListEditor items={v.value as string[]} total={v.length}
        onSet={(i, s) => run([['LSET', k, i, s]])}
        onDel={(i, s) => run([['LSET', k, i, '__bdbm_deleted__'], ['LREM', k, 1, '__bdbm_deleted__']], `${s.slice(0, 20)} 삭제됨`)}
        onPush={(s, left) => run([[left ? 'LPUSH' : 'RPUSH', k, s]], '추가됨')} />}
      {v.type === 'set' && <SetEditor items={v.value as string[]} total={v.length} onAdd={(s) => run([['SADD', k, s]], '추가됨')} onDel={(s) => run([['SREM', k, s]], '삭제됨')} />}
      {v.type === 'stream' && <StreamEditor entries={v.value as { id: string; fields: Record<string, string> }[]} total={v.length}
        onAdd={(fields) => run([['XADD', k, '*', ...Object.entries(fields).flat()]], '추가됨')} onDel={(id) => run([['XDEL', k, id]], '삭제됨')} />}
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
        {isJson && <button className="btn sm ghost" onClick={() => { try { setText(JSON.stringify(JSON.parse(text), null, 2)); } catch { /* keep */ } }}>JSON 정렬</button>}
        <span className="grow" />
        <button className="btn sm" disabled={text === value} onClick={() => setText(value)}>되돌리기</button>
        <button className="btn sm primary" disabled={text === value} onClick={() => onSave(text)}>저장 (SET)</button>
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
        <input className="inp grow" placeholder="검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn sm primary" onClick={() => setEditing({ a: '', b: '' })}>+ 추가</button>
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
                  <td className="acts"><button className="btn sm ghost" onClick={() => setEditing({ old: a, a, b })}>수정</button><button className="btn sm danger" onClick={() => onDel(a)}>삭제</button></td>
                </tr>
              )))}
          </tbody>
        </table>
      </div>
      {truncated && <p className="warn small">처음 {rows.length}개만 표시합니다.</p>}
    </div>
  );
}

function EditRow({ e, set, onSave }: { e: { old?: string; a: string; b: string }; set: (x: { old?: string; a: string; b: string } | null) => void; onSave: () => void }) {
  return (
    <tr>
      <td><input className="inp mono" style={{ width: '100%' }} autoFocus value={e.a} onChange={(x) => set({ ...e, a: x.target.value })} /></td>
      <td><input className="inp mono" style={{ width: '100%' }} value={e.b} onChange={(x) => set({ ...e, b: x.target.value })} onKeyDown={(x) => x.key === 'Enter' && onSave()} /></td>
      <td className="acts"><button className="btn sm" onClick={() => set(null)}>취소</button><button className="btn sm primary" disabled={!e.a} onClick={onSave}>저장</button></td>
    </tr>
  );
}

function ListEditor({ items, total, onSet, onDel, onPush }: { items: string[]; total: number; onSet: (i: number, s: string) => Promise<boolean>; onDel: (i: number, s: string) => Promise<boolean>; onPush: (s: string, left: boolean) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ i: number; s: string } | null>(null);
  const [add, setAdd] = useState('');
  return (
    <div className="card">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <input className="inp mono grow" placeholder="새 값" value={add} onChange={(e) => setAdd(e.target.value)} />
        <button className="btn sm" disabled={!add} onClick={async () => { if (await onPush(add, true)) setAdd(''); }}>앞에 (LPUSH)</button>
        <button className="btn sm primary" disabled={!add} onClick={async () => { if (await onPush(add, false)) setAdd(''); }}>뒤에 (RPUSH)</button>
      </div>
      <table className="coltable">
        <thead><tr><th>#</th><th>값</th><th /></tr></thead>
        <tbody>
          {items.map((s, i) => (
            <tr key={i}>
              <td className="muted">{i}</td>
              <td className="mono" style={{ wordBreak: 'break-all' }}>{editing?.i === i ? <input className="inp mono" style={{ width: '100%' }} autoFocus value={editing.s} onChange={(e) => setEditing({ i, s: e.target.value })} onKeyDown={async (e) => { if (e.key === 'Enter' && await onSet(i, editing.s)) setEditing(null); }} /> : s}</td>
              <td className="acts">{editing?.i === i
                ? <><button className="btn sm" onClick={() => setEditing(null)}>취소</button><button className="btn sm primary" onClick={async () => { if (await onSet(i, editing.s)) setEditing(null); }}>저장</button></>
                : <><button className="btn sm ghost" onClick={() => setEditing({ i, s })}>수정</button><button className="btn sm danger" onClick={() => onDel(i, s)}>삭제</button></>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {total > items.length && <p className="warn small">전체 {total.toLocaleString()}개 중 처음 {items.length}개만 표시합니다.</p>}
    </div>
  );
}

function SetEditor({ items, total, onAdd, onDel }: { items: string[]; total: number; onAdd: (s: string) => Promise<boolean>; onDel: (s: string) => Promise<boolean> }) {
  const [add, setAdd] = useState('');
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <input className="inp mono grow" placeholder="새 멤버" value={add} onChange={(e) => setAdd(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter' && add && await onAdd(add)) setAdd(''); }} />
        <button className="btn sm primary" disabled={!add} onClick={async () => { if (await onAdd(add)) setAdd(''); }}>SADD</button>
      </div>
      <div className="chips">{items.sort().map((s) => <span key={s} className="chip">{s}<span style={{ color: 'var(--danger)', marginLeft: 4 }} onClick={() => onDel(s)} title="SREM">✕</span></span>)}</div>
      {total > items.length && <p className="warn small">전체 {total.toLocaleString()}개 중 {items.length}개만 표시합니다.</p>}
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
          try { f = Object.fromEntries(Object.entries(JSON.parse(text)).map(([a, b]) => [a, typeof b === 'string' ? b : JSON.stringify(b)])); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
          if (!Object.keys(f).length) { toast('필드를 하나 이상 넣으세요', 'err'); return; }
          onAdd(f);
        }}>XADD *</button>
      </div>
      <table className="coltable">
        <thead><tr><th>ID</th><th>필드</th><th /></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td className="mono small">{e.id}</td><td className="mono small" style={{ wordBreak: 'break-all' }}>{JSON.stringify(e.fields)}</td><td className="acts"><button className="btn sm danger" onClick={() => onDel(e.id)}>XDEL</button></td></tr>)}</tbody>
      </table>
      {total > entries.length && <p className="muted small">최근 {entries.length}개 (전체 {total.toLocaleString()}개)</p>}
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
    string: '값', hash: '필드=값 (한 줄에 하나)', list: '항목 (한 줄에 하나, 순서대로)', set: '멤버 (한 줄에 하나)', zset: '점수 멤버 (한 줄에 하나, 예: 10 kim)', stream: '필드=값 (한 줄에 하나, 첫 항목)'
  };
  async function create() {
    const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
    const kv = () => lines.flatMap((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, '']; });
    const c: Record<KeyType, (string | number)[]> = {
      string: ['SET', key, value], hash: ['HSET', key, ...kv()], list: ['RPUSH', key, ...lines], set: ['SADD', key, ...lines],
      zset: ['ZADD', key, ...lines.flatMap((l) => { const [s, ...m] = l.split(/\s+/); return [s, m.join(' ')]; })], stream: ['XADD', key, '*', ...kv()]
    };
    if (type !== 'string' && !lines.length) { toast('값을 하나 이상 넣으세요', 'err'); return; }
    const exists = await cmd(conn, 'EXISTS', key);
    if (exists.ok && exists.data.result === 1) { toast('같은 이름의 키가 이미 있습니다', 'err'); return; }
    const commands = [c[type], ...(ttl > 0 ? [['EXPIRE', key, ttl]] : [])];
    const r: ApiResult = await redis(conn, 'multi', { commands: commands.map((x) => x.map(String)) });
    if (!r.ok) { toast(errorText(r), 'err'); return; }
    toast('키 생성됨', 'ok'); onCreated(key); onClose();
  }
  return (
    <Modal title="새 키" onClose={onClose}>
      <div className="grid2">
        <Field label="키 이름"><input className="mono" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="user:1" /></Field>
        <Field label="타입"><select value={type} onChange={(e) => setType(e.target.value as KeyType)}>{['string', 'hash', 'list', 'set', 'zset', 'stream'].map((t) => <option key={t}>{t}</option>)}</select></Field>
      </div>
      <Field label={help[type]}><textarea className="mono" rows={5} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      <Field label="TTL (초, 0 = 없음)"><input type="number" min={0} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} /></Field>
      <div className="actions"><button className="btn" onClick={onClose}>취소</button><button className="btn primary" disabled={!key} onClick={create}>만들기</button></div>
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
        <input className="inp mono grow" autoFocus value={line} placeholder='예: HGETALL user:1   ·   SET greeting "hello world" EX 60' onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
            else if (e.key === 'ArrowUp' && hist.length) { e.preventDefault(); const i = Math.min(hi + 1, hist.length - 1); setHi(i); setLine(hist[i]); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const i = Math.max(hi - 1, -1); setHi(i); setLine(i < 0 ? '' : hist[i]); }
          }} />
        <button className="btn primary" onClick={run}>실행</button>
      </div>
      <p className="muted small">↑↓ 로 이전 명령. 모든 Redis 명령을 실행합니다 — FLUSHDB·FLUSHALL 같은 명령도 그대로 실행되니 주의하세요.</p>
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
  if (!info) return <div className="empty">읽는 중…</div>;
  const s = info.server ?? {}, m = info.memory ?? {}, c = info.clients ?? {}, st = info.stats ?? {};
  const hits = Number(st.keyspace_hits), miss = Number(st.keyspace_misses);
  const tiles: [string, string | undefined][] = [
    ['버전', s.redis_version], ['가동 시간', s.uptime_in_days ? `${s.uptime_in_days}일` : undefined], ['모드', s.redis_mode], ['메모리', m.used_memory_human],
    ['최대 메모리', m.maxmemory_human], ['클라이언트', c.connected_clients], ['초당 명령', st.instantaneous_ops_per_sec], ['키 적중률', hits + miss ? `${((hits / (hits + miss)) * 100).toFixed(1)}%` : '-'],
    ['현재 DB 키', String((info as unknown as { dbsize?: number }).dbsize ?? '')], ['만료된 키', st.expired_keys], ['역할', info.replication?.role]
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
