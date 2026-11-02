// Server for the built app (dist/): static files, a CORS proxy for BangDB
// servers without CORS headers, and the database gateway. Usage:
//   BANGDB_URL=http://192.168.0.10:18080 PORT=8080 node proxy/server.mjs
// Serves ./dist as static files, forwards /bangdb/* to BANGDB_URL (or to the
// URL in the x-bangdb-target request header) and answers /gw/* with the
// gateway for PostgreSQL, MySQL, SQL Server, SQLite, MongoDB and Redis
// (see gateway/index.mjs; set GATEWAY_TOKEN when the port is reachable by others).
// The same server code runs inside the desktop app (electron/main.mjs).
import { join } from 'node:path';
import { createProxyServer, listen } from './lib.mjs';
import { handleGateway } from './gateway/index.mjs';

const PORT = Number(process.env.PORT || 8080);
const DEFAULT_TARGET = (process.env.BANGDB_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const DIST = process.env.DIST || join(process.cwd(), 'dist');

const server = createProxyServer({
  dist: DIST, defaultTarget: DEFAULT_TARGET, allowHeaderTarget: process.env.ALLOW_TARGET_HEADER !== '0', gateway: handleGateway
});
listen(server, PORT).then((port) => {
  console.log(`BangDB Manager serving ${DIST} on http://0.0.0.0:${port}`);
  console.log(`Proxying /bangdb/* -> ${DEFAULT_TARGET}`);
  console.log(`Database gateway on /gw/*${process.env.GATEWAY_TOKEN ? ' (token required)' : " — no GATEWAY_TOKEN: only this machine's own pages are served; set GATEWAY_TOKEN for phones and other PCs"}`);
});
