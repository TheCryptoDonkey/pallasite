/**
 * Value for value — the pre-run tip ask, front and centre.
 *
 * Shown between the title menu and every normal solo run. Honour-system:
 * a plain lightning address gives no payment callback, so the player
 * self-confirms with I PAID. Paying arms a 24-hour "blessing" — startGame
 * grants blessed pilots a launch shield and a satboost window.
 *
 * Pure state module, no DOM — ui.ts renders the overlay (renderV4v) and
 * game.ts applies the blessing, so both import from here without cycles.
 */

import { DEV } from './credits.js';

export const V4V_LIGHTNING_ADDRESS = DEV.lightningAddress;
export const V4V_GEYSER_URL = 'https://geyser.fund/project/forgesworn?hero=geyserannually1';
export const V4V_KOFI_URL = 'https://ko-fi.com/brays';
/** Printed on the overlay so players know tipping earns a boost. */
export const V4V_REWARD_LINE = '🙏 PATRONS FLY BLESSED — LAUNCH SHIELD · ×2 SATS AT IGNITION';

const STORE_KEY = 'pallasite:v4v:v1';
const BLESSING_MS = 24 * 60 * 60 * 1000;

interface V4vState {
  declines: number;
  paidAt: number;
}

function loadState(): V4vState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { declines: 0, paidAt: 0, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { declines: 0, paidAt: 0 };
}

function saveState(s: V4vState): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * The ask fires before every menu-launched solo run — nobody gets away
 * with it. Automation is the one exception: the Playwright QA tools set
 * navigator.webdriver, and they need IGNITE to start a run without a tip
 * screen in the way.
 */
export function shouldAskV4v(): boolean {
  return !navigator.webdriver;
}

/** Patrons fly blessed for 24 hours after paying: launch shield + satboost. */
export function isBlessed(): boolean {
  const s = loadState();
  return s.paidAt > 0 && Date.now() - s.paidAt < BLESSING_MS;
}

export function markV4vPaid(): void {
  const s = loadState();
  s.paidAt = Date.now();
  s.declines = 0;
  saveState(s);
}

export function markV4vDeclined(): void {
  const s = loadState();
  s.declines++;
  saveState(s);
}

const NUDGES = [
  'This ship runs on sats. Patrons fly blessed: shield up at launch, ×2 sats at ignition.',
  'Free flight logged. The donkey is counting. Patrons launch shielded.',
  'Still free. The belt remembers — patrons ignite with double sats.',
  'Sats are voluntary. The blessing (launch shield, ×2 sats) is not subtle.',
];

// Previous patrons get the thank-you variant — the ask still shows,
// the blessing still applies from storage.
const RETURNING_NUDGES = [
  'You paid before. The donkey remembers. Your blessing holds for 24 hours.',
  'Generosity noted on the ledger. Fly blessed: shield up, sats doubled at ignition.',
  'One sat is a signal. Two is a habit. Bless you either way.',
];

/** Rotating nudge copy — escalates with declines; patrons get the warm set. */
export function v4vNudge(): string {
  const s = loadState();
  return s.paidAt
    ? RETURNING_NUDGES[Math.min(s.declines, RETURNING_NUDGES.length - 1)]
    : NUDGES[Math.min(s.declines, NUDGES.length - 1)];
}
