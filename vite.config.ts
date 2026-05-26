import { defineConfig } from 'vite';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

function getBuildId(): string {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 7);
  }
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
    return sha + (dirty ? '-dev' : '');
  } catch {
    return 'dev';
  }
}

const BUILD_ID = getBuildId();
const BUILD_DATE = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
  },
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
    rollupOptions: {
      output: {
        // Split nostr-veil into its own chunk so future deploys that
        // don't touch the veil cache independently. signet-login is
        // intentionally NOT listed here — the SDK is loaded via the
        // /signet-login.iife.js script tag at runtime, our imports are
        // types-only, and Rollup would fail to resolve it as a chunk
        // entry on CI where the sibling repo isn't present. @noble/*
        // was also tree-shaken to ~50 bytes per chunk so wasn't worth
        // splitting.
        manualChunks: {
          'veil': ['nostr-veil'],
        },
      },
    },
  },
  plugins: [{
    name: 'pallasite-version-json',
    // Dev: serve /version.json from in-memory metadata so the boot-time
    // freshness check has something to compare against (always 'latest' in dev).
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ build: BUILD_ID, date: BUILD_DATE }));
      });
    },
    // Build: emit dist/version.json so prod can fetch the source-of-truth
    // build identifier without needing a server endpoint.
    closeBundle() {
      const out = resolve(__dirname, 'dist', 'version.json');
      writeFileSync(out, JSON.stringify({ build: BUILD_ID, date: BUILD_DATE }) + '\n');
    },
  }],
});
