/**
 * Pallasite — entry point.
 *
 * Sets up the canvas, runs the game loop, wires keyboard input, restores any
 * stored Signet session, and routes between title/playing/paused/game-over.
 */

import { makeInitialState, startGame, updateGame, pauseGame, resumeGame, tryHyperspace, tryActivateShield, cheatJumpToWave, skipDeathReplay, skipWaveStart } from './game.js';
import { lockInDifficulty, getStoredDifficulty } from './difficulty.js';
import { setDailySeed, todayUTC, getStoredDailyPref, getActiveSeed } from './seed.js';
import { render, preloadBackground } from './render.js';
import { bindActions, renderTitle, renderPause, renderGameOver, renderCompletion, renderToast, clearOverlay } from './ui.js';
import { tryRestore } from './auth.js';
import * as audio from './audio.js';
import { musicSetTrackForState } from './music.js';
import { setupTouchControls } from './touch.js';
import { getDisplayMode, setDisplayMode } from './display.js';
import type { GameState } from './types.js';
import { DOWN_DOUBLE_TAP_WINDOW_MS } from './types.js';

const PAUSE_DUCK = 0.3;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const state: GameState = makeInitialState();

/** Timestamp of the most recent ArrowDown keydown — used for double-tap detection. */
let lastDownArrowAt = 0;

// ── Wave-jump cheat input mode ───────────────────────────────────────────────

let cheatInputOpen = false;
let cheatInputBuffer = '';
let cheatInputEl: HTMLDivElement | null = null;
let cheatInputIdleTimer: number | null = null;

function openCheatInput(): void {
  if (cheatInputOpen) return;
  cheatInputOpen = true;
  cheatInputBuffer = '';
  cheatInputEl = document.createElement('div');
  cheatInputEl.style.cssText = [
    'position:fixed', 'top:80px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:100', 'background:rgba(0,0,0,0.92)',
    'border:2px solid #ffd84a', 'border-radius:10px',
    'padding:14px 18px',
    "font-family:'VT323',ui-monospace,monospace", 'font-size:1.4rem',
    'color:#ffd84a', 'letter-spacing:0.2em',
    'text-shadow:0 0 8px rgba(255,216,74,0.6)',
    'pointer-events:auto',
    'user-select:none', '-webkit-user-select:none',
    'min-width:220px', 'text-align:center',
  ].join(';');
  cheatInputEl.innerHTML = `
    <div>JUMP TO WAVE: <span id="pal-cheat-buf" style="color:#fff;">__</span></div>
    <div id="pal-cheat-pad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0 6px;">
      <button data-d="1">1</button><button data-d="2">2</button><button data-d="3">3</button>
      <button data-d="4">4</button><button data-d="5">5</button><button data-d="6">6</button>
      <button data-d="7">7</button><button data-d="8">8</button><button data-d="9">9</button>
      <button data-act="del">DEL</button><button data-d="0">0</button><button data-act="ok">▶</button>
    </div>
    <div style="font-size:0.7rem;color:rgba(180,140,255,0.7);letter-spacing:0.08em;">Enter / + warps · Esc cancels</div>
  `;
  const pad = cheatInputEl.querySelector('#pal-cheat-pad') as HTMLDivElement;
  for (const btn of Array.from(pad.querySelectorAll('button'))) {
    const b = btn as HTMLButtonElement;
    b.style.cssText = [
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:1.2rem', 'padding:12px 0',
      'background:rgba(255,216,74,0.08)',
      'border:1px solid rgba(255,216,74,0.5)',
      'color:#ffd84a', 'border-radius:6px',
      'cursor:pointer', 'touch-action:manipulation',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      const d = b.dataset.d;
      const a = b.dataset.act;
      if (d) {
        if (cheatInputBuffer.length < 2) {
          cheatInputBuffer += d;
          refreshCheatBuffer();
          resetCheatIdleTimer();
        }
      } else if (a === 'del') {
        cheatInputBuffer = cheatInputBuffer.slice(0, -1);
        refreshCheatBuffer();
        resetCheatIdleTimer();
      } else if (a === 'ok') {
        closeCheatInput(true);
      }
    });
  }
  document.body.appendChild(cheatInputEl);
  resetCheatIdleTimer();
}

/** Long-press the WAVE indicator on the HUD (~1.5s) to open the cheat input
 *  on touch devices where there's no `+` key. Hot zone is the top-middle of
 *  the canvas where the WAVE label is drawn (around x=0.62*WORLD_W, y<80). */
function setupWaveLongPress(): void {
  const HOLD_MS = 1500;
  const MOVE_TOL_PX = 14;
  let timer: number | null = null;
  let sx = 0, sy = 0;

  function inWaveZone(clientX: number, clientY: number): boolean {
    const rect = canvas.getBoundingClientRect();
    const xPct = (clientX - rect.left) / rect.width;
    const yPct = (clientY - rect.top) / rect.height;
    return xPct >= 0.50 && xPct <= 0.80 && yPct >= 0 && yPct <= 0.12;
  }
  function clear(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  canvas.addEventListener('pointerdown', e => {
    if (state.phase !== 'playing' && state.phase !== 'wavestart') return;
    if (cheatInputOpen) return;
    if (!inWaveZone(e.clientX, e.clientY)) return;
    sx = e.clientX; sy = e.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = null;
      if (getActiveSeed() !== null) {
        state.toast = 'CHEATS LOCKED · DAILY RUN';
        state.toastUntil = performance.now() + 1800;
        return;
      }
      openCheatInput();
    }, HOLD_MS);
  });
  canvas.addEventListener('pointermove', e => {
    if (timer === null) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_TOL_PX) clear();
  });
  canvas.addEventListener('pointerup',     clear);
  canvas.addEventListener('pointercancel', clear);
  canvas.addEventListener('pointerleave',  clear);
}

function refreshCheatBuffer(): void {
  if (!cheatInputEl) return;
  const span = cheatInputEl.querySelector('#pal-cheat-buf');
  if (span) span.textContent = cheatInputBuffer.padEnd(2, '_');
}

function resetCheatIdleTimer(): void {
  if (cheatInputIdleTimer !== null) clearTimeout(cheatInputIdleTimer);
  cheatInputIdleTimer = window.setTimeout(() => closeCheatInput(false), 3500);
}

function closeCheatInput(commit: boolean): void {
  if (!cheatInputOpen) return;
  cheatInputOpen = false;
  if (cheatInputIdleTimer !== null) { clearTimeout(cheatInputIdleTimer); cheatInputIdleTimer = null; }
  if (cheatInputEl) { cheatInputEl.remove(); cheatInputEl = null; }
  const buf = cheatInputBuffer;
  cheatInputBuffer = '';
  if (commit) {
    if (buf.length > 0) {
      const target = parseInt(buf, 10);
      if (!isNaN(target)) cheatJumpToWave(state, target);
    } else {
      cheatJumpToWave(state, state.wave + 1);  // empty buffer + Enter = next wave
    }
  }
}

function digitFromCode(code: string): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  return m ? m[1] : null;
}

bindActions({
  onStart: () => {
    // Apply current daily-mode preference. Without this, the activeSeed from
    // a prior daily run would persist through a subsequent free-mode start
    // (the IGNITE button bypasses the keyboard Enter path that did the reset).
    setDailySeed(getStoredDailyPref() ? todayUTC() : null);
    startGame(state);
    state.phase = 'wavestart';
    clearOverlay();
    audio.setMusicDuck(1);
    musicSetTrackForState(state);
  },
  onResume: () => {
    resumeGame(state);
    clearOverlay();
    audio.setMusicDuck(1);
    musicSetTrackForState(state);
  },
});

// ── Input ─────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', e => {
  // Any key during the death replay short-circuits to the gameover screen
  if (state.phase === 'deathreplay') {
    skipDeathReplay(state);
    e.preventDefault();
    return;
  }
  // Any key during the wave-start cinematic skips to playing (after the
  // skip-allowed window — guard inside skipWaveStart). Lets repeat players
  // skim past the lore without sitting through the dwell every time.
  if (state.phase === 'wavestart') {
    skipWaveStart(state);
    // Don't swallow — let the keypress also register for movement
  }
  // Wave-jump cheat input mode swallows keys while open
  if (cheatInputOpen) {
    if (e.code === 'Enter') { closeCheatInput(true); e.preventDefault(); return; }
    if (e.code === 'Escape') { closeCheatInput(false); e.preventDefault(); return; }
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { closeCheatInput(true); e.preventDefault(); return; }
    const digit = digitFromCode(e.code);
    if (digit !== null) {
      if (cheatInputBuffer.length < 2) {
        cheatInputBuffer += digit;
        refreshCheatBuffer();
        resetCheatIdleTimer();
      }
      e.preventDefault();
      return;
    }
    if (e.code === 'Backspace') {
      cheatInputBuffer = cheatInputBuffer.slice(0, -1);
      refreshCheatBuffer();
      resetCheatIdleTimer();
      e.preventDefault();
      return;
    }
    // any other key cancels
    closeCheatInput(false);
    e.preventDefault();
    return;
  }

  state.keys[e.code] = true;
  // Prevent arrows from scrolling
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  // Hyperspace via Shift / H — instant
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyH') && state.phase === 'playing') {
    tryHyperspace(state, performance.now());
  }
  // Down-arrow: shield on first press, hyperspace on double-tap
  if (e.code === 'ArrowDown' && state.phase === 'playing' && !e.repeat) {
    const now = performance.now();
    const sinceLast = now - lastDownArrowAt;
    if (lastDownArrowAt > 0 && sinceLast < DOWN_DOUBLE_TAP_WINDOW_MS) {
      tryHyperspace(state, now);
      lastDownArrowAt = 0;  // consume — prevent triple-tap chain
    } else {
      tryActivateShield(state, now);
      lastDownArrowAt = now;
    }
  }
  // Wave cheat: + opens type-to-jump input, - single-steps back. Disabled during daily runs.
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && (state.phase === 'playing' || state.phase === 'wavestart' || state.phase === 'warp')) {
    if (getActiveSeed() !== null) {
      state.toast = 'CHEATS LOCKED · DAILY RUN';
      state.toastUntil = performance.now() + 1800;
    } else {
      openCheatInput();
    }
    e.preventDefault();
  }
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && (state.phase === 'playing' || state.phase === 'wavestart')) {
    if (getActiveSeed() !== null) {
      state.toast = 'CHEATS LOCKED · DAILY RUN';
      state.toastUntil = performance.now() + 1800;
    } else {
      cheatJumpToWave(state, Math.max(1, state.wave - 1));
    }
  }
  // Pause toggle
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state.phase === 'playing') {
      pauseGame(state);
      renderPause(state);
      audio.setMusicDuck(PAUSE_DUCK);
    } else if (state.phase === 'paused') {
      resumeGame(state);
      clearOverlay();
      audio.setMusicDuck(1);
    }
  }
  // Mute toggle
  if (e.code === 'KeyM') {
    audio.setMuted(!audio.isMuted());
    if (audio.isMuted()) audio.thrustOff();
  }
  // Enter to start from title
  if (e.code === 'Enter' && state.phase === 'title') {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    setDailySeed(getStoredDailyPref() ? todayUTC() : null);
    startGame(state);
    state.phase = 'wavestart';
    clearOverlay();
  }
  // Enter to play again from gameover
  if (e.code === 'Enter' && state.phase === 'gameover') {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    setDailySeed(getStoredDailyPref() ? todayUTC() : null);
    startGame(state);
    state.phase = 'wavestart';
    clearOverlay();
  }
});

window.addEventListener('keyup', e => {
  state.keys[e.code] = false;
  if (e.code === 'Space') {
    // Allow rapid re-fire on tap by clearing the held state
    state.keys.Space = false;
  }
});

// Tap anywhere during wave-start to skip the lore dwell on touch devices.
// Buttons bubble up too — skipWaveStart guards on phase + min elapsed.
window.addEventListener('pointerdown', () => {
  if (state.phase === 'wavestart') skipWaveStart(state);
}, { capture: true });

// Lose focus → release keys & pause
window.addEventListener('blur', () => {
  state.keys = {};
  audio.thrustOff();
  if (state.phase === 'playing') {
    pauseGame(state);
    renderPause(state);
    audio.setMusicDuck(PAUSE_DUCK);
  }
});

// ── Game loop ─────────────────────────────────────────────────────────────────

let lastFrame = performance.now();
let lastPhase = state.phase;

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);  // cap to 50ms (20fps minimum step)
  lastFrame = now;

  updateGame(state, dt, now);
  render(canvas, state, now);

  // Phase transitions render UI overlays
  if (state.phase !== lastPhase) {
    if (state.phase === 'gameover') {
      renderGameOver(state);
    } else if (state.phase === 'title') {
      renderTitle(state);
    } else if (state.phase === 'completed') {
      renderCompletion(state);
    }
    // Mirror the phase to the body so CSS can gate touch controls visibility —
    // controls appear during gameplay phases only, hidden on title/menu screens.
    document.body.dataset.phase = state.phase;
    lastPhase = state.phase;
  }

  // Music keeps in step with phase + wave (idempotent — diffs internally)
  musicSetTrackForState(state);

  // Toast updates
  if (state.toast) {
    renderToast(state);
    state.toast = null;  // consume
  }

  requestAnimationFrame(loop);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Lock in stored difficulty as the default for any auto-launched run
  lockInDifficulty(getStoredDifficulty());
  // Mirror the stored display mode to a body data-attr so any CSS that wants
  // to react (currently nothing, but cheap to seed for future use) can match it.
  setDisplayMode(getDisplayMode());

  // Resize canvas to fit viewport in BOTH dimensions while preserving 4:3
  // aspect — internal pixel resolution stays 960×720 (× dpr) so the game
  // logic and HUD coords don't need to know about display size; the browser
  // scales the bitmap. Centring is handled by the CSS absolute-translate.
  function fit(): void {
    const mode = getDisplayMode();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const aspect = 4 / 3;
    let w = Math.min(vw, vh * aspect);
    // Retro mode caps at native source size so upscaling stays integer-ish;
    // modern lets the canvas fill whatever 4:3 box fits in the viewport.
    if (mode === 'retro' && w > 960) w = 960;
    const h = w / aspect;
    // Supersample only when actually upscaling — on mobile the display is
    // typically smaller than the 960 source, so extra backing is pure waste
    // (and the smooth-filter path would blur the HUD text). Cap at 2× to
    // avoid runaway backing on giant monitors.
    const supersample = mode === 'modern' && w > 960
      ? Math.min(2, w / 960)
      : 1;
    canvas.width = Math.round(960 * dpr * supersample);
    canvas.height = Math.round(720 * dpr * supersample);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    // Pixelated keeps HUD/asteroid edges crisp on downscales too — only
    // switch to smooth interpolation when we've actually supersampled.
    canvas.style.imageRendering = supersample > 1 ? 'auto' : 'pixelated';
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr * supersample, 0, 0, dpr * supersample, 0, 0);
  }
  // Expose to the settings panel — flipping the mode needs to re-fit.
  (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit = fit;
  fit();
  window.addEventListener('resize', fit);
  // iOS fires `orientationchange` slightly differently; resize covers both modern
  // browsers but the explicit listener catches stragglers.
  window.addEventListener('orientationchange', fit);

  // Try restoring a session
  state.session = await tryRestore();
  // Kick off profile fetch in the background — UI updates when it lands
  if (state.session) {
    void import('./profile.js').then(({ fetchProfile, getCachedProfile }) => {
      const cached = getCachedProfile(state.session!.pubkey);
      if (cached) state.profile = cached;
      void fetchProfile(state.session!.pubkey).then(p => { if (p) state.profile = p; });
    });
  }

  // Preload first two wave backgrounds so the start of the game is seamless
  preloadBackground(1);
  preloadBackground(2);

  // Touch controls — buttons reveal themselves on first real touch
  setupTouchControls(state, tryHyperspace, tryActivateShield);

  // Long-press the WAVE label on the HUD = open cheat input (mobile equivalent
  // of the `+` keyboard shortcut). Daily-run guard inside the handler.
  setupWaveLongPress();

  // Seed the body data-phase so the CSS gates evaluate correctly on first paint
  // (the loop only writes this on phase change after the first frame).
  document.body.dataset.phase = state.phase;

  renderTitle(state);

  // Once the user makes any audio-unlocking gesture (start, sign-in, settings,
  // even pressing M), the title music will start playing on its own via the
  // game-loop call to musicSetTrackForState. No need to play it before unlock —
  // browsers block it anyway.

  requestAnimationFrame(loop);
}

void boot();
