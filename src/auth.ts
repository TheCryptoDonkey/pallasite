/**
 * Auth state — wraps signet-login.
 *
 * Three login paths offered, all funnelled through Signet.login(). The game
 * doesn't care which method the user picks — it just gets a SignetSession
 * back with a signer that may or may not be capable of signing further events.
 *
 * Both calls are wrapped with timeouts because window.nostr / NIP-46 bunker
 * relays have no native cancellation — if the signer is cold or unreachable
 * the underlying promise can hang for tens of seconds without resolving. The
 * Signet modal itself owns its UI so we can't dismiss it from here, but we
 * can at least free our own state and surface the error to the player.
 */

import type { ConsumeCallbackResult, SignetSession } from 'signet-login';
import { getActiveRelays } from './relays.js';

/**
 * Result shape from signet-verify's verifyAge() — vendored to keep the
 * typecheck self-contained. Source of truth: `signet-verify/src/signet-verify.ts`
 * (`SignetVerifyResult`). Drift is detectable: we only consume the fields
 * below, so any rename will surface as a type error here.
 */
export interface SignetVerifyResult {
  verified: boolean;
  ageRange: string | null;
  tier: number | null;
  verifierPubkey: string | null;
  verifierConfirmed: boolean | null;
  expiresAt: number | null;
  error?: string;
}

export interface SignetVerifyOptions {
  relayUrl?: string;
  theme?: 'light' | 'dark' | 'auto';
  timeout?: number;
  verifierCheckUrl?: string | null;
  acceptUnconfirmed?: boolean;
}

declare global {
  interface Window {
    Signet?: {
      login: (opts: {
        appName: string;
        theme?: 'light' | 'dark' | 'auto';
        relayUrl?: string;
        mode?: 'relay' | 'redirect';
        redirectCallback?: string;
      }) => Promise<SignetSession | null>;
      restoreSession: () => Promise<SignetSession | null>;
      logout: (s?: SignetSession) => Promise<void>;
      handleRedirectCallback: () => Promise<ConsumeCallbackResult>;
      verifyAge?: (
        requiredAgeRange: string,
        options?: SignetVerifyOptions,
      ) => Promise<SignetVerifyResult>;
    };
  }
}

export const APP_NAME = 'Pallasite';
export const GAME_ID = 'pallasite';

/** Cap interactive sign-in at 20s — generous for cold NIP-46 bunker handshakes
 *  (service worker spawn + relay WS + identity probe) but still feels finite. */
const SIGN_IN_TIMEOUT_MS = 20_000;
/** Session restoration on boot is best-effort; don't block the title screen. */
const RESTORE_TIMEOUT_MS = 5_000;

export class SignInTimeoutError extends Error {
  constructor() {
    super("Signer didn't respond. Make sure your Nostr extension is unlocked, then try again.");
    this.name = 'SignInTimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(onTimeout()), ms);
    p.then(
      v => { window.clearTimeout(timer); resolve(v); },
      e => { window.clearTimeout(timer); reject(e); },
    );
  });
}

export async function signIn(): Promise<SignetSession | null> {
  if (!window.Signet) return null;
  // Use the player's chosen relay for the cross-device QR path — the SDK's
  // wss://relay.damus.io default doesn't match what publishing/scoring use,
  // so a relay-mode handshake there would be cross-traffic the game never
  // sees. Fall back to the SDK default only if zero relays are enabled.
  const active = getActiveRelays();
  const relayUrl = active[0];
  // Open the SDK's own picker — four buttons: NIP-07, Sign in with Signet
  // (same-tab redirect), Signet on another device (QR + relay), bunker URI.
  // We don't pass `mode` or `preferredMethod`, so the user picks; the
  // same-tab Signet button calls startRedirect inside the modal and
  // navigates this tab away.
  return withTimeout(
    window.Signet.login({
      appName: APP_NAME,
      theme: 'dark',
      ...(relayUrl ? { relayUrl } : {}),
    }),
    SIGN_IN_TIMEOUT_MS,
    () => new SignInTimeoutError(),
  );
}

/**
 * Consume an in-flight redirect callback if the URL has one. Call once on
 * boot, before tryRestore — a fresh redirect-mode login persists a session
 * via the standard storage layer, so the next tryRestore picks it up. The
 * tagged-union return is ignored here; consumers that want to surface
 * 'denied' / 'invalid' to the UI can call window.Signet.handleRedirectCallback
 * directly.
 */
export async function handleAuthCallback(): Promise<SignetSession | null> {
  if (!window.Signet?.handleRedirectCallback) return null;
  try {
    const result = await window.Signet.handleRedirectCallback();
    // Whether the callback resolved to a session, denied, or invalid, the
    // SDK should have torn down its dialog. Reports of "buttons don't work
    // after returning from sign-in" are consistent with a stale dialog
    // covering the title screen — belt-and-braces sweep here keeps the
    // title interactive even if the SDK leaves something behind.
    if (result.kind !== 'no-callback') sweepSignetArtefacts();
    return result.kind === 'session' ? result.session : null;
  } catch (err) {
    // The SDK already logs invalid-callback diagnostics. Sweep artefacts
    // and swallow so a stray bookmark with stale params can't strand the UI.
    console.warn('[auth] handleRedirectCallback threw:', err);
    sweepSignetArtefacts();
    return null;
  }
}

/**
 * Remove any Signet SDK dialog/callback overlays from the DOM. Called after
 * handleRedirectCallback resolves so a stale modal can't intercept clicks
 * on the title screen. Also strips the URL hash if one survived consume.
 *
 * Exported so main.ts can call it on bfcache restore: a player who hits
 * browser-back mid-redirect comes back to a frozen page that still has the
 * SDK dialog in the DOM, and the dialog captures every click underneath.
 */
export function sweepSignetArtefacts(): void {
  document.querySelectorAll('.signet-login-dialog').forEach(el => el.remove());
  document.querySelectorAll('.signet-login-callback').forEach(el => el.remove());
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export async function tryRestore(): Promise<SignetSession | null> {
  if (!window.Signet) return null;
  try {
    return await withTimeout(
      window.Signet.restoreSession(),
      RESTORE_TIMEOUT_MS,
      () => new Error('restore-timeout'),
    );
  } catch {
    // Restore is best-effort on boot — silently fall back to guest mode if
    // the signer doesn't respond in time. User can sign in manually after.
    return null;
  }
}

export async function signOut(currentSession: SignetSession | null): Promise<void> {
  if (!window.Signet) return;
  await window.Signet.logout(currentSession ?? undefined);
}
