// Placeholder translation. The app writes `?`, `?N` or `:name` (as BangDB
// does); each driver wants its own style: PostgreSQL $1, SQL Server @p1,
// MySQL ? (positional only), SQLite accepts the app's forms natively.

/**
 * Rewrite placeholders outside quotes and comments.
 * @param {string} sql
 * @param {unknown[] | Record<string, unknown> | undefined} args
 * @param {'pg' | 'mssql' | 'mysql'} style
 * @returns {{ sql: string, args: unknown[] }}
 */
export function bindParams(sql, args, style) {
  if (args === undefined || args === null) return { sql, args: [] };
  const named = !Array.isArray(args);
  const out = [];
  let next = 0; // for bare `?`
  const slot = new Map(); // key -> output index (pg/mssql reuse a slot for ?N / :name)
  const place = (key, value) => {
    if (style !== 'mysql' && slot.has(key)) return mark(slot.get(key));
    out.push(value);
    if (style !== 'mysql') slot.set(key, out.length);
    return mark(out.length);
  };
  const mark = (n) => (style === 'pg' ? `$${n}` : style === 'mssql' ? `@p${n}` : '?');
  let s = '';
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && style === 'mssql')) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) { if (sql[j + 1] === close && close !== ']') { j += 2; continue; } break; }
        j++;
      }
      s += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); const e = j < 0 ? sql.length : j; s += sql.slice(i, e); i = e; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); const e = j < 0 ? sql.length : j + 2; s += sql.slice(i, e); i = e; continue; }
    if (ch === '$' && style === 'pg') {
      // dollar-quoted string $$...$$ or $tag$...$tag$ ($1 placeholders have no closing $)
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) { const end = sql.indexOf(m[0], i + m[0].length); const e = end < 0 ? sql.length : end + m[0].length; s += sql.slice(i, e); i = e; continue; }
    }
    if (ch === '?' && !named) {
      const m = /^\?(\d+)/.exec(sql.slice(i));
      if (m) { const n = Number(m[1]); s += place(`#${n}`, args[n - 1]); i += m[0].length; continue; }
      s += place(`#${next + 1}`, args[next]); next++; i++; continue;
    }
    if (ch === ':' && named && sql[i - 1] !== ':' && sql[i + 1] !== ':' && /[A-Za-z_]/.test(sql[i + 1] ?? '')) {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      s += place(`:${m[1]}`, args[m[1]]); i += m[0].length; continue;
    }
    s += ch; i++;
  }
  return { sql: s, args: out };
}

/** Split a script at top-level semicolons (quotes, comments, $$ bodies honoured). */
export function splitStatements(sql) {
  const out = [];
  let cur = '';
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; } j++; }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { const end = sql.indexOf(m[0], i + m[0].length); const e = end < 0 ? sql.length : end + m[0].length; cur += sql.slice(i, e); i = e; continue; }
    }
    if (ch === '-' && sql[i + 1] === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j + 1; cur += '\n'; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const j = sql.indexOf('*/', i + 2); i = j < 0 ? sql.length : j + 2; cur += ' '; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Does a single statement return rows (for mode "auto")? */
export function returnsRows(sql) {
  const w = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').slice(0, 12).toUpperCase();
  return /^(SELECT|WITH|EXPLAIN|VALUES|SHOW|DESC|DESCRIBE|PRAGMA|TABLE)\b/.test(w);
}

/** JSON-safe value for a response: Buffers as {"blob"}, Dates as ISO text, big integers as text. */
export function encodeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().replace('T', ' ').replace(/\.000Z$/, 'Z');
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { blob: Buffer.from(v).toString('base64') };
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

/** Request argument → driver value: {"blob": base64} → Buffer. */
export function decodeArg(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.blob === 'string' && Object.keys(v).length === 1) return Buffer.from(v.blob, 'base64');
  return v;
}
