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
import { getFlavour } from './flavour.js';

interface Track {
  id: string;
  src: string;
  /** Per-track gain trim (0..1) for level-matching against other tracks. */
  trim?: number;
  /** Stings (hull-breached) play once — looping default is true. */
  loop?: boolean;
  /** Seconds to seek into the track on first play. Used for slow-orbit
   *  (and any other track with a long ambient intro) so the climactic
   *  section lands during the wave's playable window instead of after
   *  the player has died. Loop-back also seeks here, so subsequent
   *  loops skip the intro too. */
  startAt?: number;
}

const TRACKS: Record<string, Track> = {
  // ── Originals (waves 1-25, title, warp, death, victory) ──────────
  'pallasite-idle':  { src: '/music/pallasite-idle.opus',  id: 'pallasite-idle' },
  // 8-minute ambient piece — climax starts ~3:40 in. Seek past the
  // intro so wave 1's playable window catches the energy rather than
  // the slow build (which the player almost never hears).
  'slow-orbit':      { src: '/music/slow-orbit.opus',      id: 'slow-orbit', startAt: 200 },
  'tighter-orbits':  { src: '/music/tighter-orbits.opus',  id: 'tighter-orbits' },
  'cascade':         { src: '/music/cascade.opus',         id: 'cascade' },
  'warp-transition': { src: '/music/warp-transition.opus', id: 'warp-transition' },
  'event-horizon':   { src: '/music/event-horizon.opus',   id: 'event-horizon' },
  'hull-breached':   { src: '/music/hull-breached.opus',   id: 'hull-breached', loop: false },
  'banked':          { src: '/music/banked.opus',          id: 'banked' },
  // ── Additions (per-wave detail tracks + cinematic stings) ────────
  '303-belt':        { src: '/music/303-belt.opus',        id: '303-belt' },
  'apophis':         { src: '/music/apophis.opus',         id: 'apophis' },
  'banked-coin':     { src: '/music/banked-coin.opus',     id: 'banked-coin', loop: false },
  'belt-drill':      { src: '/music/belt-drill.opus',      id: 'belt-drill' },
  'hull-plating':    { src: '/music/hull-plating.opus',    id: 'hull-plating' },
  'hyperspace':      { src: '/music/hyperspace.opus',      id: 'hyperspace' },  // loops — bonus-level bed (W9 → W10)
  'ion-stream':      { src: '/music/ion-stream.opus',      id: 'ion-stream' },
  'mine-field':      { src: '/music/mine-field.opus',      id: 'mine-field' },
  'olivine':         { src: '/music/olivine.opus',         id: 'olivine' },
  'perihelion':      { src: '/music/perihelion.opus',      id: 'perihelion' },
  'slipstream':      { src: '/music/slipstream.opus',      id: 'slipstream' },
  'slow-gravity':    { src: '/music/slow-gravity.opus',    id: 'slow-gravity' },
  'tangent':         { src: '/music/tangent.opus',         id: 'tangent' },
  'tank-dive':       { src: '/music/tank-dive.opus',       id: 'tank-dive' },
  'tidal-locked':    { src: '/music/tidal-locked.opus',    id: 'tidal-locked' },
  'vacuum':          { src: '/music/vacuum.opus',          id: 'vacuum' },
  // ── Bonus levels (single-room detours) ───────────────────────────
  'the-cult':        { src: '/music/the-cult.opus',        id: 'the-cult' },  // 600bn Sanctum bed
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
  // Don't set crossOrigin — the music files are same-origin so it's
  // redundant, AND on iOS Safari setting it without matching CORS
  // response headers from the server taints the MediaElementSource and
  // makes Web Audio output silent zeroes (the visualiser still gets a
  // signal because the analyser tap reads pre-taint, but the gain →
  // destination chain plays nothing). The waveform was visible while
  // the audio was silent — exactly that fingerprint.
  const src = ctx.createMediaElementSource(el);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain);
  gain.connect(dest);
  const entry: Loaded = { el, src, gain, failed: false };
  el.addEventListener('error', () => { entry.failed = true; });
  // Honour startAt — seek into the track once metadata arrives so the
  // first play starts mid-track. timeupdate watches for the natural
  // loop point so subsequent loops also skip back to startAt instead
  // of replaying the slow intro.
  if (track.startAt && track.startAt > 0) {
    const target = track.startAt;
    el.addEventListener('loadedmetadata', () => {
      if (el.currentTime < target) {
        try { el.currentTime = target; } catch { /* ignore */ }
      }
    });
    if (track.loop !== false) {
      el.addEventListener('timeupdate', () => {
        if (el.duration > 0 && el.currentTime >= el.duration - 0.1) {
          try { el.currentTime = target; } catch { /* ignore */ }
        }
      });
    }
  }
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

/** Per-wave track map. Each entry picks a bespoke piece keyed off the
 *  wave's lore + threat mix (see types.ts WAVE_LORE). Falls back to the
 *  legacy 4-band fallbacks if a wave is somehow out of range. */
const WAVE_TRACKS: Record<number, string> = {
   1: 'slow-orbit',      //  1 Krasnojarsk — opener, calm
   2: 'slow-gravity',    //  2 Brenham — calm but heavy
   3: '303-belt',        //  3 Esquel — gem-grade, rhythmic
   4: 'ion-stream',      //  4 Fukang — elites incoming, energy ramping
   5: 'olivine',         //  5 Imilac — bank sats, mineral theme
   6: 'belt-drill',      //  6 Mineo — iron, industrial
   7: 'tank-dive',       //  7 Zaisho — tanks roll
   8: 'mine-field',      //  8 Marjalahti — mines arm
   9: 'tighter-orbits',  //  9 Omolon — breather, mid-game keystone
  10: 'slipstream',      // 10 Springwater — snipers calibrate
  11: 'tidal-locked',    // 11 Glorieta Mtn — two wells
  12: 'tangent',         // 12 Seymchan — reclassified, twisty
  13: 'vacuum',          // 13 Albin — edges open
  14: 'tank-dive',       // 14 Brahin — tanks anchor
  15: 'hull-plating',    // 15 Ahumada — defensive, conserve chain
  16: 'cascade',         // 16 Itzawisis — pallasite seam, cascade peak
  17: 'cascade',         // 17 Eagle Station — past halfway
  18: 'perihelion',      // 18 Newport — lanes tighten, close to the sun
  19: 'slipstream',      // 19 Otinapa — snipers brake
  20: 'hull-plating',    // 20 Conception Jct — chain hard
  21: 'tangent',         // 21 Quijingue — anomalous
  22: 'vacuum',          // 22 Phillips County — trust no orbit
  23: 'apophis',         // 23 Admire — six wells, existential
  24: 'perihelion',      // 24 Hambleton — last orbit before horizon
  25: 'event-horizon',   // 25 boss
};

/** Title-screen idle rotation. The first title visit of the session
 *  always picks pallasite-idle so the brand theme plays on a fresh
 *  launch; subsequent returns (back from game-over → title) rotate
 *  through the pool so re-entries feel fresh. Pool keeps to calmer
 *  pieces so the title screen never blasts a wave-25 boss bed. */
const TITLE_POOL: readonly string[] = [
  'pallasite-idle',
  'slow-gravity',
  'tidal-locked',
  'slipstream',
  'vacuum',
];
let titleVisits = 0;
let currentTitleTrack: string = TITLE_POOL[0];
/** One-shot override — after a successful sats claim, the very next
 *  visit to the title screen plays 'banked-coin' instead of the
 *  rotation pool, then clears on the next pick. Set by faucet
 *  claim-success handler. */
let pendingPostClaimTrack: string | null = null;
function pickTitleTrack(): string {
  if (pendingPostClaimTrack) {
    currentTitleTrack = pendingPostClaimTrack;
    pendingPostClaimTrack = null;
    titleVisits += 1;
    return currentTitleTrack;
  }
  if (titleVisits === 0) {
    titleVisits += 1;
    currentTitleTrack = TITLE_POOL[0];
    return currentTitleTrack;
  }
  // Pick from the rest of the pool, excluding whichever we played last
  // so we never repeat back-to-back.
  const rest = TITLE_POOL.filter((t) => t !== currentTitleTrack);
  currentTitleTrack = rest[Math.floor(Math.random() * rest.length)];
  titleVisits += 1;
  return currentTitleTrack;
}

/** Called by the claim-success handler to override the next title
 *  visit's music with 'banked-coin'. The flag clears after a single
 *  pick, so subsequent title returns resume the normal rotation. */
export function musicNotifyClaimSuccess(): void {
  pendingPostClaimTrack = 'banked-coin';
}

/** Map (phase, wave) to a track id. */
function trackForState(state: GameState): string | null {
  switch (state.phase) {
    case 'title':
      return currentTitleTrack;
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
    case 'bonus':
      // 60s W9 → W10 detour. hyperspace track is a frantic mental-prodigy
      // bed that loops for the whole window (it's set loop:false in TRACKS
      // because it's also used as a one-shot sting elsewhere, but the
      // crossfade machinery here drives it via the music gain bus so
      // looping vs not doesn't actually matter — the track plays for
      // the bonus duration and crossfades out when wave 10 starts).
      return 'hyperspace';
    case 'sanctum':
      // 600bn Sanctum bed — the-cult plays through the full 240s
      // four-phase arc. Lazy-preloaded when getFlavour()==='600bn'
      // via preloadAllTracks (see music.ts FLAVOUR_CRITICAL).
      return 'the-cult';
    case 'wavestart':
    case 'playing': {
      const w = state.wave;
      const picked = WAVE_TRACKS[w];
      if (picked) return picked;
      // Legacy band fallbacks — used if a future wave > 25 ever lands.
      if (w >= 1 && w <= 8)   return 'slow-orbit';
      if (w >= 9 && w <= 16)  return 'tighter-orbits';
      if (w >= 17 && w <= 24) return 'cascade';
      return 'cascade';
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
let lastPhase: string | null = null;
export function musicSetTrackForState(state: GameState): void {
  // Title rotation hook — on phase TRANSITION into 'title', pick a
  // fresh track from the idle pool. Done here (in the once-per-frame
  // setter) rather than in trackForState because the latter is called
  // every frame and would re-pick on every tick.
  if (lastPhase !== 'title' && state.phase === 'title') pickTitleTrack();
  // Warp entry: lazy-prime the upcoming wave's track so its crossfade
  // at wavestart isn't waiting on a cold fetch. 1.3s warp window vs
  // ~2s cold-fetch on slow networks would otherwise leave the new
  // wave's first beat silent.
  if (lastPhase !== 'warp' && state.phase === 'warp') {
    const upcoming = WAVE_TRACKS[state.warpTargetWave ?? state.wave + 1];
    if (upcoming) preloadTrack(upcoming);
  }
  lastPhase = state.phase;
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
/** Prime the *critical* tracks — ones whose cue window is too tight
 *  for a cold fetch on slow networks. Everything else lazy-loads on
 *  first crossfade. Used to preload all 24 tracks, but the new music
 *  set runs to ~63MB and most players never reach the late waves, so
 *  this now primes only the title + wave-1 + the cinematic stings. */
const CRITICAL_TRACKS: readonly string[] = [
  'pallasite-idle',   // title — first thing the user hears
  'slow-orbit',       // wave 1 — first crossfade after IGNITE
  'warp-transition',  // 1.3s window between waves
  'hyperspace',       // 1.3s window on ship hyperjump
  'hull-breached',    // death sting, must land instantly
  'banked',           // victory sting, must land instantly
];
/** Flavour-gated additions to the critical preload set. The 600bn Sanctum
 *  has a single bed (the-cult) that needs to land instantly when the player
 *  taps PLAY — no fallback track to fade in behind it. Only preloaded on
 *  600b.pallasite.app so the main game doesn't ship the 3MB file. */
const FLAVOUR_CRITICAL: Record<string, readonly string[]> = {
  '600bn': ['the-cult'],
};
export function preloadAllTracks(): void {
  for (const id of CRITICAL_TRACKS) {
    const track = TRACKS[id];
    if (track) try { load(track); } catch { /* ignore */ }
  }
  const extra = FLAVOUR_CRITICAL[getFlavour()] ?? [];
  for (const id of extra) {
    const track = TRACKS[id];
    if (track) try { load(track); } catch { /* ignore */ }
  }
}

/** Lazy-prime a single track by id. Useful for wave-change handlers
 *  that want to fetch the upcoming wave's bed before it crossfades in. */
export function preloadTrack(id: string): void {
  const track = TRACKS[id];
  if (!track) return;
  try { load(track); } catch { /* ignore */ }
}

export function musicForceRefresh(): void {
  lastAppliedKey = '';
}

/**
 * Dispose every cached music element + audio node. The next load() call
 * for any track id will create fresh DOM Audio + MediaElementSourceNode
 * pairs. Used by the global first-interaction unlock on iOS, where the
 * elements created during the loop's pre-gesture tick are silently
 * blocked even after ctx.resume() — Web Audio gives them zeroes
 * indefinitely. Replacing the elements is the only reliable cure.
 */
export function musicResetElements(): void {
  for (const entry of loaded.values()) {
    try { entry.el.pause(); } catch { /* ignore */ }
    try { entry.src.disconnect(); } catch { /* ignore */ }
    try { entry.gain.disconnect(); } catch { /* ignore */ }
  }
  loaded.clear();
  currentId = null;
  lastAppliedKey = '';
}

/**
 * Prime every music track under the active user gesture so each
 * underlying HTMLAudioElement gets its mandatory in-gesture .play() and
 * stays unlocked for the rest of the session. Without this, only the
 * track played by the initial musicSetTrackForState (pallasite-idle) is
 * activated — later phase changes load fresh elements outside any
 * gesture, iOS rejects their .play(), and the wave bands fall silent.
 *
 * Each element is muted before play() to keep the priming inaudible,
 * then paused + unmuted via the play promise so it's left in a clean
 * ready-to-play state. `skipId` lets the caller exclude the track
 * that's about to be played normally — otherwise we'd race the
 * gesture-bound startNew against our own pause.
 */
export function musicWarmUpAll(skipId?: string): void {
  for (const id of Object.keys(TRACKS)) {
    if (id === skipId) continue;
    try {
      const entry = load(TRACKS[id]);
      const track = TRACKS[id];
      entry.el.muted = true;
      const p = entry.el.play();
      const cleanup = (): void => {
        // If musicSetTrackForState picked this track between the muted
        // play() and the cleanup callback resolving, DO NOT pause it —
        // that would kill the real play we just kicked off, leaving
        // the wave silent. This was the wave-1-silence bug.
        if (currentId === id) {
          try { entry.el.muted = false; } catch { /* ignore */ }
          return;
        }
        try { entry.el.pause(); } catch { /* ignore */ }
        // Restore to startAt (not 0) so the next real play picks up
        // mid-track for tracks that opt into it (slow-orbit).
        try { entry.el.currentTime = track.startAt ?? 0; } catch { /* ignore */ }
        try { entry.el.muted = false; } catch { /* ignore */ }
      };
      if (p && typeof p.then === 'function') p.then(cleanup, cleanup);
      else cleanup();
    } catch { /* ignore */ }
  }
}

/** Display metadata for the music-player menu. `wave` lets the UI
 *  render a prominent wave-number tag for wave tracks; null for
 *  stings/title that aren't tied to a specific wave. `category`
 *  drives section grouping in renderMusicPlayer — 'sting' for the
 *  STINGS · SYSTEM band, 'wave' for the main wave setlist (1 → 25),
 *  'bonus' for off-rail level beds (W9→W10 hyperspace, 600bn the-cult). */
export interface TrackInfo {
  id: string;
  label: string;
  hint: string;
  wave: number | null;
  category: 'sting' | 'wave' | 'bonus';
}

const TRACK_INFO: TrackInfo[] = [
  // ── Stings + system (no wave) ────────────────────────────────────
  { id: 'pallasite-idle',  label: 'PALLASITE IDLE',  hint: 'Title theme',         wave: null, category: 'sting' },
  { id: 'warp-transition', label: 'WARP TRANSITION', hint: 'Inter-wave riser',    wave: null, category: 'sting' },
  { id: 'hull-breached',   label: 'HULL BREACHED',   hint: 'Death sting',         wave: null, category: 'sting' },
  { id: 'banked',          label: 'BANKED',          hint: 'Victory sting',       wave: null, category: 'sting' },
  { id: 'banked-coin',     label: 'BANKED COIN',     hint: 'Sat pickup sting',    wave: null, category: 'sting' },
  // ── Bonus levels (off-rail detours) ──────────────────────────────
  { id: 'hyperspace',      label: 'HYPERSPACE',      hint: 'Bonus level · W9 → W10', wave: null, category: 'bonus' },
  { id: 'the-cult',        label: 'THE CULT',        hint: '600bn Sanctum · single stone', wave: null, category: 'bonus' },
  // ── Wave tracks, in wave order so the menu reads like a setlist ──
  { id: 'slow-orbit',      label: 'SLOW ORBIT',      hint: 'Krasnojarsk',         wave:  1, category: 'wave' },
  { id: 'slow-gravity',    label: 'SLOW GRAVITY',    hint: 'Brenham',             wave:  2, category: 'wave' },
  { id: '303-belt',        label: '303 BELT',        hint: 'Esquel',              wave:  3, category: 'wave' },
  { id: 'ion-stream',      label: 'ION STREAM',      hint: 'Fukang · elites',     wave:  4, category: 'wave' },
  { id: 'olivine',         label: 'OLIVINE',         hint: 'Imilac · bank',       wave:  5, category: 'wave' },
  { id: 'belt-drill',      label: 'BELT DRILL',      hint: 'Mineo · iron',        wave:  6, category: 'wave' },
  { id: 'tank-dive',       label: 'TANK DIVE',       hint: 'Zaisho · tanks',      wave:  7, category: 'wave' },
  { id: 'mine-field',      label: 'MINE FIELD',      hint: 'Marjalahti · mines',  wave:  8, category: 'wave' },
  { id: 'tighter-orbits',  label: 'TIGHTER ORBITS',  hint: 'Omolon',              wave:  9, category: 'wave' },
  { id: 'slipstream',      label: 'SLIPSTREAM',      hint: 'Springwater · snipers', wave: 10, category: 'wave' },
  { id: 'tidal-locked',    label: 'TIDAL LOCKED',    hint: 'Glorieta Mtn · wells', wave: 11, category: 'wave' },
  { id: 'tangent',         label: 'TANGENT',         hint: 'Seymchan',            wave: 12, category: 'wave' },
  { id: 'vacuum',          label: 'VACUUM',          hint: 'Albin · edges open',  wave: 13, category: 'wave' },
  { id: 'hull-plating',    label: 'HULL PLATING',    hint: 'Ahumada · defensive', wave: 15, category: 'wave' },
  { id: 'cascade',         label: 'CASCADE',         hint: 'Itzawisis · seam',    wave: 16, category: 'wave' },
  { id: 'perihelion',      label: 'PERIHELION',      hint: 'Newport · close to sun', wave: 18, category: 'wave' },
  { id: 'apophis',         label: 'APOPHIS',         hint: 'Admire · existential', wave: 23, category: 'wave' },
  { id: 'event-horizon',   label: 'EVENT HORIZON',   hint: 'Final arena · boss',  wave: 25, category: 'wave' },
];

export function listTracks(): readonly TrackInfo[] { return TRACK_INFO; }

/** Currently-active track id, or null when silent. Used by the music
 *  player UI to highlight the active row. */
export function currentTrackId(): string | null { return currentId; }

/** Crossfade to a track id without going through the state-driven memo
 *  path. Used by the music-player easter egg.
 *
 *  Crucially, this does NOT invalidate lastAppliedKey. The game loop ticks
 *  musicSetTrackForState every frame and the player is opened from the
 *  title screen — if the memo were cleared, the next tick would resolve
 *  'title|0' → 'pallasite-idle' and instantly crossfade back over our
 *  chosen track. Leaving the memo at its title key means the loop returns
 *  early and the previewed track plays uninterrupted. The player's BACK
 *  button calls musicForceRefresh() on close so the loop re-resolves the
 *  current phase track on the next tick.
 *
 *  Defensive belt-and-braces for iOS: explicitly resume the AudioContext
 *  here (even though the row tap also calls audio.unlockAudio) and snap
 *  the new track's gain straight to its trim instead of relying on the
 *  rampGainTo schedule, because a context that's still transitioning out
 *  of 'suspended' has unreliable currentTime advancement and the ramp
 *  can complete with the gain still at 0 (silent track). */
export function musicPreviewPlay(id: string): void {
  const dest = getMusicDestination();
  const ctx = dest.context as AudioContext;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
  crossfadeTo(id, 250);
  // Snap the picked track's gain to full (bypass the 0→trim ramp). The
  // crossfadeTo path is still doing the previous track's fade-out, so the
  // transition isn't an audible cut — but the new track is guaranteed
  // audible the moment its play() is called.
  const entry = loaded.get(id);
  const trim = TRACKS[id]?.trim ?? 1;
  if (entry) {
    entry.gain.gain.cancelScheduledValues(ctx.currentTime);
    entry.gain.gain.value = trim;
  }
}

export function musicStop(fadeMs = DEFAULT_FADE_MS): void {
  crossfadeTo(null, fadeMs);
  lastAppliedKey = '';
}

/**
 * Pause/resume music playback without changing the active track. Used by
 * the visibilitychange / pagehide handlers so backgrounded PWAs go silent
 * instead of decoding music in the background. iOS Safari is unreliable
 * about honouring .pause() on its own when a PWA is swiped away — the OS
 * may keep the element decoding for the lock-screen control centre — so
 * we ALSO set muted=true to silence the output even if decode survives.
 * On unpause only the currently active track resumes; previously faded-out
 * tracks stay paused so they don't suddenly play when the PWA returns.
 */
export function musicSetPaused(paused: boolean): void {
  if (paused) {
    for (const entry of loaded.values()) {
      try { entry.el.pause(); } catch { /* ignore */ }
      try { entry.el.muted = true; } catch { /* ignore */ }
    }
    return;
  }
  for (const entry of loaded.values()) {
    try { entry.el.muted = false; } catch { /* ignore */ }
  }
  if (currentId) {
    const entry = loaded.get(currentId);
    if (entry && !entry.failed) {
      void entry.el.play().catch(() => undefined);
    }
  }
}
