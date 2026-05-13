/**
 * Build-version visibility.
 *
 * The user's pain: "on mobile PWA — I never seem to understand whether I've
 * got a new version or not". Three pieces fix it:
 *
 *   1. Vite injects __BUILD_ID__ and __BUILD_DATE__ at compile time. These
 *      become the bundled identity — what version this code IS.
 *   2. The build also writes /version.json with the same fields. That's the
 *      source-of-truth for what version the SERVER is offering.
 *   3. checkForUpdate() compares the two. The result drives a chip on the
 *      title screen and in settings — "v abc123 ✓ latest" or "update ready".
 *
 * The service-worker update banner already handles the *new worker waiting*
 * case. This module handles the orthogonal *am I on the latest* question
 * for cold-opens, where the banner never had a chance to fire.
 */

declare const __BUILD_ID__: string;
declare const __BUILD_DATE__: string;

export const BUILD_ID: string = __BUILD_ID__;
export const BUILD_DATE: string = __BUILD_DATE__;

export type VersionState =
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'latest'; checkedAt: number }
  | { kind: 'stale'; remote: { build: string; date: string }; checkedAt: number }
  | { kind: 'offline'; checkedAt: number };

let state: VersionState = { kind: 'unknown' };
const listeners = new Set<() => void>();
/** Active service-worker SW_VERSION reported by the running worker.
 *  Populated by querySwVersion() and shown next to BUILD_ID on the
 *  title chip so "did the new SW take?" is answered at a glance.
 *  null = haven't asked yet / no SW controlling this page. */
let swVersion: string | null = null;

export function getVersionState(): VersionState {
  return state;
}

export function getSwVersion(): string | null {
  return swVersion;
}

export function subscribeVersionState(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function setState(next: VersionState): void {
  state = next;
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore listener errors */ }
  }
}

function notifyListeners(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

/**
 * Ask the controlling service worker which SW_VERSION it's running.
 * Replies via a transferred MessageChannel so it works regardless of
 * whether the worker has access to the page's window. Safe to call
 * before the SW is controlling the page — short-circuits with a null
 * stash that re-tries on the next page interaction.
 *
 * 1-second timeout. If the worker doesn't reply that quickly, we
 * leave swVersion=null and the chip just shows BUILD_ID, which is
 * the fall-back behaviour.
 */
export function querySwVersion(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker?.controller) {
      resolve();
      return;
    }
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => {
      try { channel.port1.close(); } catch { /* ignore */ }
      resolve();
    }, 1000);
    channel.port1.onmessage = (e) => {
      window.clearTimeout(timer);
      const data = e.data as { type?: string; version?: string } | undefined;
      if (data && data.type === 'SW_VERSION' && typeof data.version === 'string') {
        swVersion = data.version;
        notifyListeners();
      }
      try { channel.port1.close(); } catch { /* ignore */ }
      resolve();
    };
    try {
      navigator.serviceWorker.controller.postMessage(
        { type: 'SW_VERSION_QUERY' },
        [channel.port2],
      );
    } catch {
      window.clearTimeout(timer);
      try { channel.port1.close(); } catch { /* ignore */ }
      resolve();
    }
  });
}

/**
 * Fetch /version.json (cache-busted) and update local state. Safe to call
 * repeatedly — concurrent calls coalesce by short-circuiting on 'checking'.
 */
let inFlight: Promise<void> | null = null;
export function checkForUpdate(): Promise<void> {
  if (inFlight) return inFlight;
  setState({ kind: 'checking' });
  inFlight = (async () => {
    try {
      const res = await fetch('/version.json?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) {
        setState({ kind: 'offline', checkedAt: Date.now() });
        return;
      }
      const data = (await res.json()) as Partial<{ build: string; date: string }>;
      if (typeof data.build !== 'string' || typeof data.date !== 'string') {
        setState({ kind: 'offline', checkedAt: Date.now() });
        return;
      }
      if (data.build === BUILD_ID) {
        setState({ kind: 'latest', checkedAt: Date.now() });
      } else {
        setState({
          kind: 'stale',
          remote: { build: data.build, date: data.date },
          checkedAt: Date.now(),
        });
      }
    } catch {
      setState({ kind: 'offline', checkedAt: Date.now() });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Friendly label for the title chip. Always shows the bundled ID first so
 *  the player can quote "I'm on abc123" regardless of network status.
 *  Includes the running SW_VERSION when known so a stale-SW suspicion
 *  ("the bundle updated but did the worker?") is settled at a glance. */
export function versionChipText(): string {
  const sw = swVersion ? ` · sw ${swVersion}` : '';
  switch (state.kind) {
    case 'latest':
      return `v ${BUILD_ID}${sw} · LATEST`;
    case 'stale':
      return `v ${BUILD_ID}${sw} · UPDATE READY`;
    case 'offline':
      return `v ${BUILD_ID}${sw} · OFFLINE`;
    case 'checking':
      return `v ${BUILD_ID}${sw} · CHECKING…`;
    case 'unknown':
    default:
      return `v ${BUILD_ID}${sw}`;
  }
}

/** Colour the chip per state — green for latest, yellow for stale, dim otherwise. */
export function versionChipColour(): string {
  switch (state.kind) {
    case 'latest':   return '#58ff58';
    case 'stale':    return '#ffd84a';
    case 'offline':  return 'rgba(180,180,180,0.55)';
    case 'checking':
    case 'unknown':
    default:         return 'rgba(180,180,180,0.55)';
  }
}
