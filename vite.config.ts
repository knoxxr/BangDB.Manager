import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// BANGDB_URL lets `npm run dev` forward /bangdb/* to a BangDB server without CORS problems.
const target = process.env.BANGDB_URL || 'http://127.0.0.1:18080';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0') },
  plugins: [
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
