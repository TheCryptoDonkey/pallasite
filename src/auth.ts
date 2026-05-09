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

import type { SignetSession } from 'signet-login';

declare global {
  interface Window {
    Signet?: {
      login: (opts: { appName: string; theme?: 'light' | 'dark' | 'auto'; relayUrl?: string }) => Promise<SignetSession | null>;
      restoreSession: () => Promise<SignetSession | null>;
      logout: (s?: SignetSession) => Promise<void>;
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
  return withTimeout(
    window.Signet.login({ appName: APP_NAME, theme: 'dark' }),
    SIGN_IN_TIMEOUT_MS,
    () => new SignInTimeoutError(),
  );
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
