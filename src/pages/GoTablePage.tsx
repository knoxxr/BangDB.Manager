import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ROWID, affinity, analyze, applyChanges, bulkInsert, countWhere, dropColumn, dropIndex, dropTable, dropView, dumpSql, errorText,
  goQuery, goRows, goTable, literal, pageSql, qi, readAll, renameTable, type BulkProgress, type InsertMode, type RowChange
} from '../api/goapi';
import { csvToDocs, downloadText, parseDocuments, toCsv } from '../api/data';
import type { ColumnInfo, Connection, GoQueryResponse, GoTableInfo } from '../api/types';
import { DataGrid, type GridRow } from '../components/DataGrid';
import { TopBar } from '../components/Layout';
import { RowForm } from '../components/RowForm';
import { AddColumnModal, CreateIndexForm, CreateViewModal } from '../components/SchemaForms';
import { DataTable, Modal, useConfirm, usePrompt, useToast } from '../components/ui';
import { useConnection } from '../store/store';

type Tab = 'data' | 'structure' | 'index' | 'transfer' | 'ddl';

/** Table / view page for knoxxr/bangdb (Go) connections. */
export default function GoTablePage() {
  const { connId, db = '', table = '' } = useParams();
  const conn = useConnection(connId);
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('data');
  const [info, setInfo] = useState<GoTableInfo | null | undefined>(undefined);
  const [total, setTotal] = useState<number | undefined>();
  const [infoErr, setInfoErr] = useState('');

  const loadInfo = useCallback(async () => {
    if (!conn) return;
    const r = await goTable(conn, table);
    if (r.ok) { setInfo(r.data); setInfoErr(''); } else { setInfo(null); setInfoErr(errorText(r)); }
  }, [conn, table]);
  const loadCount = useCallback(async () => { if (conn) setTotal(await countWhere(conn, table)); }, [conn, table]);
  useEffect(() => { loadInfo(); loadCount(); }, [loadInfo, loadCount]);

  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const base = `/c/${conn.id}/db/${encodeURIComponent(db)}`;
  const isView = info?.kind === 'view';
  const tabs: [Tab, string][] = isView
    ? [['data', '데이터'], ['transfer', '내보내기'], ['ddl', '정의']]
    : [['data', '데이터'], ['structure', '구조'], ['index', `인덱스${info?.indexes?.length ? ` (${info.indexes.length})` : ''}`], ['transfer', '가져오기·내보내기'], ['ddl', 'DDL']];

  return (
    <>
      <TopBar title={table} crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: base, label: '테이블' }]}
        right={<>
          {isView && <span className="badge accent">뷰</span>}
          {info?.store && <span className="badge accent">{info.store === 'memory' ? '인메모리' : info.store === 'timeseries' ? '시계열' : info.store}</span>}
          <span className="badge">{total === undefined ? '…' : `${total.toLocaleString()}행`}</span>
          <button className="btn sm" onClick={() => nav(`${base}/query`, { state: { sql: `SELECT * FROM ${qi(table)} LIMIT 100` } })}>SQL</button>
        </>} />
      {info === null && <div className="card danger">{infoErr || '테이블 정보를 가져오지 못했습니다.'}</div>}
      {info && (
        <>
          <div className="tabs">
            {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
          {tab === 'data' && <DataTab conn={conn} table={table} info={info} onChanged={loadCount} />}
          {tab === 'structure' && <StructureTab conn={conn} table={table} info={info} base={base} onChanged={() => { loadInfo(); loadCount(); }} />}
          {tab === 'index' && <IndexTab conn={conn} table={table} info={info} onChanged={loadInfo} />}
          {tab === 'transfer' && <TransferTab conn={conn} table={table} info={info} onChanged={loadCount} />}
          {tab === 'ddl' && <DdlTab conn={conn} table={table} info={info} base={base} onChanged={loadInfo} />}
        </>
      )}
    </>
  );
}

type TabProps = { conn: Connection; table: string; info: GoTableInfo; onChanged: () => void };

// ---------------------------------------------------------------- data

interface PageState { where: string; search: string; orderBy?: string; desc: boolean; limit: number; offset: number }
let newSeq = 0;

function DataTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const isView = info.kind === 'view';
  const [pg, setPg] = useState<PageState>({ where: '', search: '', desc: false, limit: 50, offset: 0 });
  const [whereIn, setWhereIn] = useState('');
  const [searchIn, setSearchIn] = useState('');
  const [data, setData] = useState<GoQueryResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [matched, setMatched] = useState<number | undefined>();
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [inserts, setInserts] = useState<string[]>([]);
  const [deleted, setDeleted] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ key?: string; isNew: boolean; values: Record<string, unknown> } | null>(null);
  const [saving, setSaving] = useState(false);

  const columns: ColumnInfo[] = useMemo(() => {
    if (!isView && info.columns?.length) return info.columns;
    return (data?.columns ?? []).filter((c) => c !== ROWID).map((name, i) => ({ name, decl: data?.types[i] ?? '' }));
  }, [info, data, isView]);

  const cond = useMemo(() => {
    const parts: string[] = [];
    if (pg.where.trim()) parts.push(`(${pg.where.trim()})`);
    if (pg.search.trim()) {
      const text = columns.filter((c) => ['TEXT', 'ANY'].includes(affinity(c)));
      const like = literal(`%${pg.search.trim()}%`);
      const targets = text.length ? text : columns;
      if (targets.length) parts.push(`(${targets.map((c) => `${qi(c.name)} LIKE ${like}`).join(' OR ')})`);
    }
    return parts.join(' AND ');
  }, [pg.where, pg.search, columns]);

  const load = useCallback(async () => {
    setBusy(true);
    const sql = pageSql(table, { where: cond, orderBy: pg.orderBy, desc: pg.desc, limit: pg.limit, offset: pg.offset }, !isView);
    const [r, n] = await Promise.all([goQuery(conn, sql), countWhere(conn, table, cond)]);
    setBusy(false);
    if (r.ok) { setData(r.data); setErr(''); } else { setData(null); setErr(errorText(r)); }
    setMatched(n);
  }, [conn, table, cond, pg.orderBy, pg.desc, pg.limit, pg.offset, isView]);
  useEffect(() => { load(); }, [load]);

  const rawRows = useMemo(() => (data ? goRows(data) : []), [data]);
  const unsafeIds = !isView && rawRows.some((r) => !Number.isSafeInteger(r[ROWID]));
  const readOnly = isView || unsafeIds;
  const rows: GridRow[] = useMemo(() => {
    const existing = rawRows.map((r, i) => {
      const { [ROWID]: id, ...values } = r;
      return { key: isView ? `v${i}` : String(id), values };
    });
    return [...inserts.map((k) => ({ key: k, values: {}, isNew: true })), ...existing];
  }, [rawRows, inserts, isView]);

  const nEdits = Object.keys(edits).filter((k) => !k.startsWith('new:') && !deleted.has(k)).length;
  const pending = nEdits + inserts.length + deleted.size;
  const reset = () => { setEdits({}); setInserts([]); setDeleted(new Set()); setSelected(new Set()); };

  useEffect(() => {
    if (!pending) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [pending]);

  async function guard(): Promise<boolean> {
    return !pending || confirm(`저장하지 않은 변경 ${pending}건을 버리고 이동할까요?`, '버리기').then((ok) => { if (ok) reset(); return ok; });
  }
  async function go(p: Partial<PageState>) { if (await guard()) setPg((x) => ({ ...x, ...p })); }

  function onEdit(key: string, col: string, value: unknown) {
    setEdits((e) => {
      const row = { ...(e[key] ?? {}) };
      const orig = rows.find((r) => r.key === key)?.values[col];
      if (!key.startsWith('new:') && (value === orig || (value !== null && orig !== null && typeof orig === 'object' && JSON.stringify(value) === JSON.stringify(orig)))) delete row[col];
      else row[col] = value;
      const next = { ...e };
      if (Object.keys(row).length) next[key] = row; else delete next[key];
      return next;
    });
  }

  const addRow = () => { const k = `new:${++newSeq}`; setInserts((l) => [k, ...l]); };

  function deleteSelected() {
    const keys = [...selected];
    const allDeleted = keys.every((k) => deleted.has(k) || k.startsWith('new:'));
    setInserts((l) => l.filter((k) => !selected.has(k)));
    setDeleted((d) => {
      const n = new Set(d);
      keys.filter((k) => !k.startsWith('new:')).forEach((k) => (allDeleted ? n.delete(k) : n.add(k)));
      return n;
    });
    setSelected(new Set());
  }

  async function commit(changes: RowChange[], msg: string): Promise<boolean> {
    try {
      const r = await applyChanges(conn, table, changes);
      if (!r.ok) { toast(`저장 실패 — 아무것도 반영되지 않았습니다: ${errorText(r)}`, 'err'); return false; }
      toast(msg, 'ok');
      return true;
    } catch (e) { toast((e as Error).message, 'err'); return false; }
  }

  async function saveAll() {
    const changes: RowChange[] = [
      ...[...deleted].map((k) => ({ kind: 'delete' as const, rowid: Number(k) })),
      ...Object.entries(edits).filter(([k]) => !k.startsWith('new:') && !deleted.has(k)).map(([k, v]) => ({ kind: 'update' as const, rowid: Number(k), values: v })),
      ...[...inserts].reverse().map((k) => ({ kind: 'insert' as const, values: edits[k] ?? {} }))
    ];
    setSaving(true);
    const ok = await commit(changes, `저장됨 — 수정 ${nEdits} · 추가 ${inserts.length} · 삭제 ${deleted.size}`);
    setSaving(false);
    if (ok) { reset(); load(); onChanged(); }
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's' && pending) { e.preventDefault(); saveAll(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  function sortBy(col: string) {
    if (pg.orderBy !== col) go({ orderBy: col, desc: false, offset: 0 });
    else if (!pg.desc) go({ desc: true, offset: 0 });
    else go({ orderBy: undefined, desc: false, offset: 0 });
  }

  const from = matched === 0 ? 0 : pg.offset + 1;
  const to = pg.offset + rawRows.length;
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const shownRows = rawRows.map(({ [ROWID]: _, ...v }) => v);

  return (
    <>
      <div className="toolbar">
        <input className="inp filter" placeholder="빠른 검색 (텍스트 컬럼)" value={searchIn} onChange={(e) => setSearchIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go({ search: searchIn, offset: 0 })} />
        <input className="inp filter mono" placeholder="WHERE 조건  예: age > 30 AND name LIKE 'k%'" value={whereIn} onChange={(e) => setWhereIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go({ where: whereIn, offset: 0 })} />
        <button className="btn sm primary" onClick={() => go({ where: whereIn, search: searchIn, offset: 0 })} disabled={busy}>{busy ? '…' : '조회'}</button>
        {(pg.where || pg.search) && <button className="btn sm ghost" onClick={() => { setWhereIn(''); setSearchIn(''); go({ where: '', search: '', offset: 0 }); }}>필터 해제</button>}
      </div>
      <div className="toolbar">
        {!readOnly && <button className="btn sm primary" onClick={addRow}>+ 행 추가</button>}
        {!readOnly && <button className="btn sm" onClick={() => setForm({ isNew: true, values: {} })}>+ 폼으로 추가</button>}
        {!readOnly && selected.size > 0 && <button className="btn sm danger" onClick={deleteSelected}>{[...selected].every((k) => deleted.has(k)) ? `삭제 취소 (${selected.size})` : `선택 삭제 (${selected.size})`}</button>}
        <span className="grow" />
        <div className="pager">
          <span>{matched === undefined ? '' : `${from.toLocaleString()}–${to.toLocaleString()} / ${matched.toLocaleString()}행`}</span>
          <button className="btn sm ghost" disabled={pg.offset === 0} onClick={() => go({ offset: 0 })} title="처음">«</button>
          <button className="btn sm ghost" disabled={pg.offset === 0} onClick={() => go({ offset: Math.max(0, pg.offset - pg.limit) })} title="이전">‹</button>
          <button className="btn sm ghost" disabled={matched !== undefined ? to >= matched : rawRows.length < pg.limit} onClick={() => go({ offset: pg.offset + pg.limit })} title="다음">›</button>
          <button className="btn sm ghost" disabled={matched === undefined || to >= matched} onClick={() => matched && go({ offset: Math.floor((matched - 1) / pg.limit) * pg.limit })} title="마지막">»</button>
          <select className="inp" value={pg.limit} onChange={(e) => go({ limit: Number(e.target.value), offset: 0 })} style={{ minHeight: 32, padding: '4px 6px' }}>
            {[25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}개씩</option>)}
          </select>
          <button className="btn sm ghost" onClick={async () => { if (await guard()) load(); }} title="새로고침">↻</button>
          {shownRows.length > 0 && <button className="btn sm ghost" onClick={() => downloadText(`${table}-${stamp()}.csv`, '﻿' + toCsv(shownRows), 'text/csv')} title="현재 페이지를 CSV 로">CSV</button>}
        </div>
      </div>
      {err && <div className="card danger">{err}</div>}
      {unsafeIds && <p className="warn small">rowid 가 JavaScript 정수 범위를 넘어 이 화면에서는 편집할 수 없습니다. SQL 콘솔을 사용하세요.</p>}
      {!err && (
        <DataGrid columns={columns} rows={rows} readOnly={readOnly} edits={edits} deleted={deleted} selected={selected}
          sort={pg.orderBy ? { col: pg.orderBy, desc: pg.desc } : undefined} onSort={sortBy}
          onEdit={onEdit} onError={(m) => toast(m, 'err')}
          onToggleSelect={(k) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
          onToggleAll={() => setSelected((s) => (rows.every((r) => s.has(r.key)) ? new Set() : new Set(rows.map((r) => r.key))))}
          onOpenRow={(r) => setForm({ key: r.key, isNew: !!r.isNew, values: { ...r.values, ...(edits[r.key] ?? {}) } })} />
      )}
      {!readOnly && !pending && rows.length > 0 && <p className="muted small">셀을 눌러 바로 수정하세요 — Enter 다음 행, Tab 다음 칸, Esc 취소. 변경은 모아서 한 트랜잭션으로 저장됩니다. ✎ 는 폼 편집.</p>}
      {data?.truncated && <p className="warn small">서버 행 수 제한으로 결과가 잘렸습니다. 페이지 크기를 줄이세요.</p>}
      {pending > 0 && (
        <div className="savebar">
          <span className="grow">저장 안 된 변경: <b>수정 {nEdits}</b> · <b className="ok">추가 {inserts.length}</b> · <b className="danger">삭제 {deleted.size}</b></span>
          <button className="btn sm" onClick={reset} disabled={saving}>모두 취소</button>
          <button className="btn sm primary" onClick={saveAll} disabled={saving}>{saving ? '저장 중…' : '변경 저장 (Ctrl+S)'}</button>
        </div>
      )}
      {form && (
        <RowForm columns={columns} values={form.values} isNew={form.isNew} readOnly={readOnly}
          title={form.isNew ? '새 행' : readOnly ? '행 보기' : `행 편집 (rowid ${form.key})`}
          onClose={() => setForm(null)}
          onSubmit={readOnly ? undefined : async (values) => {
            if (form.isNew) {
              const ok = await commit([{ kind: 'insert', values }], '행 추가됨');
              if (ok) {
                if (form.key) { setInserts((l) => l.filter((k) => k !== form.key)); setEdits((e) => { const n = { ...e }; delete n[form.key!]; return n; }); }
                load(); onChanged();
              }
              return ok;
            }
            const ok = await commit([{ kind: 'update', rowid: Number(form.key), values }], '저장됨');
            if (ok) { setEdits((e) => { const n = { ...e }; delete n[form.key!]; return n; }); load(); }
            return ok;
          }}
          onDelete={readOnly || form.isNew ? undefined : async () => {
            const ok = await commit([{ kind: 'delete', rowid: Number(form.key) }], '행 삭제됨');
            if (ok) { load(); onChanged(); }
            return ok;
          }}
          onDuplicate={readOnly ? undefined : (values) => setForm({ isNew: true, values })} />
      )}
      {confirmEl}
    </>
  );
}

// ---------------------------------------------------------------- structure

function StructureTab({ conn, table, info, base, onChanged }: TabProps & { base: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const [adding, setAdding] = useState(false);
  const constraints = useMemo(() => tableConstraints(info.sql ?? ''), [info.sql]);
  const storage = /\)\s*(USING\s+[\s\S]+?);?\s*(?:\n|$)/i.exec((info.sql ?? '').split(/;\s*\n/)[0])?.[1];

  async function run(sql: string | string[], ok: string): Promise<boolean> {
    const list = Array.isArray(sql) ? sql : [sql];
    const r = await goQuery(conn, list.length > 1 ? `BEGIN;\n${list.join(';\n')};\nCOMMIT;` : list[0], undefined, { mode: 'exec' });
    if (!r.ok) { toast(`실패: ${errorText(r)}`, 'err'); return false; }
    toast(ok, 'ok'); onChanged(); return true;
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="grow">컬럼 ({info.columns?.length ?? 0})</b>
          <button className="btn sm primary" onClick={() => setAdding(true)}>+ 컬럼 추가</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="coltable">
            <thead><tr><th>#</th><th>이름</th><th>선언 타입</th><th>저장</th><th>제약</th><th /></tr></thead>
            <tbody>
              {(info.columns ?? []).map((c, i) => (
                <tr key={c.name}>
                  <td className="muted">{i + 1}</td>
                  <td className="mono">{c.pk && <span className="pk-ico">🔑</span>}{c.name}</td>
                  <td className="mono">{c.decl || <span className="muted">ANY</span>}</td>
                  <td className="muted small">{c.type || 'ANY'}</td>
                  <td>
                    <div className="chips">
                      {c.pk && <span className="badge warn">PRIMARY KEY</span>}
                      {c.autoinc && <span className="badge">AUTOINCREMENT</span>}
                      {c.notNull && <span className="badge">NOT NULL</span>}
                      {c.unique && <span className="badge">UNIQUE</span>}
                      {c.collate && <span className="badge">COLLATE {c.collate}</span>}
                      {c.default && <span className="badge mono">DEFAULT {c.default}</span>}
                    </div>
                  </td>
                  <td className="acts">
                    <button className="btn sm ghost" onClick={async () => {
                      const to = await prompt('컬럼 이름 변경', `${c.name} →`, c.name);
                      if (to && to !== c.name) run(`ALTER TABLE ${qi(table)} RENAME COLUMN ${qi(c.name)} TO ${qi(to)}`, `컬럼 이름 변경: ${c.name} → ${to}`);
                    }}>이름 변경</button>
                    <button className="btn sm danger" onClick={async () => {
                      if (!(await confirm(`컬럼 "${c.name}" 와 그 값을 모두 삭제합니다.`))) return;
                      const r = await dropColumn(conn, table, c.name);
                      if (r.ok) { toast(`컬럼 "${c.name}" 삭제됨`, 'ok'); onChanged(); } else toast(`삭제 실패: ${errorText(r)}`, 'err');
                    }}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(constraints.length > 0 || storage) && (
        <div className="card">
          <b>테이블 제약 · 저장 방식</b>
          <div className="list" style={{ marginTop: 8 }}>
            {storage && <div className="mono small">{storage}</div>}
            {constraints.map((c, i) => <div key={i} className="mono small">{c}</div>)}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>제약을 바꾸려면 DDL 탭의 정의로 새 테이블을 만들어 데이터를 옮기세요 (INSERT INTO 새 SELECT * FROM 기존).</p>
        </div>
      )}

      <div className="card">
        <b>테이블 작업</b>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('테이블 이름 변경', `${table} →`, table);
            if (!to || to === table) return;
            const r = await renameTable(conn, table, to);
            if (r.ok) { toast(`이름 변경: ${to}`, 'ok'); nav(`${base}/t/${encodeURIComponent(to)}`, { replace: true }); } else toast(`실패: ${errorText(r)}`, 'err');
          }}>이름 변경</button>
          <button className="btn sm" onClick={async () => { const r = await analyze(conn, table); toast(r.ok ? 'ANALYZE 완료 — 인덱스 통계가 갱신됐습니다' : `실패: ${errorText(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onChanged(); }}>ANALYZE (통계 갱신)</button>
          <button className="btn sm" onClick={async () => {
            const to = await prompt('테이블 복제', '새 테이블 이름 (구조는 정의 SQL, 데이터는 INSERT … SELECT 로 복사)', `${table}_copy`);
            if (!to) return;
            const ddl = copyDdl(info.sql ?? '', table, to);
            if (await run([...ddl, `INSERT INTO ${qi(to)} SELECT * FROM ${qi(table)}`], `"${to}" 로 복제됨`)) nav(`${base}/t/${encodeURIComponent(to)}`);
          }}>복제</button>
          <span className="grow" />
          <button className="btn sm danger" onClick={async () => {
            if (!(await confirm(`"${table}" 의 모든 행을 삭제합니다 (DELETE FROM). 구조는 남습니다.`, '모두 삭제'))) return;
            run(`DELETE FROM ${qi(table)}`, '모든 행 삭제됨');
          }}>모든 행 삭제</button>
          <button className="btn sm danger" onClick={async () => {
            if (!(await confirm(`테이블 "${table}" 를 삭제(DROP)합니다. 데이터와 인덱스가 모두 사라집니다.`))) return;
            const r = await dropTable(conn, table);
            if (r.ok) { toast(`"${table}" 삭제됨`, 'ok'); nav(base, { replace: true }); } else toast(`삭제 실패: ${errorText(r)}`, 'err');
          }}>DROP TABLE</button>
        </div>
      </div>
      {adding && <AddColumnModal table={table} onClose={() => setAdding(false)} onAdd={(sqls) => run(sqls, '컬럼 추가됨')} />}
      {confirmEl}{promptEl}
    </>
  );
}

/** Table-level constraint lines of a CREATE TABLE statement. */
function tableConstraints(sql: string): string[] {
  const create = sql.split(/;\s*\n/)[0];
  return create.split('\n').map((l) => l.trim().replace(/,$/, '')).filter((l) => /^(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|CONSTRAINT)\b/i.test(l));
}

/** The table's CREATE TABLE / CREATE INDEX statements renamed for a copy. */
function copyDdl(sql: string, from: string, to: string): string[] {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean).map((s, i) => {
    if (i === 0) return s.replace(new RegExp(`^CREATE TABLE\\s+("?${esc}"?)`, 'i'), `CREATE TABLE ${qi(to)}`);
    return s.replace(new RegExp(`^CREATE (UNIQUE )?INDEX\\s+("?)([^"\\s]+)\\2\\s+ON\\s+("?${esc}"?)`, 'i'), (_m, u, _q, name) => `CREATE ${u ?? ''}INDEX ${qi(`${name}_${to}`)} ON ${qi(to)}`);
  });
}

// ---------------------------------------------------------------- indexes

function IndexTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const idx = info.indexes ?? [];
  const ts = info.store === 'timeseries';
  return (
    <>
      <div className="card">
        <b>인덱스 ({idx.length})</b>
        <div className="list" style={{ marginTop: 8 }}>
          {idx.map((i) => (
            <div key={i.name} className="item">
              <div className="grow">
                <div className="title mono">{i.name}{i.unique && <span className="badge warn" style={{ marginLeft: 6 }}>UNIQUE</span>}{i.auto && <span className="badge" style={{ marginLeft: 6 }}>자동 (PK/UNIQUE 제약)</span>}</div>
                <div className="sub mono">({(i.columns ?? [i.column]).join(', ')}){(i as { stats?: number[] }).stats?.length ? ` · 통계: ${(i as { stats?: number[] }).stats!.map((s) => s.toFixed(1)).join(' / ')}` : ''}</div>
              </div>
              {!i.auto && <button className="btn sm danger" onClick={async () => {
                if (!(await confirm(`인덱스 "${i.name}" 를 삭제할까요?`))) return;
                const r = await dropIndex(conn, i.name);
                toast(r.ok ? '인덱스 삭제됨' : `실패: ${errorText(r)}`, r.ok ? 'ok' : 'err'); if (r.ok) onChanged();
              }}>삭제</button>}
            </div>
          ))}
          {!idx.length && <div className="muted small">인덱스 없음</div>}
        </div>
      </div>
      {ts ? <p className="muted small">시계열 테이블은 보조 인덱스를 지원하지 않습니다 — 시간 조건은 시간 범위 스캔으로 처리됩니다.</p> : (
        <CreateIndexForm table={table} columns={info.columns ?? []} onCreate={async (sql) => {
          const r = await goQuery(conn, sql, undefined, { mode: 'exec' });
          toast(r.ok ? '인덱스 생성됨' : `실패: ${errorText(r)}`, r.ok ? 'ok' : 'err');
          if (r.ok) onChanged();
          return r.ok;
        }} />
      )}
      <p className="muted small">인덱스 사용 여부는 SQL 콘솔에서 EXPLAIN 으로 확인하세요. 외래 키 컬럼에는 인덱스를 권장합니다.</p>
      {confirmEl}
    </>
  );
}

// ---------------------------------------------------------------- import / export

function TransferTab({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const isView = info.kind === 'view';
  const [fmt, setFmt] = useState<'csv' | 'json' | 'jsonl' | 'sql'>('csv');
  const [where, setWhere] = useState('');
  const [exporting, setExporting] = useState('');

  async function doExport() {
    setExporting('읽는 중…');
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      if (fmt === 'sql' && !where.trim()) {
        downloadText(`${table}-${stamp}.sql`, await dumpSql(conn, setExporting, [table]), 'application/sql');
      } else {
        const { columns, rows } = await readAll(conn, table, (n) => setExporting(`${n}행 읽음…`), 500, where);
        const docs = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
        if (fmt === 'csv') downloadText(`${table}-${stamp}.csv`, '﻿' + toCsv(docs), 'text/csv');
        else if (fmt === 'json') downloadText(`${table}-${stamp}.json`, JSON.stringify(docs, null, 2));
        else if (fmt === 'jsonl') downloadText(`${table}-${stamp}.jsonl`, docs.map((d) => JSON.stringify(d)).join('\n'));
        else downloadText(`${table}-${stamp}.sql`, rows.map((r) => `INSERT INTO ${qi(table)} (${columns.map(qi).join(', ')}) VALUES (${r.map(literal).join(', ')});`).join('\n'), 'application/sql');
        toast(`${docs.length}행 내보냄`, 'ok');
      }
    } catch (e) { toast((e as Error).message, 'err'); } finally { setExporting(''); }
  }

  return (
    <>
      <div className="card">
        <b>내보내기</b>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <div className="seg">
            {(['csv', 'json', 'jsonl', 'sql'] as const).map((f) => <button key={f} className={fmt === f ? 'on' : ''} onClick={() => setFmt(f)}>{f.toUpperCase()}</button>)}
          </div>
          <input className="inp mono grow" placeholder="WHERE 조건 (선택, 비우면 전체)" value={where} onChange={(e) => setWhere(e.target.value)} />
          <button className="btn primary sm" disabled={!!exporting} onClick={doExport}>{exporting || '내보내기'}</button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>{fmt === 'sql' ? (where.trim() ? '조건에 맞는 행의 INSERT 문을 만듭니다.' : 'CREATE TABLE·인덱스 정의와 모든 행의 INSERT 문을 만듭니다. 다른 BangDB 에서 "SQL 스크립트 실행"으로 복원할 수 있습니다.') : '서버 행 제한과 상관없이 500행씩 나눠 전체를 읽습니다.'}</p>
      </div>
      {!isView && <ImportCard conn={conn} table={table} info={info} onChanged={onChanged} />}
    </>
  );
}

function ImportCard({ conn, table, info, onChanged }: TabProps) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [emptyNull, setEmptyNull] = useState(true);
  const [dropUnknown, setDropUnknown] = useState(true);
  const [mode, setMode] = useState<InsertMode>('insert');
  const [prog, setProg] = useState<(BulkProgress & { running: boolean }) | null>(null);
  const stop = useRef(false);

  const parsed = useMemo((): { docs: Record<string, unknown>[]; kind: string; error?: string } => {
    const t = text.trim();
    if (!t) return { docs: [], kind: '' };
    try {
      if (t.startsWith('[') || t.startsWith('{')) return { docs: parseDocuments(t), kind: 'JSON' };
      return { docs: csvToDocs(t, { emptyAsNull: emptyNull }), kind: t.split(/\r?\n/, 1)[0].includes('\t') ? 'TSV' : 'CSV' };
    } catch (e) { return { docs: [], kind: '', error: (e as Error).message }; }
  }, [text, emptyNull]);

  const known = new Set((info.columns ?? []).map((c) => c.name.toLowerCase()));
  const keys = useMemo(() => { const s = new Set<string>(); parsed.docs.forEach((d) => Object.keys(d).forEach((k) => s.add(k))); return [...s]; }, [parsed.docs]);
  const unknown = keys.filter((k) => !known.has(k.toLowerCase()));

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) setText(await f.text());
  }

  async function run() {
    let docs = parsed.docs;
    if (dropUnknown && unknown.length) docs = docs.map((d) => Object.fromEntries(Object.entries(d).filter(([k]) => known.has(k.toLowerCase()))));
    stop.current = false;
    setProg({ done: 0, total: docs.length, inserted: 0, running: true });
    const p = await bulkInsert(conn, table, docs, { mode, batch: 200, onProgress: (x) => setProg({ ...x, running: true }), shouldStop: () => stop.current });
    setProg({ ...p, running: false });
    onChanged();
    toast(p.error ? `${p.done}행 반영 후 중단: ${p.error}` : `${p.inserted.toLocaleString()}행 가져옴`, p.error ? 'err' : 'ok');
  }

  return (
    <div className="card">
      <b>가져오기</b>
      <p className="muted small">CSV·TSV(첫 줄이 컬럼 이름), JSON 배열, JSON Lines 를 붙여넣거나 파일을 고르세요. 200행씩 다중 행 INSERT 로 보내며 각 묶음은 원자적으로 반영됩니다.</p>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="btn sm">파일 선택<input type="file" accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson" style={{ display: 'none' }} onChange={pick} /></label>
        <div className="seg">
          {([['insert', 'INSERT'], ['ignore', '중복은 건너뛰기'], ['replace', '중복은 덮어쓰기']] as [InsertMode, string][]).map(([m, l]) => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{l}</button>)}
        </div>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} /> 빈 칸은 NULL</label>
      </div>
      <textarea className="inp mono" style={{ width: '100%', minHeight: 120 }} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
        placeholder={`${(info.columns ?? []).filter((c) => !(c.pk && affinity(c) === 'INTEGER')).map((c) => c.name).join(',')}\n...`} />
      {parsed.error && <p className="danger small">{parsed.error}</p>}
      {parsed.docs.length > 0 && (
        <>
          <p className="small">{parsed.kind} · <b>{parsed.docs.length.toLocaleString()}행</b> · 컬럼 {keys.length}개 — 미리보기 (처음 5행)</p>
          <DataTable rows={parsed.docs.slice(0, 5)} />
          {unknown.length > 0 && (
            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={dropUnknown} onChange={(e) => setDropUnknown(e.target.checked)} />
              <span className="warn small">테이블에 없는 컬럼 {unknown.join(', ')} 제외</span></label>
          )}
        </>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={!parsed.docs.length || prog?.running} onClick={run}>가져오기</button>
        {prog?.running && <button className="btn" onClick={() => { stop.current = true; }}>중지</button>}
        {prog && <span className="small">{prog.done.toLocaleString()}/{prog.total.toLocaleString()} 처리 · 반영 {prog.inserted.toLocaleString()}</span>}
      </div>
      {prog && prog.total > 0 && <div className="progress"><div style={{ width: `${(prog.done / prog.total) * 100}%`, background: prog.error ? 'var(--warn)' : undefined }} /></div>}
      {prog?.error && <pre className="out">{prog.error}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- DDL

function DdlTab({ conn, table, info, base, onChanged }: TabProps & { base: string }) {
  const toast = useToast();
  const nav = useNavigate();
  const { confirm, confirmEl } = useConfirm();
  const [editView, setEditView] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown>[] | null>(null);
  const isView = info.kind === 'view';
  const viewSelect = isView ? (info.sql ?? '').replace(/^CREATE VIEW\s+("(?:[^"]|"")+"|\S+)\s+(\([^)]*\)\s+)?AS\s+/i, '').replace(/;\s*$/, '') : '';
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(info.sql ?? ''); toast('복사됨', 'ok'); }}>복사</button>
        {isView && <button className="btn sm" onClick={() => setEditView(true)}>뷰 수정</button>}
        {isView && <button className="btn sm danger" onClick={async () => {
          if (!(await confirm(`뷰 "${table}" 를 삭제할까요? (원본 데이터는 그대로입니다)`))) return;
          const r = await dropView(conn, table);
          if (r.ok) { toast('뷰 삭제됨', 'ok'); nav(base, { replace: true }); } else toast(`실패: ${errorText(r)}`, 'err');
        }}>DROP VIEW</button>}
      </div>
      <pre className="out">{info.sql}</pre>
      {editView && (
        <CreateViewModal replace initialName={table} initialSelect={viewSelect} onClose={() => setEditView(false)}
          onPreview={async (s) => { const r = await goQuery(conn, s, undefined, { limit: 5 }); if (r.ok) setPreview(goRows(r.data)); else toast(errorText(r), 'err'); }}
          onCreate={async (sql) => {
            const r = await goQuery(conn, `BEGIN;\nDROP VIEW ${qi(table)};\n${sql};\nCOMMIT;`, undefined, { mode: 'exec' });
            if (!r.ok) { toast(`실패: ${errorText(r)}`, 'err'); return false; }
            toast('뷰 저장됨', 'ok'); onChanged(); return true;
          }} />
      )}
      {preview && <Modal title="미리보기 (5행)" onClose={() => setPreview(null)} wide><DataTable rows={preview} /></Modal>}
      {confirmEl}
    </>
  );
}

