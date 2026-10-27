import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { raw } from '../api/bangdb';
import type { ApiResult, HttpMethod } from '../api/types';
import { TopBar } from '../components/Layout';
import { Field, JsonOut, ResultBadge, describeResult, useToast } from '../components/ui';
import { store, useConnection, useStore } from '../store/store';

export default function ConsolePage() {
  const { connId } = useParams();
  const conn = useConnection(connId);
  const { log } = useStore();
  const toast = useToast();
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [path, setPath] = useState(conn?.kind === 'go' ? '/v1/tables' : `/db/${conn?.defaultDb ?? 'mydb'}/list`);
  const [body, setBody] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;

  async function send() {
    if (!conn) return;
    let b: unknown = undefined;
    if (body.trim() && method !== 'GET') {
      try { b = JSON.parse(body); } catch { b = body; }
    }
    setBusy(true); setRes(await raw(conn, method, path.startsWith('/') ? path : `/${path}`, b)); setBusy(false);
  }
  const mine = log.filter((l) => l.connectionId === conn.id);

  return (
    <>
      <TopBar title="REST 콘솔" crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }]} />
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={method} onChange={(e) => setMethod(e.target.value as HttpMethod)} style={{ padding: 10, borderRadius: 9, background: 'var(--bg)', border: '1px solid var(--border)' }}>
          {(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as HttpMethod[]).map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="grow mono" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} style={{ padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)' }} />
        <button className="btn primary" onClick={send} disabled={busy}>{busy ? '…' : '전송'}</button>
      </div>
      {method !== 'GET' && <Field label="본문 (JSON)"><textarea className="mono" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} rows={5} /></Field>}
      <div className="row" style={{ marginBottom: 8 }}>
        <ResultBadge r={res} />
        {res && <span className="muted small mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{res.method} {res.url}</span>}
        {res && <button className="btn sm ghost" onClick={() => { navigator.clipboard?.writeText(res.text); toast('복사됨'); }}>복사</button>}
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res && <JsonOut value={res.data ?? ''} />}

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <b className="grow">요청 기록 ({mine.length})</b>
        <button className="btn sm ghost" onClick={() => store.clearLog()}>지우기</button>
      </div>
      <div className="list">
        {mine.slice(0, 50).map((l) => (
          <div key={l.id} className="item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, cursor: 'pointer' }} onClick={() => setOpen(open === l.id ? null : l.id)}>
            <div className="row">
              <span className={`badge ${l.error ? 'err' : l.ok ? 'ok' : 'warn'}`}>{l.error ? 'ERR' : l.status}</span>
              <span className="mono small grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.method} {l.url.replace(conn.baseUrl, '')}</span>
              <span className="muted small">{l.durationMs}ms · {new Date(l.at).toLocaleTimeString()}</span>
            </div>
            {open === l.id && (
              <>
                {l.requestBody && <><div className="muted small">요청</div><pre className="out">{l.requestBody}</pre></>}
                <div className="muted small">응답</div>
                <pre className="out">{l.error ?? l.text}</pre>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
