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

/** Base pulse cadence for the combo bass. ~125 BPM at 480ms feels driving
 *  without overwhelming the recorded track. The interval shortens as the
 *  combo level rises (see comboPulseInterval) so a 5x chain sits around
 *  167 BPM and feels like the music is leaning into the player's run. */
const COMBO_PULSE_INTERVAL_MS = 480;

/** Combo level → pulse interval ms. 2x base cadence, 5x ~25% faster.
 *  Linear ramp, clamped at the floor so it never gets twitchy. */
function comboPulseInterval(level: number): number {
  if (level <= 2) return COMBO_PULSE_INTERVAL_MS;
  return Math.max(360, COMBO_PULSE_INTERVAL_MS - (level - 2) * 40);
}
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

// ── Intensity drone — scales with on-screen gameplay rock count ─────────────
//
// Persistent low-frequency layer that comes alive when the playfield is busy.
// Sub fundamental (42Hz) + first harmonic (84Hz) + lowpass-filtered noise
// rumble, all routed through a single smoothed gain. Target each frame is a
// function of the alive depth-3 asteroid count: silent below
// INTENSITY_FLOOR_COUNT, linear ramp to peak at INTENSITY_FULL_COUNT, capped
// at INTENSITY_PEAK. Felt as added density rather than a new instrument, so
// it blends with any recorded track.

let intensityGain: GainNode | null = null;
let intensityStarted = false;
const INTENSITY_PEAK = 0.18;
const INTENSITY_FLOOR_COUNT = 6;
const INTENSITY_FULL_COUNT = 20;
const INTENSITY_RAMP_S = 0.6;

function ensureIntensityStem(): void {
  if (intensityStarted) return;
  const r = ensureBus();
  if (!r) return;
  const { ctx, bus } = r;

  intensityGain = ctx.createGain();
  intensityGain.gain.value = 0;
  intensityGain.connect(bus);

  const fund = ctx.createOscillator();
  fund.type = 'sine';
  fund.frequency.value = 42;
  fund.connect(intensityGain);
  fund.start();

  const harm = ctx.createOscillator();
  harm.type = 'sine';
  harm.frequency.value = 84;
  const harmGain = ctx.createGain();
  harmGain.gain.value = 0.35;
  harm.connect(harmGain);
  harmGain.connect(intensityGain);
  harm.start();

  // 2-second looped noise buffer — tiny memory, lowpass-filtered into a
  // sub-bass texture rather than hiss. Adds rolling rumble under the
  // tonal oscillators so the drone doesn't read as a pure test tone.
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 180;
  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0.20;
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(intensityGain);
  noise.start();

  intensityStarted = true;
}

function setIntensityTargetGain(target: number): void {
  if (!intensityGain || !stemCtx) return;
  const now = stemCtx.currentTime;
  const current = intensityGain.gain.value;
  // Cancel + rebase so an in-flight ramp doesn't fight the new one, then
  // ramp linearly to target. Linear (not exponential) is fine for a
  // low-frequency bed and survives near-zero values cleanly.
  intensityGain.gain.cancelScheduledValues(now);
  intensityGain.gain.setValueAtTime(current, now);
  intensityGain.gain.linearRampToValueAtTime(target, now + INTENSITY_RAMP_S);
}

function intensityTargetFromState(state: GameState): number {
  // Count alive, gameplay-plane asteroids. Decorative parallax bands
  // (depth 1-2, 4-5) don't count toward threat density.
  let collideCount = 0;
  for (const a of state.asteroids) {
    if (a.alive && a.depth === 3) collideCount++;
  }
  if (collideCount <= INTENSITY_FLOOR_COUNT) return 0;
  const norm = Math.min(1, (collideCount - INTENSITY_FLOOR_COUNT) / (INTENSITY_FULL_COUNT - INTENSITY_FLOOR_COUNT));
  return norm * INTENSITY_PEAK;
}

/**
 * Per-frame tick. Drives the stem schedules off `performance.now()` rather
 * than the audio clock so pauses freeze the rhythm cleanly with the rest of
 * the simulation. Idempotent and cheap when nothing is firing.
 *
 * Combo pulse fires every COMBO_PULSE_INTERVAL_MS while state.combo >= 2.
 * Boss ping fires every BOSS_PING_INTERVAL_MS while wave 25 boss is alive.
 * Intensity drone updates its target gain from the live rock count.
 */
/** Intensity drone kill-switch. Disabled because the per-frame
 *  cancelScheduledValues + linearRampToValueAtTime pattern in
 *  setIntensityTargetGain hammers the Web Audio scheduler. Desktop
 *  Chrome shrugs it off; iOS Safari chokes — music plays for a few
 *  seconds and then degrades / cuts out. Re-enable once the
 *  scheduling is throttled to ~5Hz with a delta gate, or moved to a
 *  pre-recorded stem that doesn't need ramp scheduling. */
const INTENSITY_DRONE_ENABLED = false;

export function stemsTickForState(state: GameState, nowMs: number): void {
  // Only fire stems while the simulation is actually running. Title, pause,
  // death replay, game over, and warp transitions all suppress -- otherwise
  // stems would punch through the cinematic music beats.
  if (state.phase !== 'playing' && state.phase !== 'wavestart') {
    nextComboPulseAt = 0;
    nextBossPingAt = 0;
    if (INTENSITY_DRONE_ENABLED) setIntensityTargetGain(0);
    return;
  }

  if (INTENSITY_DRONE_ENABLED) {
    // Intensity drone tracks the playfield's collide-asteroid count, smoothed
    // each frame. Lazy-init on first frame of play so the AudioContext is
    // already user-unlocked by the time we reach for it.
    ensureIntensityStem();
    setIntensityTargetGain(intensityTargetFromState(state));
  }

  if (state.combo >= 2) {
    if (nextComboPulseAt === 0) nextComboPulseAt = nowMs;
    if (nowMs >= nextComboPulseAt) {
      fireComboPulse(state.combo);
      nextComboPulseAt = nowMs + comboPulseInterval(state.combo);
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
  if (INTENSITY_DRONE_ENABLED) setIntensityTargetGain(0);
}
