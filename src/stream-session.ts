/**
 * Pallasite live-stream session — Twitch-style stream key for Nostr,
 * built on NIP-53 (Live Activities) for distribution.
 *
 * Live spectating without per-frame signer round-trips:
 *
 *   1. On run start, generate a fresh ephemeral secp256k1 keypair (the
 *      "session key" — analogous to a Twitch stream key).
 *   2. Master signs ONE **NIP-53 kind 30311 "Live Activities"** event
 *      authorising that session pubkey for the run. Single NIP-07 /
 *      NIP-46 prompt per run. The same event makes the player
 *      discoverable in zap.stream, Nostrudel, and any NIP-53 client.
 *   3. During play, the session key signs every frame event (kind
 *      22769, ephemeral) locally via @noble schnorr — instant, no
 *      signer round-trip, no popups. Frames carry ship pose + score
 *      + wave.
 *   4. On game over, the session privkey is zeroed. The NIP-53 event
 *      can be updated to status=ended (optional second master sign)
 *      or allowed to age out naturally — NIP-53 clients have their
 *      own staleness heuristics.
 *
 * Bandwidth-light by design: 2 Hz, ~80 bytes per frame, single relay.
 * Mobile-friendly: one master-signer prompt per run, then all
 * subsequent publishing is local-schnorr — no signer round-trips,
 * no popups, no battery cost beyond a network ping every 500ms.
 *
 * Why ephemeral kind 22769 for frames: kinds 20000-29999 are the
 * Nostr ephemeral range — relays broadcast but don't persist them,
 * which is exactly right for live wire data. The canonical replay is
 * captured by the kind 30763 ghost (gamestr-spec) at end-of-run.
 * Frames are the live wire; the ghost is the recording.
 *
 * Privacy: session key is per-run, discarded on game over. Master
 * never signs a frame. The NIP-53 announcement is publicly verifiable
 * — anyone can confirm "this session key was authorised by this
 * master for this run" — but the master's identity isn't repeated on
 * every frame.
 *
 * Session-key authorisation in NIP-53: we put the session pubkey in a
 * `p` tag with role 'streamkey'. NIP-53 supports `p` tags with role
 * markers for participants (host, speaker, participant, ...); we
 * extend that vocabulary with a Pallasite-specific role. NIP-53
 * clients tolerate unknown roles (just don't render them as named
 * participants); the watch viewer reads it to verify frame authors.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SignetSession, NostrEvent } from 'signet-login';
import { EXPERIMENTAL_RELAYS } from './credits.js';

// ── SFX event buffer (drained per frame) ─────────────────────────────────────
//
// game.ts calls recordStreamEvent at key audio moments (asteroid break,
// UFO destroyed, mine detonate, ship hit, shield burst). The frame
// publisher drains the buffer into each kind 22769 event so the live
// theatre on watch.pallasite.app can play matching sounds in lockstep
// with what the player heard. Short codes keep the wire compact:
//   ak = asteroid break
//   uk = ufo destroyed
//   md = mine detonate
//   sh = ship hit / destroyed
//   sb = shield burst
//   vc = vein collapse (jackpot)
//   pu = powerup picked up
//   fi = bullet fired (high frequency — opt-in)
export type StreamEventCode = 'ak' | 'uk' | 'md' | 'sh' | 'sb' | 'vc' | 'pu' | 'fi';
export type WireEvent = readonly [StreamEventCode, number, number];

let eventBuffer: Array<[StreamEventCode, number, number]> = [];
const MAX_BUFFERED_EVENTS = 24;

export function recordStreamEvent(code: StreamEventCode, x: number = -1, y: number = -1): void {
  if (eventBuffer.length >= MAX_BUFFERED_EVENTS) return;
  eventBuffer.push([code, Math.round(x), Math.round(y)]);
}

export function drainStreamEvents(): Array<[StreamEventCode, number, number]> {
  const out = eventBuffer;
  eventBuffer = [];
  return out;
}

/** NIP-53 Live Activities — used as our run-scoped session key
 *  authorisation AND as the public "I'm live, watch me here"
 *  announcement that zap.stream / Nostrudel / any NIP-53 client
 *  surfaces alongside human streamers. */
export const NIP53_LIVE_EVENT_KIND = 30311;
/** Legacy: kind 22769 was the per-frame Nostr ephemeral event kind.
 *  v3 moved high-rate frames off Nostr onto controller.pallasite.app
 *  WebSocket pass-through — no per-event signing, no relay-storage
 *  tax, ~3x lower latency. Kept exported for backwards compatibility
 *  with any tooling that still references the kind. */
export const STREAM_FRAME_KIND = 22769;
/** WebSocket endpoint for live frame stream — same host as the
 *  controller pair channel; the server distinguishes by role param.
 *  Publishers connect as r=publish, watchers as r=subscribe; sessionId
 *  is the player's master pubkey (one stream per player). */
export const STREAM_WS_ENDPOINT = 'wss://controller.pallasite.app/';
/** 3 Hz frames (333ms). Was 500ms (2Hz) then 250ms (4Hz), settled on
 *  333ms — 4Hz cost noticeably more on mobile main-thread (sha256 +
 *  schnorr.sign per frame), and bullet extrapolation on the viewer
 *  already smooths fast entities visually. 3Hz is the sweet spot for
 *  perceived smoothness vs publish cost. */
export const STREAM_FRAME_INTERVAL_MS = 333;
/** During paused phases publish at 1Hz instead of full rate — nothing
 *  changes between samples and the viewer's PAUSED overlay only needs
 *  a heartbeat to know the player hasn't quit. */
export const STREAM_FRAME_INTERVAL_PAUSED_MS = 1000;
const PUBLISH_TIMEOUT_MS = 4000;

export interface StreamFrame {
  /** Frame timestamp (unix ms) — when the client captured this pose. */
  t: number;
  /** Ship position (world units). */
  x: number;
  y: number;
  /** Ship rotation (radians). */
  r: number;
  /** Current score. */
  score: number;
  /** Current wave. */
  wave: number;
  /** Lives remaining — surfaced to the live theatre HUD so spectators
   *  see the same lives count the player does. Mirrors what's on the
   *  player's HUD; cheap (single int per frame). */
  lives?: number;
  /** Sats banked this run (state.sats). Lets the viewer show the same
   *  ₿ count the player can see on their HUD. */
  sats?: number;
  /** Thrust on/off for trail rendering. */
  thrust: boolean;
  /** Optional ship-state flags for the viewer to render. */
  alive?: boolean;
  shielded?: boolean;
  /** True while the player has paused mid-run — the viewer freezes
   *  motion and renders a PAUSED overlay so spectators know the run
   *  hasn't crashed. */
  paused?: boolean;
  /** World-state snapshot of non-ship entities at frame time. Each
   *  entity is a fixed-shape tuple keyed by `id` (the first field)
   *  so the viewer can match the same entity across frames and
   *  interpolate positions smoothly at 60fps despite the 2 Hz wire
   *  cadence. Particles + coins + powerups are omitted (decorative,
   *  numerous, cheap to re-spawn). */
  asteroids?: ReadonlyArray<readonly [number, number, number, 'l' | 'm' | 's', 's' | 'i' | 'c' | 'p', number]>;
  ufos?: ReadonlyArray<readonly [number, number, number, 's' | 'p' | 't' | 'e' | 'c' | 'b']>;
  mines?: ReadonlyArray<readonly [number, number, number]>;
  /** Bullets carry velocity (vx, vy) so the viewer can extrapolate
   *  between frames at 60fps. Without this the bullet snaps each 250ms
   *  to the new position; with velocity it glides smoothly. */
  bullets?: ReadonlyArray<readonly [number, number, number, number, number, 0 | 1]>;
  /** Sat coin = 's' (₿ glyph), dust shard = 'd' (asteroid-tinted facet).
   *  Source asteroid type carried alongside dust so the viewer can paint
   *  the right glow + shape. Capped at 32/frame — most runs sit well
   *  under this even mid-vein. */
  coins?: ReadonlyArray<readonly [number, number, number, 's' | 'd', 's' | 'i' | 'c' | 'p' | '']>;
  /** Powerups dropped from UFO/vein kills. Type letter maps directly to
   *  POWERUP_CONFIG (r=rapid, b=satboost, n=nova, t=trident, m=magnet). */
  powerups?: ReadonlyArray<readonly [number, number, number, 'r' | 'b' | 'n' | 't' | 'm']>;
  /** Audio events that fired since the prior frame — drained at publish
   *  time so the live theatre can replay them in sync with what the
   *  player heard. Capped at 24 per frame. */
  events?: ReadonlyArray<WireEvent>;
}

/** Compact JSON wire format. Tuple shapes (id first):
 *    asteroids:  [id, x, y, size, type, rot]
 *    ufos:       [id, x, y, type]
 *    mines:      [id, x, y]
 *    bullets:    [id, x, y, isEnemy]
 *  Single-letter keys + omit empty arrays to keep the wire small at
 *  2 Hz × N players. */
interface WireWorld {
  v: 2;
  a?: Array<[number, number, number, string, string, number]>;
  u?: Array<[number, number, number, string]>;
  m?: Array<[number, number, number]>;
  b?: Array<[number, number, number, number, number, 0 | 1]>;
  /** Coins — sat ₿ or dust shard. sourceType '' when not from an asteroid. */
  c?: Array<[number, number, number, string, string]>;
  /** Powerups — single-letter type from POWERUP_CONFIG. */
  pu?: Array<[number, number, number, string]>;
  e?: Array<[string, number, number]>;
  shield?: 1;
  dead?: 1;
  paused?: 1;
}

export interface ActiveStreamSession {
  /** Identifier of the run — matches state.runStartedAt as ms string. */
  runId: string;
  /** Session pubkey hex (32-byte x-only). */
  sessionPubkey: string;
  /** Session private key bytes (kept in-memory only). */
  sessionPrivkey: Uint8Array;
  /** Master pubkey from the SignetSession. */
  masterPubkey: string;
  /** NIP-53 kind 30311 "Live Activities" event id. Frames carry it in
   *  their e-tag so a viewer can locate the master-signed
   *  authorisation in one fetch. */
  liveEventId: string;
  /** The d-tag used on the kind 30311 event — `<master>:<runId>` —
   *  needed for replacing the event with status=ended on game over. */
  liveDTag: string;
  /** Wall-ms of the most recent frame publish. */
  lastFramePublishedAt: number;
}

// ── Wire encoding helpers ────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Event signing (local schnorr) ───────────────────────────────────────────

// ── Relay publish (raw WebSocket) ────────────────────────────────────────────

function publishToRelay(url: string, event: NostrEvent, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('relay-timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (ev) => {
      try {
        const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (msg[2] === true) resolve();
          else reject(new Error(typeof msg[3] === 'string' ? msg[3] : 'rejected'));
        }
      } catch { /* ignore parse errors */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay-error')); };
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start a stream session. Generates a fresh session keypair, asks the
 * master to sign a NIP-53 kind 30311 "Live Activities" event (which
 * simultaneously announces the player as live to NIP-53 clients AND
 * binds the session pubkey via a 'p' tag with role 'streamkey'),
 * publishes it. Returns an active session ready for frame publishing.
 *
 * One signer round-trip — this is the only time during the run that
 * we touch NIP-07 / NIP-46. All subsequent frame events are signed
 * with the session key (local schnorr).
 */
export async function startStreamSession(
  master: SignetSession,
  runId: string,
  opts: { relays?: readonly string[]; startedAtMs?: number } = {},
): Promise<ActiveStreamSession | null> {
  if (!master.signer.capabilities.canSignEvents) return null;

  // Wipe any frames from a prior session — fresh keypair, fresh buffer.
  clearReplayBuffer();

  const sessionPrivkey = new Uint8Array(32);
  crypto.getRandomValues(sessionPrivkey);
  let sessionPubkey: string;
  try {
    sessionPubkey = bytesToHex(schnorr.getPublicKey(sessionPrivkey));
  } catch {
    return null;
  }

  // NIP-53 d-tag is required + must uniquely identify the live event
  // across the author's history. Master+runId is a clean combination
  // that lets the same player run multiple concurrent activities
  // without clashing.
  const dTag = `pallasite:${master.pubkey}:${runId}`;
  const startsAtSec = Math.floor((opts.startedAtMs ?? Date.now()) / 1000);

  const template = {
    kind: NIP53_LIVE_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content:
      `Playing Pallasite live — anonymous-jury-reviewed cosmic-arcade with ` +
      `Lightning sat payouts and live Nostr telemetry. Spectators welcome.`,
    tags: [
      ['d', dTag],
      ['title', 'Playing Pallasite'],
      ['summary', 'Cosmic arcade — Lightning payouts, anonymous jury cheat review, live game state on Nostr.'],
      ['status', 'live'],
      ['starts', String(startsAtSec)],
      // Where viewers can actually watch — watch.pallasite.app filters
      // to the player's pubkey via the URL fragment.
      ['streaming', `https://watch.pallasite.app/#p=${master.pubkey}`],
      ['service', 'https://pallasite.app'],
      ['image', 'https://pallasite.app/logo.webp'],
      // Master is the host of their own stream.
      ['p', master.pubkey, '', 'Host'],
      // Session pubkey: custom 'streamkey' role on a NIP-53 p-tag.
      // NIP-53 clients ignore unknown roles; our watch viewer reads
      // this to verify frame authors.
      ['p', sessionPubkey, '', 'streamkey'],
      ['t', 'gaming'],
      ['t', 'pallasite'],
      ['t', 'pallasite-stream'],
      ['t', 'nostr-veil'],
    ],
  };

  let signed: NostrEvent;
  try {
    signed = await master.signer.signEvent(template);
  } catch (err) {
    console.warn('[stream] NIP-53 signEvent failed:', err);
    return null;
  }

  const relays = opts.relays ?? EXPERIMENTAL_RELAYS;
  let publishedAny = false;
  await Promise.all(
    relays.map((url) =>
      publishToRelay(url, signed).then(
        () => { publishedAny = true; },
        () => { /* ignore individual relay failure */ },
      ),
    ),
  );
  if (!publishedAny) {
    console.warn('[stream] no relays accepted the NIP-53 event');
    return null;
  }
  console.log(
    `[stream] live (NIP-53) — session ${sessionPubkey.slice(0, 8)}… for run ${runId}, ` +
      `master ${signed.pubkey.slice(0, 8)}…`,
  );

  return {
    runId,
    sessionPubkey,
    sessionPrivkey,
    masterPubkey: signed.pubkey,
    liveEventId: signed.id,
    liveDTag: dTag,
    lastFramePublishedAt: 0,
  };
}

/**
 * Publish a single frame. Signed locally with the session key — no
 * signer round-trip. Best-effort: a failed publish doesn't surface
 * to the caller (gameplay must not block on a flaky relay).
 */
/** In-memory frame buffer for the current run, used to compose the
 *  end-of-run kind 30764 "full replay" bundle. Reset when a new stream
 *  session starts; drained by getReplayBuffer() on claim. */
let replayBuffer: ReplayFrameRaw[] = [];

export interface ReplayFrameRaw {
  /** Frame timestamp (unix ms). */
  t: number;
  /** Ship pose. */
  x: number;
  y: number;
  r: number;
  /** Live HUD numbers. */
  score: number;
  wave: number;
  lives: number;
  sats: number;
  thrust: boolean;
  /** Ship-state flags (omitted when default). */
  alive?: boolean;
  shielded?: boolean;
  paused?: boolean;
  /** Wire world payload — same JSON shape we publish at 3 Hz today. */
  world: unknown;
}

/** Drain the buffer (returns the frames + clears in-memory state).
 *  Called once at end-of-run when the player claims; the result is
 *  compressed and shipped as the kind 30764 replay event. */
export function getReplayBuffer(): ReplayFrameRaw[] {
  const out = replayBuffer;
  replayBuffer = [];
  return out;
}

/** Clear the buffer without returning it — used when starting a fresh
 *  session so a previous run's frames don't bleed in. */
export function clearReplayBuffer(): void {
  replayBuffer = [];
}

export async function publishStreamFrame(
  session: ActiveStreamSession,
  frame: StreamFrame,
  opts: { relays?: readonly string[] } = {},
): Promise<void> {
  // x/y/r serialised with bounded precision: 1 unit world space ≈ 1
  // pixel at game-default zoom, 2 decimals on rotation is sub-degree
  // resolution. Entities ride in the event content as JSON so the
  // tag list stays small and the wire format is straightforward to
  // extend without breaking older viewers. Older viewers (live
  // theatre v2a and earlier) simply ignore content and still get
  // ship pose + score from the tags.
  const world: WireWorld = { v: 2 };
  if (frame.asteroids?.length) {
    world.a = frame.asteroids.map(
      (a) => [a[0], round1(a[1]), round1(a[2]), a[3], a[4], round2(a[5])],
    );
  }
  if (frame.ufos?.length) {
    world.u = frame.ufos.map((u) => [u[0], round1(u[1]), round1(u[2]), u[3]]);
  }
  if (frame.mines?.length) {
    world.m = frame.mines.map((m) => [m[0], round1(m[1]), round1(m[2])]);
  }
  if (frame.bullets?.length) {
    world.b = frame.bullets.map((b) => [b[0], round1(b[1]), round1(b[2]), Math.round(b[3]), Math.round(b[4]), b[5]]);
  }
  if (frame.coins?.length) {
    world.c = frame.coins.map((c) => [c[0], round1(c[1]), round1(c[2]), c[3], c[4]]);
  }
  if (frame.powerups?.length) {
    world.pu = frame.powerups.map((p) => [p[0], round1(p[1]), round1(p[2]), p[3]]);
  }
  if (frame.events?.length) {
    world.e = frame.events.map((e) => [e[0], e[1], e[2]]);
  }
  if (frame.shielded) world.shield = 1;
  if (frame.alive === false) world.dead = 1;
  if (frame.paused) world.paused = 1;

  // Buffer this frame for the end-of-run replay bundle. Cap the buffer
  // so a stuck/long-paused run can't blow memory — 4096 frames at 3 Hz
  // ≈ 22 minutes, well beyond any single Pallasite run. Older frames
  // are dropped from the front if we overflow.
  const MAX_BUFFER = 4096;
  replayBuffer.push({
    t: frame.t,
    x: frame.x, y: frame.y, r: frame.r,
    score: frame.score, wave: frame.wave,
    lives: frame.lives ?? 0, sats: frame.sats ?? 0,
    thrust: frame.thrust,
    alive: frame.alive,
    shielded: frame.shielded,
    paused: frame.paused,
    world,
  });
  if (replayBuffer.length > MAX_BUFFER) {
    replayBuffer.splice(0, replayBuffer.length - MAX_BUFFER);
  }

  // Publish to the WebSocket relay — no signing, no Nostr envelope,
  // just the wire frame as JSON. ~3x lower latency than the legacy
  // kind 22769 path and zero per-event CPU on the player. Watchers
  // subscribe to the same relay with their target pubkey.
  void publishStreamFrameWs(session.masterPubkey, {
    t: frame.t,
    x: round1(frame.x), y: round1(frame.y), r: round2(frame.r),
    score: frame.score, wave: frame.wave,
    lives: frame.lives ?? 0, sats: frame.sats ?? 0,
    thrust: frame.thrust,
    alive: frame.alive,
    shielded: frame.shielded,
    paused: frame.paused,
    world,
  });
  void opts; // relays no longer used — kept for caller compat
  session.lastFramePublishedAt = frame.t;
}

// ── Live WebSocket publisher ────────────────────────────────────────────────
//
// One persistent socket per process, keyed by sessionId (= master
// pubkey). Reconnects on drop. Frames are JSON.stringify'd and sent
// as-is; the relay forwards bytes verbatim to all subscribers.

interface LiveWsState { ws: WebSocket | null; sessionId: string; lastConnectAttempt: number; }
let liveWs: LiveWsState | null = null;

function publishStreamFrameWs(masterPubkey: string, frame: ReplayFrameRaw): void {
  if (!liveWs || liveWs.sessionId !== masterPubkey) {
    if (liveWs?.ws) try { liveWs.ws.close(); } catch { /* ignore */ }
    liveWs = { ws: null, sessionId: masterPubkey, lastConnectAttempt: 0 };
  }
  if (!liveWs.ws || liveWs.ws.readyState >= WebSocket.CLOSING) {
    // Reopen if closed; throttle reconnect attempts to avoid hot-loops
    // when the relay is unreachable.
    const now = Date.now();
    if (now - liveWs.lastConnectAttempt < 1000) return;
    liveWs.lastConnectAttempt = now;
    try {
      liveWs.ws = new WebSocket(`${STREAM_WS_ENDPOINT}?s=${encodeURIComponent(masterPubkey)}&r=publish`);
    } catch {
      liveWs.ws = null;
      return;
    }
    return; // skip this frame — socket isn't open yet
  }
  if (liveWs.ws.readyState !== WebSocket.OPEN) return; // CONNECTING — drop
  try {
    liveWs.ws.send(JSON.stringify(frame));
  } catch { /* ignore */ }
}

/** Close the live WS publisher — called from endStreamSession so a new
 *  game-over correctly tears down the publisher socket. */
export function closeLiveStreamWs(): void {
  if (liveWs?.ws) try { liveWs.ws.close(); } catch { /* ignore */ }
  liveWs = null;
}

/**
 * Wipe the session privkey from memory. Called on game over so a long
 * idle title-screen session doesn't carry a stale broadcast key.
 *
 * Optionally publishes a NIP-53 status=ended update via the master
 * signer (second prompt) so the live event is correctly terminated
 * for NIP-53 clients. If omitted, the activity ages out naturally —
 * most NIP-53 clients drop stale 'live' events after a few minutes
 * of no fresh frames.
 */
export function endStreamSession(session: ActiveStreamSession): void {
  session.sessionPrivkey.fill(0);
  // Close the live WS publisher so a follow-up session can rebind to
  // the same master pubkey cleanly (the server replaces stale
  // publishers but explicit close is tidier).
  closeLiveStreamWs();
}

/**
 * Publish a NIP-53 status=ended update for the live event. Replaces
 * the prior status=live event in-place (parameterized-replaceable on
 * the master's d-tag).
 */
export async function publishStreamEnded(
  master: SignetSession,
  session: ActiveStreamSession,
  opts: { relays?: readonly string[]; endedAtMs?: number } = {},
): Promise<void> {
  if (!master.signer.capabilities.canSignEvents) return;
  const endsAtSec = Math.floor((opts.endedAtMs ?? Date.now()) / 1000);
  const template = {
    kind: NIP53_LIVE_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Pallasite run ended. Recap on https://pallasite.app/.',
    tags: [
      ['d', session.liveDTag],
      ['title', 'Pallasite — run ended'],
      ['status', 'ended'],
      ['ends', String(endsAtSec)],
      ['service', 'https://pallasite.app'],
      ['p', session.masterPubkey, '', 'Host'],
      ['t', 'gaming'],
      ['t', 'pallasite'],
      ['t', 'pallasite-stream'],
      ['t', 'nostr-veil'],
    ],
  };
  let signed: NostrEvent;
  try {
    signed = await master.signer.signEvent(template);
  } catch (err) {
    console.warn('[stream] status=ended signEvent failed:', err);
    return;
  }
  const relays = opts.relays ?? EXPERIMENTAL_RELAYS;
  await Promise.all(
    relays.map((url) => publishToRelay(url, signed).catch(() => undefined)),
  );
}
