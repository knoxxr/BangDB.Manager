// Minimal mock of the BangDB REST surface used by the app (no CORS headers, like a real server).
import http from 'node:http';
const dbs = { mydb: { tables: { _sys_user_tbl: {}, orders: { k1: { _pk: 'k1', amount: 10 } } } } };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  const [, root, db, a, b, c] = req.url.split('?')[0].split('/');
  if (root !== 'db') return json(res, 404, { msg: 'not found' });
  if (req.method === 'PUT' && db && !a) { dbs[db] = dbs[db] || { tables: {} }; return json(res, 200, { msg: 'created' }); }
  if (req.method === 'DELETE' && db && !a) { delete dbs[db]; return json(res, 200, { msg: 'dropped' }); }
  const D = dbs[db]; if (!D) return json(res, 404, { msg: 'no such db' });
  if (req.method === 'GET' && a === 'list') return json(res, 200, { tables: Object.keys(D.tables), num_tables: Object.keys(D.tables).length });
  if (req.method === 'POST' && a === 'table') { D.tables[body.table_name] = {}; return json(res, 200, { msg: 'ok' }); }
  if (req.method === 'POST' && a === 'query') { const m = /from\s+(\w+)/i.exec(body.sql); const t = m && D.tables[m[1]]; return t ? json(res, 200, { rows: Object.values(t) }) : json(res, 400, { msg: 'bad table' }); }
  const T = D.tables[a]; if (!T) return json(res, 404, { msg: 'no such table' });
  if (req.method === 'DELETE' && !b) { delete D.tables[a]; return json(res, 200, { msg: 'dropped' }); }
  if (req.method === 'GET' && b === 'count') return json(res, 200, { count: Object.keys(T).length });
  if (req.method === 'POST' && b === 'doc') { T[body._pk] = body; return json(res, 200, { msg: 'inserted' }); }
  if (req.method === 'GET' && b === 'doc' && c) return T[c] ? json(res, 200, T[c]) : json(res, 404, { msg: 'no key' });
  if (req.method === 'DELETE' && b === 'doc' && c) { delete T[c]; return json(res, 200, { msg: 'deleted' }); }
  if (req.method === 'POST' && b === 'index') return json(res, 200, { msg: 'index added' });
  json(res, 404, { msg: 'unhandled ' + req.method + ' ' + req.url });
}).listen(18080, () => console.log('mock bangdb on 18080'));
