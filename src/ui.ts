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
import * as auth from './auth.js';
import { addLocalHighScore, getLocalHighScores, isHighScore, fetchGlobalHighScores, clearLocalHighScores, type GlobalHighScore } from './score.js';
import { submitClaim, fetchPool, fetchPlayer, type PlayerTier } from './faucet.js';
import { renderLegalFooter } from './legal.js';
import { startGame, startDeathReplay, toastNow } from './game.js';
import * as audio from './audio.js';
import { fetchProfile, getCachedProfile, bestName } from './profile.js';
import { type Difficulty, getStoredDifficulty, setStoredDifficulty, lockInDifficulty } from './difficulty.js';
import { getStoredDailyPref, setStoredDailyPref, todayUTC, getActiveSeed } from './seed.js';
import { DEV } from './credits.js';
import { followUser, shareCompletion, endorseSubject, rankFromWave } from './social.js';
import { requestZapInvoice, hasWebLN, payViaWebLN } from './zap.js';
import { publishGhost, prefetchTopGhost } from './ghost.js';
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
  banner.style.cssText = [
    'position:fixed',
    'top:max(12px, env(safe-area-inset-top, 0px))',
    'left:50%', 'transform:translateX(-50%)',
    'z-index:200',
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
  ].join(';');
  banner.innerHTML = `<span>NEW VERSION READY</span><button type="button" style="font-family:inherit;font-size:0.95rem;letter-spacing:0.18em;padding:6px 14px;background:rgba(255,216,74,0.15);border:1px solid #ffd84a;color:#ffd84a;border-radius:6px;cursor:pointer;">RELOAD</button>`;
  banner.querySelector('button')!.addEventListener('click', () => {
    banner.querySelector('span')!.textContent = 'UPDATING...';
    (banner.querySelector('button') as HTMLButtonElement).disabled = true;
    onReload();
  });
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

  // Wordmark image rendered with mix-blend-mode: screen so the baked-in
  // black starfield bg drops out and only the green lettering floats over
  // the cycling wave background. The text is preserved as alt for screen
  // readers and shows if the image fails to load.
  const titleLogo = el('img', { parent: overlay });
  titleLogo.className = 'title-logo';
  (titleLogo as HTMLImageElement).src = '/logo.webp';
  (titleLogo as HTMLImageElement).alt = 'PALLASITE';
  (titleLogo as HTMLImageElement).decoding = 'async';
  const tagline = el('p', { parent: overlay, text: 'SHOOT ROCKS · STACK SATS' });
  tagline.style.cssText = 'font-size:1.2rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-12px;';
  el('p', { parent: overlay, text: 'Cosmic arcade · Lightning sats · Nostr leaderboards' });

  renderPoolChip(overlay);

  const sessionPanel = el('div', { className: 'session-panel', parent: overlay });
  renderSessionPanel(sessionPanel, state);

  // Difficulty selector
  renderDifficultyRow(overlay);

  // Daily / Free toggle
  renderDailyRow(overlay);

  const row = el('div', { className: 'menu-row', parent: overlay });
  const startBtn = el('button', { className: 'menu-btn', parent: row, text: 'IGNITE · PRESS ENTER' });
  startBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    onStartCb?.();
  });
  const howBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'HOW TO PLAY' });
  howBtn.addEventListener('click', () => renderHowToPlay(() => renderTitle(state)));
  const settingsBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SETTINGS' });
  settingsBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    renderSettings(() => renderTitle(state));
  });

  // Show local high scores under the start button if any exist
  const list = getLocalHighScores();
  if (list.length > 0) {
    renderLeaderboardBlock(overlay, list, '— LOCAL HIGH SCORES —');
  }

  // Global leaderboard from kind 30762 events on relays. Rendered async so
  // the title screen never blocks on a network round-trip — show a placeholder
  // while it loads, swap in the real list when the relays answer.
  renderGlobalLeaderboard(overlay);

  renderLegalFooter(overlay);

  // Keyboard cheatsheet removed — HOW TO PLAY button covers the same content
  // and the duplicate strip cramped the desktop layout against the high scores.
}

/**
 * Two-line faucet status chip. Float = working balance on the box;
 * Paid lifetime = sum of payouts. Polled every 60s while the title is
 * visible. Float drops on each Sunday sweep — Paid does not — so showing
 * both keeps the sweep from looking like a faucet drain.
 */
function renderPoolChip(parent: HTMLElement): void {
  const wrapper = el('div', { parent });
  wrapper.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:4px;margin:6px 0 4px';

  const lineFloat = el('p', { parent: wrapper });
  const linePaid = el('p', { parent: wrapper });
  for (const line of [lineFloat, linePaid]) {
    line.style.cssText =
      'font-size:0.78rem;color:rgba(255,216,74,0.65);letter-spacing:0.08em;margin:0';
  }
  lineFloat.textContent = 'Float: …';
  linePaid.textContent = 'Paid lifetime: …';

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
      lineFloat.textContent = 'Faucet status unavailable';
      lineFloat.style.color = 'rgba(180,180,180,0.6)';
      linePaid.textContent = '';
      meterWrap.style.display = 'none';
      return;
    }
    const lowFloat = pool.balance_sats < 1000;
    const floatStr = `Float: ${pool.balance_sats.toLocaleString()} sats`;
    if (pool.paused) {
      lineFloat.textContent = `${floatStr} — paused`;
      lineFloat.style.color = '#ff8050';
    } else if (lowFloat) {
      lineFloat.textContent = `${floatStr} — zap to refill`;
      lineFloat.style.color = '#ff8050';
    } else {
      lineFloat.textContent = floatStr;
      lineFloat.style.color = 'rgba(255,216,74,0.65)';
    }
    linePaid.textContent = `Paid lifetime: ${pool.total_paid_sats.toLocaleString()} sats`;

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

function renderGlobalLeaderboard(parent: HTMLElement): void {
  const container = el('div', { parent });
  const block = el('div', { className: 'leaderboard-block', parent: container });
  el('p', { className: 'leaderboard-title', parent: block, text: '— GLOBAL HIGH SCORES —' });
  const status = el('p', { parent: block, text: 'Loading from relays…' });
  status.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.7);letter-spacing:0.06em;margin:0;';

  void fetchGlobalHighScores().then(async raw => {
    if (!container.isConnected) return;
    if (raw.length === 0) {
      status.textContent = 'No global scores yet — be the first.';
      return;
    }
    const top = raw.slice(0, 5);
    const entries = await Promise.all(top.map(resolveDisplayName));
    if (!container.isConnected) return;
    container.innerHTML = '';
    renderLeaderboardBlock(container, entries.map(globalToLocal), '— GLOBAL HIGH SCORES —');
  }).catch(() => {
    if (!container.isConnected) return;
    status.textContent = 'Could not reach relays.';
  });
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

function renderLeaderboardBlock(parent: HTMLElement, list: ReturnType<typeof getLocalHighScores>, title: string, max = 5): void {
  const block = el('div', { className: 'leaderboard-block', parent });
  el('p', { className: 'leaderboard-title', parent: block, text: title });
  const table = el('div', { className: 'leaderboard-table', parent: block });
  list.slice(0, max).forEach((entry, i) => {
    el('div', { className: 'rank', parent: table, text: String(i + 1).padStart(2, '0') });
    el('div', { className: 'name', parent: table, text: entry.name });
    el('div', { className: 'score', parent: table, text: String(entry.score).padStart(6, '0') });
    el('div', { className: 'sats', parent: table, text: entry.sats > 0 ? `₿ ${entry.sats}` : '' });
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
    out.addEventListener('click', async () => {
      await auth.signOut(state.session);
      state.session = null;
      state.profile = null;
      renderSessionPanel(parent, state);
    });
  } else {
    el('p', { parent, text: 'Sign in with Nostr. Stake your name.' });
    const row = el('div', { className: 'menu-row', parent });
    const inBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'SIGN IN WITH NOSTR' });
    const status = el('p', { parent });
    status.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.85);min-height:1em;margin:0;letter-spacing:0.04em;';
    inBtn.addEventListener('click', async () => {
      void audio.unlockAudio();
      // Live status — slow signers can take 5-15s on a cold start. Updating
      // this every second tells the user it's not frozen.
      let elapsed = 0;
      status.textContent = 'Connecting…';
      status.style.color = 'rgba(180,140,255,0.85)';
      const ticker = window.setInterval(() => {
        elapsed += 1;
        status.textContent = `Connecting to your signer (${elapsed}s)…`;
      }, 1000);
      try {
        const session = await auth.signIn();
        window.clearInterval(ticker);
        if (session) {
          status.textContent = '';
          state.session = session;
          renderSessionPanel(parent, state);
        } else {
          status.textContent = 'No signer attached. Try a NIP-07 extension or your bunker URI.';
          status.style.color = '#ff8a3a';
        }
      } catch (err) {
        window.clearInterval(ticker);
        status.textContent = err instanceof auth.SignInTimeoutError
          ? `Timeout — ${err.message}`
          : `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`;
        status.style.color = '#ff5050';
      }
    });
    // Pressing IGNITE without signing in IS the guest path — no separate
    // GUEST DRIFT button needed. The session-status hint covers it.
    const hint = el('p', { parent, text: 'Or ignite as a guest — score-only, no sats.' });
    hint.style.fontSize = '0.85rem';
    hint.style.color = 'rgba(180,140,255,0.7)';
    hint.style.marginTop = '6px';
  }
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
      // The next IGNITE will call startGame which clears all run state.
      audio.thrustOff();
      audio.ufoSirenStop();
      audio.stopHeartbeat();
      audio.stopAmbient();
      audio.setMusicDuck(1);
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
  // Two-stage gameover: when the run is a new local high score, focus the
  // entire screen on the arcade-initials entry first (no other buttons,
  // no recap rows competing for attention), then advance to the recap +
  // actions screen on commit. Non-high-score runs skip straight to recap.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh) renderGameOverNameEntry(state);
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

async function maybePublishScore(state: GameState, parent: HTMLElement): Promise<void> {
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

  const claimBtn = el('button', { className: 'menu-btn', parent: compactView, text: 'CLAIM' });
  claimBtn.style.cssText = 'padding:8px 16px;cursor:pointer;font-size:0.95rem';

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
  saveBtn.addEventListener('click', onSave);
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
  };
  claimBtn.addEventListener('click', () => {
    void onClaim();
  });
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
  // capability with a one-line status of its own.
  const publishWrap = el('div', { parent: overlay });
  void maybePublishScore(state, publishWrap);

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

  // Credits scroll — 24 specimens + powered-by + lore. Pinned below the
  // primary actions so it doesn't push them off screen.
  renderCreditsRoll(overlay, undefined, state);

  // Auto-skip timer — counts down to TITLE. Resets on any keydown so a
  // player who's reading the credits doesn't get yanked away. The SKIP
  // TO TITLE button below also exits immediately.
  let secondsLeft = idleSeconds;
  const skipBar = el('p', { parent: overlay });
  skipBar.style.cssText = 'font-size:0.85rem;letter-spacing:0.18em;color:#ffd84a;margin:6px 0 0;';
  const renderSkip = (): void => { skipBar.textContent = `RETURNING TO TITLE IN ${secondsLeft}`; };
  renderSkip();

  const goToTitle = (): void => {
    cleanup();
    state.phase = 'title';
    renderTitle(state);
  };
  const idleTick = window.setInterval(() => {
    secondsLeft -= 1;
    renderSkip();
    if (secondsLeft <= 0) goToTitle();
  }, 1000);
  const resetIdle = (): void => { secondsLeft = idleSeconds; renderSkip(); };
  const onAnyKey = (): void => resetIdle();
  window.addEventListener('keydown', onAnyKey);
  const cleanup = (): void => {
    window.clearInterval(idleTick);
    window.removeEventListener('keydown', onAnyKey);
  };

  const row = el('div', { className: 'menu-row', parent: overlay });
  if (!opts.isCompletion) {
    const again = el('button', { className: 'menu-btn', parent: row, text: 'SPAWN AGAIN' });
    again.addEventListener('click', () => {
      cleanup();
      startGame(state);
      onStartCb?.();
    });
    if (state.deathReplay) {
      const replay = el('button', { className: 'menu-btn secondary', parent: row, text: 'REPLAY KILL' });
      replay.addEventListener('click', () => {
        cleanup();
        clearOverlay();
        startDeathReplay(state, 'gameover');
      });
    }
  } else {
    const again = el('button', { className: 'menu-btn', parent: row, text: 'IGNITE AGAIN' });
    again.addEventListener('click', () => {
      cleanup();
      startGame(state);
      onStartCb?.();
    });
  }
  const home = el('button', { className: 'menu-btn secondary', parent: row, text: 'SKIP TO TITLE' });
  home.addEventListener('click', goToTitle);

  renderLegalFooter(overlay);
}

export function renderCompletion(state: GameState): void {
  // Two-stage completion, mirroring gameover: focus the player on the
  // arcade name entry first, then unfurl the celebration. Non-high-score
  // wave-25 clears (rare but possible — local list already full of higher
  // scores) skip stage 1 and land on the celebration directly.
  const isNewHigh = isHighScore(state.score) && state.score > 0;
  if (isNewHigh) renderCompletionNameEntry(state);
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
    btn.addEventListener('click', async () => {
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
  // credit linking them to the game. Per UX direction: don't bother offering
  // the button without a signer; show a sign-in prompt instead.
  if (!state.session) {
    const wrap = el('div', { parent });
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:6px;';
    const label = el('p', { parent: wrap, text: '⚡ SIGN IN TO ZAP ⚡' });
    label.style.cssText = 'font-size:0.9rem;letter-spacing:0.2em;color:rgba(255,216,74,0.7);margin:0;';
    const sub = el('p', { parent: wrap, text: 'zaps need a Nostr key so the credit links back to you' });
    sub.style.cssText = 'font-size:0.7rem;letter-spacing:0.12em;color:rgba(180,140,255,0.55);margin:0;text-align:center;';
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
    btn.addEventListener('click', () => quickZap(state, p.sats, btn));
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
  custom.addEventListener('click', () => openZapModal(state));
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
