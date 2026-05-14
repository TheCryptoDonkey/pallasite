/**
 * Mobile install + fullscreen helpers.
 *
 *   beforeinstallprompt        — captured at module load, replayed by
 *                                triggerInstall() inside a user gesture.
 *                                Android Chrome only; iOS Safari ignores
 *                                it (no programmatic install on iOS).
 *
 *   requestFullscreen          — only works inside a user gesture chain
 *                                AND on browsers that implement the API.
 *                                iOS Safari rejects: standalone PWA install
 *                                is the only way to get true fullscreen
 *                                on iOS.
 *
 * UI consumers should:
 *   - hide install/fullscreen surfaces when isStandalone() (the user
 *     already got what we'd be nagging them about);
 *   - prefer canInstallNow() over checking the event listener directly;
 *   - call tryEnterFullscreen() SYNCHRONOUSLY inside a click handler,
 *     since the browser checks for gesture freshness.
 */

/** Subset of the BeforeInstallPromptEvent we actually use. Not in
 *  lib.dom.d.ts so we declare the shape here. */
interface InstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

let deferredInstallPrompt: InstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Default behaviour shows the install mini-infobar; we'd rather
    // trigger it from our own button so the timing matches the player's
    // attention rather than the browser's heuristic.
    e.preventDefault();
    deferredInstallPrompt = e as InstallPromptEvent;
  });
  // Clear the cached prompt once the user actually installs — prevents
  // a stale prompt sitting around after the PWA is on the home screen.
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
  });
}

/** True iff the page is running as an installed PWA (standalone window). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  // iOS Safari exposes a navigator.standalone flag (not in TS lib).
  const navStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return navStandalone === true;
}

/** True iff this is iOS Safari specifically. iOS Chrome / Firefox /
 *  Edge use WKWebView under the hood and don't expose Add-to-Home-Screen
 *  the same way, so we tailor the hint copy. */
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  if (!isIos) return false;
  const isSafari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  return isSafari;
}

/** Heuristic — used to gate the install/fullscreen chip so desktop
 *  visitors don't see install nags they can't act on usefully. */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  // Touch-capable + narrow viewport. matchMedia rules out big touchscreens
  // (e.g. Surface Studio) where the install hint would be confusing.
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  return touch && narrow;
}

export function canInstallNow(): boolean {
  return deferredInstallPrompt !== null;
}

/** Replay the captured install prompt. Must be called inside a user
 *  gesture (button click). Returns true if the user accepted. */
export async function triggerInstall(): Promise<boolean> {
  const ev = deferredInstallPrompt;
  if (!ev) return false;
  await ev.prompt();
  const choice = await ev.userChoice;
  if (choice.outcome === 'accepted') {
    deferredInstallPrompt = null;
    return true;
  }
  return false;
}

/** Call from a click handler. Fire-and-forget — we don't await because
 *  awaiting can break the gesture chain on some browsers, and the
 *  promise's resolution isn't actionable for us anyway. Silently no-ops
 *  when the API is missing (iOS Safari). */
export function tryEnterFullscreen(): void {
  if (typeof document === 'undefined') return;
  const docEl = document.documentElement;
  if (!docEl.requestFullscreen) return;
  if (document.fullscreenElement) return;
  docEl.requestFullscreen().catch(() => { /* user rejected or API blocked */ });
}

/** True iff requestFullscreen is callable. Use to decide whether to
 *  show a "TAP FOR FULLSCREEN" button at all. */
export function hasFullscreenAPI(): boolean {
  if (typeof document === 'undefined') return false;
  return typeof document.documentElement.requestFullscreen === 'function';
}

const INSTALL_HINT_DISMISSED_KEY = 'pallasite:installHintDismissed';

export function isInstallHintDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try { return localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === '1'; }
  catch { return false; }
}

export function dismissInstallHint(): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, '1'); }
  catch { /* ignore */ }
}
