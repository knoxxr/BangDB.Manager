import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { gwDatabases, gwStats, type DatabaseInfo } from '../api/gateway';
import { errorText } from '../api/goapi';
import { downloadText, parseDocuments, toCsv } from '../api/data';
import { ejsonText, mongo, parseJson, schemaOf, type CollectionInfo, type Doc, type IndexInfo } from '../api/mongo';
import type { Connection } from '../api/types';
import { TopBar } from '../components/Layout';
import { DataTable, Field, JsonOut, Modal, useConfirm, usePrompt, useToast } from '../components/ui';
import { useConnection } from '../store/store';
import { fmtBytes } from './ConnectionsPage';

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

// ================================================================ server

/** MongoDB server: databases and server status. */
export function MongoServerPage({ conn }: { conn: Connection }) {
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const [dbs, setDbs] = useState<DatabaseInfo[] | null>(null);
  const [stats, setStats] = useState<Doc | null>(null);
  const [err, setErr] = useState('');
  const [showSys, setShowSys] = useState(false);

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([gwDatabases(conn), gwStats(conn)]);
    if (!a.ok) { setErr(errorText(a)); return; }
    setErr(''); setDbs(a.data.databases); if (b.ok) setStats(b.data);
  }, [conn]);
  useEffect(() => { load(); }, [load]);

  const conns = stats?.connections as Doc | undefined;
  const ops = stats?.opcounters as Doc | undefined;
  const mem = stats?.mem as Doc | undefined;
  const tiles: [string, unknown][] = [
    ['버전', stats?.version], ['가동 시간', stats?.uptime !== undefined ? `${Math.floor(Number(stats.uptime) / 3600)}시간` : undefined],
    ['연결 (현재/가능)', conns ? `${conns.current} / ${conns.available}` : undefined], ['메모리 (MB)', mem?.resident],
    ['insert', ops?.insert], ['query', ops?.query], ['update', ops?.update], ['delete', ops?.delete]
  ];
  const shown = (dbs ?? []).filter((x) => showSys || !x.system);

  return (
    <>
      <TopBar title={conn.name} crumbs={[{ to: '/connections', label: '서버' }, { label: 'MongoDB' }]} right={<button className="btn sm" onClick={load}>새로고침</button>} />
      {err && <div className="card danger">{err}</div>}
      <div className="stats">
        {tiles.map(([k, v]) => <div key={k} className="stat"><div className="k">{k}</div><div className="v" style={{ fontSize: 15 }}>{v === undefined ? '…' : typeof v === 'number' ? v.toLocaleString() : String(ejsonText(v))}</div></div>)}
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <b className="grow">데이터베이스 ({shown.length})</b>
          <label className="check small" style={{ margin: 0 }}><input type="checkbox" checked={showSys} onChange={(e) => setShowSys(e.target.checked)} /> 시스템 DB</label>
          <button className="btn sm" onClick={async () => {
            const name = await prompt('데이터베이스 만들기', 'DB 이름 (첫 컬렉션과 함께 만들어집니다)');
            if (!name) return;
            const col = await prompt('첫 컬렉션', '컬렉션 이름', 'items');
            if (!col) return;
            const r = await mongo(conn, 'createCollection', { database: name, name: col });
            if (r.ok) { toast(`"${name}" 생성됨`, 'ok'); nav(`/c/${conn.id}/db/${encodeURIComponent(name)}`); } else toast(errorText(r), 'err');
          }}>+ DB</button>
        </div>
        <div className="list">
          {shown.map((x) => (
            <div key={x.name} className="item">
              <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(x.name)}`)}>
                <div className="title mono">{x.name}{x.system && <span className="badge" style={{ marginLeft: 8 }}>시스템</span>}</div>
                <div className="sub">{fmtBytes(x.size)}</div>
              </div>
              {!x.system && <button className="btn sm danger" onClick={async () => {
                if (!(await confirm(`데이터베이스 "${x.name}" 와 모든 컬렉션을 삭제합니다 (dropDatabase).`))) return;
                const r = await mongo(conn, 'command', { database: x.name, command: { dropDatabase: 1 } });
                if (r.ok) { toast(`"${x.name}" 삭제됨`, 'ok'); load(); } else toast(errorText(r), 'err');
              }}>삭제</button>}
            </div>
          ))}
        </div>
      </div>
      <details className="adv"><summary>serverStatus 원본</summary><JsonOut value={stats ?? {}} /></details>
      {confirmEl}{promptEl}
    </>
  );
}

// ================================================================ database

/** Collections of one database, plus a database command console. */
export function MongoDbPage() {
  const { connId, db = '' } = useParams();
  const conn = useConnection(connId);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const { prompt, promptEl } = usePrompt();
  const [cols, setCols] = useState<CollectionInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [cmd, setCmd] = useState('{ "dbStats": 1 }');
  const [cmdOut, setCmdOut] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!conn) return;
    const r = await mongo<CollectionInfo[]>(conn, 'collections', { database: db });
    if (r.ok) { setCols(r.data); setErr(''); } else setErr(errorText(r));
  }, [conn, db]);
  useEffect(() => { load(); }, [load]);
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const shown = (cols ?? []).filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <TopBar title={db} crumbs={[{ to: '/connections', label: '서버' }, { to: `/c/${conn.id}/dbs`, label: conn.name }]}
        right={<button className="btn primary sm" onClick={() => setCreating(true)}>+ 컬렉션</button>} />
      <div className="toolbar">
        <input className="inp filter" placeholder="컬렉션 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn sm" onClick={load}>새로고침</button>
      </div>
      {err && <div className="card danger">{err}</div>}
      {cols && !cols.length && <div className="empty">컬렉션이 없습니다.</div>}
      <div className="list">
        {shown.map((c) => (
          <div key={c.name} className="item">
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => nav(`/c/${conn.id}/db/${encodeURIComponent(db)}/t/${encodeURIComponent(c.name)}`)}>
              <div className="title mono">{c.name}{c.type !== 'collection' && <span className="badge accent" style={{ marginLeft: 8 }}>{c.type === 'view' ? '뷰' : c.type}</span>}{(c.options as Doc).timeseries ? <span className="badge accent" style={{ marginLeft: 8 }}>시계열</span> : null}{(c.options as Doc).capped ? <span className="badge" style={{ marginLeft: 8 }}>capped</span> : null}</div>
              <div className="sub">{c.count === null ? '' : `문서 약 ${c.count.toLocaleString()}개`}</div>
            </div>
            <button className="btn sm ghost" onClick={async () => {
              const to = await prompt('컬렉션 이름 변경', `${c.name} →`, c.name);
              if (!to || to === c.name) return;
              const r = await mongo(conn, 'renameCollection', { database: db, collection: c.name, to });
              if (r.ok) { toast('이름 변경됨', 'ok'); load(); } else toast(errorText(r), 'err');
            }}>이름 변경</button>
            <button className="btn sm danger" onClick={async () => {
              if (!(await confirm(`컬렉션 "${c.name}" 와 모든 문서·인덱스를 삭제합니다.`))) return;
              const r = await mongo(conn, 'dropCollection', { database: db, collection: c.name });
              if (r.ok) { toast('삭제됨', 'ok'); load(); } else toast(errorText(r), 'err');
            }}>삭제</button>
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <b>DB 명령 (db.runCommand)</b>
        <textarea className="inp mono" style={{ width: '100%', minHeight: 70, marginTop: 8 }} value={cmd} spellCheck={false} onChange={(e) => setCmd(e.target.value)} />
        <div className="row wrap" style={{ marginTop: 6 }}>
          <button className="btn sm primary" onClick={async () => {
            let c: unknown;
            try { c = parseJson(cmd, {}); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
            const r = await mongo(conn, 'command', { database: db, command: c });
            setCmdOut(r.ok ? r.data : { error: errorText(r) });
          }}>실행</button>
          {['{ "dbStats": 1 }', '{ "listCollections": 1, "nameOnly": true }', '{ "currentOp": 1 }', '{ "serverStatus": 1 }', '{ "usersInfo": 1 }'].map((x) => <span key={x} className="chip" onClick={() => setCmd(x)}>{x}</span>)}
        </div>
        {cmdOut !== null && <div style={{ marginTop: 8 }}><JsonOut value={cmdOut} /></div>}
      </div>
      {creating && <CreateCollectionModal onClose={() => setCreating(false)} onCreate={async (name, options) => {
        const r = await mongo(conn, 'createCollection', { database: db, name, options });
        if (!r.ok) { toast(errorText(r), 'err'); return false; }
        toast(`"${name}" 생성됨`, 'ok'); load(); return true;
      }} />}
      {confirmEl}{promptEl}
    </>
  );
}

function CreateCollectionModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, options: Doc) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'normal' | 'capped' | 'timeseries'>('normal');
  const [size, setSize] = useState(1048576);
  const [max, setMax] = useState(0);
  const [timeField, setTimeField] = useState('ts');
  const [metaField, setMetaField] = useState('');
  const [gran, setGran] = useState('seconds');
  const [ttl, setTtl] = useState(0);
  const [validator, setValidator] = useState('');
  const toast = useToast();
  return (
    <Modal title="컬렉션 만들기" onClose={onClose}>
      <Field label="이름"><input className="mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="seg" style={{ marginBottom: 10 }}>
        {([['normal', '일반'], ['capped', 'Capped (고정 크기)'], ['timeseries', '시계열']] as const).map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}
      </div>
      {kind === 'capped' && <div className="grid2"><Field label="최대 크기 (바이트)"><input type="number" value={size} onChange={(e) => setSize(Number(e.target.value))} /></Field><Field label="최대 문서 수 (0 = 무제한)"><input type="number" value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field></div>}
      {kind === 'timeseries' && (
        <div className="grid2">
          <Field label="시간 필드 (timeField)"><input className="mono" value={timeField} onChange={(e) => setTimeField(e.target.value)} /></Field>
          <Field label="메타 필드 (선택)"><input className="mono" value={metaField} onChange={(e) => setMetaField(e.target.value)} /></Field>
          <Field label="granularity"><select value={gran} onChange={(e) => setGran(e.target.value)}><option>seconds</option><option>minutes</option><option>hours</option></select></Field>
          <Field label="만료 (초, 0 = 없음)"><input type="number" value={ttl} onChange={(e) => setTtl(Number(e.target.value))} /></Field>
        </div>
      )}
      <Field label="스키마 검증 $jsonSchema (선택, JSON)"><textarea className="mono" rows={3} style={{ minHeight: 0 }} value={validator} placeholder='{"required": ["name"], "properties": {"name": {"bsonType": "string"}}}' onChange={(e) => setValidator(e.target.value)} /></Field>
      <div className="actions">
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={!name.trim()} onClick={async () => {
          const o: Doc = {};
          if (kind === 'capped') { o.capped = true; o.size = size; if (max) o.max = max; }
          if (kind === 'timeseries') { o.timeseries = { timeField, ...(metaField ? { metaField } : {}), granularity: gran }; if (ttl) o.expireAfterSeconds = ttl; }
          if (validator.trim()) { try { o.validator = { $jsonSchema: JSON.parse(validator) }; } catch (e) { toast(`검증 JSON 오류: ${(e as Error).message}`, 'err'); return; } }
          if (await onCreate(name.trim(), o)) onClose();
        }}>만들기</button>
      </div>
    </Modal>
  );
}

// ================================================================ collection

type CTab = 'docs' | 'aggregate' | 'indexes' | 'schema' | 'transfer';

export function MongoCollectionPage() {
  const { connId, db = '', table: coll = '' } = useParams();
  const conn = useConnection(connId);
  const [tab, setTab] = useState<CTab>('docs');
  if (!conn) return <div className="empty">연결을 찾을 수 없습니다.</div>;
  const at = { database: db, collection: coll };
  return (
    <>
      <TopBar title={coll} crumbs={[{ to: `/c/${conn.id}/dbs`, label: conn.name }, { to: `/c/${conn.id}/db/${encodeURIComponent(db)}`, label: db }]} />
      <div className="tabs">
        {([['docs', '문서'], ['aggregate', '집계'], ['indexes', '인덱스'], ['schema', '스키마'], ['transfer', '가져오기·내보내기']] as [CTab, string][]).map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'docs' && <DocsTab conn={conn} at={at} />}
      {tab === 'aggregate' && <AggregateTab conn={conn} at={at} />}
      {tab === 'indexes' && <IndexesTab conn={conn} at={at} />}
      {tab === 'schema' && <SchemaTab conn={conn} at={at} />}
      {tab === 'transfer' && <TransferTab conn={conn} at={at} />}
    </>
  );
}

type At = { database: string; collection: string };

/** Documents as a table of top-level fields; JSON editor for one document. */
function DocsTab({ conn, at }: { conn: Connection; at: At }) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [projection, setProjection] = useState('');
  const [q, setQ] = useState({ filter: '', sort: '', projection: '', skip: 0, limit: 50 });
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [asJson, setAsJson] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [edit, setEdit] = useState<{ doc: Doc | null } | null>(null);

  const load = useCallback(async () => {
    let f: unknown, s: unknown, p: unknown;
    try { f = parseJson(q.filter, {}); s = parseJson(q.sort, undefined); p = parseJson(q.projection, undefined); } catch (e) { setErr(`JSON 오류: ${(e as Error).message}`); return; }
    setBusy(true);
    const r = await mongo<{ docs: Doc[]; total: number | null }>(conn, 'find', { ...at, filter: f, sort: s, projection: p, skip: q.skip, limit: q.limit });
    setBusy(false);
    if (r.ok) { setDocs(r.data.docs); setTotal(r.data.total); setErr(''); setSel(new Set()); } else setErr(errorText(r));
  }, [conn, at.database, at.collection, q]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const cols = useMemo(() => { const s = new Set<string>(); docs.forEach((d) => Object.keys(d).forEach((k) => s.add(k))); return [...s]; }, [docs]);
  const apply = () => setQ({ ...q, filter, sort, projection, skip: 0 });

  return (
    <>
      <div className="toolbar">
        <input className="inp filter mono" placeholder='필터 {"price": {"$gt": 1000}}' value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <input className="inp mono" style={{ width: 170 }} placeholder='정렬 {"_id": -1}' value={sort} onChange={(e) => setSort(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <input className="inp mono" style={{ width: 170 }} placeholder='필드 {"name": 1}' value={projection} onChange={(e) => setProjection(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <button className="btn sm primary" onClick={apply} disabled={busy}>{busy ? '…' : '찾기'}</button>
      </div>
      <div className="toolbar">
        <button className="btn sm primary" onClick={() => setEdit({ doc: null })}>+ 문서 추가</button>
        {sel.size > 0 && <button className="btn sm danger" onClick={async () => {
          if (!(await confirm(`선택한 문서 ${sel.size}개를 삭제할까요?`))) return;
          const r = await mongo<{ deleted: number }>(conn, 'delete', { ...at, ids: [...sel].map((i) => docs[i]._id) });
          if (r.ok) { toast(`${r.data.deleted}개 삭제됨`, 'ok'); load(); } else toast(errorText(r), 'err');
        }}>선택 삭제 ({sel.size})</button>}
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={asJson} onChange={(e) => setAsJson(e.target.checked)} /> JSON 보기</label>
        <span className="grow" />
        <div className="pager">
          <span>{total === null ? '' : `${docs.length ? q.skip + 1 : 0}–${q.skip + docs.length} / ${total.toLocaleString()}`}</span>
          <button className="btn sm ghost" disabled={q.skip === 0} onClick={() => setQ({ ...q, skip: Math.max(0, q.skip - q.limit) })}>‹</button>
          <button className="btn sm ghost" disabled={total !== null ? q.skip + docs.length >= total : docs.length < q.limit} onClick={() => setQ({ ...q, skip: q.skip + q.limit })}>›</button>
          <select className="inp" value={q.limit} onChange={(e) => setQ({ ...q, limit: Number(e.target.value), skip: 0 })} style={{ minHeight: 32, padding: '4px 6px' }}>
            {[20, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}개씩</option>)}
          </select>
          <button className="btn sm ghost" onClick={load}>↻</button>
        </div>
      </div>
      {err && <div className="card danger">{err}</div>}
      {asJson ? <JsonOut value={docs} /> : (
        <div className="gridwrap">
          <table className="grid">
            <thead><tr><th className="lead"><input type="checkbox" checked={docs.length > 0 && sel.size === docs.length} onChange={() => setSel(sel.size === docs.length ? new Set() : new Set(docs.map((_, i) => i)))} /></th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {docs.map((d, i) => (
                <tr key={i} className={sel.has(i) ? 'sel' : ''}>
                  <td className="lead">
                    <input type="checkbox" checked={sel.has(i)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />
                    <button className="rowbtn" title="편집" onClick={() => setEdit({ doc: d })}>✎</button>
                  </td>
                  {cols.map((c) => <td key={c} className="cell ro" title={ejsonText(d[c])} onDoubleClick={() => setEdit({ doc: d })}>{d[c] === undefined ? '' : d[c] === null ? <span className="null">null</span> : ejsonText(d[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!docs.length && <div className="empty">문서가 없습니다</div>}
        </div>
      )}
      <p className="muted small">✎ 또는 행을 두 번 눌러 JSON 으로 편집합니다. ObjectId 는 {'{"$oid": "…"}'}, 날짜는 {'{"$date": "2026-01-01T00:00:00Z"}'} 로 씁니다.</p>
      {edit && (
        <DocEditor doc={edit.doc} onClose={() => setEdit(null)}
          onSave={async (doc) => {
            const r = edit.doc
              ? await mongo<{ matched: number }>(conn, 'replace', { ...at, id: edit.doc._id, doc })
              : await mongo(conn, 'insert', { ...at, docs: [doc] });
            if (!r.ok) { toast(errorText(r), 'err'); return false; }
            toast(edit.doc ? '저장됨' : '추가됨', 'ok'); load(); return true;
          }}
          onDelete={edit.doc ? async () => {
            const r = await mongo(conn, 'delete', { ...at, ids: [edit.doc!._id] });
            if (!r.ok) { toast(errorText(r), 'err'); return false; }
            toast('삭제됨', 'ok'); load(); return true;
          } : undefined} />
      )}
      {confirmEl}
    </>
  );
}

function DocEditor({ doc, onClose, onSave, onDelete }: { doc: Doc | null; onClose: () => void; onSave: (d: Doc) => Promise<boolean>; onDelete?: () => Promise<boolean> }) {
  const [text, setText] = useState(() => (doc ? pretty(doc) : '{\n  \n}'));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  return (
    <Modal title={doc ? `문서 편집 ${ejsonText(doc._id)}` : '새 문서'} onClose={onClose} wide>
      <textarea className="inp mono" style={{ width: '100%', minHeight: 320 }} value={text} spellCheck={false} autoFocus onChange={(e) => setText(e.target.value)} />
      <p className="muted small">{doc ? '문서 전체를 바꿉니다 (replaceOne). _id 는 바꿀 수 없습니다.' : '_id 를 비우면 ObjectId 가 자동으로 붙습니다.'}</p>
      <div className="actions">
        {onDelete && <button className="btn danger" disabled={busy} onClick={async () => { if (await confirm('이 문서를 삭제할까요?')) { setBusy(true); try { if (await onDelete()) onClose(); } finally { setBusy(false); } } }}>삭제</button>}
        <button className="btn ghost" onClick={() => { try { setText(pretty(JSON.parse(text))); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); } }}>정렬</button>
        <span className="grow" />
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" disabled={busy} onClick={async () => {
          let d: Doc;
          try { d = JSON.parse(text); if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('객체가 아닙니다'); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
          setBusy(true); try { if (await onSave(d)) onClose(); } finally { setBusy(false); }
        }}>{doc ? '저장 (replaceOne)' : '추가 (insertOne)'}</button>
      </div>
      {confirmEl}
    </Modal>
  );
}

const PIPELINES: [string, string][] = [
  ['그룹 집계', '[\n  { "$match": {} },\n  { "$group": { "_id": "$category", "count": { "$sum": 1 }, "avg": { "$avg": "$price" } } },\n  { "$sort": { "count": -1 } }\n]'],
  ['배열 펼치기', '[\n  { "$unwind": "$tags" },\n  { "$group": { "_id": "$tags", "n": { "$sum": 1 } } }\n]'],
  ['조인 ($lookup)', '[\n  { "$lookup": { "from": "orders", "localField": "_id", "foreignField": "productId", "as": "orders" } },\n  { "$project": { "name": 1, "orderCount": { "$size": "$orders" } } }\n]'],
  ['날짜별 개수', '[\n  { "$group": { "_id": { "$dateToString": { "format": "%Y-%m-%d", "date": "$created" } }, "n": { "$sum": 1 } } },\n  { "$sort": { "_id": 1 } }\n]']
];

function AggregateTab({ conn, at }: { conn: Connection; at: At }) {
  const toast = useToast();
  const [text, setText] = useState(PIPELINES[0][1]);
  const [out, setOut] = useState<Doc[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [asJson, setAsJson] = useState(false);
  async function run() {
    let p: unknown;
    try { p = JSON.parse(text); if (!Array.isArray(p)) throw new Error('파이프라인은 배열이어야 합니다'); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
    setBusy(true);
    const r = await mongo<{ docs: Doc[] }>(conn, 'aggregate', { ...at, pipeline: p });
    setBusy(false);
    if (r.ok) setOut(r.data.docs); else toast(errorText(r), 'err');
  }
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 6 }}>{PIPELINES.map(([l, p]) => <span key={l} className="chip" onClick={() => setText(p)}>{l}</span>)}</div>
      <textarea className="inp mono" style={{ width: '100%', minHeight: 200 }} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } }} />
      <div className="toolbar" style={{ marginTop: 6 }}>
        <button className="btn primary" disabled={busy} onClick={run}>{busy ? '실행 중…' : '집계 실행 (Ctrl+Enter)'}</button>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={asJson} onChange={(e) => setAsJson(e.target.checked)} /> JSON</label>
        {out && <span className="small">{out.length}개 결과</span>}
        {out && out.length > 0 && <button className="btn sm ghost" onClick={() => downloadText(`${at.collection}-aggregate.json`, pretty(out))}>JSON 저장</button>}
      </div>
      {out && (asJson ? <JsonOut value={out} /> : <DataTable rows={out.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, ejsonText(v)])))} />)}
      <p className="muted small">결과는 최대 1000개입니다. $out / $merge 단계로 결과를 컬렉션에 저장할 수도 있습니다.</p>
    </>
  );
}

function IndexesTab({ conn, at }: { conn: Connection; at: At }) {
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [list, setList] = useState<IndexInfo[]>([]);
  const [keys, setKeys] = useState('{ "field": 1 }');
  const [name, setName] = useState('');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState(0);
  const load = useCallback(async () => {
    const r = await mongo<IndexInfo[]>(conn, 'indexes', at);
    if (r.ok) setList(r.data); else toast(errorText(r), 'err');
  }, [conn, at.database, at.collection]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <div className="card">
        <b>인덱스 ({list.length})</b>
        <div className="list" style={{ marginTop: 8 }}>
          {list.map((i) => (
            <div key={i.name} className="item">
              <div className="grow">
                <div className="title mono">{i.name}{i.unique && <span className="badge warn" style={{ marginLeft: 6 }}>UNIQUE</span>}{i.sparse && <span className="badge" style={{ marginLeft: 6 }}>sparse</span>}{i.expireAfterSeconds !== undefined && <span className="badge" style={{ marginLeft: 6 }}>TTL {i.expireAfterSeconds}s</span>}</div>
                <div className="sub mono">{JSON.stringify(i.key)}</div>
              </div>
              {i.name !== '_id_' && <button className="btn sm danger" onClick={async () => {
                if (!(await confirm(`인덱스 "${i.name}" 를 삭제할까요?`))) return;
                const r = await mongo(conn, 'dropIndex', { ...at, name: i.name });
                if (r.ok) { toast('삭제됨', 'ok'); load(); } else toast(errorText(r), 'err');
              }}>삭제</button>}
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <b>인덱스 만들기</b>
        <Field label='키 (1 오름차순, -1 내림차순, "text" 전문, "2dsphere" 위치, "hashed")'><input className="mono" value={keys} onChange={(e) => setKeys(e.target.value)} /></Field>
        <div className="row wrap">
          <input className="inp mono grow" placeholder="이름 (선택)" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> unique</label>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={sparse} onChange={(e) => setSparse(e.target.checked)} /> sparse</label>
          <label className="small muted">TTL(초) <input className="inp" type="number" min={0} value={ttl} onChange={(e) => setTtl(Number(e.target.value))} style={{ width: 90 }} /></label>
          <button className="btn primary sm" onClick={async () => {
            let k: unknown;
            try { k = JSON.parse(keys); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
            const options: Doc = { ...(name ? { name } : {}), ...(unique ? { unique } : {}), ...(sparse ? { sparse } : {}), ...(ttl ? { expireAfterSeconds: ttl } : {}) };
            const r = await mongo<{ name: string }>(conn, 'createIndex', { ...at, keys: k, options });
            if (r.ok) { toast(`인덱스 ${r.data.name} 생성됨`, 'ok'); load(); } else toast(errorText(r), 'err');
          }}>createIndex</button>
        </div>
      </div>
      {confirmEl}
    </>
  );
}

function SchemaTab({ conn, at }: { conn: Connection; at: At }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  useEffect(() => { mongo<{ docs: Doc[] }>(conn, 'aggregate', { ...at, pipeline: [{ $sample: { size: 200 } }] }).then((r) => r.ok && setDocs(r.data.docs)); }, [conn, at.database, at.collection]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!docs) return <div className="empty">표본을 읽는 중…</div>;
  const s = schemaOf(docs);
  return (
    <>
      <p className="muted small">무작위 표본 {docs.length}개 문서의 최상위 필드와 타입 분포입니다.</p>
      <DataTable rows={s.map((f) => ({ 필드: f.field, 비율: `${Math.round((f.present / Math.max(1, docs.length)) * 100)}%`, 타입: Object.entries(f.types).map(([t, n]) => `${t} ${n}`).join(', ') }))} />
    </>
  );
}

function TransferTab({ conn, at }: { conn: Connection; at: At }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const stop = useRef(false);
  const [filter, setFilter] = useState('');

  async function exportAll(fmt: 'json' | 'jsonl' | 'csv') {
    let f: unknown;
    try { f = parseJson(filter, {}); } catch (e) { toast(`JSON 오류: ${(e as Error).message}`, 'err'); return; }
    const all: Doc[] = [];
    setBusy('읽는 중…');
    for (let skip = 0; ; skip += 1000) {
      const r = await mongo<{ docs: Doc[] }>(conn, 'find', { ...at, filter: f, skip, limit: 1000, count: false, sort: { _id: 1 } });
      if (!r.ok) { toast(errorText(r), 'err'); setBusy(''); return; }
      all.push(...r.data.docs);
      setBusy(`${all.length}개 읽음…`);
      if (r.data.docs.length < 1000) break;
    }
    setBusy('');
    const base = `${at.collection}-${new Date().toISOString().slice(0, 10)}`;
    if (fmt === 'json') downloadText(`${base}.json`, pretty(all));
    else if (fmt === 'jsonl') downloadText(`${base}.jsonl`, all.map((d) => JSON.stringify(d)).join('\n'));
    else downloadText(`${base}.csv`, '﻿' + toCsv(all.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, ejsonText(v)])))), 'text/csv');
    toast(`${all.length}개 내보냄`, 'ok');
  }

  return (
    <>
      <div className="card">
        <b>내보내기</b>
        <div className="row wrap" style={{ marginTop: 8 }}>
          <input className="inp mono grow" placeholder="필터 (선택)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="btn sm" disabled={!!busy} onClick={() => exportAll('json')}>JSON</button>
          <button className="btn sm" disabled={!!busy} onClick={() => exportAll('jsonl')}>JSONL</button>
          <button className="btn sm" disabled={!!busy} onClick={() => exportAll('csv')}>CSV</button>
          {busy && <span className="small">{busy}</span>}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>JSON/JSONL 은 Extended JSON 이라 ObjectId·날짜가 그대로 보존되어 다시 가져올 수 있습니다.</p>
      </div>
      <div className="card">
        <b>가져오기</b>
        <p className="muted small">JSON 배열 또는 JSON Lines (Extended JSON 가능). 500개씩 insertMany 로 넣습니다.</p>
        <label className="btn sm">파일 선택<input type="file" accept=".json,.jsonl,.ndjson,.txt" style={{ display: 'none' }} onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setText(await f.text()); }} /></label>
        <textarea className="inp mono" style={{ width: '100%', minHeight: 140, marginTop: 8 }} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder='[{"name": "a"}, {"name": "b"}]' />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={!text.trim() || !!busy} onClick={async () => {
            let docs: Doc[];
            try { docs = parseDocuments(text); } catch (e) { toast(`파싱 오류: ${(e as Error).message}`, 'err'); return; }
            stop.current = false;
            let n = 0;
            for (let i = 0; i < docs.length; i += 500) {
              if (stop.current) break;
              setBusy(`${i}/${docs.length}`);
              const r = await mongo<{ inserted: number }>(conn, 'insert', { ...at, docs: docs.slice(i, i + 500) });
              if (!r.ok) { toast(`${i + 1}번째부터 실패: ${errorText(r)}`, 'err'); break; }
              n += r.data.inserted;
            }
            setBusy('');
            toast(`${n}개 가져옴`, 'ok');
          }}>가져오기</button>
          {busy && <button className="btn" onClick={() => { stop.current = true; }}>중지</button>}
        </div>
      </div>
    </>
  );
}
