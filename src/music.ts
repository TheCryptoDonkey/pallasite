/**
 * Music subsystem — HTMLAudio elements with direct playback by default.
 * The settings panel's music slider is applied through per-element volume.
 *
 * Tracks are loaded lazily on first play. Crossfades are short (default 800ms)
 * because the maps are tonal: lingering on the previous key clashes.
 *
 * If a track src 404s the call resolves silently — the game keeps playing in
 * silence rather than throwing. This is what lets us ship the title and
 * waves-1-8 tracks now and add the rest as they're laundered.
 */

import { getMasterVolume, getMusicAnalyser, getMusicDestination, getMusicDuckFactor, getMusicVolume, isMuted, kickAudioContext } from './audio.js';
import type { GameState } from './types.js';
import { FINAL_WAVE } from './types.js';
import { getFlavour } from './flavour.js';
import { getStoredMode, isSanctumMode } from './mode.js';
import { mobileRuntimeActive } from './visual-style.js';

/** Override hook for flavour-specific wave music. When 600bn flavour
 *  is active, wave 1 swaps to the-cult.opus instead of slow-orbit.
 *  Returns null when no override applies. */
function flavourTrackOverride(state: GameState): string | null {
  const sanctumWave = (getFlavour() === '600bn' || isSanctumMode()) && state.wave === 1;
  if (sanctumWave) {
    if (state.phase === 'wavestart' || state.phase === 'playing' || state.phase === 'paused') {
      return 'the-cult';
    }
  }
  return null;
}

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

  // ── RELAY VAULT album (Defend The Relay / Echo Seven laundered set) ──
  // A second, switchable soundtrack covering title + all 25 waves + credits.
  // Selected via the music player; see ALBUMS below. Filenames are the
  // laundered opus/m4a pairs; a couple of ids keep their working names
  // while their player-facing labels are re-themed (see TRACK_INFO).
  // startAt (seconds) drops gameplay into each track's most energetic ~55s
  // window — the "good minute" a player actually hears per level — derived from
  // the loudness envelope (tools/derive-startat). Freeplay ignores it and plays
  // from the top. Tracks already hot from bar one carry no startAt.
  'relaykeep-title':      { src: '/music/relaykeep-title.opus',      id: 'relaykeep-title' },
  'the-drift':            { src: '/music/the-drift.opus',            id: 'the-drift',            startAt: 129 },
  'eternal-vigilance':    { src: '/music/eternal-vigilance.opus',    id: 'eternal-vigilance' },
  'space-invaders-march': { src: '/music/space-invaders-march.opus', id: 'space-invaders-march', startAt: 98 },
  'alien-swarm-rising':   { src: '/music/alien-swarm-rising.opus',   id: 'alien-swarm-rising',   startAt: 260 },
  'defenders-resolve':    { src: '/music/defenders-resolve.opus',    id: 'defenders-resolve',    startAt: 68 },
  'blasterz':             { src: '/music/blasterz.opus',             id: 'blasterz',             startAt: 94 },
  'planetary-defense':    { src: '/music/planetary-defense.opus',    id: 'planetary-defense',    startAt: 93 },
  'smart-bombz':          { src: '/music/smart-bombz.opus',          id: 'smart-bombz',          startAt: 53 },
  'the-survivor':         { src: '/music/the-survivor.opus',         id: 'the-survivor',         startAt: 59 },
  'rescue-run':           { src: '/music/rescue-run.opus',           id: 'rescue-run' },
  'wave-after-wave':      { src: '/music/wave-after-wave.opus',      id: 'wave-after-wave' },
  'mutant-invasion':      { src: '/music/mutant-invasion.opus',      id: 'mutant-invasion' },
  'the-swarm':            { src: '/music/the-swarm.opus',            id: 'the-swarm' },
  'cosmic-high-score':    { src: '/music/cosmic-high-score.opus',    id: 'cosmic-high-score',    startAt: 124 },
  'laser-barrage':        { src: '/music/laser-barrage.opus',        id: 'laser-barrage' },
  'missile-command':      { src: '/music/missile-command.opus',      id: 'missile-command' },
  'the-fury':             { src: '/music/the-fury.opus',             id: 'the-fury',             startAt: 74 },
  'the-tempest':          { src: '/music/the-tempest.opus',          id: 'the-tempest' },
  'the-siege':            { src: '/music/the-siege.opus',            id: 'the-siege',            startAt: 102 },
  'the-descent':          { src: '/music/the-descent.opus',          id: 'the-descent' },
  '600b-hole':            { src: '/music/600b-hole.opus',            id: '600b-hole',            startAt: 99 },
  'phoenix-reborn':       { src: '/music/phoenix-reborn.opus',       id: 'phoenix-reborn' },
  'hyperspace-chase':     { src: '/music/hyperspace-chase.opus',     id: 'hyperspace-chase',     startAt: 36 },
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
  src: MediaElementAudioSourceNode | null;
  gain: GainNode | null;
  failed: boolean;
  direct: boolean;
  volumeRaf: number | null;
}

const loaded = new Map<string, Loaded>();
let currentId: string | null = null;
let lastAppliedKey = '';  // memoised state→track key so musicSetTrackForState is O(1) per frame
// Freeplay (the SOUNDTRACK music player) is "a different beast": play full
// songs from the top and roll through the whole album, rather than the
// gameplay behaviour of dropping into each track's best ~minute (startAt) and
// looping it. The flag flips the play path between the two. Only ever true
// while the player overlay is open (bracketed by musicSetFreeplay).
let freeplayActive = false;

const DEFAULT_FADE_MS = 800;

function urlFlag(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name); }
  catch { return null; }
}

/** Music output routing.
 *
 *  DESKTOP → Web Audio path (MediaElementSource → musicBus → masterGain). This
 *  is what feeds the equalizer/visualiser analyser tap and what the gain-bus
 *  crossfade + duck schedule act on. Direct output (below) bypasses all of that,
 *  which is why the equalizer goes dead and ducking stops working under it.
 *
 *  MOBILE/iOS → DIRECT playback (HTMLAudioElement.volume). Their
 *  MediaElementSource path can output silence even after the AudioContext is
 *  unlocked (Safari/iOS especially), so direct is the validated reliable path.
 *
 *  SELF-HEAL → if the Web Audio path is ever detected silent at runtime on
 *  desktop (the "silent after repeated Chrome autoplay recovery" edge case that
 *  motivated forcing direct everywhere in 5399fa6), `forcedDirectBySilence`
 *  latches for the session and we rebuild onto the direct path — so this can
 *  never be worse than the all-direct behaviour, only better (equalizer back).
 *
 *  Overrides: ?webaudioMusic=1 forces Web Audio; ?directMusic=1 forces direct. */
let forcedDirectBySilence = false;
function directMusicOutputActive(): boolean {
  if (urlFlag('webaudioMusic') === '1') return false;
  if (urlFlag('directMusic') === '1') return true;
  if (mobileRuntimeActive()) return true;
  return forcedDirectBySilence;
}

let trustedMediaGestureSeen = false;
function markTrustedMediaGesture(event: Event): void {
  if (event.isTrusted) trustedMediaGestureSeen = true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointerup', markTrustedMediaGesture, true);
  window.addEventListener('click', markTrustedMediaGesture, true);
  window.addEventListener('keyup', markTrustedMediaGesture, true);
}

function mediaPlaybackGestureReady(): boolean {
  return trustedMediaGestureSeen;
}

// Lightweight, rate-limited music diagnostics. Music failures were historically
// swallowed by empty catches, which is exactly why "music is broken" has been
// impossible to put a finger on. These surface the failure reason on
// console.warn (and a window event the ?dbg=audio overlay can pick up),
// rate-limited per message so a repeating failure logs once every couple of
// seconds rather than every frame.
const musicLogAt = new Map<string, number>();
function logMusic(msg: string): void {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const last = musicLogAt.get(msg) ?? -Infinity;
  if (now - last < 2000) return;
  if (musicLogAt.size > 64) musicLogAt.clear();
  musicLogAt.set(msg, now);
  // eslint-disable-next-line no-console
  console.warn('[music]', msg);
  try { window.dispatchEvent(new CustomEvent('pallasite:music-diag', { detail: { msg } })); } catch { /* ignore */ }
}

function directTargetVolume(trim = 1): number {
  if (isMuted()) return 0;
  return Math.max(0, Math.min(1, getMasterVolume() * getMusicVolume() * getMusicDuckFactor() * trim));
}

function setDirectVolume(entry: Loaded, volume: number): void {
  if (entry.volumeRaf !== null) {
    cancelAnimationFrame(entry.volumeRaf);
    entry.volumeRaf = null;
  }
  try { entry.el.volume = Math.max(0, Math.min(1, volume)); } catch { /* ignore */ }
}

function rampDirectVolume(entry: Loaded, target: number, ms: number): void {
  if (entry.volumeRaf !== null) {
    cancelAnimationFrame(entry.volumeRaf);
    entry.volumeRaf = null;
  }
  const start = entry.el.volume;
  const clampedTarget = Math.max(0, Math.min(1, target));
  if (ms <= 0 || Math.abs(start - clampedTarget) < 0.001) {
    setDirectVolume(entry, clampedTarget);
    return;
  }
  const startMs = performance.now();
  const tick = (now: number): void => {
    const t = Math.min(1, (now - startMs) / ms);
    try { entry.el.volume = start + (clampedTarget - start) * t; } catch { /* ignore */ }
    if (t < 1) entry.volumeRaf = requestAnimationFrame(tick);
    else entry.volumeRaf = null;
  };
  entry.volumeRaf = requestAnimationFrame(tick);
}

/** Cache the Opus support test so we don't re-create an Audio element
 *  per load(). Empty string = no support. */
let canPlayOpusCached: boolean | null = null;
function canPlayOpus(): boolean {
  if (canPlayOpusCached !== null) return canPlayOpusCached;
  try {
    canPlayOpusCached = !!new Audio().canPlayType('audio/ogg; codecs=opus');
  } catch {
    canPlayOpusCached = false;
  }
  return canPlayOpusCached;
}

/** Pick the playable URL for a track. The wave / sting set is published
 *  as .opus (smaller files, ~50% bandwidth of equivalent-bitrate AAC).
 *  Mobile Safari can report Opus support too optimistically and then fail
 *  the element load/play path, so phones use the shipped AAC copies. */
function trackUrlFor(track: Track): string {
  if (mobileRuntimeActive()) return track.src.replace(/\.opus$/, '.m4a');
  if (canPlayOpus()) return track.src;
  return track.src.replace(/\.opus$/, '.m4a');
}

function load(track: Track): Loaded {
  const cached = loaded.get(track.id);
  if (cached) return cached;
  const el = new Audio();
  el.loop = track.loop !== false;
  el.preload = mediaPlaybackGestureReady() ? 'auto' : 'none';
  el.src = trackUrlFor(track);
  // The eager el.load() that lived here for the iOS-PWA-readyState-0 case
  // moved into the per-second verify pass (see musicSetTrackForState).
  // Calling load() inside this constructor path fired during the 25-track
  // warm-up musicWarmUpAll runs on first user gesture, which appears to
  // choke iOS PWA enough that the click handler that needs the audio
  // unlock never finishes propagating. The verify-pass retry catches the
  // genuinely-stuck case without the warm-up storm.
  // Don't set crossOrigin — the music files are same-origin so it's
  // redundant, AND on iOS Safari setting it without matching CORS
  // response headers from the server taints the MediaElementSource and
  // makes Web Audio output silent zeroes (the visualiser still gets a
  // signal because the analyser tap reads pre-taint, but the gain →
  // destination chain plays nothing). The waveform was visible while
  // the audio was silent — exactly that fingerprint.
  const direct = directMusicOutputActive();
  let src: MediaElementAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  if (direct) {
    el.volume = 0;
  } else {
    const dest = getMusicDestination();
    const ctx = dest.context as AudioContext;
    src = ctx.createMediaElementSource(el);
    gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(dest);
  }
  const entry: Loaded = { el, src, gain, failed: false, direct, volumeRaf: null };
  // First-time error → try the audio/ogg Blob workaround once. Safari
  // rejects .opus served without an audio/ogg Content-Type with
  // MediaError code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED); side-loading via
  // fetch + Blob with explicit MIME bypasses the server header check.
  // Only retry on code 4 to avoid masking real failures (404, decode).
  let blobRetryUsed = false;
  el.addEventListener('error', () => {
    const code = el.error?.code;
    const msg = el.error?.message;
    console.warn('[music] load failed', { id: track.id, src: track.src, code, msg, blobRetryUsed });
    try {
      window.dispatchEvent(new CustomEvent('pallasite:music-load-failed', {
        detail: { id: track.id, src: track.src, code, msg, blobRetryUsed },
      }));
    } catch { /* ignore */ }

    if (!blobRetryUsed && code === 4) {
      blobRetryUsed = true;
      console.warn('[music] retrying via fetch+Blob/audio-ogg', track.id);
      fetch(track.src)
        .then(async r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const contentType = r.headers.get('content-type') ?? '';
          const buf = await r.arrayBuffer();
          // OGG files start with "OggS" (0x4f 0x67 0x67 0x53). If the
          // server returned HTML (404 page proxied as 200), we'll see
          // ASCII letters here instead. Also log the file size + the
          // Content-Type header so we can tell whether the upstream
          // is serving the file at all.
          const first4 = new Uint8Array(buf.slice(0, 4));
          const magic = String.fromCharCode(first4[0], first4[1], first4[2], first4[3]);
          const isOgg = magic === 'OggS';
          // canPlayType — definitive answer on whether the browser
          // claims OGG/Opus support. '' means no, 'probably' / 'maybe' yes.
          const cpt = new Audio().canPlayType('audio/ogg; codecs=opus');
          console.warn('[music] blob diag', {
            id: track.id, bytes: buf.byteLength, magic, isOgg,
            contentType, canPlayOpus: cpt || '(empty)',
          });
          try {
            window.dispatchEvent(new CustomEvent('pallasite:music-blob-diag', {
              detail: {
                id: track.id, bytes: buf.byteLength, magic, isOgg,
                contentType, canPlayOpus: cpt || '(empty)',
              },
            }));
          } catch { /* ignore */ }
          const blob = new Blob([buf], { type: 'audio/ogg' });
          el.src = URL.createObjectURL(blob);
        })
        .catch(e => {
          console.warn('[music] blob retry fetch failed', track.id, e);
          entry.failed = true;
        });
      return;  // don't mark failed yet — give the blob retry a chance
    }
    entry.failed = true;
  });
  // Honour startAt — seek into the track once metadata arrives so the
  // first play starts mid-track. timeupdate watches for the natural
  // loop point so subsequent loops also skip back to startAt instead
  // of replaying the slow intro. Both are suppressed in freeplay, where
  // the player wants the whole song from the top (see freeplayActive).
  if (track.startAt && track.startAt > 0) {
    const target = track.startAt;
    el.addEventListener('loadedmetadata', () => {
      if (!freeplayActive && el.currentTime < target) {
        try { el.currentTime = target; } catch { /* ignore */ }
      }
    });
    if (track.loop !== false) {
      el.addEventListener('timeupdate', () => {
        if (!freeplayActive && el.duration > 0 && el.currentTime >= el.duration - 0.1) {
          try { el.currentTime = target; } catch { /* ignore */ }
        }
      });
    }
  }
  // Freeplay jukebox: in the player, tracks play loop:false (see startNew) so
  // they end naturally; on 'ended' advance to the next track in the album so
  // the whole album plays through. No-op in gameplay (freeplayActive false).
  el.addEventListener('ended', () => {
    if (freeplayActive && currentId === track.id) advanceFreeplay();
  });
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

function rampEntryTo(entry: Loaded, targetTrim: number, ms: number): void {
  if (entry.gain) {
    rampGainTo(entry.gain, targetTrim, ms);
  } else {
    rampDirectVolume(entry, directTargetVolume(targetTrim), ms);
  }
}

function entryOutputLevel(entry: Loaded): number {
  if (entry.direct) return entry.el.volume;
  return entry.gain?.gain.value ?? 0;
}

function pauseAfterFade(id: string, entry: Loaded, ms: number): void {
  window.setTimeout(() => {
    if (currentId !== id) {
      try { entry.el.pause(); } catch { /* ignore */ }
      if (entry.direct) setDirectVolume(entry, 0);
    }
  }, ms + 60);
}

function silenceStrayTracks(keepIds: ReadonlySet<string>, fadeMs: number): void {
  for (const [id, entry] of loaded) {
    if (keepIds.has(id)) continue;
    rampEntryTo(entry, 0, fadeMs);
    pauseAfterFade(id, entry, fadeMs);
  }
}

function transitionFadeMs(prevId: string | null, nextId: string | null, requestedMs: number): number {
  if (prevId && nextId && prevId !== nextId && TITLE_POOL.includes(prevId)) {
    return Math.min(requestedMs, 220);
  }
  return requestedMs;
}

function refreshDirectVolumes(): void {
  if (!directMusicOutputActive()) return;
  for (const [id, entry] of loaded) {
    if (!entry.direct) continue;
    const isCurrent = id === currentId;
    const trim = isCurrent ? (TRACKS[id]?.trim ?? 1) : 0;
    if (entry.volumeRaf === null) {
      try { entry.el.volume = directTargetVolume(trim); } catch { /* ignore */ }
      if (trim === 0 && !entry.el.paused) {
        try { entry.el.pause(); } catch { /* ignore */ }
      }
      // iOS decoder/network throttle: Safari only lets a few media elements
      // buffer at once. With ~12 cached tracks all on 'auto' preload, the CURRENT
      // bed gets starved at readyState 0/1 indefinitely — confirmed on device
      // (title pallasite-idle + wave-1 slow-orbit stuck loading, while later waves,
      // by which point the warm-up's loads had drained, reached rs4 and played).
      // So keep only the current track buffering and release every other settled
      // direct element's buffer, so the one track we actually need wins a slot. A
      // released track re-buffers via crossfadeTo (preload='auto'+play()) when it
      // next becomes current; the muted-warm play() already unlocked it for the
      // session, so releasing the buffer doesn't re-lock it. Gated on volumeRaf
      // === null so we never touch a track mid-fade (releasing a fading-out bed's
      // buffer could cut its tail on iOS).
      const wantPreload = isCurrent ? 'auto' : 'none';
      if (entry.el.preload !== wantPreload) {
        try { entry.el.preload = wantPreload; } catch { /* ignore */ }
      }
    }
  }
}

/** Crossfade to a track id, or null to fade to silence. No-op if already on it.
 *  Pass `sequentialGapMs` to defer the fade-in until after the previous track's
 *  fade-out completes (for clean cinematic stings — see PHASE_FADE_PROFILE). */
export function crossfadeTo(id: string | null, fadeMs = DEFAULT_FADE_MS, sequentialGapMs = 0): void {
  if (id === currentId) return;
  const prevId = currentId;
  const effectiveFadeMs = transitionFadeMs(prevId, id, fadeMs);
  const keepIds = new Set<string>();
  if (prevId) keepIds.add(prevId);
  if (id) keepIds.add(id);
  silenceStrayTracks(keepIds, Math.min(effectiveFadeMs, 180));
  // Fade out whatever was playing
  if (prevId) {
    const prev = loaded.get(prevId);
    if (prev) {
      rampEntryTo(prev, 0, effectiveFadeMs);
      // Pause once the fade has completed so we don't keep decoding silently
      pauseAfterFade(prevId, prev, effectiveFadeMs);
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
    try { entry.el.muted = false; } catch { /* ignore */ }
    if (entry.direct) setDirectVolume(entry, 0);
    // Position + loop, set per play so a cached element can't carry a stale
    // mode across the gameplay ↔ freeplay boundary:
    //   • Freeplay → full song from the top, loop OFF (so 'ended' fires and
    //     the jukebox advances through the album).
    //   • Gameplay → loop per track; stings restart at 0; looping beds with a
    //     startAt drop straight into their good ~minute.
    if (freeplayActive) {
      entry.el.loop = false;
      try { entry.el.currentTime = 0; } catch { /* play from 0 anyway */ }
    } else {
      entry.el.loop = track.loop !== false;
      if (track.loop === false) {
        try { entry.el.currentTime = 0; } catch { /* play from 0 anyway */ }
      } else if (track.startAt && track.startAt > 0) {
        try { entry.el.currentTime = track.startAt; } catch { /* ignore */ }
      }
    }
    // Verify-state retry. Safari can resolve play() while leaving the
    // element paused (autoplay-race: AudioContext was still
    // transitioning suspended → running when play() was called, so
    // the element decoder was suspended, but the promise resolved
    // anyway). A .catch retry won't fire — we have to check
    // el.paused directly after a delay and re-play if it didn't take.
    // Capped so a genuinely unplayable track doesn't spin forever.
    const attemptPlay = (attempts: number): void => {
      if (currentId !== id) return;
      try {
        void entry.el.play().catch((err: unknown) => {
          // NotAllowedError = autoplay/gesture block; AbortError = load race.
          logMusic(`play() rejected: ${id} (try ${attempts}): ${(err as Error)?.name ?? String(err)}`);
        });
      } catch (err) {
        logMusic(`play() threw: ${id}: ${(err as Error)?.name ?? String(err)}`);
      }
      window.setTimeout(() => {
        if (currentId !== id) return;
        if (entry.el.paused && !entry.failed && attempts < 4) {
          attemptPlay(attempts + 1);
        } else if (entry.el.paused && !entry.failed) {
          logMusic(`stuck paused: ${id} after ${attempts + 1} tries (readyState=${entry.el.readyState}, gesture=${mediaPlaybackGestureReady()}, direct=${entry.direct})`);
        }
      }, 250);
    };
    rampEntryTo(entry, trim, effectiveFadeMs);
    if (!mediaPlaybackGestureReady()) return;
    // In Web Audio mode the element only makes sound while the shared
    // AudioContext is running. The menu preview resumes it explicitly, but the
    // in-game auto-crossfade used to rely on it already being live — so if the
    // context had drifted to 'suspended' (Chrome can do this after focus/idle
    // churn), the track would play() silently in-game while the menu (which
    // resumes) worked fine. Resume on every play so both paths behave the same.
    if (!entry.direct) {
      const c = getMusicDestination().context as AudioContext;
      if (c.state !== 'running' && c.state !== 'closed') {
        try { void c.resume().catch((e: unknown) => logMusic(`ctx.resume rejected: ${(e as Error)?.name ?? String(e)}`)); } catch { /* ignore */ }
      }
      // Warm the analyser now (not at check time) so the silence probe below
      // reads real signal rather than an uninitialised buffer on its first call.
      try { getMusicAnalyser(); } catch { /* ignore */ }
    }
    if (entry.direct) {
      // This track is now current, so it's allowed to buffer again — undo any
      // preload='none' release applied by refreshDirectVolumes while it sat
      // idle (see the iOS decoder-throttle note there). preload='auto' alone
      // resumes buffering without resetting currentTime; only force a full
      // load() from readyState 0, where there's nothing to lose and we want a
      // real network start inside the gesture (a constructor-level load() here
      // would re-create the first-gesture warm-up storm).
      try { entry.el.preload = 'auto'; } catch { /* ignore */ }
      if (entry.el.readyState === 0) {
        try { entry.el.load(); } catch { /* ignore */ }
      }
    }
    attemptPlay(0);
    // Fast startup recovery: a MediaElementSource created during the gesture
    // unlock can be born silent on desktop Chrome and stay dead even through a
    // context suspend→resume — only a real tab-swap revived it. Rather than wait
    // for the once-a-second verify pass to notice, check ~600ms after play and
    // rebuild the source fresh (see reestablishWebAudio) if the analyser is dead
    // while the element is running.
    if (!entry.direct && !triedAudioKick) {
      window.setTimeout(() => {
        if (currentId !== id || forcedDirectBySilence || triedAudioKick) return;
        const e = loaded.get(id);
        if (!e || e.direct || e.el.paused || e.el.currentTime < 0.2) return;
        let energy = 0;
        try {
          const an = getMusicAnalyser();
          const buf = new Uint8Array(an.frequencyBinCount);
          an.getByteFrequencyData(buf);
          for (let i = 0; i < buf.length; i++) energy += buf[i];
        } catch { return; }
        if (energy <= 4) {
          triedAudioKick = true;
          logMusic('web-audio silent shortly after play — rebuilding source fresh');
          void reestablishWebAudio();
        }
      }, 600);
    }
  };
  // Mark currentId immediately so memoisation in musicSetTrackForState matches
  // and a duplicate call during the gap is a no-op.
  currentId = id;
  if (id) {
    if (sequentialGapMs > 0 && currentId) {
      window.setTimeout(startNew, effectiveFadeMs + sequentialGapMs);
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

// ── Albums — switchable soundtracks ─────────────────────────────────
// An album is a full set of *musical beds* covering the campaign arc:
// title, every wave (1→25), and the end-credits/completion screen, plus
// an optional bonus-level bed. The SFX-grade stings (death/hull-breached,
// warp riser, banked-sat) are deliberately NOT part of an album — they
// stay shared across all albums so the game's signature cues always land.
// The active album is a client-side presentation preference (music never
// feeds the deterministic sim), so switching it has no lockstep impact.
interface Album {
  id: string;
  label: string;
  /** Title-screen bed. Pallasite rotates a pool instead (see titlePool). */
  title: string;
  /** Optional title rotation pool — pallasite keeps its multi-track idle
   *  rotation; other albums use the single `title` track. */
  titlePool?: readonly string[];
  /** Completion / end-credits bed. */
  completed: string;
  /** Bonus-level bed (W9→W10). Falls back to the shared 'hyperspace'. */
  bonus?: string;
  /** wave (1-indexed) → track id. Must cover 1..25. */
  waves: Record<number, string>;
}

const ALBUMS: Record<string, Album> = {
  // The original, curated pallasite score — each bed hand-matched to a
  // meteorite/threat. Waves reference the existing WAVE_TRACKS table so the
  // two never drift.
  pallasite: {
    id: 'pallasite',
    label: 'PALLASITE',
    title: 'pallasite-idle',
    titlePool: TITLE_POOL,
    completed: 'banked',
    bonus: 'hyperspace',
    waves: WAVE_TRACKS,
  },
  // Defend The Relay laundered set — a second full soundtrack, energy-arced
  // to the same act structure. 21 distinct wave beds (a few reused, as the
  // pallasite album does) + title + credits + bonus = all 24 tracks placed.
  relay: {
    id: 'relay',
    label: 'RELAY VAULT',
    title: 'relaykeep-title',
    completed: 'phoenix-reborn',
    bonus: 'hyperspace-chase',
    waves: {
       1: 'the-drift',            //  1 Krasnojarsk — calm opener
       2: 'eternal-vigilance',    //  2 Brenham
       3: 'space-invaders-march', //  3 Esquel — rhythmic
       4: 'alien-swarm-rising',   //  4 Fukang — elites incoming
       5: 'defenders-resolve',    //  5 Imilac — heist, heroic
       6: 'blasterz',             //  6 Mineo — iron, action
       7: 'planetary-defense',    //  7 Zaisho — tanks
       8: 'smart-bombz',          //  8 Marjalahti — mines
       9: 'the-survivor',         //  9 Omolon — breather
      10: 'rescue-run',           // 10 Springwater — snipers
      11: 'wave-after-wave',      // 11 Glorieta — two wells
      12: 'mutant-invasion',      // 12 Seymchan — reclassified
      13: 'the-swarm',            // 13 Albin — edges open
      14: 'planetary-defense',    // 14 Brahin — tanks anchor (reuse)
      15: 'eternal-vigilance',    // 15 Ahumada — defensive (reuse)
      16: 'cosmic-high-score',    // 16 Itzawisis — seam peak
      17: 'laser-barrage',        // 17 Eagle Station — past halfway
      18: 'missile-command',      // 18 Newport — lanes tighten
      19: 'rescue-run',           // 19 Otinapa — snipers brake (reuse)
      20: 'the-fury',             // 20 Conception Jct — chain hard
      21: 'the-tempest',          // 21 Quijingue — anomalous storm
      22: 'the-swarm',            // 22 Phillips County — trust no orbit (reuse)
      23: 'the-siege',            // 23 Admire — six wells, siege
      24: 'the-descent',          // 24 Hambleton — last orbit, ominous
      25: '600b-hole',            // 25 EVENT HORIZON — the boss
    },
  },
};

const ALBUM_KEY = 'pallasite:music-album';
let activeAlbumId: string = (() => {
  try {
    const stored = localStorage.getItem(ALBUM_KEY);
    return stored && ALBUMS[stored] ? stored : 'pallasite';
  } catch { return 'pallasite'; }
})();
function activeAlbum(): Album { return ALBUMS[activeAlbumId] ?? ALBUMS.pallasite; }

export interface AlbumInfo { id: string; label: string; }
export function listAlbums(): readonly AlbumInfo[] {
  return Object.values(ALBUMS).map((a) => ({ id: a.id, label: a.label }));
}
export function getActiveAlbumId(): string { return activeAlbumId; }

/** Switch the active in-game album. Persists the choice and invalidates the
 *  track memo so the next loop tick re-resolves the current phase and
 *  crossfades into the new album's bed. No-op for an unknown / unchanged id. */
export function setActiveAlbum(id: string): void {
  if (!ALBUMS[id] || id === activeAlbumId) return;
  activeAlbumId = id;
  try { localStorage.setItem(ALBUM_KEY, id); } catch { /* ignore */ }
  // Prime the new album's first-heard beds so the crossfade isn't cold.
  for (const cid of criticalTrackIds()) preloadTrack(cid);
  musicForceRefresh();
}

/** The album's tracks as a play-through order for the freeplay jukebox:
 *  title → waves (1→N, each distinct bed once) → bonus → credits. Shared
 *  stings aren't part of an album, so they're not in the jukebox. */
function albumOrder(albumId: string): string[] {
  const a = ALBUMS[albumId] ?? ALBUMS.pallasite;
  const ids: string[] = [];
  const push = (id?: string): void => { if (id && !ids.includes(id)) ids.push(id); };
  push(a.title);
  for (const w of Object.keys(a.waves).map(Number).sort((x, y) => x - y)) push(a.waves[w]);
  push(a.bonus);
  push(a.completed);
  return ids;
}

/** Freeplay jukebox: when a track ends in the player, roll on to the next
 *  track in the active album (wrapping), so the whole album plays through. */
function advanceFreeplay(): void {
  const order = albumOrder(activeAlbumId);
  if (!order.length) return;
  const i = currentId ? order.indexOf(currentId) : -1;
  const next = order[(i + 1) % order.length];
  if (next) musicPreviewPlay(next);
}

/** Bracket the SOUNDTRACK player's "freeplay" mode (full songs from the top,
 *  album plays through) on open / close. While off, music behaves as in
 *  gameplay (startAt good-minute + loop). See freeplayActive. */
export function musicSetFreeplay(on: boolean): void {
  freeplayActive = on;
}

/** Map (phase, wave) to a track id. */
function trackForState(state: GameState): string | null {
  // 600bn flavour overrides for the Sanctum wave — the-cult plays
  // through wavestart + playing + paused.
  const override = flavourTrackOverride(state);
  if (override) return override;
  switch (state.phase) {
    case 'title':
      if (getFlavour() === '600bn') return 'the-cult';
      // Pallasite rotates its idle pool (pickTitleTrack); other albums use
      // their single title bed.
      return activeAlbum().titlePool ? currentTitleTrack : activeAlbum().title;
    case 'paused':
      // 'paused' should keep the wave track ducked, not switch — see musicSetTrackForState
      return 'pallasite-idle';
    case 'gameover':
      return 'hull-breached';
    case 'completed':
      return activeAlbum().completed;
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
      return activeAlbum().bonus ?? 'hyperspace';
    case 'sanctum':
      // 600bn Sanctum bed — the-cult plays through the full 240s
      // four-phase arc. Lazy-preloaded when getFlavour()==='600bn'
      // via preloadAllTracks (see music.ts FLAVOUR_CRITICAL).
      return 'the-cult';
    case 'wavestart':
    case 'playing': {
      const w = state.wave;
      const picked = activeAlbum().waves[w];
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
let lastVerifyMs = 0;
const VERIFY_INTERVAL_MS = 1000;
const READY_ZERO_LOADING_GRACE_MS = 8_000;
const READY_ZERO_FORCE_RETRY_MS = 3_000;
let readyZeroTrack: string | null = null;
let readyZeroSinceMs = 0;
let readyZeroLastForceMs = 0;

// Web Audio silence self-heal (desktop). If a track is "playing" via the Web
// Audio path (element advancing, context running) but the analyser tapped off
// musicBus sees no signal, the MediaElementSource is outputting zeroes — the
// desktop "silent until you swap tabs and back" case. Recovery is staged:
//   1) First REBUILD the source from scratch on the live context (dispose the
//      silent element + nodes, recreate via load()) — a source created while the
//      context is running isn't born-silent. This keeps the Web Audio path so
//      the equalizer stays alive. (The old approach merely suspend→resumed the
//      context to mimic the tab-swap, but some Chrome builds ignored it.)
//   2) Only if it's STILL silent after the rebuild, latch onto the direct path
//      for the rest of the session (audible music, no equalizer). Worst case is
//      therefore the all-direct behaviour, never silence.
// Only ever runs in Web Audio mode, so it's a no-op on mobile.
let webAudioSilentSince = 0;
let lastVerifyCurrentTime = -1;
let triedAudioKick = false;
/** Tear down a cached track's element + Web Audio nodes and recreate them
 *  FRESH on the (now-running) context, resuming playback in place. The new
 *  MediaElementSource is created while the context is live, so unlike the
 *  original it can't be born-silent — this is the equalizer-preserving cure
 *  for the desktop "silent until you tab-swap" bug. */
function rebuildSourceFresh(id: string): void {
  const track = TRACKS[id];
  if (!track) return;
  const old = loaded.get(id);
  let resumeAt = 0;
  if (old) {
    try { resumeAt = old.el.currentTime; } catch { /* ignore */ }
    try { old.el.pause(); } catch { /* ignore */ }
    if (old.volumeRaf !== null) { try { cancelAnimationFrame(old.volumeRaf); } catch { /* ignore */ } }
    try { old.src?.disconnect(); } catch { /* ignore */ }
    try { old.gain?.disconnect(); } catch { /* ignore */ }
    loaded.delete(id);
  }
  const fresh = load(track);   // fresh Audio + MediaElementSource on the live ctx
  try { fresh.el.currentTime = resumeAt; } catch { /* ignore */ }
  if (fresh.gain) {
    const ctx = getMusicDestination().context as AudioContext;
    try {
      fresh.gain.gain.cancelScheduledValues(ctx.currentTime);
      fresh.gain.gain.value = track.trim ?? 1;
    } catch { /* ignore */ }
  } else if (fresh.direct) {
    setDirectVolume(fresh, directTargetVolume(track.trim ?? 1));
  }
  try { void fresh.el.play().catch(() => undefined); } catch { /* ignore */ }
}

/**
 * Recover a desktop Web Audio track outputting digital silence. The earlier
 * approach replicated the tab-swap (pause → context suspend/resume → replay),
 * but on some Chrome builds the born-silent MediaElementSource stays dead — only
 * a real visibility change revived it. So instead make sure the context is
 * running, then REBUILD the source from scratch: a source created on a live
 * context isn't born-silent. Keeps the Web Audio path, so the equalizer survives.
 */
async function reestablishWebAudio(): Promise<void> {
  const id = currentId;
  if (!id) return;
  await kickAudioContext();    // ensure the context is running before we recreate
  rebuildSourceFresh(id);      // dispose the silent source + recreate it fresh
}
function maybeSelfHealWebAudioSilence(entry: Loaded, ctx: AudioContext): void {
  if (forcedDirectBySilence) return;
  const t = entry.el.currentTime;
  const advancing = t > 0.25 && Math.abs(t - lastVerifyCurrentTime) > 0.05;
  lastVerifyCurrentTime = t;
  if (ctx.state !== 'running' || !advancing) { webAudioSilentSince = 0; return; }
  let energy = 0;
  try {
    const an = getMusicAnalyser();
    const buf = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(buf);
    for (let i = 0; i < buf.length; i++) energy += buf[i];
  } catch { webAudioSilentSince = 0; return; }
  if (energy > 4) { webAudioSilentSince = 0; triedAudioKick = false; return; }  // real signal present
  const now = performance.now();
  if (webAudioSilentSince === 0) { webAudioSilentSince = now; return; }
  if (now - webAudioSilentSince < 600) return;          // ~2 verify ticks of silence
  webAudioSilentSince = 0;
  if (!triedAudioKick) {
    // Stage 1: rebuild the silent MediaElementSource from scratch on the live
    // context — keeps the equalizer-capable Web Audio path (a fresh source
    // isn't born-silent, unlike the context-cycle which some Chrome builds
    // ignored entirely).
    triedAudioKick = true;
    logMusic('web-audio output silent — rebuilding source fresh (live-context recreate)');
    void reestablishWebAudio();
    return;
  }
  // Stage 2: rebuild didn't help — fall back to direct (audible, no equalizer).
  forcedDirectBySilence = true;
  logMusic('still silent after source rebuild — self-healing onto direct playback (equalizer disabled) for this session');
  const resumeId = currentId;
  musicResetElements();
  musicForceRefresh();
  if (resumeId) crossfadeTo(resumeId, 200);
}

/** Mobile first-unlock defers the CURRENT bed's first real play until the
 *  warm-up burst has drained (see recoverMusicFromGesture). On iOS a bed played
 *  for real *amid* the burst wedges at readyState 0 forever (title pallasite-idle
 *  + wave-1 slow-orbit), while a bed warmed during the burst and played later
 *  (slow-gravity) loads fine — so we warm the current bed in-gesture but hold its
 *  real play for a beat. While suppressed the state-driven crossfade + verify pass
 *  are held; refreshDirectVolumes still runs so nothing is left loud. */
let suppressStatePlayUntilMs = 0;
export function musicSuppressStatePlay(ms: number): void {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  suppressStatePlayUntilMs = now + Math.max(0, ms);
}

export function musicSetTrackForState(state: GameState): void {
  if (directMusicOutputActive()) refreshDirectVolumes();
  if (suppressStatePlayUntilMs > 0) {
    if (performance.now() < suppressStatePlayUntilMs) return;  // hold: warm-up burst still draining
    suppressStatePlayUntilMs = 0;
  }
  // The SOUNDTRACK overlay owns playback while freeplay is active. The game
  // loop still ticks underneath the overlay; if an album change, STOP, or audio
  // recovery clears lastAppliedKey, state-driven music would otherwise reclaim
  // the player a few seconds after a preview starts.
  if (freeplayActive) return;
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
    const upcoming = activeAlbum().waves[state.warpTargetWave ?? state.wave + 1];
    if (upcoming) preloadTrack(upcoming);
  }
  lastPhase = state.phase;

  // Stuck-paused recovery — once per second, verify the current track's
  // element is actually playing. Safari can leave an element silently
  // paused after an autoplay race even though currentId is set and
  // crossfadeTo's memo thinks everything is fine. The retry inside
  // crossfadeTo handles the initial race, but a long-tail recovery
  // here catches any post-pause-resume / visibility-recovery gaps.
  // Skipped for paused / non-playing phases (death replay, gameover
  // hull-breached transitions, etc.) which deliberately allow paused.
  const nowMs = performance.now();
  if (nowMs - lastVerifyMs > VERIFY_INTERVAL_MS) {
    lastVerifyMs = nowMs;
    if (currentId && mediaPlaybackGestureReady() && state.phase !== 'paused' && state.phase !== 'deathreplay') {
      // An iOS interruption can suspend the whole AudioContext while
      // leaving el.paused === false — the element thinks it's playing
      // but the suspended context emits silence. Checking only el.paused
      // misses that, so verify (and revive) the context first. The
      // audio.ts onstatechange handler covers this too; this is the
      // belt-and-braces retry for when its resume() was rejected.
      const ctx = getMusicDestination().context as AudioContext;
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        try { void ctx.resume().catch(() => undefined); } catch { /* ignore */ }
      }
      const entry = loaded.get(currentId);
      if (entry && !entry.failed) {
        if (entry.direct) refreshDirectVolumes();
        if (entry.el.paused && !freeplayActive) {
          // Don't auto-replay in freeplay: a paused track there means it
          // ended (the jukebox 'ended' handler is advancing) or the user hit
          // STOP — replaying would fight either case.
          logMusic(`verify: ${currentId} was paused — replaying (readyState=${entry.el.readyState}, ctx=${ctx.state}, direct=${entry.direct})`);
          try { void entry.el.play().catch((e: unknown) => logMusic(`verify play() rejected: ${currentId}: ${(e as Error)?.name ?? String(e)}`)); } catch { /* ignore */ }
        } else if (!entry.el.paused && entry.el.readyState <= 1) {
          // iOS PWA "play() resolved, no playable data" race. The element thinks
          // it's playing (paused=false) but readyState 0 (HAVE_NOTHING) or 1
          // (HAVE_METADATA — header only, as the title track showed on device)
          // means no playable buffer arrived — the original verify pass only
          // retried on paused=true so this silent failure mode slipped through.
          // If the browser is already loading, do not call load() every verify
          // tick: that aborts the in-flight range request and can permanently
          // starve a 4MB .m4a on production/mobile networks.
          if (readyZeroTrack !== currentId) {
            readyZeroTrack = currentId;
            readyZeroSinceMs = nowMs;
            readyZeroLastForceMs = 0;
          }
          const loading = entry.el.networkState === 2;
          if (loading && nowMs - readyZeroSinceMs < READY_ZERO_LOADING_GRACE_MS) {
            logMusic(`verify: ${currentId} readyState=${entry.el.readyState} while network loading — waiting`);
            return;
          }
          if (nowMs - readyZeroLastForceMs < READY_ZERO_FORCE_RETRY_MS) return;
          readyZeroLastForceMs = nowMs;
          logMusic(`verify: ${currentId} readyState=${entry.el.readyState} while 'playing' — forcing load()+play()`);
          try { entry.el.load(); } catch { /* ignore */ }
          try { void entry.el.play().catch(() => undefined); } catch { /* ignore */ }
        } else if (!entry.direct) {
          if (readyZeroTrack === currentId) {
            readyZeroTrack = null;
            readyZeroSinceMs = 0;
            readyZeroLastForceMs = 0;
          }
          // Element genuinely playing via Web Audio — make sure it's audible.
          maybeSelfHealWebAudioSilence(entry, ctx);
        } else if (readyZeroTrack === currentId) {
          readyZeroTrack = null;
          readyZeroSinceMs = 0;
          readyZeroLastForceMs = 0;
        }
      }
    }
  }

  // Pause ducks rather than switches; include the resolved track in the memo
  // so same phase+wave transitions between modes (campaign wave 1 vs SANCTUM
  // wave 1) still re-resolve and crossfade correctly.
  const isPaused = state.phase === 'paused';
  const id = trackForState(state);
  const key = `${state.phase}|${state.wave}|${state.warpTargetWave ?? ''}|${id ?? 'silence'}`;
  if (key === lastAppliedKey) return;
  lastAppliedKey = key;
  if (isPaused) {
    // Don't change the track — the underlying playing track keeps going, just ducked.
    return;
  }
  const profile = id ? PHASE_FADE_PROFILE[id] : undefined;
  crossfadeTo(id, profile?.fadeMs, profile?.sequentialGapMs);
}

/** Reset the memo so the next musicSetTrackForState() will re-resolve and play. */
/** Prime the *critical* tracks — ones whose cue window is too tight
 *  for a cold fetch on slow networks. Everything else lazy-loads on
 *  first crossfade. Used to preload all 24 tracks, but the new music
 *  set runs to ~63MB and most players never reach the late waves, so
 *  this now primes only the title + wave-1 + the cinematic stings. */
// Shared stings whose cue window is too tight for a cold fetch — primed
// regardless of which album is active (they aren't part of any album).
const SHARED_CRITICAL: readonly string[] = [
  'warp-transition',  // 1.3s window between waves
  'hull-breached',    // death sting, must land instantly
  'banked-coin',      // post-claim title sting
];

/** Album-aware critical preload set: shared stings + the active album's
 *  first-heard beds (title, wave 1, bonus, completion). Deliberately small —
 *  everything else lazy-loads on first crossfade so we don't ship ~60MB up
 *  front for late-wave beds most players never reach. */
function criticalTrackIds(): string[] {
  if (sanctumMusicFocusActive()) {
    const ids = getFlavour() === '600bn' ? ['the-cult'] : ['pallasite-idle', 'the-cult'];
    return ids.filter((id) => !!TRACKS[id]);
  }
  const a = activeAlbum();
  const ids = new Set<string>(SHARED_CRITICAL);
  ids.add(a.title);              // title — first thing the user hears
  ids.add(a.waves[1]);           // wave 1 — first crossfade after IGNITE
  ids.add(a.completed);          // victory sting, must land instantly
  ids.add(a.bonus ?? 'hyperspace'); // 1.3s window on the W9→W10 detour
  return [...ids].filter((id) => !!TRACKS[id]);
}
/** Flavour-gated additions to the critical preload set. */
const FLAVOUR_CRITICAL: Record<string, readonly string[]> = {
  '600bn': ['the-cult'],
};

function sanctumMusicFocusActive(): boolean {
  try {
    return getFlavour() === '600bn' || getStoredMode() === 'sanctum' || isSanctumMode();
  } catch {
    return false;
  }
}

function extraCriticalTrackIds(): string[] {
  const ids = new Set<string>(FLAVOUR_CRITICAL[getFlavour()] ?? []);
  // Explicit SANCTUM mode on the main host needs the same gesture-bound warm
  // as the 600bn flavour. Reading stored mode covers the title screen before
  // startGame locks the active run mode.
  if (getStoredMode() === 'sanctum' || isSanctumMode()) ids.add('the-cult');
  return [...ids].filter((id) => !!TRACKS[id]);
}

export function preloadAllTracks(): void {
  for (const id of criticalTrackIds()) {
    const track = TRACKS[id];
    if (track) try { load(track); } catch { /* ignore */ }
  }
  for (const id of extraCriticalTrackIds()) {
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
    if (entry.volumeRaf !== null) {
      try { cancelAnimationFrame(entry.volumeRaf); } catch { /* ignore */ }
    }
    try { entry.src?.disconnect(); } catch { /* ignore */ }
    try { entry.gain?.disconnect(); } catch { /* ignore */ }
  }
  loaded.clear();
  warmedIds.clear();
  currentId = null;
  lastAppliedKey = '';
  readyZeroTrack = null;
  readyZeroSinceMs = 0;
  readyZeroLastForceMs = 0;
}

/**
 * Prime the CRITICAL music tracks under the active user gesture so each
 * underlying HTMLAudioElement gets its mandatory in-gesture .play() and
 * stays unlocked for the rest of the session. Without this, only the
 * track played by the initial musicSetTrackForState (pallasite-idle) is
 * activated — later phase changes load fresh elements outside any
 * gesture, iOS rejects their .play(), and the wave bands fall silent.
 *
 * The set is the active album's criticalTrackIds() + flavour additions, NOT
 * every track in TRACKS. The original implementation warmed all 25 tracks on
 * the first user gesture, which kicked 25 simultaneous decoder+fetch
 * starts and choked iOS PWA hard enough to break the click handler
 * that initiated the unlock (PLAY / IGNITE became unresponsive). Wave
 * tracks beyond the first few rely on the verify-pass retry +
 * crossfadeTo's lazy load to recover if a later activation fails.
 *
 * Each element is muted before play() to keep the priming inaudible,
 * then paused + unmuted via the play promise so it's left in a clean
 * ready-to-play state. `skipId` lets the caller exclude the track
 * that's about to be played normally — otherwise we'd race the
 * gesture-bound startNew against our own pause.
 */
/** Tracks every element we've kicked an in-gesture play() on, so the
 *  incremental warm in musicWarmUpAll advances through the album instead of
 *  re-warming the same few. On iOS the first in-gesture play() unlocks the
 *  element for the whole session (even though we immediately pause it), so an
 *  attempt is enough to mark it. */
const warmedIds = new Set<string>();
/** How many EXTRA (non-critical) wave beds to unlock per gesture. Small so we
 *  never recreate the 25-at-once decode storm that used to choke iOS and break
 *  the unlock click; spread across gestures the whole album warms in seconds.
 *  Mobile goes lower still: on device, warming 5 beds at once on the first
 *  gesture made ~12 elements buffer simultaneously and starved the actual
 *  current bed (title + wave 1) at readyState 0/1. Each game input is a gesture,
 *  so 2/gesture still unlocks the whole album within the first wave or two. */
const WARM_INCREMENT = mobileRuntimeActive() ? 2 : 5;

function warmOne(id: string, skipId: string | undefined): void {
  if (!id || id === skipId || !TRACKS[id]) return;
  warmedIds.add(id);
  try {
    const entry = load(TRACKS[id]);
    const track = TRACKS[id];
    entry.el.muted = true;
    const p = entry.el.play();
    const cleanup = (): void => {
      // If musicSetTrackForState picked this track between the muted play() and
      // the cleanup resolving, DO NOT pause it — that would kill the real play
      // we just kicked off, leaving the wave silent (the wave-1-silence bug).
      if (currentId === id) { try { entry.el.muted = false; } catch { /* ignore */ } return; }
      try { entry.el.pause(); } catch { /* ignore */ }
      // Restore to startAt (not 0) so the next real play picks up mid-track for
      // tracks that opt into it (slow-orbit).
      try { entry.el.currentTime = track.startAt ?? 0; } catch { /* ignore */ }
      try { entry.el.muted = false; } catch { /* ignore */ }
      // This bed is unlocked now but not current — release its buffer at once
      // (don't wait for the next refreshDirectVolumes frame) so the warm-up's
      // muted-play() load doesn't keep competing with the current bed for an
      // iOS decoder slot. It re-buffers via crossfadeTo when it becomes current.
      if (mobileRuntimeActive()) { try { entry.el.preload = 'none'; } catch { /* ignore */ } }
    };
    if (p && typeof p.then === 'function') p.then(cleanup, cleanup);
    else cleanup();
  } catch { /* ignore */ }
}

export function musicWarmUpAll(skipId?: string): void {
  // 600bn/Sanctum is a one-level mobile-heavy surface. The current track is
  // replayed below by musicSetTrackForState() under the same gesture; warming
  // campaign beds here only competes with the-cult.m4a and can leave it stuck
  // at readyState=0 on iOS.
  if (sanctumMusicFocusActive()) return;
  // Warm the critical set — title + wave 1 + completion + bonus. Rebuilds clear
  // warmedIds, so recovery still primes fresh elements without replaying the
  // same already-unlocked tracks on every later gesture.
  for (const id of new Set<string>([...criticalTrackIds(), ...extraCriticalTrackIds()])) {
    if (!warmedIds.has(id)) warmOne(id, skipId);
  }
  // Then unlock the REST of the active album's wave beds a few at a time, in
  // wave order, per gesture. THIS is the iOS "later waves fall silent" fix: only
  // wave 1 used to be warmed, so every other wave's crossfade play() fired
  // outside a gesture and iOS rejected it. Each game input is a gesture, so the
  // whole album unlocks within the first wave or two without the decode storm.
  const a = activeAlbum();
  let budget = WARM_INCREMENT;
  for (let w = 2; w <= FINAL_WAVE && budget > 0; w++) {
    const id = a.waves[w];
    if (id && !warmedIds.has(id) && id !== skipId) { warmOne(id, skipId); budget--; }
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
  /** Which album this track belongs to in the player. Undefined = the
   *  original pallasite album (kept implicit so the existing rows need no
   *  edit). 'relay' tags the Defend The Relay vault tracks. */
  album?: 'pallasite' | 'relay';
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

  // ── RELAY VAULT album (Defend The Relay) ─────────────────────────
  // Title + credits (system), bonus bed, then the wave setlist. A couple
  // of labels are re-themed off their working filenames to stay clear of
  // other games' marks (missile-command → SALVO, space-invaders-march →
  // PHALANX); the file ids are unchanged.
  { id: 'relaykeep-title',      label: 'RELAYKEEP',      hint: 'Title theme',          wave: null, category: 'sting', album: 'relay' },
  { id: 'phoenix-reborn',       label: 'PHOENIX REBORN', hint: 'End credits',          wave: null, category: 'sting', album: 'relay' },
  { id: 'hyperspace-chase',     label: 'HYPERSPACE CHASE', hint: 'Bonus level · W9 → W10', wave: null, category: 'bonus', album: 'relay' },
  { id: 'the-drift',            label: 'THE DRIFT',         hint: 'Krasnojarsk',         wave:  1, category: 'wave', album: 'relay' },
  { id: 'eternal-vigilance',    label: 'ETERNAL VIGILANCE', hint: 'Brenham',             wave:  2, category: 'wave', album: 'relay' },
  { id: 'space-invaders-march', label: 'PHALANX',           hint: 'Esquel · rhythmic',   wave:  3, category: 'wave', album: 'relay' },
  { id: 'alien-swarm-rising',   label: 'ALIEN SWARM',       hint: 'Fukang · elites',     wave:  4, category: 'wave', album: 'relay' },
  { id: 'defenders-resolve',    label: "DEFENDER'S RESOLVE", hint: 'Imilac · heist',     wave:  5, category: 'wave', album: 'relay' },
  { id: 'blasterz',             label: 'BLASTERZ',          hint: 'Mineo · iron',        wave:  6, category: 'wave', album: 'relay' },
  { id: 'planetary-defense',    label: 'PLANETARY DEFENCE', hint: 'Zaisho · tanks',      wave:  7, category: 'wave', album: 'relay' },
  { id: 'smart-bombz',          label: 'SMART BOMBZ',       hint: 'Marjalahti · mines',  wave:  8, category: 'wave', album: 'relay' },
  { id: 'the-survivor',         label: 'THE SURVIVOR',      hint: 'Omolon · breather',   wave:  9, category: 'wave', album: 'relay' },
  { id: 'rescue-run',           label: 'RESCUE RUN',        hint: 'Springwater · snipers', wave: 10, category: 'wave', album: 'relay' },
  { id: 'wave-after-wave',      label: 'WAVE AFTER WAVE',   hint: 'Glorieta · wells',    wave: 11, category: 'wave', album: 'relay' },
  { id: 'mutant-invasion',      label: 'MUTANT INVASION',   hint: 'Seymchan',            wave: 12, category: 'wave', album: 'relay' },
  { id: 'the-swarm',            label: 'THE SWARM',         hint: 'Albin · edges open',  wave: 13, category: 'wave', album: 'relay' },
  { id: 'cosmic-high-score',    label: 'COSMIC HIGH SCORE', hint: 'Itzawisis · seam',    wave: 16, category: 'wave', album: 'relay' },
  { id: 'laser-barrage',        label: 'LASER BARRAGE',     hint: 'Eagle Station',       wave: 17, category: 'wave', album: 'relay' },
  { id: 'missile-command',      label: 'SALVO',             hint: 'Newport · lanes',     wave: 18, category: 'wave', album: 'relay' },
  { id: 'the-fury',             label: 'THE FURY',          hint: 'Conception · chain',  wave: 20, category: 'wave', album: 'relay' },
  { id: 'the-tempest',          label: 'THE TEMPEST',       hint: 'Quijingue · anomalous', wave: 21, category: 'wave', album: 'relay' },
  { id: 'the-siege',            label: 'THE SIEGE',         hint: 'Admire · six wells',  wave: 23, category: 'wave', album: 'relay' },
  { id: 'the-descent',          label: 'THE DESCENT',       hint: 'Hambleton · last orbit', wave: 24, category: 'wave', album: 'relay' },
  { id: '600b-hole',            label: '600B HOLE',         hint: 'Event Horizon · boss', wave: 25, category: 'wave', album: 'relay' },
];

export function listTracks(): readonly TrackInfo[] { return TRACK_INFO; }

/** Currently-active track id, or null when silent. Used by the music
 *  player UI to highlight the active row. */
export function currentTrackId(): string | null { return currentId; }

/** Diagnostic — snapshot of the currently-playing track's element
 *  state. Used by the ?dbg=audio overlay for Safari debugging where
 *  music silently fails to play and we need to know why. */
export interface MusicDebugSnapshot {
  currentId: string | null;
  src: string | null;
  direct: boolean | null;
  volume: number | null;
  muted: boolean | null;
  paused: boolean | null;
  readyState: number | null;
  networkState: number | null;
  errorCode: number | null;
  errorMsg: string | null;
  failedFlag: boolean | null;
  loadedCount: number;
  playingIds: string[];
  audibleIds: string[];
}
export function getMusicDebugSnapshot(): MusicDebugSnapshot {
  const entry = currentId ? loaded.get(currentId) : null;
  const playingIds: string[] = [];
  const audibleIds: string[] = [];
  for (const [id, candidate] of loaded) {
    if (!candidate.el.paused) playingIds.push(id);
    if (!candidate.el.paused && !candidate.el.muted && entryOutputLevel(candidate) > 0.02) audibleIds.push(id);
  }
  return {
    currentId,
    src: entry ? entry.el.currentSrc || null : null,
    direct: entry ? entry.direct : null,
    volume: entry ? entry.el.volume : null,
    muted: entry ? entry.el.muted : null,
    paused: entry ? entry.el.paused : null,
    readyState: entry ? entry.el.readyState : null,
    networkState: entry ? entry.el.networkState : null,
    errorCode: entry ? entry.el.error?.code ?? null : null,
    errorMsg: entry ? entry.el.error?.message ?? null : null,
    failedFlag: entry ? entry.failed : null,
    loadedCount: loaded.size,
    playingIds,
    audibleIds,
  };
}

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
  let ctx: AudioContext | null = null;
  if (!directMusicOutputActive()) {
    const dest = getMusicDestination();
    ctx = dest.context as AudioContext;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined);
    }
  }
  const replayingCurrent = id === currentId;
  if (replayingCurrent) currentId = null;
  crossfadeTo(id, replayingCurrent ? 0 : 250);
  // Snap the picked track's gain to full (bypass the 0→trim ramp). The
  // crossfadeTo path is still doing the previous track's fade-out, so the
  // transition isn't an audible cut — but the new track is guaranteed
  // audible the moment its play() is called.
  const entry = loaded.get(id);
  const trim = TRACKS[id]?.trim ?? 1;
  if (entry?.gain && ctx) {
    entry.gain.gain.cancelScheduledValues(ctx.currentTime);
    entry.gain.gain.value = trim;
  } else if (entry?.direct) {
    setDirectVolume(entry, directTargetVolume(trim));
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

/**
 * Soft mute / unmute — toggles `el.muted` without pausing. Used by the
 * visibilitychange handler so transient hide events (mobile toolbar
 * collapse, brief notification pulls, fullscreen transition flickers)
 * don't break the playback's user-gesture chain. The element keeps
 * decoding so the resume path doesn't need a fresh gesture, which iOS
 * Safari otherwise rejects. The trade-off is a smidge of background
 * battery use during a transient hide — acceptable vs. music dying.
 *
 * pagehide / freeze (real backgrounding) keep using musicSetPaused
 * which DOES pause + mute, so the decode stops when the app is
 * actually backgrounded for the lock-screen Control Centre.
 */
export function musicSetMuted(muted: boolean): void {
  for (const entry of loaded.values()) {
    try { entry.el.muted = muted; } catch { /* ignore */ }
  }
}
