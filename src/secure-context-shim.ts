/**
 * Secure-context shim — lets Pallasite run over plain http on a LAN, e.g. an
 * offline booth box served at http://forgesworn.local with no internet.
 *
 * Browsers expose `crypto.randomUUID` and the whole `crypto.subtle` API only
 * in *secure contexts* (HTTPS, or http://localhost / 127.0.0.1). Served over
 * plain http to a hostname they are `undefined`, which breaks guest-identity
 * creation — `nip01EventId` sha256s the canonical event (guest.ts) and the
 * NIP-98 challenge uses `randomUUID`.
 *
 * We backfill ONLY what the app actually calls — `crypto.randomUUID` and
 * `crypto.subtle.digest('SHA-256')` — using primitives available in every
 * context: `crypto.getRandomValues` and the already-bundled @noble/hashes
 * sha256. Feature-detected, so this is a no-op under HTTPS / localhost and
 * the production deploy is untouched. Import this first in main.ts.
 */
import { sha256 } from '@noble/hashes/sha2.js';

const c = typeof crypto !== 'undefined' ? crypto : undefined;

if (c && typeof c.randomUUID !== 'function') {
  // RFC 4122 version-4 UUID, sourced from getRandomValues (insecure-context safe).
  (c as unknown as { randomUUID: () => string }).randomUUID = (): string => {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

// Outside a secure context `crypto.subtle` is entirely undefined (not just
// missing methods). The app only ever calls digest('SHA-256', …), so a
// minimal SubtleCrypto satisfying that one call is enough. Anything else was
// already broken (undefined) in this context, so providing a partial is a
// strict improvement, never a regression.
if (c && !c.subtle) {
  const subtleShim = {
    async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name.toUpperCase() !== 'SHA-256') {
        throw new Error(`secure-context shim: unsupported digest "${name}"`);
      }
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const out = sha256(view);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    },
  };
  try {
    Object.defineProperty(c, 'subtle', { value: subtleShim, configurable: true });
  } catch {
    (c as unknown as { subtle: typeof subtleShim }).subtle = subtleShim;
  }
}
