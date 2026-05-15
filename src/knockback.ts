/**
 * Bullet-knockback setting.
 *
 * When a shot lands, the laser's momentum is blended into whatever it hits:
 * a surviving rock drifts along the shot line, a shrunk chunk gets pushed
 * off its mark, and fresh fragments inherit the shot direction instead of
 * only spraying around the parent's velocity.
 *
 * The 1979 arcade did none of this — a hit split the rock or it didn't, and
 * debris flew on a fixed spread. So knockback is gameplay, not cosmetics: it
 * changes where rocks end up, which changes difficulty. Like bounce, it must
 * NOT be tied to the visual tier (vector / shaded / mesh); its default comes
 * from difficulty instead:
 *
 *   600bn flavour — always on, not overridable (the Sanctum wants it).
 *   easy          — off: classic 1979, shots don't shove rocks.
 *   normal / hard — on.
 *
 * AUTO follows that rule; ON / OFF are explicit player overrides.
 */

import { getFlavour } from './flavour.js';
import { currentDifficulty } from './difficulty.js';

export type KnockbackMode = 'auto' | 'on' | 'off';

const KEY = 'pallasite:knockback';

let cached: KnockbackMode | null = null;

function coerce(v: unknown): KnockbackMode {
  if (v === 'auto' || v === 'on' || v === 'off') return v;
  return 'auto';
}

export function getKnockbackMode(): KnockbackMode {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? coerce(raw) : 'auto';
  } catch {
    cached = 'auto';
  }
  return cached;
}

export function setKnockbackMode(mode: KnockbackMode): void {
  cached = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* ignore */ }
}

/** Whether a bullet's momentum is blended into the asteroid it hits and into
 *  any fragments. 600bn forces it on; otherwise an explicit ON / OFF override
 *  wins, and AUTO derives from the locked-in difficulty (off on easy, on for
 *  normal / hard). */
export function bulletKnockbackEnabled(): boolean {
  if (getFlavour() === '600bn') return true;
  const mode = getKnockbackMode();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return currentDifficulty() !== 'easy';
}
