/**
 * Lockstep peer transport for shared-arena 2-player multiplayer (M3).
 *
 * Two clients on one shared session exchange one input bitfield per sim step
 * via the controller-ws broker (in the `joystick` repo), kept in lockstep by
 * the deterministic sim foundation built in M1 / M2. This module is the
 * client side of the wire protocol; the broker change lives in the joystick
 * repo (see `docs/ideas/shared-arena-multiplayer.md` section 6.1).
 *
 * Two implementations:
 *
 * - `WebSocketPeer` — real transport against the broker. JSON-encoded
 *   messages, one-and-done connect, automatic ping reconnect not done in v1.
 * - `LoopbackPeer` — pair two instances together with `loopbackPair()`; one's
 *   send lands in the other's drain inbox after a configurable simulated
 *   latency. Used by the M3 offline harness to drive both sides of a duel
 *   inside one browser without the broker.
 *
 * Both expose the same `Peer` interface; main.ts's lockstep loop is written
 * against the interface so swapping transports is a one-liner.
 */

// ── Wire format ──────────────────────────────────────────────────────────────

/** Slot index: 0 = host, 1 = guest. Set when the client joins a session. */
export type PeerSlot = 0 | 1;

/** Messages this client sends to the broker. */
export type PeerMsgOut =
  | { type: 'hello-peer'; session: string; slot: PeerSlot; version: 1 }
  | { type: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { type: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { type: 'bye'; slot: PeerSlot };

/** Messages the broker forwards to this client. `frame` / `hash` are mirrors
 *  of the other slot's outbound traffic; `peer-joined` / `peer-left` are
 *  broker-originated lifecycle events; `session-error` is fatal. */
export type PeerMsgIn =
  | { type: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { type: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { type: 'peer-joined'; slot: PeerSlot }
  | { type: 'peer-left'; slot: PeerSlot; reason: string }
  | { type: 'session-error'; code: string };

/** Per-frame inbox entry, drained by the lockstep loop into the InputLog. */
export interface FrameDelivery { frame: number; input: number; }

/** Per-frame hash inbox entry, drained for desync detection. */
export interface HashDelivery { frame: number; hash: number; }

/** Options for opening a peer connection. */
export interface PeerConnectOpts {
  /** Broker URL (ws:// or wss://). For LoopbackPeer this is ignored. */
  url: string;
  /** Shared session ID. Both peers must use the same string. */
  session: string;
  /** This client's slot. Host picks 0; guest picks 1. */
  localSlot: PeerSlot;
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
  /** Buffer-and-send the local input for the given frame. */
  sendFrame(frame: number, encoded: number): void;
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

  connect(_opts: PeerConnectOpts): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  sendFrame(frame: number, encoded: number): void {
    if (this.partner) this.partner.receiveFromPartner({ frame, input: encoded });
  }

  sendHash(frame: number, hash: number): void {
    if (this.partner) this.partner.receiveHashFromPartner({ frame, hash });
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
 *  happily connected, we auto-reconnect with a short backoff. Each
 *  reconnect re-sends hello-peer; the broker's peer-joined fires when
 *  both peers are bound again. Callers can register `setOnReconnected`
 *  to replay recently-sent input frames so the input log fills the
 *  hole left by the drop. After RECONNECT_MAX_ATTEMPTS the peer gives
 *  up and stays disconnected so the lockstep loop's existing
 *  120-frame disconnect timer can end the run.
 */
const RECONNECT_BACKOFF_MS = [250, 500, 1000];
const RECONNECT_MAX_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

/** Diagnostic ring entry for the wire trace. Each send/receive records one
 *  of these, capped at WIRE_TRACE_SIZE. Used by the E2E runner to debug
 *  the duel desync — set `window.__pallasiteWireTrace = 1` (or the URL
 *  query param `?wiretrace=1`) before constructing the peer. */
export interface WireTraceEntry {
  t: number;      // performance.now()
  dir: 'out' | 'in';
  kind: 'frame' | 'hash' | 'hello-peer' | 'peer-joined' | 'peer-left' | 'session-error' | 'bye' | 'unknown';
  frame?: number;
  slot?: number;
  input?: number;
  hash?: number;
  bufferedAmount?: number;
}
const WIRE_TRACE_SIZE = 4096;

export class WebSocketPeer implements Peer {
  private ws: WebSocket | null = null;
  private localSlot: PeerSlot = 0;
  private session = '';
  private url = '';
  private connected = false;
  private partnerConnected = false;
  private frameInbox: FrameDelivery[] = [];
  private hashInbox: HashDelivery[] = [];
  private highestRemoteFrame = -1;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;
  /** Set true by disconnect() so the close handler doesn't reschedule. */
  private deliberateClose = false;
  /** Reconnect attempts since the last successful peer-joined. Reset to
   *  0 once we observe peer-joined again. */
  private reconnectAttempt = 0;
  /** Pending reconnect timer so disconnect() can cancel it. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Optional caller hook fired AFTER a reconnect's peer-joined arrives.
   *  Used by the lockstep loop to replay recently-sent input frames
   *  so the partner's input log can refill the gap left by the drop. */
  private onReconnected: (() => void) | null = null;
  /** Diagnostic wire trace. Enabled by `window.__pallasiteWireTrace = 1`
   *  before construction. Ring of WIRE_TRACE_SIZE entries, oldest dropped. */
  private wireTrace: WireTraceEntry[] | null = null;
  private wireTraceHead = 0;
  /** Cumulative send/receive counters (always on, lightweight). */
  public sentFrameCount = 0;
  public sentHashCount = 0;
  public recvFrameCount = 0;
  public recvHashCount = 0;
  public lastSendFrame = -1;
  public lastRecvFrame = -1;

  connect(opts: PeerConnectOpts): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.localSlot = opts.localSlot;
      this.session = opts.session;
      this.url = opts.url;
      this.deliberateClose = false;
      this.reconnectAttempt = 0;
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      // Opt-in wire trace for the E2E runner. Allocated on connect so the
      // window flag can be set late (before peer.connect) without missing
      // boot-time entries.
      try {
        if (typeof window !== 'undefined' && (window as unknown as { __pallasiteWireTrace?: unknown }).__pallasiteWireTrace) {
          this.wireTrace = new Array(WIRE_TRACE_SIZE);
        }
      } catch { /* SSR or sandboxed — no window */ }
      try {
        this.ws = new WebSocket(this.buildSocketUrl());
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws.addEventListener('open', () => this.onOpen());
      this.ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
      this.ws.addEventListener('close', () => this.onClose());
      this.ws.addEventListener('error', () => this.onError());
    });
  }

  /** Append one entry to the wire-trace ring. No-op if trace disabled. */
  private traceEntry(e: WireTraceEntry): void {
    if (!this.wireTrace) return;
    this.wireTrace[this.wireTraceHead] = e;
    this.wireTraceHead = (this.wireTraceHead + 1) % WIRE_TRACE_SIZE;
  }

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
  getWireCounters(): { sentFrameCount: number; sentHashCount: number; recvFrameCount: number; recvHashCount: number; lastSendFrame: number; lastRecvFrame: number; bufferedAmount: number; readyState: number } {
    return {
      sentFrameCount: this.sentFrameCount,
      sentHashCount: this.sentHashCount,
      recvFrameCount: this.recvFrameCount,
      recvHashCount: this.recvHashCount,
      lastSendFrame: this.lastSendFrame,
      lastRecvFrame: this.lastRecvFrame,
      bufferedAmount: this.ws ? this.ws.bufferedAmount : -1,
      readyState: this.ws ? this.ws.readyState : -1,
    };
  }

  /** Compose the broker URL with the role+session+slot query params the
   *  controller-ws broker reads on `upgrade`. opts.url stays bare ("just the
   *  broker host") so reconnects rebuild the full URL idempotently. */
  private buildSocketUrl(): string {
    const sep = this.url.includes('?') ? '&' : '?';
    return `${this.url}${sep}s=${encodeURIComponent(this.session)}&r=peer&slot=${this.localSlot}`;
  }

  /** Register a callback to fire after a successful reconnect. The
   *  callback receives no args; consult `isConnected()` for state. */
  setOnReconnected(cb: (() => void) | null): void {
    this.onReconnected = cb;
  }

  disconnect(): void {
    this.deliberateClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws && this.connected) {
      const bye: PeerMsgOut = { type: 'bye', slot: this.localSlot };
      try { this.ws.send(JSON.stringify(bye)); } catch { /* socket may already be closed */ }
    }
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
    this.partnerConnected = false;
  }

  sendFrame(frame: number, encoded: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: PeerMsgOut = { type: 'frame', frame, slot: this.localSlot, input: encoded };
    this.ws.send(JSON.stringify(msg));
    this.sentFrameCount++;
    this.lastSendFrame = frame;
    this.traceEntry({ t: performance.now(), dir: 'out', kind: 'frame', frame, slot: this.localSlot, input: encoded, bufferedAmount: this.ws.bufferedAmount });
  }

  sendHash(frame: number, hash: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: PeerMsgOut = { type: 'hash', frame, slot: this.localSlot, hash };
    this.ws.send(JSON.stringify(msg));
    this.sentHashCount++;
    this.traceEntry({ t: performance.now(), dir: 'out', kind: 'hash', frame, slot: this.localSlot, hash, bufferedAmount: this.ws.bufferedAmount });
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

  isConnected(): boolean { return this.connected && this.partnerConnected; }
  lastReceivedFrame(): number { return this.highestRemoteFrame; }

  private onOpen(): void {
    const hello: PeerMsgOut = { type: 'hello-peer', session: this.session, slot: this.localSlot, version: 1 };
    if (this.ws) this.ws.send(JSON.stringify(hello));
    this.connected = true;
    // We do not resolve here: the partner may not have joined yet. The
    // resolver fires on `peer-joined` (or rejects on session-error).
  }

  private onMessage(ev: MessageEvent): void {
    let msg: PeerMsgIn;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as PeerMsgIn;
    } catch { return; }
    switch (msg.type) {
      case 'frame':
        this.frameInbox.push({ frame: msg.frame, input: msg.input });
        if (msg.frame > this.highestRemoteFrame) this.highestRemoteFrame = msg.frame;
        this.recvFrameCount++;
        this.lastRecvFrame = msg.frame;
        this.traceEntry({ t: performance.now(), dir: 'in', kind: 'frame', frame: msg.frame, slot: msg.slot, input: msg.input });
        return;
      case 'hash':
        this.hashInbox.push({ frame: msg.frame, hash: msg.hash });
        this.recvHashCount++;
        this.traceEntry({ t: performance.now(), dir: 'in', kind: 'hash', frame: msg.frame, slot: msg.slot, hash: msg.hash });
        return;
      case 'peer-joined': {
        const wasReconnecting = this.reconnectAttempt > 0 && !this.partnerConnected;
        this.partnerConnected = true;
        if (this.resolveConnect) { this.resolveConnect(); this.resolveConnect = null; this.rejectConnect = null; }
        if (wasReconnecting) {
          this.reconnectAttempt = 0;
          // Caller (main.ts) replays the local input ring so the partner
          // can fill their input log over the gap we left.
          if (this.onReconnected) try { this.onReconnected(); } catch { /* don't let a buggy hook poison the wire */ }
        }
        return;
      }
      case 'peer-left':
        this.partnerConnected = false;
        return;
      case 'session-error':
        if (this.rejectConnect) { this.rejectConnect(new Error('session-error: ' + msg.code)); this.resolveConnect = null; this.rejectConnect = null; }
        this.disconnect();
        return;
    }
  }

  private onClose(): void {
    const wasConnecting = this.rejectConnect !== null;
    const wasFullyConnected = this.connected && this.partnerConnected;
    this.connected = false;
    this.partnerConnected = false;
    if (wasConnecting && this.rejectConnect) {
      this.rejectConnect(new Error('socket closed before partner joined'));
      this.resolveConnect = null;
      this.rejectConnect = null;
      return;
    }
    // Auto-reconnect only on an unexpected drop after we'd reached
    // peer-joined. Initial connect failures and deliberate disconnects
    // never reach here.
    if (!this.deliberateClose && wasFullyConnected) {
      this.scheduleReconnect();
    }
  }

  private onError(): void {
    if (this.rejectConnect) {
      this.rejectConnect(new Error('socket error'));
      this.resolveConnect = null;
      this.rejectConnect = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) return;
    const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempt];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.deliberateClose) return;
      this.openSocket();
    }, delay);
  }

  private openSocket(): void {
    try {
      this.ws = new WebSocket(this.buildSocketUrl());
    } catch {
      // Construction itself failed (rare). Schedule another attempt.
      this.scheduleReconnect();
      return;
    }
    this.ws.addEventListener('open', () => this.onOpen());
    this.ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    this.ws.addEventListener('close', () => this.onClose());
    this.ws.addEventListener('error', () => this.onError());
  }
}

// ── SpectatorPeer ────────────────────────────────────────────────────────────

/** Per-frame delivery from a spectator drain. Slot tells the lockstep loop
 *  which player's input log slot to write to; the spectator sees both. */
export interface SpectatorFrameDelivery { frame: number; slot: PeerSlot; input: number; }
export interface SpectatorHashDelivery { frame: number; slot: PeerSlot; hash: number; }

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
  private ws: WebSocket | null = null;
  private connected = false;
  private slotsBound: [boolean, boolean] = [false, false];
  private frameInbox: SpectatorFrameDelivery[] = [];
  private hashInbox: SpectatorHashDelivery[] = [];
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((e: Error) => void) | null = null;

  connect(opts: { url: string; session: string }): Promise<void> {
    void opts.session;  // session is encoded into opts.url by the caller
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      try {
        this.ws = new WebSocket(opts.url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.ws.addEventListener('open', () => { this.connected = true; });
      this.ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
      this.ws.addEventListener('close', () => {
        this.connected = false;
        this.slotsBound = [false, false];
        if (this.rejectConnect) { this.rejectConnect(new Error('socket closed before both peers joined')); this.resolveConnect = null; this.rejectConnect = null; }
      });
      this.ws.addEventListener('error', () => {
        if (this.rejectConnect) { this.rejectConnect(new Error('socket error')); this.resolveConnect = null; this.rejectConnect = null; }
      });
    });
  }

  disconnect(): void {
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
    this.slotsBound = [false, false];
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
  bothPeersBound(): boolean { return this.slotsBound[0] && this.slotsBound[1]; }

  private onMessage(ev: MessageEvent): void {
    let msg: PeerMsgIn | { type: 'peerwatch-ready' };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as PeerMsgIn | { type: 'peerwatch-ready' };
    } catch { return; }
    switch (msg.type) {
      case 'peerwatch-ready':
        // Ack only; we still wait for both peer-joined slots before resolving.
        return;
      case 'peer-joined':
        this.slotsBound[msg.slot] = true;
        if (this.bothPeersBound() && this.resolveConnect) {
          this.resolveConnect();
          this.resolveConnect = null;
          this.rejectConnect = null;
        }
        return;
      case 'peer-left':
        this.slotsBound[msg.slot] = false;
        return;
      case 'frame':
        this.frameInbox.push({ frame: msg.frame, slot: msg.slot, input: msg.input });
        return;
      case 'hash':
        this.hashInbox.push({ frame: msg.frame, slot: msg.slot, hash: msg.hash });
        return;
      case 'session-error':
        if (this.rejectConnect) { this.rejectConnect(new Error('session-error: ' + msg.code)); this.resolveConnect = null; this.rejectConnect = null; }
        this.disconnect();
        return;
    }
  }
}
