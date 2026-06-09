/**
 * Asteroid-asteroid bounce setting.
 *
 * Bounce is gameplay, not cosmetics — it changes rock trajectories, so it
 * changes difficulty. That means it must NOT be tied to the visual tier
 * (vector / shaded / mesh); two players on different render tiers get the
 * same game. Its default comes from difficulty instead:
 *
 *   600bn flavour — always on, not overridable (the Sanctum wants it).
 *   easy          — off: classic 1979 pass-through.
 *   normal / hard — on.
 *
 * AUTO follows that rule; ON / OFF are explicit player overrides.
 */

import { getFlavour, boothKioskActive } from './flavour.js';
import { currentDifficulty } from './difficulty.js';

export type BounceMode = 'auto' | 'on' | 'off';

const KEY = 'pallasite:bounce';

let cached: BounceMode | null = null;

function coerce(v: unknown): BounceMode {
  if (v === 'auto' || v === 'on' || v === 'off') return v;
  return 'auto';
}

export function getBounceMode(): BounceMode {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? coerce(raw) : 'auto';
  } catch {
    cached = 'auto';
  }
  return cached;
}

export function setBounceMode(mode: BounceMode): void {
  cached = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}

/** Whether gameplay-plane asteroids bounce off each other this run. 600bn
 *  forces it on; otherwise an explicit ON / OFF override wins, and AUTO
 *  derives from the locked-in difficulty (off on easy, on for normal / hard). */
export function asteroidBounceEnabled(): boolean {
  if (getFlavour() === '600bn') return true;
  // Booth/kiosk: always bounce — the dynamic arcade experience the showcase
  // wants — ignoring a stale 'off' override or an easy-difficulty default left
  // in the kiosk's localStorage from testing. (When the booth was stuck on the
  // 600bn flavour, bounce was forced on above; pinning the booth to 'main' for
  // shootable rocks must not silently drop the bounce with it.)
  if (boothKioskActive()) return true;
  const mode = getBounceMode();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return currentDifficulty() !== 'easy';
}
