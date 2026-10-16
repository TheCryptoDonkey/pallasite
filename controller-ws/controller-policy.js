import { createHash, timingSafeEqual } from 'node:crypto';

export const OWNER_TOKEN_RE = /^[a-f0-9]{64}$/;
export const BROKER_FRAME_TYPES = new Set([
  'welcome', 'peer-up', 'peer-down', 'peer-suspended', 'host-up', 'host-down',
  'host-ready', 'error', 'controller-join', 'host-join',
]);
const phoneTypes = new Set(['signer-announce', 'signer-revoke', 'phone-context', 'sign-response']);
const hostTypes = new Set(['controller-spec', 'controller-feedback', 'sign-request', 'haptic', 'game-score', 'spectator-view']);

export function ownerDigest(token) {
  return createHash('sha256').update('joystick-host/v2\0').update(token).digest();
}
export function ownsSession(expected, token) {
  return typeof token === 'string' && OWNER_TOKEN_RE.test(token) && timingSafeEqual(expected, ownerDigest(token));
}

/** Lifecycle messages originate at the broker, never at a paired endpoint. */
export function controllerFrame(data, role, protectedSession, playerSlot) {
  let value;
  try { value = JSON.parse(data.toString()); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (BROKER_FRAME_TYPES.has(value.type) || value.type === 'controller-heartbeat') return null;
  if (protectedSession) {
    if (role === 'phone') {
      const input = value.type === undefined && typeof value.k === 'string' && value.k.length <= 64 && typeof value.v === 'string' && value.v.length <= 128;
      if (!input && !phoneTypes.has(value.type)) return null;
    } else if (!hostTypes.has(value.type)) return null;
  }
  if (role === 'phone') {
    delete value.p;
    if (playerSlot !== undefined) value.p = playerSlot;
  }
  return Buffer.from(JSON.stringify(value));
}

/** Keep replay/fan-out bytes fixed to the negotiated lockstep schema. */
export function peerFrame(value, ownedSlots) {
  const u32 = number => Number.isInteger(number) && number >= 0 && number <= 0xffffffff;
  if (value.type === 'frame-set') {
    // One frame for several slots owned by the same socket (linked booths).
    if (!u32(value.frame) || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 64) return null;
    const entries = [];
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !u32(entry[0]) || !u32(entry[1]) || !ownedSlots.includes(entry[0])) return null;
      entries.push([entry[0], entry[1]]);
    }
    return { type: 'frame-set', frame: value.frame, entries };
  }
  if (!ownedSlots.includes(value.slot)) return null;
  if (value.type === 'frames') {
    if (!u32(value.base) || !Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 255 || !value.inputs.every(u32) || value.base + value.inputs.length - 1 > 0xffffffff) return null;
    return { type: 'frames', slot: value.slot, base: value.base, inputs: [...value.inputs] };
  }
  if (!u32(value.frame)) return null;
  if (value.type === 'frame' && u32(value.input)) return { type: 'frame', slot: value.slot, frame: value.frame, input: value.input };
  if (value.type === 'hash' && u32(value.hash)) return { type: 'hash', slot: value.slot, frame: value.frame, hash: value.hash };
  return null;
}
