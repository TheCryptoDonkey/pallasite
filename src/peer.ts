/**
 * Lockstep peer transport for shared-arena multiplayer (M3).
 *
 * Clients on one shared session exchange one input bitfield per sim step
 * via the controller-ws broker (in the `joystick` repo), kept in lockstep by
 * the deterministic sim foundation built in M1 / M2. This module is the
 * client side of the wire protocol; the broker change lives in the joystick
 * repo (see `docs/ideas/shared-arena-multiplayer.md` section 6.1).
 *
 * Two implementations:
 *
 * - `WebSocketPeer` — real transport against the broker. Control messages
 *   stay JSON; broker-capable frame/hash traffic uses a compact binary form.
 * - `LoopbackPeer` — pair two instances together with `loopbackPair()`; one's
 *   send lands in the other's drain inbox after a configurable simulated
 *   latency. Used by the M3 offline harness to drive both sides of a duel
 *   inside one browser without the broker.
 *
 * Both expose the same `Peer` interface; main.ts's lockstep loop is written
 * against the interface so swapping transports is a one-liner.
 */

// ── Wire format ──────────────────────────────────────────────────────────────

/** Slot index in a lockstep session. Set when the client joins a session. */
export type PeerSlot = number;

/** Messages this client sends to the broker. */
export type PeerMsgOut =
  | { type: 'hello-peer'; session: string; slot: PeerSlot; version: 1; players?: number; aiFill?: boolean; humanSlots?: number[]; binaryFrames?: boolean }
  | { type: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { type: 'frame-set'; frame: number; entries: Array<[PeerSlot, number]> }
  | { type: 'frames'; slot: PeerSlot; base: number; inputs: number[] }
  | { type: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { type: 'bye'; slot: PeerSlot };

/** Messages the broker forwards to this client. `frame` / `hash` are mirrors
 *  of the other slot's outbound traffic; `peer-joined` / `peer-left` are
 *  broker-originated lifecycle events; `session-error` is fatal. */
export type PeerMsgIn =
  | { type: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { type: 'frame-set'; frame: number; entries: Array<[PeerSlot, number]> }
  | { type: 'frames'; slot: PeerSlot; base: number; inputs: number[] }
  | { type: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { type: 'peer-joined'; slot: PeerSlot; binaryFrames?: boolean }
  | { type: 'peer-left'; slot: PeerSlot; reason: string }
  | { type: 'peerwatch-ready'; players?: number; aiFill?: boolean; humanSlots?: number[]; takeovers?: HumanSlotTakeover[]; inputDelay?: number; binaryFrames?: boolean }
  | { type: 'session-config'; players?: number; aiFill?: boolean; humanSlots?: number[]; takeovers?: HumanSlotTakeover[]; inputDelay?: number; binaryFrames?: boolean }
  | { type: 'session-error'; code: string };

export interface HumanSlotTakeover { slot: number; frame: number }
export interface HumanSlotConfig { humanSlots: number[]; takeovers: HumanSlotTakeover[] }

/** Per-frame inbox entry, drained by the lockstep loop into the InputLog. */
export interface FrameDelivery { frame: number; slot: PeerSlot; input: number; }

/** Per-frame hash inbox entry, drained for desync detection. */
export interface HashDelivery { frame: number; slot: PeerSlot; hash: number; }

/** Options for opening a peer connection. */
export interface PeerConnectOpts {
  /** Broker URL (ws:// or wss://). For LoopbackPeer this is ignored. */
  url: string;
  /** Shared session ID. Both peers must use the same string. */
  session: string;
  /** This client's slot. */
  localSlot: PeerSlot;
  /** Expected player count for the session. Defaults to the legacy duel size. */
  players?: number;
  /** Enable batched frame windows. Requires a broker that understands `frames`. */
  batchFrames?: boolean;
  /** In deathmatch, allow absent slots to be deterministic AI pilots. */
  aiFill?: boolean;
  /** Slot list chosen by the host as human-controlled for this run. */
  humanSlots?: number[];
  /** Slots this ONE socket drives locally — a couch booth linked to the other
   *  booth owns e.g. [0,1] on one machine. Defaults to [localSlot]; the broker
   *  registers the socket at every owned slot. */
  ownedSlots?: number[];
}

// ── Peer interface ───────────────────────────────────────────────────────────

/** Transport-agnostic peer. The lockstep loop sees a peer only through
 *  this interface, so swapping WebSocket for loopback in tests is one line. */
export interface Peer {
  /** Open the connection. Resolves once the broker has acknowledged the
   *  session join; rejects on session-error or transport failure. */
  connect(opts: PeerConnectOpts): Promise<void>;
  /** Close the connection cleanly, sending `bye` first. */
  disconnect(): void;
  /** Buffer-and-send the local input for the given frame. `slot` overrides the
   *  bound local slot — a booth owning several slots sends one per slot. */
  sendFrame(frame: number, encoded: number, slot?: number): void;
  /** Send several slot-tagged inputs for one sim frame as one wire payload. */
  sendFrameSet?(frame: number, entries: Array<{ slot: number; input: number }>): void;
  /** Send a periodic state hash for desync detection. */
  sendHash(frame: number, hash: number): void;
  /** Drain remote frame deliveries received since the last call. Returns
   *  newest-last; callers record these straight into the InputLog. */
  drainFrames(): FrameDelivery[];
  /** Drain remote hash deliveries received since the last call. */
  drainHashes(): HashDelivery[];
  /** True once the broker has acknowledged the session join and the partner
   *  slot is connected. */
  isConnected(): boolean;
  /** Highest remote frame number seen so far, -1 if none yet. Used by the
   *  stall detector to decide between "wait a beat" and "show stall UI". */
  lastReceivedFrame(): number;
  /** Optional reconnect hook. Fires once peer-joined arrives AFTER an
   *  unexpected drop (initial connect resolutions are NOT routed here).
   *  Set to null to clear. LoopbackPeer never reconnects, so this is a
   *  no-op on the loopback implementation. */
  setOnReconnected?(cb: (() => void) | null): void;
  /** Final human slots for an AI-filled deathmatch, once broker config lands. */
  getHumanSlots?(): number[];
  /** Human-slot config plus scheduled AI->human takeover frames. */
  getHumanSlotConfig?(): HumanSlotConfig;
  /** The broker-negotiated lockstep input delay in sim frames, or null if the
   *  broker has not assigned one yet (or this transport never negotiates, e.g.
   *  loopback). The whole session shares one value so determinism holds; the
   *  caller freezes it before the sim starts consuming real input. */
  getNegotiatedInputDelay?(): number | null;
}

// ── LoopbackPeer ─────────────────────────────────────────────────────────────

/** A peer that talks to its paired partner directly, in-process. Built with
 *  `loopbackPair()`. Used by the M3 offline harness and any single-process
 *  test that wants to drive both sides of a duel through the same lockstep
 *  loop as the real WebSocket transport would. */
export class LoopbackPeer implements Peer {
  /** Sim-frame delivery delay. Mirrors a one-way wire latency in frames; the
   *  default of 3 frames (~50ms at 60Hz) approximates a typical near-peer
   *  trip through a local relay. Both halves of a pair share this. */
  readonly oneWayDelayFrames: number;
  /** Paired partner. Set by `loopbackPair`. */
  private partner: LoopbackPeer | null = null;
  /** Queued inbound deliveries, indexed by the sim frame at which the
   *  message should become visible. Drained on each `drainFrames` call. */
  private frameInbox: FrameDelivery[] = [];
  private hashInbox: HashDelivery[] = [];
  /** Counter that advances on each `tick()` call; used to release queued
   *  deliveries whose `availableAt` has come due. */
  private localFrame = 0;
  /** Pending deliveries holding for `oneWayDelayFrames` more ticks. */
  private pendingFrames: Array<{ availableAt: number; delivery: FrameDelivery }> = [];
  private pendingHashes: Array<{ availableAt: number; delivery: HashDelivery }> = [];
  private connected = false;
  private highestRemoteFrame = -1;
  private localSlot: PeerSlot = 0;

  constructor(oneWayDelayFrames = 3) {
    this.oneWayDelayFrames = oneWayDelayFrames;
  }

  /** Manually advance the loopback clock by one sim frame, releasing any
   *  queued deliveries whose latency has elapsed. The lockstep loop calls
   *  this once per advancing sim step. Real WebSocket transports do not
   *  need a tick -- the wire's latency is wall-clock. */
  tick(): void {
    this.localFrame++;
    const stillFrames: typeof this.pendingFrames = [];
    for (const p of this.pendingFrames) {
      if (p.availableAt <= this.localFrame) {
        this.frameInbox.push(p.delivery);
        if (p.delivery.frame > this.highestRemoteFrame) this.highestRemoteFrame = p.delivery.frame;
      } else {
        stillFrames.push(p);
      }
    }
    this.pendingFrames = stillFrames;
    const stillHashes: typeof this.pendingHashes = [];
    for (const p of this.pendingHashes) {
      if (p.availableAt <= this.localFrame) this.hashInbox.push(p.delivery);
      else stillHashes.push(p);
    }
    this.pendingHashes = stillHashes;
  }

  /** Called by the partner's `sendFrame` to deliver a message. */
  receiveFromPartner(d: FrameDelivery): void {
    this.pendingFrames.push({ availableAt: this.localFrame + this.oneWayDelayFrames, delivery: d });
  }

  receiveHashFromPartner(d: HashDelivery): void {
    this.pendingHashes.push({ availableAt: this.localFrame + this.oneWayDelayFrames, delivery: d });
  }

  connect(opts: PeerConnectOpts): Promise<void> {
    this.localSlot = opts.localSlot;
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  sendFrame(frame: number, encoded: number, slot?: number): void {
    if (this.partner) this.partner.receiveFromPartner({ frame, slot: slot ?? this.localSlot, input: encoded });
  }

  sendHash(frame: number, hash: number): void {
    if (this.partner) this.partner.receiveHashFromPartner({ frame, slot: this.localSlot, hash });
  }

  drainFrames(): FrameDelivery[] {
    const out = this.frameInbox;
    this.frameInbox = [];
    return out;
  }

  drainHashes(): HashDelivery[] {
    const out = this.hashInbox;
    this.hashInbox = [];
    return out;
  }

  isConnected(): boolean { return this.connected; }
  lastReceivedFrame(): number { return this.highestRemoteFrame; }

  /** @internal — set by `loopbackPair`. */
  _setPartner(p: LoopbackPeer): void { this.partner = p; }
}

/** Build a paired pair of loopback peers. Each peer's `send` lands in the
 *  other's inbox after `oneWayDelayFrames` calls to `tick()`. The harness
 *  drives `tick()` for both peers each sim step so the latency simulation
 *  stays in sync with the sim clock. */
export function loopbackPair(oneWayDelayFrames = 3): [LoopbackPeer, LoopbackPeer] {
  const a = new LoopbackPeer(oneWayDelayFrames);
  const b = new LoopbackPeer(oneWayDelayFrames);
  a._setPartner(b);
  b._setPartner(a);
  return [a, b];
}

// ── WebSocketPeer ────────────────────────────────────────────────────────────

/** Real transport against the controller-ws broker (`joystick` repo). The
 *  broker's `peer` role mirrors messages between two slots on the same
 *  session. Connection lifecycle:
 *
 *  - construct, call `connect({ url, session, localSlot })`.
 *  - the promise resolves after `peer-joined` arrives for the OTHER slot
 *    (i.e., when the partner is connected too), or rejects on
 *    `session-error` / transport failure.
 *  - `sendFrame` / `sendHash` enqueue messages; the queue is flushed in
 *    insertion order. Backpressure is the broker's job (drop oldest on
 *    overflow).
 *
 *  Brief-drop tolerance: if the socket closes unexpectedly while we were
 *  happily connected, the worker auto-reconnects with a short backoff
 *  (see `RECONNECT_BACKOFF_MS` in peer-worker.ts). Each reconnect re-sends
 *  hello-peer; the broker's peer-joined fires when both peers are bound
 *  again. Callers can register `setOnReconnected` to replay recently-sent
 *  input frames so the input log fills the hole left by the drop. After
 *  the worker exhausts its reconnect budget it stays disconnected so the
 *  lockstep loop's existing 120-frame disconnect timer can end the run.
 */

/** Diagnostic ring entry for the wire trace. Each send/receive records one
 *  of these, capped at WIRE_TRACE_SIZE. Used by the E2E runner to debug
 *  the duel desync — set `window.__pallasiteWireTrace = 1` (or the URL
 *  query param `?wiretrace=1`) before constructing the peer. */
export interface WireTraceEntry {
  t: number;      // performance.now()
  dir: 'out' | 'in';
  kind: 'frame' | 'frames' | 'hash' | 'hello-peer' | 'peer-joined' | 'peer-left' | 'session-error' | 'bye' | 'unknown';
  frame?: number;
  slot?: number;
  input?: number;
  hash?: number;
  bufferedAmount?: number;
}
const WIRE_TRACE_SIZE = 4096;

/** Implementation note: as of the v193 rewrite, this class is a thin facade
 *  over a Web Worker that owns the actual WebSocket. Main-thread render work
 *  (postFX + WebGL on every rAF) was previously starving the recv handler,
 *  leaving `frame` messages queued for hundreds of ms while the lockstep
 *  loop's stall watchdog tore the connection down. The worker has its own
 *  event loop so the socket is read instantly regardless of main-thread
 *  jank; only the postMessage drain is subject to main-thread scheduling,
 *  and that's cheap (no JSON parse, no socket I/O) so it catches up quickly.
 *  See `peer-worker.ts` for the worker-side protocol. The public interface
 *  of this class is unchanged from the pre-worker version. */
export class WebSocketPeer implements Peer {
  private worker: Worker | null = null;
  private connected = false;
  private frameInbox: FrameDelivery[] = [];
  private hashInbox: HashDelivery[] = [];
  private highestRemoteFrame = -1;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;
  private onReconnected: (() => void) | null = null;
  /** Wire-trace mirror, fed by the worker on every send/recv when enabled.
   *  Ring of WIRE_TRACE_SIZE entries, oldest dropped. */
  private wireTrace: WireTraceEntry[] | null = null;
  private wireTraceHead = 0;
  /** Cumulative counters. Send counters are bumped locally on each send;
   *  recv counters are bumped when the worker posts a frame/hash. */
  public sentFrameCount = 0;
  public sentHashCount = 0;
  public recvFrameCount = 0;
  public recvHashCount = 0;
  public lastSendFrame = -1;
  public lastRecvFrame = -1;
  /** Latest socket snapshot the worker has pushed (~4Hz). -1 before any. */
  private latestBufferedAmount = -1;
  private latestReadyState = -1;
  /** Worker-side ground-truth counters from the periodic snapshot. The
   *  main-side recvFrameCount only ticks once main has processed each
   *  worker→main postMessage; comparing the two shows whether worker→main
   *  delivery is starving (vs. broker→worker which would show in the WS
   *  layer itself). */
  private wsRecvFrameCount = 0;
  private wsSentFrameCount = 0;
  private wsRecvFramePayloadCount = 0;
  private wsSentFramePayloadCount = 0;
  private binaryFramesActive = false;
  private humanSlots: number[] = [];
  private humanTakeovers: HumanSlotTakeover[] = [];
  private negotiatedInputDelay: number | null = null;

  connect(opts: PeerConnectOpts): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      let enableWireTrace = false;
      try {
        if (typeof window !== 'undefined' && (window as unknown as { __pallasiteWireTrace?: unknown }).__pallasiteWireTrace) {
          enableWireTrace = true;
          this.wireTrace = new Array(WIRE_TRACE_SIZE);
        }
      } catch { /* SSR or sandboxed — no window */ }
      try {
        // Inline-source Worker via Blob URL.
        //
        // Why: a separate peer-worker.ts bundled by Vite produced a worker
        // whose WebSocket dispatched its first 'message' event (peer-joined)
        // and then never fired again, even though server-side broker logs
        // confirmed it was sending many subsequent frames. A bare-worker
        // test using Blob URL with the same WebSocket logic got 100%
        // delivery. The asset-URL/Vite worker path was the culprit; this
        // Blob-URL inline path matches the working test shape exactly.
        //
        // The worker source is a plain string so this file stays
        // self-contained — no separate worker chunk, no module loader,
        // no Vite asset URL.
        const workerSource = buildPeerWorkerSource();
        const blob = new Blob([workerSource], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        this.worker = new Worker(workerUrl);
        // Note: NOT revoking the Blob URL. An earlier version revoked
        // after 1s and the worker stopped processing main-thread
        // postMessages partway through the session (worker tick log
        // showed sendAttempts=0 even though main had called sendFrame
        // 34+ times). One blob URL per duel is fine; it'll be GC'd
        // when the page unloads.
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.worker.addEventListener('message', this.onWorkerMessage);
      this.worker.postMessage({
        kind: 'connect',
        url: opts.url,
        session: opts.session,
        localSlot: opts.localSlot,
        players: opts.players ?? 2,
        batchFrames: opts.batchFrames === true,
        aiFill: opts.aiFill === true,
        humanSlots: Array.isArray(opts.humanSlots) ? opts.humanSlots : undefined,
        ownedSlots: Array.isArray(opts.ownedSlots) ? opts.ownedSlots : undefined,
        enableWireTrace,
      });
    });
  }

  /** Worker → main thread message handler. Arrow form so we can pass it as
   *  a stable reference to addEventListener / removeEventListener. */
  private onWorkerMessage = (ev: MessageEvent<unknown>): void => {
    const m = ev.data as
      | { kind: 'connected' }
      | { kind: 'reconnected' }
      | { kind: 'connect-failed'; error: string }
      | { kind: 'peer-left' }
      | { kind: 'session-error'; code: string }
      | { kind: 'session-config'; humanSlots: number[]; takeovers?: HumanSlotTakeover[]; inputDelay?: number | null }
      | { kind: 'frame'; frame: number; slot: PeerSlot; input: number }
      | { kind: 'frames'; slot: PeerSlot; base: number; inputs: number[] }
      | { kind: 'hash'; frame: number; slot: PeerSlot; hash: number }
      | { kind: 'wire-entry'; entry: WireTraceEntry }
      | { kind: 'counters'; bufferedAmount: number; readyState: number; wsRecvFrameCount: number; wsSentFrameCount: number; wsRecvFramePayloadCount: number; wsSentFramePayloadCount: number; binaryFramesActive?: boolean };
    switch (m.kind) {
      case 'connected':
        this.connected = true;
        if (this.resolveConnect) { this.resolveConnect(); this.resolveConnect = null; this.rejectConnect = null; }
        return;
      case 'reconnected':
        this.connected = true;
        if (this.onReconnected) try { this.onReconnected(); } catch { /* don't let a buggy hook poison the wire */ }
        return;
      case 'connect-failed':
        if (this.rejectConnect) { this.rejectConnect(new Error(m.error)); this.resolveConnect = null; this.rejectConnect = null; }
        return;
      case 'peer-left':
        this.connected = false;
        return;
      case 'session-error':
        if (this.rejectConnect) { this.rejectConnect(new Error('session-error: ' + m.code)); this.resolveConnect = null; this.rejectConnect = null; }
        this.disconnect();
        return;
      case 'session-config':
        this.humanSlots = Array.isArray(m.humanSlots) ? m.humanSlots.slice() : [];
        this.humanTakeovers = Array.isArray(m.takeovers) ? m.takeovers.slice() : [];
        if (typeof m.inputDelay === 'number' && Number.isFinite(m.inputDelay)) {
          this.negotiatedInputDelay = Math.max(0, Math.floor(m.inputDelay));
        }
        return;
      case 'frame':
        this.frameInbox.push({ frame: m.frame, slot: m.slot, input: m.input });
        if (m.frame > this.highestRemoteFrame) this.highestRemoteFrame = m.frame;
        this.recvFrameCount++;
        this.lastRecvFrame = m.frame;
        return;
      case 'frames':
        for (let i = 0; i < m.inputs.length; i++) {
          const frame = m.base + i;
          this.frameInbox.push({ frame, slot: m.slot, input: m.inputs[i] >>> 0 });
          if (frame > this.highestRemoteFrame) this.highestRemoteFrame = frame;
        }
        this.recvFrameCount += m.inputs.length;
        this.lastRecvFrame = Math.max(this.lastRecvFrame, m.base + m.inputs.length - 1);
        return;
      case 'hash':
        this.hashInbox.push({ frame: m.frame, slot: m.slot, hash: m.hash });
        this.recvHashCount++;
        return;
      case 'wire-entry':
        if (this.wireTrace) {
          this.wireTrace[this.wireTraceHead] = m.entry;
          this.wireTraceHead = (this.wireTraceHead + 1) % WIRE_TRACE_SIZE;
        }
        return;
      case 'counters':
        this.latestBufferedAmount = m.bufferedAmount;
        this.latestReadyState = m.readyState;
        this.wsRecvFrameCount = m.wsRecvFrameCount;
        this.wsSentFrameCount = m.wsSentFrameCount;
        this.wsRecvFramePayloadCount = m.wsRecvFramePayloadCount;
        this.wsSentFramePayloadCount = m.wsSentFramePayloadCount;
        this.binaryFramesActive = m.binaryFramesActive === true;
        return;
    }
  };

  /** Return the wire trace in chronological order. Empty if disabled. */
  getWireTrace(): WireTraceEntry[] {
    if (!this.wireTrace) return [];
    const out: WireTraceEntry[] = [];
    for (let i = 0; i < WIRE_TRACE_SIZE; i++) {
      const idx = (this.wireTraceHead + i) % WIRE_TRACE_SIZE;
      const e = this.wireTrace[idx];
      if (e) out.push(e);
    }
    return out;
  }

  /** Return lightweight cumulative counters (always available). */
  getWireCounters(): { sentFrameCount: number; sentHashCount: number; recvFrameCount: number; recvHashCount: number; lastSendFrame: number; lastRecvFrame: number; bufferedAmount: number; readyState: number; wsRecvFrameCount: number; wsSentFrameCount: number; wsRecvFramePayloadCount: number; wsSentFramePayloadCount: number; binaryFramesActive: boolean } {
    return {
      sentFrameCount: this.sentFrameCount,
      sentHashCount: this.sentHashCount,
      recvFrameCount: this.recvFrameCount,
      recvHashCount: this.recvHashCount,
      lastSendFrame: this.lastSendFrame,
      lastRecvFrame: this.lastRecvFrame,
      bufferedAmount: this.latestBufferedAmount,
      readyState: this.latestReadyState,
      wsRecvFrameCount: this.wsRecvFrameCount,
      wsSentFrameCount: this.wsSentFrameCount,
      wsRecvFramePayloadCount: this.wsRecvFramePayloadCount,
      wsSentFramePayloadCount: this.wsSentFramePayloadCount,
      binaryFramesActive: this.binaryFramesActive,
    };
  }

  /** Register a callback to fire after a successful reconnect. The
   *  callback receives no args; consult `isConnected()` for state. */
  setOnReconnected(cb: (() => void) | null): void {
    this.onReconnected = cb;
  }

  getHumanSlots(): number[] {
    return this.humanSlots.slice();
  }

  getHumanSlotConfig(): HumanSlotConfig {
    return {
      humanSlots: this.humanSlots.slice(),
      takeovers: this.humanTakeovers.map(t => ({ slot: t.slot, frame: t.frame })),
    };
  }

  getNegotiatedInputDelay(): number | null {
    return this.negotiatedInputDelay;
  }

  disconnect(): void {
    if (this.worker) {
      // Tell the worker to close the WS but do NOT terminate the worker
      // immediately. Calling worker.terminate() drops any pending TCP
      // recvs that haven't been dispatched yet, and earlier diagnostics
      // showed the broker continues forwarding right up until ws.close
      // round-trips — those forwards would be lost. Instead just close
      // the socket inside the worker; the worker keeps running until
      // the page unloads, which is fine (no leak on a one-page-per-
      // session app).
      try { this.worker.postMessage({ kind: 'disconnect' }); } catch { /* worker may already be gone */ }
      // Detach our listener so further worker postMessages don't
      // flip our `connected` flag back on.
      try { this.worker.removeEventListener('message', this.onWorkerMessage); } catch { /* ignore */ }
      this.worker = null;
    }
    this.connected = false;
  }

  sendFrame(frame: number, encoded: number, slot?: number): void {
    if (!this.worker) return;
    // A specific slot routes through the isolated, non-batched explicit-slot
    // path (booth owning several slots); the default keeps the batched path
    // that normal duels/deathmatch use, untouched.
    if (slot === undefined) {
      this.worker.postMessage({ kind: 'send-frame', frame, input: encoded });
    } else {
      this.worker.postMessage({ kind: 'send-frame-slot', frame, input: encoded, slot });
    }
    this.sentFrameCount++;
    this.lastSendFrame = frame;
  }

  sendFrameSet(frame: number, entries: Array<{ slot: number; input: number }>): void {
    if (!this.worker || entries.length <= 0) return;
    this.worker.postMessage({
      kind: 'send-frame-set',
      frame,
      entries: entries.map(e => [e.slot, e.input >>> 0]),
    });
    this.sentFrameCount += entries.length;
    this.lastSendFrame = frame;
  }

  sendHash(frame: number, hash: number): void {
    if (!this.worker) return;
    this.worker.postMessage({ kind: 'send-hash', frame, hash });
    this.sentHashCount++;
  }

  drainFrames(): FrameDelivery[] {
    const out = this.frameInbox;
    this.frameInbox = [];
    return out;
  }

  drainHashes(): HashDelivery[] {
    const out = this.hashInbox;
    this.hashInbox = [];
    return out;
  }

  isConnected(): boolean { return this.connected; }
  lastReceivedFrame(): number { return this.highestRemoteFrame; }
}

/** Inline worker source. Compiled to a JS string and loaded via Blob URL
 *  by WebSocketPeer.connect. Kept plain JS (no TS, no imports) so it can
 *  be evaluated as-is inside the worker context. Mirrors the protocol
 *  defined for PeerWorkerInbound/Outbound — kept in sync by hand because
 *  the worker can't import types at runtime.
 *
 *  Minimal shape on purpose: every feature beyond "open WS / forward
 *  frames / handle hello+peer-joined+disconnect" has been removed because
 *  earlier richer versions triggered apparent message loss against the
 *  production broker that wasn't reproducible from a bare-WS test. Add
 *  back deliberately, one feature at a time, with a smoke test. */
function buildPeerWorkerSource(): string {
  return `
    'use strict';
    var ws = null;
    var url = '';
    var session = '';
    var localSlot = 0;
    var ownedSlots = null;
    var expectedPlayers = 2;
    var aiFill = false;
    var startHumanSlots = null;
    var configuredHumanSlots = null;
    var configuredTakeovers = [];
    var connected = false;
    var initialConnectDone = false;
    var joinedSlots = {};
    var batchFrames = false;
    var binaryWire = false;
    var frameBatchMs = 12;
    var frameBatchMax = 2;
    var pendingFrames = {};
    var pendingFrameCount = 0;
    var frameFlushTimer = null;
    var wsRecvFrameCount = 0;
    var wsSentFrameCount = 0;
    var wsRecvFramePayloadCount = 0;
    var wsSentFramePayloadCount = 0;
    function post(m) { self.postMessage(m); }
    function frameBatchConfig(players) {
      if (players >= 16) return { ms: 50, max: 8 };
      if (players >= 8) return { ms: 33, max: 4 };
      if (players >= 3) return { ms: 20, max: 2 };
      return { ms: 12, max: 2 };
    }
    function buildSocketUrl() {
      var sep = url.indexOf('?') >= 0 ? '&' : '?';
      return url + sep + 's=' + encodeURIComponent(session) + '&r=peer';
    }
    function markJoined(slot) {
      if (typeof slot !== 'number' || slot < 0 || slot >= expectedPlayers) return;
      joinedSlots[slot] = true;
    }
    function normaliseSlots(raw) {
      if (!Array.isArray(raw)) return null;
      var seen = {};
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var slot = Math.floor(Number(raw[i]));
        if (!Number.isFinite(slot) || slot < 0 || slot >= expectedPlayers) continue;
        if (seen[slot]) continue;
        seen[slot] = true;
        out.push(slot);
      }
      out.sort(function (a, b) { return a - b; });
      return out;
    }
    function normaliseTakeovers(raw) {
      if (!Array.isArray(raw)) return [];
      var out = [];
      var seen = {};
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i] || {};
        var slot = Math.floor(Number(item.slot));
        var frame = Math.floor(Number(item.frame));
        if (!Number.isFinite(slot) || slot < 0 || slot >= expectedPlayers || !Number.isFinite(frame) || frame <= 0) continue;
        if (seen[slot]) continue;
        seen[slot] = true;
        out.push({ slot: slot, frame: frame });
      }
      out.sort(function (a, b) { return a.slot - b.slot; });
      return out;
    }
    function normaliseFrameSetEntries(raw) {
      if (!Array.isArray(raw)) return [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        var slot = Array.isArray(item) ? Math.floor(Number(item[0])) : Math.floor(Number(item && item.slot));
        var input = Array.isArray(item) ? Number(item[1]) : Number(item && item.input);
        if (!Number.isFinite(slot) || slot < 0 || slot >= expectedPlayers) continue;
        out.push([slot, (input || 0) >>> 0]);
      }
      return out;
    }
    function allExpectedJoined() {
      for (var i = 0; i < expectedPlayers; i++) {
        if (!joinedSlots[i]) return false;
      }
      return true;
    }
    function allHumanSlotsJoined() {
      if (!configuredHumanSlots || configuredHumanSlots.length <= 0) return false;
      if (configuredHumanSlots.indexOf(localSlot) < 0) return false;
      for (var i = 0; i < configuredHumanSlots.length; i++) {
        if (!joinedSlots[configuredHumanSlots[i]]) return false;
      }
      return true;
    }
    var PEER_BINARY_MAGIC = 0x50;
    var PEER_BINARY_VERSION = 1;
    var PEER_BINARY_FRAME = 1;
    var PEER_BINARY_FRAMES = 2;
    var PEER_BINARY_HASH = 3;
    function parseBinaryPeerMessage(data) {
      if (!(data instanceof ArrayBuffer) || data.byteLength < 9) return null;
      var bytes = new Uint8Array(data);
      if (bytes[0] !== PEER_BINARY_MAGIC || bytes[1] !== PEER_BINARY_VERSION) return null;
      var kind = bytes[2];
      var slot = bytes[3];
      var view = new DataView(data);
      var frameOrBase = view.getUint32(4, true);
      if (kind === PEER_BINARY_FRAME) {
        if (data.byteLength !== 12) return null;
        return { type: 'frame', frame: frameOrBase, slot: slot, input: view.getUint32(8, true) };
      }
      if (kind === PEER_BINARY_HASH) {
        if (data.byteLength !== 12) return null;
        return { type: 'hash', frame: frameOrBase, slot: slot, hash: view.getUint32(8, true) };
      }
      if (kind === PEER_BINARY_FRAMES) {
        var count = bytes[8];
        if (count <= 0 || data.byteLength !== 9 + count * 4) return null;
        var inputs = [];
        for (var i = 0; i < count; i++) inputs.push(view.getUint32(9 + i * 4, true));
        return { type: 'frames', slot: slot, base: frameOrBase, inputs: inputs };
      }
      return null;
    }
    function binaryPeerFrame(frame, input) {
      var buf = new ArrayBuffer(12);
      var bytes = new Uint8Array(buf);
      var view = new DataView(buf);
      bytes[0] = PEER_BINARY_MAGIC;
      bytes[1] = PEER_BINARY_VERSION;
      bytes[2] = PEER_BINARY_FRAME;
      bytes[3] = localSlot & 255;
      view.setUint32(4, frame >>> 0, true);
      view.setUint32(8, input >>> 0, true);
      return buf;
    }
    function binaryPeerFramesSlot(base, inputs, slot) {
      var count = Math.min(255, inputs.length);
      var buf = new ArrayBuffer(9 + count * 4);
      var bytes = new Uint8Array(buf);
      var view = new DataView(buf);
      bytes[0] = PEER_BINARY_MAGIC;
      bytes[1] = PEER_BINARY_VERSION;
      bytes[2] = PEER_BINARY_FRAMES;
      bytes[3] = slot & 255;
      view.setUint32(4, base >>> 0, true);
      bytes[8] = count;
      for (var i = 0; i < count; i++) view.setUint32(9 + i * 4, inputs[i] >>> 0, true);
      return buf;
    }
    function binaryPeerFrames(base, inputs) {
      return binaryPeerFramesSlot(base, inputs, localSlot);
    }
    function binaryPeerHash(frame, hash) {
      var buf = new ArrayBuffer(12);
      var bytes = new Uint8Array(buf);
      var view = new DataView(buf);
      bytes[0] = PEER_BINARY_MAGIC;
      bytes[1] = PEER_BINARY_VERSION;
      bytes[2] = PEER_BINARY_HASH;
      bytes[3] = localSlot & 255;
      view.setUint32(4, frame >>> 0, true);
      view.setUint32(8, hash >>> 0, true);
      return buf;
    }
    function maybeSignalConnected() {
      if (aiFill ? !allHumanSlotsJoined() : !allExpectedJoined()) return;
      if (!initialConnectDone) {
        initialConnectDone = true;
        post({ kind: 'connected' });
      }
    }
    function sendTextPayload(payload) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(payload);
        return true;
      } catch (e) {
        return false;
      }
    }
    function sendPayload(obj) {
      return sendTextPayload(JSON.stringify(obj));
    }
    function sendFrameGroupForSlot(slot, base, inputs) {
      if (inputs.length <= 0) return;
      if (binaryWire) {
        if (inputs.length === 1) {
          if (sendTextPayload(slot === localSlot ? binaryPeerFrame(base, inputs[0]) : binaryPeerFrameSlot(base, inputs[0], slot))) {
            wsSentFrameCount++;
            wsSentFramePayloadCount++;
          }
          return;
        }
        if (sendTextPayload(slot === localSlot ? binaryPeerFrames(base, inputs) : binaryPeerFramesSlot(base, inputs, slot))) {
          wsSentFrameCount += inputs.length;
          wsSentFramePayloadCount++;
        }
        return;
      }
      if (inputs.length === 1) {
        if (sendPayload({ type: 'frame', frame: base, slot: slot, input: inputs[0] })) {
          wsSentFrameCount++;
          wsSentFramePayloadCount++;
        }
        return;
      }
      if (sendPayload({ type: 'frames', slot: slot, base: base, inputs: inputs })) {
        wsSentFrameCount += inputs.length;
        wsSentFramePayloadCount++;
      }
    }
    function sendFrameGroup(base, inputs) {
      sendFrameGroupForSlot(localSlot, base, inputs);
    }
    function binaryPeerFrameSlot(frame, input, slot) {
      var buf = new ArrayBuffer(12);
      var bytes = new Uint8Array(buf);
      var view = new DataView(buf);
      bytes[0] = PEER_BINARY_MAGIC;
      bytes[1] = PEER_BINARY_VERSION;
      bytes[2] = PEER_BINARY_FRAME;
      bytes[3] = slot & 255;
      view.setUint32(4, frame >>> 0, true);
      view.setUint32(8, input >>> 0, true);
      return buf;
    }
    function sendFrameForSlot(frame, input, slot) {
      if (binaryWire) {
        if (sendTextPayload(binaryPeerFrameSlot(frame, input, slot))) { wsSentFrameCount++; wsSentFramePayloadCount++; }
        return;
      }
      if (sendPayload({ type: 'frame', frame: frame, slot: slot, input: input })) { wsSentFrameCount++; wsSentFramePayloadCount++; }
    }
    function sendFrameSet(frame, entries) {
      entries = normaliseFrameSetEntries(entries);
      if (entries.length <= 0) return;
      if (entries.length === 1) {
        sendFrameForSlot(frame, entries[0][1], entries[0][0]);
        return;
      }
      if (sendPayload({ type: 'frame-set', frame: frame, entries: entries })) {
        wsSentFrameCount += entries.length;
        wsSentFramePayloadCount++;
      }
    }
    function flushFrameBatch() {
      if (frameFlushTimer !== null) {
        clearTimeout(frameFlushTimer);
        frameFlushTimer = null;
      }
      if (pendingFrameCount > 0) {
        flushFrameValues(localSlot, pendingFrames);
        pendingFrames = {};
        pendingFrameCount = 0;
      }
    }
    function flushFrameValues(slot, values) {
      var frames = Object.keys(values).map(function (k) { return Number(k); }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
      if (frames.length <= 0) return;
      var base = -1;
      var inputs = [];
      var last = -1;
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        var input = values[String(f)] >>> 0;
        if (base < 0) {
          base = f;
          last = f;
          inputs = [input];
        } else if (f === last + 1 && inputs.length < frameBatchMax) {
          inputs.push(input);
          last = f;
        } else {
          sendFrameGroupForSlot(slot, base, inputs);
          base = f;
          last = f;
          inputs = [input];
        }
      }
      sendFrameGroupForSlot(slot, base, inputs);
    }
    function queueFrame(frame, input) {
      if (!batchFrames) {
        sendFrameGroup(frame, [input >>> 0]);
        return;
      }
      var key = String(frame);
      if (pendingFrames[key] === undefined) pendingFrameCount++;
      pendingFrames[key] = input >>> 0;
      if (pendingFrameCount >= frameBatchMax) {
        flushFrameBatch();
        return;
      }
      if (frameFlushTimer === null) {
        frameFlushTimer = setTimeout(flushFrameBatch, frameBatchMs);
      }
    }
    function openSocket() {
      try {
        ws = new WebSocket(buildSocketUrl());
        ws.binaryType = 'arraybuffer';
      } catch (e) {
        post({ kind: 'connect-failed', error: e && e.message ? e.message : String(e) });
        return;
      }
      ws.addEventListener('open', function () {
        joinedSlots = {};
        markJoined(localSlot);
        // We own our extra slots the moment we connect — the broker won't send
        // us peer-joined for our own slots, so mark them locally or the
        // all-joined gate never fires for a multi-slot booth.
        if (ownedSlots) { for (var oi = 0; oi < ownedSlots.length; oi++) markJoined(ownedSlots[oi]); }
        var hello = { type: 'hello-peer', session: session, slot: localSlot, version: 1, players: expectedPlayers, binaryFrames: true };
        if (ownedSlots && ownedSlots.length > 0) hello.ownedSlots = ownedSlots;
        if (aiFill) hello.aiFill = true;
        if (aiFill && localSlot === 0 && startHumanSlots && startHumanSlots.length > 0) hello.humanSlots = startHumanSlots;
        if (ws) ws.send(JSON.stringify(hello));
        connected = true;
      });
      ws.addEventListener('message', function (ev) {
        var msg;
        if (ev.data instanceof ArrayBuffer) {
          msg = parseBinaryPeerMessage(ev.data);
        } else {
          var raw = typeof ev.data === 'string' ? ev.data : '';
          try { msg = JSON.parse(raw); } catch (e) { return; }
        }
        if (!msg) return;
        if (msg.type === 'frame') {
          wsRecvFrameCount++;
          wsRecvFramePayloadCount++;
          post({ kind: 'frame', frame: msg.frame, slot: msg.slot, input: msg.input });
        } else if (msg.type === 'frames') {
          var inputs = Array.isArray(msg.inputs) ? msg.inputs : [];
          wsRecvFrameCount += inputs.length;
          wsRecvFramePayloadCount++;
          post({ kind: 'frames', slot: msg.slot, base: msg.base, inputs: inputs });
        } else if (msg.type === 'frame-set') {
          var entries = normaliseFrameSetEntries(msg.entries);
          wsRecvFrameCount += entries.length;
          wsRecvFramePayloadCount++;
          for (var ei = 0; ei < entries.length; ei++) {
            post({ kind: 'frame', frame: msg.frame, slot: entries[ei][0], input: entries[ei][1] });
          }
        } else if (msg.type === 'hash') {
          post({ kind: 'hash', frame: msg.frame, slot: msg.slot, hash: msg.hash });
        } else if (msg.type === 'session-config') {
          if (msg.binaryFrames === true) binaryWire = true;
          configuredHumanSlots = normaliseSlots(msg.humanSlots);
          configuredTakeovers = normaliseTakeovers(msg.takeovers);
          var negotiatedDelay = (typeof msg.inputDelay === 'number' && isFinite(msg.inputDelay)) ? Math.floor(msg.inputDelay) : null;
          post({ kind: 'session-config', humanSlots: configuredHumanSlots || [], takeovers: configuredTakeovers, inputDelay: negotiatedDelay });
          maybeSignalConnected();
        } else if (msg.type === 'peer-joined') {
          if (msg.binaryFrames === true) binaryWire = true;
          markJoined(msg.slot);
          maybeSignalConnected();
        } else if (msg.type === 'peer-left') {
          if (typeof msg.slot === 'number') delete joinedSlots[msg.slot];
          connected = false;
          post({ kind: 'peer-left' });
        } else if (msg.type === 'session-error') {
          post({ kind: 'session-error', code: msg.code });
        }
      });
      ws.addEventListener('close', function () {
        if (!initialConnectDone) {
          initialConnectDone = true;
          post({ kind: 'connect-failed', error: 'socket closed before partner joined' });
        }
      });
      ws.addEventListener('error', function () {
        if (!initialConnectDone) {
          initialConnectDone = true;
          post({ kind: 'connect-failed', error: 'socket error' });
        }
      });
    }
    setInterval(function () {
      post({ kind: 'counters', bufferedAmount: ws ? ws.bufferedAmount : -1, readyState: ws ? ws.readyState : -1, wsRecvFrameCount: wsRecvFrameCount, wsSentFrameCount: wsSentFrameCount, wsRecvFramePayloadCount: wsRecvFramePayloadCount, wsSentFramePayloadCount: wsSentFramePayloadCount, binaryFramesActive: binaryWire });
    }, 1000);
    self.addEventListener('message', function (ev) {
      var msg = ev.data;
      if (msg.kind === 'connect') {
        url = msg.url;
        session = msg.session;
        localSlot = msg.localSlot;
        expectedPlayers = Math.max(2, Math.min(64, Math.floor(Number(msg.players) || 2)));
        batchFrames = msg.batchFrames === true;
        aiFill = msg.aiFill === true;
        startHumanSlots = normaliseSlots(msg.humanSlots);
        ownedSlots = normaliseSlots(msg.ownedSlots);
        configuredHumanSlots = null;
        configuredTakeovers = [];
        binaryWire = false;
        var cfg = frameBatchConfig(expectedPlayers);
        frameBatchMs = cfg.ms;
        frameBatchMax = cfg.max;
        openSocket();
      } else if (msg.kind === 'disconnect') {
        flushFrameBatch();
        post({ kind: 'counters', bufferedAmount: ws ? ws.bufferedAmount : -1, readyState: ws ? ws.readyState : -1, wsRecvFrameCount: wsRecvFrameCount, wsSentFrameCount: wsSentFrameCount, wsRecvFramePayloadCount: wsRecvFramePayloadCount, wsSentFramePayloadCount: wsSentFramePayloadCount, binaryFramesActive: binaryWire });
        if (ws && connected) {
          try { ws.send(JSON.stringify({ type: 'bye', slot: localSlot })); } catch (e) {}
        }
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      } else if (msg.kind === 'send-frame') {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        queueFrame(msg.frame, msg.input);
      } else if (msg.kind === 'send-frame-slot') {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        sendFrameForSlot(msg.frame, msg.input, msg.slot);
      } else if (msg.kind === 'send-frame-set') {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        sendFrameSet(msg.frame, msg.entries);
      } else if (msg.kind === 'send-hash') {
        flushFrameBatch();
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(binaryWire
          ? binaryPeerHash(msg.frame, msg.hash)
          : JSON.stringify({ type: 'hash', frame: msg.frame, slot: localSlot, hash: msg.hash }));
      }
    });
  `;
}

// ── SpectatorPeer ────────────────────────────────────────────────────────────

/** Per-frame delivery from a spectator drain. Slot tells the lockstep loop
 *  which player's input log slot to write to; the spectator sees both. */
export interface SpectatorFrameDelivery { frame: number; slot: PeerSlot; input: number; }
export interface SpectatorHashDelivery { frame: number; slot: PeerSlot; hash: number; }

type SpectatorWorkerMessage =
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'error'; error?: string }
  | { kind: 'peerwatch-ready'; players?: number; aiFill?: boolean; humanSlots?: number[]; takeovers?: HumanSlotTakeover[]; inputDelay?: number }
  | { kind: 'session-config'; players?: number; aiFill?: boolean; humanSlots?: number[]; takeovers?: HumanSlotTakeover[]; inputDelay?: number }
  | { kind: 'peer-joined'; slot: PeerSlot }
  | { kind: 'peer-left'; slot: PeerSlot }
  | { kind: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { kind: 'frames'; slot: PeerSlot; base: number; inputs: number[] }
  | { kind: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { kind: 'session-error'; code: string };

/** Read-only peer that drains both slots' frames and hashes from a
 *  `r=peerwatch` broker connection. Used by the M5 spectator surface
 *  (watch.pallasite.app/?spectate=…&peer=…). Never sends; the broker
 *  silently drops anything it receives from a peerwatch socket anyway.
 *
 *  Lifecycle:
 *  - `connect(url, session)` opens the watcher socket. Resolves when the
 *    broker sends `peerwatch-ready` AND both slots are reported bound.
 *    A late-arriving peer-joined for the second slot kicks the resolve.
 *  - `drainFrames()` / `drainHashes()` return slot-tagged inboxes the
 *    lockstep loop writes into both players' input log positions. */
export class SpectatorPeer {
  private worker: Worker | null = null;
  private connected = false;
  private slotsBound: boolean[] = [false, false];
  private expectedPlayers = 2;
  private aiFill = false;
  private humanSlots: number[] | null = null;
  private humanTakeovers: HumanSlotTakeover[] = [];
  private negotiatedInputDelay: number | null = null;
  private frameInbox: SpectatorFrameDelivery[] = [];
  private hashInbox: SpectatorHashDelivery[] = [];
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;

  connect(opts: { url: string; session: string; players?: number; aiFill?: boolean }): Promise<void> {
    void opts.session;  // session is encoded into opts.url by the caller
    this.disconnect();
    this.expectedPlayers = Math.max(2, Math.min(64, Math.floor(opts.players ?? 2)));
    this.slotsBound = new Array(this.expectedPlayers).fill(false);
    this.aiFill = opts.aiFill === true;
    this.humanSlots = null;
    this.humanTakeovers = [];
    this.negotiatedInputDelay = null;
    this.frameInbox = [];
    this.hashInbox = [];
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      try {
        const workerSource = buildSpectatorWorkerSource();
        const blob = new Blob([workerSource], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        this.worker = new Worker(workerUrl);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.worker.addEventListener('message', this.onWorkerMessage);
      this.worker.postMessage({ kind: 'connect', url: opts.url });
    });
  }

  disconnect(): void {
    if (this.worker) {
      const worker = this.worker;
      try { worker.postMessage({ kind: 'disconnect' }); } catch { /* worker may already be gone */ }
      try { worker.removeEventListener('message', this.onWorkerMessage); } catch { /* ignore */ }
      setTimeout(() => { try { worker.terminate(); } catch { /* ignore */ } }, 250);
    }
    this.worker = null;
    this.connected = false;
    this.slotsBound = new Array(this.expectedPlayers).fill(false);
  }

  drainFrames(): SpectatorFrameDelivery[] {
    const out = this.frameInbox;
    this.frameInbox = [];
    return out;
  }

  drainHashes(): SpectatorHashDelivery[] {
    const out = this.hashInbox;
    this.hashInbox = [];
    return out;
  }

  isConnected(): boolean { return this.connected; }
  bothPeersBound(): boolean { return this.requiredSlotsBound(); }

  getHumanSlots(): number[] {
    return this.humanSlots ? this.humanSlots.slice() : [];
  }

  getHumanSlotConfig(): HumanSlotConfig {
    return {
      humanSlots: this.getHumanSlots(),
      takeovers: this.humanTakeovers.map(t => ({ slot: t.slot, frame: t.frame })),
    };
  }

  getNegotiatedInputDelay(): number | null {
    return this.negotiatedInputDelay;
  }

  private setNegotiatedInputDelay(raw: number | undefined): void {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      this.negotiatedInputDelay = Math.max(0, Math.floor(raw));
    }
  }

  private setHumanConfig(rawSlots: number[] | undefined, rawTakeovers: HumanSlotTakeover[] | undefined): void {
    if (!Array.isArray(rawSlots)) return;
    const seen = new Set<number>();
    const out: number[] = [];
    for (const value of rawSlots) {
      const slot = Math.floor(Number(value));
      if (!Number.isFinite(slot) || slot < 0 || slot >= this.expectedPlayers || seen.has(slot)) continue;
      seen.add(slot);
      out.push(slot);
    }
    out.sort((a, b) => a - b);
    this.humanSlots = out;
    const takeovers: HumanSlotTakeover[] = [];
    if (Array.isArray(rawTakeovers)) {
      const takeoverSeen = new Set<number>();
      for (const raw of rawTakeovers) {
        const slot = Math.floor(Number(raw?.slot));
        const frame = Math.floor(Number(raw?.frame));
        if (!Number.isFinite(slot) || slot < 0 || slot >= this.expectedPlayers || !Number.isFinite(frame) || frame <= 0 || takeoverSeen.has(slot)) continue;
        takeoverSeen.add(slot);
        takeovers.push({ slot, frame });
      }
    }
    takeovers.sort((a, b) => a.slot - b.slot);
    this.humanTakeovers = takeovers;
  }

  private requiredSlotsBound(): boolean {
    if (!this.aiFill) return this.slotsBound.slice(0, this.expectedPlayers).every(Boolean);
    if (!this.humanSlots || this.humanSlots.length === 0) return false;
    return this.humanSlots.every(slot => this.slotsBound[slot] === true);
  }

  private resolveIfReady(): void {
    if (this.requiredSlotsBound() && this.resolveConnect) {
      this.resolveConnect();
      this.resolveConnect = null;
      this.rejectConnect = null;
    }
  }

  private onWorkerMessage = (ev: MessageEvent<unknown>): void => {
    const msg = ev.data as SpectatorWorkerMessage;
    if (!msg || typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'open':
        this.connected = true;
        return;
      case 'closed':
        this.connected = false;
        this.slotsBound = new Array(this.expectedPlayers).fill(false);
        if (this.rejectConnect) { this.rejectConnect(new Error('socket closed before all peers joined')); this.resolveConnect = null; this.rejectConnect = null; }
        return;
      case 'error':
        if (this.rejectConnect) { this.rejectConnect(new Error(msg.error || 'socket error')); this.resolveConnect = null; this.rejectConnect = null; }
        return;
      case 'peerwatch-ready':
        if (msg.players !== undefined) {
          this.expectedPlayers = Math.max(2, Math.min(64, Math.floor(msg.players)));
          const next = new Array(this.expectedPlayers).fill(false);
          for (let i = 0; i < Math.min(next.length, this.slotsBound.length); i++) next[i] = this.slotsBound[i];
          this.slotsBound = next;
        }
        if (msg.aiFill) this.aiFill = true;
        this.setHumanConfig(msg.humanSlots, msg.takeovers);
        this.setNegotiatedInputDelay(msg.inputDelay);
        this.resolveIfReady();
        return;
      case 'session-config':
        if (msg.players !== undefined) {
          this.expectedPlayers = Math.max(2, Math.min(64, Math.floor(msg.players)));
          const next = new Array(this.expectedPlayers).fill(false);
          for (let i = 0; i < Math.min(next.length, this.slotsBound.length); i++) next[i] = this.slotsBound[i];
          this.slotsBound = next;
        }
        if (msg.aiFill) this.aiFill = true;
        this.setHumanConfig(msg.humanSlots, msg.takeovers);
        this.setNegotiatedInputDelay(msg.inputDelay);
        this.resolveIfReady();
        return;
      case 'peer-joined':
        this.slotsBound[msg.slot] = true;
        this.resolveIfReady();
        return;
      case 'peer-left':
        this.slotsBound[msg.slot] = false;
        return;
      case 'frame':
        this.frameInbox.push({ frame: msg.frame, slot: msg.slot, input: msg.input });
        return;
      case 'frames':
        if (Array.isArray(msg.inputs)) {
          for (let i = 0; i < msg.inputs.length; i++) {
            this.frameInbox.push({ frame: msg.base + i, slot: msg.slot, input: msg.inputs[i] >>> 0 });
          }
        }
        return;
      case 'hash':
        this.hashInbox.push({ frame: msg.frame, slot: msg.slot, hash: msg.hash });
        return;
      case 'session-error':
        if (this.rejectConnect) { this.rejectConnect(new Error('session-error: ' + msg.code)); this.resolveConnect = null; this.rejectConnect = null; }
        this.disconnect();
        return;
    }
  };
}

/** Inline spectator worker. The spectator path receives the same high-rate
 *  frame/hash traffic as a pilot but does not need to send anything back. Keep
 *  parsing and socket reads off the render thread so mobile watch pages can
 *  keep drawing while the broker replays history or fans out live inputs. */
function buildSpectatorWorkerSource(): string {
  return `
    'use strict';
    var ws = null;
    var PEER_BINARY_MAGIC = 0x50;
    var PEER_BINARY_VERSION = 1;
    var PEER_BINARY_FRAME = 1;
    var PEER_BINARY_FRAMES = 2;
    var PEER_BINARY_HASH = 3;
    function post(m) { self.postMessage(m); }
    function toInt(value, fallback) {
      var n = Number(value);
      return isFinite(n) ? Math.floor(n) : fallback;
    }
    function parseBinaryPeerMessage(data) {
      if (!(data instanceof ArrayBuffer) || data.byteLength < 9) return null;
      var bytes = new Uint8Array(data);
      if (bytes[0] !== PEER_BINARY_MAGIC || bytes[1] !== PEER_BINARY_VERSION) return null;
      var kind = bytes[2];
      var slot = bytes[3];
      var view = new DataView(data);
      var frameOrBase = view.getUint32(4, true);
      if (kind === PEER_BINARY_FRAME) {
        if (data.byteLength !== 12) return null;
        return { type: 'frame', frame: frameOrBase, slot: slot, input: view.getUint32(8, true) };
      }
      if (kind === PEER_BINARY_HASH) {
        if (data.byteLength !== 12) return null;
        return { type: 'hash', frame: frameOrBase, slot: slot, hash: view.getUint32(8, true) };
      }
      if (kind === PEER_BINARY_FRAMES) {
        var count = bytes[8];
        if (count <= 0 || data.byteLength !== 9 + count * 4) return null;
        var inputs = [];
        for (var i = 0; i < count; i++) inputs.push(view.getUint32(9 + i * 4, true));
        return { type: 'frames', slot: slot, base: frameOrBase, inputs: inputs };
      }
      return null;
    }
    function parsePeerMessageData(data) {
      if (data instanceof ArrayBuffer) return parseBinaryPeerMessage(data);
      if (typeof data !== 'string') return null;
      try {
        var parsed = JSON.parse(data);
        return parsed && typeof parsed.type === 'string' ? parsed : null;
      } catch (e) {
        return null;
      }
    }
    function normaliseInputs(raw) {
      if (!Array.isArray(raw)) return [];
      var out = [];
      for (var i = 0; i < raw.length; i++) out.push((Number(raw[i]) || 0) >>> 0);
      return out;
    }
    function normaliseFrameSetEntries(raw) {
      if (!Array.isArray(raw)) return [];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        var slot = Array.isArray(item) ? toInt(item[0], -1) : toInt(item && item.slot, -1);
        var input = Array.isArray(item) ? Number(item[1]) : Number(item && item.input);
        if (slot < 0) continue;
        out.push([slot, (input || 0) >>> 0]);
      }
      return out;
    }
    function forwardPeerMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'peerwatch-ready' || msg.type === 'session-config') {
        post({
          kind: msg.type,
          players: msg.players,
          aiFill: msg.aiFill === true ? true : undefined,
          humanSlots: Array.isArray(msg.humanSlots) ? msg.humanSlots : undefined,
          takeovers: Array.isArray(msg.takeovers) ? msg.takeovers : undefined,
          inputDelay: typeof msg.inputDelay === 'number' ? msg.inputDelay : undefined
        });
        return;
      }
      if (msg.type === 'peer-joined') {
        post({ kind: 'peer-joined', slot: toInt(msg.slot, -1) });
        return;
      }
      if (msg.type === 'peer-left') {
        post({ kind: 'peer-left', slot: toInt(msg.slot, -1) });
        return;
      }
      if (msg.type === 'frame') {
        post({ kind: 'frame', frame: toInt(msg.frame, -1), slot: toInt(msg.slot, -1), input: (Number(msg.input) || 0) >>> 0 });
        return;
      }
      if (msg.type === 'frames') {
        post({ kind: 'frames', slot: toInt(msg.slot, -1), base: toInt(msg.base, -1), inputs: normaliseInputs(msg.inputs) });
        return;
      }
      if (msg.type === 'frame-set') {
        var entries = normaliseFrameSetEntries(msg.entries);
        for (var i = 0; i < entries.length; i++) {
          post({ kind: 'frame', frame: toInt(msg.frame, -1), slot: entries[i][0], input: entries[i][1] });
        }
        return;
      }
      if (msg.type === 'hash') {
        post({ kind: 'hash', frame: toInt(msg.frame, -1), slot: toInt(msg.slot, -1), hash: (Number(msg.hash) || 0) >>> 0 });
        return;
      }
      if (msg.type === 'session-error') {
        post({ kind: 'session-error', code: typeof msg.code === 'string' ? msg.code : 'unknown' });
      }
    }
    function closeSocket() {
      if (!ws) return;
      var current = ws;
      ws = null;
      try { current.close(); } catch (e) {}
    }
    self.addEventListener('message', function (ev) {
      var msg = ev.data || {};
      if (msg.kind === 'connect') {
        closeSocket();
        try {
          ws = new WebSocket(String(msg.url || ''));
          ws.binaryType = 'arraybuffer';
        } catch (e) {
          post({ kind: 'error', error: e && e.message ? e.message : String(e) });
          return;
        }
        ws.addEventListener('open', function () { post({ kind: 'open' }); });
        ws.addEventListener('message', function (event) { forwardPeerMessage(parsePeerMessageData(event.data)); });
        ws.addEventListener('close', function () { post({ kind: 'closed' }); });
        ws.addEventListener('error', function () { post({ kind: 'error', error: 'socket error' }); });
      } else if (msg.kind === 'disconnect') {
        closeSocket();
      }
    });
  `;
}
