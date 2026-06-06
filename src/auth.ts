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
import { serialiseSigner } from './sign-queue.js';
import { getGuestRecord, loadOrCreateGuest } from './guest.js';

/**
 * Wrap a freshly-resolved session's signer so every signEvent goes through
 * the global serialised queue. Centralised here so every login path —
 * signIn, tryRestore, handleAuthCallback — returns a wrapped signer and
 * downstream call sites in main.ts / ui.ts don't need to remember to wrap.
 * Without this, heartbeat + replay chunk publishes + claim signs race and
 * jam the underlying NIP-46 / NIP-07 extension.
 */
function wrapSession(session: SignetSession | null): SignetSession | null {
  if (!session) return null;
  // Announce the resolved signer capability the moment a session is set, so a
  // silent auth-only fallback (login OK but can't sign — heartbeats/scores/
  // claims get skipped) is visible instead of being discovered mid-run.
  // Inspect live via window.__signetSignerInfo.
  try {
    const canSign = session.signer?.capabilities?.canSignEvents === true;
    const info = { method: session.method, canSignEvents: canSign, pubkey: session.pubkey };
    (globalThis as { __signetSignerInfo?: typeof info }).__signetSignerInfo = info;
    console.warn(
      `[auth] session ready — method=${session.method} canSignEvents=${canSign} pubkey=${session.pubkey?.slice(0, 12)}…`
      + (canSign ? '' : '  ⚠ AUTH-ONLY: this session CANNOT sign. The signer device handed back no live bunker (no bunker:// URI, or the reconnect to it failed). Signing-dependent features will be skipped until you get a live signer.'),
    );
  } catch { /* diagnostics must never break login */ }
  return { ...session, signer: serialiseSigner(session.signer) };
}

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

export type SignInMethod = 'nip07' | 'redirect' | 'bunker' | 'nsec' | 'amber';

declare global {
  interface Window {
    Signet?: {
      login: (opts: {
        appName: string;
        theme?: 'light' | 'dark' | 'auto';
        relayUrl?: string;
        mode?: 'relay' | 'redirect';
        redirectCallback?: string;
        preferredMethod?: SignInMethod;
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

/** Cap interactive sign-in at 3 min. The QR / cross-device flow (scan → approve →
 *  a hardware signer such as an ESP32 doing two physical signings) routinely runs
 *  to ~30s+ — the old 20s fired "Signer didn't respond" mid-sign even though
 *  signet-login's own 120s relay-wait and the response were perfectly fine. Keep
 *  this above the SDK's internal timeout so the SDK's real outcome wins. */
const SIGN_IN_TIMEOUT_MS = 180_000;
/** Session restoration on boot is best-effort; don't block the title screen. */
const RESTORE_TIMEOUT_MS = 5_000;
const SIGNET_VERIFY_SRC = '/signet-verify.iife.js';
const SIGNET_LOGIN_SRC = '/signet-login.iife.js';
const SIGNET_STORAGE_KEYS = {
  pubkey: 'signet:login.pubkey',
  method: 'signet:login.method',
  authEvent: 'signet:login.authEvent',
} as const;
const SIGNET_CALLBACK_PARAMS = ['error', 'pubkey', 'signature', 'eventId'] as const;

let signetLoadPromise: Promise<boolean> | null = null;

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

function signetLoginReady(): boolean {
  return typeof window !== 'undefined'
    && typeof window.Signet?.login === 'function'
    && typeof window.Signet.restoreSession === 'function'
    && typeof window.Signet.handleRedirectCallback === 'function';
}

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing?.dataset.loaded === '1') {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = id;
    script.src = src;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureSignetLoaded(): Promise<boolean> {
  if (signetLoginReady()) return true;
  if (typeof document === 'undefined') return false;
  if (!signetLoadPromise) {
    signetLoadPromise = (async () => {
      // signet-verify assigns window.Signet; signet-login merges into it.
      // Loading in the reverse order drops login methods.
      await loadScript(SIGNET_VERIFY_SRC, 'pallasite-signet-verify-sdk');
      await loadScript(SIGNET_LOGIN_SRC, 'pallasite-signet-login-sdk');
      return signetLoginReady();
    })().catch((err) => {
      console.warn('[auth] failed to load Signet SDK:', err);
      signetLoadPromise = null;
      return false;
    });
  }
  return signetLoadPromise;
}

export function hasSignetRedirectCallback(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return SIGNET_CALLBACK_PARAMS.some((key) => params.has(key));
  } catch {
    return false;
  }
}

function hasStoredSignetSession(): boolean {
  try {
    return !!(
      localStorage.getItem(SIGNET_STORAGE_KEYS.pubkey)
      && localStorage.getItem(SIGNET_STORAGE_KEYS.method)
      && localStorage.getItem(SIGNET_STORAGE_KEYS.authEvent)
    );
  } catch {
    return false;
  }
}

export async function signIn(): Promise<SignetSession | null> {
  if (!(await ensureSignetLoaded()) || !window.Signet) return null;
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
  const session = await withTimeout(
    window.Signet.login({
      appName: APP_NAME,
      theme: 'dark',
      ...(relayUrl ? { relayUrl } : {}),
    }),
    SIGN_IN_TIMEOUT_MS,
    () => new SignInTimeoutError(),
  );
  return wrapSession(session);
}

/**
 * Open the SDK login flow but skip its picker by forcing a specific
 * method. Used by the controller PWA to surface method-first buttons
 * (bunker / nsec / extension / Signet) without leading with Signet
 * branding — a BTC Prague crowd of privacy-conscious nostr users sees
 * "paste bunker URI" as the headline, not "Sign in with Signet".
 */
export async function signInWith(method: SignInMethod): Promise<SignetSession | null> {
  if (!(await ensureSignetLoaded()) || !window.Signet) return null;
  const active = getActiveRelays();
  const relayUrl = active[0];
  const session = await withTimeout(
    window.Signet.login({
      appName: APP_NAME,
      theme: 'dark',
      preferredMethod: method,
      ...(relayUrl ? { relayUrl } : {}),
    }),
    SIGN_IN_TIMEOUT_MS,
    () => new SignInTimeoutError(),
  );
  return wrapSession(session);
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
  if (!hasSignetRedirectCallback() && !window.Signet?.handleRedirectCallback) return null;
  if (!(await ensureSignetLoaded()) || !window.Signet?.handleRedirectCallback) return null;
  try {
    const result = await window.Signet.handleRedirectCallback();
    // Whether the callback resolved to a session, denied, or invalid, the
    // SDK should have torn down its dialog. Reports of "buttons don't work
    // after returning from sign-in" are consistent with a stale dialog
    // covering the title screen — belt-and-braces sweep here keeps the
    // title interactive even if the SDK leaves something behind.
    if (result.kind !== 'no-callback') sweepSignetArtefacts();
    return result.kind === 'session' ? wrapSession(result.session) : null;
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
 *
 * The SDK uses native <dialog> elements with IDs (not classes); a dialog left
 * open via showModal() sits in the top layer and is opaque to clicks even
 * when not visually evident. Closing first is belt-and-braces for browsers
 * that need explicit close before remove to release the top layer.
 */
export function sweepSignetArtefacts(): void {
  for (const id of ['signet-login-dialog', 'signet-verify-dialog']) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el instanceof HTMLDialogElement && el.open) {
      try { el.close(); } catch { /* ignore */ }
    }
    el.remove();
  }
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export async function tryRestore(): Promise<SignetSession | null> {
  // Signet-restored session wins if one exists — a returning user who
  // previously upgraded their guest identity to a real NIP-07 / bunker
  // account should land back on that real identity, not regress to the
  // shadow guest record we may have kept around from before the
  // upgrade.
  if (window.Signet || hasStoredSignetSession()) {
    try {
      if (!(await ensureSignetLoaded()) || !window.Signet) throw new Error('signet-load-failed');
      const session = await withTimeout(
        window.Signet.restoreSession(),
        RESTORE_TIMEOUT_MS,
        () => new Error('restore-timeout'),
      );
      if (session) return wrapSession(session);
    } catch {
      // Restore is best-effort on boot — silently fall through to the
      // guest path if the signer doesn't respond in time.
    }
  }
  // No Signet session — fall back to the seamless guest identity if
  // we've created one previously. First-time visitors get null and the
  // title screen prompts them for a name before creating their guest
  // keypair.
  const guest = getGuestRecord();
  if (!guest) return null;
  try {
    const session = await loadOrCreateGuest({ name: guest.name });
    return wrapSession(session);
  } catch {
    return null;
  }
}

export async function signOut(currentSession: SignetSession | null): Promise<void> {
  if ((currentSession?.method as string | undefined) === 'guest') return;
  if (!(await ensureSignetLoaded()) || !window.Signet) return;
  await window.Signet.logout(currentSession ?? undefined);
}

/**
 * Create or restore a seamless guest identity and return it as a
 * SignetSession with the standard sign-queue wrap applied. The title
 * screen uses this to provision a local keypair the first time a
 * visitor types their name and ignites — subsequent visits land in
 * tryRestore which reads the same localStorage record.
 *
 * `followPallasite` controls whether the fire-and-forget kind 3
 * contact-list publish includes the Pallasite game npub. Defaults to
 * true (pre-checked opt-out checkbox on the auth screen); pass false
 * for a guest who explicitly unticked it.
 */
export async function createGuestSession(
  name: string,
  opts: { followPallasite?: boolean } = {},
): Promise<SignetSession> {
  const session = await loadOrCreateGuest({
    name,
    followPallasite: opts.followPallasite ?? true,
  });
  const wrapped = wrapSession(session);
  if (!wrapped) throw new Error('guest-session-wrap-failed');
  return wrapped;
}
