/**
 * Pallasite — entry point.
 *
 * Sets up the canvas, runs the game loop, wires keyboard input, restores any
 * stored Signet session, and routes between title/playing/paused/game-over.
 */

import { makeInitialState, startGame, updateGame, pauseGame, resumeGame, tryHyperspace, tryActivateShield, cheatJumpToWave, skipDeathReplay, skipWaveStart, skipWarp } from './game.js';
import { lockInDifficulty, getStoredDifficulty } from './difficulty.js';
import { setDailySeed, todayUTC, getStoredDailyPref, getActiveSeed } from './seed.js';
import { render, preloadBackground, setRenderMode } from './render.js';
import { bindActions, renderTitle, renderPause, renderGameOver, renderCompletion, renderToast, clearOverlay, showUpdateBanner, gateBehindOnboarding } from './ui.js';
import { handleAuthCallback, tryRestore, sweepSignetArtefacts } from './auth.js';
import * as audio from './audio.js';
import { musicSetTrackForState, preloadAllTracks, musicSetPaused } from './music.js';
import { stemsTickForState } from './music-stems.js';
import { setupTouchControls } from './touch.js';
import { getDisplayMode, setDisplayMode } from './display.js';
import { checkForUpdate } from './version.js';
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
    // Hot zone is the top strip of the canvas (where the WAVE label is drawn,
    // anywhere across because cover-scale in portrait shifts the world right
    // off-centre). Long-press requirement guards against accidental taps.
    const rect = canvas.getBoundingClientRect();
    const yPct = (clientY - rect.top) / rect.height;
    return clientX >= rect.left && clientX <= rect.right
        && yPct >= 0 && yPct <= 0.10;
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
  // Any deliberate key during the death replay short-circuits to gameover.
  // Two filters protect against accidental skips: OS auto-repeats from a
  // movement key the player was still holding when they died (these fire
  // while phase=='deathreplay' even though the player hasn't pressed
  // anything new), and a 250ms grace window so a key pressed in the same
  // tick as the lethal collision doesn't skip the replay before anyone
  // sees it.
  if (state.phase === 'deathreplay') {
    if (e.repeat) return;
    if (performance.now() - state.phaseStart < 250) return;
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
  // Same for the warp cinematic — long enough to fit the music, but a key
  // press past the skip window jumps straight into the next wave.
  if (state.phase === 'warp') {
    skipWarp(state);
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
  // Enter to start from title. Two gates: the data-onboarding marker stops
  // Enter from advancing past the cinematic itself, and gateBehindOnboarding
  // diverts first-time players into the cinematic instead of the game so they
  // can't skip the intro by Entering before clicking IGNITE.
  if (e.code === 'Enter' && state.phase === 'title' && !document.querySelector('[data-onboarding="open"]')) {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    gateBehindOnboarding(() => {
      setDailySeed(getStoredDailyPref() ? todayUTC() : null);
      startGame(state);
      state.phase = 'wavestart';
      clearOverlay();
    });
  }
  // Enter to play again from gameover. Gated on the arcade-initials widget
  // not being open — when the player is locking in initials, Enter is a
  // no-op (see renderArcadeInitials in ui.ts). Without this gate, Enter on
  // the name-entry screen restarts the game and the player never sees the
  // submit / countdown.
  if (e.code === 'Enter' && state.phase === 'gameover' && !document.querySelector('[data-arcade-initials="open"]')) {
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

// Tap anywhere during wave-start or warp to skip the long cinematic on touch
// devices. Buttons bubble up too — skip helpers guard on phase + min elapsed.
window.addEventListener('pointerdown', () => {
  if (state.phase === 'wavestart') skipWaveStart(state);
  else if (state.phase === 'warp') skipWarp(state);
}, { capture: true });

// One-shot global audio unlock on any first user interaction. Without it, a
// fresh title screen sits in autoplay-blocked silence until the player taps
// IGNITE — title music never gets going, and the secret music player can't
// unlock from its own row taps reliably on iOS. A pointerdown anywhere on
// the page (logo long-press, IGNITE, settings tap, even a stray tap) covers
// every entry path.
const firstUnlock = (): void => {
  void audio.unlockAudio();
  window.removeEventListener('pointerdown', firstUnlock);
  window.removeEventListener('keydown', firstUnlock);
};
window.addEventListener('pointerdown', firstUnlock);
window.addEventListener('keydown', firstUnlock);

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

// PWA backgrounded → fully silence playback. iOS Safari and PWA shells
// keep HTMLAudio elements decoding when the page is hidden, so the music
// keeps playing after "closing" the app from the user's perspective.
// Suspending the AudioContext silences any scheduled SFX/oscillators, and
// silenceMusicEls stops + mutes the underlying audio elements. We listen
// on three events because iOS doesn't fire visibilitychange consistently
// when a standalone PWA is swiped away — pagehide is the reliable signal,
// and freeze (Page Lifecycle API) covers Chrome's discard path.
function silenceAll(): void {
  audio.thrustOff();
  audio.ufoSirenStop();
  audio.stopHeartbeat();
  audio.stopAmbient();
  musicSetPaused(true);
  audio.suspendPlayback();
}
function resumeAll(): void {
  audio.resumePlayback();
  musicSetPaused(false);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeAll();
  else silenceAll();
});
window.addEventListener('pagehide', silenceAll);
window.addEventListener('pageshow', resumeAll);
// Page Lifecycle API — Chromium discards a backgrounded tab. Last chance
// to silence before the page is frozen and listeners stop firing.
document.addEventListener('freeze', silenceAll);
document.addEventListener('resume', resumeAll);

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
  // Adaptive stems on top of the recorded track: combo bass while a chain
  // is live, boss-lead motif on wave 25 until the boss is downed.
  stemsTickForState(state, performance.now());

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
  // Read env(safe-area-inset-*) into pixel numbers via a sentinel div. iPhone
  // notch / Dynamic Island / rounded corners surface here when the canvas runs
  // edge-to-edge under viewport-fit=cover. Non-zero values get applied by the
  // HUD so SCORE/WAVE/LIVES sit clear of cutouts.
  function readSafeInsets(): { top: number; right: number; bottom: number; left: number } {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding:'
      + 'env(safe-area-inset-top) env(safe-area-inset-right) '
      + 'env(safe-area-inset-bottom) env(safe-area-inset-left);'
      + 'visibility:hidden;pointer-events:none;';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const insets = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    document.body.removeChild(el);
    return insets;
  }

  function fit(): void {
    const mode = getDisplayMode();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const insets = readSafeInsets();

    if (mode === 'modern') {
      // Modern fill: canvas spans the entire viewport. World stays 960×720 so
      // gameplay constants are unchanged; only the visual presentation differs.
      // - Landscape (incl. 4:3): contain-scale — full world visible, the wave
      //   bg drawn cover-style fills any leftover gutters.
      // - Portrait: cover-scale — game world fills the screen vertically and
      //   crops on the horizontal axis. The world wraps, so cropped asteroids
      //   are still in play, just less visible until they cross the visible band.
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = vw + 'px';
      canvas.style.height = vh + 'px';
      canvas.style.imageRendering = 'auto';
      const ctx = canvas.getContext('2d')!;
      const isPortrait = vh > vw;
      // Portrait zooms OUT (cover * 0.65) for breathing room on phones.
      // Landscape stays at plain contain — zooming in makes cropY true with
      // visW > WORLD_W, which triggers the horizontal gutter ghost and the
      // player sees their ship doubled near the world's left/right edges.
      const PORTRAIT_ZOOM = 0.55;
      const scale = isPortrait
        ? Math.max(vw / 960, vh / 720) * PORTRAIT_ZOOM
        : Math.min(vw / 960, vh / 720);
      const tx = (vw - 960 * scale) / 2;
      const ty = (vh - 720 * scale) / 2;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
      setRenderMode({ kind: 'modern', vw, vh, dpr, scale, tx, ty, insets });
      return;
    }

    // Retro: 4:3 inscribed in viewport, capped at 960 native source.
    const aspect = 4 / 3;
    let w = Math.min(vw, vh * aspect);
    if (w > 960) w = 960;
    const h = w / aspect;
    canvas.width = Math.round(960 * dpr);
    canvas.height = Math.round(720 * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.imageRendering = 'pixelated';
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    setRenderMode({ kind: 'retro', vw: w, vh: h, dpr, scale: 1, tx: 0, ty: 0, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  }
  // Expose to the settings panel — flipping the mode needs to re-fit.
  (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit = fit;
  fit();
  window.addEventListener('resize', fit);
  // iOS fires `orientationchange` slightly differently; resize covers both modern
  // browsers but the explicit listener catches stragglers.
  window.addEventListener('orientationchange', fit);

  // First, consume an in-flight signet redirect callback if one's on the URL —
  // returning from signet with auth params persists a session and strips them
  // from the URL. Then fall back to restoring a stored session for normal loads.
  state.session = (await handleAuthCallback()) ?? (await tryRestore());
  // Kick off profile fetch in the background — UI updates when it lands
  if (state.session) {
    void import('./profile.js').then(({ fetchProfile, getCachedProfile }) => {
      const cached = getCachedProfile(state.session!.pubkey);
      if (cached) state.profile = cached;
      void fetchProfile(state.session!.pubkey).then(p => { if (p) state.profile = p; });
    });
  }
  // NIP-07 extensions sometimes inject `window.nostr` after page load —
  // tryRestore at boot can land before the extension is ready, leaving us
  // with an auth-only stub session. Watch for the signer to come online and
  // upgrade transparently.
  watchForSignerUpgrade();

  // Preload first two wave backgrounds so the start of the game is seamless
  preloadBackground(1);
  preloadBackground(2);

  // Prime music tracks so warp-transition (1.3s window) doesn't miss its
  // first cue waiting on a cold fetch.
  preloadAllTracks();

  // Touch controls — buttons reveal themselves on first real touch
  setupTouchControls(state, tryHyperspace, tryActivateShield);

  // Long-press the WAVE label on the HUD = open cheat input (mobile equivalent
  // of the `+` keyboard shortcut). Daily-run guard inside the handler.
  setupWaveLongPress();

  // Seed the body data-phase so the CSS gates evaluate correctly on first paint
  // (the loop only writes this on phase change after the first frame).
  document.body.dataset.phase = state.phase;

  renderTitle(state);

  // bfcache restore: a player who taps SIGN IN, opens the Signet redirect,
  // then hits browser-back without completing returns to a frozen page that
  // still has the SDK dialog in the DOM. The dialog is opaque to clicks even
  // when not visually obvious, so the title screen below is unresponsive.
  // Two-sided defence:
  //   - pagehide (persisted=true): the page is about to enter bfcache.
  //     Strip the dialog now so the cached page state is clean.
  //   - pageshow (persisted=true): the page is being restored. Strip again
  //     in case pagehide didn't fire (some browsers skip it on redirect)
  //     and re-render the title to reset the sign-in panel's `signing`
  //     flag to a fresh closure that can be tapped again.
  window.addEventListener('pagehide', e => {
    if (!e.persisted) return;
    sweepSignetArtefacts();
  });
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    sweepSignetArtefacts();
    if (state.phase === 'title') renderTitle(state);
  });

  // Once the user makes any audio-unlocking gesture (start, sign-in, settings,
  // even pressing M), the title music will start playing on its own via the
  // game-loop call to musicSetTrackForState. No need to play it before unlock —
  // browsers block it anyway.

  setupServiceWorker();

  // Independent of the SW path so non-SW browsers also get an authoritative
  // chip on the title screen.
  void checkForUpdate();

  requestAnimationFrame(loop);
}

/**
 * Watch for a NIP-07 extension to inject `window.nostr` after boot and
 * silently upgrade an auth-only session into a fully-signing one. Some
 * extensions (Alby, nos2x) don't always have window.nostr ready by the
 * time tryRestore runs, so the initial restoreSession lands us with a
 * stub signer. Polling here is bounded (POLL_DURATION_MS) so we don't
 * loop forever for users who never had nip07 in the first place.
 *
 * Only nip07-method sessions are eligible — bunker/redirect sessions
 * have their own signing pathways and shouldn't be silently switched.
 */
function watchForSignerUpgrade(): void {
  const POLL_MS = 500;
  const POLL_DURATION_MS = 30_000;
  const startedAt = Date.now();
  let upgrading = false;

  const tick = async (): Promise<void> => {
    if (Date.now() - startedAt > POLL_DURATION_MS) return;
    const sess = state.session;
    if (!sess) {
      // Nothing to upgrade — but the user may sign in manually later, so
      // step out cleanly. Manual sign-in is its own path.
      window.setTimeout(() => void tick(), POLL_MS * 4);
      return;
    }
    if (sess.signer.capabilities.canSignEvents) return;
    if (sess.method !== 'nip07') return;
    if (!(window as { nostr?: unknown }).nostr) {
      window.setTimeout(() => void tick(), POLL_MS);
      return;
    }
    if (upgrading) {
      window.setTimeout(() => void tick(), POLL_MS);
      return;
    }
    upgrading = true;
    try {
      const upgraded = await tryRestore();
      if (upgraded?.signer.capabilities.canSignEvents
          && upgraded.pubkey === sess.pubkey) {
        state.session = upgraded;
        // Profile was tied to the stub session; refetch under the new
        // signer just in case kind 0 caching differs (cheap, returns
        // immediately if already cached).
        void import('./profile.js').then(({ fetchProfile, getCachedProfile }) => {
          if (!state.session) return;
          const cached = getCachedProfile(state.session.pubkey);
          if (cached) state.profile = cached;
          void fetchProfile(state.session.pubkey).then(p => {
            if (p && state.session?.pubkey === p.pubkey) state.profile = p;
          });
        });
        if (state.phase === 'title') renderTitle(state);
        return;
      }
    } catch { /* ignore — try again on the next tick */ }
    finally { upgrading = false; }
    window.setTimeout(() => void tick(), POLL_MS);
  };
  window.setTimeout(() => void tick(), POLL_MS);
}

/**
 * Register the service worker and wire up the new-version detection. When a
 * fresh worker reaches 'installed' state alongside an existing controller,
 * surface the update banner; on confirmation, post SKIP_WAITING + listen for
 * controllerchange to trigger a single clean reload.
 */
function setupServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
    if (!reg) return;

    // Reload exactly once when a new worker takes control.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    const promptIfWaiting = (): void => {
      const waiting = reg.waiting;
      if (!waiting) return;
      // Only prompt if there's already a controller — otherwise this is the
      // first install and no reload is needed.
      if (!navigator.serviceWorker.controller) return;
      showUpdateBanner(() => waiting.postMessage({ type: 'SKIP_WAITING' }));
    };

    promptIfWaiting();

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') promptIfWaiting();
      });
    });

    // Long-lived sessions get a periodic update check so a deploy from
    // yesterday isn't silently sat on for hours.
    setInterval(() => {
      reg.update().catch(() => { /* ignore */ });
      void checkForUpdate();
    }, 60 * 1000);

    // Re-check on PWA foreground — iOS suspends background tabs for hours,
    // so the visibility transition is the right moment to refresh the
    // "do I have the latest?" answer the user can see in the chip.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      reg.update().catch(() => { /* ignore */ });
      void checkForUpdate();
    });
  }).catch(() => { /* registration failures are non-fatal */ });
}

void boot();
