import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { countWhere, dropTable, dropView, errorText, goQuery, goRows, goTables } from '../api/goapi';
import type { GoTableInfo } from '../api/types';
import { TopBar } from '../components/Layout';
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

  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const base = `/c/${conn.id}/db/${encodeURIComponent(db)}`;
  const shown = tables.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  const nT = tables.filter((t) => t.kind === 'table').length;

  async function drop(t: GoTableInfo) {
    if (!conn) return;
    const view = t.kind === 'view';
    if (!(await confirm(view ? `뷰 "${t.name}" 를 삭제합니다.` : `테이블 "${t.name}" 를 삭제(DROP)합니다. 데이터가 모두 사라집니다.`))) return;
    const r = view ? await dropView(conn, t.name) : await dropTable(conn, t.name);
    if (r.ok) { toast(`"${t.name}" 삭제됨`, 'ok'); load(); } else toast(`삭제 실패: ${errorText(r)}`, 'err');
  }

  async function create(sql: string, name: string): Promise<boolean> {
    if (!conn) return false;
    const r = await goQuery(conn, sql, undefined, { mode: 'exec' });
    if (!r.ok) { toast(`실패: ${errorText(r)}`, 'err'); return false; }
    toast(`"${name}" 생성됨`, 'ok');
    await load();
    if (name) nav(`${base}/t/${encodeURIComponent(name)}`);
    return true;
  }

  return (
    <>
      <TopBar title={conn.db && conn.kind !== 'sqlite' ? db : '테이블'} crumbs={[{ to: '/connections', label: '서버' }, { to: `/c/${conn.id}/dbs`, label: conn.name }]}
        right={<>
          <button className="btn sm" onClick={() => nav(`${base}/query`)}>SQL</button>
          <button className="btn sm" onClick={() => setCreating('view')}>+ 뷰</button>
          <button className="btn primary sm" onClick={() => setCreating('table')}>+ 테이블</button>
        </>} />
      <div className="toolbar">
        <input className="inp filter" placeholder="테이블·뷰 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted small">테이블 {nT} · 뷰 {tables.length - nT}</span>
        <button className="btn sm" onClick={load} disabled={loading}>{loading ? '…' : '새로고침'}</button>
      </div>
      {err && <div className="card danger">{err}</div>}
      {!err && !loading && tables.length === 0 && (
        <div className="card">
          <p><b>테이블이 없습니다.</b></p>
          <p className="muted small">"+ 테이블" 로 컬럼과 제약을 고르며 만들거나, 서버 화면의 "SQL 스크립트 실행" 으로 덤프를 복원하세요.</p>
          <button className="btn primary" onClick={() => setCreating('table')}>+ 테이블 만들기</button>
        </div>
      )}
      <div className="list">
        {shown.map((t) => (
          <div key={t.name} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`${base}/t/${encodeURIComponent(t.name)}`)}>
              <div className="title mono">
                {t.name}
                {t.kind === 'view' && <span className="badge accent" style={{ marginLeft: 8 }}>뷰</span>}
                {t.store === 'memory' && <span className="badge accent" style={{ marginLeft: 8 }}>인메모리</span>}
                {t.store === 'timeseries' && <span className="badge accent" style={{ marginLeft: 8 }}>시계열</span>}
              </div>
              <div className="sub">
                {t.kind === 'view'
                  ? viewSelect(t.sql ?? '').replace(/\s+/g, ' ').slice(0, 120)
                  : `컬럼 ${t.columns?.length ?? 0} · 인덱스 ${(t.indexes ?? []).filter((i) => !i.auto).length} · ${counts[t.name] === undefined ? '…' : `${counts[t.name]!.toLocaleString()}행`} — ${(t.columns ?? []).map((c) => c.name).join(', ')}`}
              </div>
            </div>
            <button className="btn sm danger" onClick={() => drop(t)}>삭제</button>
          </div>
        ))}
      </div>
      <button className="fab" onClick={() => setCreating('table')} aria-label="테이블 만들기">+</button>
      {creating === 'table' && <CreateTableModal tables={tables} d={dialectOf(conn)} onClose={() => setCreating(null)} onCreate={create} />}
      {creating === 'view' && (
        <CreateViewModal d={dialectOf(conn)} onClose={() => setCreating(null)} onCreate={create}
          onPreview={async (s) => { const r = await goQuery(conn, s, undefined, { limit: 5 }); if (r.ok) setPreview(goRows(r.data)); else toast(errorText(r), 'err'); }} />
      )}
      {preview && <Modal title="미리보기 (5행)" onClose={() => setPreview(null)} wide><DataTable rows={preview} /></Modal>}
      {confirmEl}
    </>
  );
}
