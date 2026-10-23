/**
 * Closed vocabulary for host-to-phone text, shared by the broker, the SDKs and
 * the native clients (`vocabulary.json` is the single source; the broker and
 * `native/vocabulary-fixtures.json` hold byte-identical copies and
 * `scripts/check-vocabulary-sync.mjs` fails if they drift).
 *
 * The broker rebuilds every host frame from validated fields only. A string
 * survives only if it is a member of one of these tables or built from a
 * template whose parameters are bounded integers or other table entries.
 * Players are named by arcade initials: exactly three letters A to Z.
 */
import vocabularyData from './vocabulary.json';
import type { ControllerSpec, ControllerSlot, SlotConfig } from './index.js';
import { validPlacement } from './controller-profile.js';

export interface Vocabulary {
  version: 1;
  games: string[];
  labels: string[];
  icons: string[];
  phases: string[];
  feedback: string[];
  scoreLabels: string[];
  highlights: string[];
  graphics: { name: string; sha256: string }[];
}

/** The vocabulary bundled with this package. */
export const VOCABULARY: Vocabulary = vocabularyData as Vocabulary;

/** Arcade initials: exactly three capital letters. */
export const INITIALS_RE = /^[A-Z]{3}$/;
export const isInitials = (value: unknown): value is string => typeof value === 'string' && INITIALS_RE.test(value);

export const COLOUR_RE = /^(?:#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|rgba\((?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:0|1|0\.\d{1,3})\))$/;
export const SCORE_MAX = 1_000_000;
const SLOTS = ['joyL', 'joyR', 'A', 'B', 'X', 'Y', 'L1', 'L2', 'R1', 'R2', 'start', 'select', 'dpadU', 'dpadD', 'dpadL', 'dpadR'];
const FEEDBACK_SLOTS = ['A', 'B', 'X', 'Y'];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (items: string[]): string => items.map(escape).join('|');
const N = '(0|[1-9][0-9]{0,6})';
/** A template whose `{n}` is an integer 0..1000000 and `{slot}` one of A B X Y. */
function template(text: string): (value: string) => boolean {
  const pattern = new RegExp('^' + escape(text).replace(/\\\{n\\\}/g, N).replace(/\\\{slot\\\}/g, `(${FEEDBACK_SLOTS.join('|')})`) + '$');
  const counted = text.includes('{n}');
  return value => {
    const match = pattern.exec(value);
    if (!match) return false;
    return !counted || match.slice(1).every(part => !/^\d+$/.test(part) || Number(part) <= SCORE_MAX);
  };
}

/** Synchronous SHA-256 over bytes, so graphics can be checked without WebCrypto. */
export function sha256Hex(bytes: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length, padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000)); view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3), s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh] as number[];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return Array.from(h, word => word.toString(16).padStart(8, '0')).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (globalThis as { btoa: (data: string) => string }).btoa(binary);
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const binary = (globalThis as { atob?: (data: string) => string }).atob?.(text);
    if (binary === undefined) return null;
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { return null; }
}

export interface CompiledVocabulary {
  readonly vocabulary: Vocabulary;
  specName(value: unknown): boolean;
  title(value: unknown): boolean;
  rowLabel(value: unknown): boolean;
  highlight(value: unknown): boolean;
  feedback(value: unknown): boolean;
  scoreLabel(value: unknown): boolean;
  label(value: unknown): boolean;
  icon(value: unknown): boolean;
  /** True when `png` is base64 of exactly one of the allowed PNG files. */
  graphic(value: unknown): boolean;
}

/** Build the matchers once per vocabulary. */
export function compileVocabulary(vocabulary: Vocabulary = VOCABULARY): CompiledVocabulary {
  const index = '(?:[1-9]|[1-5][0-9]|6[0-4])';
  const game = alternation([...vocabulary.games].sort((a, b) => b.length - a.length));
  const player = `P${index}(?: · (?:BOT|[A-Z]{3}))?`;
  const specName = new RegExp(`^(?:${game})(?: · MENU)?(?: · P${index}| · SPECTATOR ${index})?$`);
  const title = new RegExp(`^(?:${game}) · (?:${alternation(vocabulary.phases)})$`);
  const rowLabel = new RegExp(`^(?:${index}\\. )?${player}$`);
  const highlight = new RegExp(`^${player} (?:${alternation(vocabulary.highlights)})$`);
  const feedback = vocabulary.feedback.map(template), scoreLabels = vocabulary.scoreLabels.map(template);
  const labels = new Set(vocabulary.labels), icons = new Set(vocabulary.icons), graphics = new Set(vocabulary.graphics.map(item => item.sha256));
  const string = (value: unknown): value is string => typeof value === 'string';
  return {
    vocabulary,
    specName: value => string(value) && specName.test(value),
    title: value => string(value) && title.test(value),
    rowLabel: value => string(value) && rowLabel.test(value),
    highlight: value => string(value) && highlight.test(value),
    feedback: value => string(value) && feedback.some(match => match(value)),
    scoreLabel: value => string(value) && scoreLabels.some(match => match(value)),
    label: value => string(value) && labels.has(value),
    icon: value => string(value) && icons.has(value),
    graphic: value => {
      if (typeof value !== 'string' || value.length > 12288 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
      const bytes = decodeBase64(value);
      // Only the canonical encoding passes, so stray padding bits cannot carry anything.
      return !!bytes && encodeBase64(bytes) === value && graphics.has(sha256Hex(bytes));
    },
  };
}

const DEFAULT_COMPILED = compileVocabulary();
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface CanonicalSpec {
  /** The spec exactly as the broker rebuilds it. */
  spec: ControllerSpec;
  /** One entry per field that the broker would replace or remove. */
  stripped: string[];
}

/**
 * Return the spec exactly as the broker will rebuild it, listing what was
 * replaced or removed: an off-list name becomes `GAME`, an off-list label,
 * icon, colour or graphic is removed, a bad layout is dropped. Unknown keys are
 * dropped. Returns null when the value is not a spec at all.
 */
export function canonicaliseSpec(value: unknown, compiled: CompiledVocabulary = DEFAULT_COMPILED): CanonicalSpec | null {
  if (!isObject(value) || value.version !== 1 || !isObject(value.slots)) return null;
  const stripped: string[] = [];
  const name = compiled.specName(value.name) ? value.name as string : 'GAME';
  if (name !== value.name) stripped.push('name');
  const slots: Partial<Record<ControllerSlot, SlotConfig>> = {};
  const keys = Object.keys(value.slots).filter(key => SLOTS.includes(key));
  if (keys.length !== Object.keys(value.slots).length) stripped.push('slots');
  for (const key of keys.slice(0, 16)) {
    const source = (value.slots as Record<string, unknown>)[key];
    if (!isObject(source)) { stripped.push(`slots.${key}`); continue; }
    const slot: SlotConfig = {};
    if (source.mode !== undefined) { if (source.mode === 'heading' || source.mode === 'xy' || source.mode === 'tilt') slot.mode = source.mode; else stripped.push(`slots.${key}.mode`); }
    if (source.tapAction !== undefined) { if (typeof source.tapAction === 'string' && SLOTS.includes(source.tapAction)) slot.tapAction = source.tapAction as ControllerSlot; else stripped.push(`slots.${key}.tapAction`); }
    if (source.label !== undefined) { if (compiled.label(source.label)) slot.label = source.label as string; else stripped.push(`slots.${key}.label`); }
    if (source.icon !== undefined) { if (compiled.icon(source.icon)) slot.icon = source.icon as string; else stripped.push(`slots.${key}.icon`); }
    if (source.colour !== undefined) { if (typeof source.colour === 'string' && COLOUR_RE.test(source.colour)) slot.colour = source.colour; else stripped.push(`slots.${key}.colour`); }
    if (source.graphic !== undefined) {
      if (isObject(source.graphic) && compiled.graphic(source.graphic.png)) slot.graphic = { png: source.graphic.png as string };
      else stripped.push(`slots.${key}.graphic`);
    }
    slots[key as ControllerSlot] = slot;
  }
  const spec: ControllerSpec = { version: 1, name, slots };
  if (isObject(value.theme)) {
    const theme: { background?: string; accent?: string } = {};
    for (const field of ['background', 'accent'] as const) {
      const colour = value.theme[field];
      if (colour === undefined) continue;
      if (typeof colour === 'string' && COLOUR_RE.test(colour)) theme[field] = colour; else stripped.push(`theme.${field}`);
    }
    spec.theme = theme;
  } else if (value.theme !== undefined) stripped.push('theme');
  if (value.layout !== undefined) {
    const layout = canonicaliseLayout(value.layout, Object.keys(slots));
    if (layout) spec.layout = layout; else stripped.push('layout');
  }
  return { spec, stripped };
}

/** Layout geometry carries three decimal places, plenty for a thumb and no spare precision for a side channel. */
const round3 = (number: number): number => Math.round(number * 1000) / 1000;

function canonicaliseLayout(value: unknown, keys: string[]): ControllerSpec['layout'] | null {
  if (!isObject(value) || value.version !== 1 || value.portrait === undefined && value.landscape === undefined) return null;
  const layout: NonNullable<ControllerSpec['layout']> = { version: 1 };
  for (const orientation of ['portrait', 'landscape'] as const) {
    const map = value[orientation];
    if (map === undefined) continue;
    if (!isObject(map) || Object.keys(map).length !== keys.length) return null;
    const rebuilt: Record<string, NonNullable<NonNullable<ControllerSpec['layout']>['portrait']>[ControllerSlot]> = {};
    for (const key of keys) {
      const placement = map[key];
      if (!validPlacement(placement, key.startsWith('joy'))) return null;
      const r = round3;
      rebuilt[key] = {
        x: r(placement.x), y: r(placement.y), size: r(placement.size),
        ...(placement.shape !== undefined ? { shape: placement.shape } : {}),
        ...(placement.zone !== undefined ? { zone: { x: r(placement.zone.x), y: r(placement.zone.y), width: r(placement.zone.width), height: r(placement.zone.height) } } : {}),
      };
    }
    layout[orientation] = rebuilt;
  }
  return layout;
}
