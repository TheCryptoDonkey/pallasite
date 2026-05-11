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
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { SignetSession, NostrEvent } from 'signet-login';
import { EXPERIMENTAL_RELAYS } from './credits.js';

/** NIP-53 Live Activities — used as our run-scoped session key
 *  authorisation AND as the public "I'm live, watch me here"
 *  announcement that zap.stream / Nostrudel / any NIP-53 client
 *  surfaces alongside human streamers. */
export const NIP53_LIVE_EVENT_KIND = 30311;
/** Ephemeral kind for per-frame pose telemetry. No NIP covers
 *  high-frequency game telemetry streams; the 20000-29999 range is
 *  Nostr's "ephemeral events" slot, which matches our needs (relays
 *  broadcast but don't persist — viewers catch frames as they fly,
 *  and the gamestr-spec kind 30763 ghost captures the canonical
 *  recording at end-of-run). */
export const STREAM_FRAME_KIND = 22769;
export const STREAM_FRAME_INTERVAL_MS = 500;
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
  /** Thrust on/off for trail rendering. */
  thrust: boolean;
  /** Optional ship-state flags for the viewer to render. */
  alive?: boolean;
  shielded?: boolean;
  /** World-state snapshot of non-ship entities at frame time. Each
   *  entity is a fixed-shape tuple to keep JSON small enough for
   *  2 Hz wire delivery without compression: see encode helpers
   *  below for the exact layouts. Particles + coins + powerups
   *  are omitted (decorative / numerous / cheap to re-spawn). */
  asteroids?: ReadonlyArray<readonly [number, number, 'l' | 'm' | 's', 's' | 'i' | 'c' | 'p', number]>;
  ufos?: ReadonlyArray<readonly [number, number, 's' | 'p' | 't' | 'e' | 'c' | 'b']>;
  mines?: ReadonlyArray<readonly [number, number]>;
  bullets?: ReadonlyArray<readonly [number, number, 0 | 1]>;
}

/** Compact JSON wire format for the entity snapshot. v1 keys are
 *  single letters to minimise bandwidth at 2 Hz × N players. */
interface WireWorld {
  v: 1;
  a?: Array<[number, number, string, string, number]>;
  u?: Array<[number, number, string]>;
  m?: Array<[number, number]>;
  b?: Array<[number, number, 0 | 1]>;
  shield?: 1;
  dead?: 1;
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

function getEventHash(unsigned: {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}): string {
  const serialised = JSON.stringify([
    0,
    unsigned.pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);
  return bytesToHex(sha256(utf8ToBytes(serialised)));
}

function finaliseLocalEvent(
  template: { kind: number; created_at: number; content: string; tags: string[][] },
  privkey: Uint8Array,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(privkey));
  const unsigned = { ...template, pubkey };
  const id = getEventHash(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privkey));
  return { ...unsigned, id, sig } as NostrEvent;
}

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
  const world: WireWorld = { v: 1 };
  if (frame.asteroids?.length) {
    world.a = frame.asteroids.map(
      (a) => [round1(a[0]), round1(a[1]), a[2], a[3], round2(a[4])],
    );
  }
  if (frame.ufos?.length) {
    world.u = frame.ufos.map((u) => [round1(u[0]), round1(u[1]), u[2]]);
  }
  if (frame.mines?.length) {
    world.m = frame.mines.map((m) => [round1(m[0]), round1(m[1])]);
  }
  if (frame.bullets?.length) {
    world.b = frame.bullets.map((b) => [round1(b[0]), round1(b[1]), b[2]]);
  }
  if (frame.shielded) world.shield = 1;
  if (frame.alive === false) world.dead = 1;

  const template = {
    kind: STREAM_FRAME_KIND,
    created_at: Math.floor(frame.t / 1000),
    content: JSON.stringify(world),
    tags: [
      // e-tag → NIP-53 kind 30311 live event so a viewer can verify
      // this session pubkey was master-authorised for this run.
      ['e', session.liveEventId],
      // a-tag → addressable reference to the same live event, which is
      // the NIP-01 way for non-replaceable events to point at
      // parameterized-replaceable ones.
      ['a', `${NIP53_LIVE_EVENT_KIND}:${session.masterPubkey}:${session.liveDTag}`],
      ['run_id', session.runId],
      ['p', session.masterPubkey],
      ['t', 'pallasite-stream-frame'],
      ['t', 'nostr-veil'],
      ['frame_t', String(frame.t)],
      ['x', frame.x.toFixed(2)],
      ['y', frame.y.toFixed(2)],
      ['r', frame.r.toFixed(3)],
      ['score', String(frame.score)],
      ['wave', String(frame.wave)],
      ['thrust', frame.thrust ? '1' : '0'],
    ],
  };

  let signed: NostrEvent;
  try {
    signed = finaliseLocalEvent(template, session.sessionPrivkey);
  } catch {
    return;
  }

  const relays = opts.relays ?? EXPERIMENTAL_RELAYS;
  await Promise.all(
    relays.map((url) => publishToRelay(url, signed).catch(() => undefined)),
  );
  session.lastFramePublishedAt = frame.t;
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
