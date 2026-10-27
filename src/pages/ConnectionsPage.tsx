import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { extractTables, extractToken, login, ping } from '../api/bangdb';
import { Capacitor } from '@capacitor/core';
import { errorText, goHealth } from '../api/goapi';
import { gw, gwSqliteFiles } from '../api/gateway';
import { DEFAULT_ENDPOINTS, GO_KEYS, REST_KEYS } from '../api/endpoints';
import type { AuthMode, Connection, DbParams, EndpointDef, EndpointKey, HttpMethod, ServerKind } from '../api/types';
import { TopBar } from '../components/Layout';
import { Field, Modal, describeResult, useConfirm, useToast } from '../components/ui';
import { isGatewayKind, newId, normalize, store, useStore } from '../store/store';

export default function ConnectionsPage() {
  const { connections } = useStore();
  const [editing, setEditing] = useState<{ conn: Connection; isNew: boolean } | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();

  const blank = (): Connection => normalize({ id: newId(), name: '', kind: 'go', baseUrl: 'http://192.168.0.10:18081', auth: { mode: 'basic', headerName: 'x-bang-api-key', tokenField: 'token' } });

  return (
    <>
      <TopBar title="서버 연결" right={<button className="btn primary" onClick={() => setEditing({ conn: blank(), isNew: true })}>+ 추가</button>} />
      {connections.length === 0 && (
        <div className="card">
          <p><b>서버를 등록하세요.</b></p>
          <p className="muted small"><b>PostgreSQL · MySQL · SQL Server · SQLite · MongoDB · Redis</b> 는 이 앱을 띄운 서버(<code>npm run dev</code> 또는 <code>node proxy/server.mjs</code>)의 DB 게이트웨이를 거쳐 접속합니다. "+ 추가"에서 종류를 고르고 호스트·계정을 입력하세요.</p>
          <p className="muted small">두 종류의 서버를 지원합니다. <b>BangDB (Go) HTTP API</b>: <code>bangdb -http :18081 -password ...</code> 로 켠 knoxxr/bangdb 서버 (CORS 지원, 프록시 불필요). <b>BangDB 2.0 REST</b>: bangdb.com 서버의 18080 포트. REST 서버는 브라우저에서 CORS 오류가 나면 "프록시 경유"를 켜세요. Android/iOS 앱에서는 프록시 없이 직접 호출됩니다.</p>
        </div>
      )}
      <div className="list">
        {connections.map((c) => (
          <div key={c.id} className="item">
            <div className="grow" onClick={() => nav(`/c/${c.id}/dbs`)} style={{ cursor: 'pointer' }}>
              <div className="title">{c.name}</div>
              <div className="sub">{kindLabel(c.kind)} · {connTarget(c)}{c.kind === 'rest' ? ` · DB ${c.databases.length}개` : ''}{c.db ? '' : ` · 인증 ${authLabel(c.auth.mode)}`}{c.useProxy ? ' · 프록시' : ''}</div>
            </div>
            <button className="btn sm" onClick={() => setEditing({ conn: c, isNew: false })}>편집</button>
            <button className="btn sm danger" onClick={async () => { if (await confirm(`"${c.name}" 연결을 삭제할까요? (서버 데이터는 삭제되지 않습니다)`)) { store.removeConnection(c.id); toast('연결 삭제됨'); } }}>삭제</button>
          </div>
        ))}
      </div>
      {editing && (
        <ConnectionForm
          initial={editing.conn}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={(c) => { store.upsertConnection(c); setEditing(null); toast('저장됨', 'ok'); }}
        />
      )}
      {confirmEl}
    </>
  );
}

export const KIND_LABEL: Record<ServerKind, string> = {
  go: 'BangDB (Go)', rest: 'BangDB 2.0 REST', postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', mssql: 'SQL Server', sqlite: 'SQLite', mongodb: 'MongoDB', redis: 'Redis'
};
export const kindLabel = (k: ServerKind) => KIND_LABEL[k] ?? k;
const DEFAULT_PORT: Partial<Record<ServerKind, number>> = { postgres: 5432, mysql: 3306, mssql: 1433, mongodb: 27017, redis: 6379 };
const DEFAULT_USER: Partial<Record<ServerKind, string>> = { postgres: 'postgres', mysql: 'root', mssql: 'sa' };

/** One line describing where a connection points. */
export function connTarget(c: Connection): string {
  if (!c.db) return c.baseUrl;
  const d = c.db;
  const where = d.uri ? d.uri.replace(/\/\/[^@/]*@/, '//***@') : c.kind === 'sqlite' ? d.file ?? '' : `${d.host || '127.0.0.1'}:${d.port || DEFAULT_PORT[c.kind] || ''}${d.database ? `/${d.database}` : ''}`;
  return `${where} · 게이트웨이 ${c.baseUrl || '(이 앱 서버)'}`;
}
const authLabel = (m: AuthMode) => ({ none: '없음', apikey: 'API 키', basic: 'Basic', login: '로그인' }[m]);

function ConnectionForm({ initial, isNew, onClose, onSave }: { initial: Connection; isNew: boolean; onClose: () => void; onSave: (c: Connection) => void }) {
  const [c, setC] = useState<Connection>(initial);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const toast = useToast();
  const up = (p: Partial<Connection>) => setC((x) => ({ ...x, ...p }));
  const upAuth = (p: Partial<Connection['auth']>) => setC((x) => ({ ...x, auth: { ...x.auth, ...p } }));

  async function doLogin(conn: Connection): Promise<Connection> {
    const r = await login(conn);
    if (!r.ok) throw new Error(`로그인 실패: ${describeResult(r)}`);
    const token = extractToken(r.data, conn.auth.tokenField);
    if (!token) throw new Error(`로그인 응답에 "${conn.auth.tokenField}" 필드가 없습니다`);
    return { ...conn, auth: { ...conn.auth, token } };
  }

  async function test() {
    setTesting(true); setTestMsg(null);
    try {
      let conn = normalize(c);
      if (conn.db) {
        const h = await gw<{ ok: boolean; version?: string }>(conn, 'health');
        if (h.ok) setTestMsg(`연결 성공: ${h.data.version ?? kindLabel(conn.kind)} (${h.durationMs}ms)`);
        else setTestMsg(`실패: ${errorText(h)}${h.status === 0 || h.status === 404 ? ' — 게이트웨이에 닿지 못했습니다. 이 앱을 proxy/server.mjs 나 npm run dev 로 띄웠는지, 게이트웨이 주소가 맞는지 확인하세요.' : ''}`);
        return;
      }
      if (conn.auth.mode === 'login') { conn = await doLogin(conn); setC(conn); }
      if (conn.kind === 'go') {
        const h = await goHealth(conn);
        if (!h.ok) { setTestMsg(`실패: ${describeResult(h)} — bangdb 를 -http 옵션으로 실행했는지, 주소/포트가 맞는지 확인하세요.`); return; }
      }
      const r = await ping(conn, conn.defaultDb);
      if (r.ok) setTestMsg(`연결 성공: 테이블 ${extractTables(r.data).length}개 (${r.durationMs}ms)`);
      else setTestMsg(`실패: ${describeResult(r)}${r.status === 0 && !conn.useProxy ? ' — 브라우저라면 CORS 또는 네트워크 문제일 수 있습니다. "프록시 경유"를 켜보세요.' : ''}`);
    } catch (e) {
      setTestMsg(e instanceof Error ? e.message : String(e));
    } finally { setTesting(false); }
  }

  async function save() {
    if (isGatewayKind(c.kind)) {
      const d = c.db ?? {};
      if (c.kind === 'sqlite' ? !d.file?.trim() : !(d.uri?.trim() || d.host?.trim())) { toast(c.kind === 'sqlite' ? 'SQLite 파일을 지정하세요' : '호스트나 연결 문자열을 입력하세요', 'err'); return; }
    } else if (!c.baseUrl.trim()) { toast('서버 URL을 입력하세요', 'err'); return; }
    onSave(normalize(c));
  }
  const gateway = isGatewayKind(c.kind);

  return (
    <Modal title={isNew ? '서버 연결 추가' : '연결 편집'} onClose={onClose}>
      <Field label="서버 종류">
        <select value={c.kind} onChange={(e) => {
          const kind = e.target.value as ServerKind;
          if (isGatewayKind(kind)) {
            up({ kind, baseUrl: isGatewayKind(c.kind) ? c.baseUrl : '', db: { ...(c.db ?? {}), port: DEFAULT_PORT[kind], user: DEFAULT_USER[kind] } });
            return;
          }
          const was = isGatewayKind(c.kind) || !c.baseUrl;
          up({ kind, db: undefined, baseUrl: was ? (kind === 'go' ? 'http://192.168.0.10:18081' : 'http://192.168.0.10:18080') : c.baseUrl.replace(/:1808[01](\/|$)/, kind === 'go' ? ':18081$1' : ':18080$1') });
          if (kind === 'go') upAuth({ mode: 'basic' });
        }}>
          <optgroup label="BangDB">
            <option value="go">BangDB (Go) HTTP API — bangdb -http (포트 18081)</option>
            <option value="rest">BangDB 2.0 REST — bangdb.com 서버 (포트 18080)</option>
          </optgroup>
          <optgroup label="관계형 DB (게이트웨이 경유)">
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL / MariaDB</option>
            <option value="mssql">Microsoft SQL Server</option>
            <option value="sqlite">SQLite (게이트웨이 PC 의 파일)</option>
          </optgroup>
          <optgroup label="NoSQL (게이트웨이 경유)">
            <option value="mongodb">MongoDB</option>
            <option value="redis">Redis</option>
          </optgroup>
        </select>
      </Field>
      <Field label="이름"><input value={c.name} onChange={(e) => up({ name: e.target.value })} placeholder={gateway ? `예: 운영 ${kindLabel(c.kind)}` : '예: 사내 BangDB'} /></Field>
      {gateway && <GatewayFields c={c} up={up} />}
      {!gateway && <><Field label={c.kind === 'go' ? '서버 URL (bangdb -http 주소, 기본 포트 18081)' : '서버 URL (REST 포트 기본 18080)'}><input className="mono" value={c.baseUrl} inputMode="url" onChange={(e) => up({ baseUrl: e.target.value })} placeholder={c.kind === 'go' ? 'http://192.168.0.10:18081' : 'http://192.168.0.10:18080'} /></Field>
      {c.kind === 'rest' && <Field label="기본 DB 이름 (bangdb.config의 BANGDB_DATABASE_NAME)"><input className="mono" value={c.defaultDb} onChange={(e) => up({ defaultDb: e.target.value })} placeholder="mydb" /></Field>}
      {c.kind === 'go' && (
        <Field label="비밀번호 (bangdb -password 값, 없으면 비워 둠)">
          <input type="password" autoComplete="current-password" value={c.auth.pass ?? ''} onChange={(e) => upAuth({ mode: 'basic', user: c.auth.user || 'app', pass: e.target.value })} />
        </Field>
      )}
      {c.kind === 'rest' && <Field label="인증 방식">
        <select value={c.auth.mode} onChange={(e) => upAuth({ mode: e.target.value as AuthMode })}>
          <option value="none">없음</option>
          <option value="apikey">API 키 헤더</option>
          <option value="login">로그인 (user/pass → 토큰)</option>
          <option value="basic">HTTP Basic</option>
        </select>
      </Field>}
      {c.kind === 'rest' && c.auth.mode === 'apikey' && (
        <div className="grid2">
          <Field label="헤더 이름"><input className="mono" value={c.auth.headerName} onChange={(e) => upAuth({ headerName: e.target.value })} /></Field>
          <Field label="API 키"><input className="mono" type="password" value={c.auth.apiKey ?? ''} onChange={(e) => upAuth({ apiKey: e.target.value })} /></Field>
        </div>
      )}
      {c.kind === 'rest' && (c.auth.mode === 'login' || c.auth.mode === 'basic') && (
        <div className="grid2">
          <Field label="사용자"><input value={c.auth.user ?? ''} autoComplete="username" onChange={(e) => upAuth({ user: e.target.value })} /></Field>
          <Field label="비밀번호"><input type="password" autoComplete="current-password" value={c.auth.pass ?? ''} onChange={(e) => upAuth({ pass: e.target.value })} /></Field>
        </div>
      )}
      {c.kind === 'rest' && c.auth.mode === 'login' && (
        <div className="grid2">
          <Field label="토큰 헤더 이름"><input className="mono" value={c.auth.headerName} onChange={(e) => upAuth({ headerName: e.target.value })} /></Field>
          <Field label="응답의 토큰 필드"><input className="mono" value={c.auth.tokenField} onChange={(e) => upAuth({ tokenField: e.target.value })} /></Field>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={c.useProxy} onChange={(e) => up({ useProxy: e.target.checked })} /> 프록시 경유 (앱과 같은 호스트의 /bangdb 로 요청, CORS 회피)</label>
      </>}

      {!gateway && <details className="adv">
        <summary>고급: REST 엔드포인트 템플릿 재정의</summary>
        <p className="muted small">{c.kind === 'go' ? 'knoxxr/bangdb HTTP API 경로입니다. 서버 버전이 다르면 여기서 바꾸세요.' : 'BangDB 문서로 확인된 항목은 ✔, 나머지는 관례에 따른 추정값입니다. 서버 버전이 다르면 여기서 경로/메서드를 바꾸세요.'}</p>
        {(c.kind === 'go' ? GO_KEYS : REST_KEYS).map((k) => <EndpointRow key={k} k={k} value={c.endpointOverrides[k]} onChange={(v) => up({ endpointOverrides: { ...c.endpointOverrides, [k]: v } })} />)}
      </details>}

      {testMsg && <p className={`small ${testMsg.startsWith('연결 성공') ? 'ok' : 'danger'}`}>{testMsg}</p>}
      <div className="actions">
        <button className="btn" onClick={test} disabled={testing}>{testing ? '테스트 중…' : '연결 테스트'}</button>
        <button className="btn" onClick={onClose}>취소</button>
        <button className="btn primary" onClick={save}>저장</button>
      </div>
    </Modal>
  );
}

/** Database settings of a gateway connection. */
function GatewayFields({ c, up }: { c: Connection; up: (p: Partial<Connection>) => void }) {
  const d = c.db ?? {};
  const set = (p: Partial<DbParams>) => up({ db: { ...d, ...p } });
  const [files, setFiles] = useState<{ root: string; files: { file: string; size: number }[] } | null>(null);
  const [useUri, setUseUri] = useState(!!d.uri);
  const native = Capacitor.isNativePlatform();
  const uriHint: Partial<Record<ServerKind, string>> = {
    postgres: 'postgres://user:pass@host:5432/db?sslmode=require', mysql: 'mysql://user:pass@host:3306/db',
    mongodb: 'mongodb+srv://user:pass@cluster.example.net/?retryWrites=true', redis: 'redis://:pass@host:6379/0',
    mssql: 'Server=host,1433;Database=db;User Id=sa;Password=…;Encrypt=true'
  };
  const dbHint: Partial<Record<ServerKind, string>> = { postgres: 'postgres', mysql: '(선택)', mssql: 'master', mongodb: 'test', redis: '0' };
  return (
    <>
      {c.kind === 'sqlite' ? (
        <>
          <Field label="SQLite 파일 (게이트웨이의 SQLITE_ROOT 기준 경로)">
            <div className="row">
              <input className="mono grow" value={d.file ?? ''} placeholder="data/app.db" onChange={(e) => set({ file: e.target.value })} />
              <button className="btn sm" onClick={async () => { const r = await gwSqliteFiles(normalize(c)); if (r.ok) setFiles(r.data); }}>찾기</button>
            </div>
          </Field>
          {files && (
            <div className="card" style={{ padding: 8 }}>
              <div className="muted small">SQLITE_ROOT: <span className="mono">{files.root}</span> — 없는 파일 이름을 쓰면 새로 만듭니다</div>
              <div className="chips" style={{ marginTop: 6 }}>
                {files.files.map((f) => <span key={f.file} className={`chip ${d.file === f.file ? 'on' : ''}`} onClick={() => set({ file: f.file })}>{f.file} <span className="muted">{fmtBytes(f.size)}</span></span>)}
                {!files.files.length && <span className="muted small">.db / .sqlite 파일이 없습니다</span>}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="check"><input type="checkbox" checked={useUri} onChange={(e) => { setUseUri(e.target.checked); if (!e.target.checked) set({ uri: undefined }); }} /> 연결 문자열(URI)로 입력</label>
          {useUri ? (
            <Field label="연결 문자열"><input className="mono" value={d.uri ?? ''} placeholder={uriHint[c.kind]} onChange={(e) => set({ uri: e.target.value })} /></Field>
          ) : (
            <>
              <div className="grid2">
                <Field label="호스트"><input className="mono" value={d.host ?? ''} placeholder="192.168.0.10" inputMode="url" onChange={(e) => set({ host: e.target.value })} /></Field>
                <Field label="포트"><input className="mono" type="number" value={d.port ?? ''} placeholder={String(DEFAULT_PORT[c.kind] ?? '')} onChange={(e) => set({ port: Number(e.target.value) || undefined })} /></Field>
                <Field label={c.kind === 'redis' ? '사용자 (ACL, 없으면 비움)' : '사용자'}><input value={d.user ?? ''} autoComplete="username" onChange={(e) => set({ user: e.target.value })} /></Field>
                <Field label="비밀번호"><input type="password" autoComplete="current-password" value={d.password ?? ''} onChange={(e) => set({ password: e.target.value })} /></Field>
                <Field label={c.kind === 'redis' ? 'DB 번호 (0~15)' : '기본 데이터베이스'}>
                  <input className="mono" value={d.database ?? ''} placeholder={dbHint[c.kind]} onChange={(e) => set({ database: e.target.value })} />
                </Field>
                {c.kind === 'mongodb' && <Field label="authSource (선택)"><input className="mono" value={d.authSource ?? ''} placeholder="admin" onChange={(e) => set({ authSource: e.target.value })} /></Field>}
              </div>
              <label className="check"><input type="checkbox" checked={!!d.ssl} onChange={(e) => set({ ssl: e.target.checked })} /> TLS/SSL 사용</label>
              {d.ssl && <label className="check"><input type="checkbox" checked={!!d.sslInsecure} onChange={(e) => set({ sslInsecure: e.target.checked })} /> <span className="warn">인증서 검증 안 함</span> <span className="muted small">(자체 서명 인증서용. 중간자 공격에 노출됩니다)</span></label>}
            </>
          )}
        </>
      )}
      <details className="adv" open={native || !!c.baseUrl}>
        <summary>게이트웨이 {c.baseUrl ? `— ${c.baseUrl}` : '— 이 앱을 서비스하는 서버'}</summary>
        <p className="muted small">브라우저와 휴대폰은 DB 에 직접 접속할 수 없어서, DB 에 닿는 PC 에서 실행한 게이트웨이(<code>node proxy/server.mjs</code> 또는 <code>npm run dev</code>)를 거칩니다. {native ? '휴대폰 앱에서는 게이트웨이 주소를 꼭 입력하세요.' : '비워 두면 이 앱을 띄운 서버를 씁니다.'}</p>
        <div className="grid2">
          <Field label="게이트웨이 주소"><input className="mono" value={c.baseUrl} placeholder="http://192.168.0.5:8080" inputMode="url" onChange={(e) => up({ baseUrl: e.target.value })} /></Field>
          <Field label="게이트웨이 토큰 (GATEWAY_TOKEN)"><input className="mono" type="password" value={c.gatewayToken ?? ''} onChange={(e) => up({ gatewayToken: e.target.value })} /></Field>
        </div>
      </details>
    </>
  );
}

export const fmtBytes = (n: number | undefined) =>
  n === undefined || n === null || isNaN(n) ? '' : n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`;

function EndpointRow({ k, value, onChange }: { k: EndpointKey; value?: EndpointDef; onChange: (v: EndpointDef | undefined) => void }) {
  const d = DEFAULT_ENDPOINTS[k];
  const cur = value ?? d;
  return (
    <div className="row" style={{ marginBottom: 6 }}>
      <span className="small mono" style={{ width: 92 }}>{d.verified ? '✔ ' : ''}{k}</span>
      <select value={cur.method} style={{ width: 84 }} onChange={(e) => onChange({ ...cur, method: e.target.value as HttpMethod })}>
        {(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as HttpMethod[]).map((m) => <option key={m}>{m}</option>)}
      </select>
      <input className="mono grow" value={cur.path} onChange={(e) => onChange({ ...cur, path: e.target.value })} title={d.note} />
      {value && <button className="btn sm ghost" onClick={() => onChange(undefined)} title="기본값으로">↺</button>}
    </div>
  );
}
