/**
 * Web Audio synth FX — pure synthesis, no samples (music goes through the
 * separate `musicBus` exposed via `getMusicDestination`).
 *
 * Signal chain:
 *   sfx → sfxBus ──────────→ masterGain → compressor → ctx.destination
 *                ↘ reverbSend → convolver → reverbWet ↗
 *   music → musicBus ──────→ masterGain
 *
 * sfxBus, musicBus, masterGain each carry an independent persisted volume so
 * the settings panel can mix the three. Mute multiplies into masterGain so
 * both branches go silent in one move.
 */

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let compressor: DynamicsCompressorNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let reverbBus: ConvolverNode | null = null;
let reverbWet: GainNode | null = null;

const STORAGE_KEY = 'pallasite:audio';
const DEFAULTS = { master: 0.7, music: 0.55, sfx: 0.85, muted: false };
type AudioSettings = typeof DEFAULTS;

let settings: AudioSettings = loadSettings();
let musicDuck = 1;  // 1.0 = no duck, <1.0 ducks music (pause overlay sets 0.3)

function loadSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    const p = parsed as Partial<AudioSettings>;
    return {
      master: clamp01(typeof p.master === 'number' ? p.master : DEFAULTS.master),
      music:  clamp01(typeof p.music  === 'number' ? p.music  : DEFAULTS.music),
      sfx:    clamp01(typeof p.sfx    === 'number' ? p.sfx    : DEFAULTS.sfx),
      muted:  typeof p.muted === 'boolean' ? p.muted : DEFAULTS.muted,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Build a synthetic impulse response — exponentially-decaying stereo noise.
 * Cheap, sounds like a generous "space hangar" reverb.
 */
function buildReverbIR(c: AudioContext, durationSec = 2.4, decay = 2.2): AudioBuffer {
  const length = Math.floor(c.sampleRate * durationSec);
  const buffer = c.createBuffer(2, length, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return buffer;
}

function getCtx(): AudioContext {
  if (!ctx) {
    const AudioCtor = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    ctx = new AudioCtor();

    masterGain = ctx.createGain();
    masterGain.gain.value = settings.muted ? 0 : settings.master;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-12, ctx.currentTime);
    compressor.ratio.setValueAtTime(4, ctx.currentTime);
    compressor.attack.setValueAtTime(0.005, ctx.currentTime);
    compressor.release.setValueAtTime(0.12, ctx.currentTime);
    compressor.knee.setValueAtTime(8, ctx.currentTime);

    reverbBus = ctx.createConvolver();
    reverbBus.buffer = buildReverbIR(ctx, 2.4, 2.2);

    reverbWet = ctx.createGain();
    reverbWet.gain.value = 0.22;

    sfxBus = ctx.createGain();
    sfxBus.gain.value = settings.sfx;

    musicBus = ctx.createGain();
    musicBus.gain.value = settings.music * musicDuck;

    const reverbSend = ctx.createGain();
    reverbSend.gain.value = 0.32;

    sfxBus.connect(masterGain);
    sfxBus.connect(reverbSend);
    reverbSend.connect(reverbBus);
    reverbBus.connect(reverbWet);
    reverbWet.connect(masterGain);
    musicBus.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);
  }
  return ctx;
}

function rampGain(node: GainNode | null, target: number, ms = 60): void {
  if (!node || !ctx) return;
  const t = ctx.currentTime;
  node.gain.cancelScheduledValues(t);
  node.gain.setValueAtTime(node.gain.value, t);
  node.gain.linearRampToValueAtTime(target, t + ms / 1000);
}

/** Resume the audio context — must be called from a user gesture handler. */
export async function unlockAudio(): Promise<void> {
  const c = getCtx();
  if (c.state === 'suspended') {
    await c.resume();
  }
}

/**
 * Suspend the AudioContext so nothing reaches the speakers while the page
 * is hidden. iOS PWAs in particular can keep HTMLAudio elements playing in
 * the background unless explicitly silenced; pair this with pausing the
 * music elements (see music.ts:musicSetPaused) on visibilitychange.
 *
 * No-op when audio hasn't been unlocked yet (ctx may not exist) or the
 * context is already suspended.
 */
export function suspendPlayback(): void {
  if (ctx && ctx.state === 'running') {
    void ctx.suspend().catch(() => undefined);
  }
}

/**
 * Reverse of suspendPlayback. Safe to call on a never-unlocked context;
 * resumes only when the context is in the suspended state.
 */
export function resumePlayback(): void {
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

export function setMuted(value: boolean): void {
  settings.muted = value;
  saveSettings();
  rampGain(masterGain, value ? 0 : settings.master, 80);
}

export function isMuted(): boolean {
  return settings.muted;
}

export function getMasterVolume(): number { return settings.master; }
export function getMusicVolume(): number  { return settings.music; }
export function getSfxVolume(): number    { return settings.sfx; }

export function setMasterVolume(v: number): void {
  settings.master = clamp01(v);
  saveSettings();
  if (!settings.muted) rampGain(masterGain, settings.master, 80);
}

export function setMusicVolume(v: number): void {
  settings.music = clamp01(v);
  saveSettings();
  rampGain(musicBus, settings.music * musicDuck, 80);
}

export function setSfxVolume(v: number): void {
  settings.sfx = clamp01(v);
  saveSettings();
  rampGain(sfxBus, settings.sfx, 80);
}

/** Duck music to a fraction of its set volume (used by pause overlays). 1.0 = no duck. */
export function setMusicDuck(amount: number): void {
  musicDuck = clamp01(amount);
  rampGain(musicBus, settings.music * musicDuck, 200);
}

/**
 * Transient music duck — quick attack, short hold, gentle release. Used by
 * impact SFX (hull breach, mine destroyed, shield ignite) so the punch of the
 * effect cuts through without permanently riding the music gain.
 *
 * Schedules directly on the music bus via Web Audio events. Doesn't touch the
 * `musicDuck` constant, so a pause/resume mid-pulse still lands at the right
 * baseline once the release ramp finishes.
 */
export function pulseDuck(depth: number, totalMs: number = 240): void {
  if (!musicBus || !ctx) return;
  const baseline = settings.music * musicDuck;
  const ducked = baseline * clamp01(depth);
  const t = ctx.currentTime;
  const attackS = 0.025;
  const sustainS = (totalMs / 1000) * 0.30;
  const releaseEndS = totalMs / 1000;
  musicBus.gain.cancelScheduledValues(t);
  musicBus.gain.setValueAtTime(musicBus.gain.value, t);
  musicBus.gain.linearRampToValueAtTime(ducked, t + attackS);
  musicBus.gain.setValueAtTime(ducked, t + attackS + sustainS);
  musicBus.gain.linearRampToValueAtTime(baseline, t + releaseEndS);
}

/** Returned for music.ts to wire MediaElementAudioSourceNode into the music bus. */
export function getMusicDestination(): AudioNode {
  getCtx();  // ensure bus exists
  return musicBus!;
}

/** All non-dry SFX connect here — gets a reverb tail automatically. */
function destination(): AudioNode {
  return sfxBus!;
}

/** Bypasses the reverb bus — used for clicks that would smear (heartbeat, ticks). */
function dryDestination(): AudioNode {
  return masterGain!;
}

// ── Thrust (continuous when held) ────────────────────────────────────────────

let thrustNode: { osc1: OscillatorNode; osc2: OscillatorNode; sub: OscillatorNode; noise: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null;

export function thrustOn(): void {
  if (settings.muted) return;
  if (thrustNode) return;
  const c = getCtx();

  // Layer 1: filtered noise (jet exhaust)
  const noise = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  noise.buffer = buf;
  noise.loop = true;

  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = 320;
  noiseFilter.Q.value = 1.4;

  // LFO modulates the noise filter for movement
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 7;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 80;
  lfo.connect(lfoGain);
  lfoGain.connect(noiseFilter.frequency);

  // Layer 2: sawtooth body
  const osc1 = c.createOscillator();
  osc1.type = 'sawtooth';
  osc1.frequency.value = 78;

  // Layer 3: detuned saw for chorus
  const osc2 = c.createOscillator();
  osc2.type = 'sawtooth';
  osc2.frequency.value = 80;

  // Layer 4: sub-bass thump (sine, very low)
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 42;

  const gain = c.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(0.22, c.currentTime + 0.06);

  noise.connect(noiseFilter);
  noiseFilter.connect(gain);
  osc1.connect(gain);
  osc2.connect(gain);
  sub.connect(gain);
  gain.connect(destination());

  noise.start();
  osc1.start();
  osc2.start();
  sub.start();
  lfo.start();
  thrustNode = { osc1, osc2, sub, noise, gain, lfo };
}

export function thrustOff(): void {
  if (!thrustNode) return;
  const c = getCtx();
  const { osc1, osc2, sub, noise, gain, lfo } = thrustNode;
  gain.gain.cancelScheduledValues(c.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.1);
  setTimeout(() => {
    try { osc1.stop(); osc2.stop(); sub.stop(); noise.stop(); lfo.stop(); } catch { /* ignore */ }
  }, 120);
  thrustNode = null;
}

// ── Fire — meaty laser with body resonance ───────────────────────────────────

export function fire(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Body thump — sub-bass kick for impact
  const thump = c.createOscillator();
  thump.type = 'sine';
  const thumpGain = c.createGain();
  thump.frequency.setValueAtTime(80, t0);
  thump.frequency.exponentialRampToValueAtTime(35, t0 + 0.08);
  thumpGain.gain.setValueAtTime(0.32, t0);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
  thump.connect(thumpGain);
  thumpGain.connect(destination());
  thump.start(t0);
  thump.stop(t0 + 0.12);

  // Laser body — square + sine swept
  const osc1 = c.createOscillator();
  osc1.type = 'square';
  const osc2 = c.createOscillator();
  osc2.type = 'sine';
  const gain = c.createGain();
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3600, t0);
  filter.frequency.exponentialRampToValueAtTime(380, t0 + 0.14);
  filter.Q.value = 4;

  osc1.frequency.setValueAtTime(1400, t0);
  osc1.frequency.exponentialRampToValueAtTime(180, t0 + 0.14);
  osc2.frequency.setValueAtTime(900, t0);
  osc2.frequency.exponentialRampToValueAtTime(120, t0 + 0.16);

  gain.gain.setValueAtTime(0.26, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);

  osc1.connect(filter);
  osc2.connect(filter);
  filter.connect(gain);
  gain.connect(destination());
  osc1.start(t0);
  osc2.start(t0);
  osc1.stop(t0 + 0.18);
  osc2.stop(t0 + 0.18);
}

// ── Explosion — cinematic 4-layer ────────────────────────────────────────────

export function explosion(scale: number = 1): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Layer 1: white-noise burst with low-pass sweep
  const burstBuf = c.createBuffer(1, c.sampleRate * 0.6, c.sampleRate);
  const burstData = burstBuf.getChannelData(0);
  for (let i = 0; i < burstData.length; i++) {
    const decay = 1 - i / burstData.length;
    burstData[i] = (Math.random() * 2 - 1) * decay * decay;
  }
  const burst = c.createBufferSource();
  burst.buffer = burstBuf;
  const burstFilter = c.createBiquadFilter();
  burstFilter.type = 'lowpass';
  burstFilter.frequency.setValueAtTime(2800 * scale, t0);
  burstFilter.frequency.exponentialRampToValueAtTime(80, t0 + 0.5);
  const burstGain = c.createGain();
  burstGain.gain.setValueAtTime(0.55 * scale, t0);
  burstGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
  burst.connect(burstFilter);
  burstFilter.connect(burstGain);
  burstGain.connect(destination());
  burst.start(t0);
  burst.stop(t0 + 0.62);

  // Layer 2: sub-bass thump (the punch)
  const thump = c.createOscillator();
  thump.type = 'sine';
  const thumpGain = c.createGain();
  thump.frequency.setValueAtTime(120 * scale, t0);
  thump.frequency.exponentialRampToValueAtTime(28, t0 + 0.32);
  thumpGain.gain.setValueAtTime(0.55 * scale, t0);
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
  thump.connect(thumpGain);
  thumpGain.connect(destination());
  thump.start(t0);
  thump.stop(t0 + 0.42);

  // Layer 3: high-frequency crackle (fragmenting metal)
  const crackle = c.createOscillator();
  crackle.type = 'square';
  const crackleGain = c.createGain();
  crackle.frequency.setValueAtTime(220 * scale, t0);
  crackle.frequency.exponentialRampToValueAtTime(50, t0 + 0.18);
  crackleGain.gain.setValueAtTime(0.22 * scale, t0);
  crackleGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
  crackle.connect(crackleGain);
  crackleGain.connect(destination());
  crackle.start(t0);
  crackle.stop(t0 + 0.22);

  // Layer 4: low rumble tail — feeds the reverb generously for echo
  const rumbleBuf = c.createBuffer(1, c.sampleRate * 1.1, c.sampleRate);
  const rumbleData = rumbleBuf.getChannelData(0);
  for (let i = 0; i < rumbleData.length; i++) {
    const t = i / rumbleData.length;
    rumbleData[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.6) * 0.4;
  }
  const rumble = c.createBufferSource();
  rumble.buffer = rumbleBuf;
  const rumbleFilter = c.createBiquadFilter();
  rumbleFilter.type = 'lowpass';
  rumbleFilter.frequency.value = 180;
  const rumbleGain = c.createGain();
  rumbleGain.gain.setValueAtTime(0.4 * scale, t0 + 0.05);
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
  rumble.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(destination());
  rumble.start(t0);
  rumble.stop(t0 + 1.12);
}

// ── UFO siren — menacing wobble ──────────────────────────────────────────────

let ufoSiren: { osc: OscillatorNode; osc2: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode; gain: GainNode } | null = null;

export function ufoSirenStart(): void {
  if (settings.muted || ufoSiren) return;
  const c = getCtx();

  // Two slightly detuned squares — dissonance signals "threat"
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 240;
  const osc2 = c.createOscillator();
  osc2.type = 'square';
  osc2.frequency.value = 247;  // slight detune for beating

  // Slow wobble LFO
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 4.5;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 60;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  lfoGain.connect(osc2.frequency);

  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 520;
  filter.Q.value = 4;

  const gain = c.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(0.07, c.currentTime + 0.15);

  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(gain);
  gain.connect(destination());

  osc.start();
  osc2.start();
  lfo.start();
  ufoSiren = { osc, osc2, lfo, lfoGain, gain };
}

export function ufoSirenStop(): void {
  if (!ufoSiren) return;
  const c = getCtx();
  const { osc, osc2, lfo, gain } = ufoSiren;
  gain.gain.cancelScheduledValues(c.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.1);
  setTimeout(() => {
    try { osc.stop(); osc2.stop(); lfo.stop(); } catch { /* ignore */ }
  }, 120);
  ufoSiren = null;
}

export function ufoShoot(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Aggressive saw with a tiny noise burst at the head
  const noiseBuf = c.createBuffer(1, c.sampleRate * 0.04, c.sampleRate);
  const noiseData = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.6;
  const noise = c.createBufferSource();
  noise.buffer = noiseBuf;
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(0.2, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.04);
  noise.connect(noiseGain);
  noiseGain.connect(destination());
  noise.start(t0);
  noise.stop(t0 + 0.05);

  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(960, t0);
  osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.14);
  gain.gain.setValueAtTime(0.18, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

// ── Mine arming — low ominous tick + high counter-note ───────────────────────

export function mineArm(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Low tick
  const low = c.createOscillator();
  low.type = 'square';
  const lowGain = c.createGain();
  low.frequency.setValueAtTime(110, t0);
  low.frequency.exponentialRampToValueAtTime(70, t0 + 0.22);
  lowGain.gain.setValueAtTime(0.16, t0);
  lowGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
  low.connect(lowGain);
  lowGain.connect(destination());
  low.start(t0);
  low.stop(t0 + 0.24);

  // High counter — dissonant minor 2nd
  const high = c.createOscillator();
  high.type = 'sine';
  const highGain = c.createGain();
  high.frequency.setValueAtTime(880, t0 + 0.12);
  highGain.gain.setValueAtTime(0, t0 + 0.12);
  highGain.gain.linearRampToValueAtTime(0.08, t0 + 0.14);
  highGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.32);
  high.connect(highGain);
  highGain.connect(destination());
  high.start(t0 + 0.12);
  high.stop(t0 + 0.34);
}

// ── Shield — crystalline shimmer ─────────────────────────────────────────────

export function shieldUp(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  // Two-tone rising chord with a sparkle on top
  const notes = [
    { startFreq: 523, endFreq: 660, delay: 0, type: 'triangle' as OscillatorType },
    { startFreq: 783, endFreq: 988, delay: 0.04, type: 'triangle' as OscillatorType },
    { startFreq: 1567, endFreq: 1976, delay: 0.08, type: 'sine' as OscillatorType },
  ];
  for (const n of notes) {
    const osc = c.createOscillator();
    osc.type = n.type;
    const gain = c.createGain();
    osc.frequency.setValueAtTime(n.startFreq, t0 + n.delay);
    osc.frequency.linearRampToValueAtTime(n.endFreq, t0 + n.delay + 0.2);
    gain.gain.setValueAtTime(0, t0 + n.delay);
    gain.gain.linearRampToValueAtTime(0.16, t0 + n.delay + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + n.delay + 0.4);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(t0 + n.delay);
    osc.stop(t0 + n.delay + 0.42);
  }
}

export function shieldDown(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'triangle';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(660, t0);
  osc.frequency.exponentialRampToValueAtTime(180, t0 + 0.22);
  gain.gain.setValueAtTime(0.16, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.26);
}

export function shieldHit(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  // Bright sparkle ping with shimmer
  const osc = c.createOscillator();
  osc.type = 'sine';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(1760, t0);
  osc.frequency.exponentialRampToValueAtTime(2640, t0 + 0.08);
  gain.gain.setValueAtTime(0.2, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.14);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.16);

  // Glassy harmonic
  const harm = c.createOscillator();
  harm.type = 'sine';
  const harmGain = c.createGain();
  harm.frequency.setValueAtTime(3520, t0 + 0.02);
  harmGain.gain.setValueAtTime(0.08, t0 + 0.02);
  harmGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
  harm.connect(harmGain);
  harmGain.connect(destination());
  harm.start(t0 + 0.02);
  harm.stop(t0 + 0.18);
}

// ── Warp jump — dimensional sweep ────────────────────────────────────────────

export function warpJump(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Sub bass swell
  const sub = c.createOscillator();
  sub.type = 'sine';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(40, t0);
  sub.frequency.exponentialRampToValueAtTime(220, t0 + 0.6);
  // Halved gains across all three layers to make room for the warp-transition
  // music opus that plays during this same 1300ms window. Was drowning it out.
  subGain.gain.setValueAtTime(0.0, t0);
  subGain.gain.linearRampToValueAtTime(0.18, t0 + 0.3);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 1.3);

  // Whoosh — filtered noise sweeping up
  const buf = c.createBuffer(1, c.sampleRate * 1.2, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 3;
  filter.frequency.setValueAtTime(200, t0);
  filter.frequency.exponentialRampToValueAtTime(4500, t0 + 0.8);
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(0.0, t0);
  noiseGain.gain.linearRampToValueAtTime(0.22, t0 + 0.4);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.1);
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(destination());
  noise.start(t0);
  noise.stop(t0 + 1.2);

  // Detuned sine pad on top (chorusy)
  const pad1 = c.createOscillator();
  pad1.type = 'sine';
  const pad2 = c.createOscillator();
  pad2.type = 'sine';
  const padGain = c.createGain();
  pad1.frequency.setValueAtTime(330, t0 + 0.2);
  pad1.frequency.linearRampToValueAtTime(660, t0 + 1.0);
  pad2.frequency.setValueAtTime(335, t0 + 0.2);
  pad2.frequency.linearRampToValueAtTime(665, t0 + 1.0);
  padGain.gain.setValueAtTime(0, t0 + 0.2);
  padGain.gain.linearRampToValueAtTime(0.07, t0 + 0.5);
  padGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.2);
  pad1.connect(padGain);
  pad2.connect(padGain);
  padGain.connect(destination());
  pad1.start(t0 + 0.2);
  pad2.start(t0 + 0.2);
  pad1.stop(t0 + 1.22);
  pad2.stop(t0 + 1.22);
}

/**
 * Glitched warp — same family as `warpJump` but visibly *wrong*. Rolling pitch
 * dropouts, detuned low-end, no resolution into the bright pad. Fires the
 * instant the malfunction roll lands so the cloak is audibly off, not just
 * silent-then-explode.
 */
export function warpJumpGlitch(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Wrong-direction sub: drops instead of rises, ends low and unresolved
  const sub = c.createOscillator();
  sub.type = 'sawtooth';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(220, t0);
  sub.frequency.exponentialRampToValueAtTime(48, t0 + 0.65);
  subGain.gain.setValueAtTime(0.0, t0);
  subGain.gain.linearRampToValueAtTime(0.42, t0 + 0.18);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.05);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 1.1);

  // Bit-crushed noise pulses — three abrupt drops simulate signal-loss
  for (let i = 0; i < 3; i++) {
    const start = t0 + 0.05 + i * 0.18;
    const buf = c.createBuffer(1, c.sampleRate * 0.18, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let n = 0; n < data.length; n++) data[n] = (Math.random() * 2 - 1) * 0.6;
    const noise = c.createBufferSource();
    noise.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 8;
    filter.frequency.value = 800 + i * 380;
    const g = c.createGain();
    g.gain.setValueAtTime(0.32, start);
    g.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
    noise.connect(filter);
    filter.connect(g);
    g.connect(destination());
    noise.start(start);
    noise.stop(start + 0.18);
  }

  // Detuned dyad in a minor 2nd — the dissonance is the tell
  const a = c.createOscillator();
  a.type = 'square';
  const b = c.createOscillator();
  b.type = 'square';
  const dyadGain = c.createGain();
  a.frequency.setValueAtTime(440, t0 + 0.15);
  a.frequency.exponentialRampToValueAtTime(220, t0 + 1.0);
  b.frequency.setValueAtTime(466, t0 + 0.15);  // semitone above — sour
  b.frequency.exponentialRampToValueAtTime(233, t0 + 1.0);
  dyadGain.gain.setValueAtTime(0, t0 + 0.15);
  dyadGain.gain.linearRampToValueAtTime(0.13, t0 + 0.4);
  dyadGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.05);
  a.connect(dyadGain);
  b.connect(dyadGain);
  dyadGain.connect(destination());
  a.start(t0 + 0.15);
  b.start(t0 + 0.15);
  a.stop(t0 + 1.07);
  b.stop(t0 + 1.07);
}

/**
 * Dust shard pickup — softer than the sat coin arpeggio. A single pure sine
 * with a gentle harmonic sparkle. Differentiated so the player can tell by
 * ear whether they grabbed sats or filler score, even before glancing at the
 * HUD.
 */
export function dustPickup(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  // Single bright sine, brief
  const osc = c.createOscillator();
  osc.type = 'sine';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(1320, t0);          // E6 — glassy
  osc.frequency.exponentialRampToValueAtTime(1660, t0 + 0.07);
  gain.gain.setValueAtTime(0.10, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.14);
  // High-shimmer harmonic at half volume for a peridot-crystal sparkle
  const harm = c.createOscillator();
  harm.type = 'sine';
  const harmGain = c.createGain();
  harm.frequency.setValueAtTime(2640, t0);         // octave above
  harmGain.gain.setValueAtTime(0.05, t0);
  harmGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.10);
  harm.connect(harmGain);
  harmGain.connect(destination());
  harm.start(t0);
  harm.stop(t0 + 0.12);
}

// ── Coin pickup — three-note ascending arpeggio ──────────────────────────────

export function coinPickup(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const notes = [880, 1108, 1397];  // A5, C#6, F6 — bright major triad
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const gain = c.createGain();
    const start = t0 + i * 0.04;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.5, start + 0.1);
    gain.gain.setValueAtTime(0.18, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(start);
    osc.stop(start + 0.16);
  });
}

// ── Hit — meaty thud, not a click ────────────────────────────────────────────

export function hit(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  // Body
  const osc = c.createOscillator();
  osc.type = 'square';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(260, t0);
  osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.08);
  gain.gain.setValueAtTime(0.3, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.12);

  // Sub thump
  const sub = c.createOscillator();
  sub.type = 'sine';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(70, t0);
  sub.frequency.exponentialRampToValueAtTime(35, t0 + 0.1);
  subGain.gain.setValueAtTime(0.32, t0);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 0.14);
}

// ── Level-up — bright fanfare with sub ───────────────────────────────────────

export function levelUp(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const notes = [440, 554.37, 659.25, 880];  // A4 C#5 E5 A5
  notes.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    const gain = c.createGain();
    osc.frequency.value = freq;
    const start = t0 + i * 0.07;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(start);
    osc.stop(start + 0.24);
  });
  // Sub-bass underpin
  const sub = c.createOscillator();
  sub.type = 'sine';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(110, t0);
  sub.frequency.linearRampToValueAtTime(220, t0 + 0.3);
  subGain.gain.setValueAtTime(0, t0);
  subGain.gain.linearRampToValueAtTime(0.22, t0 + 0.05);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 0.5);
}

// ── Extra life — sparkly rising ──────────────────────────────────────────────

export function extraLife(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const lfo = c.createOscillator();
  const lfoGain = c.createGain();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, t0);
  osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.5);
  lfo.frequency.value = 8;
  lfoGain.gain.value = 30;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  gain.gain.setValueAtTime(0.22, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  lfo.start(t0);
  osc.stop(t0 + 0.65);
  lfo.stop(t0 + 0.65);
}

// ── Game over — cinematic descent ────────────────────────────────────────────

export function gameOver(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Sawtooth descent
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(220, t0);
  osc.frequency.exponentialRampToValueAtTime(45, t0 + 1.3);
  gain.gain.setValueAtTime(0.32, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.4);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 1.4);

  // Sub layer
  const sub = c.createOscillator();
  sub.type = 'sine';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(110, t0);
  sub.frequency.exponentialRampToValueAtTime(28, t0 + 1.4);
  subGain.gain.setValueAtTime(0.36, t0);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.5);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 1.5);

  // Noise wash for desolation
  const buf = c.createBuffer(1, c.sampleRate * 1.4, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 1.5) * 0.4;
  }
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 350;
  const noiseGain = c.createGain();
  noiseGain.gain.setValueAtTime(0.18, t0);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.3);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(destination());
  noise.start(t0);
  noise.stop(t0 + 1.4);
}

// ── Triumph (boss-down + completion) ─────────────────────────────────────────

export function triumph(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Sub-bass swell
  const sub = c.createOscillator();
  sub.type = 'sine';
  const subGain = c.createGain();
  sub.frequency.setValueAtTime(55, t0);
  sub.frequency.linearRampToValueAtTime(110, t0 + 0.6);
  subGain.gain.setValueAtTime(0, t0);
  subGain.gain.linearRampToValueAtTime(0.36, t0 + 0.15);
  subGain.gain.exponentialRampToValueAtTime(0.001, t0 + 1.7);
  sub.connect(subGain);
  subGain.connect(destination());
  sub.start(t0);
  sub.stop(t0 + 1.8);

  // Stacked major chord — staggered brass stab
  const chord = [261.63, 329.63, 392.0, 523.25, 659.25];
  chord.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = i < 2 ? 'sawtooth' : 'triangle';
    const gain = c.createGain();
    const start = t0 + i * 0.05;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.16, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 1.3);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(start);
    osc.stop(start + 1.4);
  });

  // Sparkle arpeggio
  const top = [880, 1108, 1318, 1760];
  top.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    const gain = c.createGain();
    const start = t0 + 0.3 + i * 0.06;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.24);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(start);
    osc.stop(start + 0.26);
  });
}

// ── Power-up drop — rising tritone with sparkle ──────────────────────────────

export function powerupDrop(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;

  const osc = c.createOscillator();
  osc.type = 'square';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(440, t0);
  osc.frequency.exponentialRampToValueAtTime(880, t0 + 0.18);
  gain.gain.setValueAtTime(0.14, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + 0.26);

  // Sparkle on top
  const sp = c.createOscillator();
  sp.type = 'sine';
  const spGain = c.createGain();
  sp.frequency.setValueAtTime(2640, t0 + 0.06);
  sp.frequency.exponentialRampToValueAtTime(3520, t0 + 0.18);
  spGain.gain.setValueAtTime(0.1, t0 + 0.06);
  spGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
  sp.connect(spGain);
  spGain.connect(destination());
  sp.start(t0 + 0.06);
  sp.stop(t0 + 0.24);
}

// ── Power-up pickup — bright chord stab ──────────────────────────────────────

export function powerupPickup(): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const chord = [523.25, 659.25, 783.99, 1046.5];  // C E G C
  chord.forEach((freq, i) => {
    const osc = c.createOscillator();
    osc.type = 'triangle';
    const gain = c.createGain();
    osc.frequency.setValueAtTime(freq, t0 + i * 0.02);
    osc.frequency.linearRampToValueAtTime(freq * 1.1, t0 + 0.18 + i * 0.02);
    gain.gain.setValueAtTime(0, t0 + i * 0.02);
    gain.gain.linearRampToValueAtTime(0.16, t0 + 0.04 + i * 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.45 + i * 0.02);
    osc.connect(gain);
    gain.connect(destination());
    osc.start(t0 + i * 0.02);
    osc.stop(t0 + 0.48 + i * 0.02);
  });
  // High sparkle
  const sparkle = c.createOscillator();
  sparkle.type = 'sine';
  const sparkleGain = c.createGain();
  sparkle.frequency.setValueAtTime(2093, t0 + 0.06);
  sparkle.frequency.exponentialRampToValueAtTime(1568, t0 + 0.2);
  sparkleGain.gain.setValueAtTime(0, t0 + 0.06);
  sparkleGain.gain.linearRampToValueAtTime(0.1, t0 + 0.08);
  sparkleGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
  sparkle.connect(sparkleGain);
  sparkleGain.connect(destination());
  sparkle.start(t0 + 0.06);
  sparkle.stop(t0 + 0.26);
}

// ── Combo tick — clean bell, rises in pitch with chain depth ─────────────────

export function comboTick(level: number): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  osc.type = 'sine';
  const gain = c.createGain();
  const freq = 523 * Math.pow(1.18, Math.max(0, level - 1));
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t0 + 0.08);
  gain.gain.setValueAtTime(0.18, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.16);
  osc.connect(gain);
  gain.connect(dryDestination());  // dry to keep the click crisp
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

// ── Heartbeat — low pulse during play (dry, no reverb smear) ─────────────────

let heartbeatHandle: number | null = null;
let heartbeatPeriod = 1.0;

export function startHeartbeat(): void {
  if (settings.muted) return;
  if (heartbeatHandle !== null) return;
  const tick = (): void => {
    const c = getCtx();
    const osc = c.createOscillator();
    osc.type = 'sine';
    const gain = c.createGain();
    osc.frequency.value = 60;
    gain.gain.setValueAtTime(0.18, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(dryDestination());
    osc.start();
    osc.stop(c.currentTime + 0.13);
  };
  heartbeatHandle = window.setInterval(tick, heartbeatPeriod * 1000);
}

export function setHeartbeatPeriod(seconds: number): void {
  heartbeatPeriod = Math.max(0.3, Math.min(2.0, seconds));
  if (heartbeatHandle !== null) {
    stopHeartbeat();
    startHeartbeat();
  }
}

export function stopHeartbeat(): void {
  if (heartbeatHandle !== null) {
    window.clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

// ── Ambient drone — low pad while playing, fades on pause/death ──────────────

let ambient: { sub: OscillatorNode; mid: OscillatorNode; high: OscillatorNode; lfo: OscillatorNode; lfoGain: GainNode; gain: GainNode; filter: BiquadFilterNode } | null = null;

export function startAmbient(): void {
  if (settings.muted || ambient) return;
  const c = getCtx();
  const t0 = c.currentTime;

  // Three oscillators forming a low spread chord — A1, A2, E3
  const sub = c.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = 55;

  const mid = c.createOscillator();
  mid.type = 'triangle';
  mid.frequency.value = 110;
  // Slight detune for life
  mid.detune.value = -8;

  const high = c.createOscillator();
  high.type = 'triangle';
  high.frequency.value = 165;
  high.detune.value = 6;

  // Slow LFO sweeps the filter for movement
  const lfo = c.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.15;  // very slow
  const lfoGain = c.createGain();
  lfoGain.gain.value = 200;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 600;
  filter.Q.value = 1.4;
  lfo.connect(lfoGain);
  lfoGain.connect(filter.frequency);

  const gain = c.createGain();
  gain.gain.value = 0;
  gain.gain.linearRampToValueAtTime(0.10, t0 + 1.5);  // slow fade-in

  sub.connect(filter);
  mid.connect(filter);
  high.connect(filter);
  filter.connect(gain);
  gain.connect(destination());

  sub.start(t0);
  mid.start(t0);
  high.start(t0);
  lfo.start(t0);
  ambient = { sub, mid, high, lfo, lfoGain, gain, filter };
}

export function stopAmbient(): void {
  if (!ambient) return;
  const c = getCtx();
  const { sub, mid, high, lfo, gain } = ambient;
  gain.gain.cancelScheduledValues(c.currentTime);
  gain.gain.setValueAtTime(gain.gain.value, c.currentTime);
  gain.gain.linearRampToValueAtTime(0, c.currentTime + 0.6);
  setTimeout(() => {
    try { sub.stop(); mid.stop(); high.stop(); lfo.stop(); } catch { /* ignore */ }
  }, 700);
  ambient = null;
}

// ── Arcade initials entry — square-wave bleeps for the high-score widget ─────

/** Internal square-wave blip helper for the initials sounds. Short, punchy. */
function squareBlip(startFreq: number, endFreq: number, durationMs: number, volume: number): void {
  if (settings.muted) return;
  const c = getCtx();
  const t0 = c.currentTime;
  const dur = durationMs / 1000;
  const osc = c.createOscillator();
  osc.type = 'square';
  const gain = c.createGain();
  osc.frequency.setValueAtTime(startFreq, t0);
  if (endFreq !== startFreq) osc.frequency.linearRampToValueAtTime(endFreq, t0 + dur);
  // Snap-attack envelope, no exponential decay tail — keeps the chiptune
  // staccato feel rather than the softer sine arpeggios used elsewhere.
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.005);
  gain.gain.linearRampToValueAtTime(volume, t0 + dur - 0.01);
  gain.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(gain);
  gain.connect(destination());
  osc.start(t0);
  osc.stop(t0 + dur + 0.01);
}

/** ↑/↓ — character cycle. Mid-pitch beep, no slide. */
export function initialCycle(): void {
  squareBlip(880, 880, 45, 0.07);
}

/** ←/→ — cursor slot move. Lower, even shorter click. */
export function initialMove(): void {
  squareBlip(523, 523, 30, 0.06);
}

/** Backspace — descending bleep. */
export function initialBackspace(): void {
  squareBlip(660, 330, 70, 0.07);
}

/** Enter / auto-submit — two-note ascending confirm. */
export function initialCommit(): void {
  if (settings.muted) return;
  squareBlip(660, 660, 50, 0.09);
  setTimeout(() => squareBlip(990, 990, 80, 0.10), 60);
}
