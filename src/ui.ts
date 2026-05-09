/**
 * UI overlays — title screen, game-over screen, sign-in panel.
 *
 * Built as plain DOM in #ui-root, not on the canvas. Easier to style, easier
 * to handle clicks/inputs, and keeps the canvas pure-vector.
 */

import type { GameState } from './types.js';
import { WAVE_LORE } from './types.js';
import { getActiveRelays, setActiveRelays, resetRelays } from './relays.js';
import * as auth from './auth.js';
import { addLocalHighScore, getLocalHighScores, isHighScore, publishScore } from './score.js';
import { startGame, startDeathReplay, toastNow } from './game.js';
import * as audio from './audio.js';
import { fetchProfile, getCachedProfile, bestName } from './profile.js';
import { type Difficulty, getStoredDifficulty, setStoredDifficulty, lockInDifficulty } from './difficulty.js';
import { getStoredDailyPref, setStoredDailyPref, todayUTC, getActiveSeed } from './seed.js';
import { DEV } from './credits.js';
import { followUser, shareCompletion, endorseSubject, rankFromWave } from './social.js';
import { requestZapInvoice, hasWebLN, payViaWebLN } from './zap.js';
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

  el('h1', { parent: overlay, text: 'PALLASITE' });
  const tagline = el('p', { parent: overlay, text: 'SHOOT ROCKS · STACK SATS' });
  tagline.style.cssText = 'font-size:1.2rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-12px;';
  el('p', { parent: overlay, text: 'Cosmic arcade · Lightning sats · Nostr leaderboards' });

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
  const settingsBtn = el('button', { className: 'menu-btn secondary', parent: row, text: 'AUDIO' });
  settingsBtn.addEventListener('click', () => {
    void audio.unlockAudio();
    renderSettings(() => renderTitle(state));
  });

  // Show local high scores under the start button if any exist
  const list = getLocalHighScores();
  if (list.length > 0) {
    renderLeaderboardBlock(overlay, list, '— LOCAL HIGH SCORES —');
  }

  const hint = el('div', { className: 'kbhint', parent: root });
  hint.innerHTML = `
    <span><kbd>←</kbd><kbd>→</kbd> rotate</span>
    <span><kbd>↑</kbd> thrust</span>
    <span><kbd>SPACE</kbd> fire</span>
    <span><kbd>↓</kbd> shield · <kbd>↓↓</kbd> hyperspace</span>
    <span><kbd>SHIFT</kbd> or <kbd>H</kbd> hyperspace</span>
    <span><kbd>+</kbd> jump · <kbd>-</kbd> back wave (cheat)</span>
    <span><kbd>P</kbd> pause</span>
    <span><kbd>M</kbd> mute</span>
  `;
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
    inBtn.addEventListener('click', async () => {
      void audio.unlockAudio();
      const session = await auth.signIn();
      state.session = session;
      renderSessionPanel(parent, state);
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
  el('h2', { parent: overlay, text: 'PAUSED' });
  const row = el('div', { className: 'menu-row', parent: overlay });
  const resume = el('button', { className: 'menu-btn', parent: row, text: 'RESUME' });
  resume.addEventListener('click', () => onResumeCb?.());
  const settings = el('button', { className: 'menu-btn secondary', parent: row, text: 'AUDIO · SETTINGS' });
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
  el('h2', { parent: overlay, text: 'HOW TO PLAY' });

  const tagline = el('p', { parent: overlay, text: 'Drift the orbit. Shoot rocks. Survive 25 waves.' });
  tagline.style.cssText = 'font-size:1rem;color:var(--hud-yellow);letter-spacing:0.18em;text-shadow:0 0 8px rgba(255,216,74,0.45);margin:0 0 6px;';

  const panel = el('div', { parent: overlay });
  panel.style.cssText = 'display:flex;flex-direction:column;gap:18px;align-items:stretch;max-width:540px;text-align:left;';

  function section(title: string, lines: ReadonlyArray<readonly [string, string]>): void {
    const block = el('div', { parent: panel });
    block.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    const h = el('p', { parent: block, text: title });
    h.style.cssText = 'font-size:0.78rem;letter-spacing:0.32em;color:rgba(180,140,255,0.95);margin:0;';
    const grid = el('div', { parent: block });
    grid.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;font-size:0.92rem;color:rgba(220,210,255,0.92);';
    for (const [k, v] of lines) {
      const key = el('span', { parent: grid, text: k });
      key.style.cssText = 'color:#5b9dff;letter-spacing:0.08em;font-weight:bold;';
      el('span', { parent: grid, text: v });
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
    ['Pickups', 'Dust shards (green) for score · Sat coins (₿) for real sats when signed in'],
    ['Lives', 'Lose all and the run ends · extra life every 10,000 score'],
  ]);

  section('WHAT TO WATCH FOR', [
    ['Combo chain', 'Quick consecutive kills stack a multiplier — watch the chip'],
    ['Hyperspace', 'Re-emerges anywhere, but ~6% chance the warp goes wrong'],
    ['Mines', 'From wave 8 — gravity wells; bullets destroy them'],
    ['Snipers', 'From wave 10 — slow, accurate, lethal'],
    ['Iron rocks', 'Two hits to crack — the orange ones'],
    ['Pallasite rocks', 'Rare jackpot — the yellow-green ones'],
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
  el('h2', { parent: overlay, text: 'AUDIO' });

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

  const row2 = el('div', { className: 'menu-row', parent: overlay });
  // Open the Nostr relay editor without leaving settings
  const relayBtn = el('button', { className: 'menu-btn secondary', parent: row2, text: 'NOSTR RELAYS' });
  relayBtn.addEventListener('click', () => renderRelaySettings(() => renderSettings(onBack)));

  const back = el('button', { className: 'menu-btn', parent: row2, text: 'BACK' });
  back.addEventListener('click', onBack);

  // Bind musicRow for type checker satisfaction (keep handle in case we later want to react to external volume changes)
  void musicRow;
}

/**
 * Nostr relay editor. Textarea — one URL per line — for free-form editing.
 * Save validates and persists; Reset returns to bundled defaults. Used by
 * score publishing, follows, shares, endorsements, and zap requests.
 */
export function renderRelaySettings(onBack: () => void): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  el('h2', { parent: overlay, text: 'NOSTR RELAYS' });

  const intro = el('p', { parent: overlay, text: 'Where this game publishes scores, follows, shares and zap requests. One wss:// URL per line.' });
  intro.style.cssText = 'font-size:0.85rem;color:rgba(180,140,255,0.85);max-width:480px;margin:0;line-height:1.5;';

  const textarea = el('textarea', { parent: overlay }) as HTMLTextAreaElement;
  textarea.value = getActiveRelays().join('\n');
  textarea.style.cssText = [
    'background:rgba(0,0,0,0.5)', 'border:2px solid rgba(91,157,255,0.4)',
    'color:#cfd6ff', 'font-family:ui-monospace,monospace',
    'font-size:0.9rem', 'padding:10px 12px',
    'width:480px', 'max-width:90vw', 'height:180px',
    'border-radius:6px', 'resize:vertical',
    'letter-spacing:0', 'line-height:1.5',
  ].join(';');

  const status = el('p', { parent: overlay, text: '' });
  status.style.cssText = 'font-size:0.78rem;color:rgba(180,140,255,0.75);min-height:1.1em;margin:0;';

  const row = el('div', { className: 'menu-row', parent: overlay });
  const save = el('button', { className: 'menu-btn', parent: row, text: 'SAVE' });
  save.addEventListener('click', () => {
    const lines = textarea.value.split('\n').map(s => s.trim()).filter(Boolean);
    const cleaned = setActiveRelays(lines);
    textarea.value = cleaned.join('\n');
    status.textContent = `✓ ${cleaned.length} relay${cleaned.length === 1 ? '' : 's'} active.`;
    status.style.color = '#58ff58';
  });
  const reset = el('button', { className: 'menu-btn secondary', parent: row, text: 'RESET' });
  reset.addEventListener('click', () => {
    resetRelays();
    textarea.value = getActiveRelays().join('\n');
    status.textContent = 'Restored bundled defaults.';
    status.style.color = 'rgba(180,140,255,0.85)';
  });
  const back = el('button', { className: 'menu-btn secondary', parent: row, text: 'BACK' });
  back.addEventListener('click', onBack);
}

// ── Game over screen ──────────────────────────────────────────────────────────

export function renderGameOver(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  el('h2', { parent: overlay, text: 'GAME OVER' });

  const board = el('div', { className: 'scoreboard', parent: overlay });
  // Guests see SCORE + WAVE only; SATS row is Nostr-mode-exclusive.
  const rows: ReadonlyArray<readonly [string, number]> = state.session
    ? [['SCORE', state.score], ['SATS', state.sats], ['WAVE', state.wave]]
    : [['SCORE', state.score], ['WAVE', state.wave]];
  for (const [k, v] of rows) {
    el('div', { className: 'label', parent: board, text: k });
    el('div', { className: 'value', parent: board, text: String(v) });
  }

  // High-score recap
  const isNewHigh = isHighScore(state.score);
  if (isNewHigh && state.score > 0) {
    el('p', { parent: overlay, text: 'NEW PERIHELION · HIGH SCORE LOGGED' }).style.color = '#ffd84a';

    if (state.session) {
      // Auto-record under the player's resolved name (or pubkey-prefix fallback)
      const displayName = bestName(state.profile, state.session.pubkey);
      const entry = {
        name: displayName.slice(0, 16).toUpperCase(),
        score: state.score,
        sats: state.sats,
        wave: state.wave,
        at: new Date().toISOString(),
        pubkey: state.session.pubkey,
      };
      addLocalHighScore(entry);
      maybePublishScore(state, overlay);
    } else {
      // Ask for initials. The leaderboard renders below; we keep a handle
      // to it so the SAVE click can re-render with the freshly-added entry
      // (otherwise the user sees a stale list missing their just-saved row).
      const inputRow = el('div', { className: 'menu-row', parent: overlay });
      const input = el('input', { parent: inputRow, attrs: { maxlength: '8', placeholder: 'INIT', type: 'text' } });
      input.style.cssText = 'background:transparent;border:2px solid #58ff58;color:#58ff58;font-family:inherit;font-size:1.3rem;padding:8px 12px;text-align:center;text-transform:uppercase;letter-spacing:0.2em;width:140px;';
      const save = el('button', { className: 'menu-btn', parent: inputRow, text: 'SAVE' });
      save.addEventListener('click', () => {
        const name = input.value.trim().toUpperCase().slice(0, 8) || 'YOU';
        addLocalHighScore({
          name,
          score: state.score,
          sats: state.sats,
          wave: state.wave,
          at: new Date().toISOString(),
        });
        input.disabled = true;
        save.disabled = true;
        save.textContent = 'SAVED';
        // Re-render the leaderboard in place so the new row appears immediately.
        const lb = overlay.querySelector('.leaderboard-block');
        if (lb) {
          const fresh = getLocalHighScores();
          const replacement = document.createElement('div');
          overlay.replaceChild(replacement, lb);
          renderLeaderboardBlock(replacement, fresh, '— LOCAL HIGH SCORES —');
          // renderLeaderboardBlock appends to its parent, so we move its
          // single child up and ditch the wrapper.
          const block = replacement.firstElementChild;
          if (block) overlay.replaceChild(block, replacement);
        }
      });
      input.focus();
    }
  }

  // Local high scores — renders BEFORE the user has had a chance to enter
  // their initials, so the SAVE handler above re-renders this block in place.
  const list = getLocalHighScores();
  if (list.length > 0) {
    renderLeaderboardBlock(overlay, list, '— LOCAL HIGH SCORES —');
  }

  // Zap the dev — only in Nostr mode. Guests get a quieter dev card on completion.
  if (state.session) renderZapButton(overlay, state);

  const row = el('div', { className: 'menu-row', parent: overlay });
  const again = el('button', { className: 'menu-btn', parent: row, text: 'SPAWN AGAIN' });
  again.addEventListener('click', () => {
    state.session = state.session;  // preserve session
    startGame(state);
    onStartCb?.();
  });
  if (state.deathReplay) {
    const replay = el('button', { className: 'menu-btn secondary', parent: row, text: 'REPLAY KILL' });
    replay.addEventListener('click', () => {
      clearOverlay();
      startDeathReplay(state, 'gameover');
      // The post-replay setTimeout will flip phase back to 'gameover'; the
      // game loop's phase-change watcher then re-renders this overlay.
    });
  }
  const home = el('button', { className: 'menu-btn secondary', parent: row, text: 'TO TITLE' });
  home.addEventListener('click', () => {
    state.phase = 'title';
    renderTitle(state);
  });
}

async function maybePublishScore(state: GameState, parent: HTMLElement): Promise<void> {
  if (!state.session?.signer.capabilities.canSignEvents) {
    el('p', { parent, text: 'Saved locally. Bark or bunker publishes to Nostr.' }).style.fontSize = '0.85rem';
    return;
  }

  const status = el('p', { parent, text: 'Plotting to Nostr…' });
  status.style.color = '#5b9dff';
  status.style.fontSize = '0.85rem';

  try {
    const elapsed = Math.floor((performance.now() - state.phaseStart) / 1000);
    const result = await publishScore(state.session, {
      score: state.score,
      sats: state.sats,
      wave: state.wave,
      durationSeconds: elapsed,
      seed: getActiveSeed(),
      cheated: state.cheatedThisRun,
    });
    if (result) {
      status.textContent = `✓ Plotted on ${result.publishedTo.length}/${result.publishedTo.length + result.failed.length} relays`;
      status.style.color = '#58ff58';
    } else {
      status.textContent = 'Signer cannot plot.';
    }
  } catch (err) {
    status.textContent = `✗ Plot failed: ${err instanceof Error ? err.message : String(err)}`;
    status.style.color = '#ff5050';
  }
}

// ── Completion screen (wave 25 cleared) ──────────────────────────────────────

function formatRunTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function renderCompletion(state: GameState): void {
  clearOverlay();
  const overlay = el('div', { className: 'overlay', parent: root });
  overlay.style.background = 'rgba(0, 0, 0, 0.85)';

  // Staggered reveal: each section gets the .completion-stage class with an
  // increasing animation-delay so the screen paces in instead of flashing.
  let stageIndex = 0;
  const stage = (delaySeconds: number) => {
    stageIndex += 1;
    return (parent: HTMLElement) => {
      parent.classList.add('completion-stage');
      parent.style.animationDelay = `${delaySeconds}s`;
    };
  };

  const title = el('h1', { parent: overlay, text: 'PALLASITE COMPLETE' });
  stage(0.0)(title);
  const sub = el('p', { parent: overlay, text: 'EVENT HORIZON · BREACHED' });
  sub.style.cssText = 'font-size:1.2rem;color:var(--hud-yellow);letter-spacing:0.25em;text-shadow:0 0 8px rgba(255,216,74,0.5);margin-top:-12px;';
  stage(0.4)(sub);

  const board = el('div', { className: 'scoreboard', parent: overlay });
  const completionRows: ReadonlyArray<readonly [string, string]> = state.session
    ? [
        ['SCORE', state.score.toLocaleString()],
        ['SATS', `₿ ${state.sats}`],
        ['RUN TIME', formatRunTime(state.runTimeMs)],
        ['SPECIMENS', '24 / 24'],
      ]
    : [
        ['SCORE', state.score.toLocaleString()],
        ['RUN TIME', formatRunTime(state.runTimeMs)],
        ['SPECIMENS', '24 / 24'],
      ];
  for (const [k, v] of completionRows) {
    el('div', { className: 'label', parent: board, text: k });
    el('div', { className: 'value', parent: board, text: v });
  }
  stage(0.9)(board);

  // Honours strip — earned conditions surface as small badges.
  renderHonours(overlay, state, stage(1.4));

  // Credits roll — promoted high in the layout so it actually gets watched.
  renderCreditsRoll(overlay, stage(1.9), state);

  // Dev card — creator name + clickable profile (npub for Nostr, @handle for guests)
  const devWrap = el('div', { parent: overlay });
  renderDevCard(devWrap, state);
  stage(2.6)(devWrap);

  // Auto-record under the player's resolved name (or pubkey-prefix fallback)
  if (state.session) {
    const displayName = bestName(state.profile, state.session.pubkey);
    addLocalHighScore({
      name: displayName.slice(0, 16).toUpperCase(),
      score: state.score,
      sats: state.sats,
      wave: 25,
      at: new Date().toISOString(),
      pubkey: state.session.pubkey,
    });
    const pubBlock = el('div', { parent: overlay });
    maybePublishCompletion(state, pubBlock);
    stage(3.0)(pubBlock);
  } else {
    // Guest finished the run — prompt for initials instead of silently
    // saving as YOU. Mirrors the gameover flow.
    const inputWrap = el('div', { className: 'menu-row', parent: overlay });
    const input = el('input', { parent: inputWrap, attrs: { maxlength: '8', placeholder: 'INIT', type: 'text' } });
    input.style.cssText = 'background:transparent;border:2px solid #58ff58;color:#58ff58;font-family:inherit;font-size:1.3rem;padding:8px 12px;text-align:center;text-transform:uppercase;letter-spacing:0.2em;width:140px;';
    const save = el('button', { className: 'menu-btn', parent: inputWrap, text: 'BANK NAME' });
    save.addEventListener('click', () => {
      const name = input.value.trim().toUpperCase().slice(0, 8) || 'YOU';
      addLocalHighScore({
        name,
        score: state.score,
        sats: state.sats,
        wave: 25,
        at: new Date().toISOString(),
      });
      input.disabled = true;
      save.disabled = true;
      save.textContent = 'BANKED';
    });
    stage(3.0)(inputWrap);
  }

  // Social actions + zap — Nostr mode only. Guests already see the X handle on
  // the dev card; no point showing them auth-gated buttons that just nag.
  if (state.session) {
    const socialWrap = el('div', { parent: overlay });
    renderSocialActions(socialWrap, state);
    stage(3.4)(socialWrap);

    const zapWrap = el('div', { parent: overlay });
    renderZapButton(zapWrap, state);
    stage(3.8)(zapWrap);
  }

  const row = el('div', { className: 'menu-row', parent: overlay });
  const again = el('button', { className: 'menu-btn', parent: row, text: 'IGNITE AGAIN' });
  again.addEventListener('click', () => {
    startGame(state);
    onStartCb?.();
  });
  const home = el('button', { className: 'menu-btn secondary', parent: row, text: 'TO TITLE' });
  home.addEventListener('click', () => {
    state.phase = 'title';
    renderTitle(state);
  });
  stage(4.2)(row);
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

function renderDevCard(parent: HTMLElement, state: GameState): void {
  const wrap = el('div', { parent });
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:4px;';
  const heading = el('p', { parent: wrap, text: 'CREATED BY' });
  heading.style.cssText = 'font-size:0.78rem;letter-spacing:0.4em;color:rgba(180,140,255,0.85);margin:0;';
  const name = el('p', { parent: wrap, text: DEV.name.toUpperCase() });
  name.style.cssText = 'font-size:1.4rem;letter-spacing:0.25em;color:var(--hud-yellow);text-shadow:0 0 8px rgba(255,216,74,0.5);margin:0;';
  // Guest mode: surface the X handle (something a non-Nostr player can act on).
  // Nostr mode: surface the npub linking to njump.me — meaningful on the network.
  const link = el('a', { parent: wrap });
  if (state.session) {
    link.textContent = `${DEV.npub.slice(0, 12)}…${DEV.npub.slice(-6)}`;
    link.setAttribute('href', DEV.profileUrl);
  } else {
    link.textContent = `@${DEV.twitter}`;
    link.setAttribute('href', DEV.twitterUrl);
  }
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener noreferrer');
  link.style.cssText = 'font-size:0.85rem;color:var(--hud-blue);letter-spacing:0.1em;text-decoration:none;border-bottom:1px dotted rgba(91,157,255,0.5);';
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

async function maybePublishCompletion(state: GameState, parent: HTMLElement): Promise<void> {
  if (!state.session?.signer.capabilities.canSignEvents) {
    el('p', { parent, text: 'Saved locally. Bark or bunker plots completion to Nostr.' }).style.fontSize = '0.85rem';
    return;
  }

  const status = el('p', { parent, text: 'Plotting completion to Nostr (state=completed)…' });
  status.style.color = '#5b9dff';
  status.style.fontSize = '0.85rem';

  try {
    const elapsed = Math.floor(state.runTimeMs / 1000);
    const result = await publishScore(state.session, {
      score: state.score,
      sats: state.sats,
      wave: 25,
      durationSeconds: elapsed,
      state: 'completed',
      seed: getActiveSeed(),
      cheated: state.cheatedThisRun,
    });
    if (result) {
      status.textContent = `✓ Plotted on ${result.publishedTo.length}/${result.publishedTo.length + result.failed.length} relays`;
      status.style.color = '#58ff58';
    } else {
      status.textContent = 'Signer cannot plot.';
    }
  } catch (err) {
    status.textContent = `✗ Plot failed: ${err instanceof Error ? err.message : String(err)}`;
    status.style.color = '#ff5050';
  }
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
