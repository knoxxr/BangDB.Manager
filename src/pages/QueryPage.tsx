import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { extractRows, sql } from '../api/bangdb';
import { downloadText, toCsv } from '../api/data';
import { dialectOf, isSqlKind, type Dialect } from '../api/dialect';
import { errorText, goQuery, goTables } from '../api/goapi';
import type { ApiResult, Connection, GoQueryResponse, GoTableInfo } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, JsonOut, ResultBadge, describeResult } from '../components/ui';
import { useDbConnection } from '../store/store';

const HIST_KEY = 'bangdb-manager.sql-history';
function loadHist(): string[] { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }

/** Templates for the statements knoxxr/bangdb supports. */
const BANGDB_SNIPPETS: [string, string][] = [
  ['SELECT … WHERE … ORDER BY … LIMIT', 'SELECT *\nFROM t\nWHERE x > 0\nORDER BY x DESC\nLIMIT 20 OFFSET 0'],
  ['JOIN + GROUP BY + HAVING', 'SELECT d.name, COUNT(*) AS n, AVG(e.salary) AS avg_salary\nFROM emp e\nJOIN dept d ON d.id = e.dept_id\nGROUP BY d.name\nHAVING COUNT(*) > 1\nORDER BY n DESC'],
  ['INSERT … RETURNING', "INSERT INTO t (name, age)\nVALUES ('kim', 31)\nRETURNING *"],
  ['UPSERT (ON CONFLICT DO UPDATE)', "INSERT INTO t (id, name)\nVALUES (1, 'kim')\nON CONFLICT (id) DO UPDATE SET name = excluded.name"],
  ['INSERT OR IGNORE / REPLACE', "INSERT OR REPLACE INTO t (id, name) VALUES (1, 'kim')"],
  ['INSERT … SELECT', 'INSERT INTO archive SELECT * FROM t WHERE created_at < date(\'now\', \'-1 year\')'],
  ['UPDATE … RETURNING', "UPDATE t SET name = 'lee' WHERE id = 1 RETURNING *"],
  ['트랜잭션 (BEGIN … COMMIT)', "BEGIN;\nUPDATE account SET balance = balance - 100 WHERE id = 1;\nUPDATE account SET balance = balance + 100 WHERE id = 2;\nCOMMIT;"],
  ['윈도우 함수', 'SELECT name, salary,\n  RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rnk,\n  SUM(salary) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving\nFROM emp'],
  ['서브쿼리 / EXISTS / UNION', 'SELECT * FROM dept d\nWHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.id)\nUNION\nSELECT * FROM dept WHERE code IN (SELECT code FROM legacy)'],
  ['JSON 함수 · -> / ->>', "SELECT id, meta ->> '$.lvl' AS lvl, json_extract(meta, '$.tags[0]') AS tag\nFROM emp\nWHERE json_valid(meta)"],
  ['날짜 함수', "SELECT date('now'), datetime('now', '+9 hours'), strftime('%Y-%m', 'now'), unixepoch('now', '-1 day')"],
  ['시계열 테이블 만들기', "CREATE TABLE cpu (ts INTEGER NOT NULL, host TEXT, usage REAL)\n  USING timeseries WITH (time_column = ts, time_unit = 's', retention = '30 days')"],
  ['시계열 집계 (time_bucket)', "SELECT time_bucket('5 minutes', ts) AS t, host, avg(usage)\nFROM cpu\nWHERE ts >= unixepoch('now', '-1 hour')\nGROUP BY t, host\nORDER BY t"],
  ['인메모리 테이블 만들기', 'CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INT, hits INT)\n  USING memory WITH (persist = true)'],
  ['외래 키·CHECK 가 있는 테이블', 'CREATE TABLE emp (\n  id INTEGER PRIMARY KEY,\n  dept_id INT REFERENCES dept ON DELETE CASCADE,\n  email TEXT NOT NULL COLLATE NOCASE,\n  salary INT CHECK (salary >= 0),\n  UNIQUE (dept_id, email)\n)'],
  ['ALTER TABLE', 'ALTER TABLE t ADD COLUMN note TEXT DEFAULT \'\';\n-- ALTER TABLE t RENAME COLUMN note TO memo;\n-- ALTER TABLE t DROP COLUMN memo;\n-- ALTER TABLE t RENAME TO t2;'],
  ['CREATE INDEX / VIEW', 'CREATE UNIQUE INDEX idx_t_email ON t (email);\nCREATE VIEW v_active AS SELECT * FROM t WHERE active = 1;'],
  ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE SELECT * FROM t WHERE id = 1'],
  ['ANALYZE / VACUUM', 'ANALYZE;\n-- VACUUM;']
];

const TX: Record<string, string> = { mssql: 'BEGIN TRANSACTION', mysql: 'START TRANSACTION' };

/** Database-specific templates for the gateway's SQL databases. */
const OWN_SNIPPETS: Record<string, [string, string][]> = {
  postgres: [
    ['UPSERT (ON CONFLICT)', "INSERT INTO t (id, name) VALUES (1, 'kim')\nON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name\nRETURNING *"],
    ['JSONB 조회', "SELECT id, meta->>'lvl' AS lvl FROM emp WHERE meta @> '{\"lvl\": 3}'"],
    ['테이블 크기', "SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size\nFROM pg_class WHERE relkind = 'r'\nORDER BY pg_total_relation_size(oid) DESC LIMIT 20"],
    ['실행 중인 쿼리', "SELECT pid, state, now() - query_start AS running, query\nFROM pg_stat_activity WHERE state <> 'idle'"],
    ['스키마 · 확장', 'CREATE SCHEMA IF NOT EXISTS app;\nSELECT * FROM pg_extension;']
  ],
  mysql: [
    ['UPSERT (ON DUPLICATE KEY)', "INSERT INTO t (id, name) VALUES (1, 'kim')\nON DUPLICATE KEY UPDATE name = VALUES(name)"],
    ['JSON 조회', "SELECT id, meta->>'$.lvl' AS lvl FROM emp WHERE JSON_EXTRACT(meta, '$.lvl') = 3"],
    ['테이블 크기', 'SELECT TABLE_NAME, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS mb\nFROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()\nORDER BY mb DESC'],
    ['실행 중인 쿼리', 'SHOW FULL PROCESSLIST'],
    ['변수 · 권한', "SHOW VARIABLES LIKE 'max_connections';\nSHOW GRANTS;"]
  ],
  mssql: [
    ['MERGE (UPSERT)', "MERGE t AS tgt\nUSING (SELECT 1 AS id, N'kim' AS name) AS src ON tgt.id = src.id\nWHEN MATCHED THEN UPDATE SET name = src.name\nWHEN NOT MATCHED THEN INSERT (id, name) VALUES (src.id, src.name);"],
    ['OUTPUT 으로 결과 받기', "INSERT INTO t (name) OUTPUT INSERTED.* VALUES (N'kim')"],
    ['DB 크기', 'EXEC sp_spaceused'],
    ['실행 중인 요청', 'SELECT session_id, status, command, wait_type, total_elapsed_time FROM sys.dm_exec_requests'],
    ['JSON 조회', "SELECT id, JSON_VALUE(meta, '$.lvl') AS lvl FROM emp"]
  ],
  sqlite: [
    ['UPSERT (ON CONFLICT)', "INSERT INTO t (id, name) VALUES (1, 'kim')\nON CONFLICT (id) DO UPDATE SET name = excluded.name\nRETURNING *"],
    ['JSON 조회', "SELECT id, meta ->> '$.lvl' AS lvl FROM emp WHERE json_valid(meta)"],
    ['스키마 보기', 'SELECT type, name, sql FROM sqlite_master'],
    ['무결성 검사', 'PRAGMA integrity_check'],
    ['설정', 'PRAGMA journal_mode;']
  ]
};

/** Example statements for the connection's database. */
function snippetsFor(d: Dialect): [string, string][] {
  if (d.id === 'bangdb') return BANGDB_SNIPPETS;
  const t = d.qt('t');
  return [
    ['SELECT … WHERE … ORDER BY', d.page(`SELECT *\nFROM ${t}\nWHERE ${d.q('x')} > 0`, `${d.q('x')} DESC`, 20, 0)],
    ['JOIN + GROUP BY + HAVING', 'SELECT d.name, COUNT(*) AS n, AVG(e.salary) AS avg_salary\nFROM emp e\nJOIN dept d ON d.id = e.dept_id\nGROUP BY d.name\nHAVING COUNT(*) > 1'],
    ['윈도우 함수', 'SELECT name, salary,\n  RANK() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rnk\nFROM emp'],
    ['CTE (WITH)', 'WITH top AS (\n  SELECT dept_id, MAX(salary) AS m FROM emp GROUP BY dept_id\n)\nSELECT * FROM top'],
    ['트랜잭션 (한 요청 안에서)', `${TX[d.id] ?? 'BEGIN'};\nUPDATE account SET balance = balance - 100 WHERE id = 1;\nUPDATE account SET balance = balance + 100 WHERE id = 2;\nCOMMIT;`],
    ...(OWN_SNIPPETS[d.id] ?? [])
  ];
}

export default function QueryPage() {
  const { connId, db = '' } = useParams();
  const conn = useDbConnection(connId, db);
  const loc = useLocation();
  const isGo = isSqlKind(conn?.kind);
  const d = dialectOf(conn);
  const snippets = snippetsFor(d);
  const [stmt, setStmt] = useState<string>((loc.state as { sql?: string } | null)?.sql ?? (isGo ? (d.id === 'mssql' ? 'SELECT TOP 20 * FROM ' : 'SELECT * FROM  LIMIT 20') : 'select * from  limit 20'));
  const [res, setRes] = useState<ApiResult | null>(null);
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState<string[]>(loadHist);
  const [args, setArgs] = useState('');
  const [limit, setLimit] = useState(1000);
  const [argErr, setArgErr] = useState('');
  const ta = useRef<HTMLTextAreaElement>(null);
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;

  function insert(text: string) {
    const el = ta.current;
    if (!el) { setStmt((s) => s + text); return; }
    const a = el.selectionStart, b = el.selectionEnd;
    const next = stmt.slice(0, a) + text + stmt.slice(b);
    setStmt(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + text.length, a + text.length); });
  }

  async function run(prefix = '') {
    if (!conn) return;
    const el = ta.current;
    const sel = el && el.selectionEnd > el.selectionStart ? stmt.slice(el.selectionStart, el.selectionEnd) : stmt;
    const s = sel.trim();
    if (!s) return;
    setBusy(true); setArgErr('');
    let r: ApiResult;
    if (isGo) {
      let a: unknown;
      if (args.trim()) {
        try { a = JSON.parse(args); } catch (e) { setArgErr(`인자 JSON 오류: ${(e as Error).message}`); setBusy(false); return; }
      }
      r = await goQuery(conn, prefix + s, a as unknown[] | undefined, { limit });
    } else r = await sql(conn, db, s);
    setRes(r); setBusy(false);
    const h = [s, ...hist.filter((x) => x !== s)].slice(0, 50);
    setHist(h); try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch { /* ignore */ }
  }

  const g = isGo && res?.ok ? (res.data as GoQueryResponse) : null;
  const rows = res?.ok ? extractRows(res.data) : [];
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  const editor = (
    <div>
      <div className="field" style={{ marginBottom: 8 }}>
        <textarea ref={ta} className="mono" value={stmt} onChange={(e) => setStmt(e.target.value)} spellCheck={false} rows={8} style={{ minHeight: 160 }}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } }} placeholder="SELECT * FROM mytable WHERE age > 30 LIMIT 20" />
      </div>
      <div className="toolbar">
        <button className="btn primary" onClick={() => run()} disabled={busy}>{busy ? '실행 중…' : '실행 (Ctrl+Enter)'}</button>
        {isGo && d.explain && <button className="btn sm" onClick={() => run(d.explain!.plan)} disabled={busy} title="실행 계획">{d.explain.plan.trim()}</button>}
        {isGo && d.explain?.analyze && <button className="btn sm" onClick={() => run(d.explain!.analyze!)} disabled={busy} title="실제로 실행하고 단계별 행 수·시간 표시">{d.explain.analyze.trim()}</button>}
        {isGo && (
          <select className="inp" value="" onChange={(e) => { if (e.target.value) setStmt(snippets[Number(e.target.value)][1]); }} style={{ maxWidth: 220 }}>
            <option value="">예제 SQL…</option>
            {snippets.map(([l], i) => <option key={i} value={i}>{l}</option>)}
          </select>
        )}
        {hist.length > 0 && (
          <select className="inp grow" value="" onChange={(e) => e.target.value && setStmt(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">히스토리…</option>
            {hist.map((h, i) => <option key={i} value={h}>{h.replace(/\s+/g, ' ').slice(0, 90)}</option>)}
          </select>
        )}
      </div>
      {isGo && (
        <details className="adv">
          <summary>매개변수 · 행 제한</summary>
          <div className="row wrap">
            <input className="inp mono grow" value={args} onChange={(e) => setArgs(e.target.value)} placeholder='매개변수 JSON: [30, "kim"] (?, ?1) 또는 {"name": "kim"} (:name)' />
            <label className="small muted">최대 행 <input className="inp" type="number" min={1} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 1000)} style={{ width: 90 }} /></label>
          </div>
          {argErr && <p className="danger small">{argErr}</p>}
        </details>
      )}
      <p className="muted small" style={{ margin: '4px 0 10px' }}>선택한 부분만 실행할 수 있습니다. 여러 문장은 ;로 구분하며 마지막 결과가 표시됩니다{d.id === 'bangdb' ? '. 한 요청 안에서 BEGIN … COMMIT 트랜잭션이 됩니다' : ` (${d.label} 에서 하나의 세션으로 실행)`}.</p>

      {res && !res.ok && <div className="card danger">{isGo ? errorText(res) : describeResult(res)}</div>}
      {res?.ok && (
        <div className="toolbar">
          <ResultBadge r={res} />
          {g && <span className="small">{g.columns.length ? `${g.rows.length.toLocaleString()}행` : '실행됨'}{g.rows_affected ? ` · 변경 ${g.rows_affected.toLocaleString()}행` : ''}{g.last_insert_id ? ` · last_insert_id ${g.last_insert_id}` : ''} · {g.ms}ms</span>}
          <span className="grow" />
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> JSON 원문</label>
          {rows.length > 0 && <button className="btn sm ghost" onClick={() => downloadText(`query-${stamp()}.csv`, '﻿' + toCsv(rows), 'text/csv')}>CSV</button>}
          {rows.length > 0 && <button className="btn sm ghost" onClick={() => downloadText(`query-${stamp()}.json`, JSON.stringify(rows, null, 2))}>JSON</button>}
        </div>
      )}
      {res?.ok && (raw ? <JsonOut value={res.data} /> : g && !g.columns.length ? null : <DataTable rows={rows} />)}
      {g?.truncated && <p className="warn small">행 제한({limit})으로 결과가 잘렸습니다. LIMIT 를 쓰거나 최대 행을 늘리세요(서버 상한 MaxRows).</p>}
    </div>
  );

  return (
    <>
      <TopBar title="SQL 콘솔" crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: `/c/${conn.id}/db/${encodeURIComponent(db)}`, label: conn.kind === 'go' || conn.kind === 'sqlite' ? '테이블' : db }]} />
      {isGo ? <div className="split"><SchemaPanel conn={conn} d={d} onInsert={insert} onSelect={(t) => setStmt(d.page(`SELECT * FROM ${d.qt(t)}`, '', 100, 0))} />{editor}</div> : editor}
      {!isGo && <p className="muted small" style={{ marginTop: 12 }}>POST /db/{db}/query 에 {'{"sql": "..."}'} 로 전송됩니다. BangDB 의 SQL-like 문법(select/where/limit 등)을 따릅니다.</p>}
    </>
  );
}

function SchemaPanel({ conn, d, onInsert, onSelect }: { conn: Connection; d: Dialect; onInsert: (t: string) => void; onSelect: (table: string) => void }) {
  const [tables, setTables] = useState<GoTableInfo[]>([]);
  useEffect(() => { goTables(conn).then((r) => r.ok && setTables(r.data.tables)); }, [conn]);
  return (
    <div className="schema">
      <div className="muted small" style={{ padding: '2px 6px 6px' }}>스키마 — 이름을 누르면 커서 위치에 넣습니다</div>
      {tables.map((t) => (
        <details key={t.name}>
          <summary>
            <span onClick={(e) => { e.preventDefault(); onInsert(d.qt(t.name)); }} title="이름 넣기">{t.name}</span>
            {t.kind === 'view' && <span className="badge" style={{ marginLeft: 6 }}>뷰</span>}
            <a href="#" className="small" style={{ float: 'right' }} onClick={(e) => { e.preventDefault(); onSelect(t.name); }} title="SELECT 문 만들기">▶</a>
          </summary>
          {(t.columns ?? []).map((c) => (
            <div key={c.name} className="colname" onClick={() => onInsert(d.q(c.name))}><span>{c.pk ? '🔑 ' : ''}{c.name}</span><span>{c.decl || c.type}</span></div>
          ))}
        </details>
      ))}
    </div>
  );
}
