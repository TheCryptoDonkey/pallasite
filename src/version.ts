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

export function getVersionState(): VersionState {
  return state;
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
 *  the player can quote "I'm on abc123" regardless of network status. */
export function versionChipText(): string {
  switch (state.kind) {
    case 'latest':
      return `v ${BUILD_ID} · LATEST`;
    case 'stale':
      return `v ${BUILD_ID} · UPDATE READY`;
    case 'offline':
      return `v ${BUILD_ID} · OFFLINE`;
    case 'checking':
      return `v ${BUILD_ID} · CHECKING…`;
    case 'unknown':
    default:
      return `v ${BUILD_ID}`;
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
