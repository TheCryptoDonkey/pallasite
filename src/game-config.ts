/**
 * Gameplay tuning. The faucet used to serve these so an operator could
 * retune a live game; it closed on 23 October 2026, and these are the
 * defaults every run has used since.
 */
export interface GameConfig {
  /** Probability (0-1) that the W9 → W10 bonus level fires on
   *  wave-9 clear. 1.0 = always; default before the admin tunes it. */
  bonus_wave_chance: number;
  /** Per-UFO-kill chance (0-1) that a power-up drops. */
  powerup_drop_chance: number;
  /** 1-in-N sat drop selector. Lower = more sats. */
  sat_drop_denom: number;
  /** Ship lives at run start. 0 = inherit from the chosen difficulty
   *  (easy=5, normal=3, hard=2). >0 = global override, applied
   *  regardless of difficulty pick. */
  starting_lives: number;
  /** UFO timing (ms). */
  ufo_first_spawn_ms: number;
  ufo_respawn_base_ms: number;
  ufo_respawn_per_wave_ms: number;
  ufo_respawn_min_ms: number;
  /** Multiplier on per-wave asteroid count (base = min(13, 4+wave)). */
  asteroid_count_multiplier: number;
}

const GAME_CONFIG: GameConfig = {
  bonus_wave_chance: 1.0,
  powerup_drop_chance: 0.30,
  sat_drop_denom: 8,
  starting_lives: 0,
  ufo_first_spawn_ms: 12_000,
  ufo_respawn_base_ms: 18_000,
  ufo_respawn_per_wave_ms: 1_200,
  ufo_respawn_min_ms: 6_500,
  asteroid_count_multiplier: 1.0,
};

export function getGameConfig(): GameConfig {
  return GAME_CONFIG;
}
