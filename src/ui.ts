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
  getAsteroidStyle,
} from './a11y.js';
import { getHapticsEnabled, setHapticsEnabled, hapticsSupported } from './haptics.js';
import * as auth from './auth.js';
import { addLocalHighScore, getLocalHighScores, isHighScore, subscribeGlobalHighScores, clearLocalHighScores, type GlobalHighScore } from './score.js';
import { submitClaim, submitWithdraw, submitCheckin, fetchPool, fetchPlayer, fetchFlagged, type PlayerTier, type FlaggedEntry } from './faucet.js';
import {
  fetchReviewCases,
  generateJuryIdentity,
  getStoredJuryIdentity,
  setStoredJuryIdentity,
  clearStoredJuryIdentity,
  publishDelegation,
  type ReviewCase,
  type StoredJuryIdentity,
} from './jury.js';
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
import { requestZapInvoice, requestZapTo, hasWebLN, payViaWebLN, type ZapRecipient } from './zap.js';
import { subscribeRecentRuns, timeAgo, dismissWatchEntry, getDismissedWatchEntries, LIVE_FRESHNESS_MS, type WatchEntry } from './watch.js';
import { EXPERIMENTAL_RELAYS } from './credits.js';
import { STREAM_FRAME_KIND, getReplayBuffer } from './stream-session.js';
import { publishGhost, prefetchTopGhost, getCachedGhost, fetchGhostByScoreEventId, findScoreIdForLatestGhost, ghostPoseAt, ghostScoreAt, publishReplay, type GhostRun } from './ghost.js';
import { preloadBackground } from './render.js';
import { musicSetTrackForState } from './music.js';
import { savePersonalGhost } from './personal-ghost.js';
import { canCaptureClip, captureClip, shareClip, shareDailyStats } from './clip.js';
import { REPLAY_TOTAL_WALL_MS, REPLAY_EXPLOSION_WALL_MS } from './types.js';
import { getStreak, getBestStreak, markDailyCompleted, buildDailyShareText } from './streak.js';
import { markAchievement, getRunAchievements } from './achievements.js';
import { savePendingClaim, clearPendingClaim, getFreshPendingClaim, isTerminalClaimError } from './pending-claim.js';
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

  // Streak chip — only renders when the player has completed at least
  // one daily run. The number is the retention hook; once the player has
  // a streak to protect, the daily run pulls them back tomorrow.
  renderStreakChip(overlay);

  // Today's daily-seed leader — surfaces the standing top score on the
  // current daily seed so the title screen always has a visible "duel of
  // the day" hook. Empty state ("be the first") is itself motivating.
  renderDailyLeaderChip(overlay);

  // Persistent-balance chip — shows accumulated sats banked from prior
  // claims + a WITHDRAW button when balance crosses the threshold. Only
  // renders for signed-in players (anon balances live server-side
  // anyway, but the chip is a signed-in surface).
  renderBalanceChip(overlay, state);

  // Pending-claim recovery — if a previous run's claim failed (signer
  // hiccup, network blip, idle-skip dumped to title before retry), the
  // payload is still on localStorage within the server's 5-min replay
  // window. Surface a one-tap retry banner so the sats aren't orphaned.
  renderPendingClaimBanner(overlay, state);

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
  // Phone-as-controller — kicks off the pairing UI (QR code) and binds
  // accepted controller inputs into state.keys / state.targetHeading.
  // The host persists across the title→game transition; closing the
  // dialog with "KEEP CONNECTED" leaves the phone in charge.
  const phoneLabel = hasActiveControllerHost() ? '📱 PHONE · PAIRED' : '📱 USE PHONE';
  const phoneBtn = el('button', { className: 'menu-btn secondary', parent: row, text: phoneLabel });
  if (hasActiveControllerHost()) {
    phoneBtn.style.color = '#8cffb4';
    phoneBtn.style.borderColor = 'rgba(140,255,180,0.55)';
  }
  phoneBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    renderControllerHostPairing(state, () => renderTitle(state));
  });
  // Music player — was behind a hidden logo long-press, surfaced as a
  // real button so players can find it without discovering the gesture.
  const musicBtn = el('button', { className: 'menu-btn secondary', parent: row, text: '🎵 MUSIC' });
  musicBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    renderMusicPlayer(state, () => renderTitle(state));
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
/**
 * Streak chip — small horizontal chip surfacing the player's current
 * daily-completion streak and their best ever. Only renders when the
 * player has completed at least one daily run; before that there's
 * nothing to show. Streak number gets a yellow accent so the player
 * sees it as a thing they're protecting.
 */
function renderPendingClaimBanner(parent: HTMLElement, state: GameState): void {
  const session = state.session;
  if (!session) return;
  if (!session.signer.capabilities.canSignEvents) return;
  const pending = getFreshPendingClaim(session.pubkey);
  if (!pending) return;

  const wrap = el('div', { parent });
  wrap.style.cssText = [
    'display:flex', 'flex-direction:column', 'gap:8px', 'align-items:stretch',
    'margin:12px auto 4px', 'padding:10px 14px', 'max-width:340px',
    'border-radius:8px', 'background:rgba(255,128,80,0.08)',
    'border:1px solid rgba(255,128,80,0.45)',
    'text-align:center',
  ].join(';');

  const head = el('p', { parent: wrap });
  head.style.cssText = 'margin:0;font-size:0.82rem;color:#ffd84a;letter-spacing:0.08em';
  head.textContent = `UNCLAIMED · ${pending.payload.sats_claimed} SATS`;

  const sub = el('p', { parent: wrap });
  sub.style.cssText = 'margin:0;font-size:0.74rem;color:#cccccc;line-height:1.4';
  sub.textContent = `Wave ${pending.payload.wave} · ${pending.payload.score.toLocaleString()} score`;

  const btn = el('button', { className: 'menu-btn', parent: wrap, text: 'RETRY CLAIM' }) as HTMLButtonElement;
  btn.style.cssText = 'padding:6px 12px;font-size:0.85rem;cursor:pointer';

  const status = el('p', { parent: wrap });
  status.style.cssText = 'margin:0;min-height:1.1em;font-size:0.74rem;color:#888';

  const dismissBtn = el('button', { className: 'menu-btn secondary', parent: wrap, text: 'DISMISS' }) as HTMLButtonElement;
  dismissBtn.style.cssText = 'padding:4px 10px;font-size:0.72rem;cursor:pointer;opacity:0.7';
  onTap(dismissBtn, () => {
    clearPendingClaim();
    wrap.remove();
  });

  onTap(btn, () => {
    void (async () => {
      btn.disabled = true;
      dismissBtn.disabled = true;
      status.style.color = '#5b9dff';
      status.textContent = 'Validating…';
      try {
        const result = await submitClaim(session, pending.payload);
        if (result.ok) {
          clearPendingClaim();
          status.style.color = '#58ff58';
          status.textContent = `✓ Banked ${result.payout_sats} sats · balance: ${result.new_balance}`;
          btn.remove();
          dismissBtn.textContent = 'CLOSE';
          dismissBtn.disabled = false;
        } else {
          if (isTerminalClaimError(result.error)) {
            clearPendingClaim();
            status.style.color = '#ff8050';
            status.textContent = claimErrorMessage(result.error, result.detail);
            btn.remove();
            dismissBtn.textContent = 'CLOSE';
            dismissBtn.disabled = false;
          } else {
            status.style.color = '#ff8050';
            status.textContent = claimErrorMessage(result.error, result.detail);
            btn.disabled = false;
            dismissBtn.disabled = false;
          }
        }
      } catch (err) {
        status.style.color = '#ff8050';
        status.textContent = err instanceof Error ? err.message : 'Retry failed.';
        btn.disabled = false;
        dismissBtn.disabled = false;
      }
    })();
  });
}

/** Minimum balance before the WITHDRAW button activates. Avoids LN payment
 *  minima (some LSPs reject sub-10-sat invoices) and gives a satisfying
 *  "saving up" feel rather than nudging every player to withdraw 3 sats. */
const WITHDRAW_THRESHOLD_SATS = 100;

function renderBalanceChip(parent: HTMLElement, state: GameState): void {
  if (!state.session) return;
  const wrap = el('div', { parent });
  wrap.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center', 'gap:6px',
    'margin:10px auto 4px', 'padding:10px 14px', 'max-width:340px',
    'border-radius:8px', 'background:rgba(91,157,255,0.05)',
    'border:1px solid rgba(91,157,255,0.30)',
    'text-align:center',
  ].join(';');

  const head = el('p', { parent: wrap });
  head.style.cssText = 'margin:0;font-size:0.78rem;color:rgba(180,180,180,0.85);letter-spacing:0.08em';
  head.textContent = 'BALANCE · loading…';

  const sub = el('p', { parent: wrap });
  sub.style.cssText = 'margin:0;font-size:0.72rem;color:#888;line-height:1.4';

  const stipendLine = el('p', { parent: wrap });
  stipendLine.style.cssText = 'margin:0;font-size:0.72rem;color:#ffd84a;line-height:1.4;min-height:0';
  stipendLine.style.display = 'none';

  const withdrawBtn = el('button', { className: 'menu-btn', parent: wrap, text: 'WITHDRAW' }) as HTMLButtonElement;
  withdrawBtn.style.cssText = 'padding:6px 12px;font-size:0.85rem;cursor:pointer;display:none';

  const session = state.session;

  const renderBalance = (balance: number): void => {
    head.innerHTML = `BALANCE <span style="color:#5b9dff;font-weight:bold;">${balance}</span>`;
    if (balance >= WITHDRAW_THRESHOLD_SATS) {
      withdrawBtn.style.display = 'inline-block';
      sub.textContent = `Ready to withdraw.`;
    } else {
      withdrawBtn.style.display = 'none';
      sub.textContent = `Withdraw unlocks at ${WITHDRAW_THRESHOLD_SATS} sats.`;
    }
    onTap(withdrawBtn, () => openWithdrawDialog(state, balance));
  };

  // Daily check-in stipend: fire-and-forget on title mount. Idempotent
  // per UTC day, so re-renders within the same day are no-ops. Lands a
  // +1 sat credit and shows a brief yellow stipend line.
  void submitCheckin(session).then((c) => {
    if (!wrap.isConnected) return;
    if (c.ok && c.credited > 0) {
      stipendLine.style.display = 'block';
      stipendLine.textContent = `+${c.credited} daily check-in`;
      renderBalance(c.new_balance);
      return c.new_balance;
    } else if (c.ok && !c.already_checked_in_today) {
      // ok with credited=0 means hit the lifetime tier cap silently
    }
    return null;
  }).then((preBalance) => {
    if (!wrap.isConnected) return;
    if (preBalance !== null) return; // already rendered from checkin
    void fetchPlayer(session.pubkey).then((p) => {
      if (!wrap.isConnected) return;
      if (!p) {
        head.textContent = 'BALANCE · unavailable';
        sub.textContent = '';
        return;
      }
      renderBalance(p.balance_sats);
    });
  });
}

function openWithdrawDialog(state: GameState, balanceSats: number): void {
  const session = state.session;
  if (!session) return;

  // Backdrop + modal — uses the same z-stack as the recap overlays so
  // settings + how-to-play don't fight for layer order.
  const backdrop = el('div');
  backdrop.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.78)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9000', 'padding:20px',
  ].join(';');
  document.body.appendChild(backdrop);

  const card = el('div', { parent: backdrop });
  card.style.cssText = [
    'background:#0a0a0a', 'border:1px solid #333', 'border-radius:10px',
    'padding:18px 22px', 'max-width:360px', 'width:100%',
    'display:flex', 'flex-direction:column', 'gap:10px',
  ].join(';');

  const head = el('h3', { parent: card, text: 'WITHDRAW SATS' });
  head.style.cssText = 'margin:0;font-size:1.1rem;color:#5b9dff;letter-spacing:0.12em';

  const balLine = el('p', { parent: card });
  balLine.style.cssText = 'margin:0;font-size:0.82rem;color:#cccccc';
  balLine.textContent = `Balance: ${balanceSats} sats`;

  const label = el('p', { parent: card, text: 'Lightning address — where do you want sats sent?' });
  label.style.cssText = 'margin:6px 0 0 0;font-size:0.8rem;color:#aaa';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'alice@yourwallet.com';
  input.spellcheck = false;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.style.cssText =
    'padding:8px 10px;font-family:inherit;font-size:0.9rem;' +
    'background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
  const stored = getStoredLnAddress();
  input.value = state.profile?.lud16 ?? stored ?? '';
  card.appendChild(input);

  const amountLabel = el('p', { parent: card, text: 'Amount (sats)' });
  amountLabel.style.cssText = 'margin:6px 0 0 0;font-size:0.8rem;color:#aaa';
  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.min = String(10);
  amountInput.max = String(balanceSats);
  amountInput.value = String(balanceSats);
  amountInput.style.cssText =
    'padding:8px 10px;font-family:inherit;font-size:0.9rem;' +
    'background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
  card.appendChild(amountInput);

  const status = el('p', { parent: card });
  status.style.cssText = 'margin:4px 0 0 0;font-size:0.78rem;min-height:1.1em;color:#888';

  const buttonRow = el('div', { parent: card });
  buttonRow.style.cssText = 'display:flex;gap:8px;margin-top:6px';
  const cancelBtn = el('button', { className: 'menu-btn secondary', parent: buttonRow, text: 'CANCEL' }) as HTMLButtonElement;
  cancelBtn.style.cssText = 'flex:1;padding:8px;font-size:0.85rem;cursor:pointer';
  const confirmBtn = el('button', { className: 'menu-btn', parent: buttonRow, text: 'WITHDRAW' }) as HTMLButtonElement;
  confirmBtn.style.cssText = 'flex:1;padding:8px;font-size:0.85rem;cursor:pointer';

  const close = (): void => { try { backdrop.remove(); } catch { /* ignore */ } };
  onTap(cancelBtn, close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  onTap(confirmBtn, () => {
    void (async () => {
      const addr = input.value.trim();
      if (!LN_ADDRESS_RE.test(addr)) {
        status.textContent = 'Invalid lightning address.';
        status.style.color = '#ff5050';
        return;
      }
      const amount = Math.floor(Number(amountInput.value));
      if (!Number.isFinite(amount) || amount < 10) {
        status.textContent = 'Amount must be at least 10 sats.';
        status.style.color = '#ff5050';
        return;
      }
      if (amount > balanceSats) {
        status.textContent = `Balance is only ${balanceSats} sats.`;
        status.style.color = '#ff5050';
        return;
      }
      setStoredLnAddress(addr);
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      status.textContent = 'Paying…';
      status.style.color = '#5b9dff';
      try {
        const result = await submitWithdraw(session, {
          amount_sats: amount,
          lightning_address: addr,
        });
        if (result.ok) {
          status.textContent = `✓ Paid ${result.amount_sats} sats · balance: ${result.new_balance}`;
          status.style.color = '#58ff58';
          confirmBtn.textContent = 'CLOSE';
          confirmBtn.disabled = false;
          confirmBtn.onclick = () => { close(); renderTitle(state); };
          cancelBtn.style.display = 'none';
        } else {
          status.textContent = withdrawErrorMessage(result.error, result.detail);
          status.style.color = '#ff8050';
          confirmBtn.disabled = false;
          cancelBtn.disabled = false;
        }
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Withdraw failed.';
        status.style.color = '#ff8050';
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    })();
  });
}

function withdrawErrorMessage(error: string, detail?: string): string {
  switch (error) {
    case 'insufficient_balance': return 'Not enough balance.';
    case 'invalid_lightning_address': return 'Invalid lightning address.';
    case 'invalid_payload': return 'Invalid request.';
    case 'no_balance': return 'No balance to withdraw.';
    case 'player_flagged': return 'Account flagged. Contact dev.';
    case 'pool_empty': return 'Float low — try again later.';
    case 'payment_unavailable': return 'Payment service unavailable. Try later.';
    case 'ln_resolve_failed':
    case 'ln_invoice_failed': return 'Could not get an invoice from your wallet.';
    case 'payment_failed': return 'Payment failed. Try later.';
    case 'invoice_mismatch': return 'Invoice did not match expected amount.';
    case 'no_signer': return 'Cannot sign with this session.';
    case 'sign_failed': {
      if (!detail) return 'Could not sign request. Check your signer.';
      if (/timeout|signer-timeout/i.test(detail)) return 'Signer did not respond.';
      if (/reject|denied|cancel/i.test(detail)) return 'Signature rejected.';
      return `Sign failed: ${detail.slice(0, 80)}`;
    }
    case 'network_error': return 'Network error. Check connection.';
    default:
      return `Withdraw failed: ${error}${detail ? ' — ' + detail.slice(0, 80) : ''}`;
  }
}

function renderStreakChip(parent: HTMLElement): void {
  const current = getStreak();
  if (current < 1) return;
  const best = getBestStreak();
  const wrap = el('div', { parent });
  wrap.style.cssText = [
    'display:inline-flex', 'gap:14px', 'align-items:center',
    'padding:6px 14px', 'border-radius:999px',
    'background:rgba(255,216,74,0.06)', 'border:1px solid rgba(255,216,74,0.35)',
    'font-size:0.78rem', 'letter-spacing:0.16em',
    'color:rgba(220,210,255,0.75)',
  ].join(';');
  const cur = el('span', { parent: wrap });
  cur.innerHTML = `STREAK <span style="color:#ffd84a;font-weight:bold;">${current}</span>`;
  if (best > current) {
    const bst = el('span', { parent: wrap });
    bst.innerHTML = `BEST <span style="color:rgba(255,216,74,0.6);">${best}</span>`;
  }
}

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

// ── Live theatre (NIP-53 kind 30311 stream → kind 22769 frames) ────────────
//
// Pairs with src/stream-session.ts. The watching browser:
//   1. Subscribes to kind 22769 events with #p=<master_pubkey>
//   2. Each arriving frame is parsed for ship pose (x, y, r) +
//      score + wave + frame_t (millisecond timestamp the player
//      captured the pose)
//   3. RAF loop linearly interpolates ship position between the two
//      most-recent frames in the buffer for smooth motion at 60fps
//      even though the wire frequency is ~2 Hz
//   4. HUD shows latest score + wave
//   5. CLOSE returns to the watch grid
//
// Trust model: v1 trusts the relay set to deliver only authentic
// frames (we read from relay.trotters.cc only, controlled by us).
// v2 will verify against the NIP-53 kind 30311 event — fetch the
// stream-key role's pubkey, accept only frames signed by it.

interface LiveTheatreInput {
  masterPubkey: string;
  displayName: string;
  initialScore: number;
  initialWave: number;
  /** Approximate run-start time (unix ms). Used as the `since` filter
   *  when polling for the player's kind 30763 ghost after STREAM ENDED
   *  so the re-watch button can find the right replay. */
  runStartedAtMs: number;
  onClose: () => void;
}

interface LiveAsteroid {
  id: number;
  x: number;
  y: number;
  size: 'l' | 'm' | 's';
  type: 's' | 'i' | 'c' | 'p';
  rot: number;
}
interface LiveUfo {
  id: number;
  x: number;
  y: number;
  type: 's' | 'p' | 't' | 'e' | 'c' | 'b';
}
interface LiveMine { id: number; x: number; y: number; }
interface LiveBullet { id: number; x: number; y: number; vx: number; vy: number; enemy: boolean; }
interface LiveCoin { id: number; x: number; y: number; kind: 's' | 'd'; sourceType: 's' | 'i' | 'c' | 'p' | ''; }
interface LivePowerup { id: number; x: number; y: number; type: 'r' | 'b' | 'n' | 't' | 'm'; }
type LiveEventCode = 'ak' | 'uk' | 'md' | 'sh' | 'sb' | 'vc' | 'pu' | 'fi';
interface LiveSfxEvent { code: LiveEventCode; x: number; y: number; }

interface LiveFrame {
  /** When the player captured this frame (unix ms). */
  capturedAt: number;
  /** When this client received the frame from the relay (perf ms). */
  receivedAt: number;
  x: number;
  y: number;
  r: number;
  score: number;
  wave: number;
  lives: number;
  sats: number;
  thrust: boolean;
  alive: boolean;
  shielded: boolean;
  paused: boolean;
  asteroids: LiveAsteroid[];
  ufos: LiveUfo[];
  mines: LiveMine[];
  bullets: LiveBullet[];
  coins: LiveCoin[];
  powerups: LivePowerup[];
  events: LiveSfxEvent[];
}

interface WireWorld {
  v?: number;
  a?: unknown;
  u?: unknown;
  m?: unknown;
  b?: unknown;
  c?: unknown;
  pu?: unknown;
  e?: unknown;
  shield?: number;
  dead?: number;
  paused?: number;
}

const KNOWN_EVENT_CODES: ReadonlySet<LiveEventCode> = new Set([
  'ak', 'uk', 'md', 'sh', 'sb', 'vc', 'pu', 'fi',
]);
function parseEvents(raw: unknown): LiveSfxEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveSfxEvent[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const [code, x, y] = item;
    if (typeof code !== 'string' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (!KNOWN_EVENT_CODES.has(code as LiveEventCode)) continue;
    out.push({ code: code as LiveEventCode, x, y });
  }
  return out;
}

function parseWireWorld(content: string): WireWorld {
  if (!content) return {};
  try {
    const obj = JSON.parse(content);
    if (!obj || typeof obj !== 'object') return {};
    return obj as WireWorld;
  } catch {
    return {};
  }
}

function parseAsteroids(raw: unknown): LiveAsteroid[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveAsteroid[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 6) continue;
    const [id, x, y, size, type, rot] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number' || typeof rot !== 'number') continue;
    if (size !== 'l' && size !== 'm' && size !== 's') continue;
    if (type !== 's' && type !== 'i' && type !== 'c' && type !== 'p') continue;
    out.push({ id, x, y, size, type, rot });
  }
  return out;
}
function parseUfos(raw: unknown): LiveUfo[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveUfo[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [id, x, y, type] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (type !== 's' && type !== 'p' && type !== 't' && type !== 'e' && type !== 'c' && type !== 'b') continue;
    out.push({ id, x, y, type });
  }
  return out;
}
function parseMines(raw: unknown): LiveMine[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveMine[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const [id, x, y] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    out.push({ id, x, y });
  }
  return out;
}
function parseCoins(raw: unknown): LiveCoin[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveCoin[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [id, x, y, kind, sourceType] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (kind !== 's' && kind !== 'd') continue;
    const src = (sourceType === 's' || sourceType === 'i' || sourceType === 'c' || sourceType === 'p') ? sourceType : '';
    out.push({ id, x, y, kind, sourceType: src as LiveCoin['sourceType'] });
  }
  return out;
}
function parsePowerups(raw: unknown): LivePowerup[] {
  if (!Array.isArray(raw)) return [];
  const out: LivePowerup[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [id, x, y, type] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (type !== 'r' && type !== 'b' && type !== 'n' && type !== 't' && type !== 'm') continue;
    out.push({ id, x, y, type });
  }
  return out;
}
function parseBullets(raw: unknown): LiveBullet[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveBullet[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 4) continue;
    // v2g wire shape: [id, x, y, vx, vy, enemy]. v2b/v2c/v2d/v2e/v2f used
    // [id, x, y, enemy] (no velocity). Accept both so a viewer can still
    // read older relayed events without crashing.
    let id: unknown, x: unknown, y: unknown, vx: unknown, vy: unknown, enemy: unknown;
    if (item.length >= 6) {
      [id, x, y, vx, vy, enemy] = item;
    } else {
      [id, x, y, enemy] = item;
      vx = 0;
      vy = 0;
    }
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    const vxn = typeof vx === 'number' ? vx : 0;
    const vyn = typeof vy === 'number' ? vy : 0;
    out.push({ id, x, y, vx: vxn, vy: vyn, enemy: enemy === 1 });
  }
  return out;
}

function readLiveFrame(event: { tags: string[][]; content?: string }): LiveFrame | null {
  let frameT: number | null = null;
  let x: number | null = null;
  let y: number | null = null;
  let r: number | null = null;
  let score = 0;
  let wave = 0;
  let lives = 0;
  let sats = 0;
  let thrust = false;
  for (const tag of event.tags) {
    switch (tag[0]) {
      case 'frame_t': frameT = parseInt(tag[1] ?? '', 10); break;
      case 'x': x = parseFloat(tag[1] ?? ''); break;
      case 'y': y = parseFloat(tag[1] ?? ''); break;
      case 'r': r = parseFloat(tag[1] ?? ''); break;
      case 'score': score = parseInt(tag[1] ?? '0', 10) || 0; break;
      case 'wave': wave = parseInt(tag[1] ?? '0', 10) || 0; break;
      case 'lives': lives = parseInt(tag[1] ?? '0', 10) || 0; break;
      case 'sats': sats = parseInt(tag[1] ?? '0', 10) || 0; break;
      case 'thrust': thrust = tag[1] === '1'; break;
    }
  }
  if (frameT === null || !Number.isFinite(frameT)) return null;
  if (x === null || y === null || r === null) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r)) return null;
  const world = parseWireWorld(event.content ?? '');
  return {
    capturedAt: frameT,
    receivedAt: performance.now(),
    x, y, r, score, wave, lives, sats, thrust,
    alive: world.dead !== 1,
    shielded: world.shield === 1,
    paused: world.paused === 1,
    asteroids: parseAsteroids(world.a),
    ufos: parseUfos(world.u),
    mines: parseMines(world.m),
    bullets: parseBullets(world.b),
    coins: parseCoins(world.c),
    powerups: parsePowerups(world.pu),
    events: parseEvents(world.e),
  };
}

function renderLiveTheatre(input: LiveTheatreInput): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'LIVE · WATCHING' });

  const nameEl = el('p', { parent: overlay, text: input.displayName.toUpperCase() });
  nameEl.style.cssText = 'margin:6px 0 4px;font-size:1.2rem;letter-spacing:0.18em;color:#8cffb4;text-shadow:0 0 10px rgba(140,255,180,0.5);';

  const stat = el('p', { parent: overlay });
  stat.style.cssText = 'margin:0 0 14px;font-size:0.92rem;color:rgba(220,210,255,0.8);letter-spacing:0.1em;';
  // Show "Connecting…" until the first real frame lands — initialScore
  // and initialWave can be 0 for a player who has just clicked IGNITE
  // (their first heartbeat is wave=0, score=0), which used to surface
  // a misleading "WAVE 0 · 0 SCORE" line.
  if (input.initialWave > 0 || input.initialScore > 0) {
    stat.textContent = `WAVE ${input.initialWave} · ${input.initialScore.toLocaleString()} SCORE`;
  } else {
    stat.textContent = 'Tuning in…';
  }

  // Sized to viewport. We pick the larger of "stay within the viewport
  // padding" and a min width so the canvas feels like a real watch
  // screen on desktop. Internal resolution scales with DPR so the ship
  // and HUD are crisp on retina displays (the v1 fixed 600×375
  // canvas displayed at 2x looked blurry).
  const cssWidthMax = Math.min(window.innerWidth - 32, 980);
  const cssWidth = Math.max(360, cssWidthMax);
  const cssHeight = Math.round(cssWidth * PALL_WORLD_H / PALL_WORLD_W);
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const CANVAS_W = Math.round(cssWidth * dpr);
  const CANVAS_H = Math.round(cssHeight * dpr);
  const canvas = el('canvas', { parent: overlay, attrs: { width: String(CANVAS_W), height: String(CANVAS_H) } });
  canvas.style.cssText = `border:1px solid rgba(140,255,180,0.45);border-radius:8px;background:#02050d;display:block;margin:0 auto;width:${cssWidth}px;height:${cssHeight}px;max-width:100%;box-shadow:0 0 18px rgba(140,255,180,0.18);`;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    el('p', { parent: overlay, text: 'Canvas unsupported in this browser.' });
    return;
  }
  // Match the device pixel ratio so 1 game unit becomes one CSS pixel
  // after the implicit canvas → screen scale. The render loop also
  // multiplies world coordinates by sx/sy (canvas-internal/world)
  // which already accounts for both DPR and aspect.
  void ctx;

  const status = el('p', { parent: overlay, text: 'Subscribing to relay…' });
  status.style.cssText = 'margin:10px 0 4px;font-size:0.9rem;color:rgba(140,255,180,0.8);letter-spacing:0.08em;min-height:1.2em;';

  const liveScore = el('p', { parent: overlay });
  liveScore.style.cssText = 'margin:6px 0 0;font-size:1.4rem;letter-spacing:0.18em;color:var(--hud-yellow);text-shadow:0 0 12px rgba(255,216,74,0.5);min-height:1.4em;';
  // Same "waiting on first frame" guard as the stat line so the HUD
  // doesn't shout "WAVE 0 · 0" before any data arrives.
  if (input.initialWave > 0 || input.initialScore > 0) {
    liveScore.textContent = `WAVE ${input.initialWave} · ${input.initialScore.toLocaleString()}`;
  } else {
    liveScore.textContent = '';
  }
  // Lives + sats sub-line — separate row so it can be styled smaller
  // and update independently of the big score readout.
  const liveStats = el('p', { parent: overlay });
  liveStats.style.cssText = 'margin:2px 0 0;font-size:0.95rem;letter-spacing:0.16em;color:rgba(220,210,255,0.78);min-height:1.2em;';
  liveStats.textContent = '';

  const closeRow = el('div', { className: 'menu-row', parent: overlay });
  // "WATCH FROM START" — only shown once STREAM ENDED fires. Polls
  // for the player's kind 30763 ghost (published at claim time) and
  // hands off to renderReplayTheatre when found. The button sits in
  // the same row as CLOSE so spectators see a single clean choice
  // row after the stream ends.
  const replayBtn = el('button', { className: 'menu-btn', parent: closeRow, text: 'WATCH FROM START' }) as HTMLButtonElement;
  replayBtn.style.display = 'none';
  const closeBtn = el('button', { className: 'menu-btn secondary', parent: closeRow, text: 'CLOSE · ESC' });
  const replayHint = el('p', { parent: overlay });
  replayHint.style.cssText = 'margin:6px 0 0;font-size:0.78rem;color:rgba(180,140,255,0.65);letter-spacing:0.08em;min-height:1em;text-align:center;';

  // Replay button state machine: idle → loading → (success | not_yet).
  // Auto-tries once on STREAM ENDED so a recently-claimed run replays
  // with no extra click. If first attempt fails, leaves a retry button.
  let replayState: 'hidden' | 'idle' | 'loading' | 'not_yet' | 'success' = 'hidden';
  let replayAutoTried = false;
  const setReplayState = (next: typeof replayState, hint = ''): void => {
    replayState = next;
    switch (next) {
      case 'hidden':
        replayBtn.style.display = 'none';
        replayHint.textContent = '';
        return;
      case 'idle':
        replayBtn.style.display = '';
        replayBtn.disabled = false;
        replayBtn.textContent = 'WATCH FROM START';
        replayHint.textContent = hint;
        return;
      case 'loading':
        replayBtn.style.display = '';
        replayBtn.disabled = true;
        replayBtn.textContent = 'LOADING…';
        replayHint.textContent = 'Fetching the ghost recording from relays…';
        return;
      case 'not_yet':
        replayBtn.style.display = '';
        replayBtn.disabled = false;
        replayBtn.textContent = 'TRY AGAIN';
        replayHint.textContent = 'Player has not claimed yet — the ghost is published at claim time.';
        return;
      case 'success':
        replayBtn.style.display = 'none';
        replayHint.textContent = '';
        return;
    }
  };
  const tryFetchReplay = async (): Promise<void> => {
    if (replayState === 'loading') return;
    setReplayState('loading');
    const sinceSec = Math.max(0, Math.floor(input.runStartedAtMs / 1000));
    let scoreEventId: string | null = null;
    try {
      scoreEventId = await findScoreIdForLatestGhost(input.masterPubkey, sinceSec);
    } catch { /* fall through to not_yet */ }
    if (cancelled) return;
    if (!scoreEventId) {
      setReplayState('not_yet');
      return;
    }
    // Hand off to the replay theatre — closes the live theatre and
    // opens the ghost playback in its place. onClose chains back to
    // whatever the live theatre was returning to (the watch page).
    setReplayState('success');
    const latest = frames[frames.length - 1];
    const finalScore = latest?.score ?? input.initialScore;
    const finalWave = latest?.wave ?? input.initialWave;
    cleanup();
    renderReplayTheatre({
      scoreEventId,
      displayName: input.displayName,
      score: finalScore,
      wave: finalWave,
      sats: 0,
      onClose: input.onClose,
    });
  };
  replayBtn.addEventListener('click', () => { void tryFetchReplay(); });

  // Wave assets — preload the most recent wave's background image so
  // the canvas can paint it once it's decoded. Music comes from the
  // shared music.ts pipeline, keyed on a synthetic playing-phase state
  // so musicSetTrackForState resolves the same wave-band track the
  // player is hearing.
  let currentWaveAsset = 0;
  const bgImage = new Image();
  bgImage.decoding = 'async';
  // Wave banner — when frame.wave increments (or on the very first
  // frame), we flash a "WAVE N · NAME · subtitle" banner over the
  // canvas for a few seconds so the spectator gets the same wave-intro
  // beat the player gets.
  let waveBannerShownAt = 0;
  let waveBannerWave = 0;
  const WAVE_BANNER_MS = 3500;
  const applyWaveAssets = (wave: number, isInitial = false): void => {
    if (wave === currentWaveAsset || wave < 1) return;
    currentWaveAsset = wave;
    preloadBackground(wave);
    bgImage.src = `/backgrounds/wave-${wave}.webp`;
    // Synthetic state for music — only the fields trackForState reads
    // need values. Keep this minimal so we don't accidentally trip
    // anything else through musicSetTrackForState.
    try {
      musicSetTrackForState({ phase: 'playing', wave } as unknown as GameState);
    } catch { /* ignore */ }
    // Trigger the banner — skip on the very first call so the spectator
    // doesn't see a banner the moment they open the theatre. The first
    // real wave-change after that gets a banner.
    if (!isInitial) {
      waveBannerShownAt = performance.now();
      waveBannerWave = wave;
    }
  };
  applyWaveAssets(Math.max(1, input.initialWave), true);

  // Stable starfield — generated once. Used as a layer ABOVE the
  // wave background image so the canvas still has motion-cues when
  // the bg is solid colour or hasn't loaded yet.
  const stars: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 80; i++) {
    stars.push({ x: Math.random() * CANVAS_W, y: Math.random() * CANVAS_H, r: 0.6 + Math.random() * 1.4 });
  }

  // Ring buffer of recent frames. Keep ~6s worth so a slow update path
  // can still interpolate without skipping.
  const FRAME_BUFFER_MAX = 24;
  const frames: LiveFrame[] = [];
  let rafId: number | null = null;
  let cancelled = false;
  const sockets: WebSocket[] = [];

  const cleanup = (): void => {
    cancelled = true;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null; }
    for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') { cleanup(); input.onClose(); }
  };
  closeBtn.addEventListener('click', () => { cleanup(); input.onClose(); });
  window.addEventListener('keydown', onKey);

  const pushFrame = (frame: LiveFrame): void => {
    // De-dupe by capturedAt (relays can echo the same event).
    if (frames.length > 0 && frames[frames.length - 1].capturedAt === frame.capturedAt) return;
    // Out-of-order: discard older arrivals.
    if (frames.length > 0 && frame.capturedAt < frames[frames.length - 1].capturedAt) return;
    frames.push(frame);
    if (frames.length > FRAME_BUFFER_MAX) frames.shift();
    liveScore.textContent = `WAVE ${frame.wave} · ${frame.score.toLocaleString()}`;
    // Lives as ♥ glyphs; sats as ₿. Game caps lives at 3 typically so
    // the row stays compact. 0 lives shows an empty ♥♥♥ frame in red
    // so a watcher reads the "last life" tension.
    const heartsTotal = Math.max(0, frame.lives);
    const hearts = heartsTotal > 0
      ? '♥'.repeat(Math.min(5, heartsTotal))
      : 'NO LIVES';
    liveStats.textContent = `${hearts}  ·  ₿ ${frame.sats}`;
    liveStats.style.color = heartsTotal > 0 ? 'rgba(220,210,255,0.78)' : 'rgba(255,120,120,0.9)';
    // Music + bg follow the live wave the player is on — re-apply when
    // the wave changes so a spectator who joins mid-run still gets the
    // matching ambience as the player crosses wave boundaries.
    if (frame.wave > 0) applyWaveAssets(frame.wave);
    // Defer SFX bursts until playbackT reaches the event's captured
    // time. Earlier we fired them immediately on frame arrival, which
    // put explosions on screen ~350ms BEFORE the interpolated ship/
    // entity reached the death position. Buffering keeps the explosion
    // in lockstep with the ship the spectator is watching.
    for (const ev of frame.events) {
      pendingEvents.push({ code: ev.code, x: ev.x, y: ev.y, dueAt: frame.capturedAt });
    }
  };

  // Subscribe directly to kind 22769 events #p=<master>. v1 trusts
  // the relay; v2 will verify the session pubkey against the NIP-53
  // kind 30311 stream-key role tag.
  let frameCount = 0;
  // Reconnect watchdog — kind 22769 is ephemeral so most relays don't
  // serve historic frames on subscribe; we wait for the next live
  // frame from the player. If something raced (relay hadn't registered
  // our REQ before the player's last publish), we can sit on "Connected
  // · waiting for first frame…" indefinitely. The watchdog forces a
  // fresh subscription after 2.5s of silence on first join — once we
  // start getting frames it idles until needed again.
  let watchdog: number | null = null;
  const armWatchdog = (subOpen: () => void): void => {
    if (watchdog !== null) window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      if (cancelled) return;
      if (frameCount > 0) return;
      // Tear down + rebuild — closes the old sockets cleanly first so
      // the relay doesn't end up with two subs from us.
      for (const s of sockets) try { s.close(); } catch { /* ignore */ }
      sockets.length = 0;
      status.textContent = 'Reconnecting…';
      subOpen();
    }, 2500);
  };
  const openSubscriptions = (): void => {
    for (const url of EXPERIMENTAL_RELAYS) {
      if (cancelled) break;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { continue; }
      sockets.push(ws);
      const subId = 'lt' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify([
            'REQ',
            subId,
            {
              kinds: [STREAM_FRAME_KIND],
              '#p': [input.masterPubkey],
              // 60s look-back is mostly a no-op for ephemeral kinds
              // (relays don't persist them) but harmless on the wire.
              since: Math.floor(Date.now() / 1000) - 60,
            },
          ]));
          status.textContent = `Connected · waiting for first frame…`;
        } catch { /* ignore */ }
      };
      ws.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const frame = readLiveFrame(msg[2] as { tags: string[][] });
            if (frame) {
              pushFrame(frame);
              frameCount += 1;
              status.textContent = `Live · ${frameCount} frame${frameCount === 1 ? '' : 's'} received`;
              if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null; }
            }
          }
        } catch { /* ignore */ }
      };
    }
    armWatchdog(openSubscriptions);
  };
  openSubscriptions();

  const c2d = canvas.getContext('2d')!;
  // World-space (PALL_WORLD_W × PALL_WORLD_H) → canvas-space (with DPR
  // baked in). Hoisted so we compute once per resize rather than every
  // frame.
  const sx = CANVAS_W / PALL_WORLD_W;
  const sy = CANVAS_H / PALL_WORLD_H;
  // Ship is drawn in game-world coordinates (the same constants
  // render.ts uses: 14, -10, -6, 8) then scaled by sx so it occupies
  // the same fraction of the canvas as in the player's view.
  const shipScale = sx;

  // Asteroid styling — drawn from the live a11y palette so the watch
  // theatre tracks the same hue + glow combos the player is seeing
  // (default vs high-contrast). hueBase drives the stroke colour via
  // HSL exactly like render.ts drawAsteroid.
  const WIRE_TYPE_TO_GAME: Record<'s' | 'i' | 'c' | 'p', 'stony' | 'iron' | 'chondrite' | 'pallasite'> = {
    s: 'stony', i: 'iron', c: 'chondrite', p: 'pallasite',
  };
  // Match game's RADIUS_PER_SIZE — the v2d radii were a fraction too
  // small, which made asteroids feel undersized vs the player's view.
  const ASTEROID_RADIUS_WORLD: Record<'l' | 'm' | 's', number> = {
    l: 48, m: 26, s: 14,
  };
  // UFO type-letter → radius. Wire only carries the letter so the
  // viewer derives the size. Mirrors game.ts UFO_RADIUS.
  const UFO_RADIUS_WORLD: Record<'s' | 'p' | 't' | 'e' | 'c' | 'b', number> = {
    s: 22, p: 14, t: 30, e: 12, c: 22, b: 50,
  };
  // Per-type palette matches render.ts UFO_PALETTE so saucers look
  // saucer-orange and the boss reads as a red-and-gold menace.
  interface UfoPaletteEntry { primary: string; accent: string; shadow: string; cockpit: string; }
  const UFO_PALETTE: Record<'s' | 'p' | 't' | 'e' | 'c' | 'b', UfoPaletteEntry> = {
    s: { primary: '#ff8a3a', accent: '#ffd1a3', shadow: '#5a2d10', cockpit: '#ffe9c0' },
    c: { primary: '#ff8a3a', accent: '#ffd1a3', shadow: '#5a2d10', cockpit: '#ffe9c0' },
    e: { primary: '#ff5050', accent: '#ffd0d0', shadow: '#3d0808', cockpit: '#ff9090' },
    t: { primary: '#ff3a3a', accent: '#ff9a9a', shadow: '#330808', cockpit: '#ff7070' },
    p: { primary: '#7fffea', accent: '#bfffff', shadow: '#08322e', cockpit: '#cffffd' },
    b: { primary: '#ff5050', accent: '#ffd84a', shadow: '#1a0303', cockpit: '#ffd84a' },
  };

  // Deterministic per-asteroid lumpy outline, seeded by id so the same
  // asteroid keeps the same silhouette across frames without us having
  // to ship the shape on the wire. Matches the game's asteroid look
  // (7-10 sides, 0.82-1.14 radius wobble) closely enough that a
  // spectator can't distinguish from the player's canvas.
  const shapeCache = new Map<number, number[]>();
  const asteroidShape = (id: number): number[] => {
    const hit = shapeCache.get(id);
    if (hit) return hit;
    let s = (id * 2654435761) >>> 0;
    const r = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
    const sides = 8 + Math.floor(r() * 3);
    const shape: number[] = [];
    for (let i = 0; i < sides; i++) shape.push(0.82 + r() * 0.32);
    shapeCache.set(id, shape);
    return shape;
  };

  // Position interp helper — short-way-around so an asteroid wrapping
  // off one edge and reappearing on the other doesn't draw a streak
  // straight across the canvas. If the delta exceeds half the world
  // dimension on either axis, assume a wrap and snap to next.
  const interpAxis = (a: number, b: number, k: number, worldSpan: number): number => {
    const delta = b - a;
    if (Math.abs(delta) > worldSpan * 0.5) return b;
    return a + delta * k;
  };

  // Local particle system — purely viewer-side. Spawned on receipt of
  // SFX events (asteroid_kill, ufo_kill, mine_detonate, ship_destroyed,
  // shield_burst, vein_collapse). Wire pays nothing for these — the
  // events themselves are already on the wire, particles are just the
  // visual response. Bounded so a frenetic stream can't blow up frame
  // time on weaker devices.
  interface LiveParticle { x: number; y: number; vx: number; vy: number; ttl: number; ttlMax: number; colour: string; size: number; }
  // Debris — line-segment shards from ship-destroyed bursts. Matches
  // render.ts drawDebris look: tumbling angled segments fading to zero.
  interface LiveDebris { x: number; y: number; vx: number; vy: number; rot: number; rotV: number; ttl: number; ttlMax: number; length: number; colour: string; }
  // Pending SFX events — buffered with the frame's player-time capture
  // moment, drained in the tick when playbackT reaches them so the
  // explosion lines up with the interpolated ship/entity.
  interface PendingEvent { code: LiveEventCode; x: number; y: number; dueAt: number; }
  const particles: LiveParticle[] = [];
  const debris: LiveDebris[] = [];
  const pendingEvents: PendingEvent[] = [];
  const MAX_PARTICLES = 240;
  const MAX_DEBRIS = 48;
  const spawnDebris = (cx: number, cy: number, count: number): void => {
    // Pure ship-green (#58ff58) — matches game.ts spawnShipDebris.
    // Game emits exactly 4 segments (the hull triangle's four edges)
    // with ttl 1500ms; we approximate with `count` randomly-oriented
    // segments since the SFX event carries no rotation. Sizes match
    // the hull edge lengths (8-24 world units).
    for (let i = 0; i < count && debris.length < MAX_DEBRIS; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 70 + Math.random() * 80;
      debris.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: Math.random() * Math.PI * 2,
        rotV: (Math.random() - 0.5) * 6,
        ttl: 1500,
        ttlMax: 1500,
        length: 8 + Math.random() * 16,
        colour: '#58ff58',
      });
    }
  };
  const spawnBurst = (cx: number, cy: number, count: number, colour: string, speed: number, ttl: number, size = 2): void => {
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.6 + Math.random() * 0.8);
      particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        ttl, ttlMax: ttl, colour, size: size * (0.7 + Math.random() * 0.7),
      });
    }
  };

  // Playback clock — advances at 1× real time using performance.now()
  // so it's completely independent of player/viewer wall-clock drift.
  // Anchored to the player's Date.now() time-base on first frame, so
  // we can still match against frame.capturedAt for prev/next lookup.
  // The earlier renderAt = Date.now() - 600 approach was the source of
  // the asteroid jitter — any clock skew between player and viewer
  // dragged the interpolation window off the frame data.
  let playbackT = 0;
  let lastPerfMs = performance.now();
  // 350ms behind the live edge with 250ms frame cadence — enough to
  // bracket prev/next reliably and absorb a single dropped frame, low
  // enough that the perceived delay feels live.
  const PLAYBACK_LEAD_MS = 350;
  const PLAYBACK_LAG_LIMIT_MS = 2000;

  // Render loop — interpolate between adjacent frames for smooth motion
  // at 60fps even when the wire delivers 2 Hz.
  const tick = (): void => {
    if (cancelled) return;
    rafId = requestAnimationFrame(tick);
    const nowPerf = performance.now();
    const dtMs = nowPerf - lastPerfMs;
    lastPerfMs = nowPerf;

    // 1. Wave background (cover-fit, dimmed). Falls through to the
    // solid base colour while the image is still decoding.
    c2d.fillStyle = '#02050d';
    c2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (bgImage.complete && bgImage.naturalWidth > 0) {
      c2d.globalAlpha = 0.68;
      const ar = bgImage.naturalWidth / bgImage.naturalHeight;
      const canvasAr = CANVAS_W / CANVAS_H;
      let drawW = CANVAS_W, drawH = CANVAS_H;
      if (ar > canvasAr) drawW = CANVAS_H * ar;
      else drawH = CANVAS_W / ar;
      const drawX = (CANVAS_W - drawW) / 2;
      const drawY = (CANVAS_H - drawH) / 2;
      c2d.drawImage(bgImage, drawX, drawY, drawW, drawH);
      c2d.globalAlpha = 1;
    }
    // 2. Starfield overlay (subtle parallax look).
    c2d.fillStyle = 'rgba(220,210,255,0.55)';
    for (const s of stars) {
      c2d.beginPath();
      c2d.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      c2d.fill();
    }

    if (frames.length === 0) {
      // No frames yet — wait.
      return;
    }
    // Advance the playback clock and clamp it to the frame buffer.
    const latestCap = frames[frames.length - 1].capturedAt;
    const oldestCap = frames[0].capturedAt;
    if (playbackT === 0) playbackT = latestCap - PLAYBACK_LEAD_MS;
    playbackT += dtMs;
    // Don't outrun the live edge — pin at "latest - small lead" so we
    // always have a `next` frame ahead of us to interpolate toward.
    if (playbackT > latestCap - 100) playbackT = latestCap - 100;
    // Hard resync if we've fallen way behind (e.g. tab was backgrounded
    // for a while and frames piled up).
    if (playbackT < oldestCap || latestCap - playbackT > PLAYBACK_LAG_LIMIT_MS) {
      playbackT = latestCap - PLAYBACK_LEAD_MS;
    }

    // Drain SFX events whose captured time playbackT has now passed.
    // Particle palette + counts mirror game.ts so the spectator sees
    // exactly the explosion the player saw:
    //   killShip:    42 green + 22 yellow + 18 white + line-segment debris
    //   destroyUfo:  26-36 red (averaging 30 since type isn't on the wire)
    //   asteroid break (small only):  ~14 of the asteroid's hue, derived
    //   from the source style. We don't know the type letter at SFX time
    //   either, so fall back to a chondrite-like cyan-violet mix that
    //   reads as a generic asteroid break.
    while (pendingEvents.length > 0 && pendingEvents[0].dueAt <= playbackT) {
      const ev = pendingEvents.shift()!;
      try {
        switch (ev.code) {
          case 'ak':
            audio.explosion(0.8);
            spawnBurst(ev.x, ev.y, 14, '#b48cff', 220, 500);
            break;
          case 'uk':
            // Same red as game.ts destroyUfo (#ff5050). Count 30 sits
            // between cruiser/elite/sniper (26) and tank (36).
            audio.explosion(1.0);
            spawnBurst(ev.x, ev.y, 30, '#ff5050', 220, 800);
            break;
          case 'md':
            audio.explosion(0.7);
            spawnBurst(ev.x, ev.y, 18, '#ff5050', 220, 600);
            break;
          case 'sh':
            // Match killShip layered explosion exactly: ship-green burst
            // + yellow flash + white sparks + line-segment debris.
            audio.explosion(1.4);
            spawnBurst(ev.x, ev.y, 42, '#58ff58', 280, 1100);
            spawnBurst(ev.x, ev.y, 22, '#ffd84a', 200,  700);
            spawnBurst(ev.x, ev.y, 18, '#ffffff', 380,  450);
            // Game emits 4 hull-edge segments — match the count, not 14.
            spawnDebris(ev.x, ev.y, 4);
            break;
          case 'sb':
            audio.shieldUp();
            spawnBurst(ev.x, ev.y, 10, '#5b9dff', 140, 380);
            break;
          case 'vc':
            audio.explosion(1.2);
            spawnBurst(ev.x, ev.y, 36, '#ffd84a', 320, 900);
            spawnBurst(ev.x, ev.y, 14, '#ff8ad6', 280, 700);
            break;
          case 'pu': audio.powerupPickup(); break;
          case 'fi': audio.fire(); break;
        }
      } catch { /* ignore audio errors */ }
    }
    // Guardrail: drop any pending events that are way behind us (a
    // playback resync just happened) so they don't fire all at once.
    while (pendingEvents.length > 0 && playbackT - pendingEvents[0].dueAt > 2_000) {
      pendingEvents.shift();
    }
    let prev = frames[0];
    let next = frames[0];
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].capturedAt <= playbackT) prev = frames[i];
      if (frames[i].capturedAt >= playbackT) { next = frames[i]; break; }
    }
    const span = next.capturedAt - prev.capturedAt;
    const t = span > 0 ? Math.max(0, Math.min(1, (playbackT - prev.capturedAt) / span)) : 0;
    // Ship wraps too — same short-way-around treatment as entities.
    const x = interpAxis(prev.x, next.x, t, PALL_WORLD_W) * sx;
    const y = interpAxis(prev.y, next.y, t, PALL_WORLD_H) * sy;
    // Rotation lerp — pick the short way around the circle.
    let dr = next.r - prev.r;
    while (dr > Math.PI) dr -= Math.PI * 2;
    while (dr < -Math.PI) dr += Math.PI * 2;
    const rot = prev.r + dr * t;
    const thrusting = (t < 0.5 ? prev.thrust : next.thrust);

    // 2b. Entities — asteroids, UFOs, mines, bullets — interpolated by
    // id across the prev/next frame pair the same way the ship pose
    // is. New entities (present in `next` but not `prev`) appear at
    // their `next` position; destroyed entities (in `prev` not `next`)
    // disappear cleanly. Rotation lerp uses short-way-around so
    // asteroids don't flip direction at the seam.
    const prevAst = new Map<number, LiveAsteroid>();
    for (const a of prev.asteroids) prevAst.set(a.id, a);
    const prevUfo = new Map<number, LiveUfo>();
    for (const u of prev.ufos) prevUfo.set(u.id, u);
    const prevMine = new Map<number, LiveMine>();
    for (const m of prev.mines) prevMine.set(m.id, m);
    const prevBullet = new Map<number, LiveBullet>();
    for (const b of prev.bullets) prevBullet.set(b.id, b);

    const lerpRot = (a: number, b: number, k: number): number => {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return a + d * k;
    };

    for (const aNext of next.asteroids) {
      const aPrev = prevAst.get(aNext.id) ?? aNext;
      const ax = interpAxis(aPrev.x, aNext.x, t, PALL_WORLD_W) * sx;
      const ay = interpAxis(aPrev.y, aNext.y, t, PALL_WORLD_H) * sy;
      const aRot = lerpRot(aPrev.rot, aNext.rot, t);
      const rWorld = ASTEROID_RADIUS_WORLD[aNext.size];
      const rCanvas = rWorld * sx;
      const gameType = WIRE_TYPE_TO_GAME[aNext.type];
      const style = getAsteroidStyle(gameType);
      const wobble = asteroidShape(aNext.id);
      // Stable per-id hue jitter so the asteroid doesn't flat-shade
      // identically to its neighbours — game uses a.hue in 0..100 to
      // perturb lightness around hueBase.
      let h = (aNext.id * 2654435761) >>> 0;
      h = (h * 1664525 + 1013904223) >>> 0;
      const hueJitter = (h / 0x100000000) * 100;
      const lightness = 60 + hueJitter * 0.2;
      const stroke = `hsl(${style.hueBase}, 70%, ${lightness}%)`;
      c2d.save();
      c2d.translate(ax, ay);
      c2d.rotate(aRot);
      c2d.strokeStyle = stroke;
      c2d.lineWidth = gameType === 'iron' ? 2.0 * dpr : 1.4 * dpr;
      c2d.shadowColor = style.glow;
      c2d.shadowBlur = (gameType === 'pallasite' ? 14 : 8) * dpr;
      const SIDES = wobble.length;
      c2d.beginPath();
      for (let i = 0; i < SIDES; i++) {
        const ang = (i / SIDES) * Math.PI * 2;
        const r = rCanvas * wobble[i];
        const px = Math.cos(ang) * r;
        const py = Math.sin(ang) * r;
        if (i === 0) c2d.moveTo(px, py); else c2d.lineTo(px, py);
      }
      c2d.closePath();
      c2d.stroke();

      // Iron: inner armour ring at 62% radius — game uses this while
      // hp > 1. We don't know hp on the wire, so always show it (looks
      // close enough; the ring strips on hit-flash via particles).
      if (gameType === 'iron') {
        c2d.lineWidth = 1.0 * dpr;
        c2d.globalAlpha = 0.55;
        c2d.beginPath();
        for (let i = 0; i < SIDES; i++) {
          const ang = (i / SIDES) * Math.PI * 2;
          const r = rCanvas * wobble[i] * 0.62;
          const px = Math.cos(ang) * r;
          const py = Math.sin(ang) * r;
          if (i === 0) c2d.moveTo(px, py); else c2d.lineTo(px, py);
        }
        c2d.closePath();
        c2d.stroke();
        c2d.globalAlpha = 1;
      }

      // Pallasite: olivine sparkle dots — animated, signals jackpot.
      // Synthetic time-driven phase so the watcher sees it pulse even
      // though we don't carry the player's animation clock.
      if (gameType === 'pallasite') {
        const count = aNext.size === 'l' ? 7 : aNext.size === 'm' ? 4 : 2;
        const tnow = performance.now() * 0.001;
        for (let i = 0; i < count; i++) {
          const tt = tnow + i * 0.7;
          const phase = (Math.sin(tt * 1.3 + i) + 1) * 0.5;
          const ang = (Math.PI * 2 * i) / count + tt * 0.4;
          const dist = rCanvas * (0.3 + 0.4 * Math.sin(tt + i));
          c2d.fillStyle = '#ffd84a';
          c2d.shadowColor = '#ffd84a';
          c2d.shadowBlur = 8 * dpr;
          c2d.globalAlpha = 0.5 + phase * 0.5;
          c2d.beginPath();
          c2d.arc(Math.cos(ang) * dist, Math.sin(ang) * dist, 1.6 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.globalAlpha = 1;
      }

      // Chondrite: short crystal accents on every other vertex — brittle look
      if (gameType === 'chondrite') {
        c2d.lineWidth = 0.8 * dpr;
        c2d.globalAlpha = 0.55;
        c2d.strokeStyle = '#cfeaff';
        for (let i = 0; i < SIDES; i += 2) {
          const ang = (i / SIDES) * Math.PI * 2;
          const r = rCanvas * wobble[i];
          const px = Math.cos(ang) * r;
          const py = Math.sin(ang) * r;
          c2d.beginPath();
          c2d.moveTo(px * 0.9, py * 0.9);
          c2d.lineTo(px, py);
          c2d.stroke();
        }
        c2d.globalAlpha = 1;
      }

      c2d.restore();
    }

    // UFO drawing — per-type silhouettes matching render.ts so a
    // spectator sees the same hunter saucer / sniper lozenge / boss
    // monster they'd see in the player's canvas. Synthetic blink from
    // wall-clock since we don't carry the player's animation state.
    const ufoBlink = performance.now() * 0.001 * 1.4;
    for (const uNext of next.ufos) {
      const uPrev = prevUfo.get(uNext.id) ?? uNext;
      const ux = interpAxis(uPrev.x, uNext.x, t, PALL_WORLD_W) * sx;
      const uy = interpAxis(uPrev.y, uNext.y, t, PALL_WORLD_H) * sy;
      // Derive facing from interpolated motion — sniper especially
      // reads as "looking at you" with the cyclops eye aimed at +x.
      const dxFacing = (uNext.x - uPrev.x);
      const facing: 1 | -1 = dxFacing < -0.01 ? -1 : 1;
      const col = UFO_PALETTE[uNext.type];
      const rW = UFO_RADIUS_WORLD[uNext.type];
      const r = rW * sx;
      c2d.save();
      c2d.translate(ux, uy);
      c2d.lineWidth = 1.5 * dpr;
      c2d.strokeStyle = col.primary;
      c2d.shadowColor = col.primary;
      c2d.shadowBlur = 12 * dpr;

      if (uNext.type === 't') {
        // Tank — squat hex with armour seams + gun barrels along
        // the bottom + viewport scanner band.
        const w = r * 2.6;
        const h = r * 1.2;
        const bodyGrad = c2d.createRadialGradient(0, -h * 0.2, h * 0.2, 0, 0, w * 0.55);
        bodyGrad.addColorStop(0, col.accent);
        bodyGrad.addColorStop(0.55, col.primary);
        bodyGrad.addColorStop(1, col.shadow);
        const hexPts: [number, number][] = [
          [-w * 0.5, 0], [-w * 0.32, -h * 0.5], [w * 0.32, -h * 0.5],
          [w * 0.5, 0], [w * 0.32, h * 0.5], [-w * 0.32, h * 0.5],
        ];
        c2d.beginPath();
        hexPts.forEach((p, i) => i === 0 ? c2d.moveTo(p[0], p[1]) : c2d.lineTo(p[0], p[1]));
        c2d.closePath();
        c2d.fillStyle = bodyGrad;
        c2d.fill();
        c2d.stroke();
        // Three gun barrels
        c2d.fillStyle = col.shadow;
        c2d.lineWidth = 2 * dpr;
        for (const gx of [-w * 0.35, 0, w * 0.35]) {
          c2d.beginPath();
          c2d.rect(gx - 1.5 * dpr, h * 0.5, 3 * dpr, 6 * dpr);
          c2d.fill();
          c2d.stroke();
        }
        c2d.lineWidth = 1.5 * dpr;
        c2d.strokeStyle = col.primary;
        // Viewport scanner band
        const tankPulse = 0.7 + 0.3 * Math.sin(ufoBlink * 3);
        const vGrad = c2d.createLinearGradient(-w * 0.18, 0, w * 0.18, 0);
        vGrad.addColorStop(0, col.shadow);
        vGrad.addColorStop(0.5, col.cockpit);
        vGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = vGrad;
        c2d.globalAlpha = 0.7 + tankPulse * 0.3;
        c2d.beginPath();
        c2d.rect(-w * 0.18, -h * 0.34, w * 0.36, 4 * dpr);
        c2d.fill();
        c2d.globalAlpha = 1;
      } else if (uNext.type === 'p') {
        // Sniper — sleek elongated lozenge with single cyclops eye.
        const len = r * 2.8;
        const halfW = r * 0.85;
        c2d.scale(facing, 1);
        const bodyGrad = c2d.createLinearGradient(-len * 0.5, 0, len * 0.5, 0);
        bodyGrad.addColorStop(0, col.shadow);
        bodyGrad.addColorStop(0.5, col.primary);
        bodyGrad.addColorStop(0.85, col.accent);
        bodyGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = bodyGrad;
        c2d.beginPath();
        c2d.moveTo(len * 0.50, 0);
        c2d.bezierCurveTo(len * 0.45, -halfW, -len * 0.20, -halfW, -len * 0.46, -halfW * 0.35);
        c2d.lineTo(-len * 0.46, halfW * 0.35);
        c2d.bezierCurveTo(-len * 0.20, halfW, len * 0.45, halfW, len * 0.50, 0);
        c2d.closePath();
        c2d.fill();
        c2d.stroke();
        // Swept fins
        c2d.fillStyle = col.shadow;
        for (const sgn of [-1, 1]) {
          c2d.beginPath();
          c2d.moveTo(-len * 0.15, sgn * halfW * 0.6);
          c2d.lineTo(-len * 0.32, sgn * halfW * 1.85);
          c2d.lineTo(len * 0.05, sgn * halfW * 0.6);
          c2d.closePath();
          c2d.fill();
          c2d.stroke();
        }
        // Cyclops eye
        const eyePulse = 0.65 + 0.35 * Math.sin(ufoBlink * 4);
        c2d.fillStyle = col.shadow;
        c2d.beginPath();
        c2d.arc(len * 0.28, 0, halfW * 0.55, 0, Math.PI * 2);
        c2d.fill();
        c2d.stroke();
        const irisGrad = c2d.createRadialGradient(len * 0.28, 0, 0, len * 0.28, 0, halfW * 0.5);
        irisGrad.addColorStop(0, '#ffffff');
        irisGrad.addColorStop(0.4, col.cockpit);
        irisGrad.addColorStop(1, col.primary);
        c2d.fillStyle = irisGrad;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = (10 + eyePulse * 8) * dpr;
        c2d.globalAlpha = 0.85;
        c2d.beginPath();
        c2d.arc(len * 0.28, 0, halfW * 0.4 * eyePulse, 0, Math.PI * 2);
        c2d.fill();
        c2d.globalAlpha = 1;
      } else if (uNext.type === 'b') {
        // Boss — outer rotating ring with 8 ports, inner counter-ring,
        // central body with pulsing core. Synthetic rotation from wall-
        // clock so the rings spin even without the player's u.blink.
        c2d.strokeStyle = col.primary;
        c2d.lineWidth = 1 * dpr;
        c2d.globalAlpha = 0.18 + 0.12 * Math.sin(ufoBlink * 2);
        c2d.shadowBlur = 30 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 1.35, 0, Math.PI * 2);
        c2d.stroke();
        c2d.globalAlpha = 1;
        // Outer ring
        c2d.save();
        c2d.rotate(ufoBlink);
        c2d.lineWidth = 2 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 1.1, 0, Math.PI * 2);
        c2d.stroke();
        for (let i = 0; i < 8; i++) {
          const a = (Math.PI * 2 * i) / 8;
          const px = Math.cos(a) * r * 1.1;
          const py = Math.sin(a) * r * 1.1;
          c2d.fillStyle = col.primary;
          c2d.shadowBlur = 12 * dpr;
          c2d.beginPath();
          c2d.arc(px, py, 4 * dpr, 0, Math.PI * 2);
          c2d.fill();
          c2d.fillStyle = col.cockpit;
          c2d.shadowBlur = 6 * dpr;
          c2d.beginPath();
          c2d.arc(px, py, 1.5 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.restore();
        // Counter-rotating inner ring
        c2d.save();
        c2d.rotate(-ufoBlink * 0.7);
        c2d.lineWidth = 1.5 * dpr;
        c2d.strokeStyle = col.primary;
        c2d.shadowBlur = 14 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.85, 0, Math.PI * 2);
        c2d.stroke();
        c2d.restore();
        // Body
        const bodyGrad = c2d.createRadialGradient(0, -r * 0.2, r * 0.1, 0, 0, r * 0.9);
        bodyGrad.addColorStop(0, col.primary);
        bodyGrad.addColorStop(0.6, col.shadow);
        bodyGrad.addColorStop(1, '#000');
        c2d.fillStyle = bodyGrad;
        c2d.lineWidth = 2 * dpr;
        c2d.shadowBlur = 14 * dpr;
        c2d.beginPath();
        c2d.ellipse(0, 0, r * 0.9, r * 0.5, 0, 0, Math.PI * 2);
        c2d.fill();
        c2d.stroke();
        // Pulsing core
        const pulse = 0.7 + 0.3 * Math.sin(ufoBlink * 3);
        c2d.fillStyle = `rgba(255,216,74,${pulse * 0.7})`;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = 18 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.22, 0, Math.PI * 2);
        c2d.fill();
      } else {
        // Saucer family — cruiser / elite / generic saucer. Disc body
        // with cockpit dome on top + glowing rim lights at the bottom.
        const w = r * 2.2;
        const h = r * 1.0;
        const bodyGrad = c2d.createRadialGradient(0, -h * 0.15, h * 0.15, 0, 0, w * 0.55);
        bodyGrad.addColorStop(0, col.accent);
        bodyGrad.addColorStop(0.6, col.primary);
        bodyGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = bodyGrad;
        c2d.beginPath();
        c2d.ellipse(0, 0, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
        c2d.fill();
        c2d.stroke();
        // Cockpit dome — top half ellipse
        c2d.fillStyle = col.cockpit;
        c2d.globalAlpha = 0.85;
        c2d.beginPath();
        c2d.ellipse(0, -h * 0.25, w * 0.22, h * 0.35, 0, Math.PI, 0);
        c2d.fill();
        c2d.globalAlpha = 1;
        c2d.beginPath();
        c2d.ellipse(0, -h * 0.25, w * 0.22, h * 0.35, 0, Math.PI, 0);
        c2d.stroke();
        // Rim lights — three small glows underneath
        const litPulse = 0.7 + 0.3 * Math.sin(ufoBlink * 4);
        for (const gx of [-w * 0.25, 0, w * 0.25]) {
          c2d.fillStyle = col.accent;
          c2d.shadowColor = col.primary;
          c2d.shadowBlur = (6 + litPulse * 4) * dpr;
          c2d.beginPath();
          c2d.arc(gx, h * 0.32, 2.2 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
      }
      c2d.restore();
    }

    // Mines — match render.ts drawMine: outward-pulsing gravity rings,
    // dark core, pulsing red ring, six rotating spikes. Constants
    // mirror types.ts MINE_RADIUS (11) and game's gravityRange (60-ish).
    for (const mNext of next.mines) {
      const mPrev = prevMine.get(mNext.id) ?? mNext;
      const mx = interpAxis(mPrev.x, mNext.x, t, PALL_WORLD_W) * sx;
      const my = interpAxis(mPrev.y, mNext.y, t, PALL_WORLD_H) * sy;
      const mineAge = nowPerf * 0.001;
      const pulse = 0.5 + 0.5 * Math.sin(nowPerf * 0.005);
      const mineR = 11 * sx;
      const gravR = 80 * sx;
      c2d.save();
      c2d.translate(mx, my);
      // Gravity well rings
      c2d.lineWidth = 1 * dpr;
      for (let i = 0; i < 3; i++) {
        const phase = ((mineAge * 0.5 + i / 3) % 1);
        const r = gravR * phase;
        const alpha = (1 - phase) * 0.18;
        c2d.strokeStyle = `rgba(255, 80, 80, ${alpha})`;
        c2d.beginPath();
        c2d.arc(0, 0, r, 0, Math.PI * 2);
        c2d.stroke();
      }
      // Dark core
      c2d.shadowColor = '#ff5050';
      c2d.shadowBlur = (14 + pulse * 8) * dpr;
      c2d.fillStyle = '#1a0808';
      c2d.beginPath();
      c2d.arc(0, 0, mineR, 0, Math.PI * 2);
      c2d.fill();
      // Pulsing red ring
      c2d.lineWidth = 1.5 * dpr;
      c2d.strokeStyle = `rgba(255, 80, 80, ${0.6 + pulse * 0.4})`;
      c2d.beginPath();
      c2d.arc(0, 0, mineR, 0, Math.PI * 2);
      c2d.stroke();
      // Spike pattern
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI * 2 * i) / 6 + mineAge * 0.3;
        const x1 = Math.cos(a) * (mineR - 2 * dpr);
        const y1 = Math.sin(a) * (mineR - 2 * dpr);
        const x2 = Math.cos(a) * (mineR + 4 * dpr);
        const y2 = Math.sin(a) * (mineR + 4 * dpr);
        c2d.strokeStyle = `rgba(255, 80, 80, ${0.7 + pulse * 0.3})`;
        c2d.beginPath();
        c2d.moveTo(x1, y1);
        c2d.lineTo(x2, y2);
        c2d.stroke();
      }
      c2d.restore();
    }

    // Bullets — extrapolate from the most recent frame using velocity
    // on the wire (vx, vy). Bullets move ~500px/sec, so even at 4Hz
    // wire cadence the inter-frame gap is 60-125 world units; without
    // extrapolation they snap visibly between samples. With it they
    // glide at 60fps just like in the player's canvas.
    // Direction unit vector comes from velocity directly so the streak
    // points the right way even on the bullet's very first appearance.
    const bulletExtrapMs = playbackT - next.capturedAt;
    for (const bNext of next.bullets) {
      const vx = bNext.vx;
      const vy = bNext.vy;
      const speed = Math.hypot(vx, vy);
      // Position = next.pos + velocity × (playbackT - next.capturedAt).
      // If extrapMs is negative we're between prev and next — same
      // formula works (it interpolates back from `next`).
      const ext = bulletExtrapMs / 1000;
      let xw = bNext.x + vx * ext;
      let yw = bNext.y + vy * ext;
      // World wrap — same behaviour the game enforces, so a bullet
      // that crosses an edge in the extrapolated window still draws
      // at the right side.
      if (xw < 0) xw += PALL_WORLD_W;
      if (xw > PALL_WORLD_W) xw -= PALL_WORLD_W;
      if (yw < 0) yw += PALL_WORLD_H;
      if (yw > PALL_WORLD_H) yw -= PALL_WORLD_H;
      const bx = xw * sx;
      const by = yw * sy;
      let ux = 1, uy = 0;
      if (speed > 0.01) { ux = vx / speed; uy = vy / speed; }
      const len = Math.max(6 * dpr, Math.min(speed * 0.012 * sx, 30 * dpr));
      const trailLen = len * 3.5;
      c2d.save();
      // Trail (faint, flat alpha — much cheaper than gradient)
      c2d.strokeStyle = bNext.enemy ? 'rgba(255,170,40,0.30)' : 'rgba(255,90,90,0.30)';
      c2d.lineWidth = 1.6 * dpr;
      c2d.beginPath();
      c2d.moveTo(bx, by);
      c2d.lineTo(bx - ux * trailLen, by - uy * trailLen);
      c2d.stroke();
      // Glowing head streak
      c2d.lineWidth = bNext.enemy ? 2.6 * dpr : 2.2 * dpr;
      c2d.strokeStyle = bNext.enemy ? '#ffffff' : '#ff5050';
      c2d.shadowColor = bNext.enemy ? '#ff6a00' : '#ff5050';
      c2d.shadowBlur = (bNext.enemy ? 14 : 10) * dpr;
      c2d.beginPath();
      c2d.moveTo(bx - ux * len * 0.5, by - uy * len * 0.5);
      c2d.lineTo(bx + ux * len * 0.5, by + uy * len * 0.5);
      c2d.stroke();
      if (bNext.enemy) {
        c2d.fillStyle = '#ffd84a';
        c2d.beginPath();
        c2d.arc(bx, by, 1.6 * dpr, 0, Math.PI * 2);
        c2d.fill();
      }
      c2d.restore();
    }

    // Coins — sat ₿ glyph (gold) or dust shard (source-tinted). The
    // glyph approach matches render.ts drawCoin closely enough that a
    // spectator sees the same "₿ here" flash that the player does.
    // Dust shards use the asteroid glow palette so iron drops orange,
    // pallasite drops yellow, etc.
    const COIN_RADIUS_WORLD = 6;
    const coinR = COIN_RADIUS_WORLD * sx;
    const tnowS = nowPerf * 0.001;
    const DUST_SOURCE_TYPES: Record<'s' | 'i' | 'c' | 'p', 'stony' | 'iron' | 'chondrite' | 'pallasite'> = {
      s: 'stony', i: 'iron', c: 'chondrite', p: 'pallasite',
    };
    for (const cNext of next.coins) {
      const cPrev = prev.coins.find((p) => p.id === cNext.id) ?? cNext;
      const cx = interpAxis(cPrev.x, cNext.x, t, PALL_WORLD_W) * sx;
      const cy = interpAxis(cPrev.y, cNext.y, t, PALL_WORLD_H) * sy;
      if (cNext.kind === 's') {
        // Sat coin — gold ₿ with stretching wobble.
        const wobble = 1 + 0.08 * Math.sin(nowPerf * 0.008 + cNext.x);
        c2d.save();
        c2d.translate(cx, cy);
        c2d.scale(wobble, 1 / wobble);
        c2d.lineWidth = 1.6 * dpr;
        c2d.strokeStyle = '#ffd84a';
        c2d.shadowColor = '#ffd84a';
        c2d.shadowBlur = 10 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, coinR, 0, Math.PI * 2);
        c2d.stroke();
        c2d.fillStyle = '#ffd84a';
        c2d.font = `bold ${Math.round((COIN_RADIUS_WORLD + 2) * sx)}px ui-monospace, monospace`;
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillText('₿', 0, 0);
        c2d.textAlign = 'start';
        c2d.textBaseline = 'alphabetic';
        c2d.restore();
      } else {
        // Dust shard — tumbling small facet, tinted by source type.
        const sourceKey = cNext.sourceType === '' ? 'stony' : DUST_SOURCE_TYPES[cNext.sourceType];
        const style = getAsteroidStyle(sourceKey);
        const dustColour = sourceKey === 'stony' ? '#7fffb0' : style.glow;
        const tumble = tnowS * 3 + cNext.x * 0.02;
        const r = coinR * 0.95;
        c2d.save();
        c2d.translate(cx, cy);
        c2d.rotate(tumble);
        c2d.lineWidth = 1.4 * dpr;
        c2d.strokeStyle = dustColour;
        c2d.shadowColor = dustColour;
        c2d.shadowBlur = 9 * dpr;
        // Simple diamond facet — readable at the small dust radius.
        c2d.beginPath();
        c2d.moveTo(0, -r);
        c2d.lineTo(r * 0.7, 0);
        c2d.lineTo(0, r);
        c2d.lineTo(-r * 0.7, 0);
        c2d.closePath();
        c2d.stroke();
        c2d.restore();
      }
    }

    // Powerups — match render.ts drawPowerUp: outer halo + inner disc +
    // bright core + glyph. POWERUP_CONFIG colours/glyphs are inlined so
    // the viewer doesn't need to import the full game config.
    const POWERUP_VIZ: Record<'r' | 'b' | 'n' | 't' | 'm', { glyph: string; colour: string }> = {
      r: { glyph: '⚡', colour: '#ff8a3a' },
      b: { glyph: '₿', colour: '#ffd84a' },
      n: { glyph: '◉', colour: '#ff5050' },
      t: { glyph: '🜂', colour: '#7fffea' },
      m: { glyph: '☉', colour: '#b48cff' },
    };
    const POWERUP_RADIUS_WORLD = 16;
    for (const pNext of next.powerups) {
      const pPrev = prev.powerups.find((p) => p.id === pNext.id) ?? pNext;
      const px = interpAxis(pPrev.x, pNext.x, t, PALL_WORLD_W) * sx;
      const py = interpAxis(pPrev.y, pNext.y, t, PALL_WORLD_H) * sy;
      const viz = POWERUP_VIZ[pNext.type];
      const pr = POWERUP_RADIUS_WORLD * sx;
      const pulse = 0.85 + 0.25 * Math.sin(nowPerf * 0.008);
      const flash = (Math.sin(nowPerf * 0.012) + 1) * 0.5;
      const trace = (tnowS) % 1.5;
      const tracePhase = (trace / 1.5) % 1;
      c2d.save();
      c2d.translate(px, py);
      // Expanding tracer ring
      c2d.strokeStyle = viz.colour;
      c2d.shadowColor = viz.colour;
      c2d.shadowBlur = 12 * dpr;
      c2d.lineWidth = 1.4 * dpr;
      c2d.globalAlpha = (1 - tracePhase) * 0.7;
      c2d.beginPath();
      c2d.arc(0, 0, pr + tracePhase * 24 * dpr, 0, Math.PI * 2);
      c2d.stroke();
      c2d.globalAlpha = 1;
      // Outer halo
      c2d.shadowBlur = 20 * dpr;
      c2d.lineWidth = 3 * dpr;
      c2d.beginPath();
      c2d.arc(0, 0, pr * pulse, 0, Math.PI * 2);
      c2d.stroke();
      // Inner disc
      c2d.fillStyle = `${viz.colour}55`;
      c2d.shadowBlur = 14 * dpr;
      c2d.beginPath();
      c2d.arc(0, 0, pr * 0.85, 0, Math.PI * 2);
      c2d.fill();
      // Hot core
      c2d.fillStyle = `rgba(255,255,255,${0.4 + flash * 0.3})`;
      c2d.shadowBlur = 8 * dpr;
      c2d.beginPath();
      c2d.arc(0, 0, pr * 0.4, 0, Math.PI * 2);
      c2d.fill();
      // Glyph
      c2d.fillStyle = '#000';
      c2d.shadowBlur = 0;
      c2d.font = `bold ${Math.round(18 * sx)}px ui-monospace, monospace`;
      c2d.textAlign = 'center';
      c2d.textBaseline = 'middle';
      c2d.fillText(viz.glyph, 0, 0);
      c2d.textAlign = 'start';
      c2d.textBaseline = 'alphabetic';
      c2d.restore();
    }

    // 2c. Particles — local cosmetic burst on SFX events, ticked here
    // each frame. Older particles fade and shrink; expired ones are
    // swept out. Bounded to MAX_PARTICLES so a busy stream can't blow
    // up frame time on weaker devices.
    const dt = 1 / 60; // approximate; close enough for cosmetic decay
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ttl -= dt * 1000;
      if (p.ttl <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.95;
      p.vy *= 0.95;
      const k = Math.max(0, p.ttl / p.ttlMax);
      c2d.save();
      c2d.globalAlpha = k;
      c2d.fillStyle = p.colour;
      c2d.shadowColor = p.colour;
      c2d.shadowBlur = 6 * dpr;
      c2d.beginPath();
      c2d.arc(p.x * sx, p.y * sy, p.size * dpr * (0.6 + k * 0.6), 0, Math.PI * 2);
      c2d.fill();
      c2d.restore();
    }
    // 2d. Debris — line-segment shards from ship-destroyed bursts.
    // Tumbling angled segments fading to zero, matching render.ts
    // drawDebris. One save/restore for the lot per render-pass loop.
    if (debris.length > 0) {
      c2d.save();
      c2d.lineCap = 'round';
      c2d.lineWidth = 1.6 * dpr;
      c2d.shadowBlur = 0;
      for (let i = debris.length - 1; i >= 0; i--) {
        const d = debris[i];
        d.ttl -= dt * 1000;
        if (d.ttl <= 0) { debris.splice(i, 1); continue; }
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.vx *= 0.96;
        d.vy *= 0.96;
        d.rot += d.rotV * dt;
        const alpha = Math.max(0, Math.min(1, d.ttl / d.ttlMax));
        if (alpha < 0.05) continue;
        c2d.globalAlpha = alpha;
        c2d.strokeStyle = d.colour;
        c2d.save();
        c2d.translate(d.x * sx, d.y * sy);
        c2d.rotate(d.rot);
        const half = (d.length / 2) * sx;
        c2d.beginPath();
        c2d.moveTo(-half, 0);
        c2d.lineTo(half, 0);
        c2d.stroke();
        c2d.restore();
      }
      c2d.restore();
    }
    c2d.shadowBlur = 0;

    // 3. Ship — triangle outline, oriented by rot, scaled for DPR so
    // it stays sharp on retina.
    const shipAlive = (t < 0.5 ? prev.alive : next.alive);
    const shielded = (t < 0.5 ? prev.shielded : next.shielded);
    if (shipAlive) {
      // Match render.ts drawShip exactly — same triangle proportions
      // (14, -10/8 wings, -6 notch), same green stroke + shadow. Scaled
      // by sx so it occupies the same canvas fraction as in-game.
      c2d.save();
      c2d.translate(x, y);
      c2d.rotate(rot);
      c2d.scale(shipScale, shipScale);
      c2d.lineWidth = 1.6;
      c2d.strokeStyle = '#8cffb4';
      c2d.fillStyle = 'rgba(140,255,180,0.18)';
      c2d.shadowColor = 'rgba(140,255,180,0.7)';
      c2d.shadowBlur = 12;
      c2d.beginPath();
      c2d.moveTo(14, 0);
      c2d.lineTo(-10, 8);
      c2d.lineTo(-6, 0);
      c2d.lineTo(-10, -8);
      c2d.closePath();
      c2d.fill();
      c2d.stroke();
      if (thrusting) {
        // Thrust bloom + flame, matching render.ts drawShip.
        c2d.save();
        c2d.globalCompositeOperation = 'lighter';
        const bloom = c2d.createRadialGradient(-10, 0, 0, -10, 0, 24);
        bloom.addColorStop(0, 'rgba(255,216,74,0.55)');
        bloom.addColorStop(0.5, 'rgba(255,138,58,0.25)');
        bloom.addColorStop(1, 'rgba(0,0,0,0)');
        c2d.fillStyle = bloom;
        c2d.beginPath();
        c2d.arc(-10, 0, 24, 0, Math.PI * 2);
        c2d.fill();
        c2d.restore();
        c2d.strokeStyle = '#ffd84a';
        c2d.shadowColor = 'rgba(255,216,74,0.8)';
        c2d.shadowBlur = 10;
        c2d.lineWidth = 1.4;
        c2d.beginPath();
        c2d.moveTo(-6, 4);
        c2d.lineTo(-14, 0);
        c2d.lineTo(-6, -4);
        c2d.stroke();
      }
      if (shielded) {
        c2d.strokeStyle = 'rgba(120,200,255,0.85)';
        c2d.shadowColor = 'rgba(120,200,255,0.7)';
        c2d.lineWidth = 1.2;
        c2d.beginPath();
        c2d.arc(0, 0, 17, 0, Math.PI * 2);
        c2d.stroke();
      }
      c2d.restore();
    }

    // 3b. Wave-change banner — fires on each frame.wave increment.
    // Shows for WAVE_BANNER_MS (~3.5s) with fade-in/out. Mirrors the
    // game's wave-start banner so spectators see "WAVE N · NAME · lore"
    // when the player crosses a wave boundary on their canvas.
    if (waveBannerShownAt > 0 && waveBannerWave > 0) {
      const ageMs = nowPerf - waveBannerShownAt;
      if (ageMs < WAVE_BANNER_MS) {
        const lore = WAVE_LORE[waveBannerWave - 1];
        if (lore) {
          // Fade in over first 200ms, hold, fade out over last 600ms.
          const fadeIn = Math.min(1, ageMs / 200);
          const fadeOut = Math.min(1, Math.max(0, WAVE_BANNER_MS - ageMs) / 600);
          const alpha = Math.min(fadeIn, fadeOut);
          const bannerY = CANVAS_H * 0.22;
          c2d.save();
          c2d.globalAlpha = alpha * 0.75;
          c2d.fillStyle = '#02050d';
          c2d.fillRect(0, bannerY - 40 * dpr, CANVAS_W, 110 * dpr);
          c2d.globalAlpha = alpha;
          c2d.textAlign = 'center';
          c2d.textBaseline = 'middle';
          // WAVE n
          c2d.fillStyle = 'rgba(140,255,180,0.85)';
          c2d.font = `${Math.round(14 * dpr)}px ui-monospace, monospace`;
          c2d.fillText(`WAVE ${waveBannerWave}`, CANVAS_W / 2, bannerY - 18 * dpr);
          // NAME (large gold)
          c2d.fillStyle = '#ffd84a';
          c2d.shadowColor = 'rgba(255,216,74,0.6)';
          c2d.shadowBlur = 14 * dpr;
          c2d.font = `bold ${Math.round(28 * dpr)}px ui-monospace, monospace`;
          c2d.fillText(lore.name, CANVAS_W / 2, bannerY + 8 * dpr);
          c2d.shadowBlur = 0;
          // Subtitle
          c2d.fillStyle = 'rgba(220,210,255,0.75)';
          c2d.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
          c2d.fillText(lore.subtitle, CANVAS_W / 2, bannerY + 32 * dpr);
          // Tagline
          c2d.fillStyle = 'rgba(140,255,180,0.7)';
          c2d.font = `${Math.round(10 * dpr)}px ui-monospace, monospace`;
          c2d.fillText(lore.tagline, CANVAS_W / 2, bannerY + 50 * dpr);
          c2d.textAlign = 'start';
          c2d.textBaseline = 'alphabetic';
          c2d.restore();
        }
      } else {
        waveBannerShownAt = 0;
      }
    }

    // 4. Live indicator + age label + paused / ended overlays
    c2d.shadowBlur = 0;
    const latest = frames[frames.length - 1];
    // Age measured against viewer-local arrival time — capturedAt is
    // the player's Date.now() which can drift and gave false STALE
    // labels when the viewer's clock ran slightly behind the player's.
    const ageMs = latest ? performance.now() - latest.receivedAt : 0;
    const stale = ageMs > 3_000;
    const veryStale = ageMs > 6_000;
    // PAUSED only sticks while frames keep arriving (the player is
    // genuinely paused, frames keep flowing every 500ms with paused=1).
    // If frames go stale during a paused frame, the player has quit
    // or backgrounded — drop the PAUSED overlay so the watcher doesn't
    // sit on PAUSED forever waiting for the very-stale threshold.
    const paused = next.paused === true && !stale;
    // RUN ENDED only fires when frames stop arriving. Ship being dead
    // during deathreplay (alive=false in a fresh frame) is just a brief
    // gap between lives — the run is still in progress and frames keep
    // flowing every 500ms. When the run truly ends, the player stops
    // publishing entirely and the stream goes stale; 6s feels like a
    // human "they've gone" rather than a network hiccup.
    const ended = veryStale;

    // First STREAM ENDED transition — auto-try fetching the ghost so a
    // recently-claimed run replays without an extra click. If first
    // attempt fails (player hasn't claimed yet), leaves the button in
    // 'not_yet' state for manual retry.
    if (ended && !replayAutoTried) {
      replayAutoTried = true;
      void tryFetchReplay();
    } else if (!ended && replayState !== 'hidden' && replayState !== 'loading') {
      // Stream came back to life (rare — relay reconnect) — hide the
      // button so we don't strand a stale "TRY AGAIN" alongside live
      // frames.
      setReplayState('hidden');
    }

    // Live / paused / ended pill in the top-left
    let pillColour = 'rgba(140,255,180,0.85)';
    let pillLabel = 'LIVE';
    if (ended) {
      pillColour = 'rgba(255,120,120,0.9)';
      pillLabel = 'STREAM ENDED';
    } else if (paused) {
      pillColour = 'rgba(255,216,74,0.9)';
      pillLabel = 'PAUSED';
    } else if (stale) {
      pillColour = 'rgba(255,150,150,0.85)';
      pillLabel = `STALE · ${(ageMs / 1000).toFixed(0)}s`;
    }
    c2d.fillStyle = pillColour;
    c2d.beginPath();
    c2d.arc(14 * dpr, 14 * dpr, 4 * dpr, 0, Math.PI * 2);
    c2d.fill();
    c2d.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
    c2d.fillStyle = pillColour;
    c2d.fillText(pillLabel, 24 * dpr, 18 * dpr);

    // Centre overlay for PAUSED / RUN ENDED. Keeps the canvas drawn
    // underneath so spectators see the frozen game world, with a
    // clear status banner on top.
    if (paused || ended) {
      c2d.save();
      c2d.fillStyle = 'rgba(2,5,13,0.55)';
      c2d.fillRect(0, 0, CANVAS_W, CANVAS_H);
      c2d.textAlign = 'center';
      c2d.textBaseline = 'middle';
      const cx = CANVAS_W / 2;
      const cy = CANVAS_H / 2;
      if (paused) {
        c2d.shadowColor = 'rgba(255,216,74,0.7)';
        c2d.shadowBlur = 16 * dpr;
        c2d.fillStyle = '#ffd84a';
        c2d.font = `bold ${Math.round(38 * dpr)}px ui-monospace, monospace`;
        c2d.fillText('⏸  PAUSED', cx, cy);
        c2d.shadowBlur = 0;
        c2d.fillStyle = 'rgba(255,216,74,0.85)';
        c2d.font = `${Math.round(13 * dpr)}px ui-monospace, monospace`;
        c2d.fillText(`Wave ${latest.wave} · ${latest.score.toLocaleString()}`, cx, cy + 30 * dpr);
      } else {
        c2d.shadowColor = 'rgba(255,120,120,0.7)';
        c2d.shadowBlur = 16 * dpr;
        c2d.fillStyle = '#ff8a8a';
        c2d.font = `bold ${Math.round(36 * dpr)}px ui-monospace, monospace`;
        c2d.fillText('STREAM ENDED', cx, cy - 14 * dpr);
        c2d.shadowBlur = 0;
        c2d.fillStyle = 'rgba(255,200,200,0.85)';
        c2d.font = `${Math.round(15 * dpr)}px ui-monospace, monospace`;
        c2d.fillText(`Last wave ${latest.wave} · ${latest.score.toLocaleString()}`, cx, cy + 14 * dpr);
        c2d.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
        c2d.fillStyle = 'rgba(220,210,255,0.7)';
        c2d.fillText('Replay via the kind 30763 ghost once the player claims', cx, cy + 36 * dpr);
      }
      c2d.textAlign = 'start';
      c2d.textBaseline = 'alphabetic';
      c2d.restore();
    }
  };
  rafId = requestAnimationFrame(tick);
}

// ── Admin panel ───────────────────────────────────────────────────────────────
//
// Layer 1 visual review surface. Reached via ?admin=1 in the URL; the operator
// supplies the bearer token configured as ADMIN_TOKEN on the faucet. Lists
// currently-flagged players together with the run whose telemetry tripped
// the heuristic, with WATCH buttons that open the existing replay theatre.
// Pairs with the Layer 0 fingerprinter in pallasite-faucet/src/heuristics.ts.

const ADMIN_TOKEN_KEY = 'pallasite-admin-token';

function shortPubkey(hex: string): string {
  if (hex.length < 12) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

function formatFlaggedAt(ms: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

// ── Phone-as-controller ──────────────────────────────────────────────────────
//
// Two surfaces live in this section:
//   1. renderControllerHostPairing — big-screen overlay shown when the
//      player taps "USE PHONE AS CONTROLLER" on the title screen. Shows
//      QR + short pubkey, latches once the mobile paired.
//   2. renderControllerPage — the mobile page itself, served from the
//      same SPA at /controller?h=...&s=...&r=... . Joystick + buttons.
//
// The host is held in a module-level slot so it survives the pairing
// dialog being closed — the user can pair, dismiss the dialog, then
// IGNITE and the phone keeps driving the ship. Explicit DISCONNECT
// (or window close) tears it down.

let activeControllerHost: import('./controller-host.js').ControllerHost | null = null;

export function hasActiveControllerHost(): boolean {
  return activeControllerHost !== null;
}

export function disconnectActiveControllerHost(): void {
  activeControllerHost?.close();
  activeControllerHost = null;
}

export function renderControllerHostPairing(state: GameState, onClose: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'USE PHONE AS CONTROLLER' });

  const desc = el('p', { parent: overlay });
  desc.style.cssText = 'margin:8px 0 14px;font-size:0.95rem;color:rgba(220,210,255,0.85);max-width:520px;line-height:1.55;';
  desc.textContent = 'Open the QR on your phone to drive this screen. Pairing key is one-shot — it lives for this session only.';

  const qrSlot = el('div', { parent: overlay });
  qrSlot.style.cssText = 'width:200px;height:200px;background:#fff;border-radius:8px;padding:8px;margin:0 auto;box-shadow:0 0 20px rgba(140,255,180,0.25);';

  const codeP = el('p', { parent: overlay });
  codeP.style.cssText = 'margin:14px 0 6px;font-size:1.1rem;letter-spacing:0.2em;color:var(--hud-yellow);text-shadow:0 0 8px rgba(255,216,74,0.45);';

  const status = el('p', { parent: overlay });
  status.style.cssText = 'margin:8px 0 4px;font-size:0.95rem;color:rgba(140,255,180,0.85);min-height:1.4em;letter-spacing:0.08em;';
  status.textContent = 'Generating session key…';

  const hint = el('p', { parent: overlay });
  hint.style.cssText = 'margin:6px 0 18px;font-size:0.8rem;color:rgba(180,140,255,0.7);max-width:520px;line-height:1.4em;';
  hint.textContent = '';

  const row = el('div', { className: 'menu-row', parent: overlay });
  // Two action buttons: KEEP CONNECTED leaves the host alive so the
  // phone can drive the game after the dialog closes; DISCONNECT tears
  // the host down. Labels swap based on pair state.
  const primaryBtn = el('button', { className: 'menu-btn', parent: row, text: 'CANCEL' });
  const secondaryBtn = el('button', { className: 'menu-btn secondary', parent: row, text: '' });
  secondaryBtn.style.display = 'none';

  let paired = false;
  const startOrReuseHost = async (): Promise<void> => {
    const mod = await import('./controller-host.js');
    // Reuse an existing host if one's already running — saves a key
    // re-roll and lets the user re-open the QR mid-session.
    if (!activeControllerHost) {
      activeControllerHost = mod.startControllerHost(state);
    } else {
      // Already paired, jump to the paired view.
      paired = true;
    }
    const host = activeControllerHost;
    void renderQRInto(qrSlot, host.pairingUrl);
    codeP.textContent = host.sessionId.slice(0, 4).toUpperCase() + '·' + host.sessionId.slice(4, 8).toUpperCase();
    const renderPairedState = (): void => {
      status.textContent = 'Phone connected.';
      status.style.color = 'rgba(91,255,140,0.95)';
      hint.textContent = 'Close this dialog and IGNITE — your phone will keep driving the ship.';
      primaryBtn.textContent = 'KEEP CONNECTED · ESC';
      secondaryBtn.textContent = 'DISCONNECT';
      secondaryBtn.style.display = '';
    };
    if (paired) {
      renderPairedState();
    } else {
      status.textContent = 'Waiting for phone to scan…';
      hint.textContent = `Or visit ${host.pairingUrl} on your phone.`;
    }
    host.onStatus((s) => {
      if (s.kind === 'paired') {
        paired = true;
        renderPairedState();
      } else if (s.kind === 'waiting') {
        // Either the initial waiting state or the phone disconnected
        // after a successful pair. If we'd previously latched paired,
        // surface it so the dialog reflects the dropped peer.
        if (paired) {
          paired = false;
          status.textContent = 'Phone disconnected — re-scan to reconnect.';
          status.style.color = 'rgba(255,216,74,0.85)';
          primaryBtn.textContent = 'CANCEL';
          secondaryBtn.style.display = 'none';
        }
      } else if (s.kind === 'closed') {
        status.textContent = 'Disconnected.';
        primaryBtn.textContent = 'BACK';
        secondaryBtn.style.display = 'none';
      }
    });
  };
  void startOrReuseHost();

  const closeDialog = (alsoDisconnect: boolean): void => {
    window.removeEventListener('keydown', onKey);
    if (alsoDisconnect) {
      activeControllerHost?.close();
      activeControllerHost = null;
    }
    onClose();
  };
  primaryBtn.addEventListener('click', () => {
    // Primary action depends on pair state:
    //  unpaired → CANCEL (close + tear down)
    //  paired   → KEEP CONNECTED (close, host persists)
    closeDialog(!paired);
  });
  secondaryBtn.addEventListener('click', () => closeDialog(true));
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') closeDialog(!paired);
  };
  window.addEventListener('keydown', onKey);
}

// Controller mobile page — renders a touch UI that publishes input
// events. Self-contained: doesn't touch the game state at all, only
// reads the URL token and uses controller-mobile to publish.
//
// Joystick semantics mirror touch.ts → attachJoystick exactly: drag
// angle drives target heading, deflection past THRUST_THRESHOLD turns
// thrust on. Quick tap-and-release fires one shot. Action buttons
// (fire-hold, hyperspace, shield, pause) sit on the right thumb side.
/** Home page shown on mobile.pallasite.app when there's no pairing
 *  token in the URL. Lets the user scan a QR (BarcodeDetector when
 *  available, falls back to manual code entry) or type the 8-character
 *  pairing code from the big screen. On success, navigates to
 *  /?s=<code> which the route handler bounces back into
 *  renderControllerPage as the gamepad. */
function renderControllerHomePage(): void {
  clearOverlay();
  // Portrait OR landscape — the home page is just a card; we don't
  // need the rotate-device lockdown here.
  document.documentElement.style.height = '';
  document.documentElement.style.overflow = '';
  document.body.style.cssText = 'background:#02050d;color:rgba(220,210,255,0.9);font-family:ui-monospace,monospace;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px;';
  let vp = document.querySelector('meta[name="viewport"]');
  if (!vp) {
    vp = document.createElement('meta');
    vp.setAttribute('name', 'viewport');
    document.head.appendChild(vp);
  }
  vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

  const gameCanvas = document.getElementById('game');
  if (gameCanvas) gameCanvas.style.display = 'none';
  const touchCtl = document.getElementById('touch-controls');
  if (touchCtl) touchCtl.style.display = 'none';

  const overlay = el('div', { className: 'overlay', parent: root });
  overlay.style.cssText = 'position:static;padding:0;margin:0;max-width:520px;width:100%;display:flex;flex-direction:column;align-items:stretch;gap:18px;';

  // Header
  const header = el('div', { parent: overlay });
  header.style.cssText = 'text-align:center;margin-bottom:6px;';
  const title = el('h1', { parent: header, text: 'PALLASITE · CONTROLLER' });
  title.style.cssText = 'margin:0 0 6px;font-size:1.25rem;letter-spacing:0.18em;color:#8cffb4;text-shadow:0 0 12px rgba(140,255,180,0.4);';
  const subtitle = el('p', { parent: header, text: 'Pair with a game to start playing' });
  subtitle.style.cssText = 'margin:0;font-size:0.85rem;color:rgba(220,210,255,0.7);letter-spacing:0.08em;';

  // ── Code entry — single big license-plate input ────────────────────
  // Big, centred, uppercase via CSS. No mid-typing reformatting — that
  // fights the user's cursor and the IME on mobile. Only normalise on
  // submit. Accepts any combination of hex chars + punctuation (e.g.
  // "ABCD 1234", "abcd-1234", "abcd1234"); strip non-hex on submit.
  const codeCard = el('div', { parent: overlay });
  codeCard.style.cssText = 'border:1px solid rgba(140,255,180,0.35);border-radius:14px;padding:20px;background:rgba(60,200,140,0.06);display:flex;flex-direction:column;gap:14px;';
  const codeLabel = el('label', { parent: codeCard, text: 'ENTER CODE FROM GAME' });
  codeLabel.style.cssText = 'font-size:0.85rem;letter-spacing:0.18em;color:rgba(140,255,180,0.9);text-align:center;';
  const codeInput = el('input', { parent: codeCard, attrs: { type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', placeholder: 'ABCD 1234' } }) as HTMLInputElement;
  codeInput.style.cssText = 'background:rgba(2,5,13,0.7);border:2px solid rgba(140,255,180,0.5);border-radius:12px;padding:18px 14px;font-size:2rem;letter-spacing:0.18em;color:#ffd84a;text-align:center;font-family:ui-monospace,monospace;outline:none;text-transform:uppercase;width:100%;box-sizing:border-box;';
  const goBtn = el('button', { parent: codeCard, text: 'PAIR' }) as HTMLButtonElement;
  goBtn.style.cssText = 'background:rgba(140,255,180,0.22);border:2px solid rgba(140,255,180,0.7);color:#8cffb4;border-radius:12px;padding:18px;font-size:1.1rem;letter-spacing:0.22em;font-weight:bold;cursor:pointer;font-family:ui-monospace,monospace;';
  const codeHint = el('p', { parent: codeCard });
  codeHint.style.cssText = 'margin:0;font-size:0.78rem;color:rgba(180,140,255,0.7);line-height:1.5;text-align:center;';
  const HINT_DEFAULT = 'Find the 8-character code under the QR on the game screen.';
  codeHint.textContent = HINT_DEFAULT;

  const normalise = (raw: string): string | null => {
    const stripped = raw.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    return /^[a-f0-9]{8}$/.test(stripped) ? stripped : null;
  };
  const setError = (msg: string | null): void => {
    if (msg) {
      codeHint.textContent = msg;
      codeHint.style.color = 'rgba(255,120,120,0.9)';
      codeInput.style.borderColor = 'rgba(255,120,120,0.75)';
    } else {
      codeHint.textContent = HINT_DEFAULT;
      codeHint.style.color = 'rgba(180,140,255,0.7)';
      codeInput.style.borderColor = 'rgba(140,255,180,0.5)';
    }
  };
  const submitCode = (): void => {
    const code = normalise(codeInput.value);
    if (!code) {
      setError('Code must be 8 hex characters (0-9, A-F).');
      return;
    }
    codeInput.blur();
    window.location.assign(`/?s=${code}`);
  };
  goBtn.addEventListener('click', submitCode);
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitCode(); }
  });
  // Only clear errors on input — no auto-formatting that fights the
  // user. They type whatever, we strip on submit.
  codeInput.addEventListener('input', () => setError(null));

  // ── QR scanner — optional, present iff BarcodeDetector is available
  const hasBarcodeDetector = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === 'function';
  if (hasBarcodeDetector && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    const scanCard = el('div', { parent: overlay });
    scanCard.style.cssText = 'border:1px solid rgba(184,144,255,0.35);border-radius:12px;padding:18px;background:rgba(120,90,200,0.06);display:flex;flex-direction:column;gap:12px;align-items:stretch;';
    const scanLabel = el('div', { parent: scanCard, text: 'OR SCAN QR CODE' });
    scanLabel.style.cssText = 'font-size:0.78rem;letter-spacing:0.18em;color:rgba(184,144,255,0.85);';
    const scanBtn = el('button', { parent: scanCard, text: '📷  OPEN SCANNER' }) as HTMLButtonElement;
    scanBtn.style.cssText = 'background:rgba(184,144,255,0.18);border:1px solid rgba(184,144,255,0.6);color:#cbb6ff;border-radius:8px;padding:18px 18px;font-size:1rem;letter-spacing:0.16em;font-weight:bold;cursor:pointer;font-family:ui-monospace,monospace;';
    const scanHost = el('div', { parent: scanCard });
    scanHost.style.cssText = 'display:none;flex-direction:column;gap:10px;align-items:stretch;';
    const video = el('video', { parent: scanHost }) as HTMLVideoElement;
    video.style.cssText = 'width:100%;max-height:60vh;border-radius:8px;background:#000;object-fit:cover;';
    video.playsInline = true;
    video.muted = true;
    const scanStatus = el('p', { parent: scanHost });
    scanStatus.style.cssText = 'margin:0;font-size:0.78rem;color:rgba(220,210,255,0.7);text-align:center;letter-spacing:0.08em;';
    scanStatus.textContent = 'Point at the QR on the big screen';
    const stopBtn = el('button', { parent: scanHost, text: 'CANCEL' }) as HTMLButtonElement;
    stopBtn.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(220,210,255,0.3);color:rgba(220,210,255,0.85);border-radius:8px;padding:10px 12px;font-size:0.85rem;letter-spacing:0.12em;cursor:pointer;font-family:ui-monospace,monospace;';

    let stream: MediaStream | null = null;
    let scanRaf: number | null = null;
    let detector: { detect: (image: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } | null = null;

    const stopScan = (): void => {
      if (scanRaf !== null) { cancelAnimationFrame(scanRaf); scanRaf = null; }
      if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
      scanHost.style.display = 'none';
      scanBtn.style.display = '';
      scanBtn.disabled = false;
    };

    const tryParse = (raw: string): string | null => {
      // Two acceptable formats:
      //   1. A pairing URL: https://mobile.pallasite.app/?s=XXXXXXXX
      //   2. Just the 8-char code (manual)
      try {
        const u = new URL(raw);
        const s = u.searchParams.get('s');
        if (s) return normalise(s);
      } catch { /* not a URL — try as plain code */ }
      return normalise(raw);
    };

    const startScan = async (): Promise<void> => {
      scanBtn.disabled = true;
      try {
        // Prefer the rear-facing camera on phones.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch (err) {
        scanBtn.disabled = false;
        codeHint.textContent = err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera permission denied — use the code field above instead.'
          : 'Could not open the camera — use the code field above instead.';
        codeHint.style.color = 'rgba(255,180,80,0.9)';
        return;
      }
      scanBtn.style.display = 'none';
      scanHost.style.display = 'flex';
      video.srcObject = stream;
      try { await video.play(); } catch { /* ignore — some browsers want user gesture */ }
      const BD = (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => typeof detector }).BarcodeDetector;
      try { detector = new BD({ formats: ['qr_code'] }) as typeof detector; } catch { detector = null; }
      if (!detector) {
        scanStatus.textContent = 'QR scanning unavailable on this browser.';
        return;
      }
      const tick = async (): Promise<void> => {
        if (!stream || !detector) return;
        try {
          const found = await detector.detect(video);
          if (found && found.length > 0) {
            const code = tryParse(found[0].rawValue);
            if (code) {
              scanStatus.textContent = 'Got it — pairing…';
              stopScan();
              window.location.assign(`/?s=${code}`);
              return;
            }
          }
        } catch { /* keep scanning */ }
        scanRaf = requestAnimationFrame(() => { void tick(); });
      };
      void tick();
    };

    scanBtn.addEventListener('click', () => { void startScan(); });
    stopBtn.addEventListener('click', stopScan);
  } else {
    // Browser without BarcodeDetector — leave the code field as the
    // only path. Add a small hint so users know why no scanner.
    const noScanHint = el('p', { parent: overlay });
    noScanHint.style.cssText = 'margin:0;font-size:0.75rem;color:rgba(180,140,255,0.55);text-align:center;letter-spacing:0.05em;';
    noScanHint.textContent = 'QR scanning needs a modern Chromium-based browser. Use the code field above.';
  }

  // ── Add-to-Home-Screen hint ─────────────────────────────────────────
  // Only show when not already installed (display-mode standalone is
  // matchMedia-checkable).
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  if (!isStandalone) {
    const pwaCard = el('div', { parent: overlay });
    pwaCard.style.cssText = 'margin-top:8px;font-size:0.72rem;color:rgba(180,140,255,0.6);text-align:center;line-height:1.6;';
    pwaCard.innerHTML = 'Add this page to your home screen for one-tap access.<br>iOS: share → Add to Home Screen. Android: ⋮ → Install app.';
  }
}

export function renderControllerPage(): void {
  // If the URL doesn't carry a pairing token, render the home page
  // instead (scan QR / enter code). Once the user pairs we navigate
  // to ?s=<code> and re-enter this function, this time taking the
  // gamepad branch below.
  const url = new URL(window.location.href);
  if (!url.searchParams.get('s')) {
    renderControllerHomePage();
    return;
  }
  clearOverlay();
  // Lock the page chrome — controller is full-screen landscape only.
  document.documentElement.style.height = '100%';
  document.documentElement.style.overflow = 'hidden';
  document.body.style.cssText = 'background:#02050d;overflow:hidden;touch-action:none;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;overscroll-behavior:none;';
  let vp = document.querySelector('meta[name="viewport"]');
  if (!vp) {
    vp = document.createElement('meta');
    vp.setAttribute('name', 'viewport');
    document.head.appendChild(vp);
  }
  vp.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');

  const gameCanvas = document.getElementById('game');
  if (gameCanvas) gameCanvas.style.display = 'none';
  const touchCtl = document.getElementById('touch-controls');
  if (touchCtl) touchCtl.style.display = 'none';

  void (async () => {
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (orientation?.lock) await orientation.lock('landscape');
    } catch { /* not supported in non-PWA contexts */ }
  })();

  const overlay = el('div', { className: 'overlay', parent: root });
  overlay.style.cssText = 'padding:0;margin:0;max-width:none;width:100vw;height:100vh;display:flex;flex-direction:column;overflow:hidden;position:relative;';

  // ── Rotate-device card (portrait fallback) ─────────────────────────
  const rotateCard = el('div', { parent: overlay });
  rotateCard.style.cssText = 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;background:#02050d;color:rgba(220,210,255,0.85);text-align:center;padding:20px;z-index:30;';
  const rotateIcon = el('div', { parent: rotateCard, text: '📱↺' });
  rotateIcon.style.cssText = 'font-size:4rem;margin-bottom:18px;filter:drop-shadow(0 0 10px rgba(140,255,180,0.5));';
  el('h2', { parent: rotateCard, text: 'ROTATE TO LANDSCAPE' }).style.cssText = 'margin:0 0 10px;letter-spacing:0.18em;color:#8cffb4;';
  el('p', { parent: rotateCard, text: 'The controller is designed for two-thumb landscape play.' }).style.cssText = 'margin:0 0 16px;font-size:0.95rem;max-width:400px;line-height:1.5;';
  const pwaHint = el('p', { parent: rotateCard });
  pwaHint.style.cssText = 'margin:8px 0 0;font-size:0.8rem;color:rgba(180,140,255,0.7);max-width:420px;line-height:1.5;';
  pwaHint.innerHTML = 'Tip: tap the share icon → <strong>Add to Home Screen</strong> to install this as a controller PWA — opens straight into the joystick.';
  const isPortrait = (): boolean => window.innerHeight > window.innerWidth;
  const applyOrientation = (): void => {
    rotateCard.style.display = isPortrait() ? 'flex' : 'none';
  };
  applyOrientation();
  window.addEventListener('resize', applyOrientation);
  window.addEventListener('orientationchange', applyOrientation);

  // ── Top status strip ───────────────────────────────────────────────
  const titleBar = el('div', { parent: overlay });
  titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 10px;font-size:0.78rem;color:rgba(220,210,255,0.85);letter-spacing:0.14em;height:22px;flex-shrink:0;z-index:5;';
  const gameNameChip = el('span', { parent: titleBar, text: 'CONTROLLER' });
  const statusChip = el('span', { parent: titleBar });
  statusChip.style.cssText = 'color:rgba(255,216,74,0.85);font-size:0.7rem;';
  statusChip.textContent = '…';

  // ── Gamepad surface — a single positioned canvas so shoulders sit
  //    at the screen corners regardless of where the joystick + face
  //    button clusters land. Joystick on the left thumb, face buttons
  //    diamond on the right thumb, shoulders along the top edge.
  const surface = el('div', { parent: overlay });
  surface.style.cssText = 'flex:1;position:relative;min-height:0;';

  // Buttons not in the spec stay hidden. We pre-build every standard
  // slot at fixed positions and toggle visibility based on the spec.
  const slotEls = new Map<string, HTMLElement>();
  const slotLabels = new Map<string, HTMLElement>();

  const makeButton = (slot: string, css: string, defaultColour = 'rgba(220,210,255,0.7)'): HTMLElement => {
    const btn = el('div', { parent: surface });
    // border-radius comes from the caller's css string (face buttons
    // want 50%, shoulders want 14px). Same for width/height/position.
    btn.style.cssText = `position:absolute;display:none;align-items:center;justify-content:center;background:rgba(255,255,255,0.04);border:2px solid ${defaultColour}55;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;color:${defaultColour};text-shadow:0 0 12px ${defaultColour}88;font-weight:bold;${css}`;
    slotEls.set(slot, btn);
    const inner = el('div', { parent: btn });
    inner.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;line-height:1;pointer-events:none;';
    slotLabels.set(slot, inner);
    return btn;
  };

  // Ergonomic two-thumb layout. Thumbs rest at the bottom corners of
  // a phone held in landscape, so:
  //   - Joystick sits bottom-left, centred ~thumb-reach from corner
  //   - Face-button diamond sits bottom-right, mirroring it
  //   - Shoulders ride the top-left + top-right corners (index fingers
  //     or thumb-stretches)
  //   - start + select small at the top centre (rarely-pressed pause-y
  //     things)
  // Sizes use clamp() so a tiny phone and a large tablet both work.

  // Sizes are clamped between phone-floor and tablet-ceiling. Bumped
  // floors substantially after a screenshot showed FIRE looking like
  // a postage stamp in a sea of empty bottom-right. Using vh because
  // in landscape phone, height IS the smaller dimension on every
  // device, so vh tracks the limiting axis directly.
  const SHOULDER_W = 'clamp(84px, 24vh, 120px)';
  const SHOULDER_H = 'clamp(54px, 16vh, 78px)';
  const FACE_SIZE  = 'clamp(104px, 32vh, 144px)';
  const FACE_GAP   = 'clamp(132px, 38vh, 192px)';   // centre-to-centre
  const SYS_W      = 'clamp(68px, 18vh, 88px)';
  const SYS_H      = 'clamp(38px, 11vh, 52px)';

  // Top strip — shoulders + start/select. 8px margin from the edges.
  makeButton('L1', `top:8px;left:8px;width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('L2', `top:8px;left:calc(16px + ${SHOULDER_W});width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('R2', `top:8px;right:calc(16px + ${SHOULDER_W});width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('R1', `top:8px;right:8px;width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('select', `top:14px;left:calc(50% - ${SYS_W} - 4px);width:${SYS_W};height:${SYS_H};border-radius:14px;font-size:0.78rem;`);
  makeButton('start',  `top:14px;left:calc(50% + 4px);width:${SYS_W};height:${SYS_H};border-radius:14px;font-size:0.78rem;`);

  // Face-button diamond — wrapped in a relative-positioned container
  // so the four buttons stay correctly diamond-arranged regardless of
  // viewport width. Container sits in the bottom-right thumb zone.
  const faceCluster = el('div', { parent: surface });
  faceCluster.style.cssText = `position:absolute;right:24px;bottom:24px;width:calc(${FACE_GAP} + ${FACE_SIZE});height:calc(${FACE_GAP} + ${FACE_SIZE});pointer-events:none;`;

  const faceBtn = (slot: string, css: string): void => {
    const btn = makeButton(slot, `width:${FACE_SIZE};height:${FACE_SIZE};border-radius:50%;font-size:1.5rem;pointer-events:auto;${css}`);
    btn.parentElement?.removeChild(btn);
    faceCluster.appendChild(btn);
  };
  // Position each face button at one of the diamond points. Container
  // is (FACE_GAP + FACE_SIZE) square; centres are at gap-spacing from
  // the corners.
  faceBtn('Y', `top:0;left:calc(50% - ${FACE_SIZE} / 2);`);
  faceBtn('X', `top:calc(50% - ${FACE_SIZE} / 2);left:0;`);
  faceBtn('B', `top:calc(50% - ${FACE_SIZE} / 2);right:0;`);
  faceBtn('A', `bottom:0;left:calc(50% - ${FACE_SIZE} / 2);`);

  // ── Joystick (left thumb) — anchored bottom-left, sized to match
  //    the face cluster so left and right thumb work in symmetry.
  const JOY_HEADING_DEADZONE = 0.18;
  const JOY_THRUST_THRESHOLD = 0.45;
  const JOY_TAP_TIME_MS = 220;
  const JOY_TAP_MOVE_PX = 8;
  const HEADING_SAMPLE_MS = 50;
  const JOY_SIZE = `calc(${FACE_GAP} + ${FACE_SIZE})`;

  const pad = el('div', { parent: surface });
  pad.style.cssText = `position:absolute;left:24px;bottom:24px;width:${JOY_SIZE};height:${JOY_SIZE};border-radius:50%;background:radial-gradient(circle, rgba(140,255,180,0.10) 0%, rgba(140,255,180,0.04) 60%, rgba(140,255,180,0) 100%);border:2px solid rgba(140,255,180,0.35);touch-action:none;-webkit-tap-highlight-color:transparent;display:none;`;
  const knob = el('div', { parent: pad });
  knob.style.cssText = 'position:absolute;left:50%;top:50%;width:38%;height:38%;margin:-19% 0 0 -19%;border-radius:50%;background:radial-gradient(circle, rgba(140,255,180,0.45) 0%, rgba(91,255,140,0.18) 70%);border:2px solid rgba(140,255,180,0.75);box-shadow:0 0 18px rgba(140,255,180,0.4);transform:translate(0,0);transition:transform 60ms ease-out;';
  slotEls.set('joyL', pad);

  // ── Waiting-for-game card (centre overlay, hidden once spec lands)
  const waitCard = el('div', { parent: surface });
  waitCard.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;color:rgba(220,210,255,0.7);text-align:center;padding:20px;pointer-events:none;';
  const waitIcon = el('div', { parent: waitCard, text: '⏳' });
  waitIcon.style.cssText = 'font-size:3rem;margin-bottom:14px;opacity:0.85;';
  const waitTitle = el('h3', { parent: waitCard, text: 'WAITING FOR GAME…' });
  waitTitle.style.cssText = 'margin:0 0 6px;letter-spacing:0.15em;color:#ffd84a;font-size:1rem;';
  const waitBody = el('p', { parent: waitCard, text: 'Scan a game QR code or share a pairing link to start controlling.' });
  waitBody.style.cssText = 'margin:0;font-size:0.85rem;max-width:480px;line-height:1.5;';

  // ── Wire setup ──────────────────────────────────────────────────────
  const importMobile = import('./controller-mobile.js');
  const importHost = import('./controller-host.js');
  let client: import('./controller-mobile.js').ControllerClient | null = null;

  const setSlotConfig = (slot: string, cfg: import('./controller-types.js').SlotConfig): void => {
    const btnEl = slotEls.get(slot);
    if (!btnEl) return;
    btnEl.style.display = slot === 'joyL' ? 'block' : 'flex';
    const colour = cfg.colour ?? '#8cffb4';
    btnEl.style.color = colour;
    btnEl.style.borderColor = colour + '88';
    btnEl.style.textShadow = `0 0 12px ${colour}88`;
    if (slot !== 'joyL') {
      const inner = slotLabels.get(slot);
      if (inner) {
        inner.innerHTML = '';
        // Bigger glyph + label so the buttons read clearly. The font
        // sizes track the slot family — face buttons are the focus,
        // shoulders + system buttons sit smaller.
        const isFace = slot === 'A' || slot === 'B' || slot === 'X' || slot === 'Y';
        const isSys  = slot === 'start' || slot === 'select';
        const iconSize = isFace ? '2.2rem' : isSys ? '1rem' : '1.4rem';
        const labelSize = isFace ? '0.72rem' : isSys ? '0.6rem' : '0.65rem';
        if (cfg.icon) {
          const ic = el('span', { parent: inner, text: cfg.icon });
          ic.style.cssText = `font-size:${iconSize};line-height:1;`;
        }
        if (cfg.label) {
          const lb = el('span', { parent: inner, text: cfg.label });
          lb.style.cssText = `font-size:${labelSize};letter-spacing:0.14em;color:${colour};`;
        }
      }
    }
  };

  const applySpec = (spec: import('./controller-types.js').ControllerSpec): void => {
    gameNameChip.textContent = (spec.name ?? 'GAME').toUpperCase() + ' · CONTROLLER';
    // Reset all slots to hidden, then enable the ones the spec lists.
    for (const slotEl of slotEls.values()) slotEl.style.display = 'none';
    for (const [slot, cfg] of Object.entries(spec.slots ?? {})) {
      if (!cfg) continue;
      setSlotConfig(slot, cfg);
    }
    waitCard.style.display = 'none';
  };

  void Promise.all([importMobile, importHost]).then(([m, h]) => {
    const token = h.decodePairingUrl(window.location.href);
    if (!token) {
      statusChip.textContent = 'NEED PAIRING';
      statusChip.style.color = 'rgba(255,120,120,0.9)';
      waitTitle.textContent = 'NOT PAIRED';
      waitBody.textContent = 'Open the QR scanner on the home page or scan a fresh game code.';
      return;
    }
    statusChip.textContent = 'CONNECTING…';
    client = m.startControllerClient(token);
    client.onStatus((s) => {
      switch (s.kind) {
        case 'connecting':    statusChip.textContent = 'CONNECTING…'; statusChip.style.color = 'rgba(255,216,74,0.85)'; break;
        case 'waiting':       statusChip.textContent = 'WAITING FOR GAME'; statusChip.style.color = 'rgba(255,216,74,0.85)'; break;
        case 'paired':        statusChip.textContent = 'PAIRED · LIVE'; statusChip.style.color = 'rgba(91,255,140,0.95)'; break;
        case 'reconnecting':  statusChip.textContent = 'RECONNECTING…'; statusChip.style.color = 'rgba(255,150,80,0.9)'; break;
        case 'closed':        statusChip.textContent = 'CLOSED'; statusChip.style.color = 'rgba(255,120,120,0.9)'; break;
      }
    });
    client.onSpec((spec) => applySpec(spec));
  });

  // ── Joystick interaction (always built; visible iff joyL in spec) ──
  let joyActive = false;
  let joyOriginX = 0, joyOriginY = 0;
  let joyMaxRadius = 100;
  let joyPressedAt = 0;
  let joyMaxDrift = 0;
  let joyDidEngage = false;
  let lastHeadingSendAt = 0;
  let thrustingNow = false;
  let joyTapSlot: string | null = null;

  const sendThrust = (on: boolean): void => {
    if (thrustingNow === on) return;
    thrustingNow = on;
    client?.sendInput('joyL-thrust', on ? '1' : '0');
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyActive = true;
    const rect = pad.getBoundingClientRect();
    joyOriginX = rect.left + rect.width / 2;
    joyOriginY = rect.top + rect.height / 2;
    joyMaxRadius = (rect.width / 2) * 0.7;
    joyPressedAt = performance.now();
    joyMaxDrift = 0;
    joyDidEngage = false;
    // Look up tapAction from the live spec, if any.
    joyTapSlot = client?.spec?.slots?.joyL?.tapAction ?? null;
    pad.setPointerCapture(e.pointerId);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!joyActive) return;
    const dx = e.clientX - joyOriginX;
    const dy = e.clientY - joyOriginY;
    const dist = Math.hypot(dx, dy);
    if (dist > joyMaxDrift) joyMaxDrift = dist;
    const clipped = Math.min(dist || 1, joyMaxRadius);
    const kx = (dx / (dist || 1)) * clipped;
    const ky = (dy / (dist || 1)) * clipped;
    knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
    const magnitude = clipped / joyMaxRadius;
    if (magnitude > JOY_HEADING_DEADZONE) {
      joyDidEngage = true;
      const angle = Math.atan2(dy, dx);
      const now = performance.now();
      if (now - lastHeadingSendAt >= HEADING_SAMPLE_MS) {
        lastHeadingSendAt = now;
        const norm = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        client?.sendInput('joyL', String(Math.round(norm * 1000)));
      }
      sendThrust(magnitude > JOY_THRUST_THRESHOLD);
    } else {
      sendThrust(false);
    }
  });
  const joyRelease = (): void => {
    if (!joyActive) return;
    joyActive = false;
    const heldMs = performance.now() - joyPressedAt;
    knob.style.transform = 'translate(0px, 0px)';
    sendThrust(false);
    client?.sendInput('joyL-end', '1');
    if (!joyDidEngage && heldMs < JOY_TAP_TIME_MS && joyMaxDrift < JOY_TAP_MOVE_PX) {
      client?.sendInput('joyL-tap', '1');
      // Also emit the tapAction slot if the spec wired one — gives the
      // host a slot-keyed press event to feed straight into its slot map.
      if (joyTapSlot) {
        const target = joyTapSlot;
        client?.sendInput(target, '1');
        window.setTimeout(() => client?.sendInput(target, '0'), 60);
      }
    }
  };
  pad.addEventListener('pointerup', joyRelease);
  pad.addEventListener('pointercancel', joyRelease);

  // ── Bind press/release on every standard button slot ───────────────
  // Each slot is hold-style by default (presses send '1', releases '0').
  // One-shot semantics are the host's job — the slot map can ignore
  // releases for action buttons like SHIELD that should fire once per
  // press.
  const bindButton = (slot: string): void => {
    const btn = slotEls.get(slot);
    if (!btn || slot === 'joyL') return;
    const press = (e: Event): void => {
      e.preventDefault();
      btn.style.background = 'rgba(255,255,255,0.18)';
      client?.sendInput(slot, '1');
    };
    const release = (): void => {
      btn.style.background = 'rgba(255,255,255,0.04)';
      client?.sendInput(slot, '0');
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
  };
  for (const slot of ['A', 'B', 'X', 'Y', 'L1', 'L2', 'R1', 'R2', 'start', 'select']) bindButton(slot);
}

export function renderAdminPanel(): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'ADMIN · LAYER 1 REVIEW' });
  const intro = el('p', { parent: overlay });
  intro.style.cssText = 'margin:4px 0 18px;font-size:0.85rem;color:rgba(220,210,255,0.7);letter-spacing:0.08em;max-width:640px;';
  intro.textContent = 'Heuristic-flagged runs awaiting visual review. WATCH opens the kind 30763 ghost in the theatre.';

  const cached = (() => {
    try { return sessionStorage.getItem(ADMIN_TOKEN_KEY); } catch { return null; }
  })();

  if (!cached) {
    renderAdminTokenPrompt(overlay);
    return;
  }

  renderAdminFlaggedList(overlay, cached);
}

function renderAdminTokenPrompt(overlay: HTMLElement): void {
  const form = el('div', { parent: overlay });
  form.style.cssText = 'display:flex;flex-direction:column;gap:10px;align-items:center;margin:18px auto;max-width:420px;';

  el('p', { parent: form, text: 'Paste your faucet ADMIN_TOKEN to view flagged runs.' })
    .style.cssText = 'margin:0;font-size:0.88rem;color:rgba(220,210,255,0.85);';

  const input = el('input', { parent: form });
  input.setAttribute('type', 'password');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('placeholder', 'bearer token');
  input.style.cssText = 'width:100%;padding:10px 12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.18);border-radius:6px;color:#fff;font-family:monospace;letter-spacing:0.05em;';

  const row = el('div', { className: 'menu-row', parent: form });
  const enterBtn = el('button', { className: 'menu-btn', parent: row, text: 'ENTER' });
  const closeBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'BACK' });

  const submit = (): void => {
    const token = (input as HTMLInputElement).value.trim();
    if (!token) return;
    try { sessionStorage.setItem(ADMIN_TOKEN_KEY, token); } catch { /* sessionStorage blocked — keep in-memory only */ }
    renderAdminPanel();
  };

  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') submit();
  });
  enterBtn.addEventListener('click', submit);
  closeBtn.addEventListener('click', exitAdmin);

  setTimeout(() => (input as HTMLInputElement).focus(), 0);
}

function renderAdminFlaggedList(overlay: HTMLElement, token: string): void {
  const status = el('p', { parent: overlay, text: 'Loading flagged runs…' });
  status.style.cssText = 'margin:0 0 12px;font-size:0.88rem;color:rgba(180,140,255,0.7);letter-spacing:0.08em;min-height:1.2em;';

  const list = el('div', { parent: overlay });
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:760px;width:100%;margin:0 auto;';

  const footer = el('div', { className: 'menu-row', parent: overlay });
  const refreshBtn = el('button', { className: 'menu-btn secondary', parent: footer, text: 'REFRESH' });
  const logoutBtn = el('button', { className: 'menu-btn secondary', parent: footer, text: 'CLEAR TOKEN' });
  const closeBtn = el('button', { className: 'menu-btn', parent: footer, text: 'BACK' });

  refreshBtn.addEventListener('click', () => renderAdminPanel());
  logoutBtn.addEventListener('click', () => {
    try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
    renderAdminPanel();
  });
  closeBtn.addEventListener('click', exitAdmin);

  void (async () => {
    const result = await fetchFlagged(token);
    if (!result.ok) {
      if (result.error === 'unauthorized') {
        try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
        status.textContent = 'Token rejected. Re-enter to retry.';
        setTimeout(() => renderAdminPanel(), 1200);
        return;
      }
      status.textContent = `Failed: ${result.error}${result.status ? ` (HTTP ${result.status})` : ''}`;
      return;
    }
    if (result.flagged.length === 0) {
      status.textContent = 'No flagged runs. Either the heuristics haven\'t tripped, or you\'ve cleared everything.';
      return;
    }
    status.textContent = `${result.flagged.length} flagged ${result.flagged.length === 1 ? 'player' : 'players'}.`;
    for (const entry of result.flagged) {
      list.appendChild(renderFlaggedRow(entry));
    }
  })();
}

function renderFlaggedRow(entry: FlaggedEntry): HTMLElement {
  const row = el('div');
  row.style.cssText = 'border:1px solid rgba(255,80,80,0.35);border-radius:8px;padding:10px 14px;background:rgba(255,80,80,0.06);display:flex;flex-direction:column;gap:6px;';

  const head = el('div', { parent: row });
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;';

  const pk = el('div', { parent: head, text: shortPubkey(entry.pubkey) });
  pk.style.cssText = 'font-family:monospace;font-size:0.95rem;color:#ffb0b0;letter-spacing:0.06em;';

  const when = el('div', { parent: head, text: formatFlaggedAt(entry.flagged_at) });
  when.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.6);letter-spacing:0.06em;';

  const reasonText = entry.flag_reason ?? '(no reason recorded)';
  const reason = el('div', { parent: row, text: reasonText });
  reason.style.cssText = 'font-size:0.82rem;color:rgba(255,200,200,0.85);font-family:monospace;word-break:break-word;';

  const meta = el('div', { parent: row });
  meta.style.cssText = 'display:flex;gap:14px;font-size:0.82rem;color:rgba(220,210,255,0.75);letter-spacing:0.06em;flex-wrap:wrap;';
  if (entry.claim) {
    el('span', { parent: meta, text: `WAVE ${entry.claim.wave}` });
    el('span', { parent: meta, text: `SCORE ${entry.claim.score?.toLocaleString() ?? '—'}` });
    if (entry.claim.seed) el('span', { parent: meta, text: `SEED ${entry.claim.seed}` });
  } else {
    el('span', { parent: meta, text: 'No credited claim recorded.' });
  }

  const actions = el('div', { parent: row });
  actions.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const watch = el('button', { className: 'menu-btn', parent: actions, text: 'WATCH' });
  if (!entry.claim?.score_event_id) {
    watch.setAttribute('disabled', 'true');
    watch.style.opacity = '0.4';
    watch.title = 'No kind 30762 score event id stored — cannot fetch ghost.';
  } else {
    const claim = entry.claim;
    watch.addEventListener('click', () => {
      renderReplayTheatre({
        scoreEventId: claim.score_event_id!,
        displayName: shortPubkey(entry.pubkey),
        score: claim.score ?? 0,
        wave: claim.wave ?? 0,
        sats: 0,
        onClose: () => renderAdminPanel(),
      });
    });
  }
  const copyPk = el('button', { className: 'menu-btn secondary', parent: actions, text: 'COPY PUBKEY' });
  copyPk.addEventListener('click', () => {
    void navigator.clipboard?.writeText(entry.pubkey).then(() => {
      copyPk.textContent = 'COPIED';
      setTimeout(() => (copyPk.textContent = 'COPY PUBKEY'), 1200);
    });
  });
  return row;
}

function exitAdmin(): void {
  // Drop ?admin from the URL so a refresh goes back to the normal title.
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('admin');
    window.history.replaceState({}, '', url.toString());
  } catch { /* ignore */ }
  window.location.reload();
}

// ── Jury page ─────────────────────────────────────────────────────────────────
//
// Public cheat-review surface at /jury. Anyone can land here — no sign-in
// required to spectate. Signed-in players can set up an anonymous jury
// identity (kind 30765 delegation) so the faucet can include them in
// future case circles, enabling LSAG ballot signing in a later phase.
//
// Pairs with src/jury.ts (data layer) and the faucet's review.ts +
// delegations.ts (case publication + delegation watcher).

function exitJury(): void {
  // Path-based route: send the user back to "/" so a normal refresh shows
  // the title screen. Using location.assign so the SPA reboots cleanly
  // rather than trying to re-render the title from the jury overlay.
  try {
    window.location.assign('/');
  } catch {
    window.location.reload();
  }
}

export function renderJuryPage(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  const header = el('div', { parent: overlay });
  header.style.cssText = 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:6px;';
  el('h2', { parent: header, text: 'PALLASITE · JURY' });
  const tag = el('span', { parent: header, text: 'PUBLIC · ANONYMOUS REVIEW' });
  tag.style.cssText = 'font-size:0.72rem;color:rgba(180,140,255,0.7);letter-spacing:0.18em;font-family:monospace;';

  const intro = el('p', { parent: overlay });
  intro.style.cssText = 'margin:4px auto 18px;font-size:0.85rem;color:rgba(220,210,255,0.75);max-width:680px;line-height:1.5;text-align:center;';
  intro.innerHTML =
    'The faucet flags runs whose telemetry looks impossible (bot-tier hit ratios, score inflation, etc.). ' +
    'Each flag publishes a kind 31764 case to relays. Anyone can watch the ghost replay. ' +
    'Jurors verified by NIP-58 badges cast anonymous trust scores via <span style="color:#b890ff;font-family:monospace;">nostr-veil</span> — ' +
    'the ring signature hides who voted while the verdict (median rank) is publicly auditable.';

  // Setup banner — depends on session + identity state. Re-rendered on
  // state changes (sign-in completes, identity created, delegation
  // published, etc.).
  const setupSection = el('div', { parent: overlay });
  setupSection.style.cssText = 'margin:0 auto 18px;max-width:680px;width:100%;';
  renderJurySetupBanner(setupSection, state);

  const status = el('p', { parent: overlay });
  status.style.cssText = 'margin:0 0 12px;font-size:0.88rem;color:rgba(180,140,255,0.7);letter-spacing:0.08em;min-height:1.2em;text-align:center;';
  status.textContent = 'Loading open cases…';

  const list = el('div', { parent: overlay });
  list.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:760px;width:100%;margin:0 auto;';

  const footer = el('div', { className: 'menu-row', parent: overlay });
  const refreshBtn = el('button', { className: 'menu-btn secondary', parent: footer, text: 'REFRESH' });
  const backBtn = el('button', { className: 'menu-btn', parent: footer, text: 'BACK' });
  refreshBtn.addEventListener('click', () => renderJuryPage(state));
  backBtn.addEventListener('click', exitJury);

  void (async () => {
    const cases = await fetchReviewCases();
    if (cases.length === 0) {
      status.textContent = 'No open cases on relays right now. Either the heuristics have not tripped, or the relay set is unreachable.';
      return;
    }
    const word = cases.length === 1 ? 'case' : 'cases';
    status.textContent = `${cases.length} open ${word}.`;
    const identity = getStoredJuryIdentity();
    for (const c of cases) {
      list.appendChild(renderJuryCaseCard(c, identity, state));
    }
  })();
}

function renderJurySetupBanner(parent: HTMLElement, state: GameState): void {
  parent.innerHTML = '';
  const session = state.session;
  const identity = getStoredJuryIdentity();

  if (!session) {
    const card = el('div', { parent });
    card.style.cssText = 'border:1px solid rgba(184,144,255,0.35);border-radius:8px;padding:12px 16px;background:rgba(120,90,200,0.08);display:flex;flex-direction:column;gap:8px;';
    const title = el('div', { parent: card, text: 'Spectator mode' });
    title.style.cssText = 'font-size:0.92rem;color:#cbb6ff;letter-spacing:0.12em;text-transform:uppercase;';
    el('div', { parent: card, text: 'Anyone can watch the ghosts and read the verdict trail. Sign in if you want to set up an anonymous jury identity and vote on future cases.' })
      .style.cssText = 'font-size:0.85rem;color:rgba(220,210,255,0.8);line-height:1.5;';
    const row = el('div', { parent: card });
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const signInBtn = el('button', { className: 'menu-btn', parent: row, text: 'SIGN IN' });
    signInBtn.addEventListener('click', () => { void onJurySignIn(state, parent); });
    return;
  }

  if (!identity) {
    const card = el('div', { parent });
    card.style.cssText = 'border:1px solid rgba(184,144,255,0.45);border-radius:8px;padding:12px 16px;background:rgba(120,90,200,0.12);display:flex;flex-direction:column;gap:8px;';
    el('div', { parent: card, text: 'You\'re signed in. Set up a jury identity to enable voting.' })
      .style.cssText = 'font-size:0.95rem;color:#ddc8ff;letter-spacing:0.04em;';
    el('div', { parent: card, text: 'A fresh keypair is generated locally; your master signs a delegation that links it to your Nostr identity. The master never leaves your signer. The jury private key stays in your browser.' })
      .style.cssText = 'font-size:0.82rem;color:rgba(220,210,255,0.75);line-height:1.5;';
    const row = el('div', { parent: card });
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
    const setupBtn = el('button', { className: 'menu-btn', parent: row, text: 'SET UP JURY IDENTITY' });
    setupBtn.addEventListener('click', () => { void onJurySetupStart(state, parent); });
    return;
  }

  // Has identity — assume delegation was published when it was set up.
  // Future improvement: query relays for the kind 30765 event and show
  // its publish status / event id. For phase 2a it's enough to surface
  // that the identity is configured.
  const card = el('div', { parent });
  card.style.cssText = 'border:1px solid rgba(120,200,150,0.45);border-radius:8px;padding:12px 16px;background:rgba(80,200,150,0.08);display:flex;flex-direction:column;gap:8px;';
  const head = el('div', { parent: card });
  head.style.cssText = 'display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;';
  el('div', { parent: head, text: 'Jury identity active' })
    .style.cssText = 'font-size:0.95rem;color:#a8eecf;letter-spacing:0.04em;';
  const pk = el('div', { parent: head, text: shortPubkey(identity.pubkey) });
  pk.style.cssText = 'font-family:monospace;font-size:0.78rem;color:rgba(220,210,255,0.7);';
  el('div', { parent: card, text: 'Your master pubkey has delegated voting authority to this key. When a case lands and your jury pubkey appears in its circle, you can cast an anonymous LSAG ballot — coming in the next deploy.' })
    .style.cssText = 'font-size:0.82rem;color:rgba(220,210,255,0.75);line-height:1.5;';
  const row = el('div', { parent: card });
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
  const republishBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'REPUBLISH DELEGATION' });
  republishBtn.addEventListener('click', () => { void onJuryRepublish(state, identity); });
  const clearBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'CLEAR JURY KEY' });
  clearBtn.addEventListener('click', () => {
    if (!window.confirm('Clear your jury identity? You\'ll need to set up a new one to vote again. The previously published delegation remains on relays and is still tied to your master — to fully rotate, publish a fresh delegation with a new key.')) return;
    clearStoredJuryIdentity();
    renderJurySetupBanner(parent, state);
  });
}

async function onJurySignIn(state: GameState, banner: HTMLElement): Promise<void> {
  try {
    const session = await auth.signIn();
    if (session) {
      state.session = session;
      renderJurySetupBanner(banner, state);
    }
  } catch (err) {
    console.warn('[jury] sign-in failed:', err);
    window.alert(
      err instanceof auth.SignInTimeoutError
        ? `Timeout — ${err.message}`
        : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function onJurySetupStart(state: GameState, banner: HTMLElement): Promise<void> {
  const session = state.session;
  if (!session) return;
  const identity = generateJuryIdentity();
  // Render an in-progress card so the user sees what's happening — sign +
  // publish can take a few seconds and feedback matters here.
  banner.innerHTML = '';
  const card = el('div', { parent: banner });
  card.style.cssText = 'border:1px solid rgba(184,144,255,0.55);border-radius:8px;padding:12px 16px;background:rgba(120,90,200,0.15);display:flex;flex-direction:column;gap:8px;';
  el('div', { parent: card, text: 'Publishing your jury delegation…' })
    .style.cssText = 'font-size:0.95rem;color:#ddc8ff;letter-spacing:0.04em;';
  const statusLine = el('div', { parent: card });
  statusLine.style.cssText = 'font-size:0.82rem;color:rgba(220,210,255,0.75);line-height:1.5;';
  statusLine.textContent = 'Requesting signature from your Nostr signer…';

  const result = await publishDelegation(session, identity.pubkey);
  if (!result.ok) {
    statusLine.textContent = `Failed: ${result.error ?? 'no relays accepted the event'}.`;
    statusLine.style.color = '#ff8a8a';
    const retryRow = el('div', { parent: card });
    retryRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
    const retry = el('button', { className: 'menu-btn', parent: retryRow, text: 'RETRY' });
    retry.addEventListener('click', () => { void onJurySetupStart(state, banner); });
    const cancel = el('button', { className: 'menu-btn secondary', parent: retryRow, text: 'CANCEL' });
    cancel.addEventListener('click', () => renderJurySetupBanner(banner, state));
    return;
  }
  // Only persist the privkey after the delegation has been signed and
  // accepted by at least one relay — a partial failure shouldn't leave a
  // locally-stored key that nobody else knows about.
  setStoredJuryIdentity(identity);
  statusLine.innerHTML =
    `Published to <strong>${result.publishedTo.length}</strong> of <strong>${result.publishedTo.length + result.failed.length}</strong> relays. ` +
    `Jury identity stored locally. The faucet's watcher will pick it up on its next pass.`;
  statusLine.style.color = '#a8eecf';
  const ok = el('button', { className: 'menu-btn', parent: card, text: 'DONE' });
  ok.style.alignSelf = 'flex-start';
  ok.addEventListener('click', () => renderJurySetupBanner(banner, state));
}

async function onJuryRepublish(state: GameState, identity: StoredJuryIdentity): Promise<void> {
  const session = state.session;
  if (!session) return;
  const result = await publishDelegation(session, identity.pubkey);
  if (!result.ok) {
    window.alert(`Republish failed: ${result.error ?? 'no relays accepted the event'}.`);
    return;
  }
  window.alert(`Republished to ${result.publishedTo.length} of ${result.publishedTo.length + result.failed.length} relays.`);
}

function renderJuryCaseCard(c: ReviewCase, identity: StoredJuryIdentity | null, state: GameState): HTMLElement {
  const row = el('div');
  row.style.cssText = 'border:1px solid rgba(255,80,80,0.35);border-radius:8px;padding:10px 14px;background:rgba(255,80,80,0.06);display:flex;flex-direction:column;gap:6px;';

  const head = el('div', { parent: row });
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;';

  const pk = el('div', { parent: head, text: shortPubkey(c.flaggedPubkey) });
  pk.style.cssText = 'font-family:monospace;font-size:0.95rem;color:#ffb0b0;letter-spacing:0.06em;';

  const when = el('div', { parent: head, text: formatFlaggedAt(c.createdAt * 1000) });
  when.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.6);letter-spacing:0.06em;';

  const reason = el('div', { parent: row, text: c.flagReason });
  reason.style.cssText = 'font-size:0.82rem;color:rgba(255,200,200,0.85);font-family:monospace;word-break:break-word;';

  const meta = el('div', { parent: row });
  meta.style.cssText = 'display:flex;gap:14px;font-size:0.82rem;color:rgba(220,210,255,0.75);letter-spacing:0.06em;flex-wrap:wrap;';
  el('span', { parent: meta, text: `WAVE ${c.wave}` });
  el('span', { parent: meta, text: `SCORE ${c.score.toLocaleString()}` });
  if (c.seed) el('span', { parent: meta, text: `SEED ${c.seed}` });
  const circleLabel = c.underQuorum ? `${c.circleSize} JURORS · UNDER QUORUM` : `${c.circleSize} JURORS`;
  const circleBadge = el('span', { parent: meta, text: circleLabel });
  circleBadge.style.color = c.underQuorum ? 'rgba(255,184,120,0.85)' : 'rgba(180,255,200,0.85)';

  // Eligibility hint for the signed-in juror.
  if (identity) {
    const inCircle = c.circleMembers.includes(identity.pubkey);
    const elig = el('div', { parent: row });
    elig.style.cssText = 'font-size:0.78rem;letter-spacing:0.08em;';
    if (inCircle) {
      elig.textContent = '✓ YOU ARE IN THIS CIRCLE — VOTING UI SHIPS IN THE NEXT DEPLOY';
      elig.style.color = '#a8eecf';
    } else {
      elig.textContent = '— YOU ARE NOT IN THIS CIRCLE';
      elig.style.color = 'rgba(220,210,255,0.45)';
    }
  }

  const actions = el('div', { parent: row });
  actions.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const watch = el('button', { className: 'menu-btn', parent: actions, text: 'WATCH' });
  watch.addEventListener('click', () => {
    renderReplayTheatre({
      scoreEventId: c.scoreEventId,
      displayName: shortPubkey(c.flaggedPubkey),
      score: c.score,
      wave: c.wave,
      sats: 0,
      onClose: () => renderJuryPage(state),
    });
  });
  const copyPk = el('button', { className: 'menu-btn secondary', parent: actions, text: 'COPY PUBKEY' });
  copyPk.addEventListener('click', () => {
    void navigator.clipboard?.writeText(c.flaggedPubkey).then(() => {
      copyPk.textContent = 'COPIED';
      setTimeout(() => (copyPk.textContent = 'COPY PUBKEY'), 1200);
    });
  });
  return row;
}

// ── Watch page (watch.pallasite.app) ──────────────────────────────────────────
//
// Public live spectator surface. Subscribes to kind 30762 score events from
// the faucet game pubkey and shows one card per recently-active player.
// Visitors can WATCH the ghost replay or ZAP the player. v1 surfaces final
// runs (newest first); a later faucet change emitting state='active' on a
// heartbeat will let this same surface show in-progress runs in real time.

const WATCH_ZAP_PRESETS_SATS = [50, 200, 1000] as const;

let watchActiveUnsubscribe: (() => void) | null = null;

export function renderWatchPage(state: GameState, opts: { autoOpenLive?: boolean } = {}): void {
  clearOverlay();
  // Tear down any prior subscription before we open a new one — re-entering
  // the page (e.g. via BACK from the theatre) would otherwise leak sockets.
  watchActiveUnsubscribe?.();
  watchActiveUnsubscribe = null;
  // When the user lands fresh on the watch page (initial navigation, not
  // a BACK from the theatre), auto-jump into the live theatre if there's
  // exactly one player live. Saves a click during testing and feels right
  // when nobody else is around. Reset on user-initiated close so they
  // don't get bounced back in.
  let autoOpenPending = opts.autoOpenLive ?? false;

  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  const header = el('div', { parent: overlay });
  header.style.cssText = 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:6px;';
  el('h2', { parent: header, text: 'PALLASITE · WATCH' });
  const live = el('span', { parent: header, text: 'LIVE · RECENT RUNS' });
  live.style.cssText = 'font-size:0.72rem;color:rgba(255,216,74,0.85);letter-spacing:0.18em;font-family:monospace;';

  const intro = el('p', { parent: overlay });
  intro.style.cssText = 'margin:4px auto 18px;font-size:0.85rem;color:rgba(220,210,255,0.75);max-width:680px;line-height:1.5;text-align:center;';
  intro.innerHTML =
    'Every claimed run lands here as a kind 30762 score event signed by the faucet. ' +
    'Click <strong>WATCH</strong> to play back the kind 30763 ghost in the replay theatre. ' +
    'Click <strong>⚡ ZAP</strong> to send sats straight to the player\'s lightning address.';

  const status = el('p', { parent: overlay });
  status.style.cssText = 'margin:0 0 12px;font-size:0.88rem;color:rgba(255,216,74,0.75);letter-spacing:0.08em;min-height:1.2em;text-align:center;';
  status.textContent = 'Connecting to relays…';

  const grid = el('div', { parent: overlay });
  grid.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:760px;width:100%;margin:0 auto;';

  const footer = el('div', { className: 'menu-row', parent: overlay });
  const backBtn = el('button', { className: 'menu-btn', parent: footer, text: 'BACK TO PALLASITE.APP' });
  backBtn.addEventListener('click', () => {
    watchActiveUnsubscribe?.();
    watchActiveUnsubscribe = null;
    try { window.location.assign('https://pallasite.app/'); }
    catch { window.location.assign('/'); }
  });

  // Card rendering — keyed by pubkey so update emits can patch existing
  // cards rather than tear down and rebuild the grid (avoids layout jank
  // and keeps any open zap popovers anchored to the right element).
  const cardByPubkey = new Map<string, HTMLElement>();

  const setCardLiveState = (card: HTMLElement, isLive: boolean): void => {
    card.dataset.live = isLive ? '1' : '0';
    card.style.borderColor = isLive ? 'rgba(140,255,180,0.7)' : 'rgba(255,216,74,0.35)';
    card.style.background = isLive ? 'rgba(60,200,140,0.10)' : 'rgba(255,216,74,0.04)';
    card.style.boxShadow = isLive ? '0 0 14px rgba(140,255,180,0.25)' : 'none';
    const pill = card.querySelector('[data-watch-live-pill]') as HTMLElement | null;
    if (pill) pill.style.display = isLive ? 'inline-block' : 'none';
  };

  const renderEntry = (entry: WatchEntry): void => {
    const existing = cardByPubkey.get(entry.pubkey);
    if (existing) {
      const scorePill = existing.querySelector('[data-watch-score]');
      const wavePill = existing.querySelector('[data-watch-wave]');
      const whenPill = existing.querySelector('[data-watch-when]');
      if (scorePill) scorePill.textContent = entry.score.toLocaleString();
      if (wavePill) wavePill.textContent = `WAVE ${entry.wave}`;
      if (whenPill) whenPill.textContent = entry.isLive ? 'LIVE' : timeAgo(entry.createdAt);
      existing.dataset.createdAt = String(entry.createdAt);
      setCardLiveState(existing, entry.isLive);
      return;
    }
    const card = renderWatchCard(entry, state);
    cardByPubkey.set(entry.pubkey, card);
    setCardLiveState(card, entry.isLive);
    grid.appendChild(card);
  };

  const reorderGrid = (entries: WatchEntry[]): void => {
    // LIVE entries first, then everything else newest-first.
    const sorted = [...entries].sort(
      (a, b) =>
        Number(b.isLive) - Number(a.isLive) ||
        b.createdAt - a.createdAt,
    );
    for (const e of sorted) {
      const card = cardByPubkey.get(e.pubkey);
      if (card) grid.appendChild(card);
    }
  };

  watchActiveUnsubscribe = subscribeRecentRuns(
    (entries) => {
      // Drop locally-dismissed event ids; user removed them via the DISMISS
      // button so they shouldn't re-appear on update emits.
      const dismissed = getDismissedWatchEntries();
      const visible = entries.filter((e) => !dismissed.has(e.eventId));
      if (visible.length === 0) return; // status copy handled in onStatus
      const count = visible.length;
      status.textContent = `${count} ${count === 1 ? 'player' : 'players'} surfaced from the last batch.`;
      for (const e of visible) renderEntry(e);
      reorderGrid(visible);
      // Auto-open into the live theatre if exactly one entry is LIVE and
      // we haven't already consumed the flag. Use a setTimeout so the
      // current onUpdate finishes rendering before the live theatre
      // tears the watch DOM down underneath us.
      const liveOnly = visible.filter((e) => e.isLive);
      if (autoOpenPending && liveOnly.length === 1) {
        autoOpenPending = false;
        const e = liveOnly[0];
        window.setTimeout(() => {
          watchActiveUnsubscribe?.();
          watchActiveUnsubscribe = null;
          renderLiveTheatre({
            masterPubkey: e.pubkey,
            displayName: shortPubkey(e.pubkey),
            initialScore: e.score,
            initialWave: e.wave,
            runStartedAtMs: e.createdAt * 1000,
            onClose: () => renderWatchPage(state),
          });
        }, 60);
      }
    },
    {
      onStatus: (s) => {
        // Only mutate copy while the grid is still empty — once cards land,
        // the entry-count line above takes precedence.
        if (cardByPubkey.size > 0) return;
        if (s.relaysAttempted === 0) {
          status.textContent = 'Connecting to relays…';
        } else if (s.relaysSettled === 0) {
          status.textContent = `Connecting to ${s.relaysAttempted} relays…`;
        } else if (s.emptyConfirmed) {
          status.textContent = `No runs on relays yet (${s.relaysSettled}/${s.relaysAttempted} settled). Be the first.`;
        } else {
          status.textContent = `Listening to ${s.relaysSettled}/${s.relaysAttempted} relays…`;
        }
      },
    },
  );

  // Lightweight "X minutes ago" updater so cards age visibly without a
  // full re-subscribe. Also re-evaluates liveness: a LIVE card whose
  // most recent heartbeat is now older than LIVE_FRESHNESS_MS demotes
  // to a regular recent-run card.
  const ageTimer = window.setInterval(() => {
    const now = Date.now();
    let anyDemoted = false;
    for (const card of cardByPubkey.values()) {
      const at = parseInt(card.dataset.createdAt ?? '0', 10);
      if (!at) continue;
      const stillLive = card.dataset.live === '1' && now - at * 1000 < LIVE_FRESHNESS_MS;
      const wasLive = card.dataset.live === '1';
      const whenPill = card.querySelector('[data-watch-when]');
      if (whenPill) whenPill.textContent = stillLive ? 'LIVE' : timeAgo(at);
      if (wasLive && !stillLive) {
        setCardLiveState(card, false);
        anyDemoted = true;
      }
    }
    // If we demoted a card, the LIVE-first sort may now be wrong — push
    // ex-live cards down. Cheap: snapshot order, re-sort by dataset.live then createdAt.
    if (anyDemoted) {
      const cards = Array.from(cardByPubkey.values()).sort((a, b) => {
        const liveDelta = Number(b.dataset.live === '1') - Number(a.dataset.live === '1');
        if (liveDelta) return liveDelta;
        return parseInt(b.dataset.createdAt ?? '0', 10) - parseInt(a.dataset.createdAt ?? '0', 10);
      });
      for (const c of cards) grid.appendChild(c);
    }
  }, 10_000);
  // When user navigates away, stop the timer too. Hook into the unsubscribe.
  const baseUnsub = watchActiveUnsubscribe;
  watchActiveUnsubscribe = (): void => {
    window.clearInterval(ageTimer);
    baseUnsub?.();
  };
}

function renderWatchCard(entry: WatchEntry, state: GameState): HTMLElement {
  const card = el('div');
  card.dataset.pubkey = entry.pubkey;
  card.dataset.createdAt = String(entry.createdAt);
  card.style.cssText = 'border:1px solid rgba(255,216,74,0.35);border-radius:8px;padding:10px 14px;background:rgba(255,216,74,0.04);display:flex;flex-direction:column;gap:6px;';

  const head = el('div', { parent: card });
  head.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;';

  const name = el('div', { parent: head, text: shortPubkey(entry.pubkey) });
  name.style.cssText = 'font-family:monospace;font-size:0.95rem;color:#ffe0a0;letter-spacing:0.06em;';
  // Resolve display name from kind 0 in the background — replaces the
  // short pubkey when (and if) we have a profile.
  void (async () => {
    try {
      const profile = await fetchProfile(entry.pubkey);
      const display = bestName(profile, entry.pubkey);
      if (display && display !== entry.pubkey) name.textContent = display;
    } catch { /* ignore */ }
  })();

  const meta = el('div', { parent: head });
  meta.style.cssText = 'display:flex;gap:8px;align-items:baseline;';
  const livePill = el('span', { parent: meta, text: 'LIVE' });
  livePill.setAttribute('data-watch-live-pill', '1');
  livePill.style.cssText = 'display:none;font-size:0.68rem;letter-spacing:0.16em;color:#8cffb4;border:1px solid rgba(140,255,180,0.55);padding:1px 6px;border-radius:3px;font-family:monospace;animation:pallasite-live-pulse 1.6s ease-in-out infinite;';
  const when = el('div', { parent: meta, text: entry.isLive ? 'LIVE' : timeAgo(entry.createdAt) });
  when.setAttribute('data-watch-when', '1');
  when.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.6);letter-spacing:0.06em;';

  const stats = el('div', { parent: card });
  stats.style.cssText = 'display:flex;gap:14px;font-size:0.88rem;color:rgba(220,210,255,0.85);letter-spacing:0.06em;flex-wrap:wrap;align-items:baseline;';
  const score = el('span', { parent: stats, text: entry.score.toLocaleString() });
  score.setAttribute('data-watch-score', '1');
  score.style.cssText = 'color:#ffe0a0;font-size:1.05rem;font-family:monospace;';
  const wave = el('span', { parent: stats, text: `WAVE ${entry.wave}` });
  wave.setAttribute('data-watch-wave', '1');
  if (entry.sats > 0) el('span', { parent: stats, text: `₿ ${entry.sats}` })
    .style.cssText = 'color:#ffd84a;';
  if (entry.seed) el('span', { parent: stats, text: `SEED ${entry.seed}` })
    .style.cssText = 'color:rgba(180,140,255,0.7);font-family:monospace;';

  const actions = el('div', { parent: card });
  actions.style.cssText = 'display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;';
  const watch = el('button', { className: 'menu-btn', parent: actions, text: 'WATCH' });
  // LIVE actives open the live theatre (kind 22769 frame subscription).
  // Finals open the replay theatre (kind 30763 ghost from gamestr-spec).
  // Stale/orphan actives that aren't fresh enough to be LIVE get a
  // disabled label since their kind 30763 ghost was never published
  // either. Non-live / non-final entries still get a clickable button:
  // we attempt the ghost fetch on demand — if the player has since
  // claimed, the replay opens; if not, we surface a friendly retry.
  const updateWatchButton = (live: boolean, st: WatchEntry['state']): void => {
    if (live) {
      watch.disabled = false;
      watch.style.opacity = '1';
      watch.style.cursor = 'pointer';
      watch.textContent = '👁  WATCH LIVE';
      watch.title = 'Live spectate — kind 22769 frame stream rendered in lockstep.';
      return;
    }
    const isFinal = st === 'final';
    watch.disabled = false;
    watch.style.opacity = '1';
    watch.style.cursor = 'pointer';
    watch.textContent = isFinal ? 'WATCH' : 'TRY REPLAY';
    watch.title = isFinal
      ? 'Open the kind 30763 ghost in the replay theatre.'
      : 'The replay (kind 30763 ghost) is published when the run ends. We\'ll check the relay — if the player has claimed since, it will open.';
  };
  updateWatchButton(entry.isLive, entry.state);
  watch.setAttribute('data-watch-button', '1');
  watch.addEventListener('click', () => {
    if (watch.disabled) return;
    if (entry.isLive) {
      renderLiveTheatre({
        masterPubkey: entry.pubkey,
        displayName: name.textContent ?? shortPubkey(entry.pubkey),
        initialScore: entry.score,
        initialWave: entry.wave,
        // WatchEntry.createdAt is the most-recent heartbeat (within a
        // few seconds of run start in practice) — good enough as the
        // ghost-fetch `since` filter when the spectator clicks
        // "WATCH FROM START" after the run ends.
        runStartedAtMs: entry.createdAt * 1000,
        onClose: () => renderWatchPage(state),
      });
      return;
    }
    if (entry.state !== 'final') {
      // Speculative ghost fetch — the entry's state event was
      // 'active' (or null) so renderReplayTheatre would 404 on the
      // entry.eventId. Look the player's most-recent ghost up by
      // author + since-time and hand off if it lands. Mirrors the
      // STREAM ENDED auto-try in the live theatre.
      watch.disabled = true;
      const original = watch.textContent;
      watch.textContent = 'LOADING…';
      void (async () => {
        const sinceSec = Math.max(0, entry.createdAt - 30);
        const scoreEventId = await findScoreIdForLatestGhost(entry.pubkey, sinceSec).catch(() => null);
        if (!scoreEventId) {
          watch.textContent = 'NO REPLAY YET';
          watch.title = 'Player has not claimed yet — the kind 30763 ghost is published at claim. Try again later.';
          setTimeout(() => { watch.disabled = false; watch.textContent = original ?? 'TRY REPLAY'; }, 2_500);
          return;
        }
        renderReplayTheatre({
          scoreEventId,
          displayName: name.textContent ?? shortPubkey(entry.pubkey),
          score: entry.score,
          wave: entry.wave,
          sats: entry.sats,
          onClose: () => renderWatchPage(state),
        });
      })();
      return;
    }
    renderReplayTheatre({
      scoreEventId: entry.eventId,
      displayName: name.textContent ?? shortPubkey(entry.pubkey),
      score: entry.score,
      wave: entry.wave,
      sats: entry.sats,
      onClose: () => renderWatchPage(state),
    });
  });

  const zap = el('button', { className: 'menu-btn secondary', parent: actions, text: '⚡ ZAP' });
  zap.style.cssText = 'color:#ffd84a;border-color:rgba(255,216,74,0.45);';
  zap.addEventListener('click', () => { void onWatchZapClick(entry, name.textContent ?? shortPubkey(entry.pubkey), zap, actions, state); });

  const dismiss = el('button', { className: 'menu-btn secondary', parent: actions, text: 'DISMISS' });
  dismiss.style.cssText = 'color:rgba(220,210,255,0.6);border-color:rgba(220,210,255,0.25);font-size:0.78rem;';
  dismiss.title = 'Hide this entry from your view. Local-only — does not publish a NIP-09 deletion.';
  dismiss.addEventListener('click', () => {
    dismissWatchEntry(entry.eventId);
    card.remove();
  });

  return card;
}

async function onWatchZapClick(
  entry: WatchEntry,
  displayName: string,
  zapBtn: HTMLButtonElement,
  actionsRow: HTMLElement,
  state: GameState,
): Promise<void> {
  zapBtn.disabled = true;
  zapBtn.textContent = '⚡ …';
  let lud16: string | null;
  try {
    const profile = await fetchProfile(entry.pubkey);
    lud16 = profile?.lud16 ?? null;
  } catch {
    lud16 = null;
  }
  if (!lud16) {
    zapBtn.disabled = false;
    zapBtn.textContent = '⚡ NO LUD16';
    zapBtn.title = 'This player has no lightning address in their Nostr profile.';
    setTimeout(() => { zapBtn.textContent = '⚡ ZAP'; zapBtn.title = ''; }, 2400);
    return;
  }
  zapBtn.disabled = false;
  zapBtn.textContent = '⚡ ZAP';

  // Replace the actions row with an inline amount picker — anchored under
  // the same card so the user doesn't lose context. CANCEL puts the
  // original buttons back.
  const original = Array.from(actionsRow.children);
  actionsRow.innerHTML = '';
  const label = el('span', { parent: actionsRow, text: `ZAP ${displayName}:` });
  label.style.cssText = 'font-size:0.82rem;color:rgba(255,216,74,0.85);letter-spacing:0.06em;align-self:center;';
  for (const sats of WATCH_ZAP_PRESETS_SATS) {
    const btn = el('button', { className: 'menu-btn secondary', parent: actionsRow, text: `${sats}` });
    btn.style.cssText = 'color:#ffd84a;border-color:rgba(255,216,74,0.55);min-width:64px;';
    btn.addEventListener('click', () => {
      const recipient: ZapRecipient = { pubkey: entry.pubkey, lightningAddress: lud16! };
      void quickZapToRecipient(state, recipient, displayName, sats, btn);
    });
  }
  const cancel = el('button', { className: 'menu-btn secondary', parent: actionsRow, text: 'CANCEL' });
  cancel.addEventListener('click', () => {
    actionsRow.innerHTML = '';
    for (const child of original) actionsRow.appendChild(child);
  });
}

/** Mirror of quickZap (for the dev) but addressing an arbitrary recipient. */
async function quickZapToRecipient(
  state: GameState,
  recipient: ZapRecipient,
  displayName: string,
  amountSats: number,
  btn: HTMLButtonElement,
): Promise<void> {
  const originalHtml = btn.innerHTML;
  const restore = (): void => { btn.innerHTML = originalHtml; btn.disabled = false; btn.style.opacity = '1'; };
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.innerHTML = `⚡ …`;
  const pop = createZapPopover(amountSats);
  // Customise the popover heading so the user knows who's being zapped.
  const headings = pop.querySelectorAll('p');
  if (headings[0]) headings[0].textContent = `ZAP ${displayName} · ${amountSats} SATS`;

  try {
    const res = await requestZapTo({
      recipient,
      session: state.session,
      amountSats,
      comment: `Pallasite watch zap — wave done well`,
    });
    populateZapPopover(pop, res.invoice, amountSats, res.isZap);
    restore();
    if (hasWebLN()) {
      try {
        await payViaWebLN(res.invoice);
        markPopoverPaid(pop, amountSats);
        return;
      } catch { /* WebLN refused — leave the QR up */ }
    }
  } catch (err) {
    failPopover(pop, err instanceof Error ? err.message : String(err));
    btn.innerHTML = '✗ FAIL';
    btn.style.borderColor = '#ff5050';
    btn.style.color = '#ff5050';
    setTimeout(() => {
      btn.style.borderColor = 'rgba(255,216,74,0.55)';
      btn.style.color = '#ffd84a';
      restore();
    }, 2500);
  }
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
      const wrap = el('div', { parent });
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;margin:4px 0';
      const note = el('p', {
        parent: wrap,
        text: 'Auth-only · reconnecting signer…',
      });
      note.style.cssText = 'font-size:0.82rem;color:rgba(255,200,100,0.85);margin:0';
      // Manual nudge — if the silent watcher hasn't picked up the signer
      // after a few seconds (extension hibernation, browser policy), the
      // player can force a fresh restore. Quicker than logging out and
      // back in.
      const reconnectBtn = el('button', {
        className: 'menu-btn secondary',
        parent: wrap,
        text: 'RECONNECT SIGNER',
      }) as HTMLButtonElement;
      reconnectBtn.style.cssText = 'padding:4px 10px;font-size:0.72rem;cursor:pointer';
      onTap(reconnectBtn, () => {
        void (async () => {
          reconnectBtn.disabled = true;
          note.textContent = 'Reconnecting…';
          try {
            const upgraded = await auth.tryRestore();
            if (upgraded?.signer.capabilities.canSignEvents
                && state.session
                && upgraded.pubkey === state.session.pubkey) {
              state.session = upgraded;
              renderTitle(state);
              return;
            }
            note.textContent = 'Signer still unreachable. Unlock your extension and tap again.';
            reconnectBtn.disabled = false;
          } catch (err) {
            note.textContent = err instanceof Error ? err.message : 'Reconnect failed.';
            reconnectBtn.disabled = false;
          }
        })();
      });
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

// Used by the withdraw flow on title — players type their LN address once
// and we remember it for future withdraws on this device.
export function getStoredLnAddress(): string | null {
  try {
    const v = localStorage.getItem(LN_ADDRESS_KEY);
    return v && LN_ADDRESS_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function setStoredLnAddress(v: string): void {
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
    case 'sign_failed': {
      if (!detail) return 'Could not sign claim. Check your signer extension.';
      if (/timeout|signer-timeout/i.test(detail)) {
        return 'Signer did not respond. Unlock your extension and try again.';
      }
      if (/reject|denied|cancel/i.test(detail)) return 'Signature rejected.';
      return `Could not sign claim: ${detail.slice(0, 80)}`;
    }
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

  // Recap claim flow: 18+ gate (Schedule 11 requirement) → CLAIM button →
  // server credits the player's persistent balance. The LN-address-on-recap
  // flow that lived here previously moved to the WITHDRAW screen on title;
  // claim just banks the sats, withdraw cashes them out on the player's
  // schedule (any time balance >= withdrawal threshold).

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
  subline.textContent = state.sats > 0
    ? `Adds to your balance · withdraw on title screen`
    : '';

  const status = el('p', { parent: wrapper, text: '' });
  status.style.cssText = 'font-size:0.85rem;margin:4px 0 0 0;min-height:1.2em';

  const setStatus = (msg: string, color: string): void => {
    status.textContent = msg;
    status.style.color = color;
  };

  claimBtn.textContent = state.sats > 0 ? `CLAIM ${state.sats} SATS` : 'CLAIM';

  const session = state.session;

  const onClaim = async (): Promise<void> => {
    claimBtn.disabled = true;
    setStatus('Crediting balance…', '#5b9dff');

    // Pause the auto-skip-to-title countdown for the duration of the claim.
    // Bunker round-trip + relay publish can take a few seconds on a cold
    // path; without the pause, the credits-screen idle timer could navigate
    // the player back to title before they see the success line.
    setIdlePaused?.(true);

    try {
      const finishedAt = Date.now();
      const duration = Math.max(0, Math.floor(state.runTimeMs));
      const startedAt =
        state.runStartedAt > 0 ? state.runStartedAt : finishedAt - duration;

      const seed = getActiveSeed();
      const runAchievements = getRunAchievements();
      const stats = state.runStats;
      // Aggregate run telemetry — feeds the server-side heuristic cheat
      // flagger (impossible hit ratios, sustained kill rates, score-per-
      // kill outliers). Sent on every claim regardless of achievements so
      // the server always has a fingerprint to compare against.
      const durationSec = Math.max(1, duration / 1000);
      const totalKills =
        stats.asteroidsBroken +
        stats.ufoKills.cruiser + stats.ufoKills.elite + stats.ufoKills.tank +
        stats.ufoKills.sniper + stats.ufoKills.boss +
        stats.minesDestroyed;
      const telemetry: Record<string, unknown> = {
        asteroids_broken: stats.asteroidsBroken,
        ufo_kills: stats.ufoKills,
        mines_destroyed: stats.minesDestroyed,
        veins_broken: stats.veinsBroken,
        bullets_fired: stats.bulletsFired,
        bullets_missed: stats.bulletsMissed,
        hit_ratio: stats.bulletsFired > 0
          ? Math.round(((stats.bulletsFired - stats.bulletsMissed) / stats.bulletsFired) * 1000) / 1000
          : 0,
        largest_combo: stats.largestCombo,
        powerups_collected: stats.powerupsCollected,
        hyperspaces_used: stats.hyperspacesUsed,
        lives_lost: stats.livesLost,
        kills_per_sec: Math.round((totalKills / durationSec) * 100) / 100,
        score_per_kill: totalKills > 0
          ? Math.round((state.score / totalKills) * 10) / 10
          : 0,
        score_per_sec: Math.round((state.score / durationSec) * 10) / 10,
        ...(runAchievements.length > 0
          ? { achievements_unlocked: runAchievements }
          : {}),
      };
      const payload = {
        score: state.score,
        wave: state.wave,
        duration_ms: duration,
        started_at: startedAt,
        finished_at: finishedAt,
        sats_claimed: state.sats,
        cheated: state.cheatedThisRun,
        ...(seed ? { daily_seed: seed } : {}),
        telemetry,
      };
      // Persist BEFORE submit so a tab close, idle-skip, or signer hang
      // doesn't strand the sats. The server has a 5-min replay window for
      // (pubkey, started_at, finished_at); RETRY banner on title surfaces
      // it if this one doesn't land.
      if (state.sats > 0 && !state.cheatedThisRun) {
        savePendingClaim(session.pubkey, payload);
      }
      const result = await submitClaim(session, payload);

      if (result.ok) {
        clearPendingClaim();
        const pityTail = result.pity_bonus && result.pity_bonus > 0
          ? ` (★ +${result.pity_bonus} pity bonus)`
          : '';
        setStatus(
          `✓ Banked ${result.payout_sats} sats · balance: ${result.new_balance}${pityTail}`,
          '#58ff58',
        );
      } else {
        if (isTerminalClaimError(result.error)) clearPendingClaim();
        setStatus(claimErrorMessage(result.error, result.detail), '#ff8050');
        claimBtn.disabled = false;
      }
    } finally {
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
  // Personal ghost — always save when a daily seed was active so the
  // player can race themselves on their next attempt. The setting only
  // gates RENDERING; saving happens regardless so enabling later picks
  // up the most recent run rather than waiting for a fresh one.
  const seed = getActiveSeed();
  if (seed && state.ghostPoseSamples.length >= 2 && !state.cheatedThisRun) {
    savePersonalGhost({
      seed,
      score: state.score,
      wave: state.wave,
      durationMs: Math.max(0, Math.floor(state.runTimeMs)),
      poseSamples: state.ghostPoseSamples.slice(),
      lastSavedAt: 0,  // overwritten by savePersonalGhost
    });
  }
  // Mark today's daily run as completed for the streak counter. Cheated
  // runs don't count — streak should reflect honest play. Free-mode
  // runs (no seed) don't count either; only daily seeds drive the
  // streak. After the mark, check streak milestones and fire badges.
  if (seed && !state.cheatedThisRun) {
    markDailyCompleted(seed);
    const s = getStreak();
    if (s >= 30) markAchievement(state, 'streak-30');
    if (s >= 5)  markAchievement(state, 'streak-5');
  }
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
    // Full-world replay (kind 30764) — built from the buffered kind
    // 22769 frames we shipped at 3 Hz during the run. Cheated runs and
    // sub-2-frame runs are skipped (publishReplay validates internally).
    // Decoupled from the score claim — sign-capable sessions leave a
    // replay even when they don't claim, same policy as the ghost.
    if (!state.cheatedThisRun) {
      const replayFrames = getReplayBuffer();
      if (replayFrames.length >= 2) {
        void publishReplay({
          session: state.session,
          finalScore: state.score,
          finalWave: state.wave,
          durationMs: Math.max(0, Math.floor(state.runTimeMs)),
          frames: replayFrames,
        });
      }
    }
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
      // SHARE CLIP — re-trigger the death replay AND record the canvas
      // for the same window via MediaRecorder, then hand the resulting
      // file to the system share sheet. Only shown when the recording
      // path is supported (MediaRecorder + canvas.captureStream).
      if (canCaptureClip()) {
        const clip = el('button', { className: 'menu-btn secondary', parent: row, text: 'SHARE CLIP' }) as HTMLButtonElement;
        onTap(clip, () => {
          clip.disabled = true;
          clip.textContent = 'CAPTURING…';
          clip.style.opacity = '0.6';
          const canvas = document.getElementById('game') as HTMLCanvasElement | null;
          if (!canvas) {
            clip.disabled = false;
            clip.textContent = 'SHARE CLIP';
            clip.style.opacity = '1';
            return;
          }
          // Trigger replay first so frames flow, then capture for the
          // full replay window plus a small tail so the explosion lands.
          startDeathReplay(state, 'gameover');
          const captureMs = REPLAY_TOTAL_WALL_MS + REPLAY_EXPLOSION_WALL_MS + 200;
          void captureClip(canvas, captureMs).then(async (captured) => {
            if (!captured) {
              clip.disabled = false;
              clip.textContent = 'SHARE CLIP';
              clip.style.opacity = '1';
              return;
            }
            const result = await shareClip(captured, {
              filenameStem: `pallasite-w${state.wave}-s${state.score}`,
              title: 'Pallasite',
              text: `W${state.wave} · ${state.score} score · pallasite.app`,
            });
            clip.disabled = false;
            clip.textContent = result === 'shared' ? 'SHARED ✓' : result === 'downloaded' ? 'DOWNLOADED ✓' : 'CLIP FAILED';
            clip.style.opacity = '1';
          });
        });
      }
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
  // SHARE STATS — Wordle-style one-liner. Daily-mode only (the format
  // depends on the daily ordinal); free runs would just be "Pallasite ·
  // W12 · 8.4k" with no comparison hook so we hide the button there.
  const dailySeed = getActiveSeed();
  if (dailySeed) {
    const statsBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SHARE STATS' }) as HTMLButtonElement;
    onTap(statsBtn, () => {
      const text = buildDailyShareText({
        seed: dailySeed,
        score: state.score,
        wave: state.wave,
        bossDefeated: state.bossDefeated,
        largestCombo: state.runStats.largestCombo,
        veinsBroken: state.runStats.veinsBroken,
        cleared: opts.isCompletion === true,
      });
      statsBtn.disabled = true;
      statsBtn.style.opacity = '0.6';
      void shareDailyStats(text).then((result) => {
        statsBtn.disabled = false;
        statsBtn.style.opacity = '1';
        statsBtn.textContent = result === 'shared' ? 'SHARED ✓' : result === 'copied' ? 'COPIED ✓' : 'SHARE FAILED';
      });
    });
  }
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
