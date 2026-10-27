// Server for the built app (dist/): static files, a CORS proxy for BangDB
// servers without CORS headers, and the database gateway. Usage:
//   BANGDB_URL=http://192.168.0.10:18080 PORT=8080 node proxy/server.mjs
// Serves ./dist as static files, forwards /bangdb/* to BANGDB_URL (or to the
// URL in the x-bangdb-target request header) and answers /gw/* with the
// gateway for PostgreSQL, MySQL, SQL Server, SQLite, MongoDB and Redis
// (see gateway/index.mjs; set GATEWAY_TOKEN when the port is reachable by others).
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { handleGateway } from './gateway/index.mjs';

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_TARGET = (process.env.BANGDB_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const DIST = process.env.DIST || join(process.cwd(), 'dist');
const ALLOW_HEADER_TARGET = process.env.ALLOW_TARGET_HEADER !== '0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Max-Age': '86400'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (await handleGateway(req, res, cors)) return;

  if (req.url.startsWith('/bangdb/')) {
    const headerTarget = ALLOW_HEADER_TARGET ? req.headers['x-bangdb-target'] : undefined;
    const target = (typeof headerTarget === 'string' && /^https?:\/\//.test(headerTarget) ? headerTarget : DEFAULT_TARGET).replace(/\/+$/, '');
    const upstream = new URL(target + req.url.slice('/bangdb'.length));
    const headers = { ...req.headers, host: upstream.host };
    delete headers['x-bangdb-target'];
    delete headers.origin;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    try {
      const r = await fetch(upstream, { method: req.method, headers, body: body.length ? body : undefined });
      const out = Buffer.from(await r.arrayBuffer());
      const h = { ...cors, 'content-type': r.headers.get('content-type') || 'application/json' };
      res.writeHead(r.status, h);
      return res.end(out);
    } catch (e) {
      res.writeHead(502, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `proxy: ${e.message}`, target: upstream.href }));
    }
  }

  // static files with SPA fallback
  let p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, p);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404);
    return res.end('dist/ not found. Run `npm run build` first.');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`BangDB Manager serving ${DIST} on http://0.0.0.0:${PORT}`);
  console.log(`Proxying /bangdb/* -> ${DEFAULT_TARGET}`);
  console.log(`Database gateway on /gw/*${process.env.GATEWAY_TOKEN ? ' (token required)' : ' — no GATEWAY_TOKEN: only this machine\'s own pages are served; set GATEWAY_TOKEN for phones and other PCs'}`);
});
