/**
 * Phone-as-controller — PWA (mobile) side.
 *
 * Connects to the controller-ws relay as `role=phone` with the
 * sessionId from the URL, then exchanges JSON frames with the host.
 *
 * Two inbound message types:
 *   { type: 'peer-up' | 'peer-down' }     — connection state
 *   { type: 'controller-spec', spec: ... } — game's button layout
 *
 * Outbound:
 *   { k: <slot>, v: <value> }              — slot-keyed input frame
 */

import {
  type ControllerInputFrame,
  type ControllerSpec,
  type PairingToken,
  type RemoteEventTemplate,
  type RemoteSignedEvent,
  type SignerAnnounceFrame,
  type SignerRevokeFrame,
  type SignResponseFrame,
} from './controller-types.js';

/** Identity payload the phone announces to the host on pair. Built
 *  from the locally-signed-in SignetSession + optional kind-0 profile. */
export interface AnnouncedSigner {
  pubkey: string;
  npub?: string;
  name?: string;
  method?: SignerAnnounceFrame['method'];
  caps?: SignerAnnounceFrame['caps'];
}

/** Handler the caller installs to fulfil host sign-requests. Receives
 *  the event template; resolves with the signed event or throws. The
 *  client serialises the WS response so multiple in-flight requests
 *  don't get tangled. */
export type SignRequestHandler = (template: RemoteEventTemplate) => Promise<RemoteSignedEvent>;

export interface ControllerClient {
  /** True once the relay reports the host is also connected. */
  paired: boolean;
  /** Current spec — null until the host sends one. */
  spec: ControllerSpec | null;
  /** Send one input event. Drops silently if the socket is closed. */
  sendInput: (slot: string, value: string) => void;
  /**
   * Update the announced signer. Pass null to revoke. The frame is
   * sent immediately if paired, otherwise queued until pair. Re-sent
   * on reconnect. Idempotent — re-announcing the same identity is
   * cheap.
   */
  announceSigner: (signer: AnnouncedSigner | null) => void;
  /**
   * Install the sign-request handler. The phone's local signer is the
   * source of truth; the handler awaits a signed event and the client
   * frames it back to the host. Pass null to refuse all requests
   * (responds with 'no-signer'). One handler at a time.
   */
  onSignRequest: (handler: SignRequestHandler | null) => void;
  /** Force-close the WS. */
  close: () => void;
  /** Status callback. */
  onStatus: (cb: (s: ControllerClientStatus) => void) => void;
  /** Spec callback — fires whenever a fresh spec arrives. */
  onSpec: (cb: (spec: ControllerSpec) => void) => void;
}

export type ControllerClientStatus =
  | { kind: 'connecting' }
  | { kind: 'waiting' }   // socket open, waiting for host to pair
  | { kind: 'paired' }
  | { kind: 'reconnecting' }
  | { kind: 'closed' };

export function startControllerClient(token: PairingToken): ControllerClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let paired = false;
  let spec: ControllerSpec | null = null;
  let reconnectAttempt = 0;
  let statusCb: ((s: ControllerClientStatus) => void) | null = null;
  let specCb: ((s: ControllerSpec) => void) | null = null;
  // Latest signer the caller has handed us. Re-sent on every pair-up
  // (incl. reconnects) so the host always knows the current identity.
  // null means the controller is signed out / never signed in.
  let pendingSigner: AnnouncedSigner | null = null;
  let lastAnnouncedPubkey: string | null = null;
  const fireStatus = (s: ControllerClientStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };
  const fireSpec = (s: ControllerSpec): void => { try { specCb?.(s); } catch { /* ignore */ } };
  const url = `${token.ws}?s=${encodeURIComponent(token.sessionId)}&r=phone`;

  const sendSignerFrame = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pendingSigner) {
      const frame: SignerAnnounceFrame = {
        type: 'signer-announce',
        pubkey: pendingSigner.pubkey,
        ...(pendingSigner.npub ? { npub: pendingSigner.npub } : {}),
        ...(pendingSigner.name ? { name: pendingSigner.name } : {}),
        ...(pendingSigner.method ? { method: pendingSigner.method } : {}),
        ...(pendingSigner.caps ? { caps: pendingSigner.caps } : {}),
      };
      try { ws.send(JSON.stringify(frame)); lastAnnouncedPubkey = pendingSigner.pubkey; }
      catch { /* ignore — next pair-up will retry */ }
    } else if (lastAnnouncedPubkey) {
      // We previously announced an identity; the user has signed out.
      // Tell the host to drop the remote signer.
      const frame: SignerRevokeFrame = { type: 'signer-revoke' };
      try { ws.send(JSON.stringify(frame)); lastAnnouncedPubkey = null; }
      catch { /* ignore */ }
    }
  };

  const connect = (): void => {
    if (closed) return;
    fireStatus({ kind: reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      reconnectAttempt = 0;
      fireStatus(paired ? { kind: 'paired' } : { kind: 'waiting' });
      // Reconnect mid-session — if we were already paired, immediately
      // re-announce so the host (which may have lost / replaced its
      // state) sees the identity again.
      if (paired) sendSignerFrame();
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      if (obj.type === 'peer-up') {
        if (!paired) {
          paired = true;
          fireStatus({ kind: 'paired' });
          // Host just came up — announce identity (or revoke, if signed
          // out). The host's onSigner callback fires from this frame.
          sendSignerFrame();
        }
      } else if (obj.type === 'peer-down') {
        if (paired) { paired = false; fireStatus({ kind: 'waiting' }); }
      } else if (obj.type === 'controller-spec') {
        const incoming = obj.spec as ControllerSpec | undefined;
        if (incoming && typeof incoming === 'object' && incoming.slots) {
          spec = incoming;
          fireSpec(incoming);
        }
      } else if (obj.type === 'sign-request') {
        // Host wants us to sign an event with the locally-held key.
        // Dispatch to the installed handler; respond with the signed
        // event or an error code. Concurrency is the handler's
        // problem — Pallasite wraps via serialiseSigner so multiple
        // sign-requests funnel through the global sign queue serially.
        const id = typeof obj.id === 'string' ? obj.id : '';
        const template = obj.template as RemoteEventTemplate | undefined;
        if (!id || !template || typeof template !== 'object' || typeof template.kind !== 'number') {
          // Bad frame — surface an error if we have an id, otherwise drop.
          if (id) respondToSignRequest(id, { ok: false, error: 'bad-request' });
          return;
        }
        const handler = signRequestHandler;
        if (!handler) {
          respondToSignRequest(id, { ok: false, error: 'no-signer' });
          return;
        }
        void (async () => {
          try {
            const event = await handler(template);
            respondToSignRequest(id, { ok: true, event });
          } catch (err) {
            respondToSignRequest(id, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        })();
      }
    };
    ws.onerror = () => { /* close handler will reconnect */ };
    ws.onclose = () => {
      if (paired) { paired = false; }
      scheduleReconnect();
    };
  };
  const scheduleReconnect = (): void => {
    if (closed) return;
    reconnectAttempt += 1;
    const delay = Math.min(15_000, 500 * Math.pow(1.6, reconnectAttempt));
    window.setTimeout(connect, delay);
  };
  connect();

  const sendInput = (slot: string, value: string): void => {
    if (closed) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame: ControllerInputFrame = { k: slot, v: value };
    try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
  };

  const close = (): void => {
    closed = true;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    fireStatus({ kind: 'closed' });
  };

  const announceSigner = (signer: AnnouncedSigner | null): void => {
    pendingSigner = signer;
    if (paired) sendSignerFrame();
  };

  let signRequestHandler: SignRequestHandler | null = null;
  const respondToSignRequest = (id: string, result: { ok: true; event: RemoteSignedEvent } | { ok: false; error: string }): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame: SignResponseFrame = result.ok
      ? { type: 'sign-response', id, ok: true, event: result.event }
      : { type: 'sign-response', id, ok: false, error: result.error };
    try { ws.send(JSON.stringify(frame)); } catch { /* host will time out */ }
  };
  const onSignRequest = (handler: SignRequestHandler | null): void => {
    signRequestHandler = handler;
  };

  return {
    get paired() { return paired; },
    get spec() { return spec; },
    sendInput,
    announceSigner,
    onSignRequest,
    close,
    onStatus: (cb) => { statusCb = cb; },
    onSpec: (cb) => { specCb = cb; },
  };
}
