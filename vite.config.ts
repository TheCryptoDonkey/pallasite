import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    host: true,
    // In dev, /api/* is proxied to the local pallasite-faucet (Bun + Hono on
    // 127.0.0.1:8787). In prod, nginx proxies /api/* to the same target.
    // Frontend code therefore always hits same-origin `/api/...` paths.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: false,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: true,
  },
});
