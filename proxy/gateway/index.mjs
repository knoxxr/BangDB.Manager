// Database gateway: lets the browser / phone app use databases that speak
// their own wire protocols. Every call is `POST /gw/<op>` with a JSON body
// `{ conn: {kind, host, port, user, password, database, uri, file, ssl}, ... }`.
//
//   SQL kinds (postgres, mysql, mssql, sqlite):
//     health, tables, table, query, batch, databases, stats
//   mongodb: mongo/<op>   redis: redis/<op>
//
// GATEWAY_TOKEN, if set, must be sent as the x-gateway-token header; without
// it only same-origin pages on this machine are served (see gate()).
// GATEWAY_ALLOWED_HOSTS limits the database hosts, SQLITE_ROOT the SQLite files.
import { timingSafeEqual } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { mongodb } from './mongo.mjs';
import { redis } from './redis.mjs';
import { mssql, mysql, postgres, sqlite, sqliteRoot } from './sql.mjs';

const FACTORIES = { postgres, mysql, mssql, sqlite, mongodb, redis };
const SQL_KINDS = new Set(['postgres', 'mysql', 'mssql', 'sqlite']);
const TOKEN = process.env.GATEWAY_TOKEN || '';
const MAX_BODY = Number(process.env.GATEWAY_MAX_BODY || 32 << 20);
const IDLE_MS = 10 * 60 * 1000;

/** Open adapters keyed by their connection settings; closed after IDLE_MS unused. */
const pools = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of pools) if (now - p.used > IDLE_MS) { pools.delete(k); p.adapter.then((a) => a.close()).catch(() => {}); }
}, 60 * 1000).unref();

async function adapterFor(conn) {
  const f = FACTORIES[conn?.kind];
  if (!f) throw Object.assign(new Error(`지원하지 않는 종류: ${conn?.kind}`), { status: 400 });
  checkHost(conn);
  const key = keyOf(conn);
  let p = pools.get(key);
  if (!p) {
    p = { adapter: f(conn), used: Date.now() };
    pools.set(key, p);
    p.adapter.catch(() => pools.delete(key));
  }
  p.used = Date.now();
  return p.adapter;
}

const keyOf = (conn) => JSON.stringify([conn.kind, conn.uri, conn.host, conn.port, conn.user, conn.password, conn.database, conn.file, conn.ssl, conn.sslInsecure, conn.authSource]);

/** Close and forget the adapter for these settings (after a connection error, or on request). */
function drop(conn) {
  const p = pools.get(keyOf(conn));
  if (p) { pools.delete(keyOf(conn)); p.adapter.then((a) => a.close()).catch(() => {}); }
}

async function handle(op, body) {
  const conn = { ...(body.conn ?? {}) };
  if (body.database !== undefined && body.database !== '') conn.database = body.database;

  if (op === 'sqlite/files') return sqliteFiles();
  if (op === 'disconnect') { drop(conn); return { ok: true }; }

  const a = await adapterFor(conn);
  if (op.startsWith('mongo/') || op.startsWith('redis/')) {
    const fn = a.ops?.[op.split('/')[1]];
    if (!fn) throw Object.assign(new Error(`알 수 없는 작업: ${op}`), { status: 404 });
    return fn(body);
  }
  if (!SQL_KINDS.has(conn.kind)) {
    if (op === 'health') return { ok: true, kind: conn.kind };
    if (op === 'databases') return { databases: await a.ops.databases(body) };
    if (op === 'stats') return a.ops.stats(body);
    throw Object.assign(new Error(`${conn.kind} 에는 ${op} 가 없습니다`), { status: 404 });
  }
  switch (op) {
    case 'health': { const s = await a.stats(); return { ok: true, version: s.version }; }
    case 'tables': { const t = await a.tables(); return { tables: t, count: t.length }; }
    case 'table': {
      const [t] = await a.tables(body.table);
      if (!t) throw Object.assign(new Error(`테이블이나 뷰가 없습니다: ${body.table}`), { status: 404, code: 'not_found' });
      return t;
    }
    case 'query': {
      if (!String(body.sql ?? '').trim()) throw Object.assign(new Error('"sql" 이 필요합니다'), { status: 400 });
      const start = performance.now();
      const r = await a.query(body.sql, body.args, { mode: body.mode, limit: Math.min(Number(body.limit) || 1000, 100000) });
      return { ...r, ms: Math.round((performance.now() - start) * 1000) / 1000 };
    }
    case 'batch': return { results: await a.batch(body.statements ?? []) };
    case 'databases': return { databases: await a.databases() };
    case 'stats': return a.stats();
  }
  throw Object.assign(new Error(`알 수 없는 작업: ${op}`), { status: 404 });
}

function sqliteFiles() {
  const root = sqliteRoot();
  const out = [];
  const walk = (dir, depth) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(dir, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
      else if (/\.(db|sqlite3?|db3)$/i.test(n)) out.push({ file: relative(root, p).replace(/\\/g, '/'), size: st.size });
    }
  };
  walk(root, 0);
  return { root, files: out.slice(0, 500) };
}

/** HTTP status and code for a driver error. */
function classify(e) {
  if (e.status) return [e.status, e.code && typeof e.code === 'string' ? e.code : 'request'];
  const code = String(e.code ?? '');
  const n = Number(e.number ?? e.errno);
  if (/^23/.test(code) || [1062, 1451, 1452, 1216, 1217, 3819, 2627, 2601, 547].includes(n) || /CONSTRAINT/i.test(code) || /constraint failed/i.test(e.message)) return [409, 'constraint'];
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ESOCKET', 'ETIMEOUT', 'ELOGIN'].includes(code) || code === '28P01' || code === '3D000' || n === 1045 || n === 18456 || /ECONNREFUSED|Server selection timed out|connect/i.test(e.name ?? '')) return [502, 'connection'];
  return [400, 'error'];
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const tokenOk = (sent) => {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Who may use the gateway. With GATEWAY_TOKEN: whoever sends it. Without:
 * fail closed — only requests from this machine whose page has the same
 * origin as the gateway (so another website open in the browser cannot
 * drive it, and nobody on the network can).
 */
function gate(req) {
  if (TOKEN) return tokenOk(req.headers['x-gateway-token']) ? null : { status: 401, code: 'unauthorized', error: '게이트웨이 토큰이 맞지 않습니다' };
  const local = LOOPBACK.has(req.socket?.remoteAddress ?? '');
  // Host must be a loopback name too: a rebinding domain resolving to 127.0.0.1
  // would otherwise look like a same-origin page
  const host = String(req.headers.host ?? '');
  const hostOk = LOOPBACK_NAMES.has(host.replace(/:\d+$/, '').toLowerCase());
  const origin = req.headers.origin;
  let sameOrigin = !origin;
  if (origin) { try { sameOrigin = new URL(origin).host.toLowerCase() === host.toLowerCase(); } catch { sameOrigin = false; } }
  if (local && hostOk && sameOrigin) return null;
  return { status: 403, code: 'gateway_disabled', error: '이 게이트웨이는 GATEWAY_TOKEN 없이 이 PC 의 같은 주소에서 연 앱만 허용합니다. 다른 기기나 주소에서 쓰려면 서버를 GATEWAY_TOKEN=<비밀값> 으로 실행하고 연결 편집에 같은 토큰을 넣으세요.' };
}

/** GATEWAY_ALLOWED_HOSTS=db1.local,10.0.0.5 limits which database hosts the gateway connects to. */
const ALLOWED_HOSTS = (process.env.GATEWAY_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function checkHost(conn) {
  if (!ALLOWED_HOSTS.length || conn.kind === 'sqlite') return;
  // connection strings can name other hosts in ways only each driver parses
  // (query parameters, multi-host lists, SRV records): refuse them outright
  if (conn.uri) throw Object.assign(new Error('GATEWAY_ALLOWED_HOSTS 가 설정된 게이트웨이는 연결 문자열을 받지 않습니다. 호스트·포트 칸을 쓰세요.'), { status: 403, code: 'host_not_allowed' });
  const host = conn.host || '127.0.0.1';
  if (!ALLOWED_HOSTS.includes(String(host).toLowerCase().replace(/^\[|\]$/g, ''))) {
    throw Object.assign(new Error(`GATEWAY_ALLOWED_HOSTS 에 없는 호스트입니다: ${host}`), { status: 403, code: 'host_not_allowed' });
  }
}

/**
 * Node HTTP handler for /gw/* — returns false when the path is not a gateway path.
 * CORS headers are added by the caller.
 */
export async function handleGateway(req, res, cors = {}) {
  const url = req.url ?? '';
  if (!url.startsWith('/gw/')) return false;
  // without a token only this machine's own pages may call: no CORS for other origins
  const headers = TOKEN ? cors : {};
  const send = (status, obj) => { res.writeHead(status, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') { send(405, { error: 'POST only', code: 'method' }); return true; }
  const denied = gate(req);
  if (denied) { send(denied.status, { error: denied.error, code: denied.code }); return true; }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) { send(413, { error: '요청이 너무 큽니다', code: 'too_large' }); return true; } chunks.push(c); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { send(400, { error: `잘못된 JSON: ${e.message}`, code: 'bad_request' }); return true; }
  const op = url.slice(4).split('?')[0];
  try {
    send(200, await handle(op, body));
  } catch (e) {
    const [status, code] = classify(e);
    if (status === 502) drop({ ...(body.conn ?? {}), ...(body.database ? { database: body.database } : {}) });
    send(status, { error: e.message || String(e), code, ...(e.statement !== undefined ? { statement: e.statement } : {}) });
  }
  return true;
}
