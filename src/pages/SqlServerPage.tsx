import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { dialectOf, type Maintenance } from '../api/dialect';
import { gw, gwDatabases, gwStats, type DatabaseInfo } from '../api/gateway';
import { dumpSql, errorText, goQuery, goRows, goTables } from '../api/goapi';
import { downloadText } from '../api/data';
import type { Connection } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, JsonOut, Modal, useConfirm, usePrompt, useToast } from '../components/ui';
import { fmtBytes, kindLabel } from './ConnectionsPage';
import { ScriptModal } from './GoServerPage';

/** Overview of a PostgreSQL / MySQL / SQL Server / SQLite server reached through the gateway. */
export default function SqlServerPage({ conn }: { conn: Connection }) {
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const d = dialectOf(conn);
  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');
  const [showSys, setShowSys] = useState(false);
  const [target, setTarget] = useState(conn.defaultDb);
  const [busy, setBusy] = useState('');
  const [script, setScript] = useState(false);
  const [result, setResult] = useState<{ title: string; rows: Record<string, unknown>[] } | null>(null);
  const on = useMemo(() => (conn.kind === 'sqlite' || !target ? conn : { ...conn, db: { ...conn.db, database: target } }), [conn, target]);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([gwDatabases(conn), gwStats(conn)]);
    if (!a.ok) { setErr(errorText(a)); return; }
    setErr('');
    setDbs(a.data.databases);
    if (b.ok) setStats(b.data);
  }, [conn]);
  useEffect(() => { load(); }, [load]);

  const open = (name: string) => nav(`/c/${conn.id}/db/${encodeURIComponent(name)}`);
  const shown = (dbs ?? []).filter((x) => showSys || !x.system || x.name === conn.defaultDb);
  const scalar = Object.entries(stats ?? {}).filter(([k, v]) => k !== 'version' && (typeof v === 'number' || (typeof v === 'string' && v.length < 40)));

  async function runMaintenance(m: Maintenance) {
    if (m.confirm && !(await confirm(`${m.label} 를 ${target} 에서 실행합니다. 큰 DB 는 오래 걸리고 잠금이 생길 수 있습니다.`, '실행'))) return;
    setBusy(m.label);
    try {
      let stmts: string[];
      if (typeof m.sql === 'function') {
        const t = await goTables(on);
        if (!t.ok) throw new Error(errorText(t));
        stmts = m.sql(t.data.tables.filter((x) => x.kind === 'table').map((x) => x.name));
        if (!stmts.length) { toast('테이블이 없습니다'); return; }
      } else stmts = [m.sql];
      // one statement per request, outside a transaction: VACUUM, DBCC and CREATE/DROP DATABASE refuse to run inside one
      const rows: Record<string, unknown>[] = [];
      for (const s of stmts) {
        const r = await goQuery(on, s, undefined, { mode: 'exec' });
        if (!r.ok) throw new Error(errorText(r));
        rows.push(...goRows(r.data));
      }
      toast(`${m.label} 완료`, 'ok');
      if (rows.length) setResult({ title: m.label, rows });
    } catch (e) { toast(`${m.label} 실패: ${(e as Error).message}`, 'err'); } finally { setBusy(''); }
  }

  return (
    <>
      <TopBar title={conn.name} crumbs={[{ to: '/connections', label: '서버' }, { label: kindLabel(conn.kind) }]}
        right={<button className="btn sm" onClick={load}>새로고침</button>} />
      {err && <div className="card danger">{err} — 연결 설정(주소·계정·게이트웨이)을 확인하세요.</div>}
      {stats?.version !== undefined && <p className="muted small mono" style={{ whiteSpace: 'pre-wrap' }}>{String(stats.version).split('\n')[0]}</p>}

      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="grow">{conn.kind === 'sqlite' ? '데이터베이스 파일' : `데이터베이스 (${shown.length})`}</b>
          {(dbs ?? []).some((x) => x.system) && <label className="check small" style={{ margin: 0 }}><input type="checkbox" checked={showSys} onChange={(e) => setShowSys(e.target.checked)} /> 시스템 DB</label>}
          {d.createDatabase && <button className="btn sm" onClick={async () => {
            const name = await prompt('데이터베이스 만들기', '이름');
            if (!name) return;
            const r = await goQuery(conn, d.createDatabase!(name), undefined, { mode: 'exec' });
            if (r.ok) { toast(`"${name}" 생성됨`, 'ok'); load(); } else toast(`실패: ${errorText(r)}`, 'err');
          }}>+ DB</button>}
        </div>
        <div className="list">
          {shown.map((x) => (
            <div key={x.name} className="item">
              <div className="grow" style={{ cursor: 'pointer' }} onClick={() => open(x.name)}>
                <div className="title mono">{conn.kind === 'sqlite' ? conn.db?.file : x.name}{x.name === conn.defaultDb && conn.kind !== 'sqlite' && <span className="badge" style={{ marginLeft: 8 }}>기본</span>}{x.system && <span className="badge" style={{ marginLeft: 8 }}>시스템</span>}</div>
                <div className="sub">{fmtBytes(x.size ?? (conn.kind === 'sqlite' ? Number(stats?.size) : undefined)) || ' '}</div>
              </div>
              <button className="btn sm" onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(x.name)}/query`)}>SQL</button>
              {d.dropDatabase && !x.system && <button className="btn sm danger" onClick={async () => {
                if (!(await confirm(`데이터베이스 "${x.name}" 를 삭제(DROP)합니다. 모든 테이블과 데이터가 사라집니다.`))) return;
                const other = conn.db?.database === x.name ? { ...conn, db: { ...conn.db, database: d.id === 'postgres' ? 'postgres' : d.id === 'mssql' ? 'master' : '' } } : conn;
                await gw(conn, 'disconnect', { database: x.name }); // the gateway's own sessions would block the DROP
                const r = await goQuery(other, d.dropDatabase!(x.name), undefined, { mode: 'exec' });
                if (r.ok) { toast(`"${x.name}" 삭제됨`, 'ok'); load(); } else toast(`실패: ${errorText(r)}`, 'err');
              }}>DROP</button>}
            </div>
          ))}
          {dbs && !shown.length && <div className="muted small">데이터베이스가 없습니다</div>}
        </div>
      </div>

      {scalar.length > 0 && (
        <div className="stats">
          {scalar.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v" style={{ fontSize: 15 }}>{/size$/i.test(k) && v !== '' && !isNaN(Number(v)) ? fmtBytes(Number(v)) : typeof v === 'number' ? v.toLocaleString() : String(v)}</div></div>)}
        </div>
      )}

      <div className="card">
        <div className="row wrap">
          <b className="grow">작업 대상</b>
          {conn.kind !== 'sqlite' && (
            <select className="inp" value={target} onChange={(e) => setTarget(e.target.value)}>
              {(dbs ?? [{ name: conn.defaultDb }]).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
            </select>
          )}
        </div>
        <p className="muted small">덤프는 테이블 정의·인덱스·데이터와 뷰를 하나의 SQL 스크립트로 만듭니다(외래 키 순서 반영). 같은 종류의 DB 에서 "SQL 스크립트 실행"으로 복원합니다.</p>
        <div className="row wrap">
          <button className="btn" disabled={!!busy} onClick={async () => {
            setBusy('덤프');
            try {
              downloadText(`${(target || conn.name).replace(/[^\p{L}\p{N}._-]+/gu, '_')}-${new Date().toISOString().slice(0, 10)}.sql`, await dumpSql(on, (m) => setBusy(m)), 'application/sql');
              toast('덤프 완료', 'ok');
            } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
          }}>{busy && !d.maintenance.some((m) => m.label === busy) ? busy : '덤프 (.sql)'}</button>
          <button className="btn" onClick={() => setScript(true)}>SQL 스크립트 실행 / 복원</button>
        </div>
        <div className="list" style={{ marginTop: 12 }}>
          {d.maintenance.map((m) => (
            <div key={m.label} className="item">
              <div className="grow"><div className="title">{m.label}</div><div className="sub">{m.desc}</div></div>
              <button className="btn sm" disabled={!!busy} onClick={() => runMaintenance(m)}>{busy === m.label ? '…' : '실행'}</button>
            </div>
          ))}
        </div>
      </div>

      <details className="adv">
        <summary>원본 정보</summary>
        <JsonOut value={stats ?? {}} />
      </details>
      {script && <ScriptModal conn={on} onClose={() => setScript(false)} />}
      {result && <Modal title={result.title} onClose={() => setResult(null)} wide><DataTable rows={result.rows} /></Modal>}
      {confirmEl}{promptEl}
    </>
  );
}
