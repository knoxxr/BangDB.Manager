import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { addIndex, delDoc, dropIndex, extractRows, getDoc, putDoc, rowCount, sql, tableInfo } from '../api/bangdb';
import type { ApiResult, IndexSpec } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, Field, JsonOut, ResultBadge, describeResult, useConfirm, useToast } from '../components/ui';
import { useConnection } from '../store/store';

type Tab = 'browse' | 'put' | 'key' | 'index' | 'info';

export default function TableDetailPage() {
  const { connId, db = '', table = '' } = useParams();
  const conn = useConnection(connId);
  const [tab, setTab] = useState<Tab>('browse');
  const [count, setCount] = useState<ApiResult<{ count?: number }> | null>(null);

  const loadCount = useCallback(async () => { if (conn) setCount(await rowCount(conn, db, table)); }, [conn, db, table]);
  useEffect(() => { loadCount(); }, [loadCount]);

  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const n = count?.ok && count.data && typeof count.data === 'object' ? (count.data as { count?: number }).count : undefined;

  return (
    <>
      <TopBar title={table} crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: `/c/${conn.id}/db/${encodeURIComponent(db)}`, label: db }, { label: '테이블' }]}
        right={<span className="badge">{count ? (count.ok ? `행 ${n ?? '?'}개` : '카운트 실패') : '…'}</span>} />
      <div className="tabs">
        {([['browse', '조회'], ['put', '문서 입력'], ['key', '키 조회/삭제'], ['index', '인덱스'], ['info', '정보']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'browse' && <Browse conn={conn} db={db} table={table} />}
      {tab === 'put' && <PutDoc conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'key' && <KeyOps conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'index' && <IndexOps conn={conn} db={db} table={table} />}
      {tab === 'info' && <Info conn={conn} db={db} table={table} />}
    </>
  );
}

type P = { conn: NonNullable<ReturnType<typeof useConnection>>; db: string; table: string; onDone?: () => void };

function Browse({ conn, db, table }: P) {
  const [limit, setLimit] = useState(50);
  const [where, setWhere] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    const stmt = `select * from ${table}${where.trim() ? ` where ${where.trim()}` : ''} limit ${limit}`;
    setRes(await sql(conn, db, stmt));
    setBusy(false);
  }
  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <input className="grow mono" placeholder="where 조건 (선택) 예: age > 30" value={where} onChange={(e) => setWhere(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} style={inp} />
        <input type="number" className="mono" value={limit} min={1} max={10000} onChange={(e) => setLimit(Number(e.target.value) || 50)} style={{ ...inp, width: 90 }} />
        <button className="btn primary sm" onClick={run} disabled={busy}>{busy ? '…' : '조회'}</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> JSON</label>
        <ResultBadge r={res} />
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res?.ok && (raw ? <JsonOut value={res.data} /> : <DataTable rows={extractRows(res.data)} />)}
    </>
  );
}

function PutDoc({ conn, db, table, onDone }: P) {
  const [text, setText] = useState('{\n  "_pk": "key1",\n  "name": "example"\n}');
  const [res, setRes] = useState<ApiResult | null>(null);
  const toast = useToast();
  async function submit() {
    let body: unknown;
    try { body = JSON.parse(text); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
    const r = await putDoc(conn, db, table, body);
    setRes(r);
    toast(r.ok ? '저장됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
    if (r.ok) onDone?.();
  }
  return (
    <>
      <p className="muted small">"_pk" 가 기본 키입니다. NORMAL_KEY 테이블은 문자열, NORMAL_KEY_LONG 테이블은 정수를 넣으세요.</p>
      <Field label="문서 (JSON)"><textarea className="mono" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} /></Field>
      <div className="row"><button className="btn primary" onClick={submit}>저장 (POST doc)</button><ResultBadge r={res} /></div>
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

function KeyOps({ conn, db, table, onDone }: P) {
  const [key, setKey] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();
  return (
    <>
      <Field label="기본 키 (_pk)"><input className="mono" value={key} onChange={(e) => setKey(e.target.value)} /></Field>
      <div className="row wrap">
        <button className="btn" disabled={!key} onClick={async () => setRes(await getDoc(conn, db, table, key))}>조회 (GET)</button>
        <button className="btn danger" disabled={!key} onClick={async () => {
          if (!(await confirm(`키 "${key}" 문서를 삭제할까요?`))) return;
          const r = await delDoc(conn, db, table, key); setRes(r);
          toast(r.ok ? '삭제됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onDone?.();
        }}>삭제 (DELETE)</button>
        <ResultBadge r={res} />
      </div>
      <p className="muted small">키 기반 GET/DELETE 경로는 문서로 확인되지 않은 추정값입니다. 404가 나면 서버 연결 편집 → 고급에서 getDoc/delDoc 경로를 조정하세요. 조회는 "조회" 탭의 SQL(where _pk = '...')로도 가능합니다.</p>
      {res && <JsonOut value={res.data ?? res.error} />}
      {confirmEl}
    </>
  );
}

function IndexOps({ conn, db, table }: P) {
  const [s, setS] = useState<IndexSpec>({ idx_name: '', idx_type: 'SIMPLE', key_type: 'NORMAL_KEY', allow_duplicate: true });
  const [dropName, setDropName] = useState('');
  const [res, setRes] = useState<ApiResult | null>(null);
  const toast = useToast();
  const up = (p: Partial<IndexSpec>) => setS((x) => ({ ...x, ...p }));
  return (
    <>
      <div className="card">
        <b>인덱스 추가</b>
        <div className="grid2" style={{ marginTop: 8 }}>
          <Field label="필드/인덱스 이름 (예: name 또는 addr.city)"><input className="mono" value={s.idx_name} onChange={(e) => up({ idx_name: e.target.value })} /></Field>
          <Field label="유형"><select value={s.idx_type} onChange={(e) => up({ idx_type: e.target.value as IndexSpec['idx_type'] })}><option>SIMPLE</option><option>NESTED</option><option>COMPOSITE</option><option>GEO</option></select></Field>
          <Field label="키 유형"><select value={s.key_type} onChange={(e) => up({ key_type: e.target.value as IndexSpec['key_type'] })}><option value="NORMAL_KEY">NORMAL_KEY (문자열)</option><option value="NORMAL_KEY_LONG">NORMAL_KEY_LONG (정수)</option></select></Field>
        </div>
        <label className="check"><input type="checkbox" checked={s.allow_duplicate} onChange={(e) => up({ allow_duplicate: e.target.checked })} /> 중복 허용</label>
        <button className="btn primary" disabled={!s.idx_name.trim()} onClick={async () => { const r = await addIndex(conn, db, table, { ...s, idx_name: s.idx_name.trim() }); setRes(r); toast(r.ok ? '인덱스 추가됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); }}>추가 (POST index)</button>
      </div>
      <div className="card">
        <b>인덱스 삭제</b>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="grow mono" placeholder="인덱스 이름" value={dropName} onChange={(e) => setDropName(e.target.value)} style={inp} />
          <button className="btn danger sm" disabled={!dropName.trim()} onClick={async () => { const r = await dropIndex(conn, db, table, dropName.trim()); setRes(r); toast(r.ok ? '삭제됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err'); }}>삭제</button>
        </div>
      </div>
      <ResultBadge r={res} />
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

function Info({ conn, db, table }: P) {
  const [res, setRes] = useState<ApiResult | null>(null);
  useEffect(() => { tableInfo(conn, db, table).then(setRes); }, [conn, db, table]);
  return (
    <>
      <div className="row"><ResultBadge r={res} /><span className="muted small">GET tableInfo (추정 경로, 서버에 따라 미지원일 수 있음)</span></div>
      {res && <JsonOut value={res.data ?? res.error} />}
    </>
  );
}

const inp: React.CSSProperties = { padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)' };
