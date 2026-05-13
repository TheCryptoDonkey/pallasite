/**
 * RemoteControllerSigner — adapt ControllerHost.signEvent into a
 * SignetSigner so the rest of the game can sign through the phone
 * transparently.
 *
 * Step 3 of the phone-as-signer plan. When the controller PWA
 * announces a signed-in identity, the host swaps state.session for a
 * new SignetSession backed by RemoteControllerSigner. Every
 * downstream signEvent (heartbeat, score publish, replay chunks,
 * claim) now round-trips through the phone's local signer.
 *
 * On revoke (phone signed out, peer-down, host close), state.session
 * reverts to whatever local session it had before the swap.
 *
 * The swap is gated behind an auth-event synthesis: we ask the phone
 * to sign a kind-21236 challenge first, since SignetSession contracts
 * include an authEvent. If the synthesis fails the swap aborts and
 * the player keeps signing locally.
 */

import type { SignetSession, SignetSigner, EventTemplate, NostrEvent, SignetAuthEvent } from 'signet-login';
import type { GameState } from './types.js';
import type { AnnouncedSigner, ControllerHost } from './controller-host.js';
import type { RemoteEventTemplate, RemoteSignedEvent } from './controller-types.js';
import { serialiseSigner } from './sign-queue.js';

const REMOTE_METHOD = 'remote-controller' as unknown as SignetSigner['method'];

/** SignetSigner adapter that forwards every signEvent to host.signEvent. */
class RemoteControllerSigner implements SignetSigner {
  readonly pubkey: string;
  readonly method = REMOTE_METHOD;
  readonly capabilities: SignetSigner['capabilities'];

  constructor(private host: ControllerHost, announced: AnnouncedSigner) {
    this.pubkey = announced.pubkey;
    this.capabilities = {
      canSignEvents: announced.caps?.canSignEvents ?? true,
      hasNip44: announced.caps?.hasNip44 ?? false,
    };
  }

  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    const remoteTemplate: RemoteEventTemplate = {
      kind: template.kind,
      content: template.content,
      ...(template.tags ? { tags: template.tags } : {}),
      ...(template.created_at !== undefined ? { created_at: template.created_at } : {}),
    };
    const event: RemoteSignedEvent = await this.host.signEvent(remoteTemplate);
    // RemoteSignedEvent and NostrEvent are shape-compatible — same
    // NIP-01 shape. Type-cast through unknown to bridge the two
    // module-local declarations.
    return event as unknown as NostrEvent;
  }

  async close(): Promise<void> {
    // No transport to tear down here — the underlying WS is owned by
    // the ControllerHost which has its own cleanup lifecycle. Defined
    // for SignetSigner interface compliance.
  }
}

/**
 * Subscribe the game state to the controller's signer announcements.
 * When the phone announces an identity, swaps state.session for a
 * RemoteControllerSigner-backed session and stashes the previous one.
 * When the phone revokes (or the host disconnects), restores the
 * previous session.
 *
 * Returns a detach() fn so the host's pairing dialog can clean up
 * its subscription if the host is torn down before the user reloads.
 *
 * Idempotency: re-announcing the same pubkey is treated as a no-op
 * (we already swapped). A different pubkey replaces in place — we
 * keep the ORIGINAL pre-swap session as the revert target, not the
 * intermediate remote session.
 */
export function attachRemoteSession(state: GameState, host: ControllerHost): () => void {
  // Snapshot of the session the game had before we ever swapped it,
  // OR null if state had no session pre-swap. Either way this is the
  // value we restore on revoke.
  let savedLocal: SignetSession | null | undefined = undefined;
  let activeRemote: SignetSession | null = null;
  let swapInFlight = false;

  const unsub = host.onSigner((announced) => {
    if (announced) {
      // Skip if we're already pointing at this exact identity.
      if (activeRemote && activeRemote.pubkey === announced.pubkey) return;
      if (swapInFlight) return;  // ignore re-announces while we're synthesising
      swapInFlight = true;
      void (async () => {
        try {
          const rawSigner = new RemoteControllerSigner(host, announced);
          // Synthesise the authEvent up-front. Single signEvent
          // round-trip to the phone; reuses the same protocol that
          // game traffic uses. If this fails the swap aborts.
          const authEvent = (await rawSigner.signEvent({
            kind: 21236,
            content: '',
            tags: [
              ['app', 'pallasite'],
              ['method', 'remote-controller'],
              ['challenge', crypto.randomUUID()],
            ],
            created_at: Math.floor(Date.now() / 1000),
          })) as SignetAuthEvent;
          // Wrap through the global sign queue so the remote signer's
          // signEvent shares serialisation with any pre-swap signer
          // queue depth. Without this a burst of heartbeat + replay
          // + claim signs would all race the phone.
          const wrappedSigner = serialiseSigner(rawSigner);
          const remoteSession: SignetSession = {
            pubkey: announced.pubkey,
            method: REMOTE_METHOD as unknown as SignetSession['method'],
            signer: wrappedSigner,
            authEvent,
            ...(announced.name ? { displayName: announced.name } : {}),
          };
          // First successful swap latches the saved-local pointer.
          // Subsequent identity changes overwrite activeRemote but
          // savedLocal stays anchored to the pre-swap session.
          if (savedLocal === undefined) {
            savedLocal = state.session;
          }
          activeRemote = remoteSession;
          state.session = remoteSession;
        } catch (err) {
          console.warn('[remote-signer] swap aborted:', err);
        } finally {
          swapInFlight = false;
        }
      })();
    } else {
      // Revoke — phone signed out, peer disconnected, or host closed.
      // Revert to whatever the local session was pre-swap.
      if (activeRemote && savedLocal !== undefined) {
        state.session = savedLocal;
        activeRemote = null;
        savedLocal = undefined;
      }
    }
  });

  return unsub;
}
