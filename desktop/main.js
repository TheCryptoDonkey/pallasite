/**
 * Pallasite desktop / AppImage entrypoint.
 *
 * Boots three things and wires them together exactly like the production
 * deploy, but self-contained on one machine:
 *
 *   1. A localhost static server for the built `dist/` (secure-context origin
 *      so the service worker + WebGL work). It also reverse-proxies `/api/*`
 *      to the REMOTE faucet — no money-handling service is bundled.
 *   2. The controller-ws broker on :8788, which the in-page lobby auto-targets
 *      whenever the page is served from localhost (ui.ts defaultBrokerWsUrl).
 *      This powers duel / co-op / spectate without touching production.
 *   3. A Chromium BrowserWindow pointed at the local server, kiosk by default.
 *
 * Config (all optional, via env):
 *   PALLASITE_FAUCET_URL        faucet origin            default https://pallasite.app
 *   PALLASITE_HTTP_PORT         local game port          default 8123
 *   PALLASITE_CONTROLLER_HOST   broker bind address      default 127.0.0.1
 *                               (set 0.0.0.0 to let LAN phones reach it)
 *   PALLASITE_CONTROLLER_PORT   broker port              default 8788
 *   PALLASITE_KIOSK             "0" for a normal window  default kiosk/fullscreen
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startStaticServer } from './static-server.mjs';
import { resolveVariant } from './variants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load the baked variant config (booth | public, written by prepare.mjs) and
 *  apply per-field env overrides. Env still wins so a booth operator can tweak a
 *  running kiosk. Falls back to the booth variant when no config is bundled. */
function loadConfig() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'app-config.json')
    : path.join(__dirname, 'resources', 'app-config.json');
  let baked = null;
  try { baked = JSON.parse(readFileSync(file, 'utf8')); } catch { /* fall back */ }
  const base = baked ?? resolveVariant('booth');
  const envKiosk = process.env.PALLASITE_KIOSK;
  return {
    variant: base.variant ?? 'booth',
    kiosk: envKiosk !== undefined ? envKiosk !== '0' : base.kiosk !== false,
    // Query string appended to the game URL. Booth default `p1&fullfx=1` boots
    // the join wizard at max FX; public is '' (normal title screen).
    bootQuery: process.env.PALLASITE_BOOT_QUERY ?? base.bootQuery ?? '',
    faucetOrigin: (process.env.PALLASITE_FAUCET_URL || base.faucetOrigin || 'https://pallasite.app').replace(/\/+$/, ''),
    // Production broker for the public build; null on the booth → the game's own
    // localhost detection uses the bundled local broker (linked booths).
    brokerUrl: process.env.PALLASITE_BROKER_URL ?? base.brokerUrl ?? null,
    bundleBroker: base.bundleBroker !== false,
  };
}

const CONFIG = loadConfig();
const HTTP_PORT = parseInt(process.env.PALLASITE_HTTP_PORT || '8123', 10);
const CONTROLLER_HOST = process.env.PALLASITE_CONTROLLER_HOST || '127.0.0.1';
const CONTROLLER_PORT = process.env.PALLASITE_CONTROLLER_PORT || '8788';

// ── GPU: look as great as possible (4K booth TV / desktop) ──────────────────
// Force the hardware path and higher-quality raster/upload routes so Chromium
// never silently falls back to software (unplayable at 4K).
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('force_high_performance_gpu');

// Kiosk only: a gamepad press is not a user gesture, so the browser keeps the
// AudioContext suspended on a pad-only booth — music stays silent until a tap.
// Allowing autoplay fixes that. The public (windowed) build keeps the normal
// gesture requirement so it doesn't blast audio the instant it opens.
if (CONFIG.kiosk) {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

/** Packaged: assets live under resources/. Dev (`electron .`): repo root. */
function resourcePaths() {
  if (app.isPackaged) {
    return {
      dist: path.join(process.resourcesPath, 'dist'),
      brokerDir: path.join(process.resourcesPath, 'controller-ws'),
    };
  }
  const repo = path.join(__dirname, '..');
  return {
    dist: path.join(repo, 'dist'),
    brokerDir: path.join(repo, 'controller-ws'),
  };
}

let staticServer = null;
let brokerProc = null;
let win = null;

/** Run controller-ws/server.js as a plain-Node child (Electron-as-node), so
 *  its `import 'ws'` resolves from its own node_modules and a crash there can't
 *  take the window down. */
function startBroker(brokerDir) {
  const serverJs = path.join(brokerDir, 'server.js');
  brokerProc = spawn(process.execPath, [serverJs], {
    cwd: brokerDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: CONTROLLER_PORT,
      HOST: CONTROLLER_HOST,
    },
    stdio: 'inherit',
  });
  brokerProc.on('exit', (code, signal) => {
    if (!app.isPackaged) console.error(`[pallasite] broker exited (code=${code} signal=${signal})`);
    brokerProc = null;
  });
  brokerProc.on('error', (err) => {
    console.error('[pallasite] failed to start broker:', err);
  });
}

function stopBroker() {
  if (brokerProc) {
    try { brokerProc.kill('SIGTERM'); } catch { /* already gone */ }
    brokerProc = null;
  }
}

async function createWindow() {
  const { dist, brokerDir } = resourcePaths();

  const started = await startStaticServer({
    root: dist,
    faucetOrigin: CONFIG.faucetOrigin,
    brokerUrl: CONFIG.brokerUrl,
    host: '127.0.0.1',
    port: HTTP_PORT,
  });
  staticServer = started.server;

  // Booth bundles + runs a local broker (linked booths); public uses the
  // production broker, so there's nothing to start.
  if (CONFIG.bundleBroker) startBroker(brokerDir);

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#000000',
    fullscreen: CONFIG.kiosk,
    kiosk: CONFIG.kiosk,
    autoHideMenuBar: true,
    title: 'Pallasite',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // A booth screen is often unfocused; don't throttle the render loop.
      backgroundThrottling: false,
    },
  });

  win.removeMenu();
  win.on('closed', () => { win = null; });

  // Bridge renderer console → main-process stdout (→ /tmp/pallasite.log on the
  // booth), filtered to the load-bearing diagnostics, so booth issues
  // (score submission, auth, errors) are visible over SSH without DevTools.
  win.webContents.on('console-message', (_event, _level, message) => {
    if (typeof message === 'string' && /\[solo-score\]|\[auth\]|error|fail|url_mismatch|sign/i.test(message)) {
      console.log('[renderer] ' + message);
    }
  });

  const target = started.url + (CONFIG.bootQuery ? '?' + CONFIG.bootQuery.replace(/^\?/, '') : '');
  await win.loadURL(target);
}

// Single instance — a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    // Kiosk hides all chrome, so bind explicit escape hatches for setup.
    globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
    globalShortcut.register('F11', () => {
      if (win) win.setFullScreen(!win.isFullScreen());
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopBroker();
  if (staticServer) {
    try { staticServer.close(); } catch { /* ignore */ }
    staticServer = null;
  }
});
