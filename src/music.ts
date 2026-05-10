/**
 * Music subsystem — HTMLAudio elements wired through `audio.getMusicDestination()`
 * so the settings panel's music slider applies via the shared musicBus.
 *
 * Tracks are loaded lazily on first play. Crossfades are short (default 800ms)
 * because the maps are tonal: lingering on the previous key clashes.
 *
 * If a track src 404s the call resolves silently — the game keeps playing in
 * silence rather than throwing. This is what lets us ship the title and
 * waves-1-8 tracks now and add the rest as they're laundered.
 */

import { getMusicDestination } from './audio.js';
import type { GameState } from './types.js';

interface Track {
  id: string;
  src: string;
  /** Per-track gain trim (0..1) for level-matching against other tracks. */
  trim?: number;
  /** Stings (hull-breached) play once — looping default is true. */
  loop?: boolean;
}

const TRACKS: Record<string, Track> = {
  'pallasite-idle':  { src: '/music/pallasite-idle.opus',  id: 'pallasite-idle' },
  'slow-orbit':      { src: '/music/slow-orbit.opus',      id: 'slow-orbit' },
  'tighter-orbits':  { src: '/music/tighter-orbits.opus',  id: 'tighter-orbits' },
  'cascade':         { src: '/music/cascade.opus',         id: 'cascade' },
  'warp-transition': { src: '/music/warp-transition.opus', id: 'warp-transition' },
  'event-horizon':   { src: '/music/event-horizon.opus',   id: 'event-horizon' },
  'hull-breached':   { src: '/music/hull-breached.opus',   id: 'hull-breached', loop: false },
  'banked':          { src: '/music/banked.opus',          id: 'banked' },
};

interface FadeProfile {
  /** Crossfade duration in ms. Defaults to DEFAULT_FADE_MS. */
  fadeMs?: number;
  /** If set, the new track waits this many ms after the old has finished
   *  fading out before its own fade-in begins. Used for cinematic stings
   *  (hull-breached, banked) where overlap muddies the moment. */
  sequentialGapMs?: number;
}

/** Per-track fade profiles. Tracks not listed use DEFAULT_FADE_MS with no gap. */
const PHASE_FADE_PROFILE: Partial<Record<string, FadeProfile>> = {
  'warp-transition': { fadeMs: 250 },
  'hull-breached':   { fadeMs: 400, sequentialGapMs: 200 },
  'banked':          { fadeMs: 800, sequentialGapMs: 300 },
};

interface Loaded {
  el: HTMLAudioElement;
  src: MediaElementAudioSourceNode;
  gain: GainNode;
  failed: boolean;
}

const loaded = new Map<string, Loaded>();
let currentId: string | null = null;
let lastAppliedKey = '';  // memoised state→track key so musicSetTrackForState is O(1) per frame

const DEFAULT_FADE_MS = 800;

function load(track: Track): Loaded {
  const cached = loaded.get(track.id);
  if (cached) return cached;
  const dest = getMusicDestination();
  const ctx = dest.context as AudioContext;
  const el = new Audio(track.src);
  el.loop = track.loop !== false;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  const src = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain);
  gain.connect(dest);
  const entry: Loaded = { el, src, gain, failed: false };
  el.addEventListener('error', () => { entry.failed = true; });
  loaded.set(track.id, entry);
  return entry;
}

function rampGainTo(gain: GainNode, target: number, ms: number): void {
  const ctx = gain.context;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(target, t + ms / 1000);
}

/** Crossfade to a track id, or null to fade to silence. No-op if already on it.
 *  Pass `sequentialGapMs` to defer the fade-in until after the previous track's
 *  fade-out completes (for clean cinematic stings — see PHASE_FADE_PROFILE). */
export function crossfadeTo(id: string | null, fadeMs = DEFAULT_FADE_MS, sequentialGapMs = 0): void {
  if (id === currentId) return;
  // Fade out whatever was playing
  if (currentId) {
    const prevId = currentId;
    const prev = loaded.get(prevId);
    if (prev) {
      rampGainTo(prev.gain, 0, fadeMs);
      // Pause once the fade has completed so we don't keep decoding silently
      window.setTimeout(() => {
        if (currentId !== prevId) prev.el.pause();
      }, fadeMs + 40);
    }
  }
  // Schedule the new track. If sequentialGapMs is set, wait for the previous
  // fade to complete + the gap before starting the new one.
  const startNew = (): void => {
    if (!id || currentId !== id) return;  // a newer crossfadeTo cancelled us
    const track = TRACKS[id];
    if (!track) { currentId = null; return; }
    const entry = load(track);
    if (entry.failed) { currentId = null; return; }
    const trim = track.trim ?? 1;
    // Stings (loop:false) always play from 0 on re-trigger.
    if (track.loop === false) {
      try { entry.el.currentTime = 0; } catch { /* will play from 0 anyway */ }
    }
    void entry.el.play().catch(() => { /* autoplay block — caller will retry on unlock */ });
    rampGainTo(entry.gain, trim, fadeMs);
  };
  // Mark currentId immediately so memoisation in musicSetTrackForState matches
  // and a duplicate call during the gap is a no-op.
  currentId = id;
  if (id) {
    if (sequentialGapMs > 0 && currentId) {
      window.setTimeout(startNew, fadeMs + sequentialGapMs);
    } else {
      startNew();
    }
  }
}

/** Map (phase, wave) to a track id. */
function trackForState(state: GameState): string | null {
  switch (state.phase) {
    case 'title':
    case 'paused':
      // 'paused' should keep the wave track ducked, not switch — see musicSetTrackForState
      return 'pallasite-idle';
    case 'gameover':
      return 'hull-breached';
    case 'completed':
      return 'banked';
    case 'warp':
      // Distinct riser bed during the inter-wave warp tunnel — the wave-band
      // track returns on the next 'wavestart' tick.
      return 'warp-transition';
    case 'wavestart':
    case 'playing': {
      const w = state.wave;
      if (w >= 1 && w <= 8)   return 'slow-orbit';
      if (w >= 9 && w <= 16)  return 'tighter-orbits';
      if (w >= 17 && w <= 24) return 'cascade';
      if (w === 25)           return 'event-horizon';
      return 'cascade';  // unreachable under FINAL_WAVE=25, but cascade is the right fallback
    }
    case 'deathreplay':
      return null;  // silence during replay so the hull-breached sting lands clean at gameover
    default:
      return null;
  }
}

/**
 * Idempotent — call from the game loop. If the resolved track for the current
 * state differs from what's playing, crossfades. Pause uses ducking on top.
 */
export function musicSetTrackForState(state: GameState): void {
  // Pause ducks rather than switches; key the memo on phase+wave so we still
  // crossfade correctly when the wave changes during a paused mid-game.
  const isPaused = state.phase === 'paused';
  const key = `${state.phase}|${state.wave}`;
  if (key === lastAppliedKey) return;
  lastAppliedKey = key;
  if (isPaused) {
    // Don't change the track — the underlying playing track keeps going, just ducked.
    return;
  }
  const id = trackForState(state);
  const profile = id ? PHASE_FADE_PROFILE[id] : undefined;
  crossfadeTo(id, profile?.fadeMs, profile?.sequentialGapMs);
}

/** Reset the memo so the next musicSetTrackForState() will re-resolve and play. */
/** Prime all tracks into the audio graph so the first crossfade doesn't have
 *  to wait for the file to download. Especially matters for warp-transition,
 *  whose 1300ms window is shorter than a cold fetch on slow networks. */
export function preloadAllTracks(): void {
  for (const id of Object.keys(TRACKS)) {
    try { load(TRACKS[id]); } catch { /* ignore — will lazy-load on first use */ }
  }
}

export function musicForceRefresh(): void {
  lastAppliedKey = '';
}

export function musicStop(fadeMs = DEFAULT_FADE_MS): void {
  crossfadeTo(null, fadeMs);
  lastAppliedKey = '';
}

/**
 * Pause/resume music playback without changing the active track. Used by
 * the visibilitychange handler so backgrounded PWAs go silent instead of
 * decoding music in the background. On unpause only the currently active
 * track resumes -- previously faded-out tracks stay paused so they don't
 * suddenly play when the PWA returns.
 */
export function musicSetPaused(paused: boolean): void {
  if (paused) {
    for (const entry of loaded.values()) {
      try { entry.el.pause(); } catch { /* ignore */ }
    }
    return;
  }
  if (currentId) {
    const entry = loaded.get(currentId);
    if (entry && !entry.failed) {
      void entry.el.play().catch(() => undefined);
    }
  }
}
