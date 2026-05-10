/**
 * UI overlays — title screen, game-over screen, sign-in panel.
 *
 * Built as plain DOM in #ui-root, not on the canvas. Easier to style, easier
 * to handle clicks/inputs, and keeps the canvas pure-vector.
 */

import type { GameState } from './types.js';
import { WAVE_LORE } from './types.js';
import { getKnownRelays, isRelayEnabled, isDefaultRelay, setRelayEnabled, addRelay, removeRelay, resetRelays } from './relays.js';
import { getTouchMode, setTouchMode, type TouchInputMode } from './touch.js';
import { getDisplayMode, setDisplayMode, type DisplayMode } from './display.js';
import {
  getReducedMotionPref, setReducedMotionPref, type ReducedMotionPref,
  getPalette, setPalette, type ColourPalette,
} from './a11y.js';
import { getHapticsEnabled, setHapticsEnabled, hapticsSupported } from './haptics.js';
import * as auth from './auth.js';
import { addLocalHighScore, getLocalHighScores, isHighScore, subscribeGlobalHighScores, clearLocalHighScores, type GlobalHighScore } from './score.js';
import { submitClaim, fetchPool, fetchPlayer, type PlayerTier } from './faucet.js';
import { renderLegalFooter, openTermsModal } from './legal.js';
import { startGame, startDeathReplay, clearEntitiesForTitle, toastNow } from './game.js';
import * as audio from './audio.js';
import { listTracks, currentTrackId, musicPreviewPlay, musicForceRefresh, musicStop } from './music.js';
import { getMusicAnalyser } from './audio.js';
import { fetchProfile, getCachedProfile, bestName } from './profile.js';
import { type Difficulty, getStoredDifficulty, setStoredDifficulty, lockInDifficulty } from './difficulty.js';
import { getStoredDailyPref, setStoredDailyPref, todayUTC, getActiveSeed } from './seed.js';
import { getStoredMode, setStoredMode, MODE_LIST, type RunMode } from './mode.js';
import { DEV } from './credits.js';
import { followUser, shareCompletion, endorseSubject, rankFromWave } from './social.js';
import { shareRunCard } from './sharecard.js';
import { requestZapInvoice, hasWebLN, payViaWebLN } from './zap.js';
import { publishGhost, prefetchTopGhost, getCachedGhost, fetchGhostByScoreEventId, ghostPoseAt, ghostScoreAt, type GhostRun } from './ghost.js';
import { WORLD_W as PALL_WORLD_W, WORLD_H as PALL_WORLD_H } from './types.js';
import {
  SKINS, getActiveSkinId, setActiveSkinId, isSkinUnlocked,
  markSkinUnlocked, publishSkinUnlocks, syncSkinUnlocksFromNostr,
  type SkinDef,
} from './skins.js';
import {
  asteroidPreview, minePreview, sniperPreview, powerupPreview,
  dustPreview, satCoinPreview,
} from './previews.js';
import QRCode from 'qrcode';

const root = document.getElementById('ui-root')!;

let onStartCb: (() => void) | null = null;
let onResumeCb: (() => void) | null = null;

export function bindActions(opts: {
  onStart: () => void;
  onResume: () => void;
}): void {
  onStartCb = opts.onStart;
  onResumeCb = opts.onResume;
}

export function clearOverlay(): void {
  root.innerHTML = '';
}

/**
 * Bind a tap handler that fires reliably on touch devices.
 *
 * `click` alone is unreliable on iOS/Android when the body cascade is
 * `touch-action: none` and a tap happens to be reclassified mid-gesture
 * by the browser. Listening to `pointerup` (filtered to non-mouse) catches
 * those cases. A `firing` flag dedupes the rare device that fires both
 * pointerup and click from a single tap. Mouse devices stay on click so
 * desktop keyboard activation (Enter on focused button) still works.
 */
function onTap(btn: HTMLElement, fn: () => void): void {
  let firing = false;
  const run = (): void => {
    if (firing) return;
    firing = true;
    try { fn(); } finally {
      // Reset on the next microtask so a second deliberate tap after
      // the handler completes still works.
      Promise.resolve().then(() => { firing = false; });
    }
  };
  btn.addEventListener('click', run);
  btn.addEventListener('pointerup', e => {
    if (e.pointerType !== 'mouse') run();
  });
}

/**
 * Bind a long-press handler to the title logo. Used by the secret music-
 * player easter egg. Hold for 700ms with minimal drift to fire; pointer
 * release, leave, or significant motion cancels.
 */
function bindLogoLongPress(target: HTMLElement, fn: () => void): void {
  const HOLD_MS = 700;
  const MOVE_TOL = 8;
  let timer: number | null = null;
  let sx = 0, sy = 0;
  const clear = (): void => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  target.addEventListener('pointerdown', e => {
    // Pre-warm audio on the gesture that initiates the long-press. The
    // setTimeout fn() runs without a gesture context, so unlocking later
    // (in the row-tap handler) is unreliable on iOS. By the time the
    // player opens 700ms after this, the AudioContext is already running.
    void audio.unlockAudio();
    sx = e.clientX; sy = e.clientY;
    clear();
    timer = window.setTimeout(() => { timer = null; fn(); }, HOLD_MS);
  });
  target.addEventListener('pointermove', e => {
    if (timer === null) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_TOL) clear();
  });
  target.addEventListener('pointerup',     clear);
  target.addEventListener('pointercancel', clear);
  target.addEventListener('pointerleave',  clear);
}

// ── First-run onboarding ─────────────────────────────────────────────────────

const ONBOARDING_KEY = 'pallasite:onboarded';

function hasCompletedOnboarding(): boolean {
  // Fail-safe to "true" -- if storage is blocked the player should not get
  // stuck behind a tutorial on every IGNITE.
  try { return localStorage.getItem(ONBOARDING_KEY) === '1'; } catch { return true; }
}

function markOnboardingComplete(): void {
  try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* ignore */ }
}

interface OnboardingCard {
  step: string;
  title: string;
  body: string;
}

const ONBOARDING_CARDS: readonly OnboardingCard[] = [
  {
    step: '1 / 3',
    title: 'DRIFT',
    body: 'Rotate ◀ ▶ to face. Thrust ▲ to drift. There is no friction here. Mass keeps moving until you point the other way.',
  },
  {
    step: '2 / 3',
    title: 'FIRE',
    body: 'Space to fire. Quick consecutive kills chain a multiplier up to 5×. Pallasite rocks drop sats. Hunt the gold.',
  },
  {
    step: '3 / 3',
    title: 'BANK',
    body: 'Survive each wave to bank what you earned. Twenty-five waves to the horizon. Sign in with Nostr to bank real sats and stake your name on the leaderboard.',
  },
];

/**
 * First-run cinematic. Three brand-voice cards then a BEGIN button that
 * fires the actual game start. Skippable. Triggered once after the first
 * IGNITE click; localStorage flag suppresses it on return.
 *
 * Marks `data-onboarding="open"` on the overlay so the global Enter-to-start
 * handler in main.ts can refuse to fire while the cinematic is up. Without
 * the gate, pressing Enter would bypass the cinematic and start the game on
 * an un-watched intro -- defeats the whole point.
 */
function renderOnboarding(onBegin: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root, attrs: { 'data-onboarding': 'open' } });
  setupOverlayArrowNav(overlay);

  let idx = 0;

  const stepEl = el('p', { parent: overlay });
  stepEl.style.cssText = 'font-size:0.78rem;letter-spacing:0.32em;color:rgba(180,140,255,0.85);margin:0;';

  const titleEl = el('h2', { parent: overlay });
  titleEl.style.cssText = 'font-size:2.4rem;letter-spacing:0.18em;color:var(--hud-yellow);text-shadow:0 0 12px rgba(255,216,74,0.5);margin:8px 0 16px;';

  const bodyEl = el('p', { parent: overlay });
  bodyEl.style.cssText = 'max-width:540px;font-size:1rem;line-height:1.6;color:rgba(220,210,255,0.92);margin:0 0 8px;text-align:center;';

  const row = el('div', { className: 'menu-row', parent: overlay });
  const nextBtn = el('button', { className: 'menu-btn', parent: row, text: 'NEXT' });

  const skipRow = el('div', { parent: overlay });
  skipRow.style.cssText = 'margin-top:18px;';
  const skipLink = el('button', { parent: skipRow, text: 'Skip intro' });
  skipLink.style.cssText = 'background:transparent;border:none;color:rgba(180,140,255,0.65);text-decoration:underline;cursor:pointer;font-size:0.9rem;letter-spacing:0.06em;padding:4px 8px;';

  const finish = (): void => {
    markOnboardingComplete();
    clearOverlay();
    onBegin();
  };

  const renderCard = (): void => {
    const card = ONBOARDING_CARDS[idx];
    stepEl.textContent = `STEP ${card.step}`;
    titleEl.textContent = card.title;
    bodyEl.textContent = card.body;
    const isLast = idx === ONBOARDING_CARDS.length - 1;
    nextBtn.textContent = isLast ? 'BEGIN · IGNITE' : 'NEXT ▶';
  };

  nextBtn.addEventListener('click', () => {
    if (idx === ONBOARDING_CARDS.length - 1) {
      finish();
    } else {
      idx += 1;
      renderCard();
      nextBtn.focus();
    }
  });

  skipLink.addEventListener('click', finish);

  renderCard();
}

/**
 * Gate any IGNITE-style entry path behind the first-run cinematic.
 *
 * If the player has already completed onboarding, calls `onReady` straight
 * away. Otherwise shows the cinematic and calls `onReady` after they
 * finish or skip. Keeps both the IGNITE-button path and the global
 * Enter-to-start path consistent so first-timers can't skip the intro just
 * by pressing Enter.
 */
export function gateBehindOnboarding(onReady: () => void): void {
  if (hasCompletedOnboarding()) {
    onReady();
  } else {
    renderOnboarding(onReady);
  }
}

/**
 * Wire arrow-key navigation across the focusable buttons in an overlay.
 * ↑/← cycles to previous, ↓/→ to next, Enter/Space activates (browser default).
 * No autofocus — user must Tab once or press an arrow to enter the cycle —
 * which avoids fighting the global Enter-to-start handler in main.ts.
 */
function setupOverlayArrowNav(overlay: HTMLElement): void {
  const handler = (e: KeyboardEvent): void => {
    // Detach when the overlay leaves the DOM (next render replaces it).
    if (!document.body.contains(overlay)) {
      window.removeEventListener('keydown', handler);
      return;
    }
    if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown'
     && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter(b => b.offsetParent !== null);  // skip hidden ones (e.g. joystick-mode buttons)
    if (buttons.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? buttons.indexOf(active as HTMLButtonElement) : -1;
    if (idx === -1) {
      // No button focused yet — first arrow keypress focuses the first button.
      buttons[0].focus();
    } else {
      const dir = e.code === 'ArrowDown' || e.code === 'ArrowRight' ? 1 : -1;
      const next = (idx + dir + buttons.length) % buttons.length;
      buttons[next].focus();
    }
    e.preventDefault();
  };
  window.addEventListener('keydown', handler);
}

/**
 * Classic arcade initials entry — replaces the freeform <input> + SAVE button
 * for high-score naming.
 *
 *   • 4 fixed slots, A in the first, space in the rest
 *   • ↑/↓ cycle the active slot through A-Z, 0-9, space (37 chars)
 *   • →   advance the cursor; pressing → from the 4th slot submits
 *   • ←   move the cursor back one slot
 *   • Backspace clears the active slot to space and steps back
 *   • Enter / Space / Escape are swallowed (no-op) so they can't trigger
 *     the global "Enter restarts game" / "Space fires" / "Escape pauses"
 *     handlers while the player is locking in initials
 *   • An idle countdown auto-submits after `idleSeconds` of no input
 *
 * The handler runs in capture phase and stops immediate propagation on the
 * keys it consumes, so the overlay's arrow-key button-cycling listener
 * doesn't also fire on the same press. Cleans up the listener and the two
 * intervals (blink + idle) once submitted or once the wrapper detaches.
 */
function renderArcadeInitials(
  parent: HTMLElement,
  opts: { onSubmit: (name: string) => void; idleSeconds?: number },
): void {
  const idleSeconds = opts.idleSeconds ?? 30;
  // Letters + digits + a small set of classic arcade-cabinet symbols,
  // ending in a space (rendered as `_` in the slots so it reads as
  // "blank" rather than vanishing).
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?.-+*<> ';
  const SPACE_IDX = CHARS.length - 1;
  const slots = [0, SPACE_IDX, SPACE_IDX, SPACE_IDX];
  let cursor = 0;
  let secondsLeft = idleSeconds;
  let submitted = false;

  const wrap = el('div', { parent });
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;margin:6px 0;';
  // Marker for the global Enter-to-restart handler in main.ts. Capture-phase
  // stopImmediatePropagation isn't enough on its own: when key events target
  // window itself (no focused element), capture vs bubble doesn't apply and
  // listeners fire in registration order — main.ts's window keydown listener
  // is registered at module load, so it can fire before this widget's
  // capture handler ever gets a chance. Belt and braces: main.ts checks for
  // this attribute before treating Enter as "restart game".
  wrap.dataset.arcadeInitials = 'open';

  const slotsRow = el('div', { parent: wrap });
  slotsRow.style.cssText = 'display:flex;gap:8px;';
  const slotEls: HTMLDivElement[] = [];

  // Each slot lives in its own column with ▲/▼ tap buttons so mobile users
  // (no keyboard) can cycle and submit. Keyboard users still drive via the
  // arrow-key handler below; touch and keyboard share the same internal
  // cycleAt / moveTo / commit functions.
  const cycleAt = (idx: number, dir: 1 | -1): void => {
    cursor = idx;
    slots[idx] = (slots[idx] + dir + CHARS.length) % CHARS.length;
    renderSlots();
    audio.initialCycle();
    resetIdle();
  };
  const moveTo = (idx: number): void => {
    if (cursor === idx) return;
    cursor = idx;
    renderSlots();
    audio.initialMove();
    resetIdle();
  };

  // pointerdown (not click) so the overlay's touch-action: pan-y can't
  // re-interpret a tap as a scroll-cancel. position: relative + z-index ensures
  // the button always wins event capture against any overlapping descendant.
  const arrowBtnCss = 'width:48px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(88,255,88,0.12);border:2px solid rgba(88,255,88,0.4);color:#58ff58;font-family:inherit;font-size:1.1rem;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;position:relative;z-index:2;pointer-events:auto;';
  const bindTap = (btn: HTMLElement, fn: () => void): void => {
    btn.addEventListener('pointerdown', e => { e.preventDefault(); fn(); });
    btn.addEventListener('click', e => { e.preventDefault(); });
  };
  for (let i = 0; i < 4; i++) {
    const col = el('div', { parent: slotsRow }) as HTMLDivElement;
    col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;';

    const up = el('button', { parent: col, text: '▲' }) as HTMLButtonElement;
    up.type = 'button';
    up.style.cssText = arrowBtnCss;
    bindTap(up, () => cycleAt(i, 1));

    const box = el('div', { parent: col }) as HTMLDivElement;
    box.style.cssText = 'width:48px;height:54px;display:flex;align-items:center;justify-content:center;font-family:inherit;font-size:1.6rem;background:rgba(0,0,0,0.4);border:2px solid rgba(88,255,88,0.3);color:#58ff58;letter-spacing:0;transition:opacity 120ms;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;position:relative;z-index:2;pointer-events:auto;';
    bindTap(box, () => moveTo(i));

    const down = el('button', { parent: col, text: '▼' }) as HTMLButtonElement;
    down.type = 'button';
    down.style.cssText = arrowBtnCss;
    bindTap(down, () => cycleAt(i, -1));

    slotEls.push(box);
  }

  const saveBtn = el('button', { parent: wrap, text: 'SAVE' }) as HTMLButtonElement;
  saveBtn.type = 'button';
  saveBtn.style.cssText = 'margin-top:6px;padding:12px 32px;min-height:44px;background:rgba(255,216,74,0.18);border:2px solid #ffd84a;color:#ffd84a;font-family:inherit;font-size:1rem;letter-spacing:0.2em;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;position:relative;z-index:2;pointer-events:auto;';
  bindTap(saveBtn, () => commit());

  const hint = el('p', { parent: wrap, text: '▲▼ CYCLE · TAP SLOT TO MOVE · SAVE' });
  hint.style.cssText = 'font-size:0.7rem;color:rgba(180,140,255,0.7);letter-spacing:0.18em;margin:0;';

  const timerLine = el('p', { parent: wrap });
  timerLine.style.cssText = 'font-size:0.78rem;color:#ffd84a;letter-spacing:0.18em;margin:0;';

  const renderSlots = (): void => {
    for (let i = 0; i < 4; i++) {
      const ch = CHARS[slots[i]];
      slotEls[i].textContent = ch === ' ' ? '_' : ch;
      const isActive = i === cursor;
      slotEls[i].style.borderColor = isActive ? '#ffd84a' : 'rgba(88,255,88,0.3)';
      slotEls[i].style.color = isActive ? '#ffd84a' : '#58ff58';
    }
  };
  const renderTimer = (): void => { timerLine.textContent = `AUTO SAVE IN ${secondsLeft}`; };
  renderSlots();
  renderTimer();

  // Cursor blink — only the active slot pulses, so the player knows where
  // input lands without any other moving parts on the screen.
  let blinkOn = true;
  const blinkInterval = window.setInterval(() => {
    blinkOn = !blinkOn;
    for (let i = 0; i < 4; i++) slotEls[i].style.opacity = i === cursor && !blinkOn ? '0.5' : '1';
  }, 450);

  const idleInterval = window.setInterval(() => {
    secondsLeft -= 1;
    renderTimer();
    if (secondsLeft <= 0) commit();
  }, 1000);

  const resetIdle = (): void => { secondsLeft = idleSeconds; renderTimer(); };

  const cleanup = (): void => {
    window.removeEventListener('keydown', handler, true);
    window.clearInterval(blinkInterval);
    window.clearInterval(idleInterval);
    for (const s of slotEls) s.style.opacity = '1';
  };

  const commit = (): void => {
    if (submitted) return;
    submitted = true;
    cleanup();
    audio.initialCommit();
    const name = slots.map(i => CHARS[i]).join('').replace(/\s+$/, '') || 'YOU';
    opts.onSubmit(name);
  };

  function handler(e: KeyboardEvent): void {
    if (submitted || !document.body.contains(wrap)) { cleanup(); return; }
    let consumed = true;
    let interacted = true;
    switch (e.code) {
      case 'ArrowUp':
        slots[cursor] = (slots[cursor] + 1) % CHARS.length;
        renderSlots();
        audio.initialCycle();
        break;
      case 'ArrowDown':
        slots[cursor] = (slots[cursor] - 1 + CHARS.length) % CHARS.length;
        renderSlots();
        audio.initialCycle();
        break;
      case 'ArrowRight':
        if (cursor === 3) { commit(); return; }
        cursor += 1;
        renderSlots();
        audio.initialMove();
        break;
      case 'ArrowLeft':
        if (cursor > 0) { cursor -= 1; renderSlots(); audio.initialMove(); }
        break;
      case 'Backspace':
        slots[cursor] = SPACE_IDX;
        if (cursor > 0) cursor -= 1;
        renderSlots();
        audio.initialBackspace();
        break;
      case 'Enter':
      case 'Space':
      case 'Escape':
        // Swallowed but no-op. Without this, Enter falls through to the
        // global "restart game from gameover" listener, Space to "fire",
        // Escape to "pause" — none of which the player wants while
        // they're locking in initials. Submission happens only via → at
        // slot 4 or the idle auto-save. These don't count as
        // engagement, so the idle timer keeps counting down.
        interacted = false;
        break;
      default:
        consumed = false;
        interacted = false;
    }
    if (consumed) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (interacted) resetIdle();
  }

  window.addEventListener('keydown', handler, true);
}

/**
 * Floating banner that appears when the service worker has a new version
 * waiting. Tap RELOAD → posts SKIP_WAITING to the worker → controllerchange
 * triggers a clean reload into the new build.
 */
export function showUpdateBanner(onReload: () => void): void {
  if (document.getElementById('pal-update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'pal-update-banner';
  // z-index 9999 so the banner stacks above any overlay (.overlay has no
  // explicit z-index and creates a stacking context via inset:0). The body
  // sets touch-action:none which can prevent click-ready taps on iOS for
  // descendants without their own touch-action — declare manipulation on
  // the banner so the button below resolves taps without delay.
  banner.style.cssText = [
    'position:fixed',
    'top:max(12px, env(safe-area-inset-top, 0px))',
    'left:50%', 'transform:translateX(-50%)',
    'z-index:9999',
    'background:rgba(10,4,24,0.95)',
    'border:2px solid #ffd84a', 'border-radius:10px',
    'padding:12px 16px',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1rem', 'letter-spacing:0.12em',
    'color:#ffd84a',
    'text-shadow:0 0 8px rgba(255,216,74,0.6)',
    'box-shadow:0 0 20px rgba(255,216,74,0.35)',
    'display:flex', 'gap:14px', 'align-items:center',
    'pointer-events:auto',
    'touch-action:manipulation',
    '-webkit-tap-highlight-color:rgba(255,216,74,0.18)',
  ].join(';');
  banner.innerHTML = `<span>NEW VERSION READY</span><button type="button" style="font-family:inherit;font-size:0.95rem;letter-spacing:0.18em;padding:10px 16px;min-height:44px;background:rgba(255,216,74,0.15);border:1px solid #ffd84a;color:#ffd84a;border-radius:6px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:rgba(255,216,74,0.32);">RELOAD</button>`;
  const reloadBtn = banner.querySelector('button') as HTMLButtonElement;
  // Bind both click and pointerup — some mobile browsers swallow click on
  // elements layered above touch-action:none ancestors. Pointerup fires
  // reliably; click stays as the primary path. Guard against double-fire
  // with a fired flag.
  let fired = false;
  const trigger = (): void => {
    if (fired) return;
    fired = true;
    banner.querySelector('span')!.textContent = 'UPDATING...';
    reloadBtn.disabled = true;
    onReload();
  };
  reloadBtn.addEventListener('click', trigger);
  reloadBtn.addEventListener('pointerup', trigger);
  document.body.appendChild(banner);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: {
  className?: string;
  text?: string;
  html?: string;
  parent?: HTMLElement;
  attrs?: Record<string, string>;
}): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts?.className) e.className = opts.className;
  if (opts?.text) e.textContent = opts.text;
  if (opts?.html) e.innerHTML = opts.html;
  if (opts?.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  if (opts?.parent) opts.parent.appendChild(e);
  return e;
}

// ── Title screen ──────────────────────────────────────────────────────────────

export function renderTitle(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  // Warm both leader-ghost cache slots: today's seed (for the daily-mode
  // race + chip) and the global top (for the title attract-loop and
  // non-daily races). Both go into the cache so whichever mode the player
  // chooses on IGNITE has a hot ghost. getActiveSeed isn't usable here —
  // the seed only locks on IGNITE — so we read the stored preference
  // directly to anticipate.
  prefetchTopGhost(getStoredDailyPref() ? todayUTC() : null);

  // Pull skin unlocks the player earned on other devices. Fire-and-forget;
  // returned set has already been merged into local. The settings overlay
  // re-reads localStorage each time it opens so by the time the player
  // navigates there the merged set is visible.
  if (state.session) {
    void syncSkinUnlocksFromNostr(state.session.pubkey).catch(() => undefined);
  }

  // Wordmark image rendered with mix-blend-mode: screen so the baked-in
  // black starfield bg drops out and only the green lettering floats over
  // the cycling wave background. The text is preserved as alt for screen
  // readers and shows if the image fails to load.
  const titleLogo = el('img', { parent: overlay });
  titleLogo.className = 'title-logo';
  (titleLogo as HTMLImageElement).src = '/logo.webp';
  (titleLogo as HTMLImageElement).alt = 'PALLASITE';
  (titleLogo as HTMLImageElement).decoding = 'async';
  // Easter egg: long-press the logo to open the secret music player.
  bindLogoLongPress(titleLogo, () => renderMusicPlayer(state, () => renderTitle(state)));
  const tagline = el('p', { parent: overlay, text: 'SHOOT ROCKS · STACK SATS' });
  tagline.style.cssText = 'font-size:1.2rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-12px;';
  el('p', { parent: overlay, text: 'Cosmic arcade · Lightning sats · Nostr leaderboards' });

  renderPoolChip(overlay);

  const sessionPanel = el('div', { className: 'session-panel', parent: overlay });
  renderSessionPanel(sessionPanel, state);

  // Mode picker — campaign / drift / bossrush / arena. Sits above difficulty
  // because it changes the SHAPE of the run; difficulty just tunes within.
  renderModeRow(overlay, state);

  // Difficulty selector
  renderDifficultyRow(overlay);

  // Daily / Free toggle
  renderDailyRow(overlay);

  // Today's daily-seed leader — surfaces the standing top score on the
  // current daily seed so the title screen always has a visible "duel of
  // the day" hook. Empty state ("be the first") is itself motivating.
  renderDailyLeaderChip(overlay);

  const row = el('div', { className: 'menu-row', parent: overlay });
  const startBtn = el('button', { className: 'menu-btn', parent: row, text: 'IGNITE · PRESS ENTER' });
  startBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    gateBehindOnboarding(() => onStartCb?.());
  });
  const howBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'HOW TO PLAY' });
  howBtn.addEventListener('click', () => renderHowToPlay(() => renderTitle(state)));
  const settingsBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SETTINGS' });
  settingsBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    renderSettings(() => renderTitle(state));
  });

  // Show local high scores under the start button if any exist. Local entries
  // sometimes carry an eventId (set when the player published this run via the
  // faucet); when they do, the row is clickable and replays in the theatre.
  const list = getLocalHighScores();
  if (list.length > 0) {
    renderLeaderboardBlock(overlay, list, '— LOCAL HIGH SCORES —', 5, () => renderTitle(state));
  }

  // Global leaderboard from kind 30762 events on relays. Rendered async so
  // the title screen never blocks on a network round-trip — show a placeholder
  // while it loads, swap in the real list when the relays answer.
  renderGlobalLeaderboard(overlay, state);

  renderLegalFooter(overlay);

  // Keyboard cheatsheet removed — HOW TO PLAY button covers the same content
  // and the duplicate strip cramped the desktop layout against the high scores.
}

/**
 * Faucet status chip. Shows a single live/paused signal plus the daily-cap
 * meter — never the absolute float or lifetime payout, since advertising
 * pot size is a honey-pot for abuse. Polled every 60s while the title is
 * visible.
 */
function renderPoolChip(parent: HTMLElement): void {
  const wrapper = el('div', { parent });
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:4px;margin:6px 0 4px';

  const lineStatus = el('p', { parent: wrapper });
  lineStatus.style.cssText =
    'font-size:0.78rem;color:rgba(255,216,74,0.65);letter-spacing:0.08em;margin:0';
  lineStatus.textContent = 'Faucet: …';

  // Daily-faucet meter: thin horizontal bar + spent/cap text. Hidden until
  // the first /api/pool response with daily_cap_sats arrives.
  const meterWrap = el('div', { parent: wrapper });
  meterWrap.style.cssText =
    'display:none;flex-direction:column;align-items:center;gap:2px;width:200px;margin-top:4px';

  const meterBar = el('div', { parent: meterWrap });
  meterBar.style.cssText =
    'width:100%;height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden';

  const meterFill = el('div', { parent: meterBar });
  meterFill.style.cssText =
    'height:100%;width:0%;background:#58ff58;transition:width 600ms ease,background 400ms ease';

  const meterLabel = el('p', { parent: meterWrap });
  meterLabel.style.cssText =
    'font-size:0.72rem;color:rgba(180,180,180,0.7);letter-spacing:0.08em;margin:0';

  let intervalId: number | null = null;

  const update = async (): Promise<void> => {
    const pool = await fetchPool();
    if (!wrapper.isConnected) {
      if (intervalId !== null) clearInterval(intervalId);
      return;
    }
    if (!pool) {
      lineStatus.textContent = 'Faucet status unavailable';
      lineStatus.style.color = 'rgba(180,180,180,0.6)';
      meterWrap.style.display = 'none';
      return;
    }
    if (pool.paused) {
      lineStatus.textContent = 'Faucet paused';
      lineStatus.style.color = '#ff8050';
    } else {
      lineStatus.textContent = 'Faucet active';
      lineStatus.style.color = 'rgba(255,216,74,0.65)';
    }

    // Daily meter — green / amber / red as the cap fills.
    if (typeof pool.daily_cap_sats === 'number' && pool.daily_cap_sats > 0) {
      const spent = pool.daily_spent_sats ?? 0;
      const pct = Math.min(100, Math.round((spent / pool.daily_cap_sats) * 100));
      meterFill.style.width = `${pct}%`;
      let colour = '#58ff58'; // green
      if (pct >= 90) colour = '#ff5050';
      else if (pct >= 60) colour = '#ffd84a';
      meterFill.style.background = colour;
      meterLabel.textContent =
        pct >= 100
          ? `Today's faucet drained — back tomorrow`
          : `Today: ${spent.toLocaleString()} of ${pool.daily_cap_sats.toLocaleString()} sats`;
      meterWrap.style.display = 'flex';
    } else {
      meterWrap.style.display = 'none';
    }
  };

  void update();
  intervalId = window.setInterval(() => {
    if (!wrapper.isConnected) {
      if (intervalId !== null) clearInterval(intervalId);
      return;
    }
    void update();
  }, 60_000);
}

function renderGlobalLeaderboard(parent: HTMLElement, state: GameState): void {
  const container = el('div', { parent });
  const block = el('div', { className: 'leaderboard-block', parent: container });
  el('p', { className: 'leaderboard-title', parent: block, text: '— GLOBAL HIGH SCORES —' });
  const status = el('p', { parent: block, text: 'Listening to relays…' });
  status.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;';

  // Persistent subscription: scores stream in as relays propagate them and
  // the leaderboard reflects the new state without reloading the title. The
  // 30s cache that fetchGlobalHighScores used to apply is bypassed here on
  // purpose -- we want live updates, not polled snapshots.
  let renderToken = 0;
  let receivedAny = false;
  let cleanupTimer: number | null = null;

  const teardown = (): void => {
    unsubscribe();
    if (cleanupTimer !== null) { clearInterval(cleanupTimer); cleanupTimer = null; }
  };

  const unsubscribe = subscribeGlobalHighScores(async raw => {
    if (!container.isConnected) { teardown(); return; }
    receivedAny = true;
    if (raw.length === 0) {
      status.textContent = 'No global scores yet — be the first.';
      return;
    }
    const myToken = ++renderToken;
    const top = raw.slice(0, 5);
    const entries = await Promise.all(top.map(resolveDisplayName));
    if (!container.isConnected || myToken !== renderToken) return;
    container.innerHTML = '';
    renderLeaderboardBlock(container, entries.map(globalToLocal), '— GLOBAL HIGH SCORES —', 5, () => renderTitle(state));
  });

  // Backstop probe: if the title screen unmounts during a long quiet period
  // the onUpdate-side disconnection check won't fire. Probe every 30s.
  cleanupTimer = window.setInterval(() => {
    if (!container.isConnected) teardown();
  }, 30_000);

  // Empty-state fallback if relays stay silent for 8s -- soften "Listening…"
  // into the same "be the first" hint fetchGlobalHighScores used to show.
  window.setTimeout(() => {
    if (!container.isConnected) return;
    if (!receivedAny && status.isConnected) {
      status.textContent = 'No global scores yet — be the first.';
    }
  }, 8000);
}

async function resolveDisplayName(entry: GlobalHighScore): Promise<GlobalHighScore & { displayName: string }> {
  const cached = getCachedProfile(entry.pubkey);
  const profile = cached ?? await fetchProfile(entry.pubkey).catch(() => null);
  return { ...entry, displayName: bestName(profile, entry.pubkey) };
}

function globalToLocal(entry: GlobalHighScore & { displayName: string }): ReturnType<typeof getLocalHighScores>[number] {
  return {
    name: entry.displayName,
    score: entry.score,
    sats: entry.sats,
    wave: entry.wave,
    at: entry.at,
    pubkey: entry.pubkey,
    eventId: entry.eventId,
  };
}

/**
 * Mode picker — campaign / drift / bossrush / arena. Shape of the run.
 * Selected mode highlights yellow; unfinished modes (bossrush, arena)
 * still render so the player knows they're coming, but tapping them
 * toasts COMING SOON and the selection reverts to the previous valid
 * mode.
 */
function renderModeRow(parent: HTMLElement, state: GameState): void {
  void state;
  const wrapper = el('div', { parent });
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;';
  const label = el('p', { parent: wrapper, text: 'MODE' });
  label.style.cssText = 'font-size:0.8rem;color:rgba(180,140,255,0.85);letter-spacing:0.3em;margin:0;';

  const row = el('div', { parent: wrapper });
  row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;justify-content:center;';

  const hint = el('p', { parent: wrapper });
  hint.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;height:1em;text-align:center;';

  const buttons = new Map<RunMode, HTMLButtonElement>();
  const refresh = (): void => {
    const current = getStoredMode();
    for (const info of MODE_LIST) {
      const btn = buttons.get(info.id)!;
      const selected = info.id === current;
      btn.style.cssText = [
        'background:' + (selected ? 'rgba(255,216,74,0.18)' : 'transparent'),
        'border:2px solid ' + (selected ? '#ffd84a' : info.ready ? 'rgba(180,140,255,0.4)' : 'rgba(180,140,255,0.18)'),
        'color:' + (selected ? '#ffd84a' : info.ready ? 'rgba(220,210,255,0.85)' : 'rgba(180,140,255,0.45)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.95rem', 'padding:6px 14px',
        'letter-spacing:0.16em', 'cursor:pointer', 'border-radius:6px',
        'transition:all 0.12s ease',
        selected ? 'box-shadow:0 0 14px rgba(255,216,74,0.4);text-shadow:0 0 6px rgba(255,216,74,0.6)' : '',
      ].filter(Boolean).join(';');
    }
    const hintFor = MODE_LIST.find(m => m.id === current)?.hint ?? '';
    hint.textContent = hintFor;
  };

  for (const info of MODE_LIST) {
    const btn = el('button', { parent: row, text: info.label });
    buttons.set(info.id, btn);
    onTap(btn, () => {
      if (!info.ready) {
        hint.textContent = 'COMING SOON';
        return;
      }
      setStoredMode(info.id);
      refresh();
    });
    btn.addEventListener('mouseenter', () => { hint.textContent = info.hint; });
    btn.addEventListener('mouseleave', () => {
      hint.textContent = MODE_LIST.find(m => m.id === getStoredMode())?.hint ?? '';
    });
  }
  refresh();
}

function renderDifficultyRow(parent: HTMLElement): void {
  const wrapper = el('div', { parent });
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;';
  const label = el('p', { parent: wrapper, text: 'DIFFICULTY' });
  label.style.cssText = 'font-size:0.8rem;color:rgba(180,140,255,0.85);letter-spacing:0.3em;margin:0;';

  const row = el('div', { parent: wrapper });
  row.style.cssText = 'display:flex;gap:8px;';

  const opts: Array<{ value: Difficulty; label: string; hint: string }> = [
    { value: 'easy',   label: 'EASY',   hint: '5 lives · slow rocks · sloppy aim' },
    { value: 'normal', label: 'NORMAL', hint: '3 lives · the canonical run' },
    { value: 'hard',   label: 'HARD',   hint: '2 lives · fast rocks · sharp aim' },
  ];

  const hint = el('p', { parent: wrapper });
  hint.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;height:1em;';

  const buttons = new Map<Difficulty, HTMLButtonElement>();
  const refresh = (): void => {
    const current = getStoredDifficulty();
    for (const [d, btn] of buttons) {
      const selected = d === current;
      btn.style.cssText = [
        'background:' + (selected ? 'rgba(255,216,74,0.18)' : 'transparent'),
        'border:2px solid ' + (selected ? '#ffd84a' : 'rgba(180,140,255,0.4)'),
        'color:' + (selected ? '#ffd84a' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:1rem', 'padding:6px 16px',
        'letter-spacing:0.18em', 'cursor:pointer', 'border-radius:6px',
        'transition:all 0.12s ease',
        selected ? 'box-shadow:0 0 14px rgba(255,216,74,0.4);text-shadow:0 0 6px rgba(255,216,74,0.6)' : '',
      ].filter(Boolean).join(';');
    }
    const hintFor = opts.find(o => o.value === current)?.hint ?? '';
    hint.textContent = hintFor;
  };

  for (const opt of opts) {
    const btn = el('button', { parent: row, text: opt.label });
    buttons.set(opt.value, btn);
    btn.addEventListener('click', () => {
      setStoredDifficulty(opt.value);
      refresh();
    });
    btn.addEventListener('mouseenter', () => { hint.textContent = opt.hint; });
    btn.addEventListener('mouseleave', () => {
      const cur = opts.find(o => o.value === getStoredDifficulty())?.hint ?? '';
      hint.textContent = cur;
    });
  }
  refresh();
}

function renderDailyRow(parent: HTMLElement): void {
  const wrapper = el('div', { parent });
  wrapper.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;margin-top:6px;';
  const label = el('p', { parent: wrapper, text: 'RUN MODE' });
  label.style.cssText = 'font-size:0.8rem;color:rgba(180,140,255,0.85);letter-spacing:0.3em;margin:0;';

  const row = el('div', { parent: wrapper });
  row.style.cssText = 'display:flex;gap:8px;';

  const opts: Array<{ value: boolean; label: string; hint: string }> = [
    { value: false, label: 'FREE',  hint: 'Random seeds. No daily lock.' },
    { value: true,  label: 'DAILY', hint: `Same layout for everyone today (${todayUTC()})` },
  ];

  const hint = el('p', { parent: wrapper });
  hint.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;height:1em;';

  const buttons = new Map<boolean, HTMLButtonElement>();
  const refresh = (): void => {
    const current = getStoredDailyPref();
    for (const [v, btn] of buttons) {
      const selected = v === current;
      btn.style.cssText = [
        'background:' + (selected ? 'rgba(91,157,255,0.18)' : 'transparent'),
        'border:2px solid ' + (selected ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (selected ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.95rem', 'padding:5px 14px',
        'letter-spacing:0.18em', 'cursor:pointer', 'border-radius:6px',
        'transition:all 0.12s ease',
        selected ? 'box-shadow:0 0 14px rgba(91,157,255,0.4);text-shadow:0 0 6px rgba(91,157,255,0.6)' : '',
      ].filter(Boolean).join(';');
    }
    const hintFor = opts.find(o => o.value === current)?.hint ?? '';
    hint.textContent = hintFor;
  };

  for (const opt of opts) {
    const btn = el('button', { parent: row, text: opt.label });
    buttons.set(opt.value, btn);
    btn.addEventListener('click', () => {
      setStoredDailyPref(opt.value);
      refresh();
    });
    btn.addEventListener('mouseenter', () => { hint.textContent = opt.hint; });
    btn.addEventListener('mouseleave', () => {
      const cur = opts.find(o => o.value === getStoredDailyPref())?.hint ?? '';
      hint.textContent = cur;
    });
  }
  refresh();
  void getActiveSeed;  // keep import bound for cross-references
}

/**
 * Today's daily-seed chase chip. Polls the ghost cache (warmed by
 * prefetchTopGhost in renderTitle) and updates when the relays answer.
 *
 * Framed as a chase target rather than a stat:
 *   - Empty state: "TODAY IS FRESH · SET THE BAR"
 *   - Filled state: "CHASING @name · 47,820"
 *
 * Display name resolves via the kind 0 cache + fetch path used by the
 * leaderboards. Falls back to a pubkey stub if the player has no
 * profile metadata yet, then upgrades in place when the fetch lands.
 *
 * Read-only -- the DAILY/FREE toggle directly above is the actual control.
 */
function renderDailyLeaderChip(parent: HTMLElement): void {
  const wrap = el('div', { parent });
  wrap.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center', 'gap:2px',
    'margin:8px 0 0', 'padding:6px 14px',
    'border:1px solid rgba(180,140,255,0.25)', 'border-radius:8px',
    'min-width:280px', 'text-align:center',
  ].join(';');

  const heading = el('p', { parent: wrap, text: `DAILY ${todayUTC()}` });
  heading.style.cssText = 'font-size:0.7rem;color:rgba(180,140,255,0.7);letter-spacing:0.28em;margin:0;';

  const body = el('p', { parent: wrap, text: 'TODAY IS FRESH · SET THE BAR' });
  body.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:1.1rem;color:#ffd84a;letter-spacing:0.16em;margin:0;text-shadow:0 0 6px rgba(255,216,74,0.45);";

  let lastPaintedPubkey: string | null = null;

  function paint(): void {
    const seed = todayUTC();
    const run = getCachedGhost(seed);
    if (!run) return;
    if (run.pubkey === lastPaintedPubkey) return;
    lastPaintedPubkey = run.pubkey;

    // Optimistic stub render now; swap in the real display name async once
    // the kind 0 fetch lands (or hit cache for an instant swap).
    const stub = run.pubkey.slice(0, 8) + '…' + run.pubkey.slice(-4);
    const fmt = (name: string): string => `CHASING ${name} · ${run.score.toLocaleString()}`;
    body.textContent = fmt(stub);
    body.style.color = '#7fffb0';
    body.style.textShadow = '0 0 6px rgba(127,255,176,0.45)';

    const cached = getCachedProfile(run.pubkey);
    if (cached) {
      body.textContent = fmt(bestName(cached, run.pubkey));
    } else {
      void fetchProfile(run.pubkey).then(profile => {
        if (!document.body.contains(wrap)) return;
        if (lastPaintedPubkey !== run.pubkey) return;
        body.textContent = fmt(bestName(profile, run.pubkey));
      }).catch(() => undefined);
    }
  }
  paint();

  // Relay round-trip can land after this render. Poll the cache for ~5s
  // and update once the leader arrives. Bail when the chip leaves the DOM
  // (overlay swap) or after ticks burn.
  let ticks = 0;
  const interval = window.setInterval(() => {
    ticks += 1;
    paint();
    if (getCachedGhost(todayUTC()) || ticks > 12 || !document.body.contains(wrap)) {
      window.clearInterval(interval);
    }
  }, 400);
}

// ── Replay theatre ────────────────────────────────────────────────────────────

interface ReplayTheatreInput {
  scoreEventId: string;
  displayName: string;
  score: number;
  wave: number;
  sats: number;
  onClose: () => void;
}

/**
 * Watch a leaderboard run.
 *
 * Fetches the kind 30763 ghost referencing the supplied kind 30762 score
 * event, then plays it back in a small canvas with score + progress chip.
 * Ghost data carries ship pose (v2) or score-only (v1) -- the playback shows
 * how the player navigated and how their score climbed, not the asteroid
 * field they fought (the ghost stream doesn't carry that).
 *
 * Speed cycles 1x / 2x / 4x. Defaults to 2x. Space toggles looping at the
 * end of a run; Escape and the CLOSE button exit and call `onClose`.
 */
function renderReplayTheatre(input: ReplayTheatreInput): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'WATCHING' });

  const nameEl = el('p', { parent: overlay, text: input.displayName.toUpperCase() });
  nameEl.style.cssText = 'margin:6px 0 4px;font-size:1.2rem;letter-spacing:0.18em;color:var(--hud-green);text-shadow:0 0 10px rgba(91,255,140,0.4);';

  const stat = el('p', { parent: overlay });
  stat.style.cssText = 'margin:0 0 14px;font-size:0.92rem;color:rgba(220,210,255,0.8);letter-spacing:0.1em;';
  stat.textContent = `WAVE ${input.wave} · ${input.score.toLocaleString()} SCORE${input.sats > 0 ? ` · ₿ ${input.sats}` : ''}`;

  const CANVAS_W = 600;
  const CANVAS_H = Math.round(CANVAS_W * PALL_WORLD_H / PALL_WORLD_W);
  const canvas = el('canvas', { parent: overlay, attrs: { width: String(CANVAS_W), height: String(CANVAS_H) } });
  canvas.style.cssText = 'border:1px solid rgba(91,157,255,0.4);border-radius:8px;background:#02050d;display:block;margin:0 auto;max-width:100%;';
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    el('p', { parent: overlay, text: 'Canvas unsupported in this browser.' });
    return;
  }

  const status = el('p', { parent: overlay, text: 'Fetching replay…' });
  status.style.cssText = 'margin:10px 0 4px;font-size:0.9rem;color:rgba(180,140,255,0.75);letter-spacing:0.08em;min-height:1.2em;';

  const liveScore = el('p', { parent: overlay });
  liveScore.style.cssText = 'margin:6px 0 0;font-size:1.4rem;letter-spacing:0.18em;color:var(--hud-yellow);text-shadow:0 0 12px rgba(255,216,74,0.5);min-height:1.4em;';

  const progressTrack = el('div', { parent: overlay });
  progressTrack.style.cssText = 'width:600px;max-width:90vw;height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;margin:10px auto 6px;';
  const progressFill = el('div', { parent: progressTrack });
  progressFill.style.cssText = 'height:100%;width:0%;background:#5b9dff;transition:width 80ms linear;';

  const timeLabel = el('p', { parent: overlay });
  timeLabel.style.cssText = 'margin:0 0 14px;font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.08em;min-height:1em;';

  const buttonRow = el('div', { className: 'menu-row', parent: overlay });
  let speed = 2;
  const speedBtn = el('button', { className: 'menu-btn secondary', parent: buttonRow, text: `SPEED ${speed}×` });
  const closeBtn = el('button', { className: 'menu-btn', parent: buttonRow, text: 'CLOSE · ESC' });

  // Stable starfield -- generated once so the background isn't re-randomised
  // every frame.
  const stars: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 80; i++) {
    stars.push({ x: Math.random() * CANVAS_W, y: Math.random() * CANVAS_H, r: 0.4 + Math.random() * 1.0 });
  }

  let ghost: GhostRun | null = null;
  let playheadMs = 0;
  let lastFrame = 0;
  let rafId: number | null = null;
  let cancelled = false;
  let looped = false;

  const cleanup = (): void => {
    cancelled = true;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    window.removeEventListener('keydown', onKey);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      cleanup();
      input.onClose();
      return;
    }
    if (e.code === 'Space' && ghost) {
      e.preventDefault();
      looped = !looped;
      if (rafId === null) {
        playheadMs = 0;
        lastFrame = 0;
        status.textContent = looped ? 'Looping replay.' : '';
        rafId = requestAnimationFrame(tick);
      } else {
        status.textContent = looped ? 'Looping replay.' : 'Will stop at end.';
      }
    }
  };
  window.addEventListener('keydown', onKey);

  closeBtn.addEventListener('click', () => { cleanup(); input.onClose(); });

  speedBtn.addEventListener('click', () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    speedBtn.textContent = `SPEED ${speed}×`;
  });

  const formatTime = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
  };

  const drawFrame = (): void => {
    if (cancelled || !ghost) return;

    ctx.fillStyle = '#02050d';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = 'rgba(180,140,255,0.55)';
    for (const star of stars) {
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    }

    const sx = CANVAS_W / PALL_WORLD_W;
    const sy = CANVAS_H / PALL_WORLD_H;
    const pose = ghostPoseAt(ghost, playheadMs);
    if (pose && pose.alive) {
      ctx.save();
      ctx.translate(pose.x * sx, pose.y * sy);
      ctx.rotate(pose.rot);
      ctx.scale(0.85, 0.85);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#8ee0ff';
      ctx.shadowColor = '#8ee0ff';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-10, 8);
      ctx.lineTo(-6, 0);
      ctx.lineTo(-10, -8);
      ctx.closePath();
      ctx.stroke();
      if (pose.thrusting) {
        ctx.strokeStyle = '#cfeefb';
        ctx.shadowColor = '#cfeefb';
        ctx.beginPath();
        ctx.moveTo(-6, 4);
        ctx.lineTo(-14, 0);
        ctx.lineTo(-6, -4);
        ctx.stroke();
      }
      ctx.restore();
    } else if (pose && !pose.alive) {
      ctx.save();
      ctx.translate(pose.x * sx, pose.y * sy);
      ctx.strokeStyle = '#ff5050';
      ctx.shadowColor = '#ff5050';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-8, -8); ctx.lineTo(8, 8);
      ctx.moveTo(8, -8); ctx.lineTo(-8, 8);
      ctx.stroke();
      ctx.restore();
    }
    // pose === null on v1 (score-only) -- canvas stays starfield.

    liveScore.textContent = ghostScoreAt(ghost, playheadMs).toLocaleString();
    const pct = Math.min(100, Math.max(0, (playheadMs / Math.max(1, ghost.durationMs)) * 100));
    progressFill.style.width = `${pct}%`;
    timeLabel.textContent = `${formatTime(playheadMs)} / ${formatTime(ghost.durationMs)}`;
  };

  const tick = (now: number): void => {
    if (cancelled || !ghost) return;
    if (lastFrame === 0) lastFrame = now;
    const dt = now - lastFrame;
    lastFrame = now;
    playheadMs += dt * speed;
    if (playheadMs >= ghost.durationMs) {
      if (looped) {
        playheadMs = 0;
      } else {
        playheadMs = ghost.durationMs;
        drawFrame();
        status.textContent = 'End of replay. SPACE to loop, CLOSE to exit.';
        rafId = null;
        return;
      }
    }
    drawFrame();
    rafId = requestAnimationFrame(tick);
  };

  void (async () => {
    const result = await fetchGhostByScoreEventId(input.scoreEventId).catch(() => null);
    if (cancelled) return;
    if (!result) {
      status.textContent = 'No replay event found for this run.';
      return;
    }
    ghost = result;
    if (!ghost.poseSamples || ghost.poseSamples.length === 0) {
      status.textContent = 'Score-only replay (v1 ghost · no ship pose).';
    } else {
      const lengthSec = (ghost.durationMs / 1000).toFixed(0);
      status.textContent = `Live · ${lengthSec}s @ ${ghost.fps}Hz pose · SPACE loops, ${speed}× default`;
    }
    rafId = requestAnimationFrame(tick);
  })();
}

function renderLeaderboardBlock(parent: HTMLElement, list: ReturnType<typeof getLocalHighScores>, title: string, max = 5, onReplayClose?: () => void): void {
  const block = el('div', { className: 'leaderboard-block', parent });
  el('p', { className: 'leaderboard-title', parent: block, text: title });
  const table = el('div', { className: 'leaderboard-table', parent: block });
  list.slice(0, max).forEach((entry, i) => {
    // When the entry has a published kind 30762 score event id, the row is
    // clickable -- click anywhere on it to fetch the matching ghost (kind
    // 30763) and play it back in the replay theatre. Local-only entries
    // (no eventId) stay non-interactive.
    const replayable = !!entry.eventId;
    const cls = (base: string): string => replayable ? `${base} replay-row` : base;
    const rank = el('div', { className: cls('rank'), parent: table, text: String(i + 1).padStart(2, '0') });
    const name = el('div', { className: cls('name'), parent: table, text: entry.name });
    const score = el('div', { className: cls('score'), parent: table, text: String(entry.score).padStart(6, '0') });
    const sats = el('div', { className: cls('sats'), parent: table, text: entry.sats > 0 ? `₿ ${entry.sats}` : '' });
    if (replayable && entry.eventId && onReplayClose) {
      const eventId = entry.eventId;
      const onClick = (): void => {
        renderReplayTheatre({
          scoreEventId: eventId,
          displayName: entry.name,
          score: entry.score,
          wave: entry.wave,
          sats: entry.sats,
          onClose: onReplayClose,
        });
      };
      for (const cell of [rank, name, score, sats]) {
        cell.setAttribute('data-event-id', eventId);
        cell.addEventListener('click', onClick);
      }
    }
  });
}

/**
 * Tier badge: small chip showing the player's WoT/NIP-05 tier, lifetime
 * progress against their cap, and an upgrade hint when they're below the
 * top. Lazy — fetches /api/player and renders into the same parent so the
 * session panel can call it once and forget.
 */
function renderTierBadge(parent: HTMLElement, pubkey: string): void {
  const wrap = el('div', { parent });
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:2px;margin:6px 0 0';

  const chip = el('p', { parent: wrap, text: 'Loading tier…' });
  chip.style.cssText =
    'font-size:0.78rem;letter-spacing:0.08em;margin:0;color:rgba(180,180,180,0.7)';

  const upgrade = el('p', { parent: wrap });
  upgrade.style.cssText =
    'font-size:0.72rem;color:rgba(180,180,180,0.55);margin:0;text-align:center;max-width:340px;line-height:1.4';

  void fetchPlayer(pubkey).then((p) => {
    if (!wrap.isConnected) return;
    if (!p) {
      chip.textContent = 'Tier unavailable';
      upgrade.textContent = '';
      return;
    }
    const colour: Record<PlayerTier, string> = {
      anon: 'rgba(180,180,180,0.85)',
      nip05: '#5b9dff',
      close: '#b48cff',
      verified: '#58ff58',
    };
    const label: Record<PlayerTier, string> = {
      anon: 'ANON',
      nip05: 'NIP-05',
      close: 'CLOSE',
      verified: 'VERIFIED',
    };
    const earned = p.lifetime_paid_sats.toLocaleString();
    const cap = p.lifetime_cap_sats.toLocaleString();
    chip.textContent = `${label[p.tier]} · ${earned}/${cap} sats`;
    chip.style.color = colour[p.tier];

    // Ironclad skin: unlocks once the player crosses the lifetime-sats
    // threshold. Detection lives here because /api/player is the canonical
    // source for that figure. markSkinUnlocked is idempotent so this is a
    // no-op once the unlock has landed; the publish path below catches it.
    if (p.lifetime_paid_sats >= 100_000) markSkinUnlocked('ironclad');

    if (p.tier === 'anon') {
      upgrade.textContent =
        'Set NIP-05 in your profile to lift your cap to £5. Get followed by the dev for £20.';
    } else if (p.tier === 'nip05') {
      upgrade.textContent =
        '2-hop in the dev’s WoT lifts to £10. Direct follow lifts to £20.';
    } else if (p.tier === 'close') {
      upgrade.textContent = 'A direct follow from the dev lifts to £20.';
    } else {
      upgrade.textContent = '';
    }
  });
}

function renderSessionPanel(parent: HTMLElement, state: GameState): void {
  parent.innerHTML = '';
  if (state.session) {
    const pubkey = state.session.pubkey;
    const method = state.session.method;
    // Use cached profile immediately if present, then asynchronously refresh
    const cached = state.profile ?? getCachedProfile(pubkey);
    if (cached && !state.profile) state.profile = cached;
    const renderName = (): void => {
      const name = bestName(state.profile, pubkey);
      const identityRow = parent.querySelector<HTMLElement>('.session-identity');
      if (identityRow) {
        identityRow.innerHTML = '';
        if (state.profile?.picture) {
          const img = document.createElement('img');
          img.src = state.profile.picture;
          img.alt = '';
          img.style.cssText = 'width:32px;height:32px;border-radius:50%;border:1px solid rgba(255,216,74,0.5);object-fit:cover;';
          img.onerror = () => { img.style.display = 'none'; };
          identityRow.appendChild(img);
        }
        const text = document.createElement('div');
        text.innerHTML = `Locked to <span style="color:var(--hud-yellow);font-weight:bold;">${escapeHtml(name)}</span> via <span style="color:var(--hud-blue)">${method}</span>`;
        identityRow.appendChild(text);
      }
    };
    const identity = el('div', { parent });
    identity.className = 'session-identity';
    identity.style.cssText = 'display:flex;gap:10px;align-items:center;justify-content:center;';
    renderName();
    if (!state.profile) {
      void fetchProfile(pubkey).then(p => {
        if (p) { state.profile = p; renderName(); }
      });
    }
    if (!state.session.signer.capabilities.canSignEvents) {
      const note = el('p', { parent, text: 'Auth-only. Add bark or bunker to publish.' });
      note.style.fontSize = '0.85rem';
      note.style.color = 'rgba(255,200,100,0.8)';
    }
    renderTierBadge(parent, pubkey);
    const row = el('div', { className: 'menu-row', parent });
    const out = el('button', { className: 'menu-btn secondary', parent: row, text: 'EJECT' });
    let ejecting = false;
    const doEject = async (): Promise<void> => {
      if (ejecting) return;
      ejecting = true;
      try {
        await auth.signOut(state.session);
      } catch { /* ignore */ }
      state.session = null;
      state.profile = null;
      ejecting = false;
      renderSessionPanel(parent, state);
    };
    out.addEventListener('click', () => { void doEject(); });
    out.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse') void doEject();
    });
  } else {
    el('p', { parent, text: 'Sign in with Nostr. Stake your name.' });
    const row = el('div', { className: 'menu-row', parent });
    const inBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SIGN IN WITH NOSTR' });
    const status = el('p', { parent });
    status.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);min-height:1em;margin:0;letter-spacing:0.04em;';
    let signing = false;
    const doSignIn = async (): Promise<void> => {
      if (signing) return;
      signing = true;
      // Set visible feedback FIRST so the player sees their tap registered
      // even if audio unlock or the signer call hangs or throws downstream.
      status.textContent = 'Connecting…';
      status.style.color = 'rgba(180,140,255,0.85)';
      // Audio unlock is fire-and-forget — a thrown error from a half-blocked
      // AudioContext on iOS PWA mode must not kill the sign-in path.
      try { void audio.unlockAudio(); } catch { /* ignore */ }
      let elapsed = 0;
      const ticker = window.setInterval(() => {
        elapsed += 1;
        status.textContent = `Connecting to your signer (${elapsed}s)…`;
      }, 1000);
      try {
        const session = await auth.signIn();
        if (session) {
          status.textContent = '';
          state.session = session;
          renderSessionPanel(parent, state);
        } else {
          status.textContent = 'No signer attached. Try a NIP-07 extension or your bunker URI.';
          status.style.color = '#ff8a3a';
        }
      } catch (err) {
        status.textContent = err instanceof auth.SignInTimeoutError
          ? `Timeout — ${err.message}`
          : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`;
        status.style.color = '#ff5050';
      } finally {
        window.clearInterval(ticker);
        signing = false;
      }
    };
    inBtn.addEventListener('click', () => { void doSignIn(); });
    // Touch fallback. body's `touch-action: none` cascade plus the overlay's
    // `pan-y` can occasionally swallow click events on iOS/Android when a
    // gesture starts as a tap and the browser reclassifies it mid-flight.
    // pointerup fires from the same gesture and is more reliable. The
    // `signing` flag dedupes the (rare) case where both events land.
    inBtn.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse') void doSignIn();
    });
    // Pressing IGNITE without signing in IS the guest path — no separate
    // GUEST DRIFT button needed. The session-status hint covers it.
    const hint = el('p', { parent, text: 'Or ignite as a guest — score-only, no sats.' });
    hint.style.fontSize = '0.85rem';
    hint.style.color = 'rgba(180,140,255,0.7)';
    hint.style.marginTop = '6px';
  }
}

// ── Music player (secret) ────────────────────────────────────────────────────

/**
 * Hidden music-player easter egg. Reached by long-pressing the title logo.
 * Lists every campaign track with a play button that crossfades to it.
 * The currently-playing track shows a pulsing ▶ glyph. BACK restores the
 * normal title music via musicForceRefresh — the game loop's next tick
 * resolves 'pallasite-idle' from the title phase and crossfades back.
 */
function renderMusicPlayer(state: GameState, onBack: () => void): void {
  void state;
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  el('h2', { parent: overlay, text: 'PALLASITE TRACKS' });
  const sub = el('p', { parent: overlay, text: 'Drift through the score.' });
  sub.style.cssText = 'font-size:0.95rem;letter-spacing:0.2em;color:var(--hud-yellow);margin:-12px 0 6px;';

  // Spectral analyser, sticky at the top of the overlay so it stays in
  // view while the user scrolls through the track list. Log-scale bands
  // give bass and treble equal visual weight, gradient fill (green→yellow
  // →red) plus peak-hold caps with decay echo classic VU meters, strong
  // bloom on bar tops makes the bass kicks read.
  const vizSticky = el('div', { parent: overlay });
  vizSticky.style.cssText = [
    'position:sticky', 'top:-8px',  // -8px so the rounded corners overlap the overlay padding
    'z-index:5',
    'width:100%', 'max-width:480px',
    'padding:8px 0',
    'background:linear-gradient(180deg, rgba(0,0,0,0.85), rgba(0,0,0,0.55))',
    'backdrop-filter:blur(6px)',
    'border-radius:10px',
    'display:flex', 'justify-content:center',
  ].join(';');
  const canvas = el('canvas', { parent: vizSticky, attrs: { width: '960', height: '360' } }) as HTMLCanvasElement;
  canvas.style.cssText = 'width:100%;max-width:460px;height:172px;border-radius:6px;background:radial-gradient(ellipse at 50% 100%, rgba(180,140,255,0.18), rgba(0,0,0,0.7));';

  const BAR_COUNT = 96;
  const peaks = new Float32Array(BAR_COUNT);
  const smoothed = new Float32Array(BAR_COUNT);  // smoothed bar values, fluid rise/fall
  const PEAK_DECAY = 0.014;
  const FALL_RATE = 0.045;     // how fast bars fall when freq drops (gravity)
  let bgPulse = 0;
  let flashAmp = 0;            // bass-kick driven full-canvas flash
  let prevBass = 0;
  type Spark = { x: number; y: number; vx: number; vy: number; life: number; hue: number };
  const sparks: Spark[] = [];

  const drawViz = (): void => {
    if (!document.body.contains(canvas)) return;
    const analyser = getMusicAnalyser();
    const cctx = canvas.getContext('2d');
    if (!cctx) return;
    const bins = analyser.frequencyBinCount;
    const freq = new Uint8Array(bins);
    const time = new Uint8Array(analyser.fftSize);
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(time);
    const w = canvas.width;
    const h = canvas.height;
    const baseline = h * 0.78;  // bars stand on this line; mirror below

    // Bass envelope. Detect kicks via positive delta to drive the flash.
    let bassAcc = 0;
    for (let i = 0; i < 6; i++) bassAcc += freq[i];
    const bass = bassAcc / 6 / 255;
    const bassDelta = Math.max(0, bass - prevBass);
    prevBass = bass;
    if (bassDelta > 0.06) flashAmp = Math.min(1, flashAmp + bassDelta * 1.6);
    flashAmp *= 0.86;
    bgPulse = bgPulse * 0.83 + bass * 0.17;

    cctx.clearRect(0, 0, w, h);

    // Background — radial gradient that pulses with bass; topped by a
    // brief full-canvas flash on each kick.
    const bgGrad = cctx.createRadialGradient(w * 0.5, baseline, h * 0.05, w * 0.5, baseline, h * (0.7 + bgPulse * 0.6));
    bgGrad.addColorStop(0, `rgba(255, 100, 200, ${0.07 + bgPulse * 0.22})`);
    bgGrad.addColorStop(0.55, `rgba(120, 90, 255, ${0.05 + bgPulse * 0.12})`);
    bgGrad.addColorStop(1, 'rgba(0,0,0,0)');
    cctx.fillStyle = bgGrad;
    cctx.fillRect(0, 0, w, h);
    if (flashAmp > 0.02) {
      cctx.fillStyle = `rgba(255, 255, 255, ${flashAmp * 0.18})`;
      cctx.fillRect(0, 0, w, h);
    }

    // Vertical bar gradient — green→yellow→red top-up.
    const barGrad = cctx.createLinearGradient(0, baseline, 0, 0);
    barGrad.addColorStop(0.00, '#3afc7c');
    barGrad.addColorStop(0.45, '#ffd84a');
    barGrad.addColorStop(0.78, '#ff8a3a');
    barGrad.addColorStop(1.00, '#ff4858');

    const gap = 2;
    const barW = (w - gap * (BAR_COUNT + 1)) / BAR_COUNT;
    const usableBins = Math.floor(bins * 0.82);

    for (let i = 0; i < BAR_COUNT; i++) {
      // Log-scale band mapping for equal-weight bass/mid/treble.
      const t0 = i / BAR_COUNT;
      const t1 = (i + 1) / BAR_COUNT;
      const lo = Math.floor(Math.pow(t0, 2.2) * usableBins);
      const hi = Math.max(lo + 1, Math.floor(Math.pow(t1, 2.2) * usableBins));
      let acc = 0;
      for (let j = lo; j < hi; j++) acc += freq[j];
      const raw = (acc / (hi - lo)) / 255;
      const eased = Math.pow(raw, 0.78);

      // Smooth fall — bars rise instantly to new peaks, decay back at FALL_RATE.
      if (eased > smoothed[i]) smoothed[i] = eased;
      else smoothed[i] = Math.max(0, smoothed[i] - FALL_RATE);
      const v = smoothed[i];

      // Peak hold cap.
      if (v > peaks[i]) peaks[i] = v;
      else peaks[i] = Math.max(0, peaks[i] - PEAK_DECAY);

      const x = gap + i * (barW + gap);
      const barH = v * (baseline - 6);
      const y = baseline - barH;

      // Main bar.
      cctx.shadowColor = '#ff8a3a';
      cctx.shadowBlur = 14 + v * 26;
      cctx.fillStyle = barGrad;
      cctx.fillRect(x, y, barW, barH);

      // Mirror reflection — same gradient flipped, alpha fades to 0.
      const refH = barH * 0.55;
      const refGrad = cctx.createLinearGradient(0, baseline, 0, baseline + refH);
      refGrad.addColorStop(0, 'rgba(255, 138, 58, 0.45)');
      refGrad.addColorStop(1, 'rgba(255, 138, 58, 0)');
      cctx.shadowBlur = 0;
      cctx.fillStyle = refGrad;
      cctx.fillRect(x, baseline + 1, barW, refH);

      // Peak-hold cap — bright thin bar that lingers above as the bar falls.
      const peakY = baseline - peaks[i] * (baseline - 6) - 2;
      cctx.shadowBlur = 14;
      cctx.shadowColor = '#fff5d8';
      cctx.fillStyle = '#fff5d8';
      cctx.fillRect(x, peakY, barW, 2);

      // Spark burst on a fresh peak (raw amplitude high AND newly so).
      if (raw > 0.78 && Math.random() < 0.18) {
        const cx = x + barW / 2;
        const cy = peakY;
        for (let k = 0; k < 2; k++) {
          sparks.push({
            x: cx, y: cy,
            vx: (Math.random() - 0.5) * 2.4,
            vy: -1.5 - Math.random() * 1.8,
            life: 1,
            hue: 30 + Math.random() * 30,
          });
        }
      }
    }
    cctx.shadowBlur = 0;

    // Sparks — tiny dots flying upward on peak bursts.
    for (const s of sparks) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.04;            // light gravity
      s.life -= 0.025;
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      if (sparks[i].life <= 0) sparks.splice(i, 1);
    }
    for (const s of sparks) {
      cctx.fillStyle = `hsla(${s.hue}, 100%, 70%, ${s.life})`;
      cctx.shadowColor = `hsla(${s.hue}, 100%, 80%, ${s.life})`;
      cctx.shadowBlur = 8;
      cctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
    cctx.shadowBlur = 0;

    // Time-domain waveform — bright cyan line scrolls across at the
    // baseline, distorted by bass. Reads as the music's heartbeat.
    cctx.lineWidth = 1.6;
    cctx.strokeStyle = `rgba(120, 240, 255, ${0.55 + bass * 0.45})`;
    cctx.shadowColor = '#7ff0ff';
    cctx.shadowBlur = 12 + bass * 18;
    cctx.beginPath();
    const tStride = Math.max(1, Math.floor(time.length / w));
    for (let x = 0; x < w; x++) {
      const idx = Math.min(time.length - 1, x * tStride);
      const sample = (time[idx] - 128) / 128;
      const y = baseline + sample * (10 + bass * 28);
      if (x === 0) cctx.moveTo(x, y);
      else cctx.lineTo(x, y);
    }
    cctx.stroke();
    cctx.shadowBlur = 0;

    // Baseline rule — anchors the bars + mirror.
    cctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
    cctx.fillRect(0, baseline, w, 1);

    requestAnimationFrame(drawViz);
  };
  requestAnimationFrame(drawViz);

  const list = el('div', { parent: overlay });
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;max-width:420px;';

  const rows: Array<{ id: string; el: HTMLElement; glyph: HTMLElement }> = [];
  const paint = (): void => {
    const active = currentTrackId();
    for (const r of rows) {
      const isActive = r.id === active;
      r.el.style.borderColor = isActive ? 'rgba(255,216,74,0.8)' : 'rgba(180,140,255,0.3)';
      r.el.style.background = isActive ? 'rgba(255,216,74,0.08)' : 'rgba(180,140,255,0.04)';
      r.glyph.textContent = isActive ? '▶' : '·';
      r.glyph.style.color = isActive ? '#ffd84a' : 'rgba(180,140,255,0.6)';
    }
  };

  for (const t of listTracks()) {
    const row = el('div', { parent: list });
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:14px',
      'padding:10px 14px', 'border-radius:8px',
      'border:1px solid rgba(180,140,255,0.3)',
      'background:rgba(180,140,255,0.04)',
      'cursor:pointer', '-webkit-tap-highlight-color:transparent',
      'touch-action:manipulation',
    ].join(';');

    const glyph = el('span', { parent: row, text: '·' });
    glyph.style.cssText = 'font-size:1.2rem;width:1.6rem;text-align:center;color:rgba(180,140,255,0.6);';

    const text = el('div', { parent: row });
    text.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:2px;text-align:left;';
    const label = el('span', { parent: text, text: t.label });
    label.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:1.1rem;letter-spacing:0.18em;color:#fff5d8;";
    const hint = el('span', { parent: text, text: t.hint });
    hint.style.cssText = 'font-size:0.72rem;letter-spacing:0.06em;color:rgba(220,210,255,0.6);';

    onTap(row, () => {
      void audio.unlockAudio();
      musicPreviewPlay(t.id);
      paint();
    });

    rows.push({ id: t.id, el: row, glyph });
  }
  paint();

  const buttons = el('div', { className: 'menu-row', parent: overlay });
  const stop = el('button', { className: 'menu-btn secondary', parent: buttons, text: 'STOP' });
  onTap(stop, () => { musicStop(250); paint(); });
  const back = el('button', { className: 'menu-btn', parent: buttons, text: 'BACK' });
  onTap(back, () => {
    // Restore state-driven music. Force-refresh invalidates the memo so the
    // next musicSetTrackForState tick (the game loop runs every frame) will
    // re-resolve the current phase and crossfade back to pallasite-idle.
    musicForceRefresh();
    onBack();
  });
}

// ── Pause overlay ─────────────────────────────────────────────────────────────

export function renderPause(state?: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  el('h2', { parent: overlay, text: 'PAUSED' });
  const row = el('div', { className: 'menu-row', parent: overlay });
  const resume = el('button', { className: 'menu-btn', parent: row, text: 'RESUME' });
  resume.addEventListener('click', () => onResumeCb?.());
  // Focus RESUME so a single Enter press un-pauses without arrow-key navigation.
  // setTimeout(0) defers past the keydown that opened the pause menu — otherwise
  // the focus call races the same event and the button doesn't take focus.
  setTimeout(() => resume.focus(), 0);
  const settings = el('button', { className: 'menu-btn secondary', parent: row, text: 'SETTINGS' });
  settings.addEventListener('click', () => renderSettings(() => renderPause(state)));
  if (state) {
    const quit = el('button', { className: 'menu-btn secondary', parent: row, text: 'QUIT TO TITLE' });
    quit.addEventListener('click', () => {
      // Abandon the run — drop straight to title without going through gameover.
      audio.thrustOff();
      audio.ufoSirenStop();
      audio.stopHeartbeat();
      audio.stopAmbient();
      audio.setMusicDuck(1);
      // Wipe entities — leftover asteroids/debris/particles otherwise
      // bleed through the title overlay's translucent backdrop.
      clearEntitiesForTitle(state);
      state.phase = 'title';
      state.phaseStart = performance.now();
      renderTitle(state);
    });
  }

  const hint = el('div', { className: 'kbhint', parent: root });
  hint.innerHTML = '<kbd>P</kbd> resume &nbsp;·&nbsp; <kbd>ESC</kbd> resume &nbsp;·&nbsp; <kbd>M</kbd> mute';
}

// ── How to Play overlay ──────────────────────────────────────────────────────

/**
 * Player-facing instructions. Voice-guide compliant: physics + verbs, no
 * marketing fluff, British English. Cheats deliberately omitted (they're
 * easter eggs that lose meaning if telegraphed).
 */
export function renderHowToPlay(onBack: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  el('h2', { parent: overlay, text: 'HOW TO PLAY' });

  const tagline = el('p', { parent: overlay, text: 'Drift the orbit. Shoot rocks. Survive 25 waves.' });
  tagline.style.cssText = 'font-size:1rem;color:var(--hud-yellow);letter-spacing:0.18em;text-shadow:0 0 8px rgba(255,216,74,0.45);margin:0 0 6px;';

  const panel = el('div', { parent: overlay });
  panel.style.cssText = 'display:flex;flex-direction:column;gap:18px;align-items:stretch;max-width:540px;text-align:left;';

  type Row = readonly [string, string] | readonly [string, string, HTMLCanvasElement];
  function section(title: string, lines: ReadonlyArray<Row>): void {
    const block = el('div', { parent: panel });
    block.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const h = el('p', { parent: block, text: title });
    h.style.cssText = 'font-size:0.78rem;letter-spacing:0.32em;color:rgba(180,140,255,0.95);margin:0;';
    const grid = el('div', { parent: block });
    // Three columns now: preview slot (44px, kept consistent across all rows
    // so text aligns even when most rows have no preview) | key | value.
    grid.style.cssText = 'display:grid;grid-template-columns:44px max-content 1fr;gap:6px 14px;font-size:0.92rem;color:rgba(220,210,255,0.92);align-items:center;';
    for (const row of lines) {
      const previewCell = el('div', { parent: grid });
      previewCell.style.cssText = 'display:flex;align-items:center;justify-content:center;';
      if (row.length === 3) previewCell.appendChild(row[2]);
      const key = el('span', { parent: grid, text: row[0] });
      key.style.cssText = 'color:#5b9dff;letter-spacing:0.08em;font-weight:bold;';
      el('span', { parent: grid, text: row[1] });
    }
  }

  section('CONTROLS', [
    ['← →', 'Rotate ship'],
    ['↑', 'Thrust forward'],
    ['Space', 'Fire'],
    ['↓', 'Shield (timed burst)'],
    ['↓ ↓ or Shift / H', 'Hyperspace — risky'],
    ['P / Esc', 'Pause'],
    ['M', 'Mute audio'],
  ]);

  section('THE GOAL', [
    ['Waves 1-24', 'Each named after a real pallasite meteorite'],
    ['Wave 25', 'Event Horizon — the boss arena'],
    ['Dust shards', 'Tinted to the source rock · score reward', dustPreview('iron')],
    ['Sat coins', '₿ — real sats when signed in', satCoinPreview()],
    ['Lives', 'Lose all and the run ends · extra life every 10,000 score'],
  ]);

  section('WHAT TO WATCH FOR', [
    ['Combo chain', 'Quick consecutive kills stack a multiplier — watch the chip'],
    ['Hyperspace', 'Re-emerges anywhere, but ~6% chance the warp goes wrong'],
    ['Mines', 'From wave 8 — gravity wells; takes a few hits', minePreview()],
    ['Snipers', 'From wave 10 — slow, accurate, lethal', sniperPreview()],
    ['Stony rocks', 'The baseline silicate — 1 hit, modest payout', asteroidPreview('stony')],
    ['Iron rocks', 'Two hits to crack — orange shards, 1.6× score', asteroidPreview('iron')],
    ['Chondrite rocks', 'Fragile — splits into three on break', asteroidPreview('chondrite')],
    ['Pallasite rocks', 'Rare jackpot — gold shards, 2× score, sat-guaranteed', asteroidPreview('pallasite')],
  ]);

  section('POWERUPS — drop from UFO kills', [
    ['RAPID', 'Faster fire cadence for 8 seconds', powerupPreview('rapid')],
    ['×2 SATS', 'Doubles sat value of dropped coins for 12 seconds', powerupPreview('satboost')],
    ['TRIDENT', 'Three-bullet fan instead of single shot · 6 seconds', powerupPreview('trident')],
    ['MAGNET', 'Pulls coins + dust to your ship across the screen · 8 seconds', powerupPreview('magnet')],
    ['NOVA', 'One-shot — destroys every asteroid on screen · score-only', powerupPreview('nova')],
  ]);

  section('SIGN IN WITH NOSTR', [
    ['Optional', 'Guests play for score only · sign in to earn real sats and publish to leaderboards'],
    ['Daily run', 'Same seed for everyone today · clean leaderboard'],
  ]);

  const row = el('div', { className: 'menu-row', parent: overlay });
  const back = el('button', { className: 'menu-btn', parent: row, text: 'BACK' });
  back.addEventListener('click', onBack);
}

// ── Settings overlay ─────────────────────────────────────────────────────────

/**
 * Audio mix panel — master / music / SFX sliders + mute. Reachable from title
 * and pause; `onBack` re-renders whichever screen opened it.
 */
/**
 * Renders a small ship preview into a fixed-size canvas. Used by the skins
 * panel so each skin card shows the actual silhouette + thrust palette the
 * player will see in-game, not a coloured swatch.
 */
function paintShipPreview(canvas: HTMLCanvasElement, skin: SkinDef, locked: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(1.4, 1.4);
  ctx.globalAlpha = locked ? 0.35 : 1;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = skin.palette.ship;
  ctx.shadowColor = skin.palette.shipShadow;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.stroke();
  // Static thrust flame so the player sees the full palette.
  ctx.strokeStyle = skin.palette.thrust;
  ctx.shadowColor = skin.palette.thrustShadow;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(-6, 4);
  ctx.lineTo(-14, 0);
  ctx.lineTo(-6, -4);
  ctx.stroke();
  ctx.restore();
}

/**
 * Skins section in the settings overlay. Shows every catalogue entry as a
 * card with a live ship preview, label, description, and either an
 * "ACTIVE" badge (unlocked + selected), a "SELECT" button (unlocked +
 * not selected), or the unlock hint (still locked).
 */
function renderSkinsPanel(parent: HTMLElement): void {
  const heading = el('p', { parent, text: 'SHIPS' });
  heading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:8px 0 -10px;';

  const grid = el('div', { parent });
  grid.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;justify-content:center;align-items:stretch;';

  const cards: Array<{ skin: SkinDef; el: HTMLElement; preview: HTMLCanvasElement; cta: HTMLElement }> = [];

  for (const skin of SKINS) {
    const card = el('div', { parent: grid });
    card.style.cssText = [
      'display:flex', 'flex-direction:column', 'align-items:center', 'gap:6px',
      'padding:12px 14px', 'border-radius:10px', 'min-width:160px',
      'background:rgba(180,140,255,0.04)', 'border:1px solid rgba(180,140,255,0.25)',
    ].join(';');

    const preview = el('canvas', { parent: card, attrs: { width: '110', height: '60' } });
    preview.style.cssText = 'background:#02050d;border-radius:6px;width:110px;height:60px;';

    const label = el('p', { parent: card, text: skin.label });
    label.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:1.1rem;letter-spacing:0.18em;color:#fff5d8;margin:0;";

    const desc = el('p', { parent: card, text: skin.description });
    desc.style.cssText = 'font-size:0.7rem;letter-spacing:0.04em;color:rgba(220,210,255,0.75);margin:0;text-align:center;line-height:1.4;max-width:160px;';

    const cta = el('div', { parent: card });
    cta.style.cssText = 'min-height:30px;display:flex;align-items:center;justify-content:center;';

    cards.push({ skin, el: card, preview, cta });
  }

  function paintAll(): void {
    const activeId = getActiveSkinId();
    for (const { skin, el: card, preview, cta } of cards) {
      const unlocked = isSkinUnlocked(skin.id);
      paintShipPreview(preview, skin, !unlocked);

      cta.innerHTML = '';
      if (!unlocked) {
        card.style.borderColor = 'rgba(180,140,255,0.18)';
        const hint = el('p', { parent: cta, text: skin.unlockHint });
        hint.style.cssText = 'font-size:0.72rem;color:rgba(180,140,255,0.65);letter-spacing:0.06em;margin:0;text-align:center;';
      } else if (skin.id === activeId) {
        card.style.borderColor = 'rgba(255,216,74,0.65)';
        const badge = el('p', { parent: cta, text: 'ACTIVE' });
        badge.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:0.95rem;letter-spacing:0.18em;color:#ffd84a;margin:0;text-shadow:0 0 6px rgba(255,216,74,0.45);";
      } else {
        card.style.borderColor = 'rgba(91,255,140,0.45)';
        const btn = el('button', { parent: cta, text: 'SELECT' });
        btn.style.cssText = [
          'background:transparent', 'border:1px solid rgba(91,255,140,0.6)',
          'color:#7fffb0', "font-family:'VT323',ui-monospace,monospace",
          'font-size:0.85rem', 'letter-spacing:0.12em', 'padding:4px 14px',
          'cursor:pointer', 'border-radius:6px',
        ].join(';');
        btn.addEventListener('click', () => {
          if (setActiveSkinId(skin.id)) paintAll();
        });
      }
    }
  }
  paintAll();
}

export function renderSettings(onBack: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  el('h2', { parent: overlay, text: 'SETTINGS' });
  const sub = el('p', { parent: overlay, text: 'AUDIO' });
  sub.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:0 0 -8px;';

  const panel = el('div', { parent: overlay });
  panel.style.cssText = 'display:flex;flex-direction:column;gap:18px;align-items:stretch;min-width:340px;margin-top:6px;';

  function row(label: string, get: () => number, set: (v: number) => void): { input: HTMLInputElement; readout: HTMLElement } {
    const wrap = el('div', { parent: panel });
    wrap.style.cssText = 'display:grid;grid-template-columns:108px 1fr 56px;gap:14px;align-items:center;';
    const lab = el('label', { parent: wrap, text: label });
    lab.style.cssText = 'font-size:0.95rem;color:rgba(180,140,255,0.95);letter-spacing:0.22em;';
    const input = el('input', { parent: wrap, attrs: { type: 'range', min: '0', max: '100', step: '1' } }) as HTMLInputElement;
    input.value = String(Math.round(get() * 100));
    input.style.cssText = 'accent-color:#ffd84a;width:100%;';
    const readout = el('div', { parent: wrap, text: input.value });
    readout.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:1.1rem;color:#ffd84a;text-align:right;letter-spacing:0.08em;";
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10) / 100;
      set(v);
      readout.textContent = input.value;
    });
    return { input, readout };
  }

  row('MASTER', audio.getMasterVolume, audio.setMasterVolume);
  const musicRow = row('MUSIC',  audio.getMusicVolume,  audio.setMusicVolume);
  row('SFX',    audio.getSfxVolume,    audio.setSfxVolume);

  // Mute toggle row
  const muteWrap = el('div', { parent: panel });
  muteWrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:14px;border-top:1px solid rgba(180,140,255,0.2);padding-top:14px;';
  const muteLab = el('span', { parent: muteWrap, text: 'MUTE ALL' });
  muteLab.style.cssText = 'font-size:0.95rem;color:rgba(180,140,255,0.95);letter-spacing:0.22em;';
  const muteBtn = el('button', { parent: muteWrap, text: audio.isMuted() ? 'ON' : 'OFF' });
  function paintMute(): void {
    const on = audio.isMuted();
    muteBtn.textContent = on ? 'ON' : 'OFF';
    muteBtn.style.cssText = [
      'background:' + (on ? 'rgba(255,80,80,0.18)' : 'transparent'),
      'border:2px solid ' + (on ? '#ff5050' : 'rgba(180,140,255,0.4)'),
      'color:' + (on ? '#ff5050' : 'rgba(220,210,255,0.85)'),
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:1rem', 'padding:6px 18px', 'letter-spacing:0.18em',
      'cursor:pointer', 'border-radius:6px', 'min-width:64px',
    ].join(';');
  }
  paintMute();
  muteBtn.addEventListener('click', () => {
    audio.setMuted(!audio.isMuted());
    paintMute();
  });

  // Quick reference for the in-game mute key
  const note = el('p', { parent: panel, text: 'Tap M in-game to toggle mute. Music ducks while paused.' });
  note.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;text-align:center;';

  // Ship skins -- earned cosmetics drawn in render.ts. Locked entries show
  // their unlock criterion; unlocked ones are click-to-select.
  renderSkinsPanel(overlay);

  // Touch input mode — only meaningful on touch devices but harmless to show
  // on desktop (it just doesn't apply until a touch event reveals controls).
  const touchHeading = el('p', { parent: overlay, text: 'TOUCH INPUT' });
  touchHeading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:6px 0 -10px;';

  const touchPanel = el('div', { parent: overlay });
  touchPanel.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;';
  const inputOpts: ReadonlyArray<{ value: TouchInputMode; label: string; hint: string }> = [
    { value: 'buttons',  label: 'BUTTONS',  hint: 'Authentic 1979 cabinet — discrete d-pad + fire' },
    { value: 'joystick', label: 'JOYSTICK', hint: 'Point + go — stick angle = heading, push to thrust, tap to fire' },
  ];
  const inputHint = el('p', { parent: overlay });
  inputHint.style.cssText = 'font-size:0.75rem;color:rgba(180,140,255,0.65);letter-spacing:0.04em;margin:0;height:1em;text-align:center;';

  const inputBtns = new Map<TouchInputMode, HTMLButtonElement>();
  function paintInput(): void {
    const cur = getTouchMode();
    for (const [v, btn] of inputBtns) {
      const on = v === cur;
      btn.style.cssText = [
        'background:' + (on ? 'rgba(91,157,255,0.22)' : 'transparent'),
        'border:2px solid ' + (on ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (on ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:1rem', 'padding:6px 18px', 'letter-spacing:0.18em',
        'cursor:pointer', 'border-radius:6px', 'min-width:104px',
        on ? 'box-shadow:0 0 12px rgba(91,157,255,0.35);text-shadow:0 0 6px rgba(91,157,255,0.6)' : '',
      ].filter(Boolean).join(';');
    }
    inputHint.textContent = inputOpts.find(o => o.value === cur)?.hint ?? '';
  }
  for (const opt of inputOpts) {
    const btn = el('button', { parent: touchPanel, text: opt.label });
    inputBtns.set(opt.value, btn);
    btn.addEventListener('click', () => { setTouchMode(opt.value); paintInput(); });
  }
  paintInput();

  // Display mode — retro pixelated 4:3 vs smooth uncapped modern
  const displayHeading = el('p', { parent: overlay, text: 'DISPLAY' });
  displayHeading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:6px 0 -10px;';

  const displayPanel = el('div', { parent: overlay });
  displayPanel.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;';
  const displayOpts: ReadonlyArray<{ value: DisplayMode; label: string; hint: string }> = [
    { value: 'retro',  label: 'RETRO',  hint: 'Pixelated 4:3 — capped at 960×720, faithful to the cabinet' },
    { value: 'modern', label: 'MODERN', hint: 'Smooth scaling — fills viewport, supersampled, sharper backgrounds' },
  ];
  const displayHint = el('p', { parent: overlay });
  displayHint.style.cssText = 'font-size:0.75rem;color:rgba(180,140,255,0.65);letter-spacing:0.04em;margin:0;height:1em;text-align:center;';
  const displayBtns = new Map<DisplayMode, HTMLButtonElement>();
  function paintDisplay(): void {
    const cur = getDisplayMode();
    for (const [v, btn] of displayBtns) {
      const on = v === cur;
      btn.style.cssText = [
        'background:' + (on ? 'rgba(91,157,255,0.22)' : 'transparent'),
        'border:2px solid ' + (on ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (on ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:1rem', 'padding:6px 18px', 'letter-spacing:0.18em',
        'cursor:pointer', 'border-radius:6px', 'min-width:104px',
        on ? 'box-shadow:0 0 12px rgba(91,157,255,0.35);text-shadow:0 0 6px rgba(91,157,255,0.6)' : '',
      ].filter(Boolean).join(';');
    }
    displayHint.textContent = displayOpts.find(o => o.value === cur)?.hint ?? '';
  }
  for (const opt of displayOpts) {
    const btn = el('button', { parent: displayPanel, text: opt.label });
    displayBtns.set(opt.value, btn);
    btn.addEventListener('click', () => {
      setDisplayMode(opt.value);
      paintDisplay();
      // Re-fit the canvas so the new mode takes effect immediately rather
      // than waiting for the next resize/orientation event.
      (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit?.();
    });
  }
  paintDisplay();

  // ── ACCESSIBILITY ───────────────────────────────────────────────────────
  // Three independent axes:
  //   reduced motion: kills shake / chromatic split / future bloom pulses.
  //     'AUTO' follows the OS prefers-reduced-motion media query.
  //   high-contrast palette: shifts the four asteroid hues into a
  //     deuteranopia/protanopia-safer set (red, blue, cyan, yellow).
  //   haptics: toggle whether navigator.vibrate fires on impact events.
  //     Hidden entirely on platforms without vibrate support (iOS Safari).
  const a11yHeading = el('p', { parent: overlay, text: 'ACCESSIBILITY' });
  a11yHeading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:6px 0 -10px;';

  const a11yPanel = el('div', { parent: overlay });
  a11yPanel.style.cssText = 'display:flex;flex-direction:column;gap:14px;align-items:stretch;min-width:340px;';

  // Reduced-motion tri-state
  const motionRow = el('div', { parent: a11yPanel });
  motionRow.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:center;';
  const motionLab = el('label', { parent: motionRow, text: 'REDUCED MOTION' });
  motionLab.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.95);letter-spacing:0.18em;';
  const motionBtnWrap = el('div', { parent: motionRow });
  motionBtnWrap.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
  const motionOpts: ReadonlyArray<{ value: ReducedMotionPref; label: string }> = [
    { value: 'auto', label: 'AUTO' },
    { value: 'on',   label: 'ON' },
    { value: 'off',  label: 'OFF' },
  ];
  const motionBtns = new Map<ReducedMotionPref, HTMLButtonElement>();
  function paintMotion(): void {
    const cur = getReducedMotionPref();
    for (const [v, btn] of motionBtns) {
      const on = v === cur;
      btn.style.cssText = [
        'background:' + (on ? 'rgba(91,157,255,0.22)' : 'transparent'),
        'border:2px solid ' + (on ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (on ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.9rem', 'padding:5px 12px', 'letter-spacing:0.16em',
        'cursor:pointer', 'border-radius:6px', 'min-width:62px',
      ].join(';');
    }
  }
  for (const opt of motionOpts) {
    const btn = el('button', { parent: motionBtnWrap, text: opt.label });
    motionBtns.set(opt.value, btn);
    btn.addEventListener('click', () => { setReducedMotionPref(opt.value); paintMotion(); });
  }
  paintMotion();

  // High-contrast palette toggle
  const paletteRow = el('div', { parent: a11yPanel });
  paletteRow.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:center;';
  const paletteLab = el('label', { parent: paletteRow, text: 'PALETTE' });
  paletteLab.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.95);letter-spacing:0.18em;';
  const paletteBtnWrap = el('div', { parent: paletteRow });
  paletteBtnWrap.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
  const paletteOpts: ReadonlyArray<{ value: ColourPalette; label: string }> = [
    { value: 'default',        label: 'DEFAULT' },
    { value: 'high-contrast',  label: 'HI-CONTRAST' },
  ];
  const paletteBtns = new Map<ColourPalette, HTMLButtonElement>();
  function paintPalette(): void {
    const cur = getPalette();
    for (const [v, btn] of paletteBtns) {
      const on = v === cur;
      btn.style.cssText = [
        'background:' + (on ? 'rgba(91,157,255,0.22)' : 'transparent'),
        'border:2px solid ' + (on ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (on ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.9rem', 'padding:5px 12px', 'letter-spacing:0.16em',
        'cursor:pointer', 'border-radius:6px', 'min-width:108px',
      ].join(';');
    }
  }
  for (const opt of paletteOpts) {
    const btn = el('button', { parent: paletteBtnWrap, text: opt.label });
    paletteBtns.set(opt.value, btn);
    btn.addEventListener('click', () => { setPalette(opt.value); paintPalette(); });
  }
  paintPalette();

  // Haptics toggle — only render on platforms where vibrate is available
  if (hapticsSupported()) {
    const hapticsRow = el('div', { parent: a11yPanel });
    hapticsRow.style.cssText = 'display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:center;';
    const hapticsLab = el('label', { parent: hapticsRow, text: 'HAPTICS' });
    hapticsLab.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.95);letter-spacing:0.18em;';
    const hapticsBtnWrap = el('div', { parent: hapticsRow });
    hapticsBtnWrap.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const hapticsBtn = el('button', { parent: hapticsBtnWrap, text: getHapticsEnabled() ? 'ON' : 'OFF' });
    function paintHaptics(): void {
      const on = getHapticsEnabled();
      hapticsBtn.textContent = on ? 'ON' : 'OFF';
      hapticsBtn.style.cssText = [
        'background:' + (on ? 'rgba(91,157,255,0.22)' : 'transparent'),
        'border:2px solid ' + (on ? '#5b9dff' : 'rgba(180,140,255,0.4)'),
        'color:' + (on ? '#5b9dff' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.9rem', 'padding:5px 12px', 'letter-spacing:0.16em',
        'cursor:pointer', 'border-radius:6px', 'min-width:62px',
      ].join(';');
    }
    paintHaptics();
    hapticsBtn.addEventListener('click', () => { setHapticsEnabled(!getHapticsEnabled()); paintHaptics(); });
  }

  // ── DATA ────────────────────────────────────────────────────────────────
  // Single destructive action — clearing the local top-10 list. Two-tap
  // confirm so a stray click doesn't blow it away. Auto-resets after 3s
  // if the second tap doesn't happen.
  const dataHeading = el('p', { parent: overlay, text: 'DATA' });
  dataHeading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:6px 0 -10px;';

  const dataPanel = el('div', { parent: overlay });
  dataPanel.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center;';

  const clearBtn = el('button', { parent: dataPanel, text: 'CLEAR LOCAL SCORES' }) as HTMLButtonElement;
  function paintClear(state: 'idle' | 'arming' | 'cleared'): void {
    const colour = state === 'cleared' ? '#58ff58' : '#ff5050';
    const fill = state === 'arming' ? 'rgba(255,80,80,0.18)'
      : state === 'cleared' ? 'rgba(88,255,88,0.12)'
      : 'transparent';
    clearBtn.style.cssText = [
      'background:' + fill,
      'border:2px solid ' + (state === 'idle' ? 'rgba(255,80,80,0.4)' : colour),
      'color:' + colour,
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:0.95rem', 'padding:6px 18px', 'letter-spacing:0.18em',
      'cursor:' + (state === 'cleared' ? 'default' : 'pointer'),
      'border-radius:6px',
    ].join(';');
    clearBtn.textContent =
      state === 'idle' ? 'CLEAR LOCAL SCORES'
      : state === 'arming' ? 'TAP AGAIN TO CONFIRM'
      : 'CLEARED';
    clearBtn.disabled = state === 'cleared';
  }
  paintClear('idle');

  let arming = false;
  let armTimer: number | null = null;
  clearBtn.addEventListener('click', () => {
    if (!arming) {
      arming = true;
      paintClear('arming');
      armTimer = window.setTimeout(() => {
        arming = false;
        paintClear('idle');
      }, 3000);
      return;
    }
    if (armTimer !== null) { clearTimeout(armTimer); armTimer = null; }
    arming = false;
    clearLocalHighScores();
    paintClear('cleared');
  });

  const dataNote = el('p', { parent: dataPanel, text: "Removes the top-10 list shown on the title screen. Doesn't touch your relays, profile cache, or any Nostr-published scores." });
  dataNote.style.cssText = 'font-size:0.7rem;color:rgba(180,140,255,0.6);letter-spacing:0.04em;margin:0;text-align:center;max-width:420px;';

  const row2 = el('div', { className: 'menu-row', parent: overlay });
  // Push the action row clear of the DISPLAY hint above so the buttons don't
  // visually clash with text. The .overlay flex gap is 28px; this adds more.
  row2.style.marginTop = '24px';
  // Open the Nostr relay editor without leaving settings
  const relayBtn = el('button', { className: 'menu-btn secondary', parent: row2, text: 'NOSTR RELAYS' });
  relayBtn.addEventListener('click', () => renderRelaySettings(() => renderSettings(onBack)));

  const back = el('button', { className: 'menu-btn', parent: row2, text: 'BACK' });
  back.addEventListener('click', onBack);

  // Bind musicRow for type checker satisfaction (keep handle in case we later want to react to external volume changes)
  void musicRow;
}

/**
 * Nostr relay editor — toggle list with add/remove. Default relays can be
 * toggled on/off but not deleted (only hidden from `active`); custom-added
 * ones can be removed entirely. Each row is a wss:// URL.
 */
export function renderRelaySettings(onBack: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  el('h2', { parent: overlay, text: 'NOSTR RELAYS' });

  const intro = el('p', { parent: overlay, text: 'Where this game publishes scores, follows, shares and zap requests. Toggle to disable, add your own, remove the ones you brought.' });
  intro.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.85);max-width:480px;margin:0;line-height:1.5;';

  const list = el('div', { parent: overlay });
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%;max-width:520px;';

  const status = el('p', { parent: overlay, text: '' });
  status.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.75);min-height:1.1em;margin:0;';

  function setStatus(text: string, colour: string): void {
    status.textContent = text;
    status.style.color = colour;
  }

  function paint(): void {
    list.innerHTML = '';
    const relays = getKnownRelays();
    if (relays.length === 0) {
      const empty = el('p', { parent: list, text: 'No relays. Add one below or RESET to defaults.' });
      empty.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.65);text-align:center;margin:8px 0;';
    }
    for (const url of relays) {
      const enabled = isRelayEnabled(url);
      const isDefault = isDefaultRelay(url);
      const row = el('div', { parent: list });
      row.style.cssText = 'display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;background:rgba(0,0,0,0.4);border:1px solid rgba(91,157,255,0.25);border-radius:8px;padding:8px 12px;';

      const toggle = el('button', { parent: row });
      toggle.setAttribute('aria-pressed', String(enabled));
      toggle.textContent = enabled ? 'ON' : 'OFF';
      toggle.style.cssText = [
        'min-width:54px',
        'padding:5px 10px', 'border-radius:14px',
        'border:2px solid ' + (enabled ? '#58ff58' : 'rgba(180,140,255,0.4)'),
        'background:' + (enabled ? 'rgba(88,255,88,0.16)' : 'transparent'),
        'color:' + (enabled ? '#58ff58' : 'rgba(220,210,255,0.65)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.85rem', 'letter-spacing:0.18em',
        'cursor:pointer',
      ].join(';');
      toggle.addEventListener('click', () => {
        setRelayEnabled(url, !enabled);
        setStatus(enabled ? `Disabled ${shortRelay(url)}` : `Enabled ${shortRelay(url)}`, '#58ff58');
        paint();
      });

      const label = el('div', { parent: row });
      label.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;text-align:left;min-width:0;';
      const urlSpan = el('span', { parent: label, text: url });
      urlSpan.style.cssText = "font-family:ui-monospace,monospace;font-size:0.82rem;color:rgba(220,210,255,0.92);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;letter-spacing:0;";
      const tag = el('span', { parent: label, text: isDefault ? 'BUNDLED' : 'CUSTOM' });
      tag.style.cssText = 'font-size:0.62rem;letter-spacing:0.2em;color:' + (isDefault ? 'rgba(91,157,255,0.7)' : 'rgba(255,138,58,0.85)') + ';margin-top:2px;';

      if (!isDefault) {
        const remove = el('button', { parent: row, text: '✕' });
        remove.setAttribute('aria-label', 'Remove relay');
        remove.style.cssText = [
          'background:transparent', 'border:none',
          'color:rgba(255,80,80,0.7)',
          "font-family:'VT323',ui-monospace,monospace",
          'font-size:1.1rem', 'cursor:pointer',
          'padding:4px 8px', 'border-radius:4px',
        ].join(';');
        remove.addEventListener('click', () => {
          removeRelay(url);
          setStatus(`Removed ${shortRelay(url)}`, '#ff8a3a');
          paint();
        });
      } else {
        // Empty cell so the grid keeps three columns aligned across rows
        el('span', { parent: row, text: '' });
      }
    }
  }

  paint();

  // Add-new row
  const addRow = el('div', { parent: overlay });
  addRow.style.cssText = 'display:flex;gap:8px;align-items:center;width:100%;max-width:520px;';
  const input = el('input', { parent: addRow, attrs: { type: 'url', placeholder: 'wss://relay.example.com' } });
  input.style.cssText = 'flex:1;background:rgba(0,0,0,0.5);border:2px solid rgba(91,157,255,0.4);color:#cfd6ff;font-family:ui-monospace,monospace;font-size:0.85rem;padding:8px 12px;border-radius:6px;letter-spacing:0;';
  const addBtn = el('button', { className: 'menu-btn secondary', parent: addRow, text: 'ADD' });
  function commit(): void {
    const result = addRelay(input.value);
    if (result) {
      input.value = '';
      setStatus(`Added relay`, '#58ff58');
      paint();
    } else {
      setStatus('Must be a valid wss:// URL', '#ff5050');
    }
  }
  addBtn.addEventListener('click', commit);
  input.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).code === 'Enter') { e.preventDefault(); commit(); }
  });

  const row = el('div', { className: 'menu-row', parent: overlay });
  const reset = el('button', { className: 'menu-btn secondary', parent: row, text: 'RESET' });
  reset.addEventListener('click', () => {
    resetRelays();
    setStatus('Restored bundled defaults.', 'rgba(180,140,255,0.85)');
    paint();
  });
  const back = el('button', { className: 'menu-btn', parent: row, text: 'BACK' });
  back.addEventListener('click', onBack);
}

function shortRelay(url: string): string {
  return url.replace(/^wss:\/\//, '').replace(/\/$/, '');
}

// ── Game over screen ──────────────────────────────────────────────────────────

/** Where would `score` rank in the local top-10? 1-indexed; ties resolve
 *  toward the older entry (the new score sits below equal existing ones). */
function predictedLocalRank(score: number): number {
  const list = getLocalHighScores();
  let higher = 0;
  for (const e of list) if (e.score >= score) higher += 1;
  return higher + 1;
}

export function renderGameOver(state: GameState): void {
  // Push the current skin unlock set to Nostr at the end of every run.
  // kind 30764 is replaceable (d="pallasite-skins") so this is idempotent
  // when nothing has changed; when something has (e.g. halo just unlocked
  // mid-run), the new set propagates without a separate signal path.
  if (state.session) {
    void publishSkinUnlocks(state.session).catch(() => undefined);
  }

  // Two-stage gameover: when the run is a new local high score, focus the
  // entire screen on the arcade-initials entry first (no other buttons,
  // no recap rows competing for attention), then advance to the recap +
  // actions screen on commit. Non-high-score runs skip straight to recap.
  // Also skip the name-entry stage if the player has already submitted
  // initials for this run — REPLAY KILL flips phase back through 'gameover'
  // when the replay completes, and we don't want to prompt again.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh && !state.initialsEnteredThisRun) renderGameOverNameEntry(state);
  else renderGameOverRecap(state);
}

function renderGameOverNameEntry(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  // Deliberately *no* setupOverlayArrowNav here — arrow keys belong to
  // the arcade widget exclusively on this stage.
  el('h2', { parent: overlay, text: 'GAME OVER' });

  const rank = predictedLocalRank(state.score);
  const banner = el('p', { parent: overlay, text: `RANK ${String(rank).padStart(2, '0')} · NEW HIGH SCORE` });
  banner.style.cssText = 'font-size:1.15rem;color:#ffd84a;letter-spacing:0.22em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin:6px 0 4px;';

  renderRunStatGrid(overlay, state, { isCompletion: false });

  const inputRow = el('div', { className: 'menu-row', parent: overlay });
  renderArcadeInitials(inputRow, {
    onSubmit: (name) => {
      addLocalHighScore({
        name,
        score: state.score,
        sats: state.sats,
        wave: state.wave,
        at: new Date().toISOString(),
        pubkey: state.session?.pubkey,
      });
      state.initialsEnteredThisRun = true;
      renderRunCredits(state, { headerText: 'GAME OVER' });
    },
  });

  const help = el('p', { parent: overlay, text: 'ENTER YOUR INITIALS · ↑↓ CYCLE   ←→ MOVE   → AT END SAVES' });
  help.style.cssText = 'font-size:0.72rem;color:rgba(180,140,255,0.5);letter-spacing:0.16em;margin:8px 0 0;text-align:center;';
}

function renderGameOverRecap(state: GameState): void {
  // Non-high-score gameovers land directly on the credits stage — no
  // initials to enter, but the credits + zap flow still applies.
  renderRunCredits(state, { headerText: 'GAME OVER' });
}

const LN_ADDRESS_KEY = 'pallasite:lightning_address';
const LN_ADDRESS_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+(?::[0-9]+)?$/;

const AGE_ATTEST_KEY_PREFIX = 'pallasite:age_attested_18:';

function hasAgeAttestation(pubkey: string): boolean {
  try {
    return localStorage.getItem(AGE_ATTEST_KEY_PREFIX + pubkey.toLowerCase()) === '1';
  } catch {
    return false;
  }
}

function setAgeAttestation(pubkey: string): void {
  try {
    localStorage.setItem(AGE_ATTEST_KEY_PREFIX + pubkey.toLowerCase(), '1');
  } catch {
    // localStorage unavailable
  }
}

function getStoredLnAddress(): string | null {
  try {
    const v = localStorage.getItem(LN_ADDRESS_KEY);
    return v && LN_ADDRESS_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function setStoredLnAddress(v: string): void {
  try {
    if (LN_ADDRESS_RE.test(v)) localStorage.setItem(LN_ADDRESS_KEY, v);
  } catch {
    // localStorage unavailable
  }
}

function claimErrorMessage(error: string, detail?: string): string {
  switch (error) {
    case 'cap_reached': return 'Lifetime cap reached for this tier.';
    case 'rate_limited': return 'Too many claims this hour. Try later.';
    case 'daily_cap_reached': return 'Daily faucet cap hit. Try tomorrow.';
    case 'pool_empty': return 'Float low — zap to refill the faucet.';
    case 'pool_paused': return 'Faucet paused. Try later.';
    case 'cheated_run': return 'Cheats used — no payout.';
    case 'invalid_score':
    case 'invalid_duration':
    case 'invalid_run_clock':
    case 'stale_run': return 'Run rejected (stat check).';
    case 'invalid_lightning_address': return 'Invalid lightning address.';
    case 'ln_resolve_failed':
    case 'ln_invoice_failed': return 'Could not get an invoice from your wallet.';
    case 'payment_failed': return 'Payment failed. Try later.';
    case 'invoice_mismatch': return 'Invoice did not match expected amount.';
    case 'signer_unavailable': return 'Game signer unreachable. Try later.';
    case 'service_not_configured': return 'Faucet not configured yet.';
    case 'no_signer': return 'Cannot sign with this session.';
    case 'sign_failed': return 'Could not sign claim.';
    case 'network_error': return 'Network error. Check connection.';
    case 'invalid_payload':
      return `Invalid payload${detail ? ': ' + detail.slice(0, 60) : ''}.`;
    case 'player_flagged': return 'Account flagged. Contact dev.';
    case 'replay_of_failed_claim': return 'A previous attempt for this run failed.';
    default:
      return `Claim failed: ${error}${detail ? ' — ' + detail.slice(0, 100) : ''}`;
  }
}

async function maybePublishScore(
  state: GameState,
  parent: HTMLElement,
  setIdlePaused?: (paused: boolean) => void,
): Promise<void> {
  if (!state.session) {
    const cta = el('p', { parent });
    cta.style.cssText = 'font-size:0.85rem;color:#5b9dff;margin:8px 0 0 0';
    cta.textContent = 'Sign in with Nostr next time to claim sats.';
    return;
  }
  if (!state.session.signer.capabilities.canSignEvents) {
    const note = el('p', { parent });
    note.style.cssText = 'font-size:0.85rem;color:#999;margin:8px 0 0 0';
    note.textContent = 'Signed-in session cannot sign — switch to a NIP-07 extension or NIP-46 bunker to claim.';
    return;
  }
  if (state.cheatedThisRun) {
    const note = el('p', { parent });
    note.style.cssText = 'font-size:0.85rem;color:#ff8050;margin:8px 0 0 0';
    note.textContent = 'Cheats were used — no payout.';
    return;
  }

  const wrapper = el('div', { parent });
  wrapper.style.cssText =
    'display:flex;flex-direction:column;gap:6px;margin-top:12px;align-items:stretch';

  // Two views: COMPACT (CLAIM N SATS button + tiny "to addr · change" line)
  // and EDIT (input + SAVE button). Default to compact when we have an
  // address; flip to edit when we don't.

  const compactView = el('div', { parent: wrapper });
  compactView.style.cssText = 'display:flex;flex-direction:column;gap:4px;align-items:stretch';

  // 18+ gate. The game is open to all ages, but the sats claim flow is
  // adults-only (free prize competition, Schedule 11 norms). Two paths:
  //   - Self-attestation checkbox: localStorage flag per pubkey, fast.
  //   - Signet verifyAge('18+'): cryptographic proof from a confirmed
  //     professional verifier (GMC/SRA/TRA via signet-verification-bot).
  // Either path satisfies the gate. We re-prompt on every sign-in for a
  // different pubkey rather than treating the device as attested — the
  // attestation is the *player's*, not the browser's.
  const ageWrap = el('div', { parent: compactView });
  ageWrap.style.cssText =
    'display:flex;flex-direction:column;gap:6px;margin:4px 0 6px 0;text-align:left';

  // Tap target: native checkboxes render at 16-18px on mobile, well below
  // the 44pt minimum the iOS HIG recommends. We bump the box itself + tie
  // the label via id/for so tapping anywhere along the label row toggles
  // the checkbox. Without the linkage the original code only registered
  // hits on the bare checkbox pixels, which mobile users miss every time.
  const ageRow = el('div', { parent: ageWrap });
  ageRow.style.cssText =
    'display:flex;gap:10px;align-items:flex-start;font-size:0.78rem;' +
    'color:#cccccc;line-height:1.4;padding:8px 4px;' +
    '-webkit-tap-highlight-color:rgba(91,157,255,0.18)';
  const ageCheckbox = document.createElement('input');
  ageCheckbox.type = 'checkbox';
  ageCheckbox.id = 'signet-age-checkbox';
  ageCheckbox.style.cssText = 'width:22px;height:22px;margin-top:1px;cursor:pointer;flex-shrink:0;accent-color:#5b9dff';
  const ageLabel = document.createElement('label');
  ageLabel.htmlFor = 'signet-age-checkbox';
  ageLabel.style.cssText = 'cursor:pointer;flex:1;user-select:none;-webkit-user-select:none';
  ageLabel.appendChild(
    document.createTextNode('I confirm I am 18 or older and have read the '),
  );
  const ageTermsLink = document.createElement('a');
  ageTermsLink.href = '#';
  ageTermsLink.textContent = 'terms';
  ageTermsLink.style.cssText = 'color:#5b9dff;text-decoration:underline;padding:2px 0';
  // Stop the terms tap from bubbling — without this, opening terms also
  // toggles the checkbox via the label-for binding.
  ageTermsLink.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTermsModal();
  });
  ageLabel.appendChild(ageTermsLink);
  ageLabel.appendChild(document.createTextNode('.'));
  ageRow.appendChild(ageCheckbox);
  ageRow.appendChild(ageLabel);

  // Signet verify button + status line. Only render the button if the SDK
  // actually exposes verifyAge — older bundles or environments without the
  // script tag won't, and we'd rather hide the option than show a broken
  // button.
  const ageStatus = el('p', { parent: ageWrap, text: '' });
  ageStatus.style.cssText =
    'font-size:0.72rem;margin:0;min-height:1em;color:#888;letter-spacing:0.04em';
  const setAgeStatus = (msg: string, color: string): void => {
    ageStatus.textContent = msg;
    ageStatus.style.color = color;
  };

  let verifyBtn: HTMLButtonElement | null = null;
  if (typeof window.Signet?.verifyAge === 'function') {
    const verifyRow = el('div', { parent: ageWrap });
    verifyRow.style.cssText =
      'display:flex;gap:8px;align-items:center;font-size:0.72rem;color:#888';
    verifyRow.appendChild(document.createTextNode('or'));
    verifyBtn = el('button', {
      className: 'menu-btn secondary',
      parent: verifyRow,
      text: 'VERIFY WITH SIGNET',
    }) as HTMLButtonElement;
    verifyBtn.style.cssText = 'padding:4px 10px;font-size:0.72rem;cursor:pointer';
  }

  const claimBtn = el('button', { className: 'menu-btn', parent: compactView, text: 'CLAIM' });
  claimBtn.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:0.95rem';

  // Gate the claim button on the attestation. If already attested for this
  // pubkey, drop the row entirely so the recap stays compact.
  const sessionPubkey = state.session.pubkey;
  const onAttested = (): void => {
    setAgeAttestation(sessionPubkey);
    claimBtn.disabled = false;
    claimBtn.style.opacity = '1';
    ageWrap.remove();
  };
  if (hasAgeAttestation(sessionPubkey)) {
    ageWrap.remove();
  } else {
    claimBtn.disabled = true;
    claimBtn.style.opacity = '0.55';
    ageCheckbox.addEventListener('change', () => {
      if (ageCheckbox.checked) onAttested();
    });
    if (verifyBtn) {
      onTap(verifyBtn, () => {
        void (async () => {
          if (!window.Signet?.verifyAge) return;
          verifyBtn!.disabled = true;
          setAgeStatus('Opening Signet…', '#5b9dff');
          try {
            const result = await window.Signet.verifyAge('18+', { theme: 'dark' });
            if (result.verified) {
              setAgeStatus('✓ Verified by Signet', '#58ff58');
              onAttested();
            } else if (result.error === 'cancelled') {
              setAgeStatus('Verification cancelled.', '#888');
              verifyBtn!.disabled = false;
            } else {
              setAgeStatus(`Verification failed (${result.error ?? 'unknown'}).`, '#ff8050');
              verifyBtn!.disabled = false;
            }
          } catch {
            setAgeStatus('Signet unavailable. Use the checkbox.', '#ff8050');
            verifyBtn!.disabled = false;
          }
        })();
      });
    }
  }

  const subline = el('p', { parent: compactView });
  subline.style.cssText = 'font-size:0.78rem;color:#888;margin:2px 0 0 0;text-align:center';

  const editView = el('div', { parent: wrapper });
  editView.style.cssText = 'display:none;flex-direction:column;gap:6px';

  const editLabel = el('p', {
    parent: editView,
    text: 'Lightning address — where do you want sats sent?',
  });
  editLabel.style.cssText = 'font-size:0.85rem;color:#cccccc;margin:0';

  const editRow = el('div', { parent: editView });
  editRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'alice@yourwallet.com';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.style.cssText =
    'flex:1;min-width:220px;padding:6px 8px;font-family:inherit;font-size:0.9rem;' +
    'background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
  editRow.appendChild(input);

  const saveBtn = el('button', { className: 'menu-btn secondary', parent: editRow, text: 'SAVE' });
  saveBtn.style.cssText = 'padding:6px 14px;cursor:pointer;font-size:0.9rem';

  const status = el('p', { parent: wrapper, text: '' });
  status.style.cssText = 'font-size:0.85rem;margin:4px 0 0 0;min-height:1.2em';

  // Single source of truth for the chosen address. Updated by setDefault on
  // initial fill / async profile arrival, or by the SAVE button when the user
  // edits.
  let currentAddress = '';
  let lastDefault = '';

  const setDefault = (next: string): void => {
    if (currentAddress === '' || currentAddress === lastDefault) {
      currentAddress = next;
    }
    lastDefault = next;
  };

  const setStatus = (msg: string, color: string): void => {
    status.textContent = msg;
    status.style.color = color;
  };

  const updateClaimLabel = (): void => {
    claimBtn.textContent = state.sats > 0 ? `CLAIM ${state.sats} SATS` : 'CLAIM';
  };

  const renderSubline = (): void => {
    subline.replaceChildren();
    if (currentAddress) {
      subline.appendChild(document.createTextNode(`to ${currentAddress} · `));
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'change';
      a.style.color = '#5b9dff';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showEdit();
      });
      subline.appendChild(a);
    } else {
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'set lightning address';
      a.style.color = '#5b9dff';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        showEdit();
      });
      subline.appendChild(a);
    }
  };

  const showCompact = (): void => {
    editView.style.display = 'none';
    compactView.style.display = 'flex';
    renderSubline();
  };

  const showEdit = (): void => {
    compactView.style.display = 'none';
    editView.style.display = 'flex';
    input.value = currentAddress;
    setTimeout(() => input.focus(), 0);
  };

  // Initial fill: profile lud16 wins, then localStorage, then empty.
  const profileLud = state.profile?.lud16 ?? null;
  const stored = getStoredLnAddress();
  setDefault(profileLud ?? stored ?? '');
  updateClaimLabel();
  if (currentAddress) showCompact();
  else showEdit();

  // Async profile refresh — picks up a fresher lud16 if the cache is stale.
  void fetchProfile(state.session.pubkey, { force: true }).then((p) => {
    if (!p) return;
    state.profile = p;
    if (p.lud16) {
      setDefault(p.lud16);
      if (compactView.style.display !== 'none') {
        renderSubline();
      } else if (input.value === '' || input.value === lastDefault) {
        input.value = p.lud16;
      }
    }
  });

  const onSave = (): void => {
    const addr = input.value.trim();
    if (!LN_ADDRESS_RE.test(addr)) {
      setStatus('Invalid lightning address.', '#ff5050');
      return;
    }
    currentAddress = addr;
    setStoredLnAddress(addr);
    setStatus('', '');
    showCompact();
  };
  onTap(saveBtn, onSave);
  input.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      onSave();
    }
  });

  const session = state.session;

  const onClaim = async (): Promise<void> => {
    if (!currentAddress) {
      setStatus('Set a lightning address first.', '#ff5050');
      showEdit();
      return;
    }

    claimBtn.disabled = true;
    setStatus('Validating…', '#5b9dff');

    // Pause the auto-skip-to-title countdown for the duration of the claim.
    // Lightning + bunker round-trip + relay publish can take 20-30s on a
    // cold path; without the pause, the credits-screen idle timer would
    // navigate the player back to title mid-payment and they'd see no
    // confirmation that their sats actually landed.
    setIdlePaused?.(true);

    try {
      const finishedAt = Date.now();
      const duration = Math.max(0, Math.floor(state.runTimeMs));
      const startedAt =
        state.runStartedAt > 0 ? state.runStartedAt : finishedAt - duration;

      const seed = getActiveSeed();
      const result = await submitClaim(session, {
        score: state.score,
        wave: state.wave,
        duration_ms: duration,
        started_at: startedAt,
        finished_at: finishedAt,
        sats_claimed: state.sats,
        lightning_address: currentAddress,
        cheated: state.cheatedThisRun,
        ...(seed ? { daily_seed: seed } : {}),
      });

      if (result.ok) {
        const tail = result.status === 'paid_but_unannounced' ? ' (announce pending)' : '';
        setStatus(`✓ Paid ${result.payout_sats} sats${tail}`, '#58ff58');
      } else {
        setStatus(claimErrorMessage(result.error, result.detail), '#ff8050');
        claimBtn.disabled = false;
      }
    } finally {
      // Always release the idle hold and reset the countdown so the player
      // gets a fresh window to read the result before the auto-skip resumes.
      setIdlePaused?.(false);
    }
  };
  onTap(claimBtn, () => { void onClaim(); });
}

// ── Completion screen (wave 25 cleared) ──────────────────────────────────────

function formatRunTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Compact stat grid for the gameover / completion name-entry stages.
 *
 * Suppresses any zero-valued rows so a quick early death isn't crowded
 * with " 0" placeholders, but always shows the load-bearing rows
 * (score, run time, wave or specimens) so the player has the headline
 * numbers before they enter initials.
 */
function renderRunStatGrid(
  parent: HTMLElement,
  state: GameState,
  opts: { isCompletion?: boolean } = {},
): void {
  const board = el('div', { className: 'scoreboard', parent });
  const rows: Array<readonly [string, string]> = [];
  rows.push(['SCORE', state.score.toLocaleString()]);
  // Sats only matter when there's a Nostr session — guests don't earn payouts.
  if (state.session) rows.push(['SATS', `₿ ${state.sats.toLocaleString()}`]);
  rows.push(['RUN TIME', formatRunTime(state.runTimeMs)]);
  if (opts.isCompletion) {
    rows.push(['SPECIMENS', '24 / 24']);
  } else {
    rows.push(['WAVE', `${state.wave} / 25`]);
  }
  const stats = state.runStats;
  const ufoTotal = Object.values(stats.ufoKills).reduce((a, b) => a + b, 0);
  if (ufoTotal > 0) rows.push(['UFOS DOWN', String(ufoTotal)]);
  if (stats.minesDestroyed > 0) rows.push(['MINES CLEARED', String(stats.minesDestroyed)]);
  if (stats.largestCombo >= 2) rows.push(['BEST COMBO', `×${stats.largestCombo}`]);
  if (stats.powerupsCollected > 0) rows.push(['POWERUPS', String(stats.powerupsCollected)]);
  for (const [k, v] of rows) {
    el('div', { className: 'label', parent: board, text: k });
    el('div', { className: 'value', parent: board, text: v });
  }

  // UFO type breakdown — only when at least one of the named types fell.
  // Boss listed first so it pops, then descending difficulty order.
  const types: Array<readonly [string, number]> = [
    ['BOSS', stats.ufoKills.boss],
    ['TANK', stats.ufoKills.tank],
    ['ELITE', stats.ufoKills.elite],
    ['SNIPER', stats.ufoKills.sniper],
    ['UFO', stats.ufoKills.cruiser],
  ];
  const breakdown = types.filter(([, n]) => n > 0);
  if (breakdown.length > 0) {
    const line = el('p', { parent });
    line.style.cssText = 'font-size:0.78rem;letter-spacing:0.18em;color:rgba(180,140,255,0.75);margin:6px 0 0;text-align:center;';
    line.textContent = breakdown.map(([k, n]) => `${k} ×${n}`).join('  ·  ');
  }
}

/**
 * Unified post-run credits stage.
 *
 * Replaces the old gameover-recap and completion-recap screens with a
 * single auto-scrolling credits screen that centres the zap CTA, kicks
 * off the score-publish flow in the background, and either auto-returns
 * to the title after `idleSeconds` of no input or lets the player skip
 * sooner via SKIP TO TITLE / Enter.
 *
 * - Header sets the tone: GAME OVER vs PALLASITE COMPLETE
 * - Faucet / publish flow renders inline so a Nostr-mode player sees the
 *   sats land before the auto-skip fires
 * - Zap row is the most prominent action — that's the whole point of this
 *   stage
 * - Honours strip surfaces only on completion (PERFECT RUN / NO LURK /
 *   COMPLETIONIST) — gameovers don't earn the COMPLETIONIST badge so
 *   the strip is mostly empty there anyway
 */
function renderRunCredits(
  state: GameState,
  opts: { headerText: string; subText?: string; isCompletion?: boolean; idleSeconds?: number },
): void {
  const idleSeconds = opts.idleSeconds ?? 45;
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);
  if (opts.isCompletion) overlay.style.background = 'rgba(0, 0, 0, 0.85)';

  // Logo on completion only — gameover keeps text-only header so the
  // wordmark remains a "you finished it" reward.
  if (opts.isCompletion) {
    const logo = el('img', { parent: overlay });
    logo.className = 'title-logo';
    (logo as HTMLImageElement).src = '/logo.webp';
    (logo as HTMLImageElement).alt = 'PALLASITE';
    (logo as HTMLImageElement).decoding = 'async';
  }

  el('h2', { parent: overlay, text: opts.headerText });
  if (opts.subText) {
    const sub = el('p', { parent: overlay, text: opts.subText });
    sub.style.cssText = 'font-size:1.1rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin:-10px 0 4px;';
  }

  // Honours surface on completion runs only.
  if (opts.isCompletion) renderHonours(overlay, state, () => { /* no stagger */ });

  // Score-publish / faucet status — only Nostr-mode runs trigger a claim.
  // Returns immediately for guests / cheated runs / signers without sign
  // capability with a one-line status of its own. We pass setIdlePaused
  // through so the claim flow can hold the auto-skip-to-title timer while
  // a long Lightning round-trip is in flight (binding defined further
  // below; hoisted via let).
  const publishWrap = el('div', { parent: overlay });
  void maybePublishScore(state, publishWrap, (paused) => setIdlePaused(paused));

  // Best-effort kind 30763 ghost publish. Independent of the score claim so
  // sign-capable sessions leave a ghost trail even when they don't claim
  // (or the faucet is down). publishGhost no-ops on cheated / read-only /
  // sub-2-sample runs, so unconditional invocation is safe. v2 (pose) is
  // emitted automatically when the daily-mode pose stream is non-empty;
  // free runs publish v1 (score-only).
  if (state.session) {
    void publishGhost({
      session: state.session,
      samples: state.ghostSamples,
      poseSamples: state.ghostPoseSamples,
      finalScore: state.score,
      finalWave: state.wave,
      durationMs: Math.max(0, Math.floor(state.runTimeMs)),
      seed: getActiveSeed(),
      cheated: state.cheatedThisRun,
    });
  }

  // Prominent zap CTA — the entire reason this stage exists per the user
  // brief: "make zaps easy and frictionless".
  const zapWrap = el('div', { parent: overlay });
  renderZapButton(zapWrap, state);

  // Social actions only land for Nostr mode (follow + announce buttons).
  if (state.session) {
    const socialWrap = el('div', { parent: overlay });
    renderSocialActions(socialWrap, state);
  }

  // Credits scroll — 24 specimens + powered-by + lore. Completion only:
  // on a regular gameover the 460px panel sits empty for ~6s while the inner
  // scrolls in, which dominates the screen when there's little above it
  // (especially when not signed in, since faucet status + social actions
  // are skipped). Beating the game earns the credits; dying does not.
  if (opts.isCompletion) {
    renderCreditsRoll(overlay, undefined, state);
  }

  // Auto-skip timer — counts down to TITLE. Resets on any user input
  // (keydown OR pointerdown — mobile users tap, never fire keydown, so
  // a key-only listener kept ticking through their interaction). The
  // claim flow can also hold the timer via setIdlePaused while a slow
  // Lightning round-trip is mid-payment so the player isn't yanked back
  // to title before the result lands. The SKIP TO TITLE button exits
  // immediately.
  let secondsLeft = idleSeconds;
  let idlePaused = false;
  const skipBar = el('p', { parent: overlay });
  skipBar.style.cssText = 'font-size:0.85rem;letter-spacing:0.18em;color:#ffd84a;margin:6px 0 0;';
  const renderSkip = (): void => {
    skipBar.textContent = idlePaused
      ? 'CLAIM IN PROGRESS — HOLDING'
      : `RETURNING TO TITLE IN ${secondsLeft}`;
  };
  renderSkip();

  const goToTitle = (): void => {
    cleanup();
    clearEntitiesForTitle(state);
    state.phase = 'title';
    renderTitle(state);
  };
  const idleTick = window.setInterval(() => {
    if (idlePaused) return;
    secondsLeft -= 1;
    renderSkip();
    if (secondsLeft <= 0) goToTitle();
  }, 1000);
  const resetIdle = (): void => { secondsLeft = idleSeconds; renderSkip(); };
  const setIdlePaused = (paused: boolean): void => {
    idlePaused = paused;
    if (!paused) resetIdle();
    else renderSkip();
  };
  const onActivity = (): void => resetIdle();
  window.addEventListener('keydown', onActivity);
  // Pointerdown covers mouse, pen, AND touch — so a tap on mobile
  // counts as "still here" the same way a key press does on desktop.
  window.addEventListener('pointerdown', onActivity);
  const cleanup = (): void => {
    window.clearInterval(idleTick);
    window.removeEventListener('keydown', onActivity);
    window.removeEventListener('pointerdown', onActivity);
  };

  const row = el('div', { className: 'menu-row', parent: overlay });
  if (!opts.isCompletion) {
    const again = el('button', { className: 'menu-btn', parent: row, text: 'SPAWN AGAIN' });
    onTap(again, () => {
      cleanup();
      startGame(state);
      onStartCb?.();
    });
    if (state.deathReplay) {
      const replay = el('button', { className: 'menu-btn secondary', parent: row, text: 'REPLAY KILL' });
      onTap(replay, () => {
        cleanup();
        clearOverlay();
        startDeathReplay(state, 'gameover');
      });
    }
  } else {
    const again = el('button', { className: 'menu-btn', parent: row, text: 'IGNITE AGAIN' });
    onTap(again, () => {
      cleanup();
      startGame(state);
      onStartCb?.();
    });
  }
  // SHARE CARD — system share sheet with a rendered run summary image.
  // Available to guests (no auth needed); complements the signed-in
  // SHARE / FOLLOW / ENDORSE row that publishes to Nostr relays.
  const shareBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SHARE CARD' }) as HTMLButtonElement;
  onTap(shareBtn, () => {
    shareBtn.disabled = true;
    shareBtn.style.opacity = '0.6';
    void shareRunCard(state).finally(() => {
      shareBtn.disabled = false;
      shareBtn.style.opacity = '1';
    });
  });
  const home = el('button', { className: 'menu-btn secondary', parent: row, text: 'SKIP TO TITLE' });
  onTap(home, goToTitle);

  renderLegalFooter(overlay);
}

export function renderCompletion(state: GameState): void {
  // Two-stage completion, mirroring gameover: focus the player on the
  // arcade name entry first, then unfurl the celebration. Non-high-score
  // wave-25 clears (rare but possible — local list already full of higher
  // scores) skip stage 1 and land on the celebration directly.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh && !state.initialsEnteredThisRun) renderCompletionNameEntry(state);
  else renderCompletionRecap(state);
}

function renderCompletionNameEntry(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  overlay.style.background = 'rgba(0, 0, 0, 0.85)';
  // No setupOverlayArrowNav — arrow keys belong to the arcade widget on
  // this stage, full stop.

  // Pallasite logo replaces the bare h1 — the wordmark is the reward for
  // finishing, surface it where the player will see it most.
  const logo = el('img', { parent: overlay });
  logo.className = 'title-logo';
  (logo as HTMLImageElement).src = '/logo.webp';
  (logo as HTMLImageElement).alt = 'PALLASITE';
  (logo as HTMLImageElement).decoding = 'async';

  const sub = el('p', { parent: overlay, text: 'COMPLETE · EVENT HORIZON BREACHED' });
  sub.style.cssText = 'font-size:1.1rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-4px;';

  const rank = predictedLocalRank(state.score);
  const banner = el('p', { parent: overlay, text: `RANK ${String(rank).padStart(2, '0')} · NEW HIGH SCORE` });
  banner.style.cssText = 'font-size:1.05rem;color:#ffd84a;letter-spacing:0.22em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin:6px 0 4px;';

  renderRunStatGrid(overlay, state, { isCompletion: true });

  const inputWrap = el('div', { className: 'menu-row', parent: overlay });
  renderArcadeInitials(inputWrap, {
    onSubmit: (name) => {
      addLocalHighScore({
        name,
        score: state.score,
        sats: state.sats,
        wave: 25,
        at: new Date().toISOString(),
        pubkey: state.session?.pubkey,
      });
      state.initialsEnteredThisRun = true;
      renderRunCredits(state, {
        headerText: 'PALLASITE COMPLETE',
        subText: 'EVENT HORIZON · BREACHED',
        isCompletion: true,
      });
    },
  });

  const help = el('p', { parent: overlay, text: 'ENTER YOUR INITIALS · ↑↓ CYCLE   ←→ MOVE   → AT END SAVES' });
  help.style.cssText = 'font-size:0.72rem;color:rgba(180,140,255,0.5);letter-spacing:0.16em;margin:8px 0 0;text-align:center;';
}

function renderCompletionRecap(state: GameState): void {
  // Non-high-score wave-25 clears land directly on the credits stage.
  renderRunCredits(state, {
    headerText: 'PALLASITE COMPLETE',
    subText: 'EVENT HORIZON · BREACHED',
    isCompletion: true,
  });
}

/**
 * Honours strip — small badges summarising notable run conditions. Surfaced
 * above the credits so a player who had a clean run gets immediate recognition
 * without waiting for the scroll. Quiet strip when no honours apply.
 */
function renderHonours(parent: HTMLElement, state: GameState, applyStage: (e: HTMLElement) => void): void {
  const honours: Array<{ label: string; cls: string }> = [];
  // Lives lost during the run = livesStart - lives remaining + extra-life pickups
  // is hard to know without telemetry, so a "PERFECT" badge is gated on still
  // holding all 3 (or whatever default difficulty grants). Easy / Hard differ.
  if (state.lives >= 3) honours.push({ label: 'PERFECT RUN', cls: 'honour-perfect' });
  if (!state.lurkEverDetected) honours.push({ label: 'NO LURKING', cls: 'honour-no-lurk' });
  honours.push({ label: 'COMPLETIONIST · 24/24', cls: 'honour-completionist' });

  if (honours.length === 0) return;
  const row = el('div', { className: 'honours-row', parent });
  for (const h of honours) {
    el('span', { className: `honour-badge ${h.cls}`, parent: row, text: h.label });
  }
  applyStage(row);
}

function renderSocialActions(parent: HTMLElement, state: GameState): void {
  const block = el('div', { parent });
  block.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:6px;';

  const status = el('p', { parent: block });
  status.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.7);letter-spacing:0.05em;margin:0;height:1em;';

  const row = el('div', { className: 'menu-row', parent: block });
  row.style.gap = '10px';

  const setStatus = (text: string, colour: string): void => {
    status.textContent = text;
    status.style.color = colour;
  };

  const session = state.session;
  const canSign = session?.signer.capabilities.canSignEvents === true;

  function makeBtn(label: string, sub: string, colour: string, run: () => Promise<void>): HTMLButtonElement {
    const btn = el('button', { parent: row });
    btn.innerHTML = `<span style="display:block;font-size:0.95rem;letter-spacing:0.12em;">${label}</span><span style="display:block;font-size:0.62rem;letter-spacing:0.08em;opacity:0.55;margin-top:2px;">${sub}</span>`;
    btn.style.cssText = [
      'background:transparent', `border:2px solid ${colour}`, `color:${colour}`,
      "font-family:'VT323',ui-monospace,monospace",
      'padding:8px 14px', 'cursor:pointer', 'border-radius:6px',
      'transition:all 0.12s ease', `text-shadow:0 0 6px ${colour}99`,
      `box-shadow:0 0 10px ${colour}33`,
    ].join(';');
    if (!canSign) btn.style.opacity = '0.45';
    onTap(btn, async () => {
      if (!canSign) {
        setStatus('Sign in with Bark or bunker to use Nostr actions.', '#ff8a3a');
        return;
      }
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.style.opacity = '0.6';
      try {
        await run();
      } finally {
        btn.disabled = false;
        btn.style.opacity = '1';
        // Keep label change if run() updated innerHTML; else restore
        if (btn.innerHTML === '') btn.innerHTML = original;
      }
    });
    return btn;
  }

  makeBtn('⚡ FOLLOW', 'NIP-02 KIND 3', '#58ff58', async () => {
    if (!session) return;
    setStatus('Following…', '#5b9dff');
    try {
      const res = await followUser(session, DEV.pubkey);
      if (res.alreadyFollowing) {
        setStatus(`Already following ${DEV.name}.`, '#ffd84a');
      } else {
        setStatus(`✓ Followed ${DEV.name} on ${res.publishedTo.length}/${res.publishedTo.length + res.failed.length} relays.`, '#58ff58');
      }
    } catch (err) {
      setStatus(`✗ Follow failed: ${err instanceof Error ? err.message : String(err)}`, '#ff5050');
    }
  });

  makeBtn('📡 SHARE', 'KIND 1 · #pallasite', '#ffd84a', async () => {
    if (!session) return;
    setStatus('Posting note…', '#5b9dff');
    try {
      const runTimeSec = Math.floor(state.runTimeMs / 1000);
      const res = await shareCompletion(session, {
        score: state.score, sats: state.sats, wave: state.wave, runTimeSec,
      });
      setStatus(`✓ Posted on ${res.publishedTo.length}/${res.publishedTo.length + res.failed.length} relays.`, '#58ff58');
    } catch (err) {
      setStatus(`✗ Share failed: ${err instanceof Error ? err.message : String(err)}`, '#ff5050');
    }
  });

  makeBtn('✦ ENDORSE', 'NIP-85 KIND 30382', '#5b9dff', async () => {
    if (!session) return;
    const rank = rankFromWave(state.wave);
    setStatus(`Endorsing at rank ${rank}…`, '#5b9dff');
    try {
      const res = await endorseSubject(session, DEV.pubkey, rank, 'pallasite-completed');
      setStatus(`✓ Endorsed at rank ${rank} on ${res.publishedTo.length}/${res.publishedTo.length + res.failed.length} relays.`, '#58ff58');
    } catch (err) {
      setStatus(`✗ Endorse failed: ${err instanceof Error ? err.message : String(err)}`, '#ff5050');
    }
  });

  if (!canSign) {
    setStatus('Sign in with Bark or bunker on the title screen to enable these.', 'rgba(180,140,255,0.7)');
  }
}

function renderZapButton(parent: HTMLElement, state: GameState): void {
  // Without a Nostr session the LNURL-pay path still works, but the resulting
  // payment can't be signed as a NIP-57 zap — so the player gets no public
  // credit linking them to the game. Show a Ko-fi link instead so non-Nostr
  // players have a real path to support the project, not a dead-end prompt.
  if (!state.session) {
    const wrap = el('div', { parent });
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:6px;';
    const label = el('p', { parent: wrap, text: '☕ TIP VIA KO-FI' });
    label.style.cssText = 'font-size:0.95rem;letter-spacing:0.22em;color:#ffd84a;text-shadow:0 0 8px rgba(255,216,74,0.5);margin:0;';
    const sub = el('p', { parent: wrap, text: 'no Nostr needed · card or PayPal' });
    sub.style.cssText = 'font-size:0.7rem;letter-spacing:0.12em;color:rgba(180,140,255,0.6);margin:0;text-align:center;';
    const ko = el('a', { parent: wrap, text: '☕ KO-FI ·  ko-fi.com/brays' }) as HTMLAnchorElement;
    ko.href = 'https://ko-fi.com/brays';
    ko.target = '_blank';
    ko.rel = 'noopener';
    ko.style.cssText = koFiButtonStyle();
    const orZap = el('p', { parent: wrap, text: 'or sign in with Nostr to zap' });
    orZap.style.cssText = 'font-size:0.66rem;letter-spacing:0.1em;color:rgba(180,140,255,0.45);margin:6px 0 0;text-align:center;';
    return;
  }

  const wrap = el('div', { parent });
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:6px;';

  const label = el('p', { parent: wrap, text: '⚡ ZAP THE CRYPTO DONKEY ⚡' });
  label.style.cssText = 'font-size:0.95rem;letter-spacing:0.22em;color:#ffd84a;text-shadow:0 0 8px rgba(255,216,74,0.5);margin:0;';

  const sub = el('p', { parent: wrap });
  sub.innerHTML = `${hasWebLN() ? 'WebLN detected · one-click pay' : 'Click amount → opens your wallet'} · NIP-57`;
  sub.style.cssText = 'font-size:0.7rem;letter-spacing:0.15em;color:rgba(180,140,255,0.6);margin:0;';

  const row = el('div', { parent: wrap });
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';

  const presets: Array<{ label: string; sats: number }> = [
    { label: '21',  sats: 21 },
    { label: '100', sats: 100 },
    { label: '1k',  sats: 1000 },
    { label: '10k', sats: 10000 },
  ];

  for (const p of presets) {
    const btn = el('button', { parent: row, text: `⚡ ${p.label}` });
    btn.style.cssText = zapPresetStyle();
    onTap(btn, () => quickZap(state, p.sats, btn));
  }

  const custom = el('button', { parent: row, text: 'CUSTOM…' });
  custom.style.cssText = [
    'background:transparent',
    'border:2px solid rgba(180,140,255,0.5)',
    'color:rgba(220,210,255,0.85)',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:0.95rem',
    'padding:8px 14px',
    'letter-spacing:0.12em',
    'cursor:pointer',
    'border-radius:6px',
    'transition:all 0.12s ease',
  ].join(';');
  onTap(custom, () => openZapModal(state));

  // Secondary Ko-fi link for signed-in players who'd rather pay via card —
  // no judgement, sats and ko-fi both fund the faucet float.
  const koRow = el('div', { parent: wrap });
  koRow.style.cssText = 'display:flex;justify-content:center;margin-top:4px;';
  const ko = el('a', { parent: koRow, text: '☕ or tip via ko-fi' }) as HTMLAnchorElement;
  ko.href = 'https://ko-fi.com/brays';
  ko.target = '_blank';
  ko.rel = 'noopener';
  ko.style.cssText = [
    'font-size:0.72rem', 'letter-spacing:0.16em',
    'color:rgba(180,140,255,0.7)', 'text-decoration:none',
    'cursor:pointer',
  ].join(';');
}

function koFiButtonStyle(): string {
  return [
    'background:rgba(255,216,74,0.1)',
    'border:2px solid #ffd84a',
    'color:#ffd84a',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1rem',
    'padding:10px 18px',
    'letter-spacing:0.16em',
    'cursor:pointer', 'text-decoration:none',
    'border-radius:6px',
    'text-shadow:0 0 6px rgba(255,216,74,0.6)',
    'box-shadow:0 0 12px rgba(255,216,74,0.2)',
    'transition:all 0.12s ease',
  ].join(';');
}

function zapPresetStyle(): string {
  return [
    'background:rgba(255,216,74,0.1)',
    'border:2px solid #ffd84a',
    'color:#ffd84a',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1.05rem',
    'padding:8px 16px',
    'letter-spacing:0.1em',
    'cursor:pointer',
    'border-radius:6px',
    'transition:all 0.12s ease',
    'text-shadow:0 0 6px rgba(255,216,74,0.6)',
    'box-shadow:0 0 12px rgba(255,216,74,0.2)',
    'min-width:74px',
  ].join(';');
}

/**
 * One-click zap. Shows the QR popover IMMEDIATELY (with a spinner placeholder)
 * so the user has something to scan as soon as the invoice arrives. Tries
 * WebLN in parallel — success dismisses the popover with a tick, failure
 * leaves the QR up for phone-scan.
 */
async function quickZap(state: GameState, amountSats: number, btn: HTMLButtonElement): Promise<void> {
  const originalHtml = btn.innerHTML;
  const restore = (): void => { btn.innerHTML = originalHtml; btn.disabled = false; btn.style.opacity = '1'; };
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.innerHTML = `⚡ …`;

  // Show popover up-front so the user sees feedback even before the fetch lands
  const pop = createZapPopover(amountSats);

  try {
    const res = await requestZapInvoice(state.session, amountSats, '');
    populateZapPopover(pop, res.invoice, amountSats, res.isZap);
    restore();

    // Try WebLN in parallel — if it succeeds, dismiss the popover with a tick
    if (hasWebLN()) {
      try {
        await payViaWebLN(res.invoice);
        markPopoverPaid(pop, amountSats);
        return;
      } catch {
        // WebLN refused/failed — popover stays, user can scan QR or click open-wallet
      }
    }
  } catch (err) {
    failPopover(pop, err instanceof Error ? err.message : String(err));
    btn.innerHTML = '✗ FAIL';
    btn.style.borderColor = '#ff5050';
    btn.style.color = '#ff5050';
    setTimeout(() => {
      btn.style.borderColor = '#ffd84a';
      btn.style.color = '#ffd84a';
      restore();
    }, 2500);
  }
}

/** Build the popover skeleton with a spinner — invoice fills in when fetched. */
function createZapPopover(amountSats: number): HTMLElement {
  document.querySelectorAll('.zap-popover').forEach(n => n.remove());

  const pop = el('div', { className: 'zap-popover', parent: root });

  const heading = el('p', { parent: pop, text: `ZAP · ${amountSats} SATS` });
  heading.style.cssText = 'font-size:1rem;letter-spacing:0.2em;color:var(--hud-yellow);margin:0;text-shadow:0 0 6px rgba(255,216,74,0.5);';

  const sub = el('p', { className: 'zap-popover-sub', parent: pop, text: 'Generating invoice…' });
  sub.style.cssText = 'font-size:0.72rem;color:rgba(180,140,255,0.7);letter-spacing:0.1em;margin:0 0 6px;';

  const qrSlot = el('div', { className: 'zap-popover-qr', parent: pop });
  qrSlot.style.cssText = 'display:flex;align-items:center;justify-content:center;width:200px;height:200px;background:rgba(0,0,0,0.4);border:1px solid rgba(180,140,255,0.3);border-radius:8px;';

  // Spinner
  const spinner = el('div', { className: 'zap-spinner', parent: qrSlot });
  spinner.style.cssText = 'width:36px;height:36px;border:3px solid rgba(255,216,74,0.2);border-top-color:#ffd84a;border-radius:50%;animation:zap-spin 0.8s linear infinite;';

  el('div', { className: 'zap-popover-actions', parent: pop }).style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px;min-height:36px;';

  // Cancel button — always present
  const cancel = el('button', { className: 'zap-popover-close', parent: pop, text: '✕' });
  cancel.style.cssText = [
    'position:absolute', 'top:8px', 'right:8px',
    'background:transparent', 'border:none',
    'color:rgba(220,210,255,0.55)',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1.1rem',
    'cursor:pointer', 'padding:2px 8px', 'border-radius:4px',
  ].join(';');
  cancel.addEventListener('click', () => pop.remove());

  // Auto-dismiss after 90s
  const timer = window.setTimeout(() => pop.remove(), 90_000);
  pop.dataset.timer = String(timer);

  return pop;
}

/** Fill the popover with the actual invoice + QR + action buttons. */
function populateZapPopover(pop: HTMLElement, invoice: string, amountSats: number, isZap: boolean): void {
  const sub = pop.querySelector<HTMLElement>('.zap-popover-sub');
  if (sub) sub.textContent = isZap ? 'Signed zap · scan or click' : 'LNURL pay · scan or click';

  const qrSlot = pop.querySelector<HTMLElement>('.zap-popover-qr');
  if (qrSlot) {
    qrSlot.innerHTML = '';
    qrSlot.style.background = '#fff';
    qrSlot.style.border = 'none';
    qrSlot.style.padding = '8px';
    void renderQRInto(qrSlot, invoice.toUpperCase());  // uppercase encodes more efficiently in alphanumeric mode
  }

  const actions = pop.querySelector<HTMLElement>('.zap-popover-actions');
  if (!actions) return;
  actions.innerHTML = '';

  const wallet = el('a', { parent: actions, text: '⚡ OPEN WALLET' });
  wallet.setAttribute('href', `lightning:${invoice}`);
  wallet.style.cssText = [
    'background:rgba(255,216,74,0.18)',
    'border:2px solid #ffd84a',
    'color:#ffd84a',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:0.92rem',
    'padding:7px 14px',
    'letter-spacing:0.12em',
    'cursor:pointer',
    'border-radius:6px',
    'text-decoration:none',
    'display:inline-block',
  ].join(';');

  const copy = el('button', { parent: actions, text: 'COPY' });
  copy.style.cssText = [
    'background:transparent',
    'border:2px solid #5b9dff',
    'color:#5b9dff',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:0.92rem',
    'padding:7px 14px',
    'letter-spacing:0.12em',
    'cursor:pointer',
    'border-radius:6px',
  ].join(';');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(invoice);
      copy.textContent = '✓';
      setTimeout(() => { copy.textContent = 'COPY'; }, 2000);
    } catch { copy.textContent = '✗'; }
  });

  // "I PAID" — manual confirmation for QR/external wallet flows where we
  // can't detect settlement automatically. WebLN paths short-circuit to
  // markPopoverPaid() directly and bypass this.
  const paid = el('button', { parent: actions, text: 'I PAID' });
  paid.style.cssText = [
    'background:rgba(88,255,88,0.12)',
    'border:2px solid #58ff58',
    'color:#58ff58',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:0.92rem',
    'padding:7px 14px',
    'letter-spacing:0.12em',
    'cursor:pointer',
    'border-radius:6px',
  ].join(';');
  paid.addEventListener('click', () => {
    pop.remove();
    renderZapThanks(amountSats);
  });
}

/** Mark the popover as paid (WebLN succeeded) and auto-dismiss after 2.5s. */
function markPopoverPaid(pop: HTMLElement, amountSats: number): void {
  const sub = pop.querySelector<HTMLElement>('.zap-popover-sub');
  if (sub) {
    sub.textContent = `✓ ZAPPED ${amountSats} SATS · THANK YOU`;
    sub.style.color = '#58ff58';
  }
  const qrSlot = pop.querySelector<HTMLElement>('.zap-popover-qr');
  if (qrSlot) {
    qrSlot.innerHTML = '<div style="font-size:3rem;color:#58ff58;text-shadow:0 0 12px rgba(88,255,88,0.6);">✓</div>';
    qrSlot.style.background = 'rgba(88,255,88,0.08)';
    qrSlot.style.border = '2px solid #58ff58';
    qrSlot.style.padding = '0';
  }
  const timer = pop.dataset.timer;
  if (timer) clearTimeout(parseInt(timer, 10));
  // Brief popover acknowledgement, then full thank-you overlay so the
  // celebration lands and the QR doesn't loiter.
  setTimeout(() => {
    pop.remove();
    renderZapThanks(amountSats);
  }, 900);
}

/**
 * Full-screen thank-you celebration. Heart icon, glow pulse, sat amount,
 * one-line gratitude. Auto-dismisses after 5s; click anywhere to dismiss
 * sooner. Sits above any other overlay.
 */
function renderZapThanks(amountSats: number): void {
  // Remove any existing celebration so a second tap doesn't stack
  document.querySelectorAll('.zap-thanks').forEach(n => n.remove());
  const wrap = el('div', { className: 'zap-thanks', parent: root });
  wrap.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:200',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'background:radial-gradient(circle at center, rgba(255,216,74,0.08), rgba(0,0,0,0.85) 70%)',
    'backdrop-filter:blur(3px)',
    'animation:zap-thanks-in 0.4s ease forwards',
    'cursor:pointer',
    'padding:32px',
  ].join(';');

  const heart = el('div', { parent: wrap, text: '⚡' });
  heart.style.cssText = [
    'font-size:7rem', 'color:#ffd84a',
    'text-shadow:0 0 30px rgba(255,216,74,0.7)',
    'animation:zap-thanks-pulse 1.4s ease-in-out infinite',
    'line-height:1',
  ].join(';');

  const big = el('h2', { parent: wrap, text: amountSats > 0 ? `${amountSats.toLocaleString()} SATS` : 'ZAPPED' });
  big.style.cssText = [
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:clamp(1.8rem, 6vw, 3rem)',
    'color:#ffd84a', 'letter-spacing:0.18em',
    'margin:18px 0 6px', 'text-shadow:0 0 12px rgba(255,216,74,0.6)',
  ].join(';');

  const thanks = el('p', { parent: wrap, text: 'THANK YOU FOR THE ZAP' });
  thanks.style.cssText = [
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1.2rem', 'color:#58ff58',
    'letter-spacing:0.25em', 'margin:0',
    'text-shadow:0 0 8px rgba(88,255,88,0.5)',
  ].join(';');

  const sub = el('p', { parent: wrap, text: 'Tap anywhere to continue' });
  sub.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.18em;margin:24px 0 0;';

  const dismiss = (): void => {
    wrap.style.animation = 'zap-thanks-out 0.3s ease forwards';
    setTimeout(() => wrap.remove(), 320);
  };
  wrap.addEventListener('click', dismiss);
  setTimeout(dismiss, 5000);
}

function failPopover(pop: HTMLElement, message: string): void {
  const sub = pop.querySelector<HTMLElement>('.zap-popover-sub');
  if (sub) {
    sub.textContent = `✗ ${message}`;
    sub.style.color = '#ff5050';
  }
  const qrSlot = pop.querySelector<HTMLElement>('.zap-popover-qr');
  if (qrSlot) {
    qrSlot.innerHTML = '<div style="font-size:2.5rem;color:#ff5050;">✗</div>';
    qrSlot.style.background = 'rgba(255,80,80,0.08)';
    qrSlot.style.border = '2px solid #ff5050';
    qrSlot.style.padding = '0';
  }
  setTimeout(() => pop.remove(), 4000);
}

async function renderQRInto(target: HTMLElement, text: string): Promise<void> {
  try {
    const svg = await QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      width: 184,
      errorCorrectionLevel: 'L',
      color: { dark: '#000000', light: '#ffffff' },
    });
    target.innerHTML = svg;
    const svgEl = target.querySelector('svg');
    if (svgEl) {
      svgEl.style.cssText = 'display:block;width:100%;height:100%;border-radius:4px;';
    }
  } catch (err) {
    target.innerHTML = `<p style="color:#ff5050;font-size:0.8rem;">QR render failed</p>`;
    console.warn('[qr] render failed:', err);
  }
}

function openZapModal(state: GameState): void {
  // Avoid double-open
  document.querySelectorAll('.zap-modal').forEach(n => n.remove());

  const modal = el('div', { className: 'zap-modal', parent: root });
  const inner = el('div', { className: 'zap-modal-inner', parent: modal });

  el('h2', { parent: inner, text: 'ZAP THE CRYPTO DONKEY' });
  const addr = el('p', { parent: inner, text: DEV.lightningAddress });
  addr.style.cssText = 'font-size:0.95rem;color:var(--hud-blue);letter-spacing:0.06em;margin-top:-4px;';

  const desc = el('p', { parent: inner, text: 'Send sats over Lightning. NIP-57 zap if signed in, plain LNURL pay otherwise.' });
  desc.style.cssText = 'font-size:0.85rem;color:rgba(220,210,255,0.75);letter-spacing:0.04em;line-height:1.5;max-width:420px;';

  // Amount selector
  const amountLabel = el('p', { parent: inner, text: 'AMOUNT' });
  amountLabel.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);letter-spacing:0.4em;margin:14px 0 6px;';

  let chosenAmount = 100;
  const presetRow = el('div', { parent: inner });
  presetRow.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;';
  const presets = [21, 100, 1000, 10000];
  const presetButtons: HTMLButtonElement[] = [];

  const refreshPresets = (): void => {
    presetButtons.forEach((b, i) => {
      const selected = presets[i] === chosenAmount;
      b.style.cssText = [
        'background:' + (selected ? 'rgba(255,216,74,0.2)' : 'transparent'),
        'border:2px solid ' + (selected ? '#ffd84a' : 'rgba(180,140,255,0.4)'),
        'color:' + (selected ? '#ffd84a' : 'rgba(220,210,255,0.85)'),
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:1rem',
        'padding:6px 14px',
        'letter-spacing:0.1em',
        'cursor:pointer',
        'border-radius:6px',
        'transition:all 0.12s ease',
        selected ? 'box-shadow:0 0 14px rgba(255,216,74,0.4)' : '',
      ].filter(Boolean).join(';');
    });
  };

  for (const amount of presets) {
    const b = el('button', { parent: presetRow, text: amount >= 1000 ? `${amount / 1000}k` : amount.toString() });
    presetButtons.push(b);
    b.addEventListener('click', () => {
      chosenAmount = amount;
      customInput.value = '';
      refreshPresets();
    });
  }

  const customWrap = el('div', { parent: inner });
  customWrap.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px;';
  el('span', { parent: customWrap, text: 'CUSTOM:' }).style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.7);letter-spacing:0.18em;';
  const customInput = el('input', { parent: customWrap, attrs: { type: 'number', min: '1', max: '500000', placeholder: 'sats' } });
  customInput.style.cssText = 'background:rgba(0,0,0,0.5);border:2px solid rgba(180,140,255,0.4);color:#cfd6ff;font-family:inherit;font-size:1rem;padding:5px 10px;width:130px;border-radius:6px;';
  customInput.addEventListener('input', () => {
    const v = parseInt(customInput.value, 10);
    if (!isNaN(v) && v > 0) {
      chosenAmount = v;
      refreshPresets();
    }
  });
  refreshPresets();

  // Message
  const msgLabel = el('p', { parent: inner, text: 'MESSAGE (optional)' });
  msgLabel.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);letter-spacing:0.4em;margin:14px 0 6px;';
  const msgInput = el('input', { parent: inner, attrs: { maxlength: '180', placeholder: 'Loved Pallasite!' } });
  msgInput.style.cssText = 'background:rgba(0,0,0,0.5);border:2px solid rgba(91,157,255,0.4);color:#cfd6ff;font-family:inherit;font-size:0.95rem;padding:6px 12px;width:340px;max-width:100%;border-radius:6px;text-align:center;';

  // Status / invoice section
  const status = el('p', { parent: inner });
  status.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.7);letter-spacing:0.05em;margin-top:10px;min-height:1em;';

  const invoiceSection = el('div', { parent: inner });
  invoiceSection.style.cssText = 'display:none;flex-direction:column;gap:8px;align-items:center;width:100%;margin-top:8px;';

  // QR for the modal — bigger than the popover, prominent
  const qrWrap = el('div', { parent: invoiceSection });
  qrWrap.style.cssText = 'background:#fff;padding:10px;border-radius:8px;display:flex;align-items:center;justify-content:center;width:240px;height:240px;';

  const invoiceField = el('textarea', { parent: invoiceSection });
  invoiceField.setAttribute('readonly', 'true');
  invoiceField.style.cssText = 'background:rgba(0,0,0,0.5);border:1px solid rgba(91,157,255,0.4);color:#cfd6ff;font-family:ui-monospace,monospace;font-size:0.7rem;padding:8px 12px;width:100%;max-width:480px;height:64px;resize:none;border-radius:6px;text-align:left;letter-spacing:0;line-height:1.4;word-break:break-all;';

  const invoiceActions = el('div', { parent: invoiceSection });
  invoiceActions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';

  // Generate invoice button
  const genBtn = el('button', { parent: inner, text: 'GENERATE INVOICE' });
  genBtn.style.cssText = [
    'background:rgba(91,157,255,0.12)',
    'border:2px solid #5b9dff',
    'color:#5b9dff',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:1.05rem',
    'padding:8px 22px',
    'letter-spacing:0.15em',
    'cursor:pointer',
    'border-radius:6px',
    'margin-top:14px',
    'transition:all 0.12s ease',
  ].join(';');
  genBtn.addEventListener('click', async () => {
    if (chosenAmount < 1) {
      status.textContent = 'Pick an amount.';
      status.style.color = '#ff8a3a';
      return;
    }
    genBtn.disabled = true;
    genBtn.style.opacity = '0.5';
    status.textContent = 'Resolving lightning address…';
    status.style.color = '#5b9dff';

    try {
      const res = await requestZapInvoice(state.session, chosenAmount, msgInput.value || '');
      invoiceField.value = res.invoice;
      invoiceSection.style.display = 'flex';
      void renderQRInto(qrWrap, res.invoice.toUpperCase());
      status.textContent = res.isZap
        ? `✓ Zap request signed. Scan QR or click pay.`
        : `✓ Invoice ready. Scan QR or click pay (no zap receipt — sign in for one).`;
      status.style.color = '#58ff58';
      genBtn.style.display = 'none';
      buildInvoiceActions();

      // Try WebLN in parallel for desktop users
      if (hasWebLN()) {
        try {
          await payViaWebLN(res.invoice);
          status.textContent = `⚡ ZAPPED ${res.amountSats} SATS · THANK YOU`;
          status.style.color = '#ffd84a';
        } catch {
          // user cancelled or webln failed — QR + buttons remain
        }
      }
    } catch (err) {
      status.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      status.style.color = '#ff5050';
      genBtn.disabled = false;
      genBtn.style.opacity = '1';
    }
  });

  function buildInvoiceActions(): void {
    invoiceActions.innerHTML = '';
    const invoice = invoiceField.value;

    if (hasWebLN()) {
      const webln = el('button', { parent: invoiceActions, text: '⚡ PAY VIA WEBLN' });
      webln.style.cssText = [
        'background:rgba(255,216,74,0.18)',
        'border:2px solid #ffd84a',
        'color:#ffd84a',
        "font-family:'VT323',ui-monospace,monospace",
        'font-size:0.95rem',
        'padding:8px 18px',
        'letter-spacing:0.12em',
        'cursor:pointer',
        'border-radius:6px',
      ].join(';');
      webln.addEventListener('click', async () => {
        webln.disabled = true;
        webln.textContent = 'PAYING…';
        try {
          await payViaWebLN(invoice);
          status.textContent = '⚡ ZAPPED. Thank you.';
          status.style.color = '#ffd84a';
          webln.textContent = '✓ PAID';
        } catch (err) {
          status.textContent = `Payment cancelled or failed: ${err instanceof Error ? err.message : String(err)}`;
          status.style.color = '#ff5050';
          webln.disabled = false;
          webln.textContent = '⚡ PAY VIA WEBLN';
        }
      });
    }

    const copy = el('button', { parent: invoiceActions, text: 'COPY INVOICE' });
    copy.style.cssText = [
      'background:transparent',
      'border:2px solid #5b9dff',
      'color:#5b9dff',
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:0.95rem',
      'padding:8px 18px',
      'letter-spacing:0.12em',
      'cursor:pointer',
      'border-radius:6px',
    ].join(';');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(invoice);
        copy.textContent = '✓ COPIED';
        setTimeout(() => { copy.textContent = 'COPY INVOICE'; }, 2000);
      } catch {
        copy.textContent = 'COPY FAILED — SELECT MANUALLY';
      }
    });

    const wallet = el('a', { parent: invoiceActions, text: 'OPEN IN WALLET' });
    wallet.setAttribute('href', `lightning:${invoice}`);
    wallet.style.cssText = [
      'background:transparent',
      'border:2px solid rgba(180,140,255,0.6)',
      'color:rgba(220,210,255,0.85)',
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:0.95rem',
      'padding:8px 18px',
      'letter-spacing:0.12em',
      'cursor:pointer',
      'border-radius:6px',
      'text-decoration:none',
      'display:inline-block',
    ].join(';');
  }

  // Close button
  const closeRow = el('div', { parent: inner });
  closeRow.style.cssText = 'display:flex;justify-content:center;margin-top:14px;';
  const close = el('button', { parent: closeRow, text: 'CLOSE' });
  close.style.cssText = [
    'background:transparent',
    'border:2px solid rgba(180,140,255,0.5)',
    'color:rgba(220,210,255,0.85)',
    "font-family:'VT323',ui-monospace,monospace",
    'font-size:0.95rem',
    'padding:6px 18px',
    'letter-spacing:0.12em',
    'cursor:pointer',
    'border-radius:6px',
  ].join(';');
  close.addEventListener('click', () => modal.remove());

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) modal.remove();
  });

  // Close on Escape
  const escHandler = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') {
      modal.remove();
      window.removeEventListener('keydown', escHandler);
    }
  };
  window.addEventListener('keydown', escHandler);
}

function renderCreditsRoll(parent: HTMLElement, applyStage?: (e: HTMLElement) => void, state?: GameState): void {
  const panel = el('div', { className: 'credits-roll', parent });
  if (applyStage) applyStage(panel);
  const inner = el('div', { className: 'credits-roll-inner', parent: panel });

  const escape = escapeHtml;
  // Read from the single WAVE_LORE table (waves 1-24; skip the boss arena
  // entry since the credits already have a dedicated FINAL ARENA section).
  const specimens = WAVE_LORE.slice(0, 24);
  const specimensHtml = specimens.map(s =>
    `<p class="specimen"><span class="specimen-name">${escape(s.name)}</span><br><span class="specimen-sub">${escape(s.subtitle)}</span></p>`
  ).join('');

  // Guest mode shows the X handle; Nostr mode shows the full npub.
  const creatorLink = state?.session
    ? `<a href="${escape(DEV.profileUrl)}" target="_blank" rel="noopener noreferrer">${escape(DEV.npub)}</a>`
    : `<a href="${escape(DEV.twitterUrl)}" target="_blank" rel="noopener noreferrer">@${escape(DEV.twitter)}</a>`;

  inner.innerHTML = `
    <p class="credits-spacer"></p>
    <h3>A PALLASITE PRODUCTION</h3>
    <p class="credits-divider">· · ·</p>

    <h3>CREATED BY</h3>
    <p class="name">${escape(DEV.name.toUpperCase())}</p>
    <p>${creatorLink}</p>

    <p class="credits-divider">· · ·</p>

    <h3>GAME DESIGN · CODE · ART DIRECTION</h3>
    <p>The Crypto Donkey</p>

    <p class="credits-divider">· · ·</p>

    <h3>24 SPECIMENS CHARTED</h3>
    ${specimensHtml}

    <p class="credits-divider">· · ·</p>

    <h3>FINAL ARENA</h3>
    <p class="name">EVENT HORIZON</p>

    <p class="credits-divider">· · ·</p>

    <h3>POWERED BY</h3>
    <p><strong>Identity</strong> — Signet</p>
    <p>NIP-46 · NIP-07 · mysignet.app</p>
    <p></p>
    <p><strong>Leaderboard</strong> — gamestr</p>
    <p>kind 30762 player-signed scores</p>
    <p></p>
    <p><strong>Reputation</strong> — NIP-85</p>
    <p>kind 30382 user assertions</p>
    <p></p>
    <p><strong>Privacy</strong> — nostr-veil</p>
    <p>LSAG ring signatures over NIP-85</p>

    <p class="credits-divider">· · ·</p>

    <h3>BUILT WITH</h3>
    <p>TypeScript · Vite</p>
    <p>Canvas 2D · Web Audio API</p>
    <p>Procedural sound, no samples</p>
    <p></p>
    <p>Backgrounds via gpt-image-2</p>
    <p>Pallasite-themed cosmic photography</p>

    <p class="credits-divider">· · ·</p>

    <h3>PALLASITES</h3>
    <p>First proven by Peter Pallas, 1772.</p>
    <p>Stony-iron meteorites — silicate olivine</p>
    <p>embedded in iron-nickel matrix.</p>
    <p></p>
    <p>Cosmic origin: collision-disrupted</p>
    <p>parent body, core-mantle boundary.</p>

    <p class="credits-divider">· · ·</p>

    <h3>forgesworn · 2026</h3>
    <p class="name">SHOOT ROCKS · STACK SATS</p>

    <p class="credits-spacer"></p>
  `;
}

// ── Toast (tiny notification) ─────────────────────────────────────────────────

export function renderToast(state: GameState): void {
  // Remove old toast first
  document.querySelectorAll('.toast').forEach(t => t.remove());
  if (!state.toast) return;
  const t = el('div', { className: 'toast', parent: root, text: state.toast });
  setTimeout(() => t.remove(), 3000);
}

// Suppress unused warning — toastNow is re-exported for external triggers
void toastNow;
