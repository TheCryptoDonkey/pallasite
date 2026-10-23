/**
 * Value for value — the pre-run tip ask.
 *
 * Shown between the title menu and every normal solo run. Honour-system:
 * a plain lightning address gives no payment callback, so the player
 * self-confirms with I PAID. A tip is a voluntary gift and buys nothing:
 * no shield, no sat boost, no unlock of any kind.
 *
 * Pure state module, no DOM — ui.ts renders the overlay (renderV4v).
 */

import { DEV } from './credits.js';

export const V4V_LIGHTNING_ADDRESS = DEV.lightningAddress;
export const V4V_GEYSER_URL = 'https://geyser.fund/project/forgesworn?hero=geyserannually1';
export const V4V_KOFI_URL = 'https://ko-fi.com/brays';
/** Printed on the overlay so players know a tip is a pure gift. */
export const V4V_GIFT_LINE = 'Tips keep Pallasite running. They don\'t unlock anything.';

const STORE_KEY = 'pallasite:v4v:v1';

interface V4vState {
  declines: number;
}

/** Only `declines` is read. Older builds also stored a `paidAt` timestamp
 *  that armed a 24-hour boost; any such stale value is ignored and dropped
 *  on the next save. */
function loadState(): V4vState {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const n = Number((JSON.parse(raw) as { declines?: unknown }).declines);
      if (Number.isFinite(n) && n > 0) return { declines: Math.floor(n) };
    }
  } catch { /* ignore */ }
  return { declines: 0 };
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

/** The player says they tipped: thank them, stop counting declines. */
export function markV4vPaid(): void {
  saveState({ declines: 0 });
}

export function markV4vDeclined(): void {
  const s = loadState();
  s.declines++;
  saveState(s);
}

const NUDGES = [
  'This ship runs on sats. Tips are a gift: they keep Pallasite running and unlock nothing.',
  'Free flight logged. Tips are optional and buy nothing, but they keep the lights on.',
  'Still free. Everyone flies the same ship, tipped or not.',
  'Sats are voluntary. A tip is a thank-you, never a purchase.',
];

/** Rotating nudge copy, escalating gently with declines. */
export function v4vNudge(): string {
  return NUDGES[Math.min(loadState().declines, NUDGES.length - 1)];
}
