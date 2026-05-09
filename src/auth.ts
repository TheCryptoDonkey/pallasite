/**
 * Auth state — wraps signet-login.
 *
 * Three login paths offered, all funnelled through Signet.login(). The game
 * doesn't care which method the user picks — it just gets a SignetSession
 * back with a signer that may or may not be capable of signing further events.
 */

import type { SignetSession } from 'signet-login';

// Use the IIFE attached to window.Signet so we don't double-bundle the SDK.
// The SDK is also installed as a dependency for type safety.
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

export async function signIn(): Promise<SignetSession | null> {
  if (!window.Signet) {
    console.warn('Signet SDK not loaded');
    return null;
  }
  const session = await window.Signet.login({ appName: APP_NAME, theme: 'dark' });
  return session;
}

export async function tryRestore(): Promise<SignetSession | null> {
  if (!window.Signet) return null;
  return window.Signet.restoreSession();
}

export async function signOut(currentSession: SignetSession | null): Promise<void> {
  if (!window.Signet) return;
  await window.Signet.logout(currentSession ?? undefined);
}
