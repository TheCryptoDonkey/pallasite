/**
 * Portrait radar setting.
 *
 * The radar / minimap is only ever shown by the portrait follow camera, where
 * the player sees a vertical slice of the world and needs whole-field
 * awareness. It is a plain on / off toggle, not the tri-state AUTO / ON / OFF
 * of bounce.ts: there is no landscape use for a radar (the whole world is
 * already on screen there), so an AUTO state would be identical to ON.
 *
 * Default on -- portrait is barely playable without it.
 */

const KEY = 'pallasite:radar';

let cached: boolean | null = null;

export function getRadarVisible(): boolean {
  if (cached !== null) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw === null ? true : raw === '1';
  } catch {
    cached = true;
  }
  return cached;
}

export function setRadarVisible(on: boolean): void {
  cached = on;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
