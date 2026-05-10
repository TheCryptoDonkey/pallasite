/**
 * Adaptive music stems. Procedural Web Audio layers that mix on top of the
 * recorded soundtrack via the shared musicBus, keyed to live game state.
 *
 * Recorded music supplies the harmonic bed; stems supply intensity:
 *
 *   - Combo bass pulse: sub-sine kick on a metric beat while a kill chain
 *     is live. Volume scales with combo level (2x quiet, 5x prominent).
 *     Tonally near-neutral -- a sub-bass thump is felt more than heard so
 *     it stacks on any track without competing with the recorded melody.
 *
 *   - Boss lead: on wave 25 with the boss undefeated, a 3-note descending
 *     sine motif chimes every couple of seconds. Marks "this is the final
 *     fight" sonically.
 *
 * All stems route through musicBus (getMusicDestination), so the music
 * slider, music duck, and mute toggle apply to them alongside the recorded
 * tracks. No additional UI surface needed.
 */

import { getMusicDestination } from './audio.js';
import type { GameState } from './types.js';

let stemCtx: AudioContext | null = null;
let stemBus: GainNode | null = null;

let nextComboPulseAt = 0;
let nextBossPingAt = 0;

/** Pulse cadence for the combo bass. ~125 BPM at 480ms feels driving without
 *  overwhelming the recorded track. */
const COMBO_PULSE_INTERVAL_MS = 480;
/** Cadence for the boss lead motif. Long enough to feel ominous, short enough
 *  to remind the player who they are fighting. */
const BOSS_PING_INTERVAL_MS = 2400;
/** Initial delay before the first boss ping after wave 25 begins, so it
 *  doesn't fire on top of the wavestart banner / sting. */
const BOSS_PING_INITIAL_DELAY_MS = 1800;
/** Descending minor-thirds motif (B4, G#4, F#4). Tonally compatible with
 *  the cascade / event-horizon track key signatures. */
const BOSS_MOTIF_FREQS = [493.88, 415.30, 369.99];

function ensureBus(): { ctx: AudioContext; bus: GainNode } | null {
  if (stemBus && stemCtx) return { ctx: stemCtx, bus: stemBus };
  const dest = getMusicDestination();
  const ctx = dest.context as AudioContext;
  if (!ctx) return null;
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  bus.connect(dest);
  stemCtx = ctx;
  stemBus = bus;
  return { ctx, bus };
}

/** Combo level → pulse gain. 1x silent, 2x faint, ramping to 5x prominent. */
function comboGainForLevel(level: number): number {
  if (level < 2) return 0;
  return Math.min(0.40, 0.10 + (level - 2) * 0.08);
}

function fireComboPulse(level: number): void {
  const r = ensureBus();
  if (!r) return;
  const { ctx, bus } = r;
  const now = ctx.currentTime;
  const peak = comboGainForLevel(level);
  if (peak <= 0) return;

  // Sub-sine kick: pitch drops fast for the classic kick feel. Fundamental
  // sweeps 120 -> 56 Hz (sub), harmonic 180 -> 110 Hz fills the body so the
  // pulse reads on small speakers that can't reproduce sub frequencies.
  const fund = ctx.createOscillator();
  fund.type = 'sine';
  fund.frequency.setValueAtTime(120, now);
  fund.frequency.exponentialRampToValueAtTime(56, now + 0.18);

  const harm = ctx.createOscillator();
  harm.type = 'sine';
  harm.frequency.setValueAtTime(180, now);
  harm.frequency.exponentialRampToValueAtTime(110, now + 0.10);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(peak, now + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

  const harmGain = ctx.createGain();
  harmGain.gain.value = 0.5;

  fund.connect(env);
  harm.connect(harmGain);
  harmGain.connect(env);
  env.connect(bus);

  fund.start(now);
  fund.stop(now + 0.5);
  harm.start(now);
  harm.stop(now + 0.4);
}

function fireBossPing(): void {
  const r = ensureBus();
  if (!r) return;
  const { ctx, bus } = r;
  const baseNow = ctx.currentTime;

  // Three sine notes ~450ms apart with a high-octave harmonic for brightness.
  for (let i = 0; i < BOSS_MOTIF_FREQS.length; i++) {
    const freq = BOSS_MOTIF_FREQS[i];
    const startAt = baseNow + i * 0.45;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const harm = ctx.createOscillator();
    harm.type = 'sine';
    harm.frequency.value = freq * 2;

    const harmGain = ctx.createGain();
    harmGain.gain.value = 0.25;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, startAt);
    env.gain.linearRampToValueAtTime(0.16, startAt + 0.04);
    env.gain.exponentialRampToValueAtTime(0.001, startAt + 0.55);

    osc.connect(env);
    harm.connect(harmGain);
    harmGain.connect(env);
    env.connect(bus);

    osc.start(startAt);
    osc.stop(startAt + 0.6);
    harm.start(startAt);
    harm.stop(startAt + 0.6);
  }
}

/**
 * Per-frame tick. Drives the stem schedules off `performance.now()` rather
 * than the audio clock so pauses freeze the rhythm cleanly with the rest of
 * the simulation. Idempotent and cheap when nothing is firing.
 *
 * Combo pulse fires every COMBO_PULSE_INTERVAL_MS while state.combo >= 2.
 * Boss ping fires every BOSS_PING_INTERVAL_MS while wave 25 boss is alive.
 */
export function stemsTickForState(state: GameState, nowMs: number): void {
  // Only fire stems while the simulation is actually running. Title, pause,
  // death replay, game over, and warp transitions all suppress -- otherwise
  // stems would punch through the cinematic music beats.
  if (state.phase !== 'playing' && state.phase !== 'wavestart') {
    nextComboPulseAt = 0;
    nextBossPingAt = 0;
    return;
  }

  if (state.combo >= 2) {
    if (nextComboPulseAt === 0) nextComboPulseAt = nowMs;
    if (nowMs >= nextComboPulseAt) {
      fireComboPulse(state.combo);
      nextComboPulseAt = nowMs + COMBO_PULSE_INTERVAL_MS;
    }
  } else {
    nextComboPulseAt = 0;
  }

  const bossAlive = state.wave === 25 && !state.bossDefeated;
  if (bossAlive) {
    if (nextBossPingAt === 0) nextBossPingAt = nowMs + BOSS_PING_INITIAL_DELAY_MS;
    if (nowMs >= nextBossPingAt) {
      fireBossPing();
      nextBossPingAt = nowMs + BOSS_PING_INTERVAL_MS;
    }
  } else {
    nextBossPingAt = 0;
  }
}

/** Reset the schedule timestamps. Existing oscillators self-terminate via
 *  stop(now + T) so there's nothing to disconnect. Future sustained stems
 *  (e.g. a combat drone) would tear down their nodes here. */
export function stemsStop(): void {
  nextComboPulseAt = 0;
  nextBossPingAt = 0;
}
