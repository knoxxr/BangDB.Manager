import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createDb, dropDb, extractTables, listTables } from '../api/bangdb';
import { TopBar } from '../components/Layout';
import { Field, Modal, describeResult, useConfirm, useToast } from '../components/ui';
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

  if (!conn) return <div className="empty">연결을 찾을 수 없습니다. <a href="#/connections">서버 목록</a></div>;

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
        if (!r.ok) { toast(`DB 생성 실패: ${describeResult(r)}`, 'err'); return; }
        toast(`DB "${db}" 생성됨`, 'ok');
      }
      store.addDatabase(conn.id, db);
      setAdding(null); setName('');
    } finally { setBusy(false); }
  }

  async function drop(db: string) {
    if (!conn) return;
    if (!(await confirm(`DB "${db}" 를 서버에서 삭제(DROP)합니다. 모든 테이블과 데이터가 사라집니다. 계속할까요?`))) return;
    const r = await dropDb(conn, db);
    if (!r.ok) { toast(`삭제 실패: ${describeResult(r)}`, 'err'); return; }
    store.removeDatabase(conn.id, db);
    toast(`DB "${db}" 삭제됨`, 'ok');
  }

  return (
    <>
      <TopBar title="데이터베이스" crumbs={[{ to: '/connections', label: '서버' }, { label: conn.name }]}
        right={<><button className="btn sm" onClick={refresh}>새로고침</button><button className="btn primary sm" onClick={() => setAdding('create')}>+ 생성</button></>} />
      <p className="muted small">BangDB 서버는 보통 bangdb.config 의 DB 하나를 서비스합니다. 목록은 이 앱에 등록된 DB 이름이며, "등록"은 서버에 이미 있는 DB를 목록에만 추가합니다.</p>
      <div className="list">
        {conn.databases.map((db) => (
          <div key={db} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}`)}>
              <div className="title">{db}{db === conn.defaultDb && <span className="badge" style={{ marginLeft: 8 }}>기본</span>}</div>
              <div className="sub">{counts[db] === undefined ? '테이블 수: 새로고침으로 확인' : counts[db] === 'err' ? <span className="danger">조회 실패</span> : `테이블 ${counts[db]}개`}</div>
            </div>
            <button className="btn sm" onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}/query`)}>SQL</button>
            <button className="btn sm ghost" title="목록에서만 제거" onClick={() => store.removeDatabase(conn.id, db)}>숨김</button>
            <button className="btn sm danger" onClick={() => drop(db)}>DROP</button>
          </div>
        ))}
      </div>
      <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => setAdding('register')}>기존 DB 이름 등록</button>
      <button className="fab" onClick={() => setAdding('create')} aria-label="DB 생성">+</button>
      {adding && (
        <Modal title={adding === 'create' ? 'DB 생성' : '기존 DB 등록'} onClose={() => setAdding(null)}>
          <Field label="DB 이름"><input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          {adding === 'create' && <p className="muted small">createDb 엔드포인트(기본 PUT /db/{'{db}'})를 호출합니다. 서버가 지원하지 않으면 실패 메시지가 표시되며, 이 경우 "기존 DB 등록"을 사용하세요.</p>}
          <div className="actions">
            <button className="btn" onClick={() => setAdding(null)}>취소</button>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>{adding === 'create' ? '생성' : '등록'}</button>
          </div>
        </Modal>
      )}
      {confirmEl}
    </>
  );
}
