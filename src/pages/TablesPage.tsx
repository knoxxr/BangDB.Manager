import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createTable, dropTable, extractTables, isSystemTable, listTables } from '../api/bangdb';
import type { ApiResult, CreateTableSpec, KeyType, TableType } from '../api/types';
import { TopBar } from '../components/Layout';
import { Field, Modal, ResultBadge, describeResult, useConfirm, useToast } from '../components/ui';
import { useConnection } from '../store/store';

export default function TablesPage() {
  const { connId, db = '' } = useParams();
  const conn = useConnection(connId);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [tables, setTables] = useState<string[]>([]);
  const [res, setRes] = useState<ApiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSys, setShowSys] = useState(false);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    const r = await listTables(conn, db);
    setRes(r);
    setTables(r.ok ? extractTables(r.data) : []);
    setLoading(false);
  }, [conn, db]);
  useEffect(() => { load(); }, [load]);

  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;

  const shown = tables.filter((t) => (showSys || !isSystemTable(t)) && t.toLowerCase().includes(filter.toLowerCase()));

  async function drop(t: string) {
    if (!conn) return;
    if (!(await confirm(`테이블 "${t}" 를 삭제합니다. 데이터가 모두 사라집니다.`))) return;
    const r = await dropTable(conn, db, t);
    if (r.ok) { toast(`"${t}" 삭제됨`, 'ok'); load(); } else toast(`삭제 실패: ${describeResult(r)}`, 'err');
  }

  return (
    <>
      <TopBar title={db} crumbs={[{ to: '/connections', label: '서버' }, { to: `/c/${conn.id}/dbs`, label: conn.name }, { label: 'DB' }]}
        right={<><button className="btn sm" onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}/query`)}>SQL</button><button className="btn primary sm" onClick={() => setCreating(true)}>+ 테이블</button></>} />
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <input className="grow mono" placeholder="테이블 검색" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ padding: '9px 12px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--bg)' }} />
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={showSys} onChange={(e) => setShowSys(e.target.checked)} /> 시스템 테이블</label>
        <button className="btn sm" onClick={load} disabled={loading}>{loading ? '…' : '새로고침'}</button>
        <ResultBadge r={res} />
      </div>
      {res && !res.ok && <div className="card danger">{describeResult(res)}</div>}
      {res?.ok && shown.length === 0 && <div className="empty">테이블이 없습니다.</div>}
      <div className="list">
        {shown.map((t) => (
          <div key={t} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}/t/${encodeURIComponent(t)}`)}>
              <div className="title mono">{t}</div>
              {isSystemTable(t) && <div className="sub">시스템 테이블</div>}
            </div>
            <button className="btn sm danger" onClick={() => drop(t)}>삭제</button>
          </div>
        ))}
      </div>
      <button className="fab" onClick={() => setCreating(true)} aria-label="테이블 생성">+</button>
      {creating && <CreateTableModal onClose={() => setCreating(false)} onCreate={async (spec) => {
        const r = await createTable(conn, db, spec);
        if (r.ok) { toast(`"${spec.table_name}" 생성됨`, 'ok'); setCreating(false); load(); } else toast(`생성 실패: ${describeResult(r)}`, 'err');
      }} />}
      {confirmEl}
    </>
  );
}

function CreateTableModal({ onClose, onCreate }: { onClose: () => void; onCreate: (s: CreateTableSpec) => Promise<void> }) {
  const [s, setS] = useState<CreateTableSpec>({ table_name: '', table_type: 'WIDE_TABLE', key_type: 'NORMAL_KEY', key_sz: 24, allow_duplicate: false, allow_rev_idx: false, version_type: 0 });
  const [busy, setBusy] = useState(false);
  const up = (p: Partial<CreateTableSpec>) => setS((x) => ({ ...x, ...p }));
  return (
    <Modal title="테이블 생성" onClose={onClose}>
      <Field label="테이블 이름"><input className="mono" autoFocus value={s.table_name} onChange={(e) => up({ table_name: e.target.value })} /></Field>
      <div className="grid2">
        <Field label="테이블 유형">
          <select value={s.table_type} onChange={(e) => up({ table_type: e.target.value as TableType })}>
            <option value="WIDE_TABLE">WIDE_TABLE (JSON 문서, 인덱스 가능)</option>
            <option value="NORMAL_TABLE">NORMAL_TABLE (키/값)</option>
            <option value="PRIMITIVE_TABLE">PRIMITIVE_TABLE</option>
          </select>
        </Field>
        <Field label="키 유형">
          <select value={s.key_type} onChange={(e) => up({ key_type: e.target.value as KeyType })}>
            <option value="NORMAL_KEY">NORMAL_KEY (문자열)</option>
            <option value="NORMAL_KEY_LONG">NORMAL_KEY_LONG (정수)</option>
            <option value="COMPOSITE_KEY">COMPOSITE_KEY</option>
          </select>
        </Field>
        <Field label="키 크기 (바이트)"><input type="number" min={1} value={s.key_sz} onChange={(e) => up({ key_sz: Number(e.target.value) })} /></Field>
        <Field label="버전 관리"><select value={s.version_type} onChange={(e) => up({ version_type: Number(e.target.value) })}><option value={0}>사용 안 함</option><option value={1}>사용</option></select></Field>
      </div>
      <label className="check"><input type="checkbox" checked={s.allow_duplicate} onChange={(e) => up({ allow_duplicate: e.target.checked })} /> 중복 키 허용 (allow_duplicate)</label>
      <label className="check"><input type="checkbox" checked={s.allow_rev_idx} onChange={(e) => up({ allow_rev_idx: e.target.checked })} /> 역 인덱스 (allow_rev_idx, WIDE_TABLE)</label>
      <div className="actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy || !s.table_name.trim()} onClick={async () => { setBusy(true); try { await onCreate({ ...s, table_name: s.table_name.trim() }); } finally { setBusy(false); } }}>생성</button>
      </div>
    </Modal>
  );
}
