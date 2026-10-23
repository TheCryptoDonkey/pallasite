import type { ControllerSpec, ControllerSlot } from './index.js';

export interface InlineGraphic { png: string }
export interface ControlZone { x: number; y: number; width: number; height: number }
export interface ControlPlacement {
  /** Centre in the usable controller surface, from zero to one. */
  x: number; y: number;
  /** Diameter/side in CSS pixels, points or dp, bounded by the client. */
  size: number;
  shape?: 'circle' | 'rounded';
  /** Floating-stick capture area; buttons always have hit priority. */
  zone?: ControlZone;
}
export interface ControllerLayout {
  version: 1;
  portrait?: Partial<Record<ControllerSlot, ControlPlacement>>;
  landscape?: Partial<Record<ControllerSlot, ControlPlacement>>;
}
export interface ControllerTheme { background?: string; accent?: string }
export interface ResolvedPlacement {
  x: number; y: number; size: number; shape: 'circle' | 'rounded'; zone: ControlZone;
}
const slots = new Set(['joyL', 'joyR', 'A', 'B', 'X', 'Y', 'L1', 'L2', 'R1', 'R2', 'start', 'select', 'dpadU', 'dpadD', 'dpadL', 'dpadR']);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bounded = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const colour = (v: unknown) => v === undefined || typeof v === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(v);

/** Inline PNGs cannot fetch tracking URLs, execute code or allocate large images. */
export function validGraphic(value: unknown): value is InlineGraphic {
  if (!object(value) || typeof value.png !== 'string' || value.png.length > 12288 || !/^[a-z0-9+/]+={0,2}$/i.test(value.png) || value.png.length % 4 !== 0) return false;
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const bytes: number[] = [];
    for (let i = 0; i < 32; i += 4) {
      const bits = (alphabet.indexOf(value.png[i]!) << 18) | (alphabet.indexOf(value.png[i+1]!) << 12) | (alphabet.indexOf(value.png[i+2]!) << 6) | alphabet.indexOf(value.png[i+3]!);
      bytes.push((bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255);
    }
    const header = String.fromCharCode(...bytes);
    if (header.length < 24 || ![137,80,78,71,13,10,26,10].every((b, i) => header.charCodeAt(i) === b) || header.slice(12,16) !== 'IHDR') return false;
    const word = (i: number) => ((header.charCodeAt(i) * 0x1000000) + (header.charCodeAt(i+1) << 16) + (header.charCodeAt(i+2) << 8) + header.charCodeAt(i+3));
    return bounded(word(16), 1, 256) && bounded(word(20), 1, 256);
  } catch { return false; }
}
export function validPlacement(value: unknown, stick: boolean): value is ControlPlacement {
  if (!object(value) || !bounded(value.x, 0, 1) || !bounded(value.y, 0, 1) || !bounded(value.size, stick ? 96 : 48, 192)
    || value.shape !== undefined && (typeof value.shape !== 'string' || !['circle', 'rounded'].includes(value.shape))) return false;
  if (value.zone !== undefined) {
    const z = value.zone;
    if (!stick || !object(z) || !bounded(z.x, 0, 1) || !bounded(z.y, 0, 1) || !bounded(z.width, .1, 1) || !bounded(z.height, .1, 1)
      || z.x + z.width > 1.000001 || z.y + z.height > 1.000001 || value.x < z.x || value.x > z.x + z.width || value.y < z.y || value.y > z.y + z.height) return false;
  }
  return true;
}
export function isControllerSpec(value: unknown): value is ControllerSpec {
  if (!object(value) || value.version !== 1 || typeof value.name !== 'string' || value.name.length > 128 || !object(value.slots)) return false;
  try {
    const json = JSON.stringify(value);
    let bytes = 0;
    for (const character of json) { const code = character.codePointAt(0)!; bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4; }
    if (bytes > 49152) return false;
  } catch { return false; }
  const keys = Object.keys(value.slots);
  if (keys.length > 16) return false;
  let artwork = 0;
  for (const key of keys) {
    const slot = value.slots[key];
    if (!slots.has(key) || !object(slot) || slot.mode !== undefined && (typeof slot.mode !== 'string' || !['heading', 'xy', 'tilt'].includes(slot.mode))
      || !colour(slot.colour) || slot.label !== undefined && (typeof slot.label !== 'string' || slot.label.length > 48)
      || slot.icon !== undefined && (typeof slot.icon !== 'string' || slot.icon.length > 64)
      || slot.tapAction !== undefined && (typeof slot.tapAction !== 'string' || !slots.has(slot.tapAction))) return false;
    if (slot.graphic !== undefined) { if (!validGraphic(slot.graphic)) return false; artwork += slot.graphic.png.length; }
  }
  if (artwork > 32768) return false;
  if (value.theme !== undefined && (!object(value.theme) || !colour(value.theme.background) || !colour(value.theme.accent))) return false;
  if (value.layout !== undefined) {
    const l = value.layout;
    if (!object(l) || l.version !== 1 || l.portrait === undefined && l.landscape === undefined) return false;
    for (const orientation of ['portrait', 'landscape']) {
      const map = l[orientation]; if (map === undefined) continue;
      if (!object(map) || Object.keys(map).length !== keys.length || keys.some(key => !validPlacement(map[key], key.startsWith('joy')))) return false;
    }
  }
  return true;
}
export function resolvePlacement(placement: ControlPlacement, width: number, height: number): ResolvedPlacement {
  const size = Math.max(0, Math.min(placement.size, width - 8, height - 8));
  const x = Math.max(size / 2 + 4, Math.min(width - size / 2 - 4, placement.x * width));
  const y = Math.max(size / 2 + 4, Math.min(height - size / 2 - 4, placement.y * height));
  const z = placement.zone;
  return { x, y, size, shape: placement.shape ?? 'circle', zone: z ? { x: z.x * width, y: z.y * height, width: z.width * width, height: z.height * height } : { x: x-size/2, y: y-size/2, width: size, height: size } };
}

/** A layout that collides after clamping must use the client's default layout. */
export function resolveControllerLayout(spec: ControllerSpec, width: number, height: number): Record<string, ResolvedPlacement> | null {
  if (width < 200 || height < 160) return null;
  const map = width > height ? spec.layout?.landscape : spec.layout?.portrait;
  if (!map) return null;
  const result: Record<string, ResolvedPlacement> = {};
  for (const key of Object.keys(spec.slots)) result[key] = resolvePlacement(map[key as ControllerSlot]!, width, height);
  const entries = Object.entries(result);
  const overlap = (a: ControlZone, b: ControlZone) => Math.min(a.x+a.width,b.x+b.width) - Math.max(a.x,b.x) > .01 && Math.min(a.y+a.height,b.y+b.height) - Math.max(a.y,b.y) > .01;
  for (const [key,p] of entries) {
    if (key.startsWith('joy') && (p.x < p.zone.x || p.x > p.zone.x+p.zone.width || p.y < p.zone.y || p.y > p.zone.y+p.zone.height)) return null;
  }
  for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
    const [a,ap] = entries[i]!, [b,bp] = entries[j]!;
    if (a.startsWith('joy') === b.startsWith('joy') && overlap(ap.zone,bp.zone)) return null;
  }
  return result;
}
