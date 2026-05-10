/**
 * Vendored type declarations for signet-login.
 *
 * The runtime is loaded via the IIFE bundle at /signet-login.iife.js (which
 * attaches `window.Signet`); we never import values from this module at run
 * time, so the npm package dependency would only exist for type safety. Keeping
 * a local declaration removes the cross-repo build coupling — CI doesn't need
 * to clone signet-login just to typecheck.
 *
 * Source of truth: `signet-login/src/types.ts`. When that changes in a way
 * that affects this game's surface, update this file by hand. Drift is
 * detectable: TypeScript will start objecting on the next build.
 */

declare module 'signet-login' {
  /** A signed Nostr event. */
  export interface NostrEvent {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
    sig: string;
  }

  /** An unsigned event template ready for signing. */
  export interface EventTemplate {
    kind: number;
    created_at?: number;
    tags?: string[][];
    content: string;
  }

  export type LoginMethod = 'nip07' | 'redirect' | 'bunker';

  export interface SignerCapabilities {
    canSignEvents: boolean;
    hasNip44: boolean;
  }

  export interface SignetSigner {
    readonly pubkey: string;
    readonly method: LoginMethod;
    readonly capabilities: SignerCapabilities;
    signEvent(template: EventTemplate): Promise<NostrEvent>;
    nip44?: {
      encrypt(peerPubkey: string, plaintext: string): Promise<string>;
      decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
    };
    close(): Promise<void>;
  }

  export interface SignetAuthEvent extends NostrEvent {
    kind: 21236;
  }

  export interface SignetSession {
    pubkey: string;
    method: LoginMethod;
    signer: SignetSigner;
    authEvent: SignetAuthEvent;
    expiresAt?: number;
    displayName?: string;
  }

  /** Result shape from Signet.handleRedirectCallback(). */
  export type ConsumeCallbackResult =
    | { kind: 'session'; session: SignetSession }
    | { kind: 'denied' }
    | { kind: 'no-callback' }
    | { kind: 'invalid'; reason: string };
}
