import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// BANGDB_URL lets `npm run dev` forward /bangdb/* to a BangDB server without CORS problems.
const target = process.env.BANGDB_URL || 'http://127.0.0.1:18080';

/** Serve the database gateway (/gw/*) from the dev server too, so `npm run dev` needs no second process. */
const gateway = {
  name: 'bangdb-gateway',
  configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/gw/')) return next();
      // computed URL: keeps the config bundler from inlining the gateway and its drivers (they live in proxy/node_modules)
      const { handleGateway } = await import(pathToFileURL(resolve('proxy/gateway/index.mjs')).href);
      const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      await handleGateway(req, res, cors);
    });
  }
};

export default defineConfig({
  // read the file, not npm_package_version: the prebuild bump changes it after npm started
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  plugins: [
    gateway,
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'BangDB Manager',
        short_name: 'BangDB',
        description: 'BangDB 데이터베이스/테이블 관리 도구',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: { navigateFallback: '/index.html' }
    })
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/bangdb': { target, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/bangdb/, '') }
    }
  },
  test: { environment: 'node' }
} as any);
