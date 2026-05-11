/**
 * Pallasite ghost replay (kind 30763).
 *
 * v1 = score-pacing: 1Hz sample of the player's score over the run, encoded
 * as a packed binary stream of uint32 score values. Used to render the
 * leader-chip during play ("LEADER 12,450 · YOU +200 @ 5:30").
 *
 * v2 (planned) extends frames with ship pose for the daily-mode overlay.
 * Magic + ver bytes let v1 consumers ignore v2 events cleanly.
 *
 * Wire format (v1):
 *   header  ['G','H', ver=1, fps=1, frameCount uint32 LE]   8 bytes
 *   body    frameCount × uint32 LE score                    N × 4 bytes
 *
 * Decoded sample timestamps are reconstructed as `i / fps` seconds.
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { GAME_ID } from './auth.js';
import { WORLD_W, WORLD_H, type GhostSample, type GhostPoseSample } from './types.js';
import { getActiveRelays } from './relays.js';
import { EXPERIMENTAL_RELAYS } from './credits.js';

/** Publish + fetch share the same relay set so a watcher always queries
 *  the same URLs the player published to. Without this union, the
 *  watcher's getActiveRelays() (its localStorage on watch.pallasite.app)
 *  can diverge from the player's getActiveRelays() (their localStorage
 *  on pallasite.app) and a published event won't be findable. We always
 *  include EXPERIMENTAL_RELAYS (our own relay.trotters.cc) so even with
 *  zero overlap in user-customised relays there's a guaranteed shared
 *  endpoint. */
function ghostRelaySet(override?: readonly string[]): readonly string[] {
  if (override && override.length > 0) return override;
  const active = getActiveRelays();
  const merged = new Set<string>([...active, ...EXPERIMENTAL_RELAYS]);
  return Array.from(merged);
}

export const GHOST_KIND = 30763;
/** kind 30764 — full-world compressed replay. The kind 30763 ghost
 *  carries pose-only samples; 30764 carries the entire wire-format
 *  frame buffer (asteroids, UFOs, mines, bullets, coins, powerups,
 *  SFX events) so the replay theatre can render the full world the
 *  player saw, not just their ship trajectory.
 *
 *  Content is base64(gzip(JSON [ReplayFrameRaw, ...])). Player buffers
 *  every 3 Hz frame in-memory during the run; on claim, the buffer is
 *  flushed into this event alongside the kind 30763 ghost. */
export const REPLAY_KIND = 30764;
export const GHOST_FPS_V1 = 1;
export const GHOST_FPS_V2 = 4;
const MAGIC_G = 0x47;
const MAGIC_H = 0x48;
/** Coordinate fixed-point scale: float world-pixels → uint16 [0, 65535]. */
const POS_SCALE_X = 65535 / WORLD_W;
const POS_SCALE_Y = 65535 / WORLD_H;
/** Rotation fixed-point: int16 = round(radians * 10000). Range ±3.27 rad
 *  comfortably covers full -π..π (3.14). */
const ROT_SCALE = 10000;

export interface GhostRun {
  pubkey: string;
  score: number;
  wave: number;
  seed?: string;
  encoding: 'ghost-v1' | 'ghost-v2';
  fps: number;
  /** Score-pacing samples — always present. v2 reconstructs from per-frame
   *  scores; v1 reads them directly. */
  samples: GhostSample[];
  /** Pose stream — present only on v2 events. Used by the daily-mode
   *  ship overlay; consumers without overlay rendering can ignore this. */
  poseSamples?: GhostPoseSample[];
  /** Total wall-time of the run, ms — taken from `duration` tag if present, else last sample.t. */
  durationMs: number;
  eventId: string;
}

export function encodeGhostV1(samples: readonly GhostSample[]): string {
  const header = 8;
  const body = samples.length * 4;
  const buf = new ArrayBuffer(header + body);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC_G);
  view.setUint8(1, MAGIC_H);
  view.setUint8(2, 1);
  view.setUint8(3, GHOST_FPS_V1);
  view.setUint32(4, samples.length, true);
  for (let i = 0; i < samples.length; i++) {
    view.setUint32(header + i * 4, Math.max(0, samples[i].score) >>> 0, true);
  }
  return bufferToBase64(buf);
}

export function decodeGhostV1(b64: string): GhostSample[] | null {
  let buf: ArrayBuffer;
  try { buf = base64ToBuffer(b64); } catch { return null; }
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== MAGIC_G || view.getUint8(1) !== MAGIC_H) return null;
  if (view.getUint8(2) !== 1) return null;
  const fps = view.getUint8(3);
  if (fps < 1 || fps > 30) return null;
  const count = view.getUint32(4, true);
  if (count > 100_000) return null;
  if (buf.byteLength < 8 + count * 4) return null;
  const intervalMs = Math.round(1000 / fps);
  const out: GhostSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ t: i * intervalMs, score: view.getUint32(8 + i * 4, true) });
  }
  return out;
}

/** v2 frame layout (11 bytes per frame):
 *    score   uint32 LE
 *    x_q     uint16 LE  (world.x * 65535 / WORLD_W)
 *    y_q     uint16 LE  (world.y * 65535 / WORLD_H)
 *    rot_q   int16  LE  (radians * 10000)
 *    flags   uint8     (bit 0 alive, bit 1 thrusting)
 */
export function encodeGhostV2(samples: readonly GhostPoseSample[]): string {
  const header = 8;
  const body = samples.length * 11;
  const buf = new ArrayBuffer(header + body);
  const view = new DataView(buf);
  view.setUint8(0, MAGIC_G);
  view.setUint8(1, MAGIC_H);
  view.setUint8(2, 2);
  view.setUint8(3, GHOST_FPS_V2);
  view.setUint32(4, samples.length, true);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const off = header + i * 11;
    view.setUint32(off, Math.max(0, s.score) >>> 0, true);
    const xq = Math.max(0, Math.min(65535, Math.round(s.x * POS_SCALE_X)));
    const yq = Math.max(0, Math.min(65535, Math.round(s.y * POS_SCALE_Y)));
    const rotq = Math.max(-32768, Math.min(32767, Math.round(s.rot * ROT_SCALE)));
    view.setUint16(off + 4, xq, true);
    view.setUint16(off + 6, yq, true);
    view.setInt16(off + 8, rotq, true);
    view.setUint8(off + 10, s.flags & 0xff);
  }
  return bufferToBase64(buf);
}

export function decodeGhostV2(b64: string): GhostPoseSample[] | null {
  let buf: ArrayBuffer;
  try { buf = base64ToBuffer(b64); } catch { return null; }
  if (buf.byteLength < 8) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== MAGIC_G || view.getUint8(1) !== MAGIC_H) return null;
  if (view.getUint8(2) !== 2) return null;
  const fps = view.getUint8(3);
  if (fps < 1 || fps > 30) return null;
  const count = view.getUint32(4, true);
  if (count > 100_000) return null;
  if (buf.byteLength < 8 + count * 11) return null;
  const intervalMs = Math.round(1000 / fps);
  const out: GhostPoseSample[] = [];
  for (let i = 0; i < count; i++) {
    const off = 8 + i * 11;
    const score = view.getUint32(off, true);
    const xq = view.getUint16(off + 4, true);
    const yq = view.getUint16(off + 6, true);
    const rotq = view.getInt16(off + 8, true);
    const flags = view.getUint8(off + 10);
    out.push({
      t: i * intervalMs,
      score,
      x: xq / POS_SCALE_X,
      y: yq / POS_SCALE_Y,
      rot: rotq / ROT_SCALE,
      flags,
    });
  }
  return out;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishGhostInput {
  session: SignetSession;
  /** v1 score-only samples (always present). Used when no pose samples
   *  are supplied — typically on free runs where the pose stream isn't
   *  captured. */
  samples: readonly GhostSample[];
  /** v2 pose samples — present only on daily-mode runs. When supplied,
   *  publishGhost emits a v2 event (pose-bearing) instead of v1. */
  poseSamples?: readonly GhostPoseSample[];
  scoreEventId?: string;
  finalScore: number;
  finalWave: number;
  durationMs: number;
  seed?: string | null;
  cheated?: boolean;
  relays?: readonly string[];
}

/** Sign + broadcast a kind 30763 ghost event. Picks v2 (pose-bearing) when
 *  poseSamples is non-empty, else v1 (score-only). Resolves with the signed
 *  event on success, null when the session can't sign or the run is too
 *  short. Does not throw — relay failures are swallowed since this is
 *  best-effort. */
export async function publishGhost(input: PublishGhostInput): Promise<NostrEvent | null> {
  const { session, samples, poseSamples, scoreEventId, finalScore, finalWave, durationMs, seed, cheated } = input;
  if (!session.signer.capabilities.canSignEvents) return null;
  if (cheated) return null;

  const useV2 = (poseSamples?.length ?? 0) >= 2;
  if (!useV2 && samples.length < 2) return null;

  const dTag = scoreEventId
    ? `${GAME_ID}:${scoreEventId}`
    : `${GAME_ID}:${session.pubkey.slice(0, 16)}:${Date.now()}`;

  const enc = useV2 ? 'ghost-v2' : 'ghost-v1';
  const fps = useV2 ? GHOST_FPS_V2 : GHOST_FPS_V1;
  const content = useV2
    ? encodeGhostV2(poseSamples!)
    : encodeGhostV1(samples);

  const tags: string[][] = [
    ['d', dTag],
    ['t', 'pallasite'],
    ['game', GAME_ID],
    ['score', finalScore.toString()],
    ['wave', finalWave.toString()],
    ['duration', durationMs.toString()],
    ['enc', enc],
    ['fps', fps.toString()],
  ];
  if (scoreEventId) tags.push(['e', scoreEventId]);
  if (seed) tags.push(['seed', seed]);

  const signed = await session.signer.signEvent({
    kind: GHOST_KIND,
    content,
    tags,
  });

  const relays = ghostRelaySet(input.relays);
  await Promise.all(relays.map(url => publishToRelay(url, signed).catch(() => undefined)));
  return signed;
}

// ── Full-world replay (kind 30764) ──────────────────────────────────────────

import type { ReplayFrameRaw } from './stream-session.js';

export interface PublishReplayInput {
  session: SignetSession;
  /** Optional kind 30762 score event id. When supplied, the kind 30764
   *  carries an `e` tag pointing at it so watchers can fetch the
   *  replay by score id (same pattern as kind 30763 ghosts). When not
   *  supplied (player hasn't claimed yet, or claim raced this call),
   *  the replay still publishes with a timestamp-based d-tag and is
   *  findable via author + since. */
  scoreEventId?: string;
  finalScore: number;
  finalWave: number;
  durationMs: number;
  frames: ReadonlyArray<ReplayFrameRaw>;
  relays?: readonly string[];
}

/** Compress + base64-encode the frame buffer and publish a kind 30764
 *  replay event. Called alongside publishGhost on claim — kind 30763
 *  carries pose-only samples, kind 30764 carries the full world. The
 *  watcher's "WATCH FROM START" prefers 30764 (rich) and falls back
 *  to 30763 (pose-only) if 30764 isn't present. */
export async function publishReplay(input: PublishReplayInput): Promise<NostrEvent | null> {
  const { session, scoreEventId, finalScore, finalWave, durationMs, frames } = input;
  if (!session.signer.capabilities.canSignEvents) {
    console.warn('[replay] skip publish — signer cannot sign events');
    return null;
  }
  if (frames.length < 2) {
    console.warn(`[replay] skip publish — only ${frames.length} frame(s) buffered (need >=2)`);
    return null;
  }

  console.log(`[replay] encoding ${frames.length} frames…`);
  const content = await encodeReplay(frames);
  if (!content) {
    console.error('[replay] encodeReplay returned null — CompressionStream unsupported?');
    return null;
  }
  console.log(`[replay] encoded ${content.length} bytes of base64 (kind ${REPLAY_KIND})`);

  const dTag = scoreEventId
    ? `${GAME_ID}:replay:${scoreEventId}`
    : `${GAME_ID}:replay:${session.pubkey.slice(0, 16)}:${Date.now()}`;
  const tags: string[][] = [
    ['d', dTag],
    ['t', 'pallasite'],
    ['game', GAME_ID],
    ['score', finalScore.toString()],
    ['wave', finalWave.toString()],
    ['duration', durationMs.toString()],
    ['frames', String(frames.length)],
    ['enc', 'replay-gzip-b64'],
  ];
  if (scoreEventId) tags.push(['e', scoreEventId]);

  const signed = await session.signer.signEvent({ kind: REPLAY_KIND, content, tags });
  const relays = ghostRelaySet(input.relays);
  const results = await Promise.allSettled(
    relays.map((url) => publishToRelay(url, signed)),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  // Log per-relay outcome so we can see which ones accept kind 30764
  // and which reject. Particularly useful when a watcher can't find a
  // replay we know was published.
  for (let i = 0; i < relays.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      console.log(`[replay]   ✓ ${relays[i]}`);
    } else {
      console.warn(`[replay]   ✗ ${relays[i]} — ${(r.reason as Error)?.message ?? 'error'}`);
    }
  }
  console.log(`[replay] published kind ${REPLAY_KIND} ${signed.id.slice(0, 8)}… to ${ok}/${relays.length} relays`);
  return signed;
}

/** Find the most recent kind 30764 replay from `pubkey`. Used by the
 *  live theatre's "WATCH FROM START" button when the spectator doesn't
 *  know the score event id yet (e.g. player has just claimed and the
 *  faucet's kind 30762 hasn't propagated to relays). */
export async function findReplayByAuthor(
  pubkey: string,
  sinceSec: number,
  opts: { relays?: readonly string[] } = {},
): Promise<FetchedReplay | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = ghostRelaySet(opts.relays);
  if (relays.length === 0) return null;
  console.log(`[replay] findReplayByAuthor pubkey=${pubkey.slice(0, 8)}… since=${sinceSec} relays=[${relays.join(', ')}]`);

  const filter: Record<string, unknown> = {
    kinds: [REPLAY_KIND],
    authors: [pubkey],
    since: Math.max(0, sinceSec - 30),
    limit: 5,
  };
  const perRelay = new Map<string, number>();
  const events = await new Promise<NostrEvent[]>((resolve) => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => { done += 1; if (done >= relays.length) settle(); };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); perRelay.set(url, 0); } catch { console.warn(`[replay]   ✗ ${url} — ws ctor threw`); markDone(); continue; }
      sockets.push(ws);
      const subId = 'rb' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (e && typeof e === 'object' && (e as { kind?: number }).kind === REPLAY_KIND) {
              collected.push(e as NostrEvent);
              perRelay.set(url, (perRelay.get(url) ?? 0) + 1);
            }
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = () => { console.warn(`[replay]   ✗ ${url} — ws error`); markDone(); };
      ws.onclose = markDone;
    }
  });
  for (const [url, count] of perRelay) {
    console.log(`[replay]   ${count > 0 ? '✓' : '·'} ${url} returned ${count} event(s)`);
  }
  events.sort((a, b) => b.created_at - a.created_at);
  console.log(`[replay] findReplayByAuthor got ${events.length} candidate event(s)`);
  for (const e of events) {
    if (!hasTagValue(e.tags, 'game', GAME_ID)) continue;
    if (tagValue(e.tags, 'enc') !== 'replay-gzip-b64') continue;
    const frames = await decodeReplay(e.content);
    if (!frames) {
      console.warn(`[replay] decode failed for event ${e.id.slice(0, 8)}…`);
      continue;
    }
    console.log(`[replay] decoded ${frames.length} frames from event ${e.id.slice(0, 8)}…`);
    return {
      eventId: e.id,
      pubkey: e.pubkey,
      score: parseInt(tagValue(e.tags, 'score') ?? '0', 10) || 0,
      wave: parseInt(tagValue(e.tags, 'wave') ?? '0', 10) || 0,
      durationMs: parseInt(tagValue(e.tags, 'duration') ?? '0', 10) || 0,
      frames,
    };
  }
  console.warn(`[replay] no usable kind ${REPLAY_KIND} found for author ${pubkey.slice(0, 8)}…`);
  return null;
}

export interface FetchedReplay {
  eventId: string;
  pubkey: string;
  score: number;
  wave: number;
  durationMs: number;
  frames: ReplayFrameRaw[];
}

/** Fetch + decode the kind 30764 replay for the supplied score event
 *  id. Returns null if the relay set doesn't have one yet (player has
 *  not claimed) or decompression fails. */
export async function fetchReplayByScoreEventId(
  scoreEventId: string,
  opts: { relays?: readonly string[] } = {},
): Promise<FetchedReplay | null> {
  if (!/^[0-9a-f]{64}$/i.test(scoreEventId)) return null;
  const relays = ghostRelaySet(opts.relays);
  if (relays.length === 0) return null;

  const filter: Record<string, unknown> = {
    kinds: [REPLAY_KIND],
    '#e': [scoreEventId],
    '#t': ['pallasite'],
    limit: 3,
  };

  const events = await new Promise<NostrEvent[]>((resolve) => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'rp' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (e && typeof e === 'object' && (e as { kind?: number }).kind === REPLAY_KIND) {
              collected.push(e as NostrEvent);
            }
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  for (const e of events) {
    if (!hasTagValue(e.tags, 'game', GAME_ID)) continue;
    if (tagValue(e.tags, 'enc') !== 'replay-gzip-b64') continue;
    const frames = await decodeReplay(e.content);
    if (!frames) continue;
    return {
      eventId: e.id,
      pubkey: e.pubkey,
      score: parseInt(tagValue(e.tags, 'score') ?? '0', 10) || 0,
      wave: parseInt(tagValue(e.tags, 'wave') ?? '0', 10) || 0,
      durationMs: parseInt(tagValue(e.tags, 'duration') ?? '0', 10) || 0,
      frames,
    };
  }
  return null;
}

async function encodeReplay(frames: ReadonlyArray<ReplayFrameRaw>): Promise<string | null> {
  try {
    const json = JSON.stringify(frames);
    const blob = new Blob([json]);
    const cs = new (window as unknown as { CompressionStream: new (fmt: string) => GenericTransformStream }).CompressionStream('gzip');
    const compressed = await new Response(blob.stream().pipeThrough(cs)).blob();
    const buf = await compressed.arrayBuffer();
    return arrayBufferToBase64(buf);
  } catch {
    return null;
  }
}

async function decodeReplay(b64: string): Promise<ReplayFrameRaw[] | null> {
  try {
    const bytes = base64ToBytes(b64);
    // Slice into a fresh ArrayBuffer to dodge SharedArrayBuffer typing
    // friction in strict TS configs (Uint8Array.buffer may report a
    // SharedArrayBuffer in some lib configurations).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    const blob = new Blob([ab]);
    const ds = new (window as unknown as { DecompressionStream: new (fmt: string) => GenericTransformStream }).DecompressionStream('gzip');
    const text = await new Response(blob.stream().pipeThrough(ds)).text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    return parsed as ReplayFrameRaw[];
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  // chunked because String.fromCharCode.apply blows the stack at large sizes
  const chunk = 0x4000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function publishToRelay(url: string, event: NostrEvent, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('relay-timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = ev => {
      try {
        const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (msg[2] === true) resolve();
          else reject(new Error(typeof msg[3] === 'string' ? msg[3] : 'rejected'));
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay-error')); };
  });
}

// ── Fetch ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 5000;
const TOP_GHOST_CACHE_TTL_MS = 60_000;
/** Cache keyed by seed (or '' for the seedless global top). Lets the title
 *  screen prefetch both the daily ghost and the global ghost without one
 *  overwriting the other; render.ts can then prefer the daily entry and
 *  fall back to the global one for the attract loop. */
const topGhostCache = new Map<string, { at: number; ghost: GhostRun | null }>();

/** Pull the highest-score kind 30763 event for this game. Optionally filtered
 *  by daily seed (so daily mode races a same-seed ghost). Cached for 60s per
 *  seed. Resolves null on relay failure rather than throwing. */
export async function fetchTopGhost(
  opts: { seed?: string | null; relays?: readonly string[]; force?: boolean } = {},
): Promise<GhostRun | null> {
  const cacheKey = opts.seed ?? '';
  if (!opts.force) {
    const hit = topGhostCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TOP_GHOST_CACHE_TTL_MS) return hit.ghost;
  }
  const relays = ghostRelaySet(opts.relays);
  if (relays.length === 0) return null;

  const filter: Record<string, unknown> = {
    kinds: [GHOST_KIND],
    '#t': ['pallasite'],
    limit: 100,
  };
  if (opts.seed) (filter as Record<string, string[]>)['#seed'] = [opts.seed];

  const events = await new Promise<NostrEvent[]>(resolve => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'gh' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = ev => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (isGhostEvent(e)) collected.push(e);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  let best: GhostRun | null = null;
  for (const e of events) {
    if (!hasTagValue(e.tags, 'game', GAME_ID)) continue;
    const enc = tagValue(e.tags, 'enc');
    if (enc !== 'ghost-v1' && enc !== 'ghost-v2') continue;
    const score = parseInt(tagValue(e.tags, 'score') ?? '0', 10) || 0;
    if (score <= 0) continue;
    if (best && best.score >= score) continue;

    let samples: GhostSample[];
    let poseSamples: GhostPoseSample[] | undefined;
    let fps: number;
    if (enc === 'ghost-v2') {
      const pose = decodeGhostV2(e.content);
      if (!pose || pose.length < 2) continue;
      poseSamples = pose;
      fps = GHOST_FPS_V2;
      // Derive 1Hz score samples from the pose stream by picking every Nth
      // frame so the leader chip can read scoreSamples without a separate
      // decode path. Fallback to per-frame if fps is below 1Hz somehow.
      const stride = Math.max(1, Math.floor(fps / GHOST_FPS_V1));
      samples = [];
      for (let i = 0; i < pose.length; i += stride) {
        samples.push({ t: pose[i].t, score: pose[i].score });
      }
    } else {
      const v1 = decodeGhostV1(e.content);
      if (!v1 || v1.length < 2) continue;
      samples = v1;
      fps = GHOST_FPS_V1;
    }

    const declaredDuration = parseInt(tagValue(e.tags, 'duration') ?? '0', 10);
    const durationMs = declaredDuration > 0
      ? declaredDuration
      : (poseSamples ?? samples)[(poseSamples ?? samples).length - 1].t;
    best = {
      pubkey: e.pubkey,
      score,
      wave: parseInt(tagValue(e.tags, 'wave') ?? '0', 10) || 0,
      seed: tagValue(e.tags, 'seed'),
      encoding: enc,
      fps,
      samples,
      poseSamples,
      durationMs,
      eventId: e.id,
    };
  }

  topGhostCache.set(cacheKey, { at: Date.now(), ghost: best });
  return best;
}

/** Synchronous read of the cached top ghost — no network. Used by render.ts
 *  to draw the leader chip without bouncing through async on every frame. */
export function getCachedGhost(seed?: string | null): GhostRun | null {
  const wantKey = seed ?? '';
  const hit = topGhostCache.get(wantKey);
  return hit?.ghost ?? null;
}

/** Fire-and-forget prefetch for the title screen. Errors swallowed. When a
 *  seed is supplied, also kicks off a global-top fetch so the attract-loop
 *  has a fallback to render even if no ghost has been published for today's
 *  seed yet. */
export function prefetchTopGhost(seed?: string | null): void {
  void fetchTopGhost({ seed }).catch(() => undefined);
  if (seed) void fetchTopGhost({ seed: null }).catch(() => undefined);
}

/**
 * Fetch the ghost (kind 30763) that references a specific kind 30762 score
 * event. Used by the replay theatre to play back a leaderboard entry: the
 * leaderboard row knows its own score event id, and ghost events tag the
 * score event via `e`, so the lookup is a direct relay query.
 *
 * Resolves null on relay timeout, decode failure, or absent ghost (not all
 * scores have a published replay). Does not throw -- the leaderboard caller
 * shows a "no replay available" state on null instead of erroring.
 */
export async function fetchGhostByScoreEventId(
  scoreEventId: string,
  opts: { relays?: readonly string[] } = {},
): Promise<GhostRun | null> {
  if (!/^[0-9a-f]{64}$/i.test(scoreEventId)) return null;
  const relays = ghostRelaySet(opts.relays);
  if (relays.length === 0) return null;

  const filter: Record<string, unknown> = {
    kinds: [GHOST_KIND],
    '#e': [scoreEventId],
    '#t': ['pallasite'],
    limit: 5,
  };

  const events = await new Promise<NostrEvent[]>(resolve => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'gx' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = ev => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (isGhostEvent(e)) collected.push(e);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  for (const e of events) {
    if (!hasTagValue(e.tags, 'game', GAME_ID)) continue;
    const enc = tagValue(e.tags, 'enc');
    if (enc !== 'ghost-v1' && enc !== 'ghost-v2') continue;
    const score = parseInt(tagValue(e.tags, 'score') ?? '0', 10) || 0;
    if (score <= 0) continue;

    let samples: GhostSample[];
    let poseSamples: GhostPoseSample[] | undefined;
    let fps: number;
    if (enc === 'ghost-v2') {
      const pose = decodeGhostV2(e.content);
      if (!pose || pose.length < 2) continue;
      poseSamples = pose;
      fps = GHOST_FPS_V2;
      const stride = Math.max(1, Math.floor(fps / GHOST_FPS_V1));
      samples = [];
      for (let i = 0; i < pose.length; i += stride) {
        samples.push({ t: pose[i].t, score: pose[i].score });
      }
    } else {
      const v1 = decodeGhostV1(e.content);
      if (!v1 || v1.length < 2) continue;
      samples = v1;
      fps = GHOST_FPS_V1;
    }

    const declaredDuration = parseInt(tagValue(e.tags, 'duration') ?? '0', 10);
    const durationMs = declaredDuration > 0
      ? declaredDuration
      : (poseSamples ?? samples)[(poseSamples ?? samples).length - 1].t;

    return {
      pubkey: e.pubkey,
      score,
      wave: parseInt(tagValue(e.tags, 'wave') ?? '0', 10) || 0,
      seed: tagValue(e.tags, 'seed'),
      encoding: enc,
      fps,
      samples,
      poseSamples,
      durationMs,
      eventId: e.id,
    };
  }
  return null;
}

/**
 * Find the most recent ghost from `pubkey` created after `sinceSec` and
 * return its score-event-id (the 'e' tag pointing at the kind 30762 final
 * score event). Useful when a spectator wants to replay a run they just
 * watched live — the live theatre knows the player pubkey and run start
 * time but not the score event id directly. Returns null if no ghost has
 * been published yet (player hasn't claimed) or no relays respond.
 */
export async function findScoreIdForLatestGhost(
  pubkey: string,
  sinceSec: number,
  opts: { relays?: readonly string[] } = {},
): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  const relays = ghostRelaySet(opts.relays);
  if (relays.length === 0) return null;

  const filter: Record<string, unknown> = {
    kinds: [GHOST_KIND],
    authors: [pubkey],
    since: Math.max(0, sinceSec - 30),
    limit: 5,
  };

  const events = await new Promise<NostrEvent[]>((resolve) => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach((s) => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'gl' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (isGhostEvent(e)) collected.push(e);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  // Most recent first — pick the newest that has a valid 'e' tag.
  events.sort((a, b) => b.created_at - a.created_at);
  for (const e of events) {
    if (!hasTagValue(e.tags, 'game', GAME_ID)) continue;
    const scoreEventId = tagValue(e.tags, 'e');
    if (scoreEventId && /^[0-9a-f]{64}$/i.test(scoreEventId)) return scoreEventId;
  }
  return null;
}

function isGhostEvent(value: unknown): value is NostrEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.kind === GHOST_KIND
    && typeof e.id === 'string'
    && typeof e.pubkey === 'string'
    && typeof e.content === 'string'
    && Array.isArray(e.tags);
}

function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') return t[1];
  return undefined;
}

function hasTagValue(tags: string[][], name: string, value: string): boolean {
  for (const t of tags) if (t[0] === name && t[1] === value) return true;
  return false;
}

/** Pose the ghost ship was at by `t` ms into the run. Linear-interp between
 *  pose samples; returns null if the ghost has no pose stream (v1 events). */
export function ghostPoseAt(
  run: GhostRun,
  t: number,
): { x: number; y: number; rot: number; alive: boolean; thrusting: boolean } | null {
  const s = run.poseSamples;
  if (!s || s.length === 0) return null;
  if (t <= s[0].t) {
    const a = s[0];
    return { x: a.x, y: a.y, rot: a.rot, alive: (a.flags & 1) !== 0, thrusting: (a.flags & 2) !== 0 };
  }
  const last = s[s.length - 1];
  if (t >= last.t) {
    return { x: last.x, y: last.y, rot: last.rot, alive: (last.flags & 1) !== 0, thrusting: (last.flags & 2) !== 0 };
  }
  let lo = 0;
  let hi = s.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const prev = s[lo];
  const next = s[hi];
  if (next.t === prev.t) {
    return { x: next.x, y: next.y, rot: next.rot, alive: (next.flags & 1) !== 0, thrusting: (next.flags & 2) !== 0 };
  }
  const frac = (t - prev.t) / (next.t - prev.t);
  // Hyperspace can teleport the ship across the field; if the gap looks like
  // a teleport (>200 px in 250ms = >800 px/s), snap rather than interp so the
  // ghost doesn't streak diagonally across the playfield.
  const dx = next.x - prev.x;
  const dy = next.y - prev.y;
  const teleport = dx * dx + dy * dy > 200 * 200;
  if (teleport) {
    return {
      x: frac < 0.5 ? prev.x : next.x,
      y: frac < 0.5 ? prev.y : next.y,
      rot: frac < 0.5 ? prev.rot : next.rot,
      alive: (next.flags & 1) !== 0,
      thrusting: (next.flags & 2) !== 0,
    };
  }
  // Interp rotation through the short way (handle ±π wrap).
  let dRot = next.rot - prev.rot;
  if (dRot > Math.PI) dRot -= Math.PI * 2;
  else if (dRot < -Math.PI) dRot += Math.PI * 2;
  return {
    x: prev.x + dx * frac,
    y: prev.y + dy * frac,
    rot: prev.rot + dRot * frac,
    alive: (next.flags & 1) !== 0,
    thrusting: (next.flags & 2) !== 0,
  };
}

/** Score the ghost was at by `t` ms into the run. Linear-interps between
 *  samples so the chip ticks smoothly rather than stepping once per second. */
export function ghostScoreAt(run: GhostRun, t: number): number {
  const s = run.samples;
  if (s.length === 0) return 0;
  if (t <= s[0].t) return s[0].score;
  const last = s[s.length - 1];
  if (t >= last.t) return last.score;
  // Binary search for the first sample with t > target.
  let lo = 0;
  let hi = s.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const prev = s[lo];
  const next = s[hi];
  if (next.t === prev.t) return next.score;
  const frac = (t - prev.t) / (next.t - prev.t);
  return Math.round(prev.score + (next.score - prev.score) * frac);
}
