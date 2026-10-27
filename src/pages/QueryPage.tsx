import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { extractRows, sql } from '../api/bangdb';
import type { ApiResult } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, JsonOut, ResultBadge, describeResult } from '../components/ui';
import { useConnection } from '../store/store';

const HIST_KEY = 'bangdb-manager.sql-history';
function loadHist(): string[] { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }

export default function QueryPage() {
  const { connId, db = '' } = useParams();
  const conn = useConnection(connId);
  const [stmt, setStmt] = useState(conn?.kind === 'go' ? 'SELECT * FROM  LIMIT 20' : 'select * from  limit 20');
  const [res, setRes] = useState<ApiResult | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<string[]>(loadHist);
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;

  async function run() {
    if (!conn || !stmt.trim()) return;
    setBusy(true);
    const r = await sql(conn, db, stmt.trim());
    setRes(r); setBusy(false);
    const h = [stmt.trim(), ...hist.filter((x) => x !== stmt.trim())].slice(0, 30);
    setHist(h); try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* ignore */ }
  }

  return (
    <>
      <TopBar title="SQL 쿼리" crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: `/c/${conn.id}/db/${encodeURIComponent(db)}`, label: db }]} />
      <div className="field">
        <textarea className="mono" value={stmt} onChange={(e) => setStmt(e.target.value)} spellCheck={false} rows={4}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); }} placeholder="select * from mytable where age > 30 limit 20" />
      </div>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={run} disabled={busy}>{busy ? '실행 중…' : '실행 (Ctrl+Enter)'}</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> JSON 원문</label>
        <ResultBadge r={res} />
        {hist.length > 0 && (
          <select className="grow" value="" onChange={(e) => e.target.value && setStmt(e.target.value)} style={{ padding: 8, borderRadius: 9, background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <option value="">히스토리…</option>
            {hist.map((h, i) => <option key={i} value={h}>{h.slice(0, 80)}</option>)}
          </select>
        )}
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res?.ok && (raw ? <JsonOut value={res.data} /> : <DataTable rows={extractRows(res.data)} />)}
      {res?.ok && (res.data as { truncated?: boolean })?.truncated && <p className="warn small">서버 행 수 제한으로 결과가 잘렸습니다. LIMIT 를 지정하세요.</p>}
      {conn.kind === 'go'
        ? <p className="muted small" style={{ marginTop: 12 }}>POST /v1/query 에 {'{"sql": "..."}'} 로 전송됩니다. 여러 문장은 ;로 구분하며 마지막 SELECT 의 결과가 표시됩니다. 변경 문장은 rows_affected 로 결과를 확인하세요.</p>
        : <p className="muted small" style={{ marginTop: 12 }}>POST /db/{db}/query 에 {'{"sql": "..."}'} 로 전송됩니다. BangDB 의 SQL-like 문법(select/where/limit 등)을 따릅니다.</p>}
    </>
  );
}
