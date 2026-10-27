import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyze, dumpSql, errorText, goHealth, goStats, runScript, splitSql, vacuum, type ScriptProgress } from '../api/goapi';
import { downloadText } from '../api/data';
import type { ApiResult, Connection } from '../api/types';
import { TopBar } from '../components/Layout';
import { JsonOut, Modal, useConfirm, useToast } from '../components/ui';

interface Stats {
  version?: string; tables?: number; views?: number; seq?: number;
  db?: Record<string, number>;
  api?: { requests: number; rejected: number; statements: number; errors: number };
}

/** Overview and maintenance of one knoxxr/bangdb server (one database file). */
export default function GoServerPage({ conn }: { conn: Connection }) {
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [script, setScript] = useState(false);
  const base = `/c/${conn.id}/db/${encodeURIComponent(conn.defaultDb)}`;

  const load = useCallback(async () => {
    const [h, s] = await Promise.all([goHealth(conn), goStats(conn)]);
    if (!s.ok) { setErr(errorText(s)); return; }
    setErr('');
    setStats({ ...(s.data as Stats), version: (s.data as Stats).version ?? h.data?.version });
  }, [conn]);
  useEffect(() => { load(); }, [load]);

  const d = stats?.db ?? {};
  const hit = d.PageReads + d.PageCacheHits > 0 ? (d.PageCacheHits / (d.PageReads + d.PageCacheHits)) * 100 : undefined;
  const nodeHit = d.NodeHits + d.NodeMisses > 0 ? (d.NodeHits / (d.NodeHits + d.NodeMisses)) * 100 : undefined;
  const tiles: [string, string | number | undefined][] = [
    ['테이블', stats?.tables], ['뷰', stats?.views], ['커밋', d.Commits], ['문장 / 오류', d.Statements !== undefined ? `${d.Statements} / ${d.Errors}` : undefined],
    ['슬로우 쿼리', d.SlowQueries], ['WAL 페이지', d.WALPages], ['체크포인트', d.Checkpoints], ['페이지 수', d.PageCount],
    ['페이지 캐시 적중', hit === undefined ? '-' : `${hit.toFixed(1)}%`], ['노드 캐시 적중', nodeHit === undefined ? '-' : `${nodeHit.toFixed(1)}%`],
    ['열린 스냅샷', d.Snapshots], ['쓰기 락 대기', d.LockWaits], ['API 요청', stats?.api?.requests], ['인증 거부', stats?.api?.rejected]
  ];

  async function act(label: string, fn: () => Promise<ApiResult>, ok: string) {
    setBusy(label);
    const r = await fn();
    setBusy('');
    toast(r.ok ? ok : `${label} 실패: ${errorText(r)}`, r.ok ? 'ok' : 'err');
    load();
  }

  return (
    <>
      <TopBar title={conn.name} crumbs={[{ to: '/connections', label: '서버' }, { label: 'BangDB (Go)' }]}
        right={<button className="btn sm" onClick={load}>새로고침</button>} />
      {err && <div className="card danger">{err} — 서버 연결 설정(주소, 비밀번호)을 확인하세요.</div>}
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={() => nav(base)}>테이블 열기</button>
        <button className="btn" onClick={() => nav(`${base}/query`)}>SQL 콘솔</button>
      </div>
      {stats && <p className="muted small mono">{stats.version}</p>}
      <div className="stats">
        {tiles.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v">{v === undefined ? '…' : typeof v === 'number' ? v.toLocaleString() : v}</div></div>)}
      </div>

      <div className="card">
        <b>백업 · 이관</b>
        <p className="muted small">덤프는 모든 테이블의 정의·인덱스·데이터와 뷰를 하나의 SQL 스크립트로 만듭니다 (외래 키 순서 반영). 스크립트 실행은 BangDB/SQLite 덤프를 나눠 실행합니다.</p>
        <div className="row wrap">
          <button className="btn" disabled={!!busy} onClick={async () => {
            setBusy('덤프');
            try {
              const sql = await dumpSql(conn, (m) => setBusy(m));
              downloadText(`${conn.name.replace(/[^\p{L}\p{N}._-]+/gu, '_')}-${new Date().toISOString().slice(0, 10)}.sql`, sql, 'application/sql');
              toast('덤프 완료', 'ok');
            } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
          }}>{busy && busy !== 'VACUUM' && busy !== 'ANALYZE' ? busy : '전체 덤프 (.sql)'}</button>
          <button className="btn" onClick={() => setScript(true)}>SQL 스크립트 실행 / 복원</button>
        </div>
      </div>

      <div className="card">
        <b>유지 보수</b>
        <div className="list" style={{ marginTop: 8 }}>
          <div className="item">
            <div className="grow"><div className="title">ANALYZE</div><div className="sub">인덱스 통계를 모아 조인 순서·인덱스 선택을 개선합니다</div></div>
            <button className="btn sm" disabled={!!busy} onClick={() => act('ANALYZE', () => analyze(conn), 'ANALYZE 완료')}>실행</button>
          </div>
          <div className="item">
            <div className="grow"><div className="title">VACUUM</div><div className="sub">파일을 새로 압축해 삭제로 빈 공간을 돌려받습니다 (쓰기는 끝날 때까지 대기)</div></div>
            <button className="btn sm" disabled={!!busy} onClick={async () => { if (await confirm('VACUUM 을 실행합니다. 큰 DB 는 시간이 걸리며 그동안 쓰기가 대기합니다.', '실행')) act('VACUUM', () => vacuum(conn), 'VACUUM 완료'); }}>실행</button>
          </div>
        </div>
      </div>

      <details className="adv">
        <summary>원본 통계 (GET /v1/stats)</summary>
        <JsonOut value={stats ?? {}} />
      </details>
      <p className="muted small">HTTP API 에서 제공되지 않는 기능(온라인 백업 파일, 복제, 암호화 키, 무결성 검사)은 서버의 bangdb CLI(.backup, .check, -replica-of)에서 사용하세요.</p>
      {script && <ScriptModal conn={conn} onClose={() => { setScript(false); load(); }} />}
      {confirmEl}
    </>
  );
}

function ScriptModal({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [prog, setProg] = useState<(ScriptProgress & { running: boolean }) | null>(null);
  const stop = useRef(false);
  const n = text.trim() ? splitSql(text).length : 0;
  return (
    <Modal title="SQL 스크립트 실행" onClose={() => !prog?.running && onClose()} wide>
      <p className="muted small">세미콜론으로 구분된 문장을 약 256KB 씩 묶어 각각 한 트랜잭션으로 실행합니다. SQLite <code>.dump</code> 의 PRAGMA / BEGIN / COMMIT 은 건너뜁니다. 실패하면 그 묶음만 롤백되고 중단됩니다.</p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="btn sm">파일 선택<input type="file" accept=".sql,.txt" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setText(await f.text()); }} /></label>
        <span className="small muted">{n ? `${n.toLocaleString()}개 문장 · ${(text.length / 1024).toFixed(0)} KB` : ''}</span>
      </div>
      <textarea className="inp mono" style={{ width: '100%', minHeight: 200 }} value={text.length > 200000 ? `${text.slice(0, 200000)}\n-- … (미리보기는 처음 200KB 만 표시)` : text} readOnly={text.length > 200000}
        spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder="CREATE TABLE ...; INSERT INTO ...;" />
      {prog && <div className="progress"><div style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%`, background: prog.error ? 'var(--warn)' : undefined }} /></div>}
      {prog && <p className="small">{prog.done.toLocaleString()}/{prog.total.toLocaleString()} 문장 실행</p>}
      {prog?.error && <pre className="out danger">{prog.error}{prog.failedSql ? `\n\n${prog.failedSql}` : ''}</pre>}
      <div className="actions">
        {prog?.running && <button className="btn" onClick={() => { stop.current = true; }}>중지</button>}
        <span className="grow" />
        <button className="btn" disabled={prog?.running} onClick={onClose}>닫기</button>
        <button className="btn primary" disabled={!n || prog?.running} onClick={async () => {
          stop.current = false;
          setProg({ done: 0, total: n, running: true });
          const p = await runScript(conn, text, (x) => setProg({ ...x, running: true }), 256 * 1024, () => stop.current);
          setProg({ ...p, running: false });
          toast(p.error ? '스크립트 실행 중 오류' : `${p.done.toLocaleString()}개 문장 실행 완료`, p.error ? 'err' : 'ok');
        }}>실행</button>
      </div>
    </Modal>
  );
}
