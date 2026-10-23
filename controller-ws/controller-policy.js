import { createHash, timingSafeEqual } from 'node:crypto';
import { COLOUR_RE, INITIALS_RE, SCORE_MAX, SLOTS, canonicaliseSpec } from './vocabulary.js';
export { compileVocabulary, loadVocabulary } from './vocabulary.js';

export const OWNER_TOKEN_RE = /^[a-f0-9]{64}$/;
/** Lifecycle messages originate at the broker, never at a paired endpoint. */
export const BROKER_FRAME_TYPES = new Set([
  'welcome', 'peer-up', 'peer-down', 'peer-suspended', 'host-up', 'host-down',
  'host-ready', 'error', 'controller-join', 'host-join',
]);
export function ownerDigest(token) {
  return createHash('sha256').update('joystick-host/v2\0').update(token).digest();
}
export function ownsSession(expected, token) {
  return typeof token === 'string' && OWNER_TOKEN_RE.test(token) && timingSafeEqual(expected, ownerDigest(token));
}

/** A phone's text frame never legitimately exceeds a few hundred bytes. */
export const PHONE_FRAME_BYTES = 4096;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

const STICKS = new Set(['joyL', 'joyR']);
const BUTTONS = new Set(SLOTS.filter(slot => !STICKS.has(slot)));
const INPUT_VALUE_RE = /^-?\d{1,4}$/;
/** Inclusive range of each accepted input value, by suffix. `''` is the stick heading. */
const STICK_RANGES = Object.freeze({ '': [-6284, 6284], '-x': [-1000, 1000], '-y': [-1000, 1000], '-power': [0, 1000], '-thrust': [0, 1], '-end': [1, 1], '-tap': [1, 1] });

/**
 * Rebuild a phone frame from validated fields, or return null.
 *
 *   input          { k, v }   k is a slot (or stick slot plus one suffix), v a bounded integer string
 *   phone-context  { type, tournamentTotal (capped at the score ceiling), name? }   name is three capital letters (arcade initials)
 *
 * `p` is never taken from the phone: the broker stamps `playerSlot` in multi mode.
 * Nothing else is forwarded: no other type, no extra fields, no free text.
 */
export function phoneFrame(value, playerSlot) {
  if (!isObject(value)) return null;
  let out;
  if (value.type === undefined) {
    if (typeof value.k !== 'string' || typeof value.v !== 'string' || value.k.length > 16 || !INPUT_VALUE_RE.test(value.v)) return null;
    const dash = value.k.indexOf('-');
    const slot = dash < 0 ? value.k : value.k.slice(0, dash), suffix = dash < 0 ? '' : value.k.slice(dash);
    let range;
    if (STICKS.has(slot)) range = STICK_RANGES[suffix];
    else if (suffix === '' && BUTTONS.has(slot)) range = [0, 1];
    if (!Object.hasOwn(STICK_RANGES, suffix) || !range) return null;
    const number = Number(value.v);
    if (number < range[0] || number > range[1]) return null;
    out = { k: value.k, v: String(number) };
  } else if (value.type === 'phone-context') {
    if (!integer(value.tournamentTotal, 0, Number.MAX_SAFE_INTEGER)) return null;
    // A running total is a score, so it has the score ceiling: a phone cannot choose a larger number to show strangers.
    out = { type: 'phone-context', tournamentTotal: Math.min(value.tournamentTotal, SCORE_MAX) };
    if (typeof value.name === 'string' && INITIALS_RE.test(value.name)) out.name = value.name;
  } else return null;
  if (playerSlot !== undefined) out.p = playerSlot;
  return out;
}

const TONES = new Set(['neutral', 'success', 'error']);
const HAPTIC_PRESETS = new Set(['tap', 'pulse', 'thud', 'win', 'fail']);

/**
 * A host may name a player's initials only when that player's phone sent exactly
 * those letters in this session (`initialsOf(slot)` is what the broker validated
 * from the phone's phone-context). Any other three letters, apart from the host's
 * own `BOT` marker, are dropped, so a scripted host cannot compose text from
 * leaderboard rows. Without `initialsOf` nothing is checked (unit tests only).
 */
export function scrubInitials(text, initialsOf) {
  if (typeof text !== 'string' || typeof initialsOf !== 'function') return text;
  return text.replace(/P(\d{1,2}) · ([A-Z]{3})(?![A-Z])/g, (all, number, letters) => letters === 'BOT' || initialsOf(Number(number) - 1) === letters ? all : `P${number}`);
}

function spectatorRows(value, compiled, initialsOf) {
  if (!Array.isArray(value)) return [];
  const rows = [];
  for (const row of value.slice(0, 8)) {
    if (!isObject(row) || !integer(row.p, 0, 63) || !integer(row.score, -SCORE_MAX, SCORE_MAX)) continue;
    const out = {
      p: row.p,
      label: compiled.rowLabel(row.label) ? scrubInitials(row.label, initialsOf) : `P${row.p + 1}`,
      score: row.score,
    };
    if (row.tournamentTotal !== undefined && integer(row.tournamentTotal, 0, Number.MAX_SAFE_INTEGER)) out.tournamentTotal = Math.min(row.tournamentTotal, SCORE_MAX);
    out.colour = typeof row.colour === 'string' && COLOUR_RE.test(row.colour) ? row.colour : '#ffffff';
    rows.push(out);
  }
  return rows;
}

/**
 * Rebuild a host frame from validated fields, or return null.
 *
 *   controller-spec      { type, spec }   spec rebuilt by canonicaliseSpec (closed lists)
 *   controller-feedback  { type, message, selected?, locked?, tone? }
 *   haptic               { type, pattern }
 *   game-score           { type, score, label? }
 *   spectator-view       { type, title, leaderboard, highlight? }   initials in rows and highlight only as the phone sent them
 *
 * `p` routes to one phone in multi mode (an integer below `maxPhones`, anything
 * else drops the frame so it is never broadcast by accident) and is removed in
 * single mode. `sign-request` and every other type are dropped.
 */
export function hostFrame(value, multi, maxPhones, compiled, initialsOf) {
  if (!isObject(value) || typeof value.type !== 'string') return null;
  let out;
  switch (value.type) {
    case 'controller-spec': {
      const canonical = canonicaliseSpec(value.spec, compiled);
      if (!canonical) return null;
      out = { type: value.type, spec: canonical.spec };
      break;
    }
    case 'controller-feedback':
      out = { type: value.type, message: compiled.feedback(value.message) ? value.message : '' };
      if (value.selected === null || typeof value.selected === 'string' && SLOTS.includes(value.selected)) out.selected = value.selected;
      if (typeof value.locked === 'boolean') out.locked = value.locked;
      if (typeof value.tone === 'string' && TONES.has(value.tone)) out.tone = value.tone;
      break;
    case 'haptic':
      if (typeof value.pattern === 'string' && HAPTIC_PRESETS.has(value.pattern)) out = { type: value.type, pattern: value.pattern };
      else if (Array.isArray(value.pattern) && value.pattern.length >= 1 && value.pattern.length <= 16 && value.pattern.every(item => integer(item, 0, 5000))) out = { type: value.type, pattern: [...value.pattern] };
      else return null;
      break;
    case 'game-score':
      if (!integer(value.score, 0, SCORE_MAX)) return null;
      out = { type: value.type, score: value.score };
      if (compiled.scoreLabel(value.label)) out.label = value.label;
      break;
    case 'spectator-view':
      out = {
        type: value.type,
        title: compiled.title(value.title) ? value.title : 'SPECTATOR',
        leaderboard: spectatorRows(value.leaderboard, compiled, initialsOf),
      };
      if (compiled.highlight(value.highlight)) out.highlight = scrubInitials(value.highlight, initialsOf);
      break;
    default:
      return null;
  }
  if (value.p !== undefined && multi) {
    if (!integer(value.p, 0, maxPhones - 1)) return null;
    out.p = value.p;
  }
  return out;
}

/**
 * Lockstep peers may only exchange game inputs. Every value a peer sends is an
 * unsigned integer inside one of these bounds, so a relayed message cannot
 * carry text, names, images or free-form JSON. Keep `input` and `frame` in step
 * with the game's `encodePlayerInput` (a 24-bit packed value, 18 bits used) and
 * its sim frame counter (2^24 frames is about 77 hours at 60 Hz).
 */
export const PEER_LIMITS = Object.freeze({
  input: 0xffffff,
  frame: 0xffffff,
  hash: 0xffffffff, // 32-bit FNV-1a state canary
  framesPerMessage: 32, // the client batches at most 8, load tools at most 16
  entriesPerFrameSet: 64, // one entry per slot, MAX_PEER_PLAYERS
});

/** The only peer message types that are ever forwarded. */
export const PEER_FORWARD_TYPES = new Set(['frame', 'frame-set', 'frames', 'hash']);

/**
 * Rebuild a peer message from validated fields only, or return null.
 *
 *   frame      { type, slot, frame, input }
 *   frame-set  { type, frame, entries: [[slot, input], ...] }
 *   frames     { type, slot, base, inputs: [input, ...] }
 *   hash       { type, slot, frame, hash }
 *
 * Every slot must be owned by the sending socket. Unknown fields are dropped
 * rather than copied, and the result is what gets forwarded and replayed.
 */
export function peerFrame(value, ownedSlots, limits = PEER_LIMITS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const uint = (number, max) => Number.isInteger(number) && number >= 0 && number <= max;
  const frame = number => uint(number, limits.frame), input = number => uint(number, limits.input);
  if (value.type === 'frame-set') {
    // One frame for several slots owned by the same socket (linked booths).
    if (!frame(value.frame) || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > limits.entriesPerFrameSet) return null;
    const entries = [];
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !input(entry[1]) || !ownedSlots.includes(entry[0])) return null;
      entries.push([entry[0], entry[1]]);
    }
    return { type: 'frame-set', frame: value.frame, entries };
  }
  if (!ownedSlots.includes(value.slot)) return null;
  if (value.type === 'frames') {
    if (!frame(value.base) || !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > limits.framesPerMessage || !value.inputs.every(input) || value.base + value.inputs.length - 1 > limits.frame) return null;
    return { type: 'frames', slot: value.slot, base: value.base, inputs: [...value.inputs] };
  }
  if (!frame(value.frame)) return null;
  if (value.type === 'frame' && input(value.input)) return { type: 'frame', slot: value.slot, frame: value.frame, input: value.input };
  if (value.type === 'hash' && uint(value.hash, limits.hash)) return { type: 'hash', slot: value.slot, frame: value.frame, hash: value.hash };
  return null;
}

/**
 * Which Origin may open a host (game screen) socket. `CONTROLLER_HOST_ORIGINS`
 * is a comma-separated list of exact origins. Unset or empty allows any origin,
 * which is what a self-hoster running their own relay wants. When it is set, a
 * missing Origin is refused, and `CONTROLLER_ALLOW_LOOPBACK=1` additionally
 * admits http://127.0.0.1:* and http://localhost:* for local development.
 *
 * Browsers always send Origin on a WebSocket upgrade and a page cannot forge
 * it, so this stops other websites from driving a phone's screen through this
 * relay. A script that is not a browser can send any header, so this is a
 * boundary between sites, not authentication.
 */
export function hostOriginPolicy(env = process.env) {
  const list = (env.CONTROLLER_HOST_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  const allowed = new Set();
  for (const item of list) {
    let url;
    try { url = new URL(item); } catch { throw Error(`Invalid CONTROLLER_HOST_ORIGINS entry: ${item}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== item) throw Error(`Invalid CONTROLLER_HOST_ORIGINS entry: ${item}`);
    allowed.add(item);
  }
  if (!allowed.size) return Object.assign(() => true, { restricted: false });
  const loopback = env.CONTROLLER_ALLOW_LOOPBACK === '1';
  return Object.assign(origin => typeof origin === 'string'
    && (allowed.has(origin) || loopback && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)), { restricted: true });
}
