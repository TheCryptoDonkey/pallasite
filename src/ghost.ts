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
import type { GhostSample } from './types.js';
import { getActiveRelays } from './relays.js';

export const GHOST_KIND = 30763;
export const GHOST_FPS = 1;
const MAGIC_G = 0x47;
const MAGIC_H = 0x48;

export interface GhostRun {
  pubkey: string;
  score: number;
  wave: number;
  seed?: string;
  /** Decoded samples ordered by t (ms since run start). */
  samples: GhostSample[];
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
  view.setUint8(3, GHOST_FPS);
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
  samples: readonly GhostSample[];
  scoreEventId?: string;
  finalScore: number;
  finalWave: number;
  durationMs: number;
  seed?: string | null;
  cheated?: boolean;
  relays?: readonly string[];
}

/** Sign + broadcast a kind 30763 ghost event. Resolves with the signed event
 *  on success, null when the session can't sign or the run is too short. Does
 *  not throw — relay failures are swallowed since this is best-effort. */
export async function publishGhost(input: PublishGhostInput): Promise<NostrEvent | null> {
  const { session, samples, scoreEventId, finalScore, finalWave, durationMs, seed, cheated } = input;
  if (!session.signer.capabilities.canSignEvents) return null;
  if (samples.length < 2) return null;
  if (cheated) return null;

  const dTag = scoreEventId
    ? `${GAME_ID}:${scoreEventId}`
    : `${GAME_ID}:${session.pubkey.slice(0, 16)}:${Date.now()}`;

  const tags: string[][] = [
    ['d', dTag],
    ['t', 'pallasite'],
    ['game', GAME_ID],
    ['score', finalScore.toString()],
    ['wave', finalWave.toString()],
    ['duration', durationMs.toString()],
    ['enc', 'ghost-v1'],
    ['fps', GHOST_FPS.toString()],
  ];
  if (scoreEventId) tags.push(['e', scoreEventId]);
  if (seed) tags.push(['seed', seed]);

  const signed = await session.signer.signEvent({
    kind: GHOST_KIND,
    content: encodeGhostV1(samples),
    tags,
  });

  const relays = input.relays ?? getActiveRelays();
  await Promise.all(relays.map(url => publishToRelay(url, signed).catch(() => undefined)));
  return signed;
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
let topGhostCache: { at: number; key: string; ghost: GhostRun | null } | null = null;

/** Pull the highest-score kind 30763 event for this game. Optionally filtered
 *  by daily seed (so daily mode races a same-seed ghost). Cached for 60s per
 *  seed. Resolves null on relay failure rather than throwing. */
export async function fetchTopGhost(
  opts: { seed?: string | null; relays?: readonly string[]; force?: boolean } = {},
): Promise<GhostRun | null> {
  const cacheKey = opts.seed ?? '';
  if (!opts.force && topGhostCache && topGhostCache.key === cacheKey
      && Date.now() - topGhostCache.at < TOP_GHOST_CACHE_TTL_MS) {
    return topGhostCache.ghost;
  }
  const relays = opts.relays ?? getActiveRelays();
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
    if (tagValue(e.tags, 'enc') !== 'ghost-v1') continue;
    const score = parseInt(tagValue(e.tags, 'score') ?? '0', 10) || 0;
    if (score <= 0) continue;
    if (best && best.score >= score) continue;
    const samples = decodeGhostV1(e.content);
    if (!samples || samples.length < 2) continue;
    const declaredDuration = parseInt(tagValue(e.tags, 'duration') ?? '0', 10);
    const durationMs = declaredDuration > 0 ? declaredDuration : samples[samples.length - 1].t;
    best = {
      pubkey: e.pubkey,
      score,
      wave: parseInt(tagValue(e.tags, 'wave') ?? '0', 10) || 0,
      seed: tagValue(e.tags, 'seed'),
      samples,
      durationMs,
      eventId: e.id,
    };
  }

  topGhostCache = { at: Date.now(), key: cacheKey, ghost: best };
  return best;
}

/** Synchronous read of the cached top ghost — no network. Used by render.ts
 *  to draw the leader chip without bouncing through async on every frame. */
export function getCachedGhost(seed?: string | null): GhostRun | null {
  if (!topGhostCache) return null;
  const wantKey = seed ?? '';
  if (topGhostCache.key !== wantKey) return null;
  return topGhostCache.ghost;
}

/** Fire-and-forget prefetch for the title screen. Errors swallowed. */
export function prefetchTopGhost(seed?: string | null): void {
  void fetchTopGhost({ seed }).catch(() => undefined);
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
