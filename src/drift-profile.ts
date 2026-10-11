import type { RunMode } from './mode.js';
import type { UfoType } from './types.js';

/** Five-wave breathing cycle; none of these values grow with run length. */
export function driftProfile(wave: number, mode: RunMode) {
  if (mode !== 'drift' || wave <= 25) return null;
  const beat = (wave - 26) % 5;
  return {
    recovery: beat === 0,
    rockCount: [8, 9, 10, 10, 11][beat],
    speedWave: [12, 14, 16, 17, 18][beat],
    ufoType: (['cruiser', 'cruiser', 'elite', 'cruiser', 'tank'] as const)[beat] as UfoType,
    ufoIntervalFloorMs: beat === 0 ? 18000 : 14000,
    defenceCooldownMul: 0.75,
  };
}

export const DRIFT_VISTAS = [
  { asset: 'lagoon', name: 'THE QUIET EXPANSE', subtitle: 'Turquoise tides beyond the Forge' },
  { asset: 'rings', name: 'SAPPHIRE REACH', subtitle: 'Past the rings of a sleeping giant' },
  { asset: 'galaxy', name: 'AFTERGLOW', subtitle: 'Follow the light between galaxies' },
] as const;

/** Finite art/cache keys even when a pilot reaches wave one million. */
export function driftVista(wave: number) {
  return DRIFT_VISTAS[Math.floor(Math.max(0, wave - 26) / 2) % DRIFT_VISTAS.length];
}
