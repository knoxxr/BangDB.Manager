// Redis adapter: key browsing (SCAN), typed reads, raw commands and
// MULTI transactions. Edits are plain Redis commands built by the app.
const PREVIEW = 1000;

export async function redis(conn) {
  const { createClient } = await import('redis');
  const client = conn.uri
    ? createClient({ url: conn.uri })
    : createClient({
      socket: { host: conn.host || '127.0.0.1', port: Number(conn.port) || 6379, tls: !!conn.ssl, rejectUnauthorized: conn.ssl ? !conn.sslInsecure : undefined, connectTimeout: 8000, reconnectStrategy: false },
      username: conn.user || undefined, password: conn.password || undefined, database: Number(conn.database) || 0
    });
  client.on('error', () => {});
  await client.connect();
  const cmd = (args) => client.sendCommand(args.map(String));

  const ops = {
    async scan(b) {
      const args = ['SCAN', String(b.cursor ?? '0'), 'MATCH', b.pattern || '*', 'COUNT', String(b.count || 200)];
      if (b.type) args.push('TYPE', b.type);
      const [cursor, keys] = await cmd(args);
      const m = client.multi();
      keys.forEach((k) => { m.addCommand(['TYPE', k]); m.addCommand(['PTTL', k]); });
      const meta = keys.length ? await m.execAsPipeline() : [];
      return { cursor, keys: keys.map((k, i) => ({ key: k, type: meta[i * 2], ttl: Number(meta[i * 2 + 1]) })) };
    },
    async get(b) {
      const k = b.key;
      const type = await cmd(['TYPE', k]);
      const ttl = Number(await cmd(['PTTL', k]));
      const n = Math.min(Number(b.limit) || PREVIEW, 10000);
      let value, length;
      switch (type) {
        case 'string': value = await cmd(['GET', k]); length = value?.length ?? 0; break;
        case 'hash': { length = Number(await cmd(['HLEN', k])); const [, kv] = await cmd(['HSCAN', k, '0', 'COUNT', String(n)]); value = pairs(kv).map(([field, v]) => ({ field, value: v })); break; }
        case 'list': length = Number(await cmd(['LLEN', k])); value = await cmd(['LRANGE', k, '0', String(n - 1)]); break;
        case 'set': { length = Number(await cmd(['SCARD', k])); const [, m] = await cmd(['SSCAN', k, '0', 'COUNT', String(n)]); value = m; break; }
        case 'zset': length = Number(await cmd(['ZCARD', k])); value = pairs(await cmd(['ZRANGE', k, '0', String(n - 1), 'WITHSCORES'])).map(([member, score]) => ({ member, score: Number(score) })); break;
        case 'stream': length = Number(await cmd(['XLEN', k])); value = (await cmd(['XREVRANGE', k, '+', '-', 'COUNT', String(n)])).map(([id, kv]) => ({ id, fields: Object.fromEntries(pairs(kv)) })); break;
        case 'none': throw Object.assign(new Error(`키가 없습니다: ${k}`), { status: 404 });
        default: value = null;
      }
      return { key: k, type, ttl, length, value };
    },
    async command(b) {
      if (!Array.isArray(b.args) || !b.args.length) throw Object.assign(new Error('args 배열이 필요합니다'), { status: 400 });
      return { result: await cmd(b.args) };
    },
    async multi(b) {
      const m = client.multi();
      for (const a of b.commands ?? []) m.addCommand(a.map(String));
      return { results: await m.exec() };
    },
    async databases() {
      const ks = parseInfo(await cmd(['INFO', 'keyspace'])).keyspace ?? {};
      const n = Number((await cmd(['CONFIG', 'GET', 'databases']).catch(() => ['databases', '16']))[1]) || 16;
      return Array.from({ length: n }, (_, i) => ({ name: String(i), keys: Number(/keys=(\d+)/.exec(ks[`db${i}`] ?? '')?.[1] ?? 0) }));
    },
    async stats() {
      const info = parseInfo(await cmd(['INFO']));
      return { ...info, dbsize: Number(await cmd(['DBSIZE'])) };
    }
  };
  return { dialect: 'redis', ops, close: () => client.quit().catch(() => client.disconnect()) };
}

const pairs = (a) => { const out = []; for (let i = 0; i + 1 < (a?.length ?? 0); i += 2) out.push([a[i], a[i + 1]]); return out; };

/** INFO text → { section: { key: value } }. */
export function parseInfo(text) {
  const out = {};
  let sec = 'info';
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('# ')) { sec = line.slice(2).trim().toLowerCase(); out[sec] = {}; continue; }
    const i = line.indexOf(':');
    if (i > 0) (out[sec] ??= {})[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
