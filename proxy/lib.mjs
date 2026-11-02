// Static file server + CORS proxy, shared by `npm run proxy` and the desktop app.
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};

/**
 * Create (but do not listen on) a server that serves `dist`, forwards
 * /bangdb/* to `defaultTarget` or to the URL in the x-bangdb-target header,
 * and hands /gw/* to `gateway` (the database gateway's handleGateway) when given.
 */
export function createProxyServer({ dist, defaultTarget = 'http://127.0.0.1:18080', allowHeaderTarget = true, gateway = null } = {}) {
  const target0 = defaultTarget.replace(/\/+$/, '');
  return http.createServer(async (req, res) => {
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
    if (req.url.startsWith('/gw/')) {
      if (gateway) {
        if (await gateway(req, res, cors)) return;
      } else {
        res.writeHead(501, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '이 서버에는 DB 게이트웨이가 없습니다 (proxy/ 에서 npm install 을 실행하세요)', code: 'no_gateway' }));
      }
    }
    if (req.url.startsWith('/bangdb/')) {
      const headerTarget = allowHeaderTarget ? req.headers['x-bangdb-target'] : undefined;
      const target = (typeof headerTarget === 'string' && /^https?:\/\//.test(headerTarget) ? headerTarget : target0).replace(/\/+$/, '');
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
        res.writeHead(r.status, { ...cors, 'content-type': r.headers.get('content-type') || 'application/json' });
        return res.end(out);
      } catch (e) {
        res.writeHead(502, { ...cors, 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `proxy: ${e.message}`, target: upstream.href }));
      }
    }
    const p = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    let file = join(dist, p);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404);
      return res.end('dist/ not found. Run `npm run build` first.');
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
}

/** Listen and resolve with the bound port. */
export function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}
