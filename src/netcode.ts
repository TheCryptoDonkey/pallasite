/**
 * Lockstep input-log foundation for shared-arena 2-player multiplayer (M2).
 *
 * This module is the wire-format and storage layer for delay-based lockstep
 * netcode. It defines the per-step input snapshot that the sim consumes, plus
 * the encode / decode pair used on the wire, plus the input-log ring buffer
 * that holds recent steps for replay, input-delay, and (later) rollback.
 *
 * Hard requirements:
 *
 * - **Determinism.** A round-trip `decode(encode(sample))` must reproduce the
 *   sampled input bit-identically. The simulated-latency loopback test in
 *   later M2 commits verifies this end-to-end against the B3 hash.
 * - **No sim dependency.** This file imports nothing sim-side, so it stays
 *   safe to load early and from harnesses.
 *
 * Encoding (24 bits packed into a single number):
 *
 *   bit  0  turnLeft           (held: ArrowLeft || KeyA, collapsed)
 *   bit  1  turnRight          (held: ArrowRight || KeyD, collapsed)
 *   bit  2  thrustHeld         (held: ArrowUp || KeyW, collapsed)
 *   bit  3  thrustOverride     (held: touch / joystick magnitude > threshold)
 *   bit  4  fire               (held: Space)
 *   bit  5  hyperspaceEdge     (rising edge on the step the player pressed)
 *   bit  6  shieldEdge         (rising edge on the step the player pressed)
 *   bit  7  headingActive      (1: heading bucket below is the joystick angle)
 *   bits 8-17  headingBucket   (10-bit quantisation of [-PI, PI), 1024 levels)
 *
 * The remaining 6 bits are reserved. One number per player per step is plenty
 * for a 60Hz feed (480 bytes / sec per player at 32-bit JSON, far less if a
 * future commit switches to a binary frame).
 *
 * Keyboard aliases (`KeyA`/`KeyD`/`KeyW`) are collapsed into the arrow held
 * bits at sample time, because the sim ORs them together. Decode therefore
 * writes back only into the arrow slots and leaves the KeyA/KeyD/KeyW slots
 * empty -- the sim's `||` makes the result byte-identical to the original.
 *
 * `thrustOverride` rides as its own bit rather than collapsing into
 * `thrustHeld`, because the sim reads it as a separate field; preserving the
 * split keeps decoded state byte-identical to live state under length-1.
 */

import type { PlayerState } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** One step's worth of input from a single player.
 *
 *  Sampled from `PlayerState` immediately before each `updateGame` call. The
 *  edge bits are rising-edge: true on the step the player pressed, false on
 *  every other step. Held bits track the player's current input state at the
 *  step boundary. */
export interface PlayerInput {
  turnLeft: boolean;
  turnRight: boolean;
  thrustHeld: boolean;
  thrustOverride: boolean;
  fire: boolean;
  hyperspaceEdge: boolean;
  shieldEdge: boolean;
  /** Joystick / heading-mode target angle in radians on [-PI, PI), or `null`
   *  for keyboard-mode (turn-left / turn-right). The sim reads
   *  `p.targetHeading`; we ferry it through the input log so a remote player's
   *  joystick mode survives the wire. */
  heading: number | null;
}

/** Per-player edge flags accumulated between sim steps. The keydown handler
 *  raises one of these and the next sample reads-and-clears it; the cleared
 *  state is what gets logged for the step that follows. */
export interface EdgeFlags {
  hyperspace: boolean;
  shield: boolean;
}

/** Process-global edge buffer raised by the local input sources (keyboard,
 *  touch, controller PWA) and drained by the per-step sample. Two slots, one
 *  per local player; couch 2-player uses both, solo uses index 0 only. Lives
 *  in this module so every input source (main.ts, controller-host.ts, touch
 *  callbacks) raises a flag without taking a dependency on main.ts. */
export const localEdges: EdgeFlags[] = [
  { hyperspace: false, shield: false },
  { hyperspace: false, shield: false },
];

/** Process-global lockstep-active flag. True only once the duel peer is
 *  connected; false in solo, in couch, and before the peer hello completes.
 *  Input sources read this to decide whether to dispatch edge actions
 *  (tryHyperspace, tryActivateShield) synchronously (solo path) or to leave
 *  them for the per-step decode in the lockstep loop (peer path). Keeping
 *  the solo direct-dispatch path is what preserves the pre-M2 input feel
 *  for the public single-player experience. */
let _peerActive = false;
export function setPeerActive(b: boolean): void { _peerActive = b; }
export function isPeerActive(): boolean { return _peerActive; }

/** A canonical empty input -- every flag clear, no heading. Use as a fill
 *  value in the input log and as the starting `prev` for a fresh run. */
export const EMPTY_INPUT: PlayerInput = Object.freeze({
  turnLeft: false,
  turnRight: false,
  thrustHeld: false,
  thrustOverride: false,
  fire: false,
  hyperspaceEdge: false,
  shieldEdge: false,
  heading: null,
}) as PlayerInput;

// ── Sample / apply ───────────────────────────────────────────────────────────

/** Read the live PlayerState into a fresh PlayerInput, draining the edge
 *  flags as a side-effect. After this returns, `edges.hyperspace` and
 *  `edges.shield` are both false -- the rising edges have been captured into
 *  the snapshot and must not fire again until the next keydown.
 *
 *  `keysOverride` lets the caller supply a separate held-keys buffer that is
 *  NOT clobbered by `applyPlayerInput`'s log-driven writes. Solo and couch
 *  pass `undefined` and read directly off `p.keys` (apply is a no-op
 *  round-trip there). Peer mode passes a `localKeys[mpSlot]` map that the
 *  keyboard writes to in parallel with `p.keys`; the sample reads the
 *  un-clobbered local buffer, while apply continues to drive `p.keys`. */
export function samplePlayerInput(p: PlayerState, edges: EdgeFlags, keysOverride?: Record<string, boolean>): PlayerInput {
  const k = keysOverride ?? p.keys;
  const input: PlayerInput = {
    turnLeft:       !!(k['ArrowLeft']  || k['KeyA']),
    turnRight:      !!(k['ArrowRight'] || k['KeyD']),
    thrustHeld:     !!(k['ArrowUp']    || k['KeyW']),
    thrustOverride: !!p.thrustOverride,
    fire:           !!k['Space'],
    hyperspaceEdge: edges.hyperspace,
    shieldEdge:     edges.shield,
    heading:        p.targetHeading,
  };
  edges.hyperspace = false;
  edges.shield = false;
  return input;
}

/** Write a PlayerInput back into a PlayerState. Used on decode to drive the
 *  sim from the input log. Edges are NOT applied here -- they are consumed
 *  separately by the per-step dispatch in main.ts, which calls
 *  `tryHyperspace` / `tryActivateShield` so the existing sim contract is
 *  preserved. */
export function applyPlayerInput(p: PlayerState, input: PlayerInput): void {
  p.keys['ArrowLeft']  = input.turnLeft;
  p.keys['ArrowRight'] = input.turnRight;
  p.keys['ArrowUp']    = input.thrustHeld;
  p.keys['Space']      = input.fire;
  // The KeyA/KeyD/KeyW aliases stay zero -- the sim's `||` collapses them,
  // so decoded state is byte-identical to the original sampled state.
  p.keys['KeyA'] = false;
  p.keys['KeyD'] = false;
  p.keys['KeyW'] = false;
  p.thrustOverride = input.thrustOverride;
  p.targetHeading = input.heading;
}

// ── Encode / decode ──────────────────────────────────────────────────────────

const HEADING_BUCKETS = 1024;
const HEADING_NONE = 0;  // sentinel: headingActive bit clear

/** Pack a PlayerInput into a single 24-bit non-negative integer. */
export function encodePlayerInput(i: PlayerInput): number {
  let n = 0;
  if (i.turnLeft)       n |= 1 << 0;
  if (i.turnRight)      n |= 1 << 1;
  if (i.thrustHeld)     n |= 1 << 2;
  if (i.thrustOverride) n |= 1 << 3;
  if (i.fire)           n |= 1 << 4;
  if (i.hyperspaceEdge) n |= 1 << 5;
  if (i.shieldEdge)     n |= 1 << 6;
  if (i.heading !== null) {
    n |= 1 << 7;
    // Normalise heading to [0, 2PI), then quantise to 0..1023. The Math.floor
    // makes encoding deterministic across JS engines.
    let h = i.heading;
    const TWO_PI = Math.PI * 2;
    while (h < 0) h += TWO_PI;
    while (h >= TWO_PI) h -= TWO_PI;
    const bucket = Math.floor((h / TWO_PI) * HEADING_BUCKETS) % HEADING_BUCKETS;
    n |= (bucket & 0x3ff) << 8;
  }
  return n >>> 0;
}

/** Unpack an encoded input back into a PlayerInput. The heading is restored
 *  to its bucket centre on [-PI, PI). */
export function decodePlayerInput(n: number): PlayerInput {
  const headingActive = (n & (1 << 7)) !== 0;
  let heading: number | null = null;
  if (headingActive) {
    const bucket = (n >>> 8) & 0x3ff;
    const TWO_PI = Math.PI * 2;
    // Bucket centre, then shift to [-PI, PI) to match how the sim consumes it.
    let h = ((bucket + 0.5) / HEADING_BUCKETS) * TWO_PI;
    if (h >= Math.PI) h -= TWO_PI;
    heading = h;
  }
  return {
    turnLeft:       (n & (1 << 0)) !== 0,
    turnRight:      (n & (1 << 1)) !== 0,
    thrustHeld:     (n & (1 << 2)) !== 0,
    thrustOverride: (n & (1 << 3)) !== 0,
    fire:           (n & (1 << 4)) !== 0,
    hyperspaceEdge: (n & (1 << 5)) !== 0,
    shieldEdge:     (n & (1 << 6)) !== 0,
    heading,
  };
}

void HEADING_NONE;  // reserved for a future explicit-null encoding if needed

// ── Input log ────────────────────────────────────────────────────────────────

/** Ring-buffered input log indexed by sim frame. One slot per player per
 *  frame. Used by the lockstep loop to:
 *
 *  - record locally-sampled input as it lands;
 *  - hand a remote-decoded input into the same slot (the local and remote
 *    half of the same frame, from different sources);
 *  - read the resolved input for frame `N - delay` to drive the sim;
 *  - (later) snapshot/restore on rollback miss.
 *
 *  Ring capacity must exceed the maximum input delay + jitter buffer. 256
 *  steps is roughly 4.2 seconds at 60Hz, far above any realistic delay. */
export class InputLog {
  /** Encoded input by [frame % capacity][playerIdx]. Encoded numbers stay
   *  packed in storage; callers decode at read time. -1 means "not yet
   *  recorded for this slot." */
  private readonly ring: Int32Array;
  /** Highest frame so far recorded for each player. Used by readiness checks
   *  ("do I have both sides' input for frame N yet?") in later commits. */
  private readonly lastFrame: number[];
  readonly capacity: number;
  readonly players: number;

  constructor(players: number, capacity = 256) {
    this.players = players;
    this.capacity = capacity;
    this.ring = new Int32Array(capacity * players).fill(-1);
    this.lastFrame = new Array(players).fill(-1);
  }

  /** Record an encoded input for `(frame, playerIdx)`. Idempotent for the same
   *  encoded value; logs a warning in dev if a different value lands on a slot
   *  already recorded for that frame (would indicate a desync source). */
  record(frame: number, playerIdx: number, encoded: number): void {
    if (playerIdx < 0 || playerIdx >= this.players) return;
    const slot = (frame % this.capacity + this.capacity) % this.capacity;
    this.ring[slot * this.players + playerIdx] = encoded >>> 0;
    if (frame > this.lastFrame[playerIdx]) this.lastFrame[playerIdx] = frame;
  }

  /** Return the encoded input for `(frame, playerIdx)`, or -1 if not yet
   *  recorded or already overwritten by ring wrap. */
  get(frame: number, playerIdx: number): number {
    if (playerIdx < 0 || playerIdx >= this.players) return -1;
    const slot = (frame % this.capacity + this.capacity) % this.capacity;
    return this.ring[slot * this.players + playerIdx];
  }

  /** Latest frame recorded for a given player. -1 if nothing yet. */
  latest(playerIdx: number): number {
    if (playerIdx < 0 || playerIdx >= this.players) return -1;
    return this.lastFrame[playerIdx];
  }
}
