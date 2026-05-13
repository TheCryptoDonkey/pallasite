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
import { submitClaim, submitWithdraw, submitCheckin, fetchPool, fetchPlayer, fetchFlagged, requestDeleteFlag, requestLnurlWithdraw, pollLnurlWithdrawStatus, fetchAdminState, setAdminCaps, setAdminPause, applyAdminPreset, saveAdminSettings, fetchAdminPlayer, setAdminPlayerFlag, adjustAdminPlayerBalance, setAdminPlayerTier, isAdminSession, type PlayerTier, type FlaggedEntry, type AdminStateResult, type AdminPlayer } from './faucet.js';
import {
  fetchReviewCases,
  generateJuryIdentity,
  getStoredJuryIdentity,
  setStoredJuryIdentity,
  clearStoredJuryIdentity,
  publishDelegation,
  submitVote,
  hasVotedOnCase,
  type ReviewCase,
  type StoredJuryIdentity,
  type VoteSubmitResult,
} from './jury.js';
import { renderLegalFooter, openTermsModal } from './legal.js';
import { startGame, startDeathReplay, clearEntitiesForTitle, toastNow } from './game.js';
import * as audio from './audio.js';
import { listTracks, currentTrackId, musicPreviewPlay, musicForceRefresh, musicStop, musicNotifyClaimSuccess, musicWarmUpAll } from './music.js';
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
import { decodeNpub, encodeNpub, encodeNsec } from './bech32.js';
import { subscribeZapTotals, type ZapTotalsByPubkey } from './zaps.js';
import { isGuestSession, setGuestName, clearGuestIdentity, getGuestPrivkeyHex, getGuestRecord } from './guest.js';
import { getReplayBuffer, type ReplayFrameRaw } from './stream-session.js';
import { publishGhost, prefetchTopGhost, getCachedGhost, fetchGhostByScoreEventId, findScoreIdForLatestGhost, ghostPoseAt, ghostScoreAt, publishReplay, gzipReplayFrames, findReplayByAuthor, fetchReplayByScoreEventId, fetchReplayByEventId, type GhostRun } from './ghost.js';
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
 *
 * Geometric, not DOM-order: ↑ / ↓ moves between visual rows (different
 * top coordinates), ← / → moves between buttons on the SAME row
 * (close top, different left). The mode picker / difficulty picker /
 * daily toggle on the mission-select screen each live on their own
 * row, so ↑ ↓ skips between those rows cleanly and ← → cycles values
 * within whichever row is focused. Buttons that are alone on a row
 * (IGNITE, HOW TO PLAY, SETTINGS) get visited by ↑ ↓ too.
 *
 * Falls back to a linear FIFO cycle if no geometric neighbour exists
 * in the requested direction — keeps simple two-button dialogs
 * (BACK / CONFIRM) navigable without needing explicit row grouping.
 *
 * Also explicitly fires .click() on the focused button for Enter /
 * Space. The browser is supposed to synthesise this from a focused
 * button's default action, but the synthesis varies across mobile
 * browsers and the controller-PWA-over-WS keyboard-event path —
 * being explicit means SELECT (A → Enter) ALWAYS activates the
 * focused button, regardless of browser quirks.
 *
 * Focus is applied with {focusVisible: true} where supported, so the
 * loud :focus-visible CSS treatment kicks in even though the focus
 * arrived programmatically rather than via Tab.
 */
function setupOverlayArrowNav(overlay: HTMLElement): void {
  const handler = (e: KeyboardEvent): void => {
    if (!document.body.contains(overlay)) {
      window.removeEventListener('keydown', handler);
      return;
    }
    // Skip when an input/textarea is focused — the form field owns
    // its own keys (typing names, code entry).
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;

    const isArrow = e.code === 'ArrowUp' || e.code === 'ArrowDown'
                 || e.code === 'ArrowLeft' || e.code === 'ArrowRight';
    const isActivate = e.code === 'Enter' || e.code === 'Space';
    if (!isArrow && !isActivate) return;

    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button:not([disabled])'))
      .filter((b) => b.offsetParent !== null);
    if (buttons.length === 0) return;

    if (isActivate) {
      // Defensive activation. Browsers normally synthesise click()
      // when Enter / Space is pressed on a focused button, but the
      // synthesis is unreliable across the controller-PWA-WS path on
      // some Android Chromium builds. Explicit click here means
      // SELECT always works on the focused button.
      const focused = active instanceof HTMLButtonElement && buttons.includes(active) ? active : null;
      if (focused) {
        e.preventDefault();
        focused.click();
      }
      return;
    }

    if (!active || !(active instanceof HTMLButtonElement) || !buttons.includes(active)) {
      // No button focused yet — first arrow keypress focuses the
      // first visible button. Pass focusVisible:true so the loud
      // :focus-visible CSS treatment shows immediately.
      tryFocusVisible(buttons[0]);
      e.preventDefault();
      return;
    }

    // Geometric neighbour search. Match "same row" by close top
    // coordinate (within half the button height — generous for
    // wrap-flex layouts where row-mates can be staggered a couple
    // pixels). Pick the nearest centre-aligned neighbour in the
    // requested direction.
    const cur = active.getBoundingClientRect();
    const curCx = cur.left + cur.width / 2;
    const curCy = cur.top + cur.height / 2;
    const SAME_ROW = Math.max(cur.height / 2, 8);

    interface Cand { btn: HTMLButtonElement; dx: number; dy: number; absDx: number; absDy: number; }
    const cands: Cand[] = [];
    for (const btn of buttons) {
      if (btn === active) continue;
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      cands.push({ btn, dx: cx - curCx, dy: cy - curCy, absDx: Math.abs(cx - curCx), absDy: Math.abs(cy - curCy) });
    }

    const horizontal = e.code === 'ArrowLeft' || e.code === 'ArrowRight';
    const positive = e.code === 'ArrowDown' || e.code === 'ArrowRight';

    let pick: Cand | null = null;
    if (horizontal) {
      // Prefer same-row neighbours in the requested left/right
      // direction. Pick the one with smallest horizontal distance.
      const sameRow = cands.filter((c) => c.absDy <= SAME_ROW && (positive ? c.dx > 0 : c.dx < 0));
      sameRow.sort((a, b) => a.absDx - b.absDx);
      pick = sameRow[0] ?? null;
    } else {
      // Vertical: pick a different-row neighbour in the requested
      // up/down direction. Weight horizontal distance into the
      // sort so the visually-nearest column wins ties.
      const otherRow = cands.filter((c) => positive ? c.dy > SAME_ROW : c.dy < -SAME_ROW);
      otherRow.sort((a, b) => (a.absDy + a.absDx * 0.25) - (b.absDy + b.absDx * 0.25));
      pick = otherRow[0] ?? null;
    }

    // Fallback: no geometric neighbour exists in that direction.
    // Wrap to the opposite end so a small dialog with two buttons in
    // a row still cycles cleanly when the user presses ← past the
    // first button. This also covers single-column overlays where
    // ↑ at the top wraps to the bottom.
    if (!pick) {
      const all = cands.slice();
      if (horizontal) {
        all.sort((a, b) => a.dx - b.dx);
        pick = positive ? all[0] : all[all.length - 1];
      } else {
        all.sort((a, b) => a.dy - b.dy);
        pick = positive ? all[0] : all[all.length - 1];
      }
    }

    if (pick) {
      tryFocusVisible(pick.btn);
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', handler);
}

/** Programmatically focus a button so the :focus-visible CSS treatment
 *  fires. Chrome/Edge support {focusVisible: true}; Safari/Firefox fall
 *  through to plain .focus() and the heuristic decides — usually they
 *  treat programmatic focus during a keydown handler as "keyboard-
 *  caused" and apply :focus-visible anyway. */
function tryFocusVisible(btn: HTMLButtonElement): void {
  try {
    (btn as HTMLButtonElement & { focus(opts?: { focusVisible?: boolean }): void }).focus({ focusVisible: true });
  } catch {
    btn.focus();
  }
}


/**
 * Variable-length name picker. Same arcade ▲▼ + ←→ + BKSP grammar as
 * renderArcadeInitials but designed for up to 25 characters by showing
 * a single big editor slot for the currently-active position above a
 * preview line of the full name. The fixed-slot picker was right for
 * 4-char high-score initials; this surface is right for guest-mode
 * display names where players want their handle ("MORG OF ALDEBARAN")
 * rather than initials.
 *
 * The controls are *all* native <button> elements so the controller
 * PWA in d-pad mode (which emits ArrowUp/Down/Left/Right via the
 * gamepad bridge) can navigate through them via setupOverlayArrowNav,
 * land on ▲ / ▼ / ◀ / ▶ / BKSP / DONE, and activate with Enter
 * (the PWA's A button). Keyboard users get the same buttons via Tab,
 * plus typing a letter / digit directly types into the active slot
 * and auto-advances the cursor.
 *
 * Returns a `getCurrentName()` accessor so callers (the IGNITE
 * fallback path) can read the in-progress value without waiting for
 * onSubmit.
 */
function renderArcadeName(
  parent: HTMLElement,
  opts: {
    onSubmit?: (name: string) => void;
    initialValue?: string;
    maxLen?: number;
  },
): { getCurrentName: () => string } {
  const MAX_LEN = opts.maxLen ?? 25;
  // A-Z + 0-9 + space — the classic arcade charset the user picked.
  // Order: A first so a freshly empty slot starts at A on first ▲.
  // Space last so a cursor that "overflowed" reads as blank.
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
  const SPACE_IDX = CHARS.length - 1;

  // Initial value: pad to MAX_LEN with spaces. Cursor lands on the
  // first space so typing a fresh name doesn't require manual cursor
  // navigation. If a returning guest is renaming, cursor lands at
  // end-of-name + 1 (or last slot if full).
  const initial = (opts.initialValue ?? '').toUpperCase().slice(0, MAX_LEN);
  const slots: number[] = [];
  for (let i = 0; i < MAX_LEN; i++) {
    const ch = i < initial.length ? initial[i] : ' ';
    const idx = CHARS.indexOf(ch);
    slots.push(idx === -1 ? SPACE_IDX : idx);
  }
  let cursor = Math.min(initial.length, MAX_LEN - 1);
  let submitted = false;

  const wrap = el('div', { parent });
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin:4px 0;width:100%;';
  // Same opt-out marker the global Enter-restarts-game handler in
  // main.ts already checks for — keeps Enter from re-triggering the
  // game while the player is mid-name.
  wrap.dataset.arcadeInitials = 'open';

  // Preview line — the whole 25-char name with the cursor position
  // visually highlighted as an underline. Reads at a glance ("you've
  // typed MORG, cursor is on slot 5") without needing to look at the
  // big editor below.
  const preview = el('div', { parent: wrap });
  preview.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:2px;font-family:monospace;font-size:1rem;letter-spacing:0.04em;padding:6px 8px;background:rgba(2,5,13,0.4);border:1px solid rgba(140,255,180,0.2);border-radius:4px;min-height:1.6em;max-width:480px;width:100%;';
  const previewChars: HTMLSpanElement[] = [];
  for (let i = 0; i < MAX_LEN; i++) {
    const span = el('span', { parent: preview, text: '_' });
    span.style.cssText = 'display:inline-block;min-width:0.65em;text-align:center;color:rgba(220,210,255,0.55);border-bottom:1px solid transparent;transition:color 80ms, border-color 80ms;';
    previewChars.push(span);
  }

  // Big editor — current character, ▲ above, ▼ below, ◀ ▶ left/right.
  // Sized so it's tap-friendly on mobile and reads at TV-distance for
  // controller PWA users.
  const editor = el('div', { parent: wrap });
  editor.style.cssText = 'display:grid;grid-template-columns:auto auto auto;grid-template-rows:auto auto auto;gap:6px;align-items:center;justify-items:center;margin:4px 0;';
  // Row 1: empty, ▲, empty
  const upBtn = el('button', { parent: editor, text: '▲' }) as HTMLButtonElement;
  upBtn.type = 'button';
  upBtn.style.cssText = 'grid-column:2;grid-row:1;width:56px;height:40px;background:rgba(88,255,88,0.12);border:2px solid rgba(88,255,88,0.4);color:#58ff58;font-size:1.1rem;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;';
  // Row 2: ◀, big slot, ▶
  const leftBtn = el('button', { parent: editor, text: '◀' }) as HTMLButtonElement;
  leftBtn.type = 'button';
  leftBtn.style.cssText = 'grid-column:1;grid-row:2;width:48px;height:54px;background:rgba(140,140,255,0.10);border:2px solid rgba(140,140,255,0.35);color:#9b9bff;font-size:1.1rem;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;';
  const slotBox = el('div', { parent: editor }) as HTMLDivElement;
  slotBox.style.cssText = 'grid-column:2;grid-row:2;width:64px;height:64px;display:flex;align-items:center;justify-content:center;background:rgba(2,5,13,0.6);border:2px solid #ffd84a;color:#ffd84a;font-family:inherit;font-size:2rem;font-weight:bold;letter-spacing:0;text-shadow:0 0 10px rgba(255,216,74,0.5);';
  const rightBtn = el('button', { parent: editor, text: '▶' }) as HTMLButtonElement;
  rightBtn.type = 'button';
  rightBtn.style.cssText = 'grid-column:3;grid-row:2;width:48px;height:54px;background:rgba(140,140,255,0.10);border:2px solid rgba(140,140,255,0.35);color:#9b9bff;font-size:1.1rem;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;';
  // Row 3: empty, ▼, empty
  const downBtn = el('button', { parent: editor, text: '▼' }) as HTMLButtonElement;
  downBtn.type = 'button';
  downBtn.style.cssText = 'grid-column:2;grid-row:3;width:56px;height:40px;background:rgba(88,255,88,0.12);border:2px solid rgba(88,255,88,0.4);color:#58ff58;font-size:1.1rem;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;';

  // Actions row — backspace + done
  const actions = el('div', { parent: wrap });
  actions.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const bkspBtn = el('button', { parent: actions, text: 'BKSP' }) as HTMLButtonElement;
  bkspBtn.type = 'button';
  bkspBtn.style.cssText = 'padding:8px 16px;background:rgba(255,120,120,0.12);border:2px solid rgba(255,120,120,0.4);color:#ff8a8a;font-family:inherit;letter-spacing:0.16em;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;';
  const doneBtn = el('button', { parent: actions, text: 'DONE' }) as HTMLButtonElement;
  doneBtn.type = 'button';
  doneBtn.style.cssText = 'padding:8px 24px;background:rgba(255,216,74,0.18);border:2px solid #ffd84a;color:#ffd84a;font-family:inherit;letter-spacing:0.16em;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;';

  const hint = el('p', { parent: wrap, text: '▲▼ CYCLE · ◀▶ CURSOR · BKSP · DONE' });
  hint.style.cssText = 'font-size:0.65rem;color:rgba(180,140,255,0.55);letter-spacing:0.16em;margin:0;';

  const getCurrentName = (): string => {
    let out = '';
    for (let i = 0; i < MAX_LEN; i++) out += CHARS[slots[i]];
    return out.trimEnd();
  };

  const render = (): void => {
    for (let i = 0; i < MAX_LEN; i++) {
      const ch = CHARS[slots[i]];
      previewChars[i].textContent = ch === ' ' ? '_' : ch;
      const isActive = i === cursor;
      previewChars[i].style.color = isActive ? '#ffd84a' : (ch === ' ' ? 'rgba(220,210,255,0.35)' : '#fff5d8');
      previewChars[i].style.borderBottomColor = isActive ? '#ffd84a' : 'transparent';
    }
    const ch = CHARS[slots[cursor]];
    slotBox.textContent = ch === ' ' ? '_' : ch;
  };
  render();

  const cycle = (dir: 1 | -1): void => {
    slots[cursor] = (slots[cursor] + dir + CHARS.length) % CHARS.length;
    render();
    try { audio.initialCycle(); } catch { /* ignore */ }
  };
  const move = (dir: 1 | -1): void => {
    const next = cursor + dir;
    if (next < 0 || next >= MAX_LEN) return;
    cursor = next;
    render();
    try { audio.initialMove(); } catch { /* ignore */ }
  };
  const bksp = (): void => {
    if (slots[cursor] !== SPACE_IDX) {
      slots[cursor] = SPACE_IDX;
    } else if (cursor > 0) {
      cursor -= 1;
      slots[cursor] = SPACE_IDX;
    }
    render();
    try { audio.initialBackspace(); } catch { /* ignore */ }
  };
  const commit = (): void => {
    if (submitted) return;
    submitted = true;
    window.removeEventListener('keydown', keyHandler, true);
    const name = getCurrentName();
    opts.onSubmit?.(name);
  };

  // Bind buttons (pointerdown + click + Enter on focused button).
  // pointerdown is touch-friendly (avoids the iOS 300ms delay), click
  // covers mouse + keyboard activation (Enter / Space on focused
  // button fires synthetic click).
  const bindTap = (btn: HTMLElement, fn: () => void): void => {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
    btn.addEventListener('click', (e) => { e.preventDefault(); });
  };
  bindTap(upBtn,    () => cycle(1));
  bindTap(downBtn,  () => cycle(-1));
  bindTap(leftBtn,  () => move(-1));
  bindTap(rightBtn, () => move(1));
  bindTap(bkspBtn,  () => bksp());
  bindTap(doneBtn,  () => commit());

  // Keyboard fast path — typing a letter / digit replaces the active
  // slot and advances the cursor. Avoids forcing kb users through the
  // arcade ▲▼ dance when they can just type.
  //
  // Capture phase + stopImmediatePropagation on consumed keys so the
  // global IGNITE-on-Enter handler in main.ts doesn't fire mid-edit,
  // and the overlay arrow-key button-cycle handler doesn't fight us
  // for ↑↓←→ when focus is inside this widget.
  const keyHandler = (e: KeyboardEvent): void => {
    if (submitted) return;
    if (!document.body.contains(wrap)) {
      window.removeEventListener('keydown', keyHandler, true);
      return;
    }
    // Only intercept arrow keys when focus is on one of OUR buttons
    // or the wrap itself — otherwise the user is trying to navigate
    // the surrounding overlay and we shouldn't steal arrows.
    const active = document.activeElement as Element | null;
    const focusInside = active === wrap || wrap.contains(active);
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (!focusInside) return;
    }
    let consumed = true;
    switch (e.code) {
      case 'ArrowUp': cycle(1); break;
      case 'ArrowDown': cycle(-1); break;
      case 'ArrowRight': move(1); break;
      case 'ArrowLeft': move(-1); break;
      case 'Backspace': bksp(); break;
      case 'Enter':
        // Enter on DONE submits; Enter elsewhere advances cursor and,
        // if at end, commits. Lets a kb user "type then press Enter"
        // without hunting for the DONE button.
        if (document.activeElement === doneBtn) { commit(); }
        else if (cursor < MAX_LEN - 1) { move(1); }
        else { commit(); }
        break;
      default: {
        // Letter / digit / space — type into the current slot. Match
        // is case-insensitive (we normalise to upper for CHARS).
        const ch = e.key.toUpperCase();
        if (ch.length === 1 && CHARS.indexOf(ch) !== -1) {
          slots[cursor] = CHARS.indexOf(ch);
          render();
          if (cursor < MAX_LEN - 1) cursor += 1;
          render();
        } else {
          consumed = false;
        }
        break;
      }
    }
    if (consumed) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener('keydown', keyHandler, true);

  return { getCurrentName };
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
    void (async () => {
      void audio.unlockAudio();
      // Fallback path for IGNITE without first typing a name: rather
      // than starting a session-less run that can't publish scores or
      // earn anything, provision an Anonymous guest identity inline.
      // The user can rename later from the title session panel.
      if (!state.session) {
        try {
          // Read whatever the title-screen arcade name picker has
          // currently typed. Falls back to 'Anonymous' for a freshly-
          // mounted picker the user hasn't touched.
          const typed = titleNamePickerGetName?.().trim() ?? '';
          state.session = await auth.createGuestSession(typed || 'Anonymous');
        } catch (err) {
          console.warn('[guest] inline create on IGNITE failed:', err);
        }
      }
      lockInDifficulty(getStoredDifficulty());
      gateBehindOnboarding(() => onStartCb?.());
    })();
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

// ── Three-screen flow: attract → auth → mission select ──────────────────────
//
// Classic arcade structure. The title used to be a "settings dashboard"
// (logo + tagline + session panel + modes + difficulty + daily + streak +
// balance + pending claim + buttons + leaderboards all on one screen),
// which served the dev fine but read busy for new players. The new flow:
//
//   ATTRACT    Just logo + tagline + rotating panel + huge PLAY + footer.
//              Insert-coin energy — nothing to configure, nothing to learn,
//              one obvious thing to tap. Returning users skip auth and go
//              straight to mission select.
//
//   AUTH       Two-button chooser: SIGN IN WITH NOSTR (existing Signet flow)
//              or PLAY AS GUEST (arcade name picker → local keypair + kind 0
//              metadata + opt-out kind 3 follow of the Pallasite npub).
//
//   MISSION    renderTitle as it stands today — modes, difficulty, daily
//   SELECT     toggle, balance, pending claim, IGNITE, phone pairing,
//              leaderboards. Reached from attract via PLAY (after auth if
//              needed), or directly from game-over via "PLAY AGAIN".
//
// Rotation panels, kind 0 + kind 3 publish, game-over initials drop, and
// the universal claim destination flow are layered on top in follow-up
// commits. This commit is scaffolding only — visual redesign comes later.

export function renderAttract(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  // Logo — same wordmark as the previous title.
  const titleLogo = el('img', { parent: overlay });
  titleLogo.className = 'title-logo';
  (titleLogo as HTMLImageElement).src = '/logo.webp';
  (titleLogo as HTMLImageElement).alt = 'PALLASITE';
  (titleLogo as HTMLImageElement).decoding = 'async';
  bindLogoLongPress(titleLogo, () => renderMusicPlayer(state, () => renderAttract(state)));

  const tagline = el('p', { parent: overlay, text: 'SHOOT ROCKS · STACK SATS' });
  tagline.style.cssText = 'font-size:1.2rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-12px;';
  el('p', { parent: overlay, text: 'Cosmic arcade · Lightning sats · Nostr leaderboards' });

  // Rotating attract panel — three contents cycle every few seconds:
  //   GLOBAL HIGH SCORES TOP 5   (8s)  — live-updating leaderboard
  //   TOP RUN HIGHLIGHT           (8s) — placeholder for replay
  //                                      autoplay; full live render is
  //                                      a follow-up. Static "top run"
  //                                      stat panel for now.
  //   CREDITS                     (5s) — handcrafted by + zaps tip
  // 300ms crossfade between panels via opacity transition.
  //
  // Each render is fire-and-forget: it mounts a subtree into the panel
  // and tears down on next rotation tick (innerHTML='' is enough since
  // none of the panels open network sockets except the high-scores
  // panel, which checks container.isConnected for self-teardown).
  const attractPanel = el('div', { parent: overlay });
  attractPanel.style.cssText = 'min-height:240px;margin:24px auto;max-width:760px;width:100%;display:flex;align-items:center;justify-content:center;transition:opacity 300ms ease;';
  attractPanel.dataset.attractPanel = '1';

  type AttractPhase = 'scores' | 'replay' | 'credits';
  const PHASE_DURATIONS: Record<AttractPhase, number> = {
    scores: 8000,
    replay: 8000,
    credits: 5000,
  };
  const PHASE_ORDER: readonly AttractPhase[] = ['scores', 'replay', 'credits'];
  let phaseIdx = 0;
  let phaseTimer: number | null = null;

  const mountPhase = (phase: AttractPhase): void => {
    attractPanel.innerHTML = '';
    if (phase === 'scores') {
      // Wrap renderGlobalLeaderboard so we can scope the title to a
      // shorter ATTRACT-style label rather than the full "GLOBAL HIGH
      // SCORES" the mission-select uses.
      const wrap = el('div', { parent: attractPanel });
      wrap.style.cssText = 'width:100%;max-width:560px;text-align:center;';
      renderGlobalLeaderboard(wrap, state);
    } else if (phase === 'replay') {
      // v1 placeholder — full live-frame autoplay of a top-zapped run
      // is the next commit. For now show a tasteful "highlight reel
      // loading" stand-in that doesn't promise more than we deliver.
      const wrap = el('div', { parent: attractPanel });
      wrap.style.cssText = 'width:100%;max-width:560px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center;';
      const head = el('p', { parent: wrap, text: '⚡ TOP RUN HIGHLIGHTS' });
      head.style.cssText = 'font-size:0.95rem;color:#ffd84a;letter-spacing:0.18em;margin:0;';
      const body = el('p', { parent: wrap, text: 'Autoplay coming soon — open the WATCH page to see live runs and replay-worthy clips from across the relay set.' });
      body.style.cssText = 'font-size:0.82rem;color:rgba(220,210,255,0.65);max-width:480px;line-height:1.5;margin:0;';
      const watchBtn = el('a', { parent: wrap, text: 'OPEN WATCH PAGE ▶' }) as HTMLAnchorElement;
      watchBtn.href = 'https://watch.pallasite.app/';
      watchBtn.target = '_blank';
      watchBtn.rel = 'noopener';
      watchBtn.style.cssText = 'font-size:0.78rem;letter-spacing:0.16em;color:#8cffb4;text-decoration:none;border:1px solid rgba(140,255,180,0.55);padding:4px 14px;border-radius:3px;background:rgba(140,255,180,0.06);margin-top:4px;';
    } else {
      // Credits — minimal. Names + zap pointer; sources from
      // existing credits.ts module if there's more later, but for
      // attract a tight three-line block reads better.
      const wrap = el('div', { parent: attractPanel });
      wrap.style.cssText = 'width:100%;max-width:560px;text-align:center;display:flex;flex-direction:column;gap:6px;';
      el('p', { parent: wrap, text: '— CREDITS —' }).style.cssText = 'font-size:0.85rem;color:#ffd84a;letter-spacing:0.22em;margin:0 0 6px;';
      const line = el('p', { parent: wrap, text: 'Handcrafted by The Crypto Donkey' });
      line.style.cssText = 'font-size:0.92rem;color:#fff5d8;letter-spacing:0.06em;margin:0;';
      const tip = el('p', { parent: wrap, text: 'Built on Nostr · Lightning · open relays' });
      tip.style.cssText = 'font-size:0.74rem;color:rgba(220,210,255,0.6);letter-spacing:0.06em;margin:0;';
      const npub = el('p', { parent: wrap, text: 'npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2' });
      npub.style.cssText = 'font-size:0.66rem;color:rgba(180,140,255,0.55);font-family:monospace;letter-spacing:0.04em;margin:4px 0 0;word-break:break-all;';
    }
  };

  const rotate = (): void => {
    if (!attractPanel.isConnected) {
      if (phaseTimer !== null) { window.clearTimeout(phaseTimer); phaseTimer = null; }
      return;
    }
    // Fade out, swap, fade in. setTimeout chain keeps the crossfade
    // visible without needing CSS @keyframes.
    attractPanel.style.opacity = '0';
    window.setTimeout(() => {
      if (!attractPanel.isConnected) return;
      phaseIdx = (phaseIdx + 1) % PHASE_ORDER.length;
      const next = PHASE_ORDER[phaseIdx];
      mountPhase(next);
      attractPanel.style.opacity = '1';
      phaseTimer = window.setTimeout(rotate, PHASE_DURATIONS[next]);
    }, 300);
  };
  // First panel — render immediately, no fade-in.
  mountPhase(PHASE_ORDER[0]);
  attractPanel.style.opacity = '1';
  phaseTimer = window.setTimeout(rotate, PHASE_DURATIONS[PHASE_ORDER[0]]);

  // The ONE thing on this screen — big PLAY button.
  const playRow = el('div', { className: 'menu-row', parent: overlay });
  const playBtn = el('button', { className: 'menu-btn', parent: playRow, text: 'PLAY ▶' }) as HTMLButtonElement;
  playBtn.style.cssText += 'font-size:1.4rem;padding:14px 48px;letter-spacing:0.28em;background:rgba(255,216,74,0.18);border-color:#ffd84a;color:#ffd84a;text-shadow:0 0 12px rgba(255,216,74,0.6);';
  playBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    if (state.session) {
      // Returning visitor with an identity — go straight to mission
      // select. The auth step is only for first-time visitors.
      renderTitle(state);
    } else {
      renderAuth(state, () => renderTitle(state));
    }
  });

  // Footer — terms, privacy, version. Always visible on attract so the
  // legal surface is one tap away without cluttering the auth or
  // mission screens.
  renderLegalFooter(overlay);
}

export function renderAuth(state: GameState, onDone: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'WHO ARE YOU?' });

  const sub = el('p', { parent: overlay, text: 'Sign in with Nostr to take your name, your zaps, and your replays everywhere — or play as a guest and we\'ll create a local identity for you.' });
  sub.style.cssText = 'font-size:0.85rem;color:rgba(220,210,255,0.7);margin:6px auto 18px;max-width:560px;text-align:center;line-height:1.5;';

  // Option 1 — sign in with Nostr (existing Signet flow). The
  // SignInWithNostr button is the "advanced" path: NIP-07 extension,
  // NIP-46 bunker, or the SDK's QR-over-relay flow. We hand off to
  // auth.signIn() which manages the modal.
  const signInBtn = el('button', { className: 'menu-btn', parent: overlay, text: '⚡ SIGN IN WITH NOSTR' }) as HTMLButtonElement;
  signInBtn.style.cssText += 'font-size:1rem;padding:12px 32px;letter-spacing:0.18em;margin:6px auto;display:block;min-width:280px;';
  const signInStatus = el('p', { parent: overlay });
  signInStatus.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);min-height:1em;margin:0 0 12px;letter-spacing:0.04em;text-align:center;';
  let signing = false;
  signInBtn.addEventListener('click', () => {
    if (signing) return;
    signing = true;
    signInStatus.textContent = 'Connecting…';
    void (async () => {
      try {
        const session = await auth.signIn();
        if (session) {
          state.session = session;
          onDone();
          return;
        }
        signInStatus.textContent = 'No signer attached.';
        signInStatus.style.color = '#ff8a3a';
      } catch (err) {
        signInStatus.textContent = err instanceof auth.SignInTimeoutError
          ? `Timeout — ${err.message}`
          : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`;
        signInStatus.style.color = '#ff5050';
      } finally {
        signing = false;
      }
    })();
  });

  // Visual separator between the two paths.
  const sep = el('div', { parent: overlay, text: '— OR —' });
  sep.style.cssText = 'font-family:monospace;color:rgba(220,210,255,0.4);letter-spacing:0.3em;margin:14px 0;text-align:center;';

  // Option 2 — guest. Arcade name picker + opt-out follow checkbox.
  // The picker is the same renderArcadeName the title's session
  // panel uses, so d-pad / touch / kb parity is automatic.
  el('p', { parent: overlay, text: '🚀 PLAY AS GUEST' }).style.cssText = 'font-size:1rem;letter-spacing:0.18em;color:#8cffb4;margin:0 0 8px;text-align:center;';

  const guestStatus = el('p', { parent: overlay });
  guestStatus.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);min-height:1em;margin:0;letter-spacing:0.04em;text-align:center;';

  let creating = false;
  const submitGuest = (raw: string): void => {
    if (creating) return;
    creating = true;
    guestStatus.textContent = '';
    try { void audio.unlockAudio(); } catch { /* ignore */ }
    void (async () => {
      try {
        const name = raw.trim() || 'Anonymous';
        // Read the opt-out checkbox state at submit time. Defaults
        // to true (pre-checked) so a user who just types and submits
        // gets the auto-follow.
        const followCheckEl = overlay.querySelector<HTMLInputElement>('input[data-follow-pallasite]');
        const followPallasite = followCheckEl?.checked ?? true;
        state.session = await auth.createGuestSession(name, { followPallasite });
        onDone();
      } catch (err) {
        guestStatus.textContent = `Couldn't create local identity: ${err instanceof Error ? err.message : String(err)}`;
        guestStatus.style.color = '#ff8a3a';
        creating = false;
      }
    })();
  };

  const picker = renderArcadeName(overlay, {
    maxLen: 25,
    onSubmit: (name) => submitGuest(name),
  });
  // Expose the in-progress name accessor in case a future PLAY-anywhere
  // shortcut on this screen wants to read it (matches the title-screen
  // pattern).
  titleNamePickerGetName = picker.getCurrentName;

  // Opt-out follow checkbox. Pre-checked so the default path publishes
  // a kind 3 contact list following the Pallasite game npub when the
  // guest identity is first created — disclosure is the point.
  // The actual publish happens in the kind-0 / kind-3 wiring (task #123);
  // this UI element reads its state at submit time.
  const followRow = el('label', { parent: overlay });
  followRow.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;font-size:0.78rem;color:rgba(220,210,255,0.7);margin:6px auto 0;cursor:pointer;letter-spacing:0.04em;max-width:480px;';
  const followCheck = el('input', { parent: followRow }) as HTMLInputElement;
  followCheck.type = 'checkbox';
  followCheck.checked = true;
  followCheck.dataset.followPallasite = '1';
  followCheck.style.cssText = 'width:16px;height:16px;accent-color:#8cffb4;cursor:pointer;';
  el('span', { parent: followRow, text: 'Follow Pallasite on Nostr for daily seeds + run highlights' });

  // Back to attract.
  const backRow = el('div', { className: 'menu-row', parent: overlay });
  const backBtn = el('button', { className: 'menu-btn secondary', parent: backRow, text: '◀ BACK' }) as HTMLButtonElement;
  backBtn.style.cssText += 'font-size:0.78rem;padding:6px 18px;letter-spacing:0.16em;';
  backBtn.addEventListener('click', () => renderAttract(state));
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

  // Same picker pattern as the game-over destination chooser — keeps
  // the title and recap consistent so a returning player who saved up
  // gets the same options as a one-and-done venue guest. Three paths:
  //   ⚡ Send to lud16 (pre-fill from profile / stored, hidden if
  //      no pre-fill AND no kb available)
  //   📱 Scan with wallet (LNURL-w QR — the d-pad-native option)
  //   ✕ Cancel
  //
  // Amount = full balance by default. Kb users can override; d-pad
  // users get the full amount (no numeric input to fight).

  const preFilledLud16 = state.profile?.lud16 ?? getStoredLnAddress() ?? '';
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const controllerPaired = activeControllerHost?.paired === true;
  const kbAvailable = !coarsePointer && !controllerPaired;
  const offerAddress = preFilledLud16 !== '' || kbAvailable;

  const backdrop = el('div', { className: 'overlay' });
  backdrop.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.78)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'z-index:9000', 'padding:20px',
  ].join(';');
  document.body.appendChild(backdrop);
  // setupOverlayArrowNav scans for buttons under the overlay on every
  // keydown, so d-pad nav reaches the picker + sub-flow buttons even
  // though they're built lazily after a destination is picked.
  setupOverlayArrowNav(backdrop);

  const card = el('div', { parent: backdrop });
  card.style.cssText = [
    'background:#0a0a0a', 'border:1px solid #333', 'border-radius:10px',
    'padding:18px 22px', 'max-width:420px', 'width:100%',
    'display:flex', 'flex-direction:column', 'gap:10px',
    'max-height:90vh', 'overflow-y:auto',
  ].join(';');

  const head = el('h3', { parent: card, text: 'WITHDRAW SATS' });
  head.style.cssText = 'margin:0;font-size:1.1rem;color:#5b9dff;letter-spacing:0.12em';

  const balLine = el('p', { parent: card });
  balLine.style.cssText = 'margin:0;font-size:0.82rem;color:#cccccc';
  balLine.textContent = `Balance: ${balanceSats} sats`;

  const heading = el('p', { parent: card, text: 'WHERE TO SEND?' });
  heading.style.cssText = 'margin:6px 0 0;font-size:0.72rem;letter-spacing:0.18em;color:rgba(255,216,74,0.85)';

  const picker = el('div', { parent: card });
  picker.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const mkBtn = (label: string, sub: string, accent: string): HTMLButtonElement => {
    const btn = el('button', { className: 'menu-btn', parent: picker }) as HTMLButtonElement;
    btn.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 14px;border:1.5px solid ${accent};background:rgba(2,5,13,0.4);cursor:pointer;font-size:0.92rem;letter-spacing:0.1em;text-align:center`;
    const top = el('div', { parent: btn, text: label });
    top.style.cssText = 'font-weight:bold;';
    const subEl = el('div', { parent: btn, text: sub });
    subEl.style.cssText = 'font-size:0.68rem;color:rgba(220,210,255,0.65);font-weight:normal;letter-spacing:0.06em';
    return btn;
  };

  const addressBtn = offerAddress
    ? mkBtn(
        '⚡ SEND TO LIGHTNING ADDRESS',
        preFilledLud16
          ? `Pay ${preFilledLud16.slice(0, 32)}${preFilledLud16.length > 32 ? '…' : ''}`
          : 'Pay an address like donkey@strike.me',
        'rgba(140,255,180,0.55)',
      )
    : null;
  const qrBtn = mkBtn('📱 SCAN WITH WALLET', 'LNURL-w QR — your wallet pulls the sats', 'rgba(184,144,255,0.55)');

  const flowSlot = el('div', { parent: card });
  flowSlot.style.cssText = 'display:flex;flex-direction:column;gap:8px';

  const status = el('p', { parent: card });
  status.style.cssText = 'margin:4px 0 0;font-size:0.82rem;min-height:1.1em;color:#888';

  const closeRow = el('div', { parent: card });
  closeRow.style.cssText = 'display:flex;gap:8px;margin-top:6px';
  const cancelBtn = el('button', { className: 'menu-btn secondary', parent: closeRow, text: 'CANCEL' }) as HTMLButtonElement;
  cancelBtn.style.cssText = 'flex:1;padding:8px;font-size:0.85rem;cursor:pointer';

  const close = (): void => { try { backdrop.remove(); } catch { /* ignore */ } };
  onTap(cancelBtn, close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  const onKey = (e: KeyboardEvent): void => { if (e.code === 'Escape') close(); };
  window.addEventListener('keydown', onKey, { once: true });

  const allButtons: HTMLButtonElement[] = [];
  if (addressBtn) allButtons.push(addressBtn);
  allButtons.push(qrBtn);
  const setEnabled = (on: boolean): void => {
    for (const b of allButtons) {
      b.disabled = !on;
      b.style.opacity = on ? '1' : '0.55';
    }
  };
  const lockPicker = (chosen: HTMLButtonElement): void => {
    setEnabled(false);
    chosen.style.borderColor = '#ffd84a';
    chosen.style.background = 'rgba(255,216,74,0.10)';
  };
  const unlockPicker = (): void => {
    flowSlot.replaceChildren();
    setEnabled(true);
    for (const b of allButtons) {
      b.style.background = 'rgba(2,5,13,0.4)';
    }
    status.textContent = '';
  };

  // ── Lightning Address destination ─────────────────────────────────
  if (addressBtn) {
    onTap(addressBtn, () => {
      lockPicker(addressBtn);
      flowSlot.replaceChildren();
      const sub = el('div', { parent: flowSlot });
      sub.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid rgba(140,255,180,0.3);border-radius:8px;background:rgba(60,200,140,0.05)';
      const lblA = el('p', { parent: sub, text: 'LIGHTNING ADDRESS' });
      lblA.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(140,255,180,0.85);letter-spacing:0.14em';
      const addrInput = document.createElement('input');
      addrInput.type = 'text';
      addrInput.placeholder = 'alice@yourwallet.com';
      addrInput.spellcheck = false;
      addrInput.autocapitalize = 'off';
      addrInput.autocomplete = 'email';
      addrInput.style.cssText = 'padding:10px 12px;font-family:inherit;font-size:0.95rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
      addrInput.value = preFilledLud16;
      sub.appendChild(addrInput);

      // Amount: default = balance. Numeric input is only useful with a
      // keyboard, so hide it on coarse-pointer / paired-pad surfaces —
      // those players get the whole balance.
      let amount = balanceSats;
      if (kbAvailable) {
        const lblB = el('p', { parent: sub, text: 'AMOUNT (sats)' });
        lblB.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(140,255,180,0.85);letter-spacing:0.14em';
        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.min = String(10);
        amountInput.max = String(balanceSats);
        amountInput.value = String(balanceSats);
        amountInput.style.cssText = 'padding:10px 12px;font-family:inherit;font-size:0.95rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
        sub.appendChild(amountInput);
        amountInput.addEventListener('input', () => {
          const v = Math.floor(Number(amountInput.value));
          if (Number.isFinite(v)) amount = v;
        });
      }

      const sendBtn = el('button', { className: 'menu-btn', parent: sub }) as HTMLButtonElement;
      sendBtn.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:0.92rem';
      sendBtn.textContent = `SEND ${balanceSats} SATS →`;
      const backBtn = el('button', { className: 'menu-btn secondary', parent: sub, text: '← BACK' }) as HTMLButtonElement;
      backBtn.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:0.78rem;align-self:flex-start';
      onTap(backBtn, () => unlockPicker());

      window.setTimeout(() => {
        try {
          if (preFilledLud16) tryFocusVisible(sendBtn);
          else addrInput.focus();
        } catch { /* ignore */ }
      }, 50);

      onTap(sendBtn, () => {
        void (async () => {
          const addr = addrInput.value.trim();
          if (!LN_ADDRESS_RE.test(addr)) {
            status.textContent = 'Invalid lightning address.';
            status.style.color = '#ff5050';
            return;
          }
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
          sendBtn.disabled = true;
          backBtn.disabled = true;
          addrInput.disabled = true;
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
              cancelBtn.textContent = 'CLOSE';
            } else {
              status.textContent = withdrawErrorMessage(result.error, result.detail);
              status.style.color = '#ff8050';
              sendBtn.disabled = false;
              backBtn.disabled = false;
              addrInput.disabled = false;
            }
          } catch (err) {
            status.textContent = err instanceof Error ? err.message : 'Withdraw failed.';
            status.style.color = '#ff8050';
            sendBtn.disabled = false;
            backBtn.disabled = false;
            addrInput.disabled = false;
          }
        })();
      });
    });
  }

  // ── LNURL-w QR destination ────────────────────────────────────────
  onTap(qrBtn, () => {
    lockPicker(qrBtn);
    flowSlot.replaceChildren();
    const sub = el('div', { parent: flowSlot });
    sub.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid rgba(184,144,255,0.3);border-radius:8px;background:rgba(120,90,200,0.05);align-items:center';
    const title = el('p', { parent: sub, text: 'SCAN WITH YOUR WALLET' });
    title.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(184,144,255,0.9);letter-spacing:0.14em';
    const qrSlot = el('div', { parent: sub });
    qrSlot.style.cssText = 'width:240px;height:240px;background:#fff;border-radius:8px;padding:10px;box-shadow:0 0 20px rgba(184,144,255,0.25)';
    const note = el('p', { parent: sub });
    note.style.cssText = 'margin:0;font-size:0.74rem;color:rgba(220,210,255,0.7);text-align:center;line-height:1.45';
    note.textContent = 'Phoenix, Wallet of Satoshi, Mutiny, Zeus, Cash App — any wallet that supports LNURL withdraw.';
    let claimFired = false;
    const backBtn = el('button', { className: 'menu-btn secondary', parent: sub, text: '← BACK' }) as HTMLButtonElement;
    backBtn.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:0.78rem;align-self:flex-start';
    onTap(backBtn, () => {
      if (claimFired) return;
      unlockPicker();
    });

    void (async () => {
      status.textContent = `Minting QR for ${balanceSats} sats…`;
      status.style.color = '#5b9dff';
      claimFired = true;
      backBtn.disabled = true;
      backBtn.style.opacity = '0.4';
      try {
        const mint = await requestLnurlWithdraw(session, { amount_sats: balanceSats });
        if (!mint.ok) {
          status.textContent = `QR mint failed: ${mint.error}`;
          status.style.color = '#ff8050';
          return;
        }
        void renderQRInto(qrSlot, mint.lnurl);
        status.textContent = 'Waiting for your wallet to pull…';
        status.style.color = 'rgba(184,144,255,0.9)';

        let polling = true;
        const tick = async (): Promise<void> => {
          if (!polling) return;
          const s = await pollLnurlWithdrawStatus(mint.k1);
          if (!polling) return;
          if (s.ok) {
            if (s.status === 'paid' || s.consumed) {
              status.textContent = `✓ Paid ${balanceSats} sats — your wallet has them`;
              status.style.color = '#58ff58';
              cancelBtn.textContent = 'CLOSE';
              polling = false;
              return;
            }
            if (s.status === 'expired' || s.expires_at <= Date.now()) {
              status.textContent = 'QR expired — sats refunded to balance';
              status.style.color = '#ff8050';
              polling = false;
              return;
            }
          }
          window.setTimeout(() => void tick(), 2500);
        };
        void tick();
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Mint failed.';
        status.style.color = '#ff8050';
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
      if (/timeout|signer-timeout|queue-timeout/i.test(detail)) return 'Signer did not respond. Open your Nostr extension and unlock it.';
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
  /** Rich replay mode — when provided, skips the WS subscription, pre-
   *  seeds the frame buffer with these frames, and drives playback
   *  linearly through the whole timeline at 1x. Used by the kind 30764
   *  "WATCH FROM START" path so spectators see the full world (not just
   *  the pose-only kind 30763 ghost). */
  replaySource?: {
    frames: ReadonlyArray<ReplayFrameRaw>;
    durationMs: number;
    /** Header label shown above the canvas, e.g. "REPLAY · WATCHING". */
    headerLabel?: string;
    /** kind 30764 event id — used to build a `watch.pallasite.app/
     *  #replay=<id>` deep-link from the SHARE button. */
    eventId?: string;
  };
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
  /** Current HP. Drives tank's bottom HP dots and boss's segmented HP
   *  bar. Defaults to 1 for old clients that don't ship the field. */
  hp: number;
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
  /** Game phase — drives the watcher's incoming-wave banner during
   *  warp and similar overlays. Empty string for old wire payloads
   *  without the field. */
  phase: string;
  /** Wave the player is jumping to during 'warp' (0 when not warping). */
  nextWave: number;
  /** Ship skin code — drives the watcher ship palette. 'd' default,
   *  'i' ironclad orange, 'h' halo cyan. */
  skin: 'd' | 'i' | 'h';
  asteroids: LiveAsteroid[];
  ufos: LiveUfo[];
  mines: LiveMine[];
  bullets: LiveBullet[];
  coins: LiveCoin[];
  powerups: LivePowerup[];
  events: LiveSfxEvent[];
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
    const [id, x, y, type, hp] = item;
    if (typeof id !== 'number' || typeof x !== 'number' || typeof y !== 'number') continue;
    if (type !== 's' && type !== 'p' && type !== 't' && type !== 'e' && type !== 'c' && type !== 'b') continue;
    out.push({ id, x, y, type, hp: typeof hp === 'number' ? hp : 1 });
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

/** Convert a raw WS frame (the ReplayFrameRaw shape published by
 *  stream-session.ts → publishStreamFrameWs) into the parsed LiveFrame
 *  shape the renderer uses. The wire delivers the same world payload
 *  as kind 22769 used to — we just skip the Nostr envelope. */
function readWsFrame(obj: Record<string, unknown>): LiveFrame | null {
  const t = typeof obj.t === 'number' ? obj.t : null;
  const x = typeof obj.x === 'number' ? obj.x : null;
  const y = typeof obj.y === 'number' ? obj.y : null;
  const r = typeof obj.r === 'number' ? obj.r : null;
  if (t === null || x === null || y === null || r === null) return null;
  const world = (typeof obj.world === 'object' && obj.world) ? obj.world as Record<string, unknown> : {};
  return {
    capturedAt: t,
    receivedAt: performance.now(),
    x, y, r,
    score: typeof obj.score === 'number' ? obj.score : 0,
    wave: typeof obj.wave === 'number' ? obj.wave : 0,
    lives: typeof obj.lives === 'number' ? obj.lives : 0,
    sats: typeof obj.sats === 'number' ? obj.sats : 0,
    thrust: obj.thrust === true,
    alive: obj.alive !== false,
    shielded: obj.shielded === true,
    paused: obj.paused === true,
    phase: typeof world.ph === 'string' ? world.ph : '',
    nextWave: typeof world.nw === 'number' ? world.nw : 0,
    skin: (world.sk === 'i' || world.sk === 'h' ? world.sk : 'd') as 'd' | 'i' | 'h',
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

  // Opening the theatre counts as a user gesture (came from a click on
  // a watch-grid card or mini-tile), so we can safely unlock the audio
  // context here. Without this, a viewer who landed straight on the
  // watch page never hit the title-screen audio unlock and replay/live
  // SFX + music get silently dropped by the browser's autoplay policy.
  void audio.unlockAudio().catch(() => undefined);
  audio.resumePlayback();

  // Replay mode (kind 30764 full-world bundle) reuses this theatre but
  // skips the WS subscription, pre-seeds the frame buffer with the whole
  // run, and advances playbackT linearly across the whole timeline.
  const replayMode = !!input.replaySource;
  const headerLabel = input.replaySource?.headerLabel ?? (replayMode ? 'REPLAY · WATCHING' : 'LIVE · WATCHING');
  el('h2', { parent: overlay, text: headerLabel });

  const nameEl = el('p', { parent: overlay, text: input.displayName.toUpperCase() });
  nameEl.style.cssText = 'margin:6px 0 14px;font-size:1.2rem;letter-spacing:0.18em;color:#8cffb4;text-shadow:0 0 10px rgba(140,255,180,0.5);';
  // Profile-resolve the name asynchronously — the caller may have
  // passed in a shortPubkey fallback (e.g. when the theatre opens
  // before the watch card's own fetchProfile resolved). Replace with
  // the kind 0 display name once available so the header reads e.g.
  // 'THE CRYPTO DONKEY' instead of 'DA19F1CD…E5BD'.
  if (/^[0-9a-f]{64}$/i.test(input.masterPubkey)) {
    void (async () => {
      try {
        const profile = await fetchProfile(input.masterPubkey);
        const resolved = bestName(profile, input.masterPubkey);
        if (resolved && resolved !== input.masterPubkey) {
          nameEl.textContent = resolved.toUpperCase();
        }
      } catch { /* keep the shortPubkey fallback */ }
    })();
  }
  // The previous 'stat' line duplicated liveScore below — initialScore
  // was sticky from the entry's kind 30762 heartbeat (often wave=1
  // score=0 for a freshly-started run) while liveScore updates from
  // the frame stream. They'd disagree once the frames started arriving
  // (header shows '0' while the canvas HUD shows 11,705) which was
  // confusing. Removed; liveScore is canonical.

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

  // Replay controls — scrub bar + play/pause + speed. Only visible in
  // replay mode; live mode hides this row entirely. State (speed,
  // paused) is captured by closure and read by the playback tick.
  let replaySpeed = 1;
  let replayPaused = false;
  const replayCtl = el('div', { parent: overlay });
  replayCtl.style.cssText = 'display:none;margin:10px auto 0;max-width:760px;width:100%;flex-direction:column;gap:6px;';
  if (replayMode) replayCtl.style.display = 'flex';

  const timeRow = el('div', { parent: replayCtl });
  timeRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-family:monospace;font-size:0.78rem;color:rgba(220,210,255,0.78);';
  const playToggle = el('button', { className: 'menu-btn secondary', parent: timeRow, text: '⏸' }) as HTMLButtonElement;
  playToggle.style.cssText += 'flex:0 0 44px;padding:4px 0;';
  const restartBtn = el('button', { className: 'menu-btn secondary', parent: timeRow, text: '⏮' }) as HTMLButtonElement;
  restartBtn.style.cssText += 'flex:0 0 44px;padding:4px 0;';
  const timeLabel = el('span', { parent: timeRow, text: '0:00 / 0:00' });
  timeLabel.style.cssText = 'min-width:90px;text-align:center;color:#a8eecf;letter-spacing:0.06em;';
  const scrub = el('input', { parent: timeRow }) as HTMLInputElement;
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = '1000';
  scrub.step = '1';
  scrub.value = '0';
  scrub.style.cssText = 'flex:1;accent-color:#8cffb4;';

  // Playhead info — wave/score/lives/sats at the current frame. Updates
  // every tick as playback advances or the user scrubs. Sits between
  // the time row and speed row so it tracks naturally with the scrub
  // slider above it.
  const playInfo = el('div', { parent: replayCtl });
  playInfo.style.cssText = 'display:flex;justify-content:center;gap:14px;font-family:monospace;font-size:0.78rem;color:rgba(220,210,255,0.7);letter-spacing:0.08em;min-height:1.2em;';
  playInfo.textContent = '';

  const speedRow = el('div', { parent: replayCtl });
  speedRow.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:4px;font-family:monospace;font-size:0.78rem;flex-wrap:wrap;';

  // JUMP TO DEATH — scan replay frames for the final 'sh' (ship-hit)
  // SFX event, seek to ~2s before it. Surfaced only in replay mode +
  // when at least one 'sh' event exists. Set up later (after `frames`
  // is seeded) since the seed loop runs further down.
  let deathSeekBtn: HTMLButtonElement | null = null;
  if (replayMode) {
    deathSeekBtn = el('button', { className: 'menu-btn secondary', parent: speedRow, text: '💀 LAST DEATH' }) as HTMLButtonElement;
    deathSeekBtn.style.cssText += 'flex:0 0 auto;padding:4px 12px;font-size:0.78rem;color:#ffb0b0;border-color:rgba(255,120,120,0.5);margin-left:14px;display:none;';
    deathSeekBtn.title = 'Seek to ~2s before the final ship-hit event.';
  }

  if (replayMode) {
    const help = el('div', { parent: replayCtl });
    help.style.cssText = 'text-align:center;font-family:monospace;font-size:0.7rem;color:rgba(220,210,255,0.45);letter-spacing:0.06em;';
    help.textContent = 'SPACE pause · J/L ±5% · ,/. step · [/] speed · 0-9 jump · HOME restart';
  }
  const SPEEDS = [0.5, 1, 2, 4];
  const speedBtns: HTMLButtonElement[] = [];
  for (const sp of SPEEDS) {
    const b = el('button', { className: 'menu-btn secondary', parent: speedRow, text: `${sp}×` }) as HTMLButtonElement;
    b.style.cssText += 'flex:0 0 60px;padding:4px 0;font-size:0.78rem;';
    if (sp === 1) {
      b.style.background = 'rgba(140,255,180,0.20)';
      b.style.color = '#8cffb4';
    }
    b.addEventListener('click', () => {
      replaySpeed = sp;
      for (let i = 0; i < SPEEDS.length; i++) {
        const active = SPEEDS[i] === sp;
        speedBtns[i].style.background = active ? 'rgba(140,255,180,0.20)' : '';
        speedBtns[i].style.color = active ? '#8cffb4' : '';
      }
    });
    speedBtns.push(b);
  }
  // SHARE — only meaningful in replay mode with a known event id.
  // Copies a `watch.pallasite.app/#replay=<id>` URL so the recipient
  // opens the same rich replay in one click (Nostr resolution happens
  // client-side; no server lookup).
  const shareEventId = input.replaySource?.eventId;
  if (replayMode && shareEventId) {
    const shareBtn = el('button', { className: 'menu-btn secondary', parent: speedRow, text: 'COPY LINK' }) as HTMLButtonElement;
    shareBtn.style.cssText += 'flex:0 0 110px;padding:4px 0;font-size:0.78rem;color:#cbb6ff;border-color:rgba(184,144,255,0.55);margin-left:14px;';
    shareBtn.addEventListener('click', () => {
      const url = `https://watch.pallasite.app/#replay=${shareEventId}`;
      const restore = (): void => { setTimeout(() => { shareBtn.textContent = 'COPY LINK'; }, 1400); };
      void (async () => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            shareBtn.textContent = 'COPIED';
            restore();
            return;
          }
        } catch { /* fall through to manual copy */ }
        // Fallback: select a hidden textarea so iOS Safari without
        // Clipboard permissions still surfaces the URL for the user
        // to long-press-copy. Cheap to ship; rarely hit on modern UAs.
        window.prompt('Copy the replay link:', url);
        shareBtn.textContent = 'COPIED';
        restore();
      })();
    });
  }

  const closeRow = el('div', { className: 'menu-row', parent: overlay });
  // "WATCH FROM START" — only shown once STREAM ENDED fires. Polls
  // for the player's kind 30763 ghost (published at claim time) and
  // hands off to renderReplayTheatre when found. The button sits in
  // the same row as CLOSE so spectators see a single clean choice
  // row after the stream ends.
  const replayBtn = el('button', { className: 'menu-btn', parent: closeRow, text: 'WATCH FROM START' }) as HTMLButtonElement;
  replayBtn.style.display = 'none';
  const closeBtn = el('button', { className: 'menu-btn secondary', parent: closeRow, text: 'CLOSE · ESC' });

  playToggle.addEventListener('click', () => {
    replayPaused = !replayPaused;
    playToggle.textContent = replayPaused ? '▶' : '⏸';
  });
  restartBtn.addEventListener('click', () => {
    if (frames.length === 0) return;
    playbackT = frames[0].capturedAt;
    // Re-queue all SFX events so the run replays end-to-end with sound.
    pendingEvents.length = 0;
    for (const f of frames) {
      for (const ev of f.events) pendingEvents.push({ code: ev.code, x: ev.x, y: ev.y, dueAt: f.capturedAt });
    }
    particles.length = 0;
    debris.length = 0;
  });
  // Scrub bar — slider value 0..1000 maps to playbackT across the run.
  // While dragging we update playbackT directly and freeze the scrub
  // updates the tick loop would otherwise do.
  let scrubbing = false;
  const seekTo = (frac: number): void => {
    if (frames.length === 0) return;
    const span = frames[frames.length - 1].capturedAt - frames[0].capturedAt;
    playbackT = frames[0].capturedAt + span * frac;
    // Drop SFX events past the playhead to avoid a burst if the user
    // skipped forward; collect future events again so audio resumes.
    pendingEvents.length = 0;
    for (const f of frames) {
      if (f.capturedAt < playbackT) continue;
      for (const ev of f.events) pendingEvents.push({ code: ev.code, x: ev.x, y: ev.y, dueAt: f.capturedAt });
    }
    particles.length = 0;
    debris.length = 0;
  };
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('input', () => { seekTo(parseInt(scrub.value, 10) / 1000); });
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
        replayHint.textContent = 'No replay event found yet. Player may still be claiming, or their signer rejected the publish — check the player\'s console for [replay] lines.';
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
    console.log(`[replay] tryFetchReplay pubkey=${input.masterPubkey.slice(0, 8)}… since=${sinceSec}`);
    // 1) Rich kind 30764 replay — preferred. Carries the full world the
    // player saw (asteroids, UFOs, bullets, coins, SFX events). Played
    // back through this same theatre with replaySource set.
    let richReplay: Awaited<ReturnType<typeof findReplayByAuthor>> = null;
    try {
      richReplay = await findReplayByAuthor(input.masterPubkey, sinceSec);
    } catch (err) {
      console.warn('[replay] findReplayByAuthor threw:', err);
    }
    if (cancelled) return;
    if (richReplay && richReplay.frames.length >= 2) {
      setReplayState('success');
      cleanup();
      renderLiveTheatre({
        masterPubkey: input.masterPubkey,
        displayName: input.displayName,
        initialScore: richReplay.score,
        initialWave: richReplay.wave,
        runStartedAtMs: input.runStartedAtMs,
        onClose: input.onClose,
        replaySource: {
          frames: richReplay.frames,
          durationMs: richReplay.durationMs,
          headerLabel: 'REPLAY · WATCHING',
          eventId: richReplay.eventId,
        },
      });
      return;
    }
    // 2) Fallback: pose-only kind 30763 ghost. The legacy renderReplayTheatre
    // handles this — score chip + ship trajectory only, no world.
    let scoreEventId: string | null = null;
    try {
      scoreEventId = await findScoreIdForLatestGhost(input.masterPubkey, sinceSec);
    } catch { /* fall through to not_yet */ }
    if (cancelled) return;
    if (!scoreEventId) {
      setReplayState('not_yet');
      return;
    }
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
  // Wave assets — switch the background image and music track when the
  // player crosses a wave boundary. The mid-screen INCOMING banner
  // (rendered above, during 'warp' phase) is the only wave-intro cue
  // the spectator gets; the previous duplicate top-banner that fired on
  // wave-increment was redundant and read as visual noise after the
  // INCOMING bookend.
  const applyWaveAssets = (wave: number): void => {
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
  };
  applyWaveAssets(Math.max(1, input.initialWave));

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
    if (e.code === 'Escape') { cleanup(); input.onClose(); return; }
    if (!replayMode) return;
    // Replay-mode keyboard shortcuts — modelled on YouTube + standard
    // media-player conventions. All edits go through the same scrub /
    // pause / speed paths the buttons drive, so behaviour stays
    // consistent regardless of input.
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;  // don't hijack form fields
    const seekFracBy = (delta: number): void => {
      if (frames.length === 0) return;
      const span = frames[frames.length - 1].capturedAt - frames[0].capturedAt;
      if (span <= 0) return;
      const cur = (playbackT - frames[0].capturedAt) / span;
      const next = Math.max(0, Math.min(1, cur + delta));
      seekTo(next);
      scrub.value = String(Math.round(next * 1000));
    };
    const setSpeed = (sp: number): void => {
      replaySpeed = sp;
      for (let i = 0; i < SPEEDS.length; i++) {
        const active = SPEEDS[i] === sp;
        speedBtns[i].style.background = active ? 'rgba(140,255,180,0.20)' : '';
        speedBtns[i].style.color = active ? '#8cffb4' : '';
      }
    };
    switch (e.code) {
      case 'Space':
      case 'KeyK':
        e.preventDefault();
        replayPaused = !replayPaused;
        playToggle.textContent = replayPaused ? '▶' : '⏸';
        return;
      case 'KeyJ':
        e.preventDefault();
        seekFracBy(-0.05);  // ~5% back
        return;
      case 'KeyL':
        e.preventDefault();
        seekFracBy(0.05);
        return;
      case 'Comma':
        // Step back one wire frame (~16ms at 60Hz publish, ~33ms in
        // the subsampled buffer). Easiest is to find the frame just
        // before playbackT and seek to it.
        e.preventDefault();
        for (let i = frames.length - 1; i >= 0; i--) {
          if (frames[i].capturedAt < playbackT - 1) {
            seekTo((frames[i].capturedAt - frames[0].capturedAt) / Math.max(1, frames[frames.length - 1].capturedAt - frames[0].capturedAt));
            return;
          }
        }
        return;
      case 'Period':
        e.preventDefault();
        for (const f of frames) {
          if (f.capturedAt > playbackT + 1) {
            seekTo((f.capturedAt - frames[0].capturedAt) / Math.max(1, frames[frames.length - 1].capturedAt - frames[0].capturedAt));
            return;
          }
        }
        return;
      case 'BracketLeft': {
        e.preventDefault();
        const idx = SPEEDS.indexOf(replaySpeed);
        setSpeed(SPEEDS[Math.max(0, idx - 1)]);
        return;
      }
      case 'BracketRight': {
        e.preventDefault();
        const idx = SPEEDS.indexOf(replaySpeed);
        setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)]);
        return;
      }
      case 'Home':
        e.preventDefault();
        if (frames.length > 0) seekTo(0);
        return;
    }
    // Digits 0-9 seek to 0%, 10%, … 90%.
    if (e.code.startsWith('Digit') && e.code.length === 6) {
      const n = parseInt(e.code[5], 10);
      if (Number.isFinite(n)) {
        e.preventDefault();
        seekTo(n / 10);
      }
    }
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

  // Subscribe to the controller-ws relay as r=subscribe with the
  // player's master pubkey as the streamId. The relay broadcasts every
  // frame the player publishes to all subscribers. No Nostr envelope,
  // no per-event signature verification, ~3x lower latency than the
  // kind 22769 path.
  let frameCount = 0;
  let watchdog: number | null = null;
  const armWatchdog = (subOpen: () => void): void => {
    if (watchdog !== null) window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      if (cancelled) return;
      if (frameCount > 0) return;
      for (const s of sockets) try { s.close(); } catch { /* ignore */ }
      sockets.length = 0;
      status.textContent = 'Reconnecting…';
      subOpen();
    }, 4000);
  };
  const openSubscriptions = (): void => {
    if (cancelled) return;
    const url = `wss://controller.pallasite.app/?s=${encodeURIComponent(input.masterPubkey)}&r=subscribe`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { armWatchdog(openSubscriptions); return; }
    sockets.push(ws);
    ws.onopen = () => {
      status.textContent = 'Connected · waiting for first frame…';
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      // Server control frames: {type: 'publisher-up' | 'publisher-down'}
      if (typeof obj.type === 'string') {
        if (obj.type === 'publisher-up') {
          status.textContent = 'Player connected — waiting for first frame…';
        } else if (obj.type === 'publisher-down') {
          status.textContent = 'Player disconnected.';
        }
        return;
      }
      // Otherwise it's a wire frame — same shape as ReplayFrameRaw.
      const frame = readWsFrame(obj);
      if (frame) {
        pushFrame(frame);
        frameCount += 1;
        // Surface end-to-end latency (player publish time → here) so
        // we can spot when the WS pipe is congested or the player is
        // backgrounded. capturedAt is the player's Date.now() at
        // publish; receivedAt is our local performance.now() so we
        // compute against a fresh Date.now() to keep the same clock
        // base. Difference > 500ms is unusual.
        const lagMs = Math.max(0, Math.round(Date.now() - frame.capturedAt));
        status.textContent = `Live · ${frameCount} frames · ${lagMs}ms`;
        if (watchdog !== null) { window.clearTimeout(watchdog); watchdog = null; }
      }
    };
    ws.onerror = () => { armWatchdog(openSubscriptions); };
    ws.onclose = () => { armWatchdog(openSubscriptions); };
    armWatchdog(openSubscriptions);
  };
  if (!replayMode) openSubscriptions();

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

  // Replay mode: pre-seed the frame buffer with the entire replay, in
  // capture order. readWsFrame works directly on ReplayFrameRaw — same
  // shape as a WS payload (publishStreamFrameWs ships ReplayFrameRaw).
  // We push each frame manually rather than via pushFrame() so HUD
  // updates stay playback-driven (in the tick loop) instead of seeding
  // the HUD with the final-frame values up front.
  if (replayMode) {
    const replay = input.replaySource!;
    for (const raw of replay.frames) {
      const lf = readWsFrame(raw as unknown as Record<string, unknown>);
      if (!lf) continue;
      frames.push(lf);
      for (const ev of lf.events) {
        pendingEvents.push({ code: ev.code, x: ev.x, y: ev.y, dueAt: lf.capturedAt });
      }
    }
    status.textContent = `REPLAY · ${(replay.durationMs / 1000).toFixed(0)}s · ${replay.frames.length} frames`;
    // Replay starts at frame 0's wave so the spectator sees the run
    // unfold from the start. The tick-loop HUD update takes over after.
    const first = frames[0];
    if (first) {
      liveScore.textContent = `WAVE ${first.wave} · ${first.score.toLocaleString()}`;
      if (first.wave > 0) applyWaveAssets(first.wave);
    }
    // Scan for the latest 'sh' (ship-hit) SFX event — wire up the
    // JUMP TO DEATH button if one exists. Lead-in 2s before the
    // event so the spectator sees the lead-up + the hit.
    if (deathSeekBtn) {
      let deathT = -1;
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        for (const ev of f.events) {
          if (ev.code === 'sh') { deathT = f.capturedAt; break; }
        }
        if (deathT > 0) break;
      }
      if (deathT > 0 && frames.length > 0) {
        const oldest = frames[0].capturedAt;
        const newest = frames[frames.length - 1].capturedAt;
        const span = Math.max(1, newest - oldest);
        const seekTarget = (deathT - 2000 - oldest) / span;
        deathSeekBtn.style.display = '';
        deathSeekBtn.addEventListener('click', () => {
          seekTo(Math.max(0, Math.min(1, seekTarget)));
          scrub.value = String(Math.round(Math.max(0, Math.min(1, seekTarget)) * 1000));
        });
      }
    }
  }

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
  // 30Hz wire → 33ms inter-frame. Lead of 0ms slams playback to the
  // latest received frame: prev = next = latest, render at its pose.
  // No interpolation between frames, just a 30fps slam-cut. Costs
  // some smoothness on slow networks (visible step instead of glide)
  // but eliminates the intentional 100ms lag the user was feeling as
  // "2 second delay" when playing phone→watch. With 30Hz wire,
  // 30fps slam-cut motion is plenty smooth for spectating.
  const PLAYBACK_LEAD_MS = 0;
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
    if (replayMode) {
      // Linear playback through the full timeline. Speed is governed
      // by replaySpeed (set by the 0.5/1/2/4× buttons); playback can
      // be paused via replayPaused.
      if (playbackT === 0) playbackT = oldestCap;
      if (!replayPaused) playbackT += dtMs * replaySpeed;
      if (playbackT >= latestCap) {
        playbackT = latestCap;
        status.textContent = 'REPLAY ENDED · CLOSE · ESC';
      }
      if (!scrubbing) {
        const span = latestCap - oldestCap;
        const frac = span > 0 ? (playbackT - oldestCap) / span : 0;
        scrub.value = String(Math.round(frac * 1000));
        const fmt = (ms: number): string => {
          const s = Math.max(0, Math.floor(ms / 1000));
          return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
        };
        timeLabel.textContent = `${fmt(playbackT - oldestCap)} / ${fmt(span)}`;
      }
    } else {
      if (playbackT === 0) playbackT = latestCap - PLAYBACK_LEAD_MS;
      playbackT += dtMs;
      // Pin to the live edge so the prev/next lookup always lands on
      // (last-frame, last-frame) and renders the freshest pose. With
      // PLAYBACK_LEAD_MS=0 this collapses to playbackT === latestCap.
      if (playbackT > latestCap - PLAYBACK_LEAD_MS) playbackT = latestCap - PLAYBACK_LEAD_MS;
      // Hard resync if we've fallen way behind (e.g. tab was backgrounded
      // for a while and frames piled up).
      if (playbackT < oldestCap || latestCap - playbackT > PLAYBACK_LAG_LIMIT_MS) {
        playbackT = latestCap - PLAYBACK_LEAD_MS;
      }
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
    // Replay mode: drive the HUD off the playhead so score/wave/hearts
    // tick up as playback advances. Live mode updates HUD in pushFrame
    // when each new frame lands. playInfo lives in the controls row;
    // it duplicates the wave/score info next to the scrub slider so a
    // user dragging the bar sees the playhead state without looking up
    // at the main HUD.
    if (replayMode) {
      liveScore.textContent = `WAVE ${prev.wave} · ${prev.score.toLocaleString()}`;
      const heartsTotal = Math.max(0, prev.lives);
      const hearts = heartsTotal > 0 ? '♥'.repeat(Math.min(5, heartsTotal)) : 'NO LIVES';
      liveStats.textContent = `${hearts}  ·  ₿ ${prev.sats}`;
      liveStats.style.color = heartsTotal > 0 ? 'rgba(220,210,255,0.78)' : 'rgba(255,120,120,0.9)';
      if (prev.wave > 0) applyWaveAssets(prev.wave);
      playInfo.innerHTML = `<span style="color:#8cffb4;">WAVE ${prev.wave}</span>`
        + ` <span style="color:#ffe0a0;">SCORE ${prev.score.toLocaleString()}</span>`
        + ` <span style="color:${heartsTotal > 0 ? 'rgba(255,120,120,0.7)' : 'rgba(255,120,120,0.95)'};">${hearts}</span>`
        + ` <span style="color:#ffd84a;">₿ ${prev.sats}</span>`;
    }
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
        // Tank — squat hex with armour seams, rivets, gun barrels,
        // top turret + antenna, viewport scanner, white running light,
        // and bottom HP dots. Ported from render.ts drawUfo.tank.
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
        // Armour plate seams
        c2d.lineWidth = 1 * dpr;
        c2d.beginPath();
        c2d.moveTo(-w * 0.4, -h * 0.18); c2d.lineTo(w * 0.4, -h * 0.18);
        c2d.moveTo(-w * 0.4, h * 0.18); c2d.lineTo(w * 0.4, h * 0.18);
        c2d.stroke();
        // Bolt rivets at hex vertices
        c2d.fillStyle = col.shadow;
        c2d.shadowBlur = 0;
        for (const [hx, hy] of hexPts) {
          c2d.beginPath();
          c2d.arc(hx * 0.92, hy * 0.92, 1.2 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.shadowBlur = 12 * dpr;
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
        // Top turret with antenna
        c2d.beginPath();
        c2d.rect(-w * 0.1, -h * 0.5 - 5 * dpr, w * 0.2, 5 * dpr);
        c2d.fillStyle = col.primary;
        c2d.fill();
        c2d.stroke();
        c2d.beginPath();
        c2d.moveTo(0, -h * 0.5 - 5 * dpr);
        c2d.lineTo(0, -h * 0.5 - 11 * dpr);
        c2d.stroke();
        // Viewport scanner band
        const tankPulse = 0.7 + 0.3 * Math.sin(ufoBlink * 3);
        const vGrad = c2d.createLinearGradient(-w * 0.18, 0, w * 0.18, 0);
        vGrad.addColorStop(0, col.shadow);
        vGrad.addColorStop(0.5, col.cockpit);
        vGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = vGrad;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = (10 + tankPulse * 4) * dpr;
        c2d.globalAlpha = 0.7 + tankPulse * 0.3;
        c2d.beginPath();
        c2d.rect(-w * 0.18, -h * 0.34, w * 0.36, 4 * dpr);
        c2d.fill();
        c2d.globalAlpha = 1;
        c2d.shadowBlur = 12 * dpr;
        // Single bright white running light dead-centre
        c2d.fillStyle = '#ffffff';
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = 8 * dpr;
        c2d.beginPath();
        c2d.arc(0, -h * 0.32 + 2 * dpr, (1.4 + tankPulse * 0.6) * dpr, 0, Math.PI * 2);
        c2d.fill();
        // HP dots under the body
        c2d.shadowBlur = 0;
        const hpShown = Math.min(8, Math.max(0, uNext.hp));
        for (let i = 0; i < hpShown; i++) {
          const hpx = -7 * dpr + i * 7 * dpr;
          c2d.fillStyle = col.primary;
          c2d.beginPath();
          c2d.arc(hpx, h * 0.5 + 13 * dpr, 2 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.shadowBlur = 12 * dpr;
      } else if (uNext.type === 'p') {
        // Sniper — sleek elongated lozenge with twin engine ribbons,
        // single cyclops eye, swept fins. Ported from render.ts.
        const len = r * 2.8;
        const halfW = r * 0.85;
        c2d.scale(facing, 1);
        // Twin engine ribbons trailing behind — gradient triangles
        // fading from primary → transparent.
        for (const sign of [-1, 1]) {
          const ey = sign * halfW * 0.35;
          const ribbonLen = len * 0.45;
          const grad = c2d.createLinearGradient(-len * 0.46, ey, -len * 0.46 - ribbonLen, ey);
          grad.addColorStop(0, `${col.primary}cc`);
          grad.addColorStop(0.5, `${col.primary}55`);
          grad.addColorStop(1, `${col.primary}00`);
          c2d.save();
          c2d.fillStyle = grad;
          c2d.shadowColor = col.primary;
          c2d.shadowBlur = 12 * dpr;
          c2d.globalAlpha = 0.8;
          c2d.beginPath();
          c2d.moveTo(-len * 0.46, ey - 3 * dpr);
          c2d.lineTo(-len * 0.46 - ribbonLen, ey);
          c2d.lineTo(-len * 0.46, ey + 3 * dpr);
          c2d.closePath();
          c2d.fill();
          c2d.restore();
        }
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
        // Inner ring 6 tick marks (counter-rotation)
        c2d.save();
        c2d.rotate(-ufoBlink * 0.7);
        c2d.lineWidth = 1.5 * dpr;
        c2d.strokeStyle = col.primary;
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI * 2 * i) / 6;
          const x1 = Math.cos(a) * r * 0.85;
          const y1 = Math.sin(a) * r * 0.85;
          c2d.beginPath();
          c2d.moveTo(x1 * 0.95, y1 * 0.95);
          c2d.lineTo(x1 * 1.05, y1 * 1.05);
          c2d.stroke();
        }
        c2d.restore();
        // Pulsing core
        const pulse = 0.7 + 0.3 * Math.sin(ufoBlink * 3);
        c2d.fillStyle = `rgba(255,216,74,${pulse * 0.7})`;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = 30 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.28 * pulse, 0, Math.PI * 2);
        c2d.fill();
        // Bright white eye dot
        c2d.fillStyle = '#fff';
        c2d.shadowBlur = 16 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, r * 0.07, 0, Math.PI * 2);
        c2d.fill();
        // Top dome
        c2d.shadowColor = col.primary;
        c2d.shadowBlur = 12 * dpr;
        c2d.fillStyle = col.shadow;
        c2d.beginPath();
        c2d.arc(0, -r * 0.2, r * 0.35, Math.PI, 0);
        c2d.fill();
        c2d.stroke();
        // HP bar above with segment markers (every 5 HP across max 25)
        c2d.shadowBlur = 0;
        const hpMax = 25;
        const hpFrac = Math.max(0, Math.min(1, uNext.hp / hpMax));
        c2d.fillStyle = 'rgba(0,0,0,0.55)';
        c2d.fillRect(-r * 0.95, -r - 16 * dpr, r * 1.9, 7 * dpr);
        c2d.fillStyle = '#ff5050';
        c2d.fillRect(-r * 0.95, -r - 16 * dpr, r * 1.9 * hpFrac, 7 * dpr);
        c2d.strokeStyle = 'rgba(255,255,255,0.35)';
        c2d.lineWidth = 1 * dpr;
        for (let s = 1; s < 5; s++) {
          const segX = -r * 0.95 + (r * 1.9) * (s / 5);
          c2d.beginPath();
          c2d.moveTo(segX, -r - 16 * dpr);
          c2d.lineTo(segX, -r - 9 * dpr);
          c2d.stroke();
        }
        c2d.strokeStyle = col.primary;
        c2d.lineWidth = 1.5 * dpr;
        c2d.strokeRect(-r * 0.95, -r - 16 * dpr, r * 1.9, 7 * dpr);
      } else if (uNext.type === 'e') {
        // Elite — fast stealth saucer with twin engine pods. Distinct
        // silhouette from cruiser: lower, sleeker, twin nacelles.
        // Ported from render.ts drawUfo's elite branch.
        const w = r * 2.6;
        const h = r * 1.05;
        c2d.scale(facing, 1);
        // Lower hull
        const hullGrad = c2d.createRadialGradient(0, h * 0.3, h * 0.15, 0, 0, w * 0.55);
        hullGrad.addColorStop(0, col.accent);
        hullGrad.addColorStop(0.55, col.primary);
        hullGrad.addColorStop(1, col.shadow);
        c2d.beginPath();
        c2d.ellipse(0, h * 0.05, w * 0.5, h * 0.42, 0, 0, Math.PI * 2);
        c2d.fillStyle = hullGrad;
        c2d.fill();
        c2d.stroke();
        // Forward swept canopy
        const canopyGrad = c2d.createLinearGradient(0, -h * 0.5, 0, 0);
        canopyGrad.addColorStop(0, col.cockpit);
        canopyGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = canopyGrad;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = 10 * dpr;
        c2d.beginPath();
        c2d.moveTo(w * 0.42, 0);
        c2d.bezierCurveTo(w * 0.42, -h * 0.55, -w * 0.25, -h * 0.55, -w * 0.25, 0);
        c2d.closePath();
        c2d.fill();
        c2d.stroke();
        // Canopy reflection
        c2d.shadowBlur = 0;
        c2d.strokeStyle = `${col.accent}cc`;
        c2d.lineWidth = 1 * dpr;
        c2d.beginPath();
        c2d.moveTo(w * 0.34, -h * 0.18);
        c2d.bezierCurveTo(w * 0.30, -h * 0.42, -w * 0.10, -h * 0.42, -w * 0.18, -h * 0.18);
        c2d.stroke();
        c2d.strokeStyle = col.primary;
        c2d.lineWidth = 1.5 * dpr;
        c2d.shadowColor = col.primary;
        c2d.shadowBlur = 12 * dpr;
        // Twin engine pods + glowing intakes
        const ePulse = ufoBlink * 5;
        for (const py of [-h * 0.2, h * 0.2]) {
          c2d.fillStyle = col.shadow;
          c2d.beginPath();
          c2d.ellipse(-w * 0.42, py, w * 0.08, h * 0.18, 0, 0, Math.PI * 2);
          c2d.fill();
          c2d.stroke();
          const intakePulse = 0.6 + 0.4 * Math.sin(ePulse * 2 + (py > 0 ? 0 : Math.PI));
          c2d.fillStyle = col.cockpit;
          c2d.shadowColor = col.cockpit;
          c2d.shadowBlur = (8 + intakePulse * 6) * dpr;
          c2d.globalAlpha = 0.7 + intakePulse * 0.3;
          c2d.beginPath();
          c2d.arc(-w * 0.36, py, 1.6 * dpr, 0, Math.PI * 2);
          c2d.fill();
          c2d.globalAlpha = 1;
        }
        c2d.shadowColor = col.primary;
        c2d.shadowBlur = 12 * dpr;
        // Underside running lights
        for (let i = 0; i < 3; i++) {
          const x = -w * 0.18 + i * w * 0.18;
          const phase = (Math.sin(ePulse + i * 1.6) + 1) / 2;
          c2d.globalAlpha = 0.4 + phase * 0.5;
          c2d.fillStyle = col.cockpit;
          c2d.shadowColor = col.cockpit;
          c2d.shadowBlur = 6 * dpr;
          c2d.beginPath();
          c2d.arc(x, h * 0.38, 1.6 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.globalAlpha = 1;
      } else {
        // Cruiser ('c') and any unknown — classic saucer with chrome-
        // belly hull, equator ridge, top dome, underside porthole
        // lights. Ported from render.ts drawUfo's cruiser branch.
        const w = r * 2.4;
        const h = r * 1.0;
        c2d.scale(facing, 1);
        const bodyGrad = c2d.createRadialGradient(0, -h * 0.4, h * 0.1, 0, h * 0.2, w * 0.55);
        bodyGrad.addColorStop(0, col.accent);
        bodyGrad.addColorStop(0.5, col.primary);
        bodyGrad.addColorStop(1, col.shadow);
        c2d.beginPath();
        c2d.ellipse(0, 0, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
        c2d.fillStyle = bodyGrad;
        c2d.fill();
        c2d.stroke();
        // Equator seam
        c2d.lineWidth = 1 * dpr;
        c2d.strokeStyle = col.shadow;
        c2d.beginPath();
        c2d.moveTo(-w * 0.48, 0); c2d.lineTo(w * 0.48, 0);
        c2d.stroke();
        c2d.strokeStyle = col.primary;
        c2d.lineWidth = 1.5 * dpr;
        // Top dome
        const domeGrad = c2d.createRadialGradient(0, -h * 0.45, 0, 0, -h * 0.3, w * 0.2);
        domeGrad.addColorStop(0, col.cockpit);
        domeGrad.addColorStop(1, col.shadow);
        c2d.fillStyle = domeGrad;
        c2d.shadowColor = col.cockpit;
        c2d.shadowBlur = 10 * dpr;
        c2d.beginPath();
        c2d.arc(0, -h * 0.3, w * 0.2, Math.PI, 0);
        c2d.fill();
        c2d.stroke();
        // Underside porthole round-robin blink
        c2d.shadowBlur = 8 * dpr;
        const cPulse = ufoBlink * 4;
        for (let i = 0; i < 5; i++) {
          const x = -w * 0.35 + (i / 4) * w * 0.7;
          const phase = Math.sin(cPulse + i * 1.4);
          c2d.fillStyle = phase > 0 ? col.cockpit : col.shadow;
          c2d.beginPath();
          c2d.arc(x, h * 0.32, 2.2 * dpr, 0, Math.PI * 2);
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
    // on the wire (vx, vy). For bullets present in BOTH prev and next,
    // extrapolate freely. For bullets only in next (just spawned
    // between prev and next), skip drawing until playbackT actually
    // reaches their spawn moment — otherwise we draw a phantom bullet
    // flying backwards from the ship for the buffer's worth of time.
    const bulletExtrapMs = playbackT - next.capturedAt;
    const prevBulletIds = prevBullet;  // already a Map keyed by id
    for (const bNext of next.bullets) {
      if (!prevBulletIds.has(bNext.id) && bulletExtrapMs < 0) continue;
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
        // Per-type silhouette mirrors render.ts drawDustShape so the
        // four asteroid families read as distinct loot.
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
        if (sourceKey === 'iron') {
          // Hex nut — flat sides + bolt-mark.
          c2d.beginPath();
          for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2 - Math.PI / 2;
            const px = Math.cos(ang) * r;
            const py = Math.sin(ang) * r;
            if (i === 0) c2d.moveTo(px, py); else c2d.lineTo(px, py);
          }
          c2d.closePath();
          c2d.stroke();
          c2d.lineWidth = 0.9 * dpr;
          c2d.globalAlpha = 0.6;
          c2d.beginPath();
          c2d.arc(0, 0, r * 0.35, 0, Math.PI * 2);
          c2d.stroke();
          c2d.globalAlpha = 1;
        } else if (sourceKey === 'chondrite') {
          // Three-fragment cluster — chondrites split into three.
          const off = r * 0.55;
          const tri = (cxL: number, cyL: number): void => {
            c2d.beginPath();
            c2d.moveTo(cxL, cyL - r * 0.42);
            c2d.lineTo(cxL + r * 0.36, cyL + r * 0.22);
            c2d.lineTo(cxL - r * 0.36, cyL + r * 0.22);
            c2d.closePath();
            c2d.stroke();
          };
          tri(0, -off * 0.4);
          tri(-off * 0.6, off * 0.4);
          tri(off * 0.6, off * 0.4);
        } else if (sourceKey === 'pallasite') {
          // Six-point star — premium silhouette.
          c2d.beginPath();
          const points = 12;
          for (let i = 0; i < points; i++) {
            const ang = (i / points) * Math.PI * 2 - Math.PI / 2;
            const radius = i % 2 === 0 ? r : r * 0.45;
            const px = Math.cos(ang) * radius;
            const py = Math.sin(ang) * radius;
            if (i === 0) c2d.moveTo(px, py); else c2d.lineTo(px, py);
          }
          c2d.closePath();
          c2d.stroke();
        } else {
          // Stony (default) — diamond facet with cross-hatch interior.
          c2d.beginPath();
          c2d.moveTo(0, -r);
          c2d.lineTo(r * 0.78, 0);
          c2d.lineTo(0, r);
          c2d.lineTo(-r * 0.78, 0);
          c2d.closePath();
          c2d.stroke();
          c2d.lineWidth = 0.9 * dpr;
          c2d.globalAlpha = 0.6;
          c2d.beginPath();
          c2d.moveTo(0, -r * 0.6); c2d.lineTo(0, r * 0.6);
          c2d.moveTo(-r * 0.5, 0); c2d.lineTo(r * 0.5, 0);
          c2d.stroke();
          c2d.globalAlpha = 1;
        }
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
      // Skin palette — mirrors src/skins.ts SKINS[].palette closely
      // enough that the watcher renders the cosmetic the player picked.
      // RGBA-fill / shadow tweaks land via a single PALETTE record so
      // adding a new skin is just adding an entry here + matching the
      // wire code in stream-session.ts. Default = ship-green, matching
      // the game's STANDARD skin.
      const skinCode = (t < 0.5 ? prev.skin : next.skin) ?? 'd';
      const WATCHER_SHIP_SKIN: Record<'d' | 'i' | 'h', {
        ship: string; fill: string; shadow: string;
        thrust: string; thrustShadow: string;
        bloomCore: string; bloomMid: string;
      }> = {
        d: { ship: '#8cffb4', fill: 'rgba(140,255,180,0.18)', shadow: 'rgba(140,255,180,0.7)',
             thrust: '#ffd84a', thrustShadow: 'rgba(255,216,74,0.8)',
             bloomCore: 'rgba(255,216,74,0.55)', bloomMid: 'rgba(255,138,58,0.25)' },
        i: { ship: '#ff7a3a', fill: 'rgba(255,122,58,0.20)', shadow: 'rgba(255,122,58,0.7)',
             thrust: '#ffd84a', thrustShadow: 'rgba(255,122,58,0.8)',
             bloomCore: 'rgba(255,160,80,0.55)', bloomMid: 'rgba(220,90,30,0.22)' },
        h: { ship: '#5be0ff', fill: 'rgba(91,224,255,0.20)', shadow: 'rgba(91,224,255,0.7)',
             thrust: '#cfeefb', thrustShadow: 'rgba(91,224,255,0.8)',
             bloomCore: 'rgba(150,230,255,0.55)', bloomMid: 'rgba(60,160,220,0.22)' },
      };
      const skinPal = WATCHER_SHIP_SKIN[skinCode];
      // Match render.ts drawShip exactly — same triangle proportions
      // (14, -10/8 wings, -6 notch). Scaled by sx so it occupies the
      // same canvas fraction as in-game.
      c2d.save();
      c2d.translate(x, y);
      c2d.rotate(rot);
      c2d.scale(shipScale, shipScale);
      c2d.lineWidth = 1.6;
      c2d.strokeStyle = skinPal.ship;
      c2d.fillStyle = skinPal.fill;
      c2d.shadowColor = skinPal.shadow;
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
        c2d.save();
        c2d.globalCompositeOperation = 'lighter';
        const bloom = c2d.createRadialGradient(-10, 0, 0, -10, 0, 24);
        bloom.addColorStop(0, skinPal.bloomCore);
        bloom.addColorStop(0.5, skinPal.bloomMid);
        bloom.addColorStop(1, 'rgba(0,0,0,0)');
        c2d.fillStyle = bloom;
        c2d.beginPath();
        c2d.arc(-10, 0, 24, 0, Math.PI * 2);
        c2d.fill();
        c2d.restore();
        c2d.strokeStyle = skinPal.thrust;
        c2d.shadowColor = skinPal.thrustShadow;
        c2d.shadowBlur = 10;
        c2d.lineWidth = 1.4;
        c2d.beginPath();
        c2d.moveTo(-6, 4);
        c2d.lineTo(-14, 0);
        c2d.lineTo(-6, -4);
        c2d.stroke();
      }
      c2d.restore();
      if (shielded) {
        // Match render.ts drawShield: outer-glow radial gradient + hex
        // perimeter with 6 rotating dots. Sized off the ship's world
        // radius (14) × 2.2 like the game so the bubble looks the same
        // fraction of the canvas the player sees. Previous version was
        // a single 17px arc — way smaller + flatter than the game's.
        const shipR = 14 * shipScale;
        const shieldR = shipR * 2.2 + Math.sin(nowPerf * 0.012) * 1.5 * dpr;
        c2d.save();
        c2d.translate(x, y);
        const sg = c2d.createRadialGradient(0, 0, shipR * 1.2, 0, 0, shieldR);
        sg.addColorStop(0, 'rgba(91,157,255,0)');
        sg.addColorStop(0.7, 'rgba(91,157,255,0.18)');
        sg.addColorStop(1, 'rgba(91,157,255,0.5)');
        c2d.fillStyle = sg;
        c2d.beginPath();
        c2d.arc(0, 0, shieldR, 0, Math.PI * 2);
        c2d.fill();
        c2d.strokeStyle = 'rgba(91,157,255,0.85)';
        c2d.lineWidth = 1.2 * dpr;
        c2d.shadowColor = '#5b9dff';
        c2d.shadowBlur = 14 * dpr;
        c2d.beginPath();
        c2d.arc(0, 0, shieldR, 0, Math.PI * 2);
        c2d.stroke();
        c2d.shadowBlur = 0;
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI * 2 * i) / 6 + nowPerf * 0.001;
          c2d.fillStyle = 'rgba(180,220,255,0.9)';
          c2d.beginPath();
          c2d.arc(Math.cos(a) * shieldR, Math.sin(a) * shieldR, 2 * dpr, 0, Math.PI * 2);
          c2d.fill();
        }
        c2d.restore();
      }
    }

    // 3a. Warp-incoming banner — fires while the player is in 'warp'
    // phase (1.3s between waves). The host sends nextWave so we know
    // which wave is about to land; we render "WAVE N+1 INCOMING" as a
    // big centred banner over the frozen last-gameplay-frame canvas.
    // This replaces the 60Hz frame stream during warp (host throttles
    // to 1Hz heartbeats; banner gives the spectator something to look
    // at instead of a static last-frame).
    if (prev.phase === 'warp' && prev.nextWave > 0) {
      const incomingLore = WAVE_LORE[prev.nextWave - 1];
      if (incomingLore) {
        const bannerY = CANVAS_H * 0.5;
        c2d.save();
        c2d.globalAlpha = 0.78;
        c2d.fillStyle = '#02050d';
        c2d.fillRect(0, bannerY - 70 * dpr, CANVAS_W, 160 * dpr);
        c2d.globalAlpha = 1;
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillStyle = 'rgba(140,255,180,0.9)';
        c2d.font = `${Math.round(16 * dpr)}px ui-monospace, monospace`;
        const blinkOn = Math.sin(nowPerf * 0.005) > 0;
        c2d.globalAlpha = blinkOn ? 1 : 0.35;
        c2d.fillText('INCOMING', CANVAS_W / 2, bannerY - 38 * dpr);
        c2d.globalAlpha = 1;
        c2d.fillStyle = '#ffd84a';
        c2d.shadowColor = 'rgba(255,216,74,0.7)';
        c2d.shadowBlur = 18 * dpr;
        c2d.font = `bold ${Math.round(34 * dpr)}px ui-monospace, monospace`;
        c2d.fillText(`WAVE ${prev.nextWave} · ${incomingLore.name}`, CANVAS_W / 2, bannerY - 4 * dpr);
        c2d.shadowBlur = 0;
        c2d.fillStyle = 'rgba(220,210,255,0.8)';
        c2d.font = `${Math.round(12 * dpr)}px ui-monospace, monospace`;
        c2d.fillText(incomingLore.subtitle, CANVAS_W / 2, bannerY + 26 * dpr);
        c2d.fillStyle = 'rgba(140,255,180,0.7)';
        c2d.font = `${Math.round(11 * dpr)}px ui-monospace, monospace`;
        c2d.fillText(incomingLore.tagline, CANVAS_W / 2, bannerY + 48 * dpr);
        c2d.textAlign = 'start';
        c2d.textBaseline = 'alphabetic';
        c2d.restore();
      }
    }

    // 4. Live indicator + age label + paused / ended overlays
    c2d.shadowBlur = 0;
    const latest = frames[frames.length - 1];
    // Age measured against viewer-local arrival time — capturedAt is
    // the player's Date.now() which can drift and gave false STALE
    // labels when the viewer's clock ran slightly behind the player's.
    // In replay mode the frame buffer is pre-seeded so `latest.receivedAt`
    // would always show massively stale — short-circuit the freshness
    // checks instead.
    const ageMs = !replayMode && latest ? performance.now() - latest.receivedAt : 0;
    const stale = !replayMode && ageMs > 3_000;
    const veryStale = !replayMode && ageMs > 6_000;
    // PAUSED only sticks while frames keep arriving (the player is
    // genuinely paused, frames keep flowing every 500ms with paused=1).
    // If frames go stale during a paused frame, the player has quit
    // or backgrounded — drop the PAUSED overlay so the watcher doesn't
    // sit on PAUSED forever waiting for the very-stale threshold.
    const paused = !replayMode && next.paused === true && !stale;
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
    // 'not_yet' state for manual retry. Skipped in replay mode (we're
    // already in the replay).
    if (!replayMode) {
      if (ended && !replayAutoTried) {
        replayAutoTried = true;
        void tryFetchReplay();
      } else if (!ended && replayState !== 'hidden' && replayState !== 'loading') {
        // Stream came back to life (rare — relay reconnect) — hide the
        // button so we don't strand a stale "TRY AGAIN" alongside live
        // frames.
        setReplayState('hidden');
      }
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

  // Bigger QR slot for cleaner phone-camera detection at desk distance.
  // 200px was tight on a 1080p+ host monitor — a phone aimed from 30cm
  // away saw the QR fill <5% of its frame, which most scanners struggle
  // with. 280px nearly doubles the visual area and reliably latches
  // even on mid-range phone cameras.
  const qrSlot = el('div', { parent: overlay });
  qrSlot.style.cssText = 'width:280px;height:280px;background:#fff;border-radius:8px;padding:12px;margin:0 auto;box-shadow:0 0 20px rgba(140,255,180,0.25);';

  const codeP = el('p', { parent: overlay });
  codeP.style.cssText = 'margin:14px 0 6px;font-size:1.1rem;letter-spacing:0.2em;color:var(--hud-yellow);text-shadow:0 0 8px rgba(255,216,74,0.45);';

  const status = el('p', { parent: overlay });
  status.style.cssText = 'margin:8px 0 4px;font-size:0.95rem;color:rgba(140,255,180,0.85);min-height:1.4em;letter-spacing:0.08em;';
  status.textContent = 'Generating session key…';

  // Identity banner — populates when the phone announces a
  // SignerAnnounceFrame on pair. Step 2 of phone-as-signer is
  // cosmetic: the host still signs with its local session. Step 3
  // swaps the host's session for a RemoteControllerSigner backed by
  // this announce.
  const signerLine = el('p', { parent: overlay });
  signerLine.style.cssText = 'margin:2px 0 4px;font-size:0.85rem;color:rgba(184,144,255,0.9);min-height:1.2em;letter-spacing:0.1em;display:none;';

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
      // Phone-as-signer step 3: as soon as the host exists, wire it
      // up so any signer-announce frame swaps state.session for a
      // RemoteControllerSigner. attachRemoteSession is idempotent
      // (won't double-swap on re-announce) and unwires itself when
      // the host closes. Only attach for fresh hosts — re-opening
      // the dialog mustn't double-subscribe.
      void import('./remote-signer.js').then(({ attachRemoteSession }) => {
        if (activeControllerHost) attachRemoteSession(state, activeControllerHost);
      });
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
        signerLine.style.display = 'none';
      } else if (s.kind === 'closed') {
        status.textContent = 'Disconnected.';
        primaryBtn.textContent = 'BACK';
        secondaryBtn.style.display = 'none';
        signerLine.style.display = 'none';
      }
    });
    host.onSigner((signer) => {
      if (!signer) {
        signerLine.style.display = 'none';
        return;
      }
      // Shorten npub for the banner — full bech32 is 63 chars which
      // wraps awkwardly in this dialog. First 12 + last 6 is the
      // standard "npub1abc…xyz" form most clients use.
      let npubShort: string;
      if (signer.npub && signer.npub.length > 18) {
        npubShort = `${signer.npub.slice(0, 12)}…${signer.npub.slice(-6)}`;
      } else if (signer.npub) {
        npubShort = signer.npub;
      } else {
        npubShort = `${signer.pubkey.slice(0, 8)}…${signer.pubkey.slice(-4)}`;
      }
      const displayName = signer.name ?? npubShort;
      signerLine.textContent = `🔐 Phone signing as ${displayName}`;
      signerLine.style.display = '';
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

/**
 * Identity card shown at the top of the controller PWA home page.
 *
 * Step 1 of the phone-as-signer plan: the controller is just an
 * identity carrier here — pair frames don't yet propagate the signed-in
 * pubkey to a host. That's step 2. For now this card lets a player
 * sign in (or stay anonymous) on the pad itself, surfaces the pubkey,
 * and offers SIGN OUT.
 *
 * Method ordering is deliberate: bunker / nsec / extension first, then
 * Signet, then guest. Privacy-conscious nostr users at BTC Prague
 * don't want a Signet redirect as the headline option, they want to
 * paste their bunker URI from nsec.app or paste an nsec directly.
 */
function renderControllerIdentityCard(parent: HTMLElement, state: GameState): void {
  const card = el('div', { parent });
  card.style.cssText = 'border:1px solid rgba(255,216,74,0.32);border-radius:14px;padding:18px;background:rgba(255,216,74,0.05);display:flex;flex-direction:column;gap:12px;';

  const refresh = (): void => {
    card.replaceChildren();
    renderControllerIdentityCardInner(card, state, refresh);
  };
  renderControllerIdentityCardInner(card, state, refresh);
}

function renderControllerIdentityCardInner(
  card: HTMLElement,
  state: GameState,
  refresh: () => void,
): void {
  const label = el('div', { parent: card, text: 'IDENTITY' });
  label.style.cssText = 'font-size:0.78rem;letter-spacing:0.22em;color:rgba(255,216,74,0.85);text-align:center;';

  const session = state.session;
  if (session) {
    // Signed-in summary: name / npub / method / SIGN OUT.
    const guest = getGuestRecord();
    const isGuest = guest?.pubkey === session.pubkey;
    const profile = getCachedProfile(session.pubkey);
    // Same precedence as buildAnnouncedSigner — prefer profile, then
    // fall back to SignetSession.displayName before the 8-hex sentinel
    // so a freshly-paired bunker session shows the bunker's display
    // name immediately instead of "ABCD1234".
    const profileName = bestName(profile, session.pubkey);
    const profileLooksLikeFallback = /^[0-9A-F]{8}$/.test(profileName);
    const name = isGuest && guest
      ? guest.name
      : (profileLooksLikeFallback && session.displayName ? session.displayName : profileName);

    const nameRow = el('div', { parent: card, text: name });
    nameRow.style.cssText = 'font-size:1.05rem;color:#fff5d8;letter-spacing:0.08em;text-align:center;text-shadow:0 0 10px rgba(255,216,74,0.35);';

    let npubShort: string;
    try {
      const full = encodeNpub(session.pubkey);
      npubShort = full.length > 24 ? `${full.slice(0, 14)}…${full.slice(-6)}` : full;
    } catch {
      npubShort = `${session.pubkey.slice(0, 8)}…${session.pubkey.slice(-4)}`;
    }
    const npubRow = el('div', { parent: card, text: npubShort });
    npubRow.style.cssText = 'font-size:0.72rem;color:rgba(220,210,255,0.6);text-align:center;letter-spacing:0.06em;word-break:break-all;';

    const methodLabel = isGuest ? 'LOCAL GUEST' : describeMethod(session);
    const methodRow = el('div', { parent: card, text: methodLabel });
    methodRow.style.cssText = 'font-size:0.65rem;color:rgba(140,255,180,0.7);letter-spacing:0.22em;text-align:center;';

    const actions = el('div', { parent: card });
    actions.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:4px;';

    if (isGuest && guest) {
      const exportBtn = el('button', { parent: actions, text: 'EXPORT KEYS' }) as HTMLButtonElement;
      exportBtn.style.cssText = 'padding:10px 16px;background:rgba(140,255,180,0.14);border:1px solid rgba(140,255,180,0.55);border-radius:8px;color:#8cffb4;font-family:ui-monospace,monospace;font-size:0.78rem;letter-spacing:0.16em;cursor:pointer;';
      exportBtn.addEventListener('click', () => {
        const priv = getGuestPrivkeyHex();
        if (priv) openGuestKeyExport(guest.pubkey, priv);
      });
    }

    const signOutBtn = el('button', { parent: actions, text: 'SIGN OUT' }) as HTMLButtonElement;
    signOutBtn.style.cssText = 'padding:10px 16px;background:rgba(255,120,120,0.14);border:1px solid rgba(255,120,120,0.55);border-radius:8px;color:#ff8a8a;font-family:ui-monospace,monospace;font-size:0.78rem;letter-spacing:0.16em;cursor:pointer;';
    signOutBtn.addEventListener('click', () => {
      void (async () => {
        signOutBtn.disabled = true;
        try { await auth.signOut(state.session); } catch { /* ignore */ }
        // Guest identities live in our localStorage, not Signet's — wipe
        // those too so SIGN OUT is a clean slate regardless of method.
        if (isGuest) clearGuestIdentity();
        state.session = null;
        refresh();
      })();
    });

    // Once paired, the host swaps its local session for a remote
    // signer backed by this phone. Every game-side signEvent
    // (heartbeat, score, replay, claim) round-trips back here and
    // the phone's local signer fulfils it. The big screen never
    // sees your nsec.
    const gap = el('p', { parent: card });
    gap.style.cssText = 'margin:8px 0 0;font-size:0.68rem;color:rgba(140,255,180,0.55);text-align:center;letter-spacing:0.04em;line-height:1.5;';
    gap.textContent = 'Pair with a game — the big screen will sign through this phone. Your key never leaves the device.';
    return;
  }

  // Anonymous: explain what signing in buys, list methods, BTC-Prague
  // friendly order (bunker → nsec → extension → Signet → guest).
  const blurb = el('p', { parent: card });
  blurb.style.cssText = 'margin:0;font-size:0.78rem;color:rgba(220,210,255,0.65);line-height:1.5;text-align:center;';
  blurb.textContent = 'Sign in on the pad so your phone holds your keys. Optional — you can pair as a plain joystick and let the host sign.';

  const methods = el('div', { parent: card });
  methods.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px;';

  type MethodSpec = {
    label: string;
    sub: string;
    onClick: () => void;
    accent: string;
  };
  const status = el('div', { parent: card });
  status.style.cssText = 'min-height:1.2em;font-size:0.78rem;color:rgba(220,210,255,0.7);text-align:center;letter-spacing:0.04em;';

  let busy = false;
  const runSignIn = async (method: auth.SignInMethod, label: string): Promise<void> => {
    if (busy) return;
    busy = true;
    status.textContent = `Opening ${label}…`;
    status.style.color = 'rgba(180,140,255,0.85)';
    try {
      const sess = await auth.signInWith(method);
      if (sess) {
        state.session = sess;
        // Profile lookup is fire-and-forget; the card renders from
        // session.pubkey + cached profile so we don't gate on the fetch.
        void import('./profile.js').then(({ fetchProfile }) => {
          void fetchProfile(sess.pubkey).then(p => {
            if (p && state.session?.pubkey === sess.pubkey) {
              state.profile = p;
              refresh();
            }
          });
        });
        refresh();
      } else {
        status.textContent = 'No signer attached.';
        status.style.color = '#ff8a3a';
        busy = false;
      }
    } catch (err) {
      status.textContent = err instanceof auth.SignInTimeoutError
        ? err.message
        : `Failed: ${err instanceof Error ? err.message : String(err)}`;
      status.style.color = '#ff5050';
      busy = false;
    }
  };

  // Ordered MOST secure → LEAST secure. The bunker path keeps your
  // nsec on a separate device entirely; the extension/Amber paths
  // keep it OS- or browser-isolated; Signet trusts an operator; nsec
  // paste and guest both land an nsec in this device's localStorage
  // (nsec paste is worse blast-radius because it's likely your main
  // identity, vs. a guest that's a fresh sacrifice key).
  const hasNip07 = typeof window !== 'undefined' && 'nostr' in window && Boolean((window as { nostr?: unknown }).nostr);
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const specs: MethodSpec[] = [];
  specs.push({
    label: '🔗 PASTE BUNKER URI',
    sub: 'NIP-46 · key stays on your remote signer (nsec.app, Alby, your own bunker)',
    accent: 'rgba(140,255,180,0.55)',
    onClick: () => { void runSignIn('bunker', 'bunker'); },
  });
  if (hasNip07) {
    specs.push({
      label: '🔌 BROWSER EXTENSION',
      sub: 'NIP-07 · key isolated in the browser extension',
      accent: 'rgba(140,200,255,0.55)',
      onClick: () => { void runSignIn('nip07', 'extension'); },
    });
  }
  if (isAndroid) {
    specs.push({
      label: '🤖 SIGN VIA AMBER',
      sub: 'Android-only · key stays in the Amber signing app',
      accent: 'rgba(255,200,120,0.55)',
      onClick: () => { void runSignIn('amber', 'Amber'); },
    });
  }
  specs.push({
    label: '📱 SIGN IN WITH SIGNET',
    sub: 'OAuth-style sign-in via Signet · open-source, self-hostable',
    accent: 'rgba(255,216,74,0.55)',
    onClick: () => { void runSignIn('redirect', 'Signet'); },
  });
  specs.push({
    label: '🔑 PASTE NSEC',
    sub: 'Raw key in this browser · only do this on a phone YOU control',
    accent: 'rgba(184,144,255,0.55)',
    onClick: () => { void runSignIn('nsec', 'nsec paste'); },
  });
  specs.push({
    label: '🎮 PLAY AS GUEST',
    sub: 'Fresh local keypair · stored in this browser, exportable later',
    accent: 'rgba(255,140,200,0.55)',
    onClick: () => { void startControllerGuestFlow(state, refresh); },
  });

  for (const spec of specs) {
    const btn = el('button', { parent: methods }) as HTMLButtonElement;
    btn.style.cssText = `display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:12px 14px;background:rgba(2,5,13,0.55);border:1.5px solid ${spec.accent};border-radius:10px;color:#fff5d8;font-family:ui-monospace,monospace;font-size:0.92rem;letter-spacing:0.12em;cursor:pointer;text-align:left;`;
    const top = el('div', { parent: btn, text: spec.label });
    top.style.cssText = 'font-weight:bold;';
    const sub = el('div', { parent: btn, text: spec.sub });
    sub.style.cssText = 'font-size:0.7rem;color:rgba(220,210,255,0.6);letter-spacing:0.06em;font-weight:normal;';
    btn.addEventListener('click', spec.onClick);
  }
}

/**
 * Build the AnnouncedSigner payload the controller PWA sends on pair.
 * Sources the pubkey from state.session, the name from the cached
 * profile or the guest record, the npub via bech32, and the method
 * from the wrapped signer (mapped to the protocol's enum).
 */
function buildAnnouncedSigner(state: GameState): import('./controller-mobile.js').AnnouncedSigner | null {
  const session = state.session;
  if (!session) return null;
  const guest = getGuestRecord();
  const isGuest = guest?.pubkey === session.pubkey;
  const profile = getCachedProfile(session.pubkey);
  // Name precedence (so a bunker for "thecryptodonkey" shows up as
  // "The Crypto Donkey" even before the kind 0 fetch lands on the
  // pad):
  //   1. guest record name (when this IS the guest identity)
  //   2. cached kind 0 display_name / name
  //   3. SignetSession.displayName — the SDK fills this in from the
  //      bunker / amber / signet handshake metadata
  //   4. 8-hex fallback (bestName's terminal case)
  const profileName = bestName(profile, session.pubkey);
  const profileLooksLikeFallback = /^[0-9A-F]{8}$/.test(profileName);
  const rawName = isGuest && guest
    ? guest.name
    : (profileLooksLikeFallback && session.displayName ? session.displayName : profileName);
  const name = rawName.length > 64 ? rawName.slice(0, 64) : rawName;
  let npub: string | undefined;
  try { npub = encodeNpub(session.pubkey); } catch { /* leave undefined */ }
  const signerMethod = (session.signer as { method?: string } | null)?.method;
  const method: import('./controller-mobile.js').AnnouncedSigner['method'] =
    isGuest ? 'guest'
    : signerMethod === 'nip07'    ? 'nip07'
    : signerMethod === 'bunker'   ? 'bunker'
    : signerMethod === 'nsec'     ? 'nsec'
    : signerMethod === 'amber'    ? 'amber'
    : signerMethod === 'redirect' || signerMethod === 'signet' ? 'redirect'
    : 'unknown';
  const caps = {
    canSignEvents: true,
    hasNip44: Boolean((session.signer as { nip44?: unknown } | null)?.nip44),
  };
  return {
    pubkey: session.pubkey,
    ...(npub ? { npub } : {}),
    ...(name ? { name } : {}),
    method,
    caps,
  };
}

/** Describe a SignetSession's signing method for the IDENTITY card. */
function describeMethod(session: { signer?: { method?: string } | null } | null): string {
  const m = session?.signer?.method;
  if (!m) return 'NOSTR';
  if (m === 'nip07') return 'BROWSER EXTENSION';
  if (m === 'bunker') return 'BUNKER (NIP-46)';
  if (m === 'nsec') return 'PASTED NSEC';
  if (m === 'amber') return 'AMBER';
  if (m === 'redirect' || m === 'signet') return 'SIGNET';
  return m.toUpperCase();
}

/**
 * Guest sign-in flow for the controller PWA: full-screen overlay with
 * the arcade name picker. On submit, provisions a local keypair via
 * loadOrCreateGuest and sets state.session. Pre-checked "follow
 * Pallasite" stays as the default, mirroring the host flow.
 */
function startControllerGuestFlow(state: GameState, refresh: () => void): void {
  const modal = el('div', { parent: root });
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(2,5,13,0.95);display:flex;align-items:center;justify-content:center;z-index:1000;padding:18px;overflow-y:auto;';
  const inner = el('div', { parent: modal });
  inner.style.cssText = 'background:#02050d;border:1px solid rgba(255,140,200,0.45);border-radius:14px;padding:22px;max-width:520px;width:100%;display:flex;flex-direction:column;gap:14px;font-family:ui-monospace,monospace;box-shadow:0 0 36px rgba(255,140,200,0.18);';

  const title = el('h2', { parent: inner, text: 'PLAY AS GUEST' });
  title.style.cssText = 'margin:0;font-size:1rem;letter-spacing:0.2em;color:#ffacd5;text-align:center;';
  const sub = el('p', { parent: inner, text: 'A fresh local keypair lives only on this phone. Back it up later via EXPORT KEYS.' });
  sub.style.cssText = 'margin:0;font-size:0.78rem;color:rgba(220,210,255,0.7);line-height:1.5;text-align:center;';

  const close = (): void => { modal.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.code === 'Escape') close(); };
  window.addEventListener('keydown', onKey);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const status = el('div', { parent: inner });
  status.style.cssText = 'min-height:1.2em;font-size:0.78rem;color:rgba(220,210,255,0.7);text-align:center;';

  let followPallasite = true;
  const followRow = el('label', { parent: inner });
  followRow.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.78rem;color:rgba(220,210,255,0.75);justify-content:center;cursor:pointer;';
  const followBox = el('input', { parent: followRow, attrs: { type: 'checkbox' } }) as HTMLInputElement;
  followBox.checked = true;
  followBox.addEventListener('change', () => { followPallasite = followBox.checked; });
  el('span', { parent: followRow, text: 'Follow Pallasite (kind 3) on signup' });

  let creating = false;
  const submit = async (name: string): Promise<void> => {
    if (creating) return;
    creating = true;
    status.textContent = 'Creating your identity…';
    status.style.color = 'rgba(180,140,255,0.85)';
    try {
      const sess = await auth.createGuestSession(name.trim() || 'Anonymous', { followPallasite });
      state.session = sess;
      close();
      refresh();
    } catch (err) {
      status.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
      status.style.color = '#ff5050';
      creating = false;
    }
  };

  renderArcadeName(inner, {
    maxLen: 25,
    onSubmit: (name) => { void submit(name); },
  });

  const cancelRow = el('div', { parent: inner });
  cancelRow.style.cssText = 'display:flex;justify-content:center;margin-top:6px;';
  const cancelBtn = el('button', { parent: cancelRow, text: 'CANCEL' }) as HTMLButtonElement;
  cancelBtn.style.cssText = 'padding:8px 18px;background:transparent;border:1px solid rgba(220,210,255,0.3);color:rgba(220,210,255,0.75);border-radius:6px;font-family:ui-monospace,monospace;font-size:0.78rem;letter-spacing:0.14em;cursor:pointer;';
  cancelBtn.addEventListener('click', close);
}

/** Home page shown on mobile.pallasite.app when there's no pairing
 *  token in the URL. Lets the user scan a QR (BarcodeDetector when
 *  available, falls back to manual code entry) or type the 8-character
 *  pairing code from the big screen. On success, navigates to
 *  /?s=<code> which the route handler bounces back into
 *  renderControllerPage as the gamepad. */
function renderControllerHomePage(state: GameState): void {
  clearOverlay();
  // Portrait OR landscape — the home page is just a card; we don't
  // need the rotate-device lockdown here.
  document.documentElement.style.height = '';
  document.documentElement.style.overflow = '';
  // Pad against the iPhone notch + side-rails. max() guarantees a
  // minimum padding so the content still has breathing room when there
  // ARE no safe-area insets (regular browsers). Portrait notch lives
  // top; landscape notch lives left or right depending on orientation.
  document.body.style.cssText = 'background:#02050d;color:rgba(220,210,255,0.9);font-family:ui-monospace,monospace;margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding-top:max(24px, env(safe-area-inset-top));padding-bottom:max(24px, env(safe-area-inset-bottom));padding-left:max(16px, env(safe-area-inset-left));padding-right:max(16px, env(safe-area-inset-right));';
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

  // ── Identity card ──────────────────────────────────────────────────
  // Phone-as-signer step 1: surface a sign-in entry point on the
  // controller home page so the pad can carry the user's identity
  // independent of any specific game. Method-first ordering — BTC
  // Prague-style nostr users see bunker / nsec / extension first;
  // Signet sits as one option among others, not the headline.
  renderControllerIdentityCard(overlay, state);

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

  // ── QR scanner — works on every browser via jsQR (pure JS decoder).
  //    Live video on cameras that support getUserMedia, file-upload
  //    fallback (snap a photo, decode the image) where camera access
  //    is denied or unsupported.
  const tryParse = (raw: string): string | null => {
    try {
      const u = new URL(raw);
      const s = u.searchParams.get('s');
      if (s) return normalise(s);
    } catch { /* not a URL — try as plain code */ }
    return normalise(raw);
  };

  const scanCard = el('div', { parent: overlay });
  scanCard.style.cssText = 'border:1px solid rgba(184,144,255,0.35);border-radius:12px;padding:18px;background:rgba(120,90,200,0.06);display:flex;flex-direction:column;gap:12px;align-items:stretch;';
  const scanLabel = el('div', { parent: scanCard, text: 'OR SCAN QR CODE' });
  scanLabel.style.cssText = 'font-size:0.85rem;letter-spacing:0.18em;color:rgba(184,144,255,0.9);text-align:center;';
  const scanRow = el('div', { parent: scanCard });
  scanRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';
  const scanBtn = el('button', { parent: scanRow, text: '📷  CAMERA' }) as HTMLButtonElement;
  scanBtn.style.cssText = 'flex:1;min-width:140px;background:rgba(184,144,255,0.18);border:2px solid rgba(184,144,255,0.6);color:#cbb6ff;border-radius:10px;padding:16px;font-size:1rem;letter-spacing:0.16em;font-weight:bold;cursor:pointer;font-family:ui-monospace,monospace;';
  // File-upload fallback — picks/takes a photo, we decode with jsQR.
  // Works on every browser (including older iOS) and doesn't require
  // an always-on camera stream.
  const fileBtn = el('button', { parent: scanRow, text: '🖼  FILE' }) as HTMLButtonElement;
  fileBtn.style.cssText = 'flex:1;min-width:140px;background:rgba(220,210,255,0.08);border:2px solid rgba(184,144,255,0.4);color:rgba(220,210,255,0.85);border-radius:10px;padding:16px;font-size:0.95rem;letter-spacing:0.14em;cursor:pointer;font-family:ui-monospace,monospace;';
  const fileInput = el('input', { parent: scanCard, attrs: { type: 'file', accept: 'image/*' } }) as HTMLInputElement;
  fileInput.setAttribute('capture', 'environment');
  fileInput.style.display = 'none';

  const scanHost = el('div', { parent: scanCard });
  scanHost.style.cssText = 'display:none;flex-direction:column;gap:10px;align-items:stretch;';
  const video = el('video', { parent: scanHost }) as HTMLVideoElement;
  video.style.cssText = 'width:100%;max-height:48vh;border-radius:8px;background:#000;object-fit:cover;';
  video.playsInline = true;
  video.muted = true;
  const scanStatus = el('p', { parent: scanHost });
  scanStatus.style.cssText = 'margin:0;font-size:0.8rem;color:rgba(220,210,255,0.75);text-align:center;letter-spacing:0.08em;';
  scanStatus.textContent = 'Point at the QR on the big screen';
  const stopBtn = el('button', { parent: scanHost, text: 'CANCEL' }) as HTMLButtonElement;
  stopBtn.style.cssText = 'background:rgba(255,255,255,0.06);border:1px solid rgba(220,210,255,0.3);color:rgba(220,210,255,0.85);border-radius:8px;padding:10px 12px;font-size:0.85rem;letter-spacing:0.12em;cursor:pointer;font-family:ui-monospace,monospace;';

  let stream: MediaStream | null = null;
  let scanRaf: number | null = null;
  let jsQRLib: typeof import('jsqr').default | null = null;

  const loadJsQR = async (): Promise<typeof import('jsqr').default> => {
    if (jsQRLib) return jsQRLib;
    const mod = await import('jsqr');
    jsQRLib = mod.default;
    return jsQRLib;
  };

  const stopScan = (): void => {
    if (scanRaf !== null) { cancelAnimationFrame(scanRaf); scanRaf = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    // Belt-and-braces release the video element so iOS Safari doesn't
    // keep the camera indicator hot — track.stop() is the contractual
    // cure but iOS occasionally needs srcObject=null + pause() to
    // actually drop the MediaStream reference.
    try { video.pause(); } catch { /* ignore */ }
    try { video.srcObject = null; } catch { /* ignore */ }
    scanHost.style.display = 'none';
    scanRow.style.display = 'flex';
    scanBtn.disabled = false;
    scanStatus.textContent = 'Point at the QR on the big screen';
    scanStatus.style.color = 'rgba(220,210,255,0.75)';
  };

  const handleResult = (raw: string): boolean => {
    const code = tryParse(raw);
    if (!code) return false;
    scanStatus.textContent = 'Got it — pairing…';
    stopScan();
    window.location.assign(`/?s=${code}`);
    return true;
  };

  const startCameraScan = async (): Promise<void> => {
    scanBtn.disabled = true;
    setError(null);
    let jsQR: typeof import('jsqr').default;
    try { jsQR = await loadJsQR(); } catch {
      scanBtn.disabled = false;
      setError('QR library failed to load — use FILE or type the code.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      scanBtn.disabled = false;
      setError('This browser has no camera API — use FILE or type the code.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      scanBtn.disabled = false;
      setError(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Camera permission denied — use FILE or type the code.'
        : 'Could not open the camera — use FILE or type the code.');
      return;
    }
    scanRow.style.display = 'none';
    scanHost.style.display = 'flex';
    video.srcObject = stream;
    try { await video.play(); } catch { /* ignore */ }
    // Downscale phone-camera frames to ~640px wide before running
    // jsQR. Modern phones deliver 1080p+ video which decodes ~5x
    // slower per frame than the 640px scale that gives reliable QR
    // detection. Cuts per-tick CPU from ~80ms to ~16ms on a mid-range
    // Android, which is the difference between "scans instantly" and
    // "video is on but seems stuck".
    const SCAN_TARGET_W = 640;
    const canvas = document.createElement('canvas');
    const cctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!cctx) return;
    const scanStart = Date.now();
    let lastStatusTick = scanStart;
    const tick = (): void => {
      if (!stream) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        // Maintain aspect ratio so QRs near the frame edge aren't
        // squished. Scale to target width; height follows.
        const aspect = video.videoHeight / video.videoWidth;
        const w = Math.min(SCAN_TARGET_W, video.videoWidth);
        const h = Math.round(w * aspect);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        cctx.drawImage(video, 0, 0, w, h);
        try {
          const data = cctx.getImageData(0, 0, w, h);
          // attemptBoth covers light-on-dark QRs (e.g. an inverted
          // screen, a dark-mode browser rendering the QR) on top of
          // the standard dark-on-light path. Roughly 2x per-frame
          // cost vs dontInvert, but the downscale above absorbs it.
          const found = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
          if (found && handleResult(found.data)) return;
        } catch { /* keep scanning */ }
      }
      // After 8s of unsuccessful scanning, soften the status text to
      // a hint pointing at the type-the-code fallback. Avoids the
      // dead "Point at the QR" line lingering forever when the
      // camera is on but the QR isn't readable.
      const now = Date.now();
      if (now - scanStart > 8_000 && now - lastStatusTick > 1_000) {
        scanStatus.textContent = 'Still scanning… if it won\'t latch, tap CANCEL and type the 8-character code below.';
        scanStatus.style.color = 'rgba(255,216,74,0.85)';
        lastStatusTick = now;
      }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  };

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    let jsQR: typeof import('jsqr').default;
    try { jsQR = await loadJsQR(); } catch {
      setError('QR library failed to load.');
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    try { await img.decode(); } catch {
      URL.revokeObjectURL(url);
      setError('Could not read that image.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cctx = canvas.getContext('2d');
    if (!cctx) { URL.revokeObjectURL(url); return; }
    cctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    let data: ImageData;
    try { data = cctx.getImageData(0, 0, canvas.width, canvas.height); }
    catch { setError('Could not read image data.'); return; }
    const found = jsQR(data.data, data.width, data.height);
    if (!found || !handleResult(found.data)) {
      setError('No QR code found in that photo — try again or type the code.');
    }
  };

  scanBtn.addEventListener('click', () => { void startCameraScan(); });
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = '';
  });
  stopBtn.addEventListener('click', stopScan);

  // ── Add-to-Home-Screen install ──────────────────────────────────────
  // iOS has no programmatic install — show a banner with manual
  // instructions on first visit. Android Chrome fires
  // beforeinstallprompt — capture + expose an INSTALL button.
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  if (!isStandalone) {
    const seenKey = 'pall:a2hs:seen';
    const seen = localStorage.getItem(seenKey) === '1';
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) && !/Android/.test(ua);
    const a2hsCard = el('div', { parent: overlay });
    a2hsCard.style.cssText = `border:1px solid rgba(140,255,180,0.3);border-radius:10px;padding:12px 14px;background:rgba(60,200,140,0.05);display:${seen ? 'none' : 'flex'};flex-direction:column;gap:8px;font-size:0.8rem;color:rgba(220,210,255,0.85);line-height:1.5;`;
    const a2hsTitle = el('div', { parent: a2hsCard, text: '📲 INSTALL AS APP' });
    a2hsTitle.style.cssText = 'font-size:0.78rem;letter-spacing:0.16em;color:rgba(140,255,180,0.95);';
    const a2hsBody = el('div', { parent: a2hsCard });
    a2hsBody.style.fontSize = '0.78rem';
    a2hsBody.innerHTML = isIOS
      ? 'Tap the <strong>share icon</strong> in Safari and choose <strong>Add to Home Screen</strong> — opens straight into the controller.'
      : 'Tap the <strong>⋮ menu</strong> in your browser and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.';
    const a2hsRow = el('div', { parent: a2hsCard });
    a2hsRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';
    let installPromptDeferred: { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> } | null = null;
    const installBtn = el('button', { parent: a2hsRow, text: 'INSTALL' }) as HTMLButtonElement;
    installBtn.style.cssText = 'background:rgba(140,255,180,0.18);border:1px solid rgba(140,255,180,0.5);color:#8cffb4;border-radius:6px;padding:8px 14px;font-size:0.78rem;letter-spacing:0.12em;cursor:pointer;font-family:ui-monospace,monospace;display:none;';
    installBtn.addEventListener('click', () => {
      if (!installPromptDeferred) return;
      installBtn.disabled = true;
      void installPromptDeferred.prompt();
      void installPromptDeferred.userChoice.then(() => { installPromptDeferred = null; });
    });
    const dismissBtn = el('button', { parent: a2hsRow, text: 'DISMISS' }) as HTMLButtonElement;
    dismissBtn.style.cssText = 'background:transparent;border:1px solid rgba(220,210,255,0.25);color:rgba(220,210,255,0.65);border-radius:6px;padding:8px 14px;font-size:0.78rem;letter-spacing:0.12em;cursor:pointer;font-family:ui-monospace,monospace;';
    dismissBtn.addEventListener('click', () => {
      localStorage.setItem(seenKey, '1');
      a2hsCard.style.display = 'none';
    });
    // Capture Android Chrome's beforeinstallprompt so we can fire it
    // from the INSTALL button (the spec requires user-gesture trigger).
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPromptDeferred = e as unknown as typeof installPromptDeferred;
      if (installPromptDeferred) installBtn.style.display = '';
    });
  }
}

export function renderControllerPage(state: GameState): void {
  // If the URL doesn't carry a pairing token, render the home page
  // instead (scan QR / enter code). Once the user pairs we navigate
  // to ?s=<code> and re-enter this function, this time taking the
  // gamepad branch below.
  const url = new URL(window.location.href);
  if (!url.searchParams.get('s')) {
    renderControllerHomePage(state);
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
  // Safe-area-inset padding so the joystick + face cluster sit inside
  // the iPhone notch / home indicator zone in landscape (the notch is
  // on the LEFT or RIGHT depending on orientation — env(safe-area-
  // inset-left) tracks whichever is active). box-sizing:border-box
  // lets the padding eat into the 100vw/100vh box.
  overlay.style.cssText = 'padding-top:max(8px, env(safe-area-inset-top));padding-bottom:max(8px, env(safe-area-inset-bottom));padding-left:max(8px, env(safe-area-inset-left));padding-right:max(8px, env(safe-area-inset-right));margin:0;max-width:none;width:100vw;height:100vh;display:flex;flex-direction:column;overflow:hidden;position:relative;box-sizing:border-box;';

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
  titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 10px;font-size:0.78rem;color:rgba(220,210,255,0.85);letter-spacing:0.14em;height:22px;flex-shrink:0;z-index:5;gap:10px;';
  const gameNameChip = el('span', { parent: titleBar, text: 'CONTROLLER' });
  // Right cluster: status + battery + network. Status takes precedence
  // for colour (paired green vs reconnecting orange); battery + net are
  // muted-grey so they sit under the status visually.
  const rightCluster = el('span', { parent: titleBar });
  rightCluster.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const batteryChip = el('span', { parent: rightCluster });
  batteryChip.style.cssText = 'color:rgba(220,210,255,0.55);font-size:0.7rem;font-family:monospace;';
  batteryChip.textContent = '';
  const netChip = el('span', { parent: rightCluster });
  netChip.style.cssText = 'color:rgba(180,140,255,0.55);font-size:0.7rem;font-family:monospace;';
  netChip.textContent = '';
  const statusChip = el('span', { parent: rightCluster });
  statusChip.style.cssText = 'color:rgba(255,216,74,0.85);font-size:0.7rem;';
  statusChip.textContent = '…';

  // Battery API — Android Chrome only; Safari + Firefox have removed
  // it. Updates on level/charging changes. Silently no-ops elsewhere.
  void (async () => {
    type BatteryManager = { level: number; charging: boolean; addEventListener: (ev: string, cb: () => void) => void };
    type WithBattery = { getBattery?: () => Promise<BatteryManager> };
    const nav = navigator as unknown as WithBattery;
    if (typeof nav.getBattery !== 'function') return;
    let bm: BatteryManager;
    try { bm = await nav.getBattery(); } catch { return; }
    const paint = (): void => {
      const pct = Math.round(bm.level * 100);
      batteryChip.textContent = `${bm.charging ? '⚡' : '🔋'} ${pct}%`;
      if (pct <= 15 && !bm.charging) batteryChip.style.color = 'rgba(255,120,120,0.85)';
      else batteryChip.style.color = 'rgba(220,210,255,0.55)';
    };
    paint();
    bm.addEventListener('levelchange', paint);
    bm.addEventListener('chargingchange', paint);
  })();

  // Network Information API — Chromium-only. Surfaces effectiveType
  // ('4g' / '3g' / 'slow-2g') + downlink so users can see when a
  // congested link explains laggy input.
  void (() => {
    type NetInfo = { effectiveType?: string; downlink?: number; addEventListener?: (ev: string, cb: () => void) => void };
    type WithConnection = { connection?: NetInfo };
    const nav = navigator as unknown as WithConnection;
    const info = nav.connection;
    if (!info) return;
    const paint = (): void => {
      const et = info.effectiveType ?? '';
      const dl = info.downlink ? `${info.downlink}Mb` : '';
      netChip.textContent = et ? `${et.toUpperCase()}${dl ? ' · ' + dl : ''}` : '';
    };
    paint();
    info.addEventListener?.('change', paint);
  })();

  // Screen Wake Lock — keep the phone screen on while paired so the
  // controller doesn't suspend mid-run. Re-acquires on visibility
  // change because the lock auto-releases when the tab backgrounds.
  void (async () => {
    type WakeLockSentinel = { release: () => Promise<void> };
    type WithWakeLock = { wakeLock?: { request: (kind: 'screen') => Promise<WakeLockSentinel> } };
    const nav = navigator as unknown as WithWakeLock;
    if (!nav.wakeLock) return;
    let sentinel: WakeLockSentinel | null = null;
    const acquire = async (): Promise<void> => {
      try { sentinel = await nav.wakeLock!.request('screen'); } catch { /* ignore */ }
    };
    await acquire();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire();
    });
  })();

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

  // Mirrors the in-game touch.ts cluster the user said feels right:
  // FIRE is a big horizontal rounded-rect across the bottom-right,
  // WARP + SHIELD sit as smaller pills above it side-by-side, PAUSE
  // tucks into the top-right corner. Joystick anchors bottom-left
  // (smaller than the face cluster — player preference: dominant
  // FIRE button, lean joystick).
  const SHOULDER_W = 'clamp(74px, 22vh, 110px)';
  const SHOULDER_H = 'clamp(48px, 14vh, 70px)';
  // FIRE (A) — the big wide one. Bottom-right edge.
  const FIRE_W = 'clamp(220px, 28vw, 320px)';
  const FIRE_H = 'clamp(88px, 24vh, 116px)';
  // SHIELD / WARP — the smaller pills above FIRE.
  const SEC_W  = 'clamp(110px, 16vw, 168px)';
  const SEC_H  = 'clamp(64px, 18vh, 92px)';
  // PAUSE (Y) — tucks in the top-right; small and easy to tap.
  const SYS_W = 'clamp(76px, 14vh, 96px)';
  const SYS_H = 'clamp(40px, 10vh, 54px)';

  // Shoulders + start/select stay in the spec for non-Pallasite games
  // but Pallasite hides them. Positions kept tight to the corners so
  // they don't clash with the face cluster when a game does use them.
  makeButton('L1', `top:8px;left:8px;width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('L2', `top:8px;left:calc(16px + ${SHOULDER_W});width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('R2', `top:calc(16px + ${SYS_H});right:8px;width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('R1', `top:calc(16px + ${SYS_H} + 12px + ${SHOULDER_H});right:8px;width:${SHOULDER_W};height:${SHOULDER_H};border-radius:14px;font-size:1rem;`);
  makeButton('select', `top:14px;left:calc(50% - ${SYS_W} - 4px);width:${SYS_W};height:${SYS_H};border-radius:14px;font-size:0.78rem;`);

  // Face cluster — vertically centred on the right thumb edge. Phone
  // cases eat the bottom 30-50px of the screen so a bottom-anchored
  // cluster forces thumb-reach down past the case lip. Centring on
  // top:50% puts the cluster squarely in the thumb's natural sweep.
  //
  //   [Y]                ← PAUSE (small, top of the column)
  //   [X] [B]            ← WARP + SHIELD pills
  //   [    A    ]        ← FIRE wide pill
  //
  // Wrapped in a flex column anchored to right:14px with translateY
  // to perfectly centre. Buttons are flex children (position:static)
  // so the column auto-sizes around them.
  const faceWrap = el('div', { parent: surface });
  faceWrap.style.cssText = 'position:absolute;top:50%;right:14px;transform:translateY(-50%);display:flex;flex-direction:column;align-items:flex-end;gap:10px;pointer-events:none;';
  const secRow = el('div', { parent: faceWrap });
  secRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

  const reparent = (slot: string, parent: HTMLElement): void => {
    const btn = slotEls.get(slot);
    if (btn) parent.appendChild(btn);  // moves from `surface` to the flex parent
  };
  makeButton('Y', `position:static;width:${SYS_W};height:${SYS_H};border-radius:14px;font-size:0.85rem;pointer-events:auto;`);
  makeButton('X', `position:static;width:${SEC_W};height:${SEC_H};border-radius:calc(${SEC_H} / 2);font-size:1rem;pointer-events:auto;`);
  makeButton('B', `position:static;width:${SEC_W};height:${SEC_H};border-radius:calc(${SEC_H} / 2);font-size:1rem;pointer-events:auto;`);
  makeButton('A', `position:static;width:${FIRE_W};height:${FIRE_H};border-radius:calc(${FIRE_H} / 2);font-size:1.1rem;pointer-events:auto;`);
  reparent('Y', faceWrap);
  reparent('X', secRow);
  reparent('B', secRow);
  reparent('A', faceWrap);
  // `start` stays in the top centre — not used by Pallasite but
  // available to other specs that want a system button surface.
  makeButton('start', `top:8px;right:calc(50% - ${SYS_W} / 2);width:${SYS_W};height:${SYS_H};border-radius:14px;font-size:0.78rem;`);

  // ── Joystick (left thumb) — anchored bottom-left, sized to match
  //    the face cluster so left and right thumb work in symmetry.
  // Joystick responsiveness — lower deadzone (was 0.18, now 0.10) so a
  // small thumb deflection already starts steering. Heading sample
  // rate up from 20Hz to 33Hz for less perceived lag. Pad radius
  // reaches max at 60% of pad-pixels (was 70%), so smaller drags hit
  // full deflection.
  const JOY_HEADING_DEADZONE = 0.10;
  const JOY_THRUST_THRESHOLD = 0.45;
  const JOY_TAP_TIME_MS = 220;
  const JOY_TAP_MOVE_PX = 8;
  const HEADING_SAMPLE_MS = 30;
  const JOY_RADIUS_SCALE = 0.6;
  // Joystick is smaller than face cluster — feedback was that the
  // joystick dominated the screen. Capped tighter and hugged closer
  // to the left edge.
  const JOY_SIZE = 'clamp(170px, 48vh, 240px)';

  const pad = el('div', { parent: surface });
  // Vertically centred on the left thumb edge — bottom-anchored
  // joysticks were unreachable past the phone case lip on most phones.
  pad.style.cssText = `position:absolute;left:14px;top:50%;transform:translateY(-50%);width:${JOY_SIZE};height:${JOY_SIZE};border-radius:50%;background:radial-gradient(circle, rgba(140,255,180,0.10) 0%, rgba(140,255,180,0.04) 60%, rgba(140,255,180,0) 100%);border:2px solid rgba(140,255,180,0.35);touch-action:none;-webkit-tap-highlight-color:transparent;display:none;`;
  const knob = el('div', { parent: pad });
  knob.style.cssText = 'position:absolute;left:50%;top:50%;width:38%;height:38%;margin:-19% 0 0 -19%;border-radius:50%;background:radial-gradient(circle, rgba(140,255,180,0.45) 0%, rgba(91,255,140,0.18) 70%);border:2px solid rgba(140,255,180,0.75);box-shadow:0 0 18px rgba(140,255,180,0.4);transform:translate(0,0);transition:transform 60ms ease-out;';
  slotEls.set('joyL', pad);

  // ── D-pad (left thumb, menu mode) — replaces the joystick when the
  //    host signals a menu/initials phase. Cross-shaped, sized to fit
  //    inside the joystick's footprint so swapping in/out doesn't
  //    reflow the left thumb area.
  const DPAD_BTN = 'clamp(58px, 13vh, 84px)';
  // Offset from the joystick centre — buttons sit 1.05× their own
  // width away so the cross gap is ~5% of a button.
  const DPAD_OFFSET = 'clamp(64px, 14vh, 90px)';
  const DPAD_CENTRE_X = `calc(14px + ${JOY_SIZE} / 2)`;
  // dpad arrows are big — keep label hidden, lean on the icon.
  makeButton('dpadU', `left:calc(${DPAD_CENTRE_X} - ${DPAD_BTN} / 2);top:calc(50% - ${DPAD_OFFSET} - ${DPAD_BTN} / 2);width:${DPAD_BTN};height:${DPAD_BTN};border-radius:18px;font-size:1.8rem;`);
  makeButton('dpadD', `left:calc(${DPAD_CENTRE_X} - ${DPAD_BTN} / 2);top:calc(50% + ${DPAD_OFFSET} - ${DPAD_BTN} / 2);width:${DPAD_BTN};height:${DPAD_BTN};border-radius:18px;font-size:1.8rem;`);
  makeButton('dpadL', `left:calc(${DPAD_CENTRE_X} - ${DPAD_OFFSET} - ${DPAD_BTN} / 2);top:calc(50% - ${DPAD_BTN} / 2);width:${DPAD_BTN};height:${DPAD_BTN};border-radius:18px;font-size:1.8rem;`);
  makeButton('dpadR', `left:calc(${DPAD_CENTRE_X} + ${DPAD_OFFSET} - ${DPAD_BTN} / 2);top:calc(50% - ${DPAD_BTN} / 2);width:${DPAD_BTN};height:${DPAD_BTN};border-radius:18px;font-size:1.8rem;`);

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
        // Per-slot sizing — FIRE (A) is the dominant horizontal pill,
        // SHIELD/WARP (B/X) are smaller pills above it, PAUSE (Y) is
        // a top-corner pill. Shoulders + system buttons stay neutral.
        let iconSize: string;
        let labelSize: string;
        let layout: 'col' | 'row' = 'col';
        switch (slot) {
          case 'A':                iconSize = '1.9rem'; labelSize = '0.9rem'; layout = 'row'; break;
          case 'B': case 'X':      iconSize = '1.5rem'; labelSize = '0.72rem'; layout = 'row'; break;
          case 'Y':                iconSize = '1.05rem'; labelSize = '0.62rem'; layout = 'row'; break;
          case 'start': case 'select': iconSize = '1rem'; labelSize = '0.6rem'; break;
          default:                 iconSize = '1.3rem'; labelSize = '0.65rem'; break;
        }
        inner.style.flexDirection = layout === 'row' ? 'row' : 'column';
        inner.style.gap = layout === 'row' ? '10px' : '2px';
        if (cfg.icon) {
          const ic = el('span', { parent: inner, text: cfg.icon });
          ic.style.cssText = `font-size:${iconSize};line-height:1;`;
        }
        if (cfg.label) {
          const lb = el('span', { parent: inner, text: cfg.label });
          lb.style.cssText = `font-size:${labelSize};letter-spacing:0.14em;color:${colour};font-weight:bold;`;
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
    // Announce the local identity (if any) to the host on pair. The
    // host's onSigner callback receives this and uses the announce to
    // build a RemoteControllerSigner — every host signEvent then
    // round-trips back here via onSignRequest.
    if (state.session) {
      client.announceSigner(buildAnnouncedSigner(state));
      // The profile fetch is async, so the initial announce above can
      // carry a placeholder name (8-hex stub or SDK displayName). Once
      // kind 0 lands, re-announce so the host swaps its banner to the
      // real name. Cheap idempotent re-send — the host's onSigner
      // change-detection skips if the pubkey hasn't moved unless
      // name/method changed (which they have now).
      const sigPubkey = state.session.pubkey;
      void fetchProfile(sigPubkey).then(p => {
        if (!p) return;
        if (state.session?.pubkey !== sigPubkey) return;
        state.profile = p;
        client?.announceSigner(buildAnnouncedSigner(state));
      });
    }
    // Fulfil host sign-requests via the phone's local session signer.
    // The phone's signer is already wrapped through the global sign-
    // queue (auth.ts wrapSession) so concurrent requests from the host
    // serialise here, not on the bunker / extension. signRequestHandler
    // returns the signed event the host marshals as a sign-response.
    // If state.session goes away (user signs out on the pad mid-pair),
    // the handler resolves to a 'no-signer' error which the host
    // surfaces as sign-failed.
    client.onSignRequest(async (template) => {
      const sess = state.session;
      if (!sess) throw new Error('no-signer');
      const signed = await sess.signer.signEvent({
        kind: template.kind,
        content: template.content,
        ...(template.tags ? { tags: template.tags } : {}),
        ...(template.created_at !== undefined ? { created_at: template.created_at } : {}),
      });
      return signed as unknown as import('./controller-types.js').RemoteSignedEvent;
    });
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
    // Soft thump when thrust engages — gives the player tactile
    // confirmation past the deadzone threshold. Skipping the
    // disengagement vibration keeps the buzz from chattering on
    // the deadzone boundary.
    if (on && typeof navigator.vibrate === 'function') {
      try { navigator.vibrate(10); } catch { /* ignore */ }
    }
    client?.sendInput('joyL-thrust', on ? '1' : '0');
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    joyActive = true;
    const rect = pad.getBoundingClientRect();
    joyOriginX = rect.left + rect.width / 2;
    joyOriginY = rect.top + rect.height / 2;
    joyMaxRadius = (rect.width / 2) * JOY_RADIUS_SCALE;
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
      // Tap-fire haptic — mirrors the A/FIRE button's 18ms thump so a
      // quick joystick tap feels the same as pressing FIRE.
      if (typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(18); } catch { /* ignore */ }
      }
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
  // Vibration intensity per slot type. navigator.vibrate is widely
  // supported on Android Chrome / Firefox; iOS Safari silently no-ops,
  // which is fine — the buttons still work, just without haptics.
  const VIBE_MS: Record<string, number> = {
    A: 18,  // FIRE — primary, slightly heavier so the player feels each shot
    B: 28,  // SHIELD — defensive, distinct heavier thump
    X: 22,  // WARP — escape, mid-thump
    Y: 8,   // PAUSE — light tick
    dpadU: 6, dpadD: 6, dpadL: 6, dpadR: 6,  // d-pad — barely-there ticks for menu nav
  };
  const bindButton = (slot: string): void => {
    const btn = slotEls.get(slot);
    if (!btn || slot === 'joyL') return;
    const press = (e: Event): void => {
      e.preventDefault();
      btn.style.background = 'rgba(255,255,255,0.18)';
      const ms = VIBE_MS[slot];
      if (ms && typeof navigator.vibrate === 'function') {
        try { navigator.vibrate(ms); } catch { /* iOS / unsupported — ignore */ }
      }
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
  for (const slot of ['A', 'B', 'X', 'Y', 'L1', 'L2', 'R1', 'R2', 'start', 'select', 'dpadU', 'dpadD', 'dpadL', 'dpadR']) bindButton(slot);
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
      list.appendChild(renderFlaggedRow(entry, token));
    }
  })();
}

function renderFlaggedRow(entry: FlaggedEntry, token: string): HTMLElement {
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
  // DELETE — publishes a NIP-09 kind 5 deletion from the game pubkey
  // referencing the kind 30762 score event id (and any associated
  // ghost/replay/case events the faucet has on file), and clears the
  // flag from the faucet DB. Only enabled when we have a score event
  // id to delete by — anonymous flags or claim-less rows don't have a
  // canonical thing to point the NIP-09 at.
  const scoreId = entry.claim?.score_event_id ?? null;
  const del = el('button', { className: 'menu-btn secondary', parent: actions, text: 'DELETE' }) as HTMLButtonElement;
  del.style.cssText += 'color:#ffb0b0;border-color:rgba(255,120,120,0.5);';
  if (!scoreId) {
    del.disabled = true;
    del.style.opacity = '0.4';
    del.title = 'No score event id stored — no canonical event to NIP-09 against.';
  } else {
    del.addEventListener('click', () => {
      if (!window.confirm(`Delete this flag and publish NIP-09 kind 5 referencing ${scoreId.slice(0, 12)}…?\n\nThis broadcasts a deletion to all relays. Honest relays will drop the score + ghost + replay events. Cannot be undone.`)) return;
      void (async () => {
        del.disabled = true;
        del.textContent = 'DELETING…';
        const result = await requestDeleteFlag(token, { scoreEventId: scoreId });
        if (result.ok) {
          row.style.opacity = '0.4';
          row.style.pointerEvents = 'none';
          del.textContent = result.deletionEventId
            ? `DELETED · ${result.deletionEventId.slice(0, 8)}…`
            : 'DELETED';
        } else {
          del.disabled = false;
          del.textContent = `FAILED · ${result.error}`;
          setTimeout(() => (del.textContent = 'DELETE'), 2400);
        }
      })();
    });
  }
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

/** Render the rank slider + submit / already-voted panel for a juror
 *  who's eligible to vote on this case. State machine:
 *    idle     → slider + SUBMIT VOTE (default rank 50)
 *    sending  → slider locked + "SUBMITTING…" button
 *    sent     → read-only "✓ VOTE SUBMITTED · rank N" line
 *    failed   → slider unlocked + error text under the button
 *  Already-voted state (from localStorage) skips the slider and renders
 *  the sent panel directly.
 *
 *  Rank semantics: 100 = clearly honest, 50 = uncertain, 0 = clearly
 *  cheating. submitVote enforces 0..100 server-side; the slider mirrors. */
function renderJuryVotePanel(parent: HTMLElement, c: ReviewCase, identity: StoredJuryIdentity): void {
  const panel = el('div', { parent });
  panel.style.cssText = 'border-top:1px dashed rgba(184,144,255,0.25);margin-top:4px;padding-top:8px;display:flex;flex-direction:column;gap:8px;';

  // Already-voted from localStorage — render read-only state, skip slider.
  if (hasVotedOnCase(c.eventId)) {
    const done = el('div', { parent: panel });
    done.style.cssText = 'font-size:0.85rem;color:#a8eecf;letter-spacing:0.06em;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;';
    el('span', { parent: done, text: '✓ VOTE SUBMITTED' });
    const sub = el('span', { parent: done, text: 'Your LSAG ballot is on relays. Verdict aggregates when the case closes.' });
    sub.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.6);letter-spacing:0.04em;';
    return;
  }

  const label = el('div', { parent: panel });
  label.style.cssText = 'font-size:0.85rem;color:#cbb6ff;letter-spacing:0.08em;';
  label.textContent = '✓ YOU ARE IN THIS CIRCLE — CAST AN ANONYMOUS RANK';

  // Slider row: 0 ── (rank value bubble) ── 100 with cheat ↔ honest hints.
  const sliderRow = el('div', { parent: panel });
  sliderRow.style.cssText = 'display:flex;align-items:center;gap:10px;font-family:monospace;font-size:0.78rem;color:rgba(220,210,255,0.7);';
  const minHint = el('span', { parent: sliderRow, text: '0 · CHEAT' });
  minHint.style.cssText = 'color:#ffb0b0;min-width:80px;';
  const slider = el('input', { parent: sliderRow }) as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.value = '50';
  slider.style.cssText = 'flex:1;accent-color:#b890ff;';
  const maxHint = el('span', { parent: sliderRow, text: 'HONEST · 100' });
  maxHint.style.cssText = 'color:#a8eecf;min-width:90px;text-align:right;';

  const liveBubble = el('div', { parent: panel });
  liveBubble.style.cssText = 'font-size:0.8rem;color:rgba(220,210,255,0.85);text-align:center;letter-spacing:0.06em;';
  const renderBubble = (): void => {
    const v = parseInt(slider.value, 10);
    let verdict: string;
    if (v >= 80) verdict = 'CLEARLY HONEST';
    else if (v >= 60) verdict = 'PROBABLY HONEST';
    else if (v >= 40) verdict = 'UNCERTAIN';
    else if (v >= 20) verdict = 'PROBABLY CHEATING';
    else verdict = 'CLEARLY CHEATING';
    liveBubble.textContent = `RANK ${v} · ${verdict}`;
  };
  renderBubble();
  slider.addEventListener('input', renderBubble);

  const actions = el('div', { parent: panel });
  actions.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const submitBtn = el('button', { className: 'menu-btn', parent: actions, text: 'SUBMIT VOTE' }) as HTMLButtonElement;
  submitBtn.style.cssText += 'flex:0 1 200px;';
  const statusLine = el('div', { parent: actions });
  statusLine.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.6);letter-spacing:0.04em;flex:1;min-height:1.2em;';

  submitBtn.addEventListener('click', () => {
    void (async () => {
      const rank = parseInt(slider.value, 10);
      submitBtn.disabled = true;
      slider.disabled = true;
      submitBtn.textContent = 'SUBMITTING…';
      statusLine.textContent = 'Signing LSAG ballot + publishing to relays…';
      statusLine.style.color = 'rgba(255,216,74,0.85)';
      let result: VoteSubmitResult;
      try {
        result = await submitVote({ reviewCase: c, identity, rank });
      } catch (err) {
        result = { ok: false, publishedTo: [], failed: [], error: err instanceof Error ? err.message : 'unknown' };
      }
      if (result.ok) {
        // Replace the whole panel with the sent state.
        panel.innerHTML = '';
        const done = el('div', { parent: panel });
        done.style.cssText = 'font-size:0.85rem;color:#a8eecf;letter-spacing:0.06em;display:flex;flex-direction:column;gap:4px;';
        const head = el('div', { parent: done });
        head.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;';
        el('span', { parent: head, text: '✓ VOTE SUBMITTED' });
        const rankTag = el('span', { parent: head, text: `RANK ${rank}` });
        rankTag.style.cssText = 'font-family:monospace;color:#ffd84a;letter-spacing:0.06em;';
        const meta = el('div', { parent: done });
        meta.style.cssText = 'font-size:0.74rem;color:rgba(220,210,255,0.55);letter-spacing:0.04em;font-family:monospace;';
        const pubCount = result.publishedTo.length;
        const failCount = result.failed.length;
        meta.textContent = `Published to ${pubCount}/${pubCount + failCount} relays · key-image ${(result.keyImage ?? '').slice(0, 12)}…`;
      } else {
        submitBtn.disabled = false;
        slider.disabled = false;
        submitBtn.textContent = 'TRY AGAIN';
        statusLine.style.color = 'rgba(255,120,120,0.9)';
        statusLine.textContent = `Vote failed: ${result.error ?? 'unknown'}`;
      }
    })();
  });
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

  // Eligibility + voting UI for the signed-in juror.
  if (identity) {
    const inCircle = c.circleMembers.includes(identity.pubkey);
    if (!inCircle) {
      const elig = el('div', { parent: row });
      elig.style.cssText = 'font-size:0.78rem;letter-spacing:0.08em;color:rgba(220,210,255,0.45);';
      elig.textContent = '— YOU ARE NOT IN THIS CIRCLE';
    } else {
      renderJuryVotePanel(row, c, identity);
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
/** Module-scoped teardown for the top-3 live mini-tile WS subscriptions.
 *  Tracked here (not in renderWatchPage's closure) so a re-entry into
 *  the watch page or a route-away tears down the previous tiles' WS
 *  connections — otherwise each renderWatchPage call would leak 3+
 *  sockets per visit. */
let watchActiveMiniTeardown: (() => void) | null = null;
/** Module-scoped teardown for the kind 9735 zap aggregator. Same
 *  rationale as watchActiveMiniTeardown — separate so the page can
 *  re-open the zap subscription with a refreshed pubkey set without
 *  tearing down the score-event subscription. */
let watchActiveZapTeardown: (() => void) | null = null;

export function renderWatchPage(state: GameState): void {
  clearOverlay();
  // Tear down any prior subscription before we open a new one — re-entering
  // the page (e.g. via BACK from the theatre) would otherwise leak sockets.
  watchActiveUnsubscribe?.();
  watchActiveUnsubscribe = null;
  watchActiveMiniTeardown?.();
  watchActiveMiniTeardown = null;
  watchActiveZapTeardown?.();
  watchActiveZapTeardown = null;

  // Deep-link router: two URL forms
  //   /#replay=<kind-30764-event-id>  → fetch the rich replay directly
  //   /#score=<kind-30762-score-id>   → fetch the matching kind 30764 via
  //                                     its #e tag, then open the theatre.
  // The score-id form is the SHARE-from-card link: card knows the score
  // event id from the kind 30762 it subscribes to, doesn't need to fetch
  // 30764 before building the URL. Hash is cleared after the theatre
  // opens so a BACK from the theatre lands on the normal grid instead
  // of re-firing the deep-link.
  const scoreMatch = /^#score=([0-9a-f]{64})$/i.exec(window.location.hash);
  const hashMatch = /^#replay=([0-9a-f]{64})$/i.exec(window.location.hash);
  if (scoreMatch) {
    const scoreEventId = scoreMatch[1].toLowerCase();
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
    const overlay = el('div', { className: 'overlay', parent: root });
    setupOverlayArrowNav(overlay);
    el('h2', { parent: overlay, text: 'OPENING REPLAY…' });
    const stat = el('p', { parent: overlay, text: `Fetching kind 30764 via #e=${scoreEventId.slice(0, 8)}…` });
    stat.style.cssText = 'margin:12px auto;font-size:0.85rem;color:rgba(220,210,255,0.7);max-width:560px;text-align:center;';
    void (async () => {
      const rich = await fetchReplayByScoreEventId(scoreEventId).catch(() => null);
      if (rich && rich.frames.length >= 2) {
        renderLiveTheatre({
          masterPubkey: rich.pubkey,
          displayName: shortPubkey(rich.pubkey),
          initialScore: rich.score,
          initialWave: rich.wave,
          runStartedAtMs: Date.now() - rich.durationMs,
          onClose: () => renderWatchPage(state),
          replaySource: {
            frames: rich.frames,
            durationMs: rich.durationMs,
            headerLabel: 'REPLAY · SHARED LINK',
            eventId: rich.eventId,
          },
        });
        return;
      }
      stat.textContent = 'Could not find a kind 30764 replay e-tagged to this score event. Player may not have published yet, or NIP-09 deleted it.';
      stat.style.color = 'rgba(255,120,120,0.85)';
      const back = el('button', { className: 'menu-btn', parent: overlay, text: 'CONTINUE TO WATCH PAGE' });
      back.style.cssText += 'margin:14px auto;display:block;';
      back.addEventListener('click', () => renderWatchPage(state));
    })();
    return;
  }
  if (hashMatch) {
    const replayEventId = hashMatch[1].toLowerCase();
    try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ }
    const overlay = el('div', { className: 'overlay', parent: root });
    setupOverlayArrowNav(overlay);
    el('h2', { parent: overlay, text: 'OPENING REPLAY…' });
    const stat = el('p', { parent: overlay, text: `Fetching kind 30764 ${replayEventId.slice(0, 8)}… from relays.` });
    stat.style.cssText = 'margin:12px auto;font-size:0.85rem;color:rgba(220,210,255,0.7);max-width:560px;text-align:center;';
    void (async () => {
      const rich = await fetchReplayByEventId(replayEventId).catch(() => null);
      if (rich && rich.frames.length >= 2) {
        renderLiveTheatre({
          masterPubkey: rich.pubkey,
          displayName: shortPubkey(rich.pubkey),
          initialScore: rich.score,
          initialWave: rich.wave,
          runStartedAtMs: Date.now() - rich.durationMs,
          onClose: () => renderWatchPage(state),
          replaySource: {
            frames: rich.frames,
            durationMs: rich.durationMs,
            headerLabel: 'REPLAY · SHARED LINK',
            eventId: rich.eventId,
          },
        });
        return;
      }
      stat.textContent = 'Could not find this replay on the relay set. The author may not have published, or it has been deleted via NIP-09.';
      stat.style.color = 'rgba(255,120,120,0.85)';
      const back = el('button', { className: 'menu-btn', parent: overlay, text: 'CONTINUE TO WATCH PAGE' });
      back.style.cssText += 'margin:14px auto;display:block;';
      back.addEventListener('click', () => renderWatchPage(state));
    })();
    return;
  }
  // When the user lands fresh on the watch page (initial navigation, not
  const overlay = el('div', { className: 'overlay', parent: root });
  setupOverlayArrowNav(overlay);

  const header = el('div', { parent: overlay });
  header.style.cssText = 'display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;justify-content:center;margin-bottom:6px;';
  el('h2', { parent: header, text: 'PALLASITE · WATCH' });
  const live = el('span', { parent: header, text: 'LIVE · RECENT RUNS' });
  live.style.cssText = 'font-size:0.72rem;color:rgba(255,216,74,0.85);letter-spacing:0.18em;font-family:monospace;';
  // Live count chip — pulses ship-green when ≥1 player is live so the
  // tab title bar reads "3 LIVE" at a glance.
  const liveCount = el('span', { parent: header, text: '' });
  liveCount.style.cssText = 'display:none;font-size:0.72rem;letter-spacing:0.16em;color:#8cffb4;border:1px solid rgba(140,255,180,0.55);padding:2px 8px;border-radius:3px;font-family:monospace;animation:pallasite-live-pulse 1.6s ease-in-out infinite;';
  const updateLiveCount = (n: number): void => {
    if (n > 0) {
      liveCount.style.display = 'inline-block';
      liveCount.textContent = `${n} LIVE`;
    } else {
      liveCount.style.display = 'none';
    }
  };

  // Tighter intro — the hero tiles now sit directly under the header so
  // the explanation can shrink to a single line. The verbose
  // "Every claimed run lands here as a kind 30762…" copy moved to a
  // <title> tooltip on the page header for the curious.
  const intro = el('p', { parent: overlay });
  intro.style.cssText = 'margin:4px auto 12px;font-size:0.78rem;color:rgba(220,210,255,0.6);max-width:680px;line-height:1.4;text-align:center;letter-spacing:0.04em;';
  intro.innerHTML = 'Click a tile to <strong>WATCH</strong>. ⚡ ZAP the player from any card below.';
  header.title = 'Every claimed run lands as a kind 30762 score event signed by the faucet. Ghosts (kind 30763) and full-world replays (kind 30764) are fetched per-card.';

  const status = el('p', { parent: overlay });
  status.style.cssText = 'margin:0 0 8px;font-size:0.78rem;color:rgba(255,216,74,0.65);letter-spacing:0.08em;min-height:1.2em;text-align:center;';
  status.textContent = 'Connecting to relays…';

  // Per-relay status pills — one chip per relay we tried, coloured by
  // state: green=settled with events, yellow=settled+empty, red=errored,
  // grey=connecting. Event count appears next to the URL host so a
  // spectator can see at a glance which relay actually has data.
  const relayPills = el('div', { parent: overlay });
  relayPills.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:6px;margin:0 auto 14px;max-width:760px;font-family:monospace;font-size:0.68rem;letter-spacing:0.06em;';
  const renderRelayPills = (per: ReadonlyArray<{ url: string; settled: boolean; errored: boolean; events: number }>): void => {
    relayPills.innerHTML = '';
    for (const r of per) {
      const host = (() => { try { return new URL(r.url).host; } catch { return r.url; } })();
      const pill = el('span', { parent: relayPills, text: '' });
      let colour = 'rgba(220,210,255,0.4)';  // connecting
      let glyph = '○';
      if (r.errored) { colour = 'rgba(255,120,120,0.85)'; glyph = '✗'; }
      else if (r.settled && r.events > 0) { colour = '#8cffb4'; glyph = '✓'; }
      else if (r.settled) { colour = 'rgba(255,216,74,0.75)'; glyph = '·'; }
      pill.style.cssText = `border:1px solid ${colour}55;border-radius:3px;padding:2px 7px;color:${colour};background:transparent;`;
      pill.textContent = `${glyph} ${host}${r.events > 0 ? ` ${r.events}` : ''}`;
      pill.title = r.url + (r.errored ? ' — connection error/close' : r.settled ? ' — settled' : ' — connecting…');
    }
  };

  // Filter tabs — LIVE / TODAY / ZAPPED / ALL (+ MINE if signed in).
  // Toggles card visibility client-side based on data-* attributes set
  // in renderEntry. Tabs always render so the user knows the dimension
  // exists; counts update when entries land. ZAPPED also re-sorts the
  // grid by aggregate sats received instead of newest-first.
  type FilterKind = 'live' | 'today' | 'mine' | 'zapped' | 'all';
  let activeFilter: FilterKind = 'all';
  const filterRow = el('div', { parent: overlay });
  filterRow.style.cssText = 'display:flex;justify-content:center;gap:6px;margin:0 auto 12px;max-width:760px;width:100%;flex-wrap:wrap;';
  const filterCounts: Record<FilterKind, HTMLSpanElement> = { live: el('span'), today: el('span'), mine: el('span'), zapped: el('span'), all: el('span') };
  const filterBtns: Record<FilterKind, HTMLButtonElement> = {} as Record<FilterKind, HTMLButtonElement>;
  const FILTER_DEFS: Array<{ k: FilterKind; label: string; visible: boolean }> = [
    { k: 'live', label: 'LIVE', visible: true },
    { k: 'today', label: 'TODAY', visible: true },
    { k: 'zapped', label: '⚡ ZAPPED', visible: true },
    { k: 'mine', label: 'MINE', visible: !!state.session },
    { k: 'all', label: 'ALL', visible: true },
  ];
  const FILTER_COLOUR: Record<FilterKind, string> = {
    live: '#8cffb4',
    today: '#ffd84a',
    zapped: '#ff8a3a',
    mine: '#cbb6ff',
    all: 'rgba(220,210,255,0.85)',
  };
  for (const def of FILTER_DEFS) {
    if (!def.visible) continue;
    const btn = el('button', { className: 'menu-btn secondary', parent: filterRow }) as HTMLButtonElement;
    btn.style.cssText += 'flex:0 0 auto;padding:4px 14px;font-size:0.78rem;letter-spacing:0.16em;';
    btn.innerHTML = '';
    const labelEl = el('span', { parent: btn, text: def.label });
    const countEl = filterCounts[def.k];
    countEl.textContent = '0';
    countEl.style.cssText = 'margin-left:6px;font-size:0.7rem;color:rgba(220,210,255,0.55);font-family:monospace;';
    btn.appendChild(countEl);
    void labelEl;
    btn.addEventListener('click', () => setFilter(def.k));
    filterBtns[def.k] = btn;
  }

  // PERSON filter — narrows the visible cards to a single pubkey (or
  // matching prefix). Accepts:
  //   • a full npub1... bech32 string (decoded to 64-char hex)
  //   • a hex pubkey (full 64 chars or shorter prefix substring)
  // Lives alongside the LIVE/TODAY/MINE/ALL tabs as an orthogonal axis:
  // tabs still gate visibility, person narrows within. Empty input
  // clears the constraint. The clear (✕) chip nulls it without
  // requiring the user to manually empty the field.
  let personFilter = '';  // lowercase hex prefix, possibly empty
  const personRow = el('div', { parent: overlay });
  personRow.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:6px;margin:0 auto 12px;max-width:760px;width:100%;flex-wrap:wrap;';
  const personInput = el('input', { parent: personRow }) as HTMLInputElement;
  personInput.type = 'text';
  personInput.placeholder = 'FILTER BY NPUB OR HEX PUBKEY…';
  personInput.autocomplete = 'off';
  personInput.spellcheck = false;
  personInput.style.cssText = 'flex:1 1 320px;max-width:520px;padding:6px 10px;border:1px solid rgba(220,210,255,0.25);border-radius:4px;background:rgba(2,5,13,0.6);color:rgba(220,210,255,0.92);font-family:monospace;font-size:0.82rem;letter-spacing:0.04em;';
  const personHint = el('span', { parent: personRow, text: '' });
  personHint.style.cssText = 'font-family:monospace;font-size:0.7rem;letter-spacing:0.08em;color:rgba(220,210,255,0.55);min-width:6em;';
  const personClear = el('button', { className: 'menu-btn secondary', parent: personRow, text: '✕' }) as HTMLButtonElement;
  personClear.style.cssText += 'flex:0 0 auto;padding:4px 10px;font-size:0.78rem;display:none;';
  personClear.title = 'Clear person filter';
  const setPersonFilter = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) {
      personFilter = '';
      personHint.textContent = '';
      personClear.style.display = 'none';
      applyFilter();
      return;
    }
    const npub = decodeNpub(trimmed);
    if (npub) {
      personFilter = npub;
      personHint.textContent = `→ ${npub.slice(0, 8)}…`;
      personHint.style.color = '#8cffb4';
    } else {
      // Hex prefix — accept anything that's plausibly the start of a
      // 64-char hex pubkey. Sanitise to lowercase hex only so a paste of
      // "0xAB..." or a stray space doesn't break the prefix match.
      const hex = trimmed.toLowerCase().replace(/[^0-9a-f]/g, '');
      personFilter = hex;
      if (hex.length === 0) {
        personHint.textContent = 'INVALID';
        personHint.style.color = 'rgba(255,120,120,0.85)';
      } else if (hex.length === 64) {
        personHint.textContent = 'EXACT';
        personHint.style.color = '#8cffb4';
      } else {
        personHint.textContent = `PREFIX ${hex.length}/64`;
        personHint.style.color = 'rgba(255,216,74,0.85)';
      }
    }
    personClear.style.display = '';
    applyFilter();
  };
  personInput.addEventListener('input', () => setPersonFilter(personInput.value));
  personClear.addEventListener('click', () => {
    personInput.value = '';
    setPersonFilter('');
    personInput.focus();
  });

  // Top live tiles — up to 3 mini canvases of currently-live players,
  // one per row of the grid below. Click expands into the full live
  // theatre via makeMiniLiveTile's own click handler. Kept above the
  // grid so a glance at the watch page surfaces who's actually playing
  // right now without having to scan the score list.
  const liveTiles = el('div', { parent: overlay });
  // Hero row — wider tiles (min 320px) so the canvas reads as a real
  // game view, not a thumbnail. Bigger gap. Sits high in the page DOM
  // (moved above the relay/filter clutter via insertBefore below) so
  // a fresh visitor sees actual play before any chrome.
  liveTiles.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:22px;max-width:1100px;width:100%;margin:6px auto 22px;position:relative;';
  liveTiles.style.display = 'none';  // shown once at least one live tile lands
  // Per-pubkey tracker so we can keep stable tiles across update emits
  // (rebuilding from scratch every emit would flicker the canvas and
  // re-subscribe the WS, killing the smooth-frame illusion).
  const miniTiles = new Map<string, { el: HTMLElement; unsubscribe: () => void }>();
  watchActiveMiniTeardown = () => {
    for (const t of miniTiles.values()) t.unsubscribe();
    miniTiles.clear();
  };
  // Move the hero row up to sit directly below the page header. The
  // intro / status / relay pills / filter rows are all chrome around
  // the actual live play; pulling the tiles above them makes the page
  // read as "here's who's playing right now" first.
  overlay.insertBefore(liveTiles, intro);

  const grid = el('div', { parent: overlay });
  grid.style.cssText = 'display:flex;flex-direction:column;gap:10px;max-width:760px;width:100%;margin:0 auto;';

  const footer = el('div', { className: 'menu-row', parent: overlay });
  const backBtn = el('button', { className: 'menu-btn', parent: footer, text: 'BACK TO PALLASITE.APP' });
  backBtn.addEventListener('click', () => {
    watchActiveUnsubscribe?.();
    watchActiveUnsubscribe = null;
    watchActiveZapTeardown?.();
    watchActiveZapTeardown = null;
    for (const t of miniTiles.values()) t.unsubscribe();
    miniTiles.clear();
    try { window.location.assign('https://pallasite.app/'); }
    catch { window.location.assign('/'); }
  });

  // Card rendering — keyed by pubkey so update emits can patch existing
  // cards rather than tear down and rebuild the grid (avoids layout jank
  // and keeps any open zap popovers anchored to the right element).
  // Declared BEFORE setFilter/applyFilter because the initial
  // setFilter('all') call walks the empty map at boot — declaring this
  // after that call hit TDZ on a fresh visit and froze the watch page
  // on 'Connecting to relays…'.
  const cardByPubkey = new Map<string, HTMLElement>();

  // Initial highlight on ALL — done before any clicks.
  const setFilter = (k: FilterKind): void => {
    activeFilter = k;
    for (const def of FILTER_DEFS) {
      if (!def.visible) continue;
      const active = def.k === k;
      const c = FILTER_COLOUR[def.k];
      const btn = filterBtns[def.k];
      btn.style.background = active ? `${c}22` : '';
      btn.style.color = active ? c : '';
      btn.style.borderColor = active ? c : '';
    }
    applyFilter();
  };
  const applyFilter = (): void => {
    for (const [pubkey, card] of cardByPubkey) {
      const isLive = card.dataset.live === '1';
      const isMine = card.dataset.mine === '1';
      const at = parseInt(card.dataset.createdAt ?? '0', 10);
      const isToday = at > 0 && (Date.now() - at * 1000) < 24 * 60 * 60_000;
      const zapSats = parseInt(card.dataset.zapSats ?? '0', 10) || 0;
      let show = true;
      if (activeFilter === 'live') show = isLive;
      else if (activeFilter === 'today') show = isToday;
      else if (activeFilter === 'mine') show = isMine;
      else if (activeFilter === 'zapped') show = zapSats > 0;
      // Person filter — prefix match against the card's pubkey. Empty
      // filter means "no constraint". A short prefix matches several
      // cards; the 64-char form pins it to exactly one.
      if (show && personFilter) show = pubkey.startsWith(personFilter);
      card.style.display = show ? '' : 'none';
    }
    // ZAPPED tab re-orders cards by aggregate sats descending — playing
    // a "leaderboard of generosity" angle rather than chronology. Cards
    // with zero zaps drop out via the show=false branch above, so the
    // sort only touches the survivors.
    if (activeFilter === 'zapped') {
      const visible: Array<[number, HTMLElement]> = [];
      for (const card of cardByPubkey.values()) {
        if (card.style.display === 'none') continue;
        const zapSats = parseInt(card.dataset.zapSats ?? '0', 10) || 0;
        visible.push([zapSats, card]);
      }
      visible.sort((a, b) => b[0] - a[0]);
      for (const [, card] of visible) grid.appendChild(card);
    }
  };
  setFilter('all');

  const setCardLiveState = (card: HTMLElement, isLive: boolean): void => {
    card.dataset.live = isLive ? '1' : '0';
    card.style.borderColor = isLive ? 'rgba(140,255,180,0.7)' : 'rgba(255,216,74,0.35)';
    card.style.background = isLive ? 'rgba(60,200,140,0.10)' : 'rgba(255,216,74,0.04)';
    card.style.boxShadow = isLive ? '0 0 14px rgba(140,255,180,0.25)' : 'none';
    const pill = card.querySelector('[data-watch-live-pill]') as HTMLElement | null;
    if (pill) pill.style.display = isLive ? 'inline-block' : 'none';
  };

  const renderEntry = (entry: WatchEntry): void => {
    const isMine = !!(state.session && state.session.pubkey === entry.pubkey);
    const existing = cardByPubkey.get(entry.pubkey);
    if (existing) {
      const scorePill = existing.querySelector('[data-watch-score]');
      const wavePill = existing.querySelector('[data-watch-wave]');
      const whenPill = existing.querySelector('[data-watch-when]');
      if (scorePill) scorePill.textContent = entry.score.toLocaleString();
      if (wavePill) wavePill.textContent = `WAVE ${entry.wave}`;
      if (whenPill) whenPill.textContent = entry.isLive ? 'LIVE' : timeAgo(entry.createdAt);
      existing.dataset.createdAt = String(entry.createdAt);
      existing.dataset.mine = isMine ? '1' : '0';
      setCardLiveState(existing, entry.isLive);
      return;
    }
    const card = renderWatchCard(entry, state);
    card.dataset.mine = isMine ? '1' : '0';
    cardByPubkey.set(entry.pubkey, card);
    setCardLiveState(card, entry.isLive);
    grid.appendChild(card);
  };

  const refreshFilterCounts = (): void => {
    let live = 0, today = 0, mine = 0, zapped = 0;
    const now = Date.now();
    for (const card of cardByPubkey.values()) {
      if (card.dataset.live === '1') live += 1;
      if (card.dataset.mine === '1') mine += 1;
      const at = parseInt(card.dataset.createdAt ?? '0', 10);
      if (at > 0 && (now - at * 1000) < 24 * 60 * 60_000) today += 1;
      const zapSats = parseInt(card.dataset.zapSats ?? '0', 10) || 0;
      if (zapSats > 0) zapped += 1;
    }
    filterCounts.live.textContent = String(live);
    filterCounts.today.textContent = String(today);
    filterCounts.mine.textContent = String(mine);
    filterCounts.zapped.textContent = String(zapped);
    filterCounts.all.textContent = String(cardByPubkey.size);
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

  // Zap-total state — apply to cards on every entries OR zap emit, so a
  // card that arrives AFTER the zap aggregator already saw its receipts
  // still gets decorated, and a late-arriving zap on a known card
  // updates the chip without re-rendering. Keyed by lowercase hex.
  const zapTotalsByPubkey = new Map<string, { sats: number; count: number }>();
  // The pubkey set the zap subscription was opened with — used to know
  // when the set has grown enough that re-subscribing is worth the
  // socket churn. We tolerate stale subscriptions for a few new players
  // before re-opening: each re-subscribe drops the historical totals
  // we've accumulated client-side and re-fetches them.
  let lastSubscribedPubkeys: ReadonlySet<string> = new Set();
  const applyZapToCard = (card: HTMLElement, pubkey: string): void => {
    const totals = zapTotalsByPubkey.get(pubkey);
    const chip = card.querySelector('[data-watch-zap]') as HTMLElement | null;
    if (!chip) return;
    if (!totals || totals.sats <= 0) {
      chip.style.display = 'none';
      card.dataset.zapSats = '0';
      return;
    }
    card.dataset.zapSats = String(totals.sats);
    chip.style.display = '';
    chip.textContent = `⚡ ${totals.sats.toLocaleString()} sat${totals.sats === 1 ? '' : 's'}`;
    chip.title = `${totals.count} zap${totals.count === 1 ? '' : 's'} totalling ${totals.sats} sat${totals.sats === 1 ? '' : 's'} via kind 9735 receipts`;
  };
  const onZapTotals = (totals: ZapTotalsByPubkey): void => {
    // Copy into the local map — totals is a ReadonlyMap that may be the
    // aggregator's internal store, and we keep a stable reference here
    // so a card rendered after this emit can still look up its totals.
    zapTotalsByPubkey.clear();
    for (const [pk, t] of totals) zapTotalsByPubkey.set(pk, { sats: t.sats, count: t.count });
    for (const [pk, card] of cardByPubkey) applyZapToCard(card, pk);
    refreshFilterCounts();
    if (activeFilter === 'zapped') applyFilter();
  };
  const refreshZapSubscription = (pubkeys: ReadonlySet<string>): void => {
    // Only re-open the subscription when at least 4 new pubkeys appear
    // (or the set shrinks). Each re-subscribe drops the accumulated
    // client-side totals + reopens 6 WebSockets, so we want to batch.
    if (pubkeys.size === lastSubscribedPubkeys.size) {
      let identical = true;
      for (const pk of pubkeys) if (!lastSubscribedPubkeys.has(pk)) { identical = false; break; }
      if (identical) return;
    }
    const grown = pubkeys.size - lastSubscribedPubkeys.size;
    if (lastSubscribedPubkeys.size > 0 && grown < 4) return;
    watchActiveZapTeardown?.();
    lastSubscribedPubkeys = new Set(pubkeys);
    if (pubkeys.size === 0) { watchActiveZapTeardown = null; return; }
    watchActiveZapTeardown = subscribeZapTotals(
      Array.from(pubkeys),
      onZapTotals,
    );
  };

  watchActiveUnsubscribe = subscribeRecentRuns(
    (entries) => {
      // Drop locally-dismissed event ids; user removed them via the DISMISS
      // button so they shouldn't re-appear on update emits.
      const dismissed = getDismissedWatchEntries();
      const visible = entries.filter((e) => !dismissed.has(e.eventId));
      if (visible.length === 0) return; // status copy handled in onStatus
      const count = visible.length;
      const liveN = visible.reduce((acc, e) => acc + (e.isLive ? 1 : 0), 0);
      status.textContent = `${count} ${count === 1 ? 'player' : 'players'} surfaced from the last batch.`;
      updateLiveCount(liveN);
      // Drop the empty-state CTA now that we have entries to show.
      grid.querySelector('[data-watch-empty-cta]')?.remove();
      for (const e of visible) renderEntry(e);
      reorderGrid(visible);
      // Decorate any freshly-rendered card with whatever totals we
      // already know about — covers the "zap aggregator saw the receipt
      // before the score event arrived" case.
      for (const [pk, card] of cardByPubkey) applyZapToCard(card, pk);
      refreshFilterCounts();
      applyFilter();
      // Refresh the zap subscription against the latest pubkey set.
      refreshZapSubscription(new Set(visible.map((e) => e.pubkey)));
      // Sync top-3 live mini-canvas tiles. Live entries with the most
      // recent heartbeat win the slots. Add new ones, remove tiles whose
      // entry dropped out of the live set, leave matching ones in place.
      const liveTop = visible.filter((e) => e.isLive).slice(0, 3);
      const wanted = new Set(liveTop.map((e) => e.pubkey));
      for (const [pk, t] of miniTiles) {
        if (!wanted.has(pk)) { t.unsubscribe(); t.el.remove(); miniTiles.delete(pk); }
      }
      for (let i = 0; i < liveTop.length; i++) {
        const e = liveTop[i];
        if (miniTiles.has(e.pubkey)) continue;
        const t = makeMiniLiveTile(
          e.pubkey,
          shortPubkey(e.pubkey),
          e.score,
          e.wave,
          e.createdAt * 1000,
          state,
          (i + 1) as 1 | 2 | 3,
        );
        liveTiles.appendChild(t.el);
        miniTiles.set(e.pubkey, t);
      }
      liveTiles.style.display = miniTiles.size > 0 ? 'grid' : 'none';
    },
    {
      onStatus: (s) => {
        renderRelayPills(s.perRelay);
        // Only mutate copy while the grid is still empty — once cards land,
        // the entry-count line above takes precedence.
        if (cardByPubkey.size > 0) return;
        if (s.relaysAttempted === 0) {
          status.textContent = 'Connecting to relays…';
        } else if (s.relaysSettled === 0) {
          status.textContent = `Connecting to ${s.relaysAttempted} relays…`;
        } else if (s.emptyConfirmed) {
          status.textContent = `No runs on relays yet (${s.relaysSettled}/${s.relaysAttempted} settled).`;
          // First-run empty state — render a one-button CTA into the
          // grid that sends the visitor over to pallasite.app/play to
          // be the first published run. Renders inline once; further
          // status emits don't re-add the CTA.
          if (!grid.querySelector('[data-watch-empty-cta]')) {
            const cta = el('div', { parent: grid });
            cta.setAttribute('data-watch-empty-cta', '1');
            cta.style.cssText = 'border:1px dashed rgba(255,216,74,0.35);border-radius:8px;padding:18px 14px;background:rgba(255,216,74,0.03);display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;';
            const icon = el('div', { parent: cta, text: '🛸' });
            icon.style.cssText = 'font-size:2rem;opacity:0.85;';
            const headLine = el('div', { parent: cta, text: 'BE THE FIRST PLAYER ON THE WATCH PAGE' });
            headLine.style.cssText = 'font-size:0.95rem;color:#ffe0a0;letter-spacing:0.14em;';
            const sub = el('div', { parent: cta, text: 'No claimed runs on relays yet. Play a game on pallasite.app and your score lands here as a kind 30762 event.' });
            sub.style.cssText = 'font-size:0.82rem;color:rgba(220,210,255,0.75);max-width:520px;line-height:1.5;';
            const playBtn = el('button', { className: 'menu-btn', parent: cta, text: 'PLAY NOW · PALLASITE.APP' });
            playBtn.addEventListener('click', () => {
              try { window.location.assign('https://pallasite.app/'); }
              catch { window.location.assign('/'); }
            });
          }
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

/** Mini live preview canvas for a player. Subscribes to the same WS
 *  endpoint the full theatre uses but renders a stripped-down view:
 *  ship triangle + asteroid dots + UFO dots, no particles, no skins,
 *  no shield/thrust effects. Optimised for ≤200px-wide tiles so 3-4
 *  can run in parallel at 60fps without burning the main thread.
 *
 *  Returns an unsubscribe — call when the tile is removed. The caller
 *  can also call .onClick to wire up expand-to-full-theatre. */
function makeMiniLiveTile(
  pubkey: string,
  displayName: string,
  initialScore: number,
  initialWave: number,
  runStartedAtMs: number,
  state: GameState,
  rank: 1 | 2 | 3,
): { el: HTMLElement; unsubscribe: () => void } {
  // Hero treatment — these are the *only* thing on the page actually
  // showing live play, so they take centre stage: thick border, strong
  // glow, two-line HUD with avatar + name on top, score/wave row below.
  // Rank colour tints the border so 1ST/2ND/3RD reads at a glance.
  const rankColours: Record<1 | 2 | 3, string> = { 1: '#ffd84a', 2: '#cbd5e0', 3: '#cd7f32' };
  const rankGlows: Record<1 | 2 | 3, string> = {
    1: '0 0 22px rgba(255,216,74,0.45)',
    2: '0 0 18px rgba(203,213,224,0.32)',
    3: '0 0 18px rgba(205,127,50,0.32)',
  };
  const rankLabels: Record<1 | 2 | 3, string> = { 1: '1ST', 2: '2ND', 3: '3RD' };
  const tint = rankColours[rank];
  const card = el('div');
  card.style.cssText = [
    'position:relative',
    `border:2px solid ${tint}88`,
    'border-radius:10px',
    'background:#02050d',
    `box-shadow:${rankGlows[rank]}`,
    'overflow:hidden',
    'cursor:pointer',
    '-webkit-tap-highlight-color:transparent',
    'display:flex',
    'flex-direction:column',
    'transition:transform 120ms ease, box-shadow 120ms ease',
  ].join(';');
  card.addEventListener('mouseenter', () => {
    card.style.transform = 'translateY(-2px)';
    card.style.boxShadow = rankGlows[rank].replace(/0\.\d+/g, (m) => String(Math.min(0.9, parseFloat(m) + 0.18)));
  });
  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.boxShadow = rankGlows[rank];
  });
  // Canvas sized to fill the grid cell — let the CSS dictate the box and
  // size the internal buffer to DPR for crispness. The grid template uses
  // minmax(320px, 1fr) so a single-column phone layout still works.
  const MINI_W_CSS = 340;
  const MINI_H_CSS = Math.round(MINI_W_CSS * PALL_WORLD_H / PALL_WORLD_W);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const canvas = el('canvas', { parent: card, attrs: { width: String(MINI_W_CSS * dpr), height: String(MINI_H_CSS * dpr) } }) as HTMLCanvasElement;
  canvas.style.cssText = `display:block;width:100%;height:auto;aspect-ratio:${PALL_WORLD_W} / ${PALL_WORLD_H};`;
  const ctx = canvas.getContext('2d');

  // Rank chip — top-left, bolder than before so the podium reads first.
  const rankChip = el('span', { parent: card, text: rankLabels[rank] });
  rankChip.style.cssText = `position:absolute;top:8px;left:8px;font-size:0.72rem;font-weight:bold;letter-spacing:0.2em;color:${tint};border:1.5px solid ${tint};padding:3px 9px;border-radius:4px;font-family:monospace;background:rgba(2,5,13,0.82);text-shadow:0 0 8px ${tint}88;`;

  // Live pulse pill — top-right.
  const pill = el('span', { parent: card, text: '● LIVE' });
  pill.style.cssText = 'position:absolute;top:8px;right:8px;font-size:0.68rem;font-weight:bold;letter-spacing:0.16em;color:#8cffb4;border:1.5px solid rgba(140,255,180,0.7);padding:3px 9px;border-radius:4px;font-family:monospace;background:rgba(2,5,13,0.82);animation:pallasite-live-pulse 1.6s ease-in-out infinite;';

  // Mode badge — RETRO / MODERN, bottom-left over the HUD strip.
  const modeChip = el('span', { parent: card, text: '' });
  modeChip.style.cssText = 'position:absolute;bottom:60px;left:8px;font-size:0.6rem;letter-spacing:0.14em;font-family:monospace;background:rgba(2,5,13,0.78);padding:2px 7px;border-radius:3px;display:none;';

  // HUD — two-line: avatar + name on top, score / wave on bottom.
  const hud = el('div', { parent: card });
  hud.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 10px;background:rgba(2,5,13,0.92);border-top:1px solid rgba(220,210,255,0.08);';
  const hudTop = el('div', { parent: hud });
  hudTop.style.cssText = 'display:flex;align-items:center;gap:8px;';
  const avatarEl = el('div', { parent: hudTop });
  avatarEl.style.cssText = `flex:0 0 28px;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg, ${tint}33, rgba(140,255,180,0.18));border:1px solid ${tint}66;background-size:cover;background-position:center;`;
  const nameEl = el('span', { parent: hudTop, text: displayName });
  nameEl.style.cssText = 'flex:1;color:#fff5d8;letter-spacing:0.08em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:0.88rem;';
  const hudBot = el('div', { parent: hud });
  hudBot.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-family:monospace;';
  const scoreEl = el('span', { parent: hudBot, text: initialScore.toLocaleString() });
  scoreEl.style.cssText = 'color:#ffd84a;letter-spacing:0.06em;font-size:1.1rem;font-weight:bold;text-shadow:0 0 8px rgba(255,216,74,0.45);';
  const waveEl = el('span', { parent: hudBot, text: `WAVE ${initialWave}` });
  waveEl.style.cssText = 'color:#8cffb4;letter-spacing:0.12em;font-size:0.78rem;';

  // Asynchronously resolve a profile name + avatar.
  void (async () => {
    try {
      const profile = await fetchProfile(pubkey);
      const display = bestName(profile, pubkey);
      if (display && display !== pubkey) nameEl.textContent = display;
      if (profile?.picture) avatarEl.style.backgroundImage = `url('${profile.picture.replace(/'/g, '%27')}')`;
    } catch { /* ignore */ }
  })();

  // Click → open full live theatre.
  card.addEventListener('click', () => {
    unsubscribe();
    renderLiveTheatre({
      masterPubkey: pubkey,
      displayName: nameEl.textContent ?? shortPubkey(pubkey),
      initialScore: parseInt((scoreEl.textContent ?? '0').replace(/,/g, ''), 10) || 0,
      initialWave: parseInt((waveEl.textContent ?? 'W0').replace('W', ''), 10) || 0,
      runStartedAtMs,
      onClose: () => renderWatchPage(state),
    });
  });

  // WS subscription — minimal frame parse, render ship pose + entity
  // dots. Don't bother with interpolation / extrapolation at this
  // size; a 60fps slam-cut reads fine.
  let lastFrame: { x: number; y: number; r: number; asteroids: unknown[][]; ufos: unknown[][]; score: number; wave: number; mode: 'r' | 'm' } | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let lastActivity = Date.now();
  const open = (): void => {
    if (closed) return;
    try {
      ws = new WebSocket(`wss://controller.pallasite.app/?s=${encodeURIComponent(pubkey)}&r=subscribe`);
    } catch { return; }
    ws.onmessage = (ev) => {
      try {
        const obj = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (!obj || typeof obj.type === 'string') return;  // ignore peer-up/down
        const world = (typeof obj.world === 'object' && obj.world) ? obj.world : {};
        const md = world.md === 'm' ? 'm' : 'r';
        lastFrame = {
          x: typeof obj.x === 'number' ? obj.x : 0,
          y: typeof obj.y === 'number' ? obj.y : 0,
          r: typeof obj.r === 'number' ? obj.r : 0,
          asteroids: Array.isArray(world.a) ? world.a as unknown[][] : [],
          ufos: Array.isArray(world.u) ? world.u as unknown[][] : [],
          score: typeof obj.score === 'number' ? obj.score : 0,
          wave: typeof obj.wave === 'number' ? obj.wave : 0,
          mode: md,
        };
        lastActivity = Date.now();
        scoreEl.textContent = lastFrame.score.toLocaleString();
        waveEl.textContent = `W${lastFrame.wave}`;
        modeChip.style.display = 'inline-block';
        if (md === 'm') {
          modeChip.textContent = 'MODERN';
          modeChip.style.color = '#b48cff';
          modeChip.style.border = '1px solid rgba(180,140,255,0.55)';
        } else {
          modeChip.textContent = 'RETRO 4:3';
          modeChip.style.color = '#ffd84a';
          modeChip.style.border = '1px solid rgba(255,216,74,0.55)';
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (!closed) window.setTimeout(open, 1500); };
    ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
  };
  open();

  let raf = 0;
  const draw = (): void => {
    if (closed) return;
    raf = requestAnimationFrame(draw);
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#02050d';
    ctx.fillRect(0, 0, w, h);
    if (!lastFrame) {
      // No data yet — faint scanline at centre.
      ctx.fillStyle = 'rgba(140,255,180,0.18)';
      ctx.fillRect(0, h / 2, w, 1);
      return;
    }
    const sx = w / PALL_WORLD_W;
    const sy = h / PALL_WORLD_H;
    // Asteroids — small grey dots, slightly larger for size 'l'.
    ctx.fillStyle = 'rgba(220,210,255,0.55)';
    for (const a of lastFrame.asteroids) {
      const ax = (a[1] as number) * sx;
      const ay = (a[2] as number) * sy;
      const size = a[3] as string;
      const r = size === 'l' ? 3 * dpr : size === 'm' ? 2 * dpr : 1.4 * dpr;
      ctx.beginPath();
      ctx.arc(ax, ay, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // UFOs — red dots, distinct from asteroids at this scale.
    ctx.fillStyle = '#ff5050';
    for (const u of lastFrame.ufos) {
      const ux = (u[1] as number) * sx;
      const uy = (u[2] as number) * sy;
      ctx.beginPath();
      ctx.arc(ux, uy, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    // Ship — small green triangle.
    const shipX = lastFrame.x * sx;
    const shipY = lastFrame.y * sy;
    ctx.save();
    ctx.translate(shipX, shipY);
    ctx.rotate(lastFrame.r);
    ctx.scale(sx, sy);
    ctx.fillStyle = 'rgba(140,255,180,0.45)';
    ctx.strokeStyle = '#8cffb4';
    ctx.lineWidth = 1 / sx;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-10, 8);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-10, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Stale indicator — if no frame in 6s, fade the canvas to signal
    // the stream went quiet without removing the tile.
    if (Date.now() - lastActivity > 6000) {
      ctx.fillStyle = 'rgba(2,5,13,0.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,120,120,0.85)';
      ctx.font = `bold ${Math.round(10 * dpr)}px ui-monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('STALE', w / 2, h / 2);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  };
  raf = requestAnimationFrame(draw);

  const unsubscribe = (): void => {
    closed = true;
    cancelAnimationFrame(raf);
    try { ws?.close(); } catch { /* ignore */ }
  };

  return { el: card, unsubscribe };
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
  // "MINE" badge — surfaces signed-in player's own runs so they can
  // verify their score landed on relays + open their own replay.
  // Tinted purple so it sits off the LIVE-green / when-grey scale.
  if (state.session && state.session.pubkey === entry.pubkey) {
    const mine = el('span', { parent: meta, text: 'MINE' });
    mine.style.cssText = 'font-size:0.68rem;letter-spacing:0.16em;color:#cbb6ff;border:1px solid rgba(184,144,255,0.55);padding:1px 6px;border-radius:3px;font-family:monospace;background:rgba(120,90,200,0.10);';
  }
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
  // Zap-total chip — kept invisible until the kind 9735 aggregator
  // reports >0 sats for this pubkey. The orange ⚡ visually separates
  // it from the ₿ daily-claim sats already on the card, and reads as a
  // "this player got zapped" signal at a glance.
  const zapChip = el('span', { parent: stats, text: '' });
  zapChip.setAttribute('data-watch-zap', '1');
  zapChip.style.cssText = 'display:none;color:#ff8a3a;font-family:monospace;letter-spacing:0.06em;';

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
    // Audio prep MUST happen synchronously inside the click gesture.
    // iOS Safari unlocks audio per-element on the first in-gesture
    // .play(); musicWarmUpAll does that priming dance for every track,
    // skipping whatever is currently playing so we don't bounce the
    // title music. The async replay fetch below runs OUTSIDE the
    // gesture window, so any element first-played there is permanently
    // muted. resumePlayback also handles the post-pageshow case where
    // the AudioContext was suspended by silenceAll().
    void audio.unlockAudio().catch(() => undefined);
    audio.resumePlayback();
    musicWarmUpAll(currentTrackId() ?? undefined);
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
    // Try rich kind 30764 first (full-world replay) — falls back to the
    // pose-only kind 30763 path if no 30764 is found. Works for both
    // 'active' (player hasn't claimed) and 'final' entries because
    // findReplayByAuthor / fetchReplayByScoreEventId both publish
    // alongside the ghost on claim.
    watch.disabled = true;
    const original = watch.textContent;
    watch.textContent = 'LOADING…';
    void (async () => {
      const sinceSec = Math.max(0, entry.createdAt - 30);
      // Final entries: try score-id lookup first (#e match — only works
      // if the player passed scoreEventId at publishReplay time; at
      // game-over they don't have it yet because the score event is
      // signed by the faucet AFTER the claim). Then fall back to
      // author+since which finds any kind 30764 from that pubkey.
      let rich: Awaited<ReturnType<typeof findReplayByAuthor>> = null;
      try {
        if (entry.state === 'final') {
          rich = await fetchReplayByScoreEventId(entry.eventId);
          if (!rich) {
            console.log(`[replay] #e lookup empty for ${entry.eventId.slice(0, 8)}…, falling back to findReplayByAuthor`);
            rich = await findReplayByAuthor(entry.pubkey, sinceSec);
          }
        } else {
          rich = await findReplayByAuthor(entry.pubkey, sinceSec);
        }
      } catch { /* fall through to ghost */ }
      if (rich && rich.frames.length >= 2) {
        renderLiveTheatre({
          masterPubkey: entry.pubkey,
          displayName: name.textContent ?? shortPubkey(entry.pubkey),
          initialScore: rich.score,
          initialWave: rich.wave,
          runStartedAtMs: entry.createdAt * 1000,
          onClose: () => renderWatchPage(state),
          replaySource: {
            frames: rich.frames,
            durationMs: rich.durationMs,
            headerLabel: 'REPLAY · WATCHING',
            eventId: rich.eventId,
          },
        });
        return;
      }
      // Fallback: pose-only kind 30763 ghost.
      const scoreEventId = entry.state === 'final'
        ? entry.eventId
        : await findScoreIdForLatestGhost(entry.pubkey, sinceSec).catch(() => null);
      if (!scoreEventId) {
        watch.textContent = 'NO REPLAY YET';
        watch.title = 'Player has not claimed yet — the kind 30763 / 30764 events publish at claim. Try again later.';
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
  });

  // SHARE — copies a /#score=<eventId> deep-link. Single click, no
  // pre-fetch needed — recipient's browser resolves the kind 30764
  // via its #e tag on page load.
  const share = el('button', { className: 'menu-btn secondary', parent: actions, text: 'SHARE' }) as HTMLButtonElement;
  share.style.cssText += 'color:#cbb6ff;border-color:rgba(184,144,255,0.55);';
  share.addEventListener('click', () => {
    const url = `https://watch.pallasite.app/#score=${entry.eventId}`;
    const restore = (): void => { setTimeout(() => { share.textContent = 'SHARE'; }, 1400); };
    void (async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          share.textContent = 'COPIED';
          restore();
          return;
        }
      } catch { /* fall through */ }
      window.prompt('Copy the replay link:', url);
      share.textContent = 'COPIED';
      restore();
    })();
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

/** Accessor for the live in-progress name in the title-screen arcade
 *  picker. Set by renderSessionPanel when the no-session branch mounts
 *  the picker; cleared when the panel re-renders into the signed-in
 *  branch. The IGNITE button on the title reads this so a player who
 *  hammers IGNITE without pressing DONE still gets whatever they
 *  cycled in, falling back to 'Anonymous' for an untouched picker. */
let titleNamePickerGetName: (() => string) | null = null;

function renderSessionPanel(parent: HTMLElement, state: GameState): void {
  parent.innerHTML = '';
  // Reset the title-screen name-picker accessor on every panel render —
  // a re-render usually means the picker is being unmounted, so a stale
  // closure would point at a detached DOM widget.
  titleNamePickerGetName = null;
  if (state.session && isGuestSession(state.session)) {
    // Subtle disclosure path — the player is on a locally-generated
    // Nostr identity. We surface the name (editable) and a quiet
    // npub line + upgrade affordance, but skip the "locked to X via
    // bunker" copy that's appropriate for "real" signers. Goal:
    // feels like a normal name display, not a crypto-key panel.
    const session = state.session;
    const guestName = session.displayName ?? 'Anonymous';
    const identity = el('div', { parent });
    identity.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;';
    const nameLine = el('div', { parent: identity });
    nameLine.style.cssText = 'display:flex;align-items:center;gap:8px;';
    el('span', { parent: nameLine, text: 'Playing as' }).style.cssText = 'color:rgba(220,210,255,0.7);letter-spacing:0.08em;';
    const nameBtn = el('button', { parent: nameLine, text: guestName }) as HTMLButtonElement;
    nameBtn.style.cssText = 'background:transparent;border:none;color:var(--hud-yellow);font-weight:bold;font-size:1.05rem;letter-spacing:0.06em;cursor:pointer;padding:2px 6px;border-bottom:1px dashed rgba(255,216,74,0.4);';
    nameBtn.title = 'Tap to rename';
    nameBtn.addEventListener('click', () => {
      // Inline-swap the panel into rename mode using the same arcade
      // picker the first-time signup uses. window.prompt was a quick
      // start but is unreachable from the controller PWA d-pad (no
      // alphanumerics on the joystick) and breaks the seamless feel
      // on mobile (modal blocks the page).
      parent.innerHTML = '';
      titleNamePickerGetName = null;
      const banner = el('p', { parent, text: 'RENAME' });
      banner.style.cssText = 'font-size:0.95rem;color:#ffd84a;letter-spacing:0.16em;margin:0 0 6px;';
      const commit = (raw: string): void => {
        const result = setGuestName(raw);
        if (result.ok && result.name && state.session) {
          // Mutate displayName in place so subsequent reads of
          // state.session see the new name without rebuilding the
          // whole SignetSession object.
          (state.session as { displayName: string }).displayName = result.name;
        }
        renderSessionPanel(parent, state);
      };
      renderArcadeName(parent, {
        maxLen: 25,
        initialValue: guestName,
        onSubmit: (name) => commit(name.trim() || guestName),
      });
      const cancelRow = el('div', { parent });
      cancelRow.style.cssText = 'display:flex;justify-content:center;margin-top:6px;';
      const cancel = el('button', { className: 'menu-btn secondary', parent: cancelRow, text: 'CANCEL' }) as HTMLButtonElement;
      cancel.style.cssText += 'font-size:0.72rem;padding:4px 12px;letter-spacing:0.14em;';
      cancel.addEventListener('click', () => renderSessionPanel(parent, state));
    });
    // Identity disclosure — small "your Nostr identity" line with the
    // truncated npub. Click-to-copy so a curious user can paste it
    // into another Nostr client and confirm it's a real key.
    const idLine = el('div', { parent: identity });
    idLine.style.cssText = 'font-size:0.7rem;color:rgba(180,140,255,0.65);letter-spacing:0.06em;font-family:monospace;cursor:pointer;';
    const shortPk = shortPubkey(session.pubkey);
    idLine.textContent = `local identity · ${shortPk} · tap to copy`;
    idLine.addEventListener('click', () => {
      void navigator.clipboard?.writeText(session.pubkey).then(
        () => { idLine.textContent = `copied! · ${shortPk}`; window.setTimeout(() => { idLine.textContent = `local identity · ${shortPk} · tap to copy`; }, 1400); },
        () => { /* clipboard refused — silent, the user can find it again on the settings panel */ },
      );
    });
    renderTierBadge(parent, session.pubkey);
    const row = el('div', { className: 'menu-row', parent });
    const upgrade = el('button', { className: 'menu-btn secondary', parent: row, text: 'UPGRADE TO NOSTR' }) as HTMLButtonElement;
    upgrade.style.cssText += 'font-size:0.72rem;padding:4px 12px;letter-spacing:0.14em;';
    upgrade.title = 'Sign in with a NIP-07 extension or bunker URI. Replaces this local identity with a portable Nostr account that works across devices.';
    upgrade.addEventListener('click', () => {
      void (async () => {
        try { void audio.unlockAudio(); } catch { /* ignore */ }
        try {
          const signedIn = await auth.signIn();
          if (signedIn) {
            // Real Nostr signer wins over the guest. Don't wipe the
            // guest record here — leave it on disk so an EJECT
            // returns the player to their guest identity rather than
            // a blank "what's your name?" prompt. Settings has a
            // separate "clear local identity" affordance for hard
            // wipe.
            state.session = signedIn;
            renderSessionPanel(parent, state);
          }
        } catch { /* errors already surfaced by the SDK modal */ }
      })();
    });
    const exportBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'EXPORT KEY' }) as HTMLButtonElement;
    exportBtn.style.cssText += 'font-size:0.72rem;padding:4px 12px;letter-spacing:0.14em;';
    exportBtn.title = 'Show your npub (public) and nsec (secret key) so you can back this identity up in a Nostr client.';
    exportBtn.addEventListener('click', () => {
      const privHex = getGuestPrivkeyHex();
      if (!privHex) return;
      openGuestKeyExport(session.pubkey, privHex);
    });
    const wipe = el('button', { className: 'menu-btn secondary', parent: row, text: 'CLEAR' }) as HTMLButtonElement;
    wipe.style.cssText += 'font-size:0.72rem;padding:4px 12px;letter-spacing:0.14em;color:rgba(255,120,120,0.85);border-color:rgba(255,120,120,0.4);';
    wipe.title = 'Forget this local identity. You\'ll be asked for your name again next time you visit.';
    wipe.addEventListener('click', () => {
      if (!window.confirm('Forget this local identity? Your scores stay on relays but this device will create a new keypair next time.')) return;
      clearGuestIdentity();
      state.session = null;
      state.profile = null;
      // After wipe we're a fresh visitor — the attract screen is the
      // right home, not the in-place no-session panel (which would
      // show the arcade picker mid-mission-select-context).
      renderAttract(state);
    });
    return;
  }
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
    // ADMIN button — only visible when the signed-in pubkey matches
    // the server's ADMIN_PUBKEY_HEX. Server still enforces the
    // allowlist on every action, so a tampered client that forced
    // this button to appear would just bounce off the /api/admin/v2
    // 403 wall. Useful so the admin doesn't have to remember the
    // /admin URL.
    if (isAdminSession(pubkey)) {
      const adminBtn = el('button', { className: 'menu-btn', parent: row, text: '⚙ ADMIN' }) as HTMLButtonElement;
      adminBtn.style.cssText += 'border-color:rgba(255,216,74,0.7);color:#ffd84a;letter-spacing:0.14em';
      adminBtn.title = 'Operator panel — tune caps, presets, settings, player overrides.';
      adminBtn.addEventListener('click', () => { window.location.assign('/admin'); });
    } else {
      // GameInfo (which carries admin_pubkey) is fetched lazily — if
      // the cache hasn't landed yet, kick off the fetch and re-render
      // when it resolves so the ADMIN button surfaces without
      // requiring the user to navigate away and back.
      void import('./faucet.js').then(async ({ fetchGameInfo, isAdminSession: isAdmin }) => {
        await fetchGameInfo();
        if (isAdmin(pubkey) && parent.isConnected) {
          renderSessionPanel(parent, state);
        }
      });
    }
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
      // EJECT returns to attract — a session-less mission select would
      // surface the inline arcade picker (back-compat branch in
      // renderSessionPanel) but that's confusing in the new flow.
      renderAttract(state);
    };
    out.addEventListener('click', () => { void doEject(); });
    out.addEventListener('pointerup', e => {
      if (e.pointerType !== 'mouse') void doEject();
    });
  } else {
    // Seamless guest identity — every visitor gets a local Nostr
    // keypair the first time they ignite. The user-visible primitive is
    // a name field, not "create an account": we ask "what's your name?"
    // and silently provision the keypair behind it. Returning visitors
    // skip this branch entirely because auth.tryRestore resurrects the
    // stored guest record into a SignetSession on boot.
    const greet = el('p', { parent, text: 'WHAT\'S YOUR NAME?' });
    greet.style.cssText = 'font-size:0.95rem;color:#ffd84a;letter-spacing:0.16em;margin:0 0 6px;';
    const status = el('p', { parent });
    status.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);min-height:1em;margin:0;letter-spacing:0.04em;';
    let creating = false;
    const submitWithName = (raw: string): void => {
      if (creating) return;
      creating = true;
      status.textContent = '';
      // Audio unlock under the click gesture — same reason as the
      // watch page WATCH-button handler: any audio play() after an
      // async hop gets rejected by iOS Safari.
      try { void audio.unlockAudio(); } catch { /* ignore */ }
      void (async () => {
        try {
          const name = raw.trim() || 'Anonymous';
          const session = await auth.createGuestSession(name);
          state.session = session;
          renderSessionPanel(parent, state);
        } catch (err) {
          status.textContent = `Couldn\'t create local identity: ${err instanceof Error ? err.message : String(err)}`;
          status.style.color = '#ff8a3a';
          creating = false;
        }
      })();
    };
    // Arcade-style 25-char name picker. Three input modes all work:
    //   • Desktop kb: ▲▼ arrows or type letters directly.
    //   • Mobile touch: tap ▲▼/◀▶/BKSP/DONE buttons.
    //   • Controller PWA in d-pad mode: setupOverlayArrowNav cycles
    //     focus through the picker's <button> elements; ENTER (A) on
    //     ▲ cycles char, on ◀▶ moves cursor, on DONE submits.
    // The plain <input> the panel had before was unusable on the
    // controller PWA — d-pad emits arrow keys, not alphanumerics.
    const picker = renderArcadeName(parent, {
      maxLen: 25,
      onSubmit: (name) => { submitWithName(name); },
    });
    titleNamePickerGetName = picker.getCurrentName;
    // "I have a Nostr account already" — fold the existing Signet flow
    // into a smaller secondary path so the primary action stays "type
    // name and play". A user with NIP-07 / bunker / signet QR just
    // taps this to skip the guest path entirely.
    const advRow = el('div', { parent });
    advRow.style.cssText = 'display:flex;justify-content:center;margin-top:4px;';
    const inBtn = el('button', { className: 'menu-btn secondary', parent: advRow, text: 'I HAVE A NOSTR ACCOUNT' }) as HTMLButtonElement;
    inBtn.style.cssText += 'font-size:0.72rem;padding:4px 12px;letter-spacing:0.14em;';
    let signing = false;
    const doSignIn = async (): Promise<void> => {
      if (signing) return;
      signing = true;
      status.textContent = 'Connecting…';
      status.style.color = 'rgba(180,140,255,0.85)';
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
    // Autofocus the first interactive control inside the arcade name
    // picker on desktop so a kb user can start typing letters straight
    // away (the picker has a keydown shortcut for letter / digit keys
    // that types into the active slot). Skip on coarse-pointer devices
    // since we don't want focus jumping into a hidden control before
    // the user has decided to play.
    if (!matchMedia('(pointer: coarse)').matches) {
      window.setTimeout(() => {
        const firstBtn = parent.querySelector<HTMLButtonElement>('[data-arcade-initials="open"] button');
        try { firstBtn?.focus(); } catch { /* ignore */ }
      }, 60);
    }
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
  // Shrink the viz on phones so the 20-row track list isn't pushed
  // below the fold. 110px is enough for the bar pattern to read; the
  // 172px desktop version stays via the min() ceiling.
  canvas.style.cssText = 'width:100%;max-width:460px;height:min(172px, 22vh);border-radius:6px;background:radial-gradient(ellipse at 50% 100%, rgba(180,140,255,0.18), rgba(0,0,0,0.7));';

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

  // Buttons go ABOVE the list so STOP + BACK are reachable without
  // scrolling past 20+ rows on a phone. Previously they sat at the
  // bottom of the overlay; with the expanded track set they were
  // off-screen on iPhone SE-class displays.
  const buttons = el('div', { className: 'menu-row', parent: overlay });
  const stop = el('button', { className: 'menu-btn secondary', parent: buttons, text: 'STOP' });
  const back = el('button', { className: 'menu-btn', parent: buttons, text: 'BACK' });

  // Group tracks by category — stings (system + cinematic), bonus levels
  // (off-rail detours — W9→W10 hyperspace, 600bn the-cult), then wave tracks.
  const tracks = listTracks();
  const stings = tracks.filter((t) => t.category === 'sting');
  const bonusTracks = tracks.filter((t) => t.category === 'bonus');
  const waveTracks = tracks.filter((t) => t.category === 'wave');

  const list = el('div', { parent: overlay });
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;max-width:460px;';

  const renderHeader = (text: string): void => {
    const h = el('div', { parent: list, text });
    h.style.cssText = 'margin:8px 0 2px;font-size:0.78rem;letter-spacing:0.22em;color:rgba(184,144,255,0.75);text-align:left;font-family:monospace;';
  };

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

  const addRow = (t: import('./music.js').TrackInfo): void => {
    const row = el('div', { parent: list });
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:10px',
      'padding:10px 12px', 'border-radius:8px',
      'border:1px solid rgba(180,140,255,0.3)',
      'background:rgba(180,140,255,0.04)',
      'cursor:pointer', '-webkit-tap-highlight-color:transparent',
      'touch-action:manipulation',
    ].join(';');

    const glyph = el('span', { parent: row, text: '·' });
    glyph.style.cssText = 'font-size:1.1rem;width:1.4rem;text-align:center;color:rgba(180,140,255,0.6);flex:0 0 1.4rem;';

    // Prominent wave-number chip on the left for wave tracks. Stings
    // get a small dim chip so the columns align visually.
    const waveChip = el('span', { parent: row });
    waveChip.style.cssText = [
      'flex:0 0 56px',
      'font-family:monospace', 'font-size:0.95rem', 'letter-spacing:0.06em',
      'text-align:center', 'padding:3px 0',
      'border-radius:4px',
      t.wave !== null
        ? 'background:rgba(255,216,74,0.12);color:#ffd84a;border:1px solid rgba(255,216,74,0.35);'
        : 'background:rgba(184,144,255,0.08);color:rgba(184,144,255,0.55);border:1px solid rgba(184,144,255,0.25);',
    ].join(';');
    waveChip.textContent = t.wave !== null ? `W${t.wave}` : '·';

    const text = el('div', { parent: row });
    text.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:1px;text-align:left;min-width:0;';
    const label = el('span', { parent: text, text: t.label });
    label.style.cssText = "font-family:'VT323',ui-monospace,monospace;font-size:1.05rem;letter-spacing:0.16em;color:#fff5d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const hint = el('span', { parent: text, text: t.hint });
    hint.style.cssText = 'font-size:0.72rem;letter-spacing:0.06em;color:rgba(220,210,255,0.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    onTap(row, () => {
      void audio.unlockAudio();
      musicPreviewPlay(t.id);
      paint();
    });

    rows.push({ id: t.id, el: row, glyph });
  };

  renderHeader('STINGS · SYSTEM');
  for (const t of stings) addRow(t);
  renderHeader('BONUS LEVELS');
  for (const t of bonusTracks) addRow(t);
  renderHeader('WAVE TRACKS (1 → 25)');
  for (const t of waveTracks) addRow(t);
  paint();

  onTap(stop, () => { musicStop(250); paint(); });
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
  // Focus RESUME so a single Enter press (or controller-pad A) un-pauses
  // without first hunting via the d-pad. setTimeout(0) defers past the
  // keydown that opened the pause menu — otherwise the focus call races
  // the same event and the button doesn't take focus. tryFocusVisible
  // makes the focus ring light up loudly so the player sees what's
  // about to fire.
  setTimeout(() => tryFocusVisible(resume), 0);
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

export function renderGameOver(state: GameState): void {
  // Push the current skin unlock set to Nostr at the end of every run.
  // kind 30764 is replaceable (d="pallasite-skins") so this is idempotent
  // when nothing has changed; when something has (e.g. halo just unlocked
  // mid-run), the new set propagates without a separate signal path.
  if (state.session) {
    void publishSkinUnlocks(state.session).catch(() => undefined);
  }

  // High-score handling — auto-save under the player's session display
  // name (guest's chosen name, or NIP-01 best-name for a real signer)
  // and advance straight to the recap. The previous 4-char arcade
  // initials picker is gone: every player now arrives with an
  // identity already (seamless guest or signed-in Nostr), and a
  // separate 3-letter pseudonym for the leaderboard was duplicate
  // identity churn. `initialsEnteredThisRun` is repurposed as "high
  // score for this run has been written" so REPLAY KILL re-renders
  // don't double-count.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh && !state.initialsEnteredThisRun) {
    addLocalHighScore({
      name: scoreboardNameFor(state),
      score: state.score,
      sats: state.sats,
      wave: state.wave,
      at: new Date().toISOString(),
      pubkey: state.session?.pubkey,
    });
    state.initialsEnteredThisRun = true;
  }
  renderGameOverRecap(state);
}

/**
 * Derive the name to write into the local high-score table for the
 * current session. Order of preference:
 *   1. session.displayName (set by guest signup, or by Signet for some
 *      sign-in paths)
 *   2. NIP-01 kind 0 metadata via the cached profile + bestName helper
 *   3. truncated pubkey hex as a last-resort fallback
 *   4. literal 'PLAYER' for sessionless runs (shouldn't happen in the
 *      new attract → auth flow, but keeps the table populated)
 *
 * Upper-cased + capped at 25 chars to match the table's column width.
 */
function scoreboardNameFor(state: GameState): string {
  const session = state.session;
  if (!session) return 'PLAYER';
  const raw = session.displayName
    ?? (state.profile ? bestName(state.profile, session.pubkey) : null)
    ?? shortPubkey(session.pubkey);
  return raw.toUpperCase().slice(0, 25);
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
      if (/timeout|signer-timeout|queue-timeout/i.test(detail)) {
        return 'Signer did not respond. Open your Nostr extension, unlock it, then click CLAIM again.';
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

  // ── Destination picker — replaces the single CLAIM button ──────────
  // BTC Prague flow: a walk-up guest scores well and wants the sats now.
  // Three options, every time (no muscle-memory default):
  //   • Send to Lightning Address  — paste a lud16, server pays it
  //   • Scan with Wallet           — LNURL-w QR, wallet pulls the sats
  //   • Add to Balance             — bank for later (legacy single-tap)
  // Direct payouts are gated at ≥100 sats (invoice fees would eat
  // smaller payouts); below the threshold only the balance path
  // appears, with a one-liner explaining why.
  const sessionPubkey = state.session.pubkey;
  const sats = state.sats;
  const canDirectPayout = sats >= WITHDRAW_THRESHOLD_SATS;

  const heading = el('p', { parent: compactView });
  heading.style.cssText = 'margin:6px 0 4px;font-size:0.72rem;letter-spacing:0.18em;color:rgba(255,216,74,0.85);text-align:center';
  heading.textContent = sats > 0 ? `CLAIM ${sats} SATS — WHERE?` : 'CLAIM';

  const picker = el('div', { parent: compactView });
  picker.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:2px';

  const mkBtn = (label: string, sub: string, accent: string): HTMLButtonElement => {
    const btn = el('button', { className: 'menu-btn', parent: picker }) as HTMLButtonElement;
    btn.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:2px;padding:10px 14px;border:1.5px solid ${accent};background:rgba(2,5,13,0.4);cursor:pointer;font-size:0.92rem;letter-spacing:0.1em;text-align:center`;
    const top = el('div', { parent: btn, text: label });
    top.style.cssText = 'font-weight:bold;';
    const subEl = el('div', { parent: btn, text: sub });
    subEl.style.cssText = 'font-size:0.68rem;color:rgba(220,210,255,0.65);font-weight:normal;letter-spacing:0.06em';
    return btn;
  };

  // D-pad / controller-only surfaces can't type, so the lud16 path
  // only makes sense when we have a pre-fill (returning player) or
  // a real keyboard is plausible. Hide it otherwise — the QR path
  // is the venue-native option anyway, so a fresh BTC Prague guest
  // is funnelled there instead of staring at an unusable input.
  const preFilledLud16 = state.profile?.lud16 ?? getStoredLnAddress() ?? '';
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const controllerPaired = activeControllerHost?.paired === true;
  const kbAvailable = !coarsePointer && !controllerPaired;
  const offerAddress = canDirectPayout && (preFilledLud16 !== '' || kbAvailable);

  const addressBtn = offerAddress
    ? mkBtn(
        '⚡ SEND TO LIGHTNING ADDRESS',
        preFilledLud16
          ? `Pay ${preFilledLud16.slice(0, 28)}${preFilledLud16.length > 28 ? '…' : ''}`
          : 'Pay an address like donkey@strike.me',
        'rgba(140,255,180,0.55)',
      )
    : null;
  const qrBtn = canDirectPayout
    ? mkBtn('📱 SCAN WITH WALLET', 'LNURL-w QR — your wallet pulls the sats', 'rgba(184,144,255,0.55)')
    : null;
  const balanceBtn = mkBtn(
    '💰 ADD TO BALANCE',
    canDirectPayout ? 'Save up — withdraw later from the title screen' : `Direct payout unlocks at ${WITHDRAW_THRESHOLD_SATS} sats`,
    'rgba(255,216,74,0.55)',
  );

  // Focus the primary destination button on render so a single Enter
  // press (or controller-pad A) fires the claim without first hunting
  // for it via d-pad. Priority order matches the picker layout:
  // address (pre-fill or kb) → QR → balance. On a coarse-pointer
  // surface with no pre-fill, address is null and QR becomes the
  // default. Below-threshold runs only have balance, so it's the
  // default there. Deferred via setTimeout to let the recap layout
  // settle before grabbing focus.
  const primaryBtn = addressBtn ?? qrBtn ?? balanceBtn;
  if (primaryBtn && hasAgeAttestation(sessionPubkey)) {
    setTimeout(() => tryFocusVisible(primaryBtn), 0);
  }

  // Inline expansion slot — when a destination is picked, its own
  // sub-form (lud16 input, QR canvas, etc.) renders here.
  const flowSlot = el('div', { parent: compactView });
  flowSlot.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:8px';

  const allButtons = [addressBtn, qrBtn, balanceBtn].filter((b): b is HTMLButtonElement => b !== null);
  const setEnabled = (on: boolean): void => {
    for (const b of allButtons) {
      b.disabled = !on;
      b.style.opacity = on ? '1' : '0.55';
    }
  };

  const onAttested = (): void => {
    setAgeAttestation(sessionPubkey);
    setEnabled(true);
    ageWrap.remove();
    // Now that the picker is live, drop focus on the primary so the
    // player can press A immediately after ticking the 18+ box.
    if (primaryBtn) setTimeout(() => tryFocusVisible(primaryBtn), 0);
  };
  if (hasAgeAttestation(sessionPubkey)) {
    ageWrap.remove();
  } else {
    setEnabled(false);
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

  const status = el('p', { parent: wrapper, text: '' });
  status.style.cssText = 'font-size:0.85rem;margin:4px 0 0 0;min-height:1.2em';
  const setStatus = (msg: string, color: string): void => {
    status.textContent = msg;
    status.style.color = color;
  };

  const session = state.session;

  // Build the run payload once. Identical to the old single-button
  // flow — every destination starts with the same submitClaim.
  const buildPayload = (): {
    payload: Parameters<typeof submitClaim>[1];
  } => {
    const finishedAt = Date.now();
    const duration = Math.max(0, Math.floor(state.runTimeMs));
    const startedAt =
      state.runStartedAt > 0 ? state.runStartedAt : finishedAt - duration;

    const seed = getActiveSeed();
    const runAchievements = getRunAchievements();
    const stats = state.runStats;
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
    return {
      payload: {
        score: state.score,
        wave: state.wave,
        duration_ms: duration,
        started_at: startedAt,
        finished_at: finishedAt,
        sats_claimed: state.sats,
        cheated: state.cheatedThisRun,
        ...(seed ? { daily_seed: seed } : {}),
        // Flag Sanctum runs so the faucet enforces the daily_cap_600bn
        // budget + appends the ['t','600bn'] tag on the kind 30762
        // score event. state.sanctum is set by startSanctumRun and
        // survives through gameover; absent on every standard-game claim.
        ...(state.sanctum ? { room: '600bn' as const } : {}),
        telemetry,
      },
    };
  };

  // Run submitClaim once. Returns the payout sats actually credited
  // (the server may downgrade based on tier caps) so the chained
  // payout step (lud16 / LNURL-w) knows how much to drain.
  let claimRun = false;
  let claimedAmount = 0;
  const runClaim = async (): Promise<{ ok: true; amount: number } | { ok: false }> => {
    if (claimRun) return { ok: true, amount: claimedAmount };
    const { payload } = buildPayload();
    if (state.sats > 0 && !state.cheatedThisRun) {
      savePendingClaim(session.pubkey, payload);
    }
    const result = await submitClaim(session, payload);
    if (!result.ok) {
      if (isTerminalClaimError(result.error)) clearPendingClaim();
      setStatus(claimErrorMessage(result.error, result.detail), '#ff8050');
      setEnabled(true);
      return { ok: false };
    }
    clearPendingClaim();
    musicNotifyClaimSuccess();
    claimRun = true;
    claimedAmount = result.payout_sats;
    return { ok: true, amount: claimedAmount };
  };

  const lockPicker = (chosen: HTMLButtonElement): void => {
    setEnabled(false);
    chosen.style.borderColor = '#ffd84a';
    chosen.style.background = 'rgba(255,216,74,0.10)';
  };

  // Undo a lockPicker. Only useful before the destination's actual
  // claim fires (e.g. the player tapped ADDRESS but realised they
  // can't type and wants to back out to pick QR instead). After the
  // claim runs there's no going back.
  const unlockPicker = (): void => {
    flowSlot.replaceChildren();
    setEnabled(true);
    for (const b of allButtons) {
      b.style.borderColor = '';
      b.style.background = 'rgba(2,5,13,0.4)';
      // mkBtn's border was set from the accent colour; restoring the
      // exact original needs the inline cssText. Re-applying the
      // outline via the picker's setter would be tidier, but for the
      // visual revert here we just clear the highlight.
    }
  };

  // ── Destination: Add to balance ─────────────────────────────────────
  onTap(balanceBtn, () => {
    void (async () => {
      lockPicker(balanceBtn);
      setStatus('Crediting balance…', '#5b9dff');
      setIdlePaused?.(true);
      try {
        const r = await runClaim();
        if (r.ok) {
          setStatus(`✓ Banked ${r.amount} sats · withdraw from the title screen`, '#58ff58');
        }
      } finally {
        setIdlePaused?.(false);
      }
    })();
  });

  // ── Destination: Lightning Address ──────────────────────────────────
  if (addressBtn) {
    onTap(addressBtn, () => {
      lockPicker(addressBtn);
      flowSlot.replaceChildren();
      const card = el('div', { parent: flowSlot });
      card.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid rgba(140,255,180,0.3);border-radius:8px;background:rgba(60,200,140,0.05)';
      const label = el('p', { parent: card, text: 'LIGHTNING ADDRESS' });
      label.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(140,255,180,0.85);letter-spacing:0.14em';
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.autocapitalize = 'off';
      input.autocomplete = 'email';
      input.placeholder = 'alice@yourwallet.com';
      input.style.cssText = 'padding:10px 12px;font-family:inherit;font-size:0.95rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px';
      input.value = preFilledLud16;
      card.appendChild(input);
      const sendBtn = el('button', { className: 'menu-btn', parent: card, text: `SEND ${sats} SATS →` }) as HTMLButtonElement;
      sendBtn.style.cssText = 'padding:8px 14px;cursor:pointer;font-size:0.92rem';
      // BACK button — gives a d-pad / mis-tap player a route back to
      // the picker without having to wait for the auto-skip-to-title
      // timer. Only effective until SEND is pressed (after that the
      // claim is in flight). Stays visible inside the card so d-pad
      // nav can reach it via the standard geometric search.
      const backBtn = el('button', { className: 'menu-btn secondary', parent: card, text: '← BACK' }) as HTMLButtonElement;
      backBtn.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:0.78rem;align-self:flex-start';
      onTap(backBtn, () => unlockPicker());
      const sendErr = el('p', { parent: card });
      sendErr.style.cssText = 'margin:0;font-size:0.74rem;min-height:1em;color:#888';

      // Focus strategy: pre-fill present → focus SEND so d-pad A
      // activates immediately; pre-fill empty → focus the input so
      // desktop kb / mobile OSK users start typing without an extra
      // tap. setupOverlayArrowNav ignores INPUT focus, so a
      // controller-pad user pressing arrows from inside the input
      // sees nothing happen — which is why the address button is
      // hidden upstream when no pre-fill and no kb is plausible.
      window.setTimeout(() => {
        try {
          if (preFilledLud16) tryFocusVisible(sendBtn);
          else input.focus();
        } catch { /* ignore */ }
      }, 50);
      onTap(sendBtn, () => {
        void (async () => {
          const addr = input.value.trim();
          if (!LN_ADDRESS_RE.test(addr)) {
            sendErr.textContent = 'Invalid lightning address.';
            sendErr.style.color = '#ff5050';
            return;
          }
          setStoredLnAddress(addr);
          sendBtn.disabled = true;
          input.disabled = true;
          sendErr.textContent = '';
          setStatus('Crediting balance…', '#5b9dff');
          setIdlePaused?.(true);
          try {
            const claim = await runClaim();
            if (!claim.ok) {
              sendBtn.disabled = false;
              input.disabled = false;
              return;
            }
            setStatus(`Paying ${claim.amount} sats to ${addr}…`, '#5b9dff');
            const w = await submitWithdraw(session, { amount_sats: claim.amount, lightning_address: addr });
            if (w.ok) {
              setStatus(`✓ Paid ${w.amount_sats} sats to ${addr}`, '#58ff58');
            } else {
              setStatus(`Banked ${claim.amount} sats · payout failed: ${withdrawErrorMessage(w.error, w.detail)}`, '#ff8050');
              sendErr.textContent = 'Sats sit safely on your balance — retry withdraw on the title screen.';
              sendErr.style.color = 'rgba(255,216,74,0.85)';
            }
          } finally {
            setIdlePaused?.(false);
          }
        })();
      });
    });
  }

  // ── Destination: LNURL-withdraw QR ──────────────────────────────────
  if (qrBtn) {
    onTap(qrBtn, () => {
      lockPicker(qrBtn);
      flowSlot.replaceChildren();
      const card = el('div', { parent: flowSlot });
      card.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid rgba(184,144,255,0.3);border-radius:8px;background:rgba(120,90,200,0.05);align-items:center';
      const title = el('p', { parent: card, text: 'SCAN WITH YOUR WALLET' });
      title.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(184,144,255,0.9);letter-spacing:0.14em';
      const qrSlot = el('div', { parent: card });
      qrSlot.style.cssText = 'width:240px;height:240px;background:#fff;border-radius:8px;padding:10px;box-shadow:0 0 20px rgba(184,144,255,0.25)';
      const sub = el('p', { parent: card });
      sub.style.cssText = 'margin:0;font-size:0.74rem;color:rgba(220,210,255,0.7);text-align:center;line-height:1.45';
      sub.textContent = 'Phoenix, Wallet of Satoshi, Mutiny, Zeus, Cash App — any wallet that supports LNURL withdraw.';
      // BACK button — d-pad / mis-tap recovery before the mint
      // claim runs. Once claim resolves the sats are already on
      // balance and the QR is the way to drain them; backing out
      // after that is meaningless.
      let claimFired = false;
      const backBtn = el('button', { className: 'menu-btn secondary', parent: card, text: '← BACK' }) as HTMLButtonElement;
      backBtn.style.cssText = 'padding:6px 12px;cursor:pointer;font-size:0.78rem;align-self:flex-start';
      onTap(backBtn, () => {
        if (claimFired) return;
        unlockPicker();
      });

      void (async () => {
        setStatus('Crediting balance…', '#5b9dff');
        setIdlePaused?.(true);
        try {
          claimFired = true;
          backBtn.disabled = true;
          backBtn.style.opacity = '0.4';
          const claim = await runClaim();
          if (!claim.ok) {
            flowSlot.replaceChildren();
            setEnabled(true);
            return;
          }
          setStatus(`Minting QR for ${claim.amount} sats…`, '#5b9dff');
          const mint = await requestLnurlWithdraw(session, { amount_sats: claim.amount });
          if (!mint.ok) {
            setStatus(`Banked ${claim.amount} sats · QR mint failed: ${mint.error}`, '#ff8050');
            const note = el('p', { parent: card });
            note.style.cssText = 'margin:0;color:#ff8050;font-size:0.78rem';
            note.textContent = 'Sats sit safely on your balance — try the Lightning Address option, or withdraw on the title screen.';
            return;
          }
          // Render the bech32 LNURL as a QR. Upper-case keeps the QR
          // smaller (alphanumeric mode vs byte mode).
          void renderQRInto(qrSlot, mint.lnurl);
          setStatus('Waiting for your wallet to pull…', 'rgba(184,144,255,0.9)');

          // Poll for consumed/paid status every 2.5s, time out at the
          // server's TTL (15 min). Stop polling on success or failure.
          let polling = true;
          const stopPolling = (): void => { polling = false; };
          const tick = async (): Promise<void> => {
            if (!polling) return;
            const s = await pollLnurlWithdrawStatus(mint.k1);
            if (!polling) return;
            if (s.ok) {
              if (s.status === 'paid' || s.consumed) {
                setStatus(`✓ Paid ${claim.amount} sats — your wallet has them`, '#58ff58');
                stopPolling();
                return;
              }
              if (s.status === 'expired' || s.expires_at <= Date.now()) {
                setStatus(`Banked ${claim.amount} sats · QR expired (sats refunded to balance)`, '#ff8050');
                stopPolling();
                return;
              }
            }
            window.setTimeout(() => void tick(), 2500);
          };
          void tick();
        } finally {
          setIdlePaused?.(false);
        }
      })();
    });
  }
}

// ── Completion screen (wave 25 cleared) ──────────────────────────────────────


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
/** FUCHS2 · 11 JUNE party card — appears above the claim picker on
 *  every Sanctum game-over. Sacred-number wordmark + party details +
 *  QR code to 600.wtf so phone players can tap-or-scan their way to
 *  the canonical site without typing a URL. */
function renderFuchs2Card(overlay: HTMLElement): void {
  const card = el('div', { parent: overlay });
  card.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center',
    'gap:8px', 'padding:16px 20px', 'margin:8px 0',
    'background:linear-gradient(180deg, rgba(255,138,58,0.12), rgba(40,16,8,0.85))',
    'border:1px solid rgba(255,216,74,0.5)',
    'border-radius:8px',
    'max-width:420px', 'width:100%',
    'box-shadow:0 0 30px rgba(255,138,58,0.25)',
  ].join(';');

  // 4-line sacred number wordmark — canon-formatted.
  const number = el('div', { parent: card });
  number.style.cssText = 'font:bold 18px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.16em;line-height:1.1;text-align:center;text-shadow:0 0 10px rgba(255,138,58,0.5);';
  number.innerHTML = '600<br>000<br>000<br>000';

  // Party banner.
  const banner = el('div', { parent: card, text: 'PRAGUE PARTY · 11 JUNE 2026' });
  banner.style.cssText = 'font:bold 13px ui-monospace,monospace;color:#fff5d8;letter-spacing:0.22em;margin-top:6px;';

  const venue = el('div', { parent: card, text: 'FUCHS2 · OSTROV ŠTVANICE' });
  venue.style.cssText = 'font:11px ui-monospace,monospace;color:rgba(255,245,216,0.75);letter-spacing:0.16em;';

  // QR code anchor — clickable so desktop users can just tap.
  const link = el('a', { parent: card }) as HTMLAnchorElement;
  link.href = 'https://600.wtf';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;margin-top:6px;text-decoration:none;';

  const qrCanvas = el('canvas', { parent: link }) as HTMLCanvasElement;
  qrCanvas.style.cssText = 'background:#fff5d8;padding:6px;border-radius:4px;';
  void QRCode.toCanvas(qrCanvas, 'https://600.wtf', {
    width: 140,
    margin: 0,
    color: { dark: '#0a0418', light: '#fff5d8' },
  }).catch(() => undefined);

  const url = el('div', { parent: link, text: '600.wtf · TAP' });
  url.style.cssText = 'font:bold 12px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.2em;margin-top:4px;';
}

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

  // 600bn Sanctum runs land here too — surface the FUCHS2 party card
  // above the claim picker so every Sanctum game-over funnels traffic
  // back to the canonical 600.wtf URL.
  if (state.sanctum) {
    renderFuchs2Card(overlay);
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
  // Replay-publish status badge — visible to the player on the
  // game-over screen so they don't need to open dev tools. Inserted
  // after the score/sats summary; replaced once publishReplay's
  // promise resolves.
  const replayStatus = el('div', { parent: overlay });
  replayStatus.style.cssText = 'margin:8px auto;padding:6px 12px;border-radius:6px;font-family:monospace;font-size:0.78rem;letter-spacing:0.08em;max-width:520px;text-align:center;';
  const setReplayBadge = (kind: 'pending' | 'ok' | 'skip' | 'fail', text: string): void => {
    const COLOURS: Record<typeof kind, [string, string]> = {
      pending: ['rgba(255,216,74,0.85)', 'rgba(255,216,74,0.18)'],
      ok:      ['#8cffb4',              'rgba(140,255,180,0.18)'],
      skip:    ['rgba(220,210,255,0.7)', 'rgba(180,140,255,0.10)'],
      fail:    ['rgba(255,120,120,0.95)', 'rgba(255,120,120,0.15)'],
    };
    const [fg, bg] = COLOURS[kind];
    replayStatus.style.color = fg;
    replayStatus.style.background = bg;
    replayStatus.style.border = `1px solid ${fg}55`;
    replayStatus.textContent = text;
  };

  if (state.session) {
    console.log(`[replay] game-over · session=${state.session.pubkey.slice(0, 8)}… cheated=${state.cheatedThisRun} score=${state.score} wave=${state.wave}`);
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
    // Full-world replay (kind 30764) — built from the buffered wire
    // frames we shipped at 30 Hz during the run. Cheated runs and
    // sub-2-frame runs are skipped (publishReplay validates internally).
    // Decoupled from the score claim — sign-capable sessions leave a
    // replay even when they don't claim, same policy as the ghost.
    if (state.cheatedThisRun) {
      console.warn('[replay] skipping kind 30764 — run was cheated');
      setReplayBadge('skip', '⚠ REPLAY SKIPPED · cheated this run (sat-void on first cheat)');
    } else {
      // Blossom-style single-blob publish: gzip the whole run → PUT to
      // faucet's content-addressed store → sign ONE kind 30764 pointer
      // event tagging the URL + hash. Two signs total for the replay
      // (NIP-98 auth + pointer event). Replaces the previous per-wave
      // chunking pipeline that signed 25+ events sequentially and
      // wedged bunker-backed signers under sustained load.
      const remainingBuffer = getReplayBuffer();
      console.log(`[replay] game-over · ${remainingBuffer.length} frame(s) in buffer`);
      if (remainingBuffer.length < 2) {
        setReplayBadge('fail', `✗ REPLAY EMPTY · only ${remainingBuffer.length} frame(s) buffered`);
      } else {
        const session = state.session;
        const score = state.score;
        const finalWave = state.wave;
        const durationMs = Math.max(0, Math.floor(state.runTimeMs));
        // Cache the gzipped frames across retries. First click gzips
        // (~500ms for a 14k-frame run on a phone); subsequent RETRY
        // clicks reuse the same bytes. Caller-side caching keeps
        // publishReplay's interface clean — it doesn't need to know
        // about retry semantics.
        let cachedGzip: Uint8Array | null = null;
        // Tells the player WHAT to do, not just THAT it failed. Most
        // common failure mode: bark's service worker fell asleep mid-
        // session and the signEvent times out. The remedy is opening
        // the extension to wake it.
        const signerHint = 'Your Nostr signer didn\'t respond. Open your extension (bark / nsec.app / your bunker), make sure it\'s unlocked, then click RETRY.';
        const renderRetryBadge = (msg: string, hint: string): void => {
          replayStatus.innerHTML = '';
          replayStatus.style.color = 'rgba(255,120,120,0.95)';
          replayStatus.style.background = 'rgba(255,120,120,0.15)';
          replayStatus.style.border = '1px solid rgba(255,120,120,0.55)';
          const line = el('span', { parent: replayStatus, text: msg + ' · ' });
          void line;
          const retry = el('button', { parent: replayStatus, text: 'RETRY' });
          retry.style.cssText = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,120,120,0.7);color:#fff;padding:2px 10px;border-radius:4px;font-family:monospace;font-size:0.78rem;letter-spacing:0.1em;cursor:pointer;margin-left:6px;';
          retry.addEventListener('click', tryPublish);
          const hintEl = el('div', { parent: replayStatus, text: hint });
          hintEl.style.cssText = 'font-size:0.72rem;margin-top:4px;color:rgba(220,210,255,0.75);letter-spacing:0.04em;line-height:1.4;';
        };
        const tryPublish = (): void => {
          setReplayBadge('pending', `📼 REPLAY · ${cachedGzip ? 'retrying' : 'uploading'} ${remainingBuffer.length} frames…`);
          void (async () => {
            try {
              if (!cachedGzip) {
                cachedGzip = await gzipReplayFrames(remainingBuffer);
                if (!cachedGzip) {
                  renderRetryBadge('✗ REPLAY FAILED · gzip error', 'Compression failed on your device. Try again, or play a shorter run.');
                  return;
                }
                console.log(`[replay] gzipped ${remainingBuffer.length} frames → ${cachedGzip.byteLength}B (cached for retries)`);
              }
              const signed = await publishReplay({
                session,
                finalScore: score,
                finalWave,
                durationMs,
                frames: remainingBuffer,
                gzippedFrames: cachedGzip,
              });
              if (signed) setReplayBadge('ok', `✓ REPLAY PUBLISHED · ${signed.id.slice(0, 8)}…`);
              else renderRetryBadge('✗ REPLAY FAILED', signerHint);
            } catch (err) {
              renderRetryBadge(`✗ REPLAY THREW · ${err instanceof Error ? err.message : String(err)}`, signerHint);
            }
          })();
        };
        tryPublish();
      }
    }
  } else {
    console.warn('[replay] no kind 30763/30764 published — guest run (state.session is null). Sign in to enable replays.');
    setReplayBadge('skip', '— REPLAY OFF · guest mode (sign in to publish replays)');
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
  // Same identity-driven high-score handling as renderGameOver — auto-
  // save under the session display name, advance to celebration. The
  // 4-char arcade picker pre-stage is gone now that every run has a
  // signed-in identity attached at the front door.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh && !state.initialsEnteredThisRun) {
    addLocalHighScore({
      name: scoreboardNameFor(state),
      score: state.score,
      sats: state.sats,
      wave: 25,
      at: new Date().toISOString(),
      pubkey: state.session?.pubkey,
    });
    state.initialsEnteredThisRun = true;
  }
  renderCompletionRecap(state);
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
      // Explicit quiet zone — 2 modules of white border baked into the
      // SVG. Was margin: 0 previously, which relied on CSS padding for
      // the quiet zone. Most camera scanners examine the rendered
      // bitmap and want the quiet zone INSIDE the QR bounding box, so
      // CSS padding around an external div is not always enough on a
      // motion-blurred mobile capture.
      margin: 2,
      width: 256,
      // 'M' instead of 'L' — same Version 2 (25 modules) for our ~40
      // char pairing URL, but ~15% error correction so a partial
      // occlusion / motion blur / camera glare doesn't kill the
      // decode. Cheap insurance.
      errorCorrectionLevel: 'M',
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

/**
 * Modal that surfaces the player's guest identity in NIP-19 bech32
 * form (npub for the public key, nsec for the secret key). Read-only
 * — for backup / portability use only. The nsec is hidden behind a
 * "Show secret key" toggle so a casual screenshot or a shoulder-surf
 * doesn't leak it. Both fields have a one-tap copy button.
 *
 * Pasting the nsec into a Nostr client like Damus, Amethyst, nsec.app
 * or a NIP-46 bunker recreates this identity there — useful when a
 * player loved their guest profile and wants to keep it after
 * upgrading device, OR when they want to bind it to a real bunker
 * for cross-device portability.
 */
function openGuestKeyExport(pubkeyHex: string, privkeyHex: string): void {
  document.querySelectorAll('.guest-key-modal').forEach((n) => n.remove());

  const modal = el('div', { className: 'guest-key-modal', parent: root });
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(2,5,13,0.92);display:flex;align-items:center;justify-content:center;z-index:1000;padding:18px;';
  const inner = el('div', { parent: modal });
  inner.style.cssText = 'background:#02050d;border:1px solid rgba(140,255,180,0.45);border-radius:12px;padding:20px;max-width:520px;width:100%;display:flex;flex-direction:column;gap:12px;font-family:ui-monospace,monospace;box-shadow:0 0 30px rgba(140,255,180,0.18);max-height:90vh;overflow-y:auto;';

  el('h2', { parent: inner, text: 'EXPORT IDENTITY' }).style.cssText = 'margin:0;font-size:1rem;letter-spacing:0.2em;color:#8cffb4;text-align:center;';
  const sub = el('p', { parent: inner, text: 'Back this identity up by copying the nsec into another Nostr client (Damus, Amethyst, nsec.app, your bunker). Anyone with this nsec controls your account.' });
  sub.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.7);line-height:1.5;margin:0;text-align:center;';

  // ── npub block — always visible, identifying ────────────────────────
  let npubBech: string;
  try { npubBech = encodeNpub(pubkeyHex); }
  catch { npubBech = `[failed to encode pubkey: ${pubkeyHex.slice(0, 8)}…]`; }
  const npubBlock = el('div', { parent: inner });
  npubBlock.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  el('span', { parent: npubBlock, text: '🔓 PUBLIC KEY (npub)' }).style.cssText = 'font-size:0.72rem;color:rgba(140,255,180,0.85);letter-spacing:0.18em;';
  const npubRow = el('div', { parent: npubBlock });
  npubRow.style.cssText = 'display:flex;align-items:stretch;gap:6px;';
  const npubText = el('div', { parent: npubRow, text: npubBech });
  npubText.style.cssText = 'flex:1;padding:8px 10px;background:rgba(2,5,13,0.6);border:1px solid rgba(140,255,180,0.25);border-radius:6px;font-size:0.78rem;color:#fff5d8;word-break:break-all;line-height:1.4;user-select:all;';
  const npubCopy = el('button', { parent: npubRow, text: 'COPY' }) as HTMLButtonElement;
  npubCopy.style.cssText = 'flex:0 0 auto;padding:8px 14px;background:rgba(140,255,180,0.12);border:1px solid rgba(140,255,180,0.55);border-radius:6px;color:#8cffb4;font-family:inherit;font-size:0.78rem;letter-spacing:0.14em;cursor:pointer;';
  npubCopy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(npubBech).then(
      () => { npubCopy.textContent = 'COPIED'; window.setTimeout(() => { npubCopy.textContent = 'COPY'; }, 1400); },
      () => { npubCopy.textContent = 'FAIL'; },
    );
  });

  // ── nsec block — hidden behind reveal toggle ────────────────────────
  let nsecBech: string;
  try { nsecBech = encodeNsec(privkeyHex); }
  catch { nsecBech = `[failed to encode privkey]`; }
  const nsecBlock = el('div', { parent: inner });
  nsecBlock.style.cssText = 'display:flex;flex-direction:column;gap:4px;border-top:1px dashed rgba(255,120,120,0.3);padding-top:12px;';
  el('span', { parent: nsecBlock, text: '🔐 SECRET KEY (nsec) — KEEP PRIVATE' }).style.cssText = 'font-size:0.72rem;color:rgba(255,120,120,0.95);letter-spacing:0.18em;';
  const warning = el('p', { parent: nsecBlock, text: 'This is the master key for your identity. Anyone with it can post as you, send your sats, and delete your runs. Never share it. Never paste it into a website you don\'t trust.' });
  warning.style.cssText = 'font-size:0.72rem;color:rgba(255,160,120,0.85);line-height:1.5;margin:0;';

  const nsecRow = el('div', { parent: nsecBlock });
  nsecRow.style.cssText = 'display:flex;align-items:stretch;gap:6px;';
  // Hidden by default — replaced with a literal "REVEAL" placeholder
  // so a casual screenshot or shoulder-surf can't leak the nsec.
  const nsecText = el('div', { parent: nsecRow, text: '••••••••••••••••••••••••••••••••' });
  nsecText.style.cssText = 'flex:1;padding:8px 10px;background:rgba(2,5,13,0.6);border:1px solid rgba(255,120,120,0.35);border-radius:6px;font-size:0.78rem;color:rgba(255,160,120,0.85);word-break:break-all;line-height:1.4;user-select:all;';
  const revealBtn = el('button', { parent: nsecRow, text: 'REVEAL' }) as HTMLButtonElement;
  revealBtn.style.cssText = 'flex:0 0 auto;padding:8px 14px;background:rgba(255,120,120,0.12);border:1px solid rgba(255,120,120,0.55);border-radius:6px;color:#ff8a8a;font-family:inherit;font-size:0.78rem;letter-spacing:0.14em;cursor:pointer;';
  let revealed = false;
  revealBtn.addEventListener('click', () => {
    revealed = !revealed;
    nsecText.textContent = revealed ? nsecBech : '••••••••••••••••••••••••••••••••';
    nsecText.style.color = revealed ? '#fff5d8' : 'rgba(255,160,120,0.85)';
    revealBtn.textContent = revealed ? 'HIDE' : 'REVEAL';
  });
  const nsecCopy = el('button', { parent: nsecRow, text: 'COPY' }) as HTMLButtonElement;
  nsecCopy.style.cssText = 'flex:0 0 auto;padding:8px 14px;background:rgba(255,120,120,0.12);border:1px solid rgba(255,120,120,0.55);border-radius:6px;color:#ff8a8a;font-family:inherit;font-size:0.78rem;letter-spacing:0.14em;cursor:pointer;';
  nsecCopy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(nsecBech).then(
      () => { nsecCopy.textContent = 'COPIED'; window.setTimeout(() => { nsecCopy.textContent = 'COPY'; }, 1400); },
      () => { nsecCopy.textContent = 'FAIL'; },
    );
  });

  // ── How to restore — short instruction block ────────────────────────
  const how = el('div', { parent: inner });
  how.style.cssText = 'border-top:1px dashed rgba(220,210,255,0.15);padding-top:10px;font-size:0.74rem;color:rgba(220,210,255,0.6);line-height:1.5;';
  how.innerHTML = 'To restore on another device: paste the nsec into any Nostr client that supports nsec import (Damus iOS, Amethyst Android, nsec.app web, your bunker). Or upgrade in-game by tapping <strong>UPGRADE TO NOSTR</strong> on the title screen.';

  // ── Close button ────────────────────────────────────────────────────
  const closeRow = el('div', { parent: inner });
  closeRow.style.cssText = 'display:flex;justify-content:center;margin-top:6px;';
  const closeBtn = el('button', { className: 'menu-btn', parent: closeRow, text: 'DONE' }) as HTMLButtonElement;
  closeBtn.style.cssText += 'font-size:0.85rem;padding:8px 24px;letter-spacing:0.18em;';
  const close = (): void => { modal.remove(); window.removeEventListener('keydown', onKey); };
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const onKey = (e: KeyboardEvent): void => { if (e.code === 'Escape') close(); };
  window.addEventListener('keydown', onKey);
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

// ── Admin v2 panel ────────────────────────────────────────────────────────────
//
// NIP-98 + pubkey-allowlist gated. Lives at /admin. Lets TheCryptoDonkey
// (or whichever pubkey ADMIN_PUBKEY_HEX names server-side) flip caps,
// pause the pool, apply NORMAL / CONFERENCE / FROZEN presets without
// SSH-ing in for raw SQL. Authentication is implicit: the server only
// accepts events signed by the admin pubkey, so a non-admin who lands
// here just sees a 403 and a "not authorised" hint.

/** Format a unix-ms timestamp as a relative-time hint ("3m ago"). */
function relativeTime(unixMs: number): string {
  const dt = Date.now() - unixMs;
  if (dt < 0) {
    const ahead = Math.floor(-dt / 1000);
    if (ahead < 60) return `in ${ahead}s`;
    if (ahead < 3600) return `in ${Math.floor(ahead / 60)}m`;
    return `in ${Math.floor(ahead / 3600)}h`;
  }
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function renderAdminV2Panel(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  overlay.style.cssText = 'padding:20px;max-width:720px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;';
  setupOverlayArrowNav(overlay);

  el('h2', { parent: overlay, text: 'ADMIN' }).style.cssText = 'margin:0;font-size:1.2rem;letter-spacing:0.22em;color:#ffd84a;';

  const session = state.session;
  if (!session) {
    const note = el('p', { parent: overlay });
    note.style.cssText = 'font-size:0.9rem;color:#ff8050';
    note.textContent = 'Sign in first — admin actions are NIP-98 signed.';
    const back = el('button', { className: 'menu-btn', parent: overlay, text: '← BACK' }) as HTMLButtonElement;
    back.addEventListener('click', () => { window.location.assign('/'); });
    return;
  }

  const status = el('p', { parent: overlay });
  status.style.cssText = 'min-height:1.2em;font-size:0.85rem;color:rgba(220,210,255,0.75)';
  const setStatus = (msg: string, color = '#5b9dff'): void => {
    status.textContent = msg;
    status.style.color = color;
  };

  const stateSlot = el('div', { parent: overlay });
  stateSlot.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

  let cached: AdminStateResult | null = null;

  const refresh = async (): Promise<void> => {
    setStatus('Loading…');
    const r = await fetchAdminState(session);
    if (r.ok) {
      cached = r;
      render(r);
      setStatus('');
    } else {
      cached = null;
      stateSlot.replaceChildren();
      if (r.error === 'not_authorised' || (r as { status?: number }).status === 403) {
        setStatus('Not authorised — your pubkey is not on the admin allowlist.', '#ff5050');
      } else if (r.error === 'service_not_configured') {
        setStatus('Admin v2 not configured on the server (set ADMIN_PUBKEY_HEX).', '#ff8050');
      } else {
        setStatus(`Load failed: ${r.error}`, '#ff8050');
      }
    }
  };

  const render = (data: Extract<AdminStateResult, { ok: true }>): void => {
    stateSlot.replaceChildren();

    // ── Status card ─────────────────────────────────────────────
    const stCard = el('div', { parent: stateSlot });
    stCard.style.cssText = 'padding:14px;border:1px solid rgba(91,157,255,0.4);border-radius:10px;background:rgba(91,157,255,0.06);display:grid;grid-template-columns:1fr 1fr;gap:10px;';
    const stat = (label: string, value: string, accent = '#fff5d8'): void => {
      const cell = el('div', { parent: stCard });
      cell.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
      const k = el('span', { parent: cell, text: label });
      k.style.cssText = 'font-size:0.66rem;letter-spacing:0.14em;color:rgba(220,210,255,0.6);';
      const v = el('span', { parent: cell, text: value });
      v.style.cssText = `font-size:0.95rem;color:${accent};font-family:monospace`;
    };
    stat('PHOENIXD BALANCE', data.phoenixd.balance_sat !== null ? `${data.phoenixd.balance_sat} sats` : '— unavailable —', data.phoenixd.balance_sat !== null ? '#8cffb4' : '#888');
    stat('LIFETIME PAID', `${data.pool.total_paid_sats} sats`);
    stat('TODAY SPENT', `${data.limits.today_spent_sats} / ${data.limits.daily_cap_sats}`, data.limits.today_spent_sats >= data.limits.daily_cap_sats ? '#ff8050' : '#fff5d8');
    stat('HOURLY CLAIMS', `${data.limits.hour_claims_count} / ${data.limits.hourly_cap_count}`, data.limits.hour_claims_count >= data.limits.hourly_cap_count ? '#ff8050' : '#fff5d8');
    stat('POOL STATE', data.pool.paused ? 'PAUSED' : 'LIVE', data.pool.paused ? '#ff5050' : '#58ff58');
    stat('FLAGGED PLAYERS', String(data.players.flagged_count), data.players.flagged_count > 0 ? '#ff8050' : '#fff5d8');
    const tokenSummary = data.withdraw_tokens.length === 0
      ? 'none'
      : data.withdraw_tokens.map(t => `${t.status}=${t.count}`).join(' · ');
    stat('LNURL TOKENS', tokenSummary);
    stat('LAST POOL SYNC', data.pool.last_synced_at ? relativeTime(data.pool.last_synced_at) : '—');

    // ── Presets ──────────────────────────────────────────────────
    const presetCard = el('div', { parent: stateSlot });
    presetCard.style.cssText = 'padding:14px;border:1px solid rgba(184,144,255,0.4);border-radius:10px;background:rgba(184,144,255,0.06);';
    const presetHead = el('h3', { parent: presetCard, text: 'PRESETS' });
    presetHead.style.cssText = 'margin:0 0 8px;font-size:0.9rem;letter-spacing:0.18em;color:#cbb6ff;';
    const presetRow = el('div', { parent: presetCard });
    presetRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';
    const mkPreset = (label: string, profile: 'normal' | 'conference' | 'frozen', accent: string): void => {
      const btn = el('button', { className: 'menu-btn', parent: presetRow, text: label }) as HTMLButtonElement;
      const p = data.presets[profile];
      btn.style.cssText = `flex:1 1 30%;min-width:160px;padding:12px 10px;border:1.5px solid ${accent};background:rgba(2,5,13,0.5);cursor:pointer;font-size:0.85rem;letter-spacing:0.14em;`;
      btn.title = p ? `daily=${p.daily_cap_sats} · per-claim=${p.per_claim_cap_sats} · hourly=${p.hourly_cap_count} · pause=${p.pause}` : '';
      btn.addEventListener('click', () => {
        void (async () => {
          if (!window.confirm(`Apply ${profile} preset?`)) return;
          setStatus(`Applying ${profile}…`);
          const r = await applyAdminPreset(session, profile);
          if (r.ok) await refresh();
          else setStatus(`Preset failed: ${r.error}`, '#ff8050');
        })();
      });
    };
    mkPreset('🟢 NORMAL', 'normal', 'rgba(140,255,180,0.55)');
    mkPreset('🟡 CONFERENCE', 'conference', 'rgba(255,216,74,0.55)');
    mkPreset('🔴 FROZEN', 'frozen', 'rgba(255,120,120,0.55)');

    // ── Manual caps ──────────────────────────────────────────────
    const capsCard = el('div', { parent: stateSlot });
    capsCard.style.cssText = 'padding:14px;border:1px solid rgba(140,255,180,0.4);border-radius:10px;background:rgba(60,200,140,0.06);display:flex;flex-direction:column;gap:10px;';
    el('h3', { parent: capsCard, text: 'MANUAL CAPS' }).style.cssText = 'margin:0;font-size:0.9rem;letter-spacing:0.18em;color:#8cffb4;';
    const capInput = (label: string, value: number): HTMLInputElement => {
      const row = el('div', { parent: capsCard });
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;';
      const lbl = el('label', { parent: row, text: label });
      lbl.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.8);letter-spacing:0.08em';
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.step = '1';
      inp.value = String(value);
      inp.style.cssText = 'padding:8px 10px;font-family:monospace;font-size:0.95rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:6px;width:140px;text-align:right';
      row.appendChild(inp);
      return inp;
    };
    const dailyInp = capInput('Daily cap (sats)', data.limits.daily_cap_sats);
    const perClaimInp = capInput('Per-claim cap (sats)', data.limits.per_claim_cap_sats);
    const hourlyInp = capInput('Hourly claim count', data.limits.hourly_cap_count);
    const saveBtn = el('button', { className: 'menu-btn', parent: capsCard, text: 'SAVE CAPS' }) as HTMLButtonElement;
    saveBtn.style.cssText = 'padding:10px 14px;font-size:0.9rem;cursor:pointer;letter-spacing:0.14em';
    saveBtn.addEventListener('click', () => {
      void (async () => {
        const caps = {
          daily_cap_sats: Math.max(0, Math.floor(Number(dailyInp.value))),
          per_claim_cap_sats: Math.max(0, Math.floor(Number(perClaimInp.value))),
          hourly_cap_count: Math.max(0, Math.floor(Number(hourlyInp.value))),
        };
        setStatus('Saving caps…');
        const r = await setAdminCaps(session, caps);
        if (r.ok) await refresh();
        else setStatus(`Save failed: ${r.error}`, '#ff8050');
      })();
    });

    // ── Pause toggle ─────────────────────────────────────────────
    const pauseCard = el('div', { parent: stateSlot });
    pauseCard.style.cssText = `padding:14px;border:1px solid ${data.pool.paused ? 'rgba(255,120,120,0.6)' : 'rgba(220,210,255,0.3)'};border-radius:10px;background:${data.pool.paused ? 'rgba(255,120,120,0.08)' : 'rgba(2,5,13,0.4)'};display:flex;justify-content:space-between;align-items:center;gap:10px;`;
    const pauseLabel = el('div', { parent: pauseCard });
    pauseLabel.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    const pHead = el('span', { parent: pauseLabel, text: 'CIRCUIT BREAKER' });
    pHead.style.cssText = 'font-size:0.78rem;letter-spacing:0.16em;color:rgba(220,210,255,0.85)';
    const pSub = el('span', { parent: pauseLabel, text: data.pool.paused ? 'All /api/claim returning 503' : 'Faucet live — claims paying out' });
    pSub.style.cssText = `font-size:0.72rem;color:${data.pool.paused ? '#ff8050' : 'rgba(220,210,255,0.55)'}`;
    const pauseBtn = el('button', { className: 'menu-btn', parent: pauseCard, text: data.pool.paused ? 'UNPAUSE' : 'PAUSE' }) as HTMLButtonElement;
    pauseBtn.style.cssText = `padding:10px 18px;font-size:0.9rem;cursor:pointer;letter-spacing:0.14em;border:1.5px solid ${data.pool.paused ? 'rgba(140,255,180,0.6)' : 'rgba(255,120,120,0.6)'};background:rgba(2,5,13,0.5);`;
    pauseBtn.addEventListener('click', () => {
      void (async () => {
        const target = !data.pool.paused;
        const reason = target ? window.prompt('Reason for pause? (optional)') ?? undefined : undefined;
        setStatus(target ? 'Pausing…' : 'Unpausing…');
        const r = await setAdminPause(session, target, reason);
        if (r.ok) await refresh();
        else setStatus(`Toggle failed: ${r.error}`, '#ff8050');
      })();
    });

    // ── Live settings (wave B) ──────────────────────────────────
    // Static-today constants made tunable: withdraw threshold, LNURL
    // bounds, per-tier lifetime caps + multipliers. Each row shows
    // current vs default. SAVE ALL fires one signed batch update.
    const settingsCard = el('div', { parent: stateSlot });
    settingsCard.style.cssText = 'padding:14px;border:1px solid rgba(220,210,255,0.3);border-radius:10px;background:rgba(2,5,13,0.4);display:flex;flex-direction:column;gap:10px;';
    el('h3', { parent: settingsCard, text: 'LIVE SETTINGS' }).style.cssText = 'margin:0;font-size:0.9rem;letter-spacing:0.18em;color:rgba(220,210,255,0.85);';
    const settingsHint = el('p', { parent: settingsCard, text: 'Tunable without redeploy. Defaults shown after each value when modified.' });
    settingsHint.style.cssText = 'margin:0;font-size:0.72rem;color:rgba(220,210,255,0.55);';
    const settingInputs: { key: string; input: HTMLInputElement }[] = [];
    const settingRow = (key: string, label: string, fractional = false): void => {
      const row = el('div', { parent: settingsCard });
      row.style.cssText = 'display:grid;grid-template-columns:1fr 140px 60px;gap:10px;align-items:center;';
      const lbl = el('label', { parent: row, text: label });
      lbl.style.cssText = 'font-size:0.78rem;color:rgba(220,210,255,0.8);letter-spacing:0.06em';
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = fractional ? '0.01' : '1';
      inp.min = '0';
      inp.value = String(data.settings[key] ?? data.setting_defaults[key] ?? 0);
      inp.style.cssText = 'padding:8px 10px;font-family:monospace;font-size:0.9rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:6px;text-align:right;';
      row.appendChild(inp);
      const def = el('span', { parent: row });
      def.style.cssText = 'font-size:0.66rem;color:rgba(180,180,180,0.5);font-family:monospace;text-align:right;';
      const defaultVal = data.setting_defaults[key];
      const liveVal = data.settings[key];
      def.textContent = liveVal !== defaultVal ? `def ${defaultVal}` : '';
      settingInputs.push({ key, input: inp });
    };
    settingRow('withdraw_threshold_sats', 'Withdraw threshold (sats)');
    settingRow('lnurl_min_sats',          'LNURL min (sats)');
    settingRow('lnurl_max_sats',          'LNURL max (sats)');
    settingRow('lnurl_ttl_ms',            'LNURL TTL (ms)');
    settingRow('tier_lifetime_anon',      'Anon lifetime cap');
    settingRow('tier_lifetime_nip05',     'Nip05 lifetime cap');
    settingRow('tier_lifetime_close',     'Close lifetime cap');
    settingRow('tier_lifetime_verified',  'Verified lifetime cap');
    settingRow('tier_multiplier_anon',     'Anon multiplier',     true);
    settingRow('tier_multiplier_nip05',    'Nip05 multiplier',    true);
    settingRow('tier_multiplier_close',    'Close multiplier',    true);
    settingRow('tier_multiplier_verified', 'Verified multiplier', true);
    // Gameplay knobs — exposed via /api/game-config (no auth) so the
    // client can read them at boot. Add new ones here as they ship.
    settingRow('bonus_wave_chance',         'Bonus wave chance (0-1)',         true);
    settingRow('powerup_drop_chance',       'Powerup drop chance (0-1)',       true);
    settingRow('sat_drop_denom',            'Sat drop 1-in-N');
    settingRow('starting_lives',            'Starting lives (0=difficulty)');
    settingRow('ufo_first_spawn_ms',        'UFO first spawn (ms)');
    settingRow('ufo_respawn_base_ms',       'UFO respawn base (ms)');
    settingRow('ufo_respawn_per_wave_ms',   'UFO respawn per-wave (ms)');
    settingRow('ufo_respawn_min_ms',        'UFO respawn min (ms)');
    settingRow('asteroid_count_multiplier', 'Asteroid count multiplier',       true);
    settingRow('checkin_sats',              'Daily check-in stipend (sats)');
    const saveSettingsBtn = el('button', { className: 'menu-btn', parent: settingsCard, text: 'SAVE ALL SETTINGS' }) as HTMLButtonElement;
    saveSettingsBtn.style.cssText = 'padding:10px 14px;font-size:0.85rem;cursor:pointer;letter-spacing:0.14em;align-self:flex-start';
    saveSettingsBtn.addEventListener('click', () => {
      void (async () => {
        const payload = settingInputs.map(({ key, input }) => ({
          key,
          value: Number(input.value),
        }));
        setStatus('Saving settings…');
        const r = await saveAdminSettings(session, payload);
        if (r.ok) {
          const appliedCount = r.applied?.length ?? 0;
          const skipped = r.skipped ?? [];
          if (skipped.length > 0) {
            setStatus(`Saved ${appliedCount}, skipped ${skipped.length} (${skipped.map(s => `${s.key}:${s.reason}`).join(', ')})`, '#ff8050');
          }
          await refresh();
        } else {
          setStatus(`Save failed: ${r.error}`, '#ff8050');
        }
      })();
    });

    // ── Player management ───────────────────────────────────────
    const playerCard = el('div', { parent: stateSlot });
    playerCard.style.cssText = 'padding:14px;border:1px solid rgba(255,140,200,0.4);border-radius:10px;background:rgba(255,140,200,0.06);display:flex;flex-direction:column;gap:10px;';
    el('h3', { parent: playerCard, text: 'PLAYER' }).style.cssText = 'margin:0;font-size:0.9rem;letter-spacing:0.18em;color:#ffacd5;';
    const lookupRow = el('div', { parent: playerCard });
    lookupRow.style.cssText = 'display:flex;gap:8px;';
    const npubInput = document.createElement('input');
    npubInput.type = 'text';
    npubInput.placeholder = 'npub1… or 64-char hex';
    npubInput.spellcheck = false;
    npubInput.autocapitalize = 'off';
    npubInput.autocomplete = 'off';
    npubInput.style.cssText = 'flex:1;padding:8px 10px;font-family:monospace;font-size:0.85rem;background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:6px';
    lookupRow.appendChild(npubInput);
    const lookupBtn = el('button', { className: 'menu-btn', parent: lookupRow, text: 'LOOKUP' }) as HTMLButtonElement;
    lookupBtn.style.cssText = 'padding:8px 14px;font-size:0.85rem;cursor:pointer;letter-spacing:0.12em';
    const playerSlot = el('div', { parent: playerCard });
    playerSlot.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

    const renderPlayerCard = (p: AdminPlayer): void => {
      playerSlot.replaceChildren();
      const head = el('div', { parent: playerSlot });
      head.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;font-family:monospace;font-size:0.8rem;';
      const stat = (k: string, v: string, color = '#fff5d8'): void => {
        const cell = el('div', { parent: head });
        cell.style.cssText = 'display:flex;flex-direction:column;gap:2px';
        const kEl = el('span', { parent: cell, text: k });
        kEl.style.cssText = 'font-size:0.62rem;letter-spacing:0.14em;color:rgba(220,210,255,0.55)';
        const vEl = el('span', { parent: cell, text: v });
        vEl.style.cssText = `font-size:0.85rem;color:${color}`;
      };
      stat('PUBKEY', `${p.pubkey.slice(0, 12)}…${p.pubkey.slice(-6)}`);
      stat('TIER', p.tier_override ? `${p.tier_override} (override)` : p.tier, p.tier_override ? '#ffd84a' : '#fff5d8');
      stat('BALANCE', `${p.balance_sats} sats`);
      stat('LIFETIME PAID', `${p.lifetime_paid_sats} sats`);
      stat('CLAIMS', String(p.claims_count));
      stat('BEST', `${p.best_score} · W${p.best_wave}`);
      stat('FLAGGED', p.flagged ? 'YES' : 'no', p.flagged ? '#ff5050' : '#fff5d8');
      stat('OPEN LNURL', String(p.open_withdraw_tokens), p.open_withdraw_tokens > 0 ? '#ffd84a' : '#fff5d8');

      const actions = el('div', { parent: playerSlot });
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;';

      // Flag / unflag
      const flagBtn = el('button', { className: 'menu-btn', parent: actions, text: p.flagged ? 'UNFLAG' : 'FLAG' }) as HTMLButtonElement;
      flagBtn.style.cssText = `padding:8px 14px;font-size:0.78rem;cursor:pointer;letter-spacing:0.1em;border:1.5px solid ${p.flagged ? 'rgba(140,255,180,0.55)' : 'rgba(255,120,120,0.55)'}`;
      flagBtn.addEventListener('click', () => {
        void (async () => {
          const reason = window.prompt(p.flagged ? 'Reason for unflagging?' : 'Reason for flagging?') ?? undefined;
          setStatus(p.flagged ? 'Unflagging…' : 'Flagging…');
          const r = await setAdminPlayerFlag(session, p.pubkey, !p.flagged, reason);
          if (r.ok) {
            setStatus(p.flagged ? 'Unflagged.' : 'Flagged.', '#58ff58');
            await loadPlayer(p.pubkey);
            void refresh();
          } else {
            setStatus(`Action failed: ${r.error}`, '#ff8050');
          }
        })();
      });

      // Balance adjust
      const balanceBtn = el('button', { className: 'menu-btn', parent: actions, text: 'ADJUST BALANCE' }) as HTMLButtonElement;
      balanceBtn.style.cssText = 'padding:8px 14px;font-size:0.78rem;cursor:pointer;letter-spacing:0.1em;border:1.5px solid rgba(255,216,74,0.55)';
      balanceBtn.addEventListener('click', () => {
        void (async () => {
          const raw = window.prompt('Delta sats (negative to debit, positive to credit):');
          if (raw === null) return;
          const delta = Math.floor(Number(raw));
          if (!Number.isFinite(delta) || delta === 0) {
            setStatus('Invalid delta.', '#ff5050');
            return;
          }
          const reason = window.prompt('Reason? (optional)') ?? undefined;
          setStatus('Adjusting balance…');
          const r = await adjustAdminPlayerBalance(session, p.pubkey, delta, reason);
          if (r.ok) {
            setStatus(`Balance ${delta > 0 ? '+' : ''}${delta} → ${r.balance_sats}`, '#58ff58');
            await loadPlayer(p.pubkey);
          } else {
            setStatus(`Adjust failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`, '#ff8050');
          }
        })();
      });

      // Tier override
      const tierWrap = el('div', { parent: actions });
      tierWrap.style.cssText = 'display:flex;gap:6px;align-items:center;border:1.5px solid rgba(184,144,255,0.55);border-radius:6px;padding:6px 10px;';
      const tierLbl = el('span', { parent: tierWrap, text: 'TIER OVERRIDE' });
      tierLbl.style.cssText = 'font-size:0.66rem;letter-spacing:0.12em;color:rgba(184,144,255,0.8)';
      const tierSel = document.createElement('select');
      tierSel.style.cssText = 'background:#0a0a0a;color:#eee;border:1px solid #333;border-radius:4px;padding:4px 6px;font-size:0.78rem;font-family:monospace';
      const opts: Array<['', 'anon', 'nip05', 'close', 'verified']> = [['', 'anon', 'nip05', 'close', 'verified']];
      for (const v of opts[0]) {
        const o = document.createElement('option');
        o.value = v;
        o.text = v === '' ? '— none —' : v;
        if ((p.tier_override ?? '') === v) o.selected = true;
        tierSel.appendChild(o);
      }
      tierWrap.appendChild(tierSel);
      const tierApply = el('button', { className: 'menu-btn secondary', parent: tierWrap, text: 'APPLY' }) as HTMLButtonElement;
      tierApply.style.cssText = 'padding:4px 10px;font-size:0.72rem;cursor:pointer';
      tierApply.addEventListener('click', () => {
        void (async () => {
          const v = tierSel.value as '' | 'anon' | 'nip05' | 'close' | 'verified';
          const tier = v === '' ? null : v;
          const reason = window.prompt('Reason for tier override?') ?? undefined;
          setStatus('Updating tier override…');
          const r = await setAdminPlayerTier(session, p.pubkey, tier, reason);
          if (r.ok) {
            setStatus(`Tier override = ${tier ?? 'cleared'}`, '#58ff58');
            await loadPlayer(p.pubkey);
          } else {
            setStatus(`Tier update failed: ${r.error}`, '#ff8050');
          }
        })();
      });
    };

    const loadPlayer = async (pubkey: string): Promise<void> => {
      setStatus('Loading player…');
      const r = await fetchAdminPlayer(session, pubkey);
      if (r.ok) {
        renderPlayerCard(r.player);
        setStatus('');
      } else {
        playerSlot.replaceChildren();
        if (r.error === 'not_found') {
          setStatus('Player not found.', '#ff8050');
        } else {
          setStatus(`Lookup failed: ${r.error}`, '#ff8050');
        }
      }
    };

    lookupBtn.addEventListener('click', () => {
      const raw = npubInput.value.trim();
      if (!raw) return;
      // Accept npub1… or 64-char hex.
      let pubkey: string | null = null;
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        pubkey = raw.toLowerCase();
      } else if (raw.startsWith('npub1')) {
        pubkey = decodeNpub(raw);
      }
      if (!pubkey) {
        setStatus('Invalid pubkey — expecting npub1… or 64-char hex.', '#ff5050');
        return;
      }
      void loadPlayer(pubkey);
    });
    npubInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') lookupBtn.click();
    });

    // ── Footer ───────────────────────────────────────────────────
    const footer = el('div', { parent: stateSlot });
    footer.style.cssText = 'display:flex;gap:10px;margin-top:6px;';
    const refreshBtn = el('button', { className: 'menu-btn secondary', parent: footer, text: '↻ REFRESH' }) as HTMLButtonElement;
    refreshBtn.style.cssText = 'padding:8px 14px;font-size:0.78rem;cursor:pointer;letter-spacing:0.12em';
    refreshBtn.addEventListener('click', () => { void refresh(); });
    const backBtn = el('button', { className: 'menu-btn secondary', parent: footer, text: '← BACK TO TITLE' }) as HTMLButtonElement;
    backBtn.style.cssText = 'padding:8px 14px;font-size:0.78rem;cursor:pointer;letter-spacing:0.12em';
    backBtn.addEventListener('click', () => { window.location.assign('/'); });
  };

  void refresh();
  // Suppress unused warning if cached is touched elsewhere later.
  void cached;
}
