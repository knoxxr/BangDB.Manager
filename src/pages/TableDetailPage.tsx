import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { addIndex, delDoc, dropIndex, extractRows, getDoc, putDoc, rowCount, sql, tableInfo } from '../api/bangdb';
import { docKey, downloadText, parseDocuments, toCsv } from '../api/data';
import type { ApiResult, IndexSpec } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, Field, JsonOut, Modal, ResultBadge, describeResult, useConfirm, useToast } from '../components/ui';
import { useConnection } from '../store/store';

type Tab = 'browse' | 'put' | 'import' | 'key' | 'index' | 'info';

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
        {([['browse', '조회'], ['put', '문서 입력'], ['import', '가져오기'], ['key', '키 조회/삭제'], ['index', '인덱스'], ['info', '정보']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'browse' && <Browse conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'put' && <PutDoc conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'import' && <ImportDocs conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'key' && <KeyOps conn={conn} db={db} table={table} onDone={loadCount} />}
      {tab === 'index' && <IndexOps conn={conn} db={db} table={table} />}
      {tab === 'info' && <Info conn={conn} db={db} table={table} />}
    </>
  );
}

type P = { conn: NonNullable<ReturnType<typeof useConnection>>; db: string; table: string; onDone?: () => void };

function Browse({ conn, db, table, onDone }: P) {
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
        <input className="grow mono" placeholder="where 조건 (선택) 예: age > 30" value={where} onChange={(e) => setWhere(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} style={inp} />
        <input type="number" className="mono" value={limit} min={1} max={10000} onChange={(e) => setLimit(Number(e.target.value) || 50)} style={{ ...inp, width: 90 }} />
        <button className="btn primary sm" onClick={run} disabled={busy}>{busy ? '…' : '조회'}</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> JSON</label>
        <ResultBadge r={res} />
        {rows.length > 0 && (
          <>
            <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.json`, JSON.stringify(rows, null, 2))}>JSON 저장</button>
            <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.csv`, '﻿' + toCsv(rows), 'text/csv')}>CSV 저장</button>
          </>
        )}
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res?.ok && (raw ? <JsonOut value={res.data} /> : <DataTable rows={rows} onRowClick={(r) => setSel(r)} />)}
      {res?.ok && !raw && rows.length > 0 && <p className="muted small">행을 누르면 수정/삭제할 수 있습니다.</p>}
      {sel && (
        <RowModal doc={sel} onClose={() => setSel(null)}
          onSave={async (doc) => {
            const r = await putDoc(conn, db, table, doc);
            toast(r.ok ? '저장됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
            if (r.ok) { setSel(null); run(); onDone?.(); }
          }}
          onDelete={async (key) => {
            const r = await delDoc(conn, db, table, key);
            toast(r.ok ? '삭제됨' : `실패: ${describeResult(r)}`, r.ok ? 'ok' : 'err');
            if (r.ok) { setSel(null); run(); onDone?.(); }
          }} />
      )}
    </>
  );
}

function RowModal({ doc, onClose, onSave, onDelete }: { doc: Record<string, unknown>; onClose: () => void; onSave: (d: Record<string, unknown>) => Promise<void>; onDelete: (key: string) => Promise<void> }) {
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [busy, setBusy] = useState(false);
  const { confirm, confirmEl } = useConfirm();
  const toast = useToast();
  const key = docKey(doc);
  return (
    <Modal title={key !== undefined ? `문서 ${key}` : '문서'} onClose={onClose}>
      <Field label="JSON (수정 후 저장하면 같은 _pk 로 덮어씁니다)"><textarea className="mono" value={text} rows={12} spellCheck={false} onChange={(e) => setText(e.target.value)} /></Field>
      <div className="actions">
        {key !== undefined && (
          <button className="btn danger" disabled={busy} onClick={async () => {
            if (!(await confirm(`키 "${key}" 문서를 삭제할까요?`))) return;
            setBusy(true); try { await onDelete(key); } finally { setBusy(false); }
          }}>삭제</button>
        )}
        <span className="grow" />
        <button className="btn" onClick={onClose}>닫기</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          let d: Record<string, unknown>;
          try { d = parseDocuments(text)[0]; if (!d) throw new Error('비어 있음'); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
          setBusy(true); try { await onSave(d); } finally { setBusy(false); }
        }}>저장</button>
      </div>
      {confirmEl}
    </Modal>
  );
}

function ImportDocs({ conn, db, table, onDone }: P) {
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
    try { docs = parseDocuments(text); } catch (e) { toast(`파싱 오류: ${(e as Error).message}`, 'err'); return; }
    if (!docs.length) { toast('가져올 문서가 없습니다', 'err'); return; }
    const missing = docs.findIndex((d) => docKey(d) === undefined);
    if (missing >= 0) { toast(`${missing + 1}번째 문서에 _pk 가 없습니다`, 'err'); return; }
    stopRef.stop = false;
    const st = { done: 0, total: docs.length, failed: 0, running: true, errors: [] as string[] };
    setProg({ ...st });
    for (const d of docs) {
      if (stopRef.stop) break;
      const r = await putDoc(conn, db, table, d);
      st.done++;
      if (!r.ok) {
        st.failed++;
        if (st.errors.length < 20) st.errors.push(`${docKey(d)}: ${describeResult(r)}`);
        if (stopOnError) break;
      }
      setProg({ ...st });
    }
    st.running = false;
    setProg({ ...st });
    onDone?.();
    toast(st.failed ? `완료: ${st.done - st.failed}건 성공, ${st.failed}건 실패` : `${st.done}건 가져옴`, st.failed ? 'err' : 'ok');
  }

  return (
    <>
      <p className="muted small">JSON 배열, 한 줄에 하나씩(JSON Lines), 또는 단일 객체를 붙여넣거나 파일을 선택하세요. 각 문서에 <code>_pk</code> 가 있어야 하며 한 건씩 POST doc 으로 전송됩니다.</p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="btn sm">파일 선택<input type="file" accept=".json,.jsonl,.ndjson,.txt,application/json" style={{ display: 'none' }} onChange={pick} /></label>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> 오류 시 중단</label>
      </div>
      <Field label="문서"><textarea className="mono" value={text} rows={10} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder={'[{"_pk":"u1","name":"a"},{"_pk":"u2","name":"b"}]'} /></Field>
      <div className="row">
        <button className="btn primary" disabled={prog?.running || !text.trim()} onClick={run}>가져오기</button>
        {prog?.running && <button className="btn" onClick={() => { stopRef.stop = true; }}>중지</button>}
        {prog && <span className="small">{prog.done}/{prog.total} 처리, 실패 {prog.failed}</span>}
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
