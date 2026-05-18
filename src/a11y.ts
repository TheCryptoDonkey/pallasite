/**
 * Accessibility preferences — reduced-motion + colour-blind palette.
 *
 * Two orthogonal axes:
 *
 *   reducedMotion: 'auto' | 'on' | 'off'
 *     'auto' follows the OS prefers-reduced-motion query (default).
 *     'on'/'off' override per-user. Render layer consults shouldReduceMotion()
 *     to skip screen shake, chromatic aberration, bloom pulses, parallax —
 *     anything that could trigger vestibular discomfort.
 *
 *   palette: 'default' | 'high-contrast'
 *     'high-contrast' shifts the four asteroid hues into a deuteranopia /
 *     protanopia-safer set with stronger luminance separation. Iron and
 *     pallasite (orange / yellow-green) are the pair most often confused;
 *     this mode pushes iron toward red and lowers its lightness, while
 *     pulling pallasite toward bright yellow.
 *
 *   The visual *patterns* on each asteroid type (iron inner ring, pallasite
 *   sparkle, chondrite three-way break, stony plain outline) are unchanged —
 *   they already provide non-colour discrimination. The palette swap is a
 *   reinforcer, not the only signal.
 */

import type { AsteroidType } from './types.js';

const STORAGE_KEY = 'pallasite:a11y';

export type ReducedMotionPref = 'auto' | 'on' | 'off';
export type ColourPalette = 'default' | 'high-contrast';

interface A11ySettings {
  reducedMotion: ReducedMotionPref;
  palette: ColourPalette;
}

const DEFAULTS: A11ySettings = { reducedMotion: 'auto', palette: 'default' };

let settings: A11ySettings = load();
const listeners = new Set<() => void>();

function defaultsForDevice(): A11ySettings {
  // Mobile-first default: high-contrast palette tracks better on small
  // screens where the four asteroid hues blur into each other under glare
  // and motion. Desktop keeps the default palette since the larger canvas
  // and steadier viewing conditions already separate the colours cleanly.
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return { ...DEFAULTS, palette: 'high-contrast' };
  }
  return { ...DEFAULTS };
}

function load(): A11ySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultsForDevice();
    const parsed = JSON.parse(raw) as Partial<A11ySettings>;
    const fallback = defaultsForDevice();
    return {
      reducedMotion: parsed.reducedMotion === 'on' || parsed.reducedMotion === 'off'
        ? parsed.reducedMotion : fallback.reducedMotion,
      palette: parsed.palette === 'high-contrast' || parsed.palette === 'default'
        ? parsed.palette : fallback.palette,
    };
  } catch {
    return defaultsForDevice();
  }
}

function save(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

export function subscribeA11y(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ── Reduced motion ──────────────────────────────────────────────────────────

export function getReducedMotionPref(): ReducedMotionPref {
  return settings.reducedMotion;
}

export function setReducedMotionPref(value: ReducedMotionPref): void {
  settings.reducedMotion = value;
  save();
  notify();
}

/** True when the renderer should suppress shake / aberration / bloom pulses. */
export function shouldReduceMotion(): boolean {
  if (settings.reducedMotion === 'on') return true;
  if (settings.reducedMotion === 'off') return false;
  return prefersReducedMotionOS();
}

function prefersReducedMotionOS(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ── Colour-blind palette ────────────────────────────────────────────────────

export function getPalette(): ColourPalette {
  return settings.palette;
}

export function setPalette(value: ColourPalette): void {
  settings.palette = value;
  save();
  notify();
}

interface AsteroidStyle {
  hueBase: number;
  glow: string;
}

const HIGH_CONTRAST_PALETTE: Record<AsteroidType, AsteroidStyle> = {
  // Pure blue, well clear of cyan + yellow on the wheel.
  stony:        { hueBase: 220, glow: '#7ea8ff' },
  // Saturated red — orange shifted hard. Pairs with the iron inner-ring pattern.
  iron:         { hueBase: 0,   glow: '#ff5050' },
  // Cyan with high luminance.
  chondrite:    { hueBase: 180, glow: '#7fffff' },
  // Pure bright yellow, distinct from iron-red across all common deficiencies.
  pallasite:    { hueBase: 55,  glow: '#ffe07a' },
  // White-ish for the very dark carbonaceous so the outline reads against space.
  carbonaceous: { hueBase: 0,   glow: '#e8e0f0' },
  // Magenta/pink — distinct from iron-red and pallasite-yellow.
  mesosiderite: { hueBase: 320, glow: '#ff80c0' },
  // Saturated lime — distinct from the others on the wheel.
  achondrite:   { hueBase: 90,  glow: '#a8ff60' },
  kinetic:      { hueBase: 195, glow: '#60d0ff' },
  volatile:     { hueBase: 28,  glow: '#ff8030' },
  ballast:      { hueBase: 240, glow: '#8090ff' },
  tektite:      { hueBase: 140, glow: '#80ffb0' },
  lodestone:    { hueBase: 300, glow: '#ff80e0' },
};

const DEFAULT_PALETTE: Record<AsteroidType, AsteroidStyle> = {
  stony:        { hueBase: 265, glow: '#b48cff' },
  iron:         { hueBase: 16,  glow: '#ff7a3a' },
  chondrite:    { hueBase: 195, glow: '#7fbfff' },
  pallasite:    { hueBase: 80,  glow: '#ffd84a' },
  carbonaceous: { hueBase: 280, glow: '#7a5aa0' },
  mesosiderite: { hueBase: 30,  glow: '#c0884a' },
  achondrite:   { hueBase: 0,   glow: '#d05a3a' },
  kinetic:      { hueBase: 175, glow: '#3ad6c8' },
  volatile:     { hueBase: 32,  glow: '#ff8a2a' },
  ballast:      { hueBase: 212, glow: '#6c8cb8' },
  tektite:      { hueBase: 152, glow: '#5fe0a0' },
  lodestone:    { hueBase: 304, glow: '#d060e0' },
};

/** Resolve hue + glow for an asteroid type under the active palette.
 *  Other config (HP, satMul, scoreMul, breakInto, label) come from the
 *  default ASTEROID_TYPE_CONFIG — only the visual axes are swapped. */
export function getAsteroidStyle(type: AsteroidType): AsteroidStyle {
  return settings.palette === 'high-contrast'
    ? HIGH_CONTRAST_PALETTE[type]
    : DEFAULT_PALETTE[type];
}

// ── OS-pref watcher ─────────────────────────────────────────────────────────
//
// When the user has 'auto' selected, OS-level changes to prefers-reduced-motion
// should take effect immediately without a page reload. Bind once at module
// load — the listener is process-lifetime and re-broadcasts to subscribers.

try {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fire = (): void => { if (settings.reducedMotion === 'auto') notify(); };
  if ('addEventListener' in mq) mq.addEventListener('change', fire);
  else (mq as unknown as { addListener: (fn: () => void) => void }).addListener(fire);
} catch { /* no matchMedia in some test envs */ }
