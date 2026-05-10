/**
 * Mobile haptics. Wraps navigator.vibrate with a small preset palette and a
 * single user preference. iOS Safari ignores vibrate() silently — no harm in
 * calling, just no buzz. Android + most PWA wrappers honour it.
 *
 * The preference defaults to ON so first-touch devices get the feedback
 * without a setup step. The Settings panel exposes a toggle.
 *
 * Triggered from the same impact sites that bump trauma and pulse-duck the
 * music — the three "feel" channels (visual / audio / haptic) line up so
 * a hit reads as one event across all three.
 */

const STORAGE_KEY = 'pallasite:haptics';
const DEFAULT_ENABLED = true;

let enabled: boolean = load();

function load(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_ENABLED;
    return raw === '1';
  } catch {
    return DEFAULT_ENABLED;
  }
}

function save(): void {
  try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

export function getHapticsEnabled(): boolean {
  return enabled;
}

export function setHapticsEnabled(value: boolean): void {
  enabled = value;
  save();
}

/** True when the runtime can buzz at all (regardless of user pref). */
export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && 'vibrate' in navigator;
}

export type HapticPattern =
  | 'tap'         // shield ignite, button confirm — 18ms
  | 'thump'       // large asteroid, mine destroyed — 30ms
  | 'rumble'      // ship death — three-pulse buzz
  | 'celebrate';  // wave clear, completion — five-pulse roll

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap:        18,
  thump:      30,
  rumble:     [40, 30, 60],
  celebrate:  [20, 30, 20, 30, 60],
};

export function haptic(pattern: HapticPattern): void {
  if (!enabled) return;
  if (!hapticsSupported()) return;
  try {
    navigator.vibrate(PATTERNS[pattern]);
  } catch {
    /* some embedded webviews throw — ignore */
  }
}
