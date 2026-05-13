/**
 * Minimal bech32 encoder — just enough to encode an LNURL string for use in
 * NIP-57 zap request `lnurl` tags. Adapted from BIP-173.
 *
 * We only need encoding (URL → bech32 string). No decoding.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 0x1f);
  return ret;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const ret: number[] = [];
  for (let i = 0; i < 6; i++) ret.push((mod >> (5 * (5 - i))) & 0x1f);
  return ret;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

/**
 * Encode a URL as a bech32 LNURL string ("LNURL1..." form).
 *
 * @example
 *   encodeLNURL('https://coinos.io/.well-known/lnurlp/foo')
 *   // → 'LNURL1DP68GURN8GHJ7...'
 */
export function encodeLNURL(url: string): string {
  const utf8 = new TextEncoder().encode(url);
  const data = convertBits(utf8, 8, 5, true);
  const checksum = createChecksum('lnurl', data);
  const combined = data.concat(checksum);
  let result = 'lnurl1';
  for (const v of combined) result += CHARSET[v];
  return result.toUpperCase();
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod(hrpExpand(hrp).concat(data)) === 1;
}

/**
 * Encode a 32-byte secp256k1 pubkey or privkey as a NIP-19 bech32
 * string (npub1... or nsec1...). The bytes are passed as 64-char
 * lowercase hex; output is the bech32 string with the given HRP.
 *
 * Shared helper for the guest-identity disclosure surface — the
 * settings panel shows the player's npub (so they can paste it into
 * other Nostr clients) and lets them reveal/copy the nsec (so they
 * can back up the local-only identity to a real signer).
 */
function encodeBech32Pubkey(hrp: 'npub' | 'nsec', hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('expected 64-char hex');
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const data = convertBits(bytes, 8, 5, true);
  const checksum = createChecksum(hrp, data);
  let result = `${hrp}1`;
  for (const v of data.concat(checksum)) result += CHARSET[v];
  return result;
}

export function encodeNpub(pubkeyHex: string): string {
  return encodeBech32Pubkey('npub', pubkeyHex);
}

export function encodeNsec(privkeyHex: string): string {
  return encodeBech32Pubkey('nsec', privkeyHex);
}

/**
 * Decode an npub (NIP-19) into a 64-char hex pubkey. Returns null for any
 * malformed input — caller should treat null as "not a valid npub". The
 * watch page's PERSON filter uses this to accept either an npub or raw hex.
 */
export function decodeNpub(npub: string): string | null {
  const lower = npub.trim().toLowerCase();
  if (!lower.startsWith('npub1')) return null;
  if (lower.length < 8 || lower.length > 90) return null;
  const sepPos = lower.lastIndexOf('1');
  const hrp = lower.slice(0, sepPos);
  if (hrp !== 'npub') return null;
  const dataStr = lower.slice(sepPos + 1);
  const data: number[] = [];
  for (const ch of dataStr) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) return null;
    data.push(idx);
  }
  if (data.length < 6) return null;
  if (!verifyChecksum(hrp, data)) return null;
  const payload = data.slice(0, -6);
  // 5-bit groups → 8-bit bytes, no pad. NIP-19 npub payload is exactly 32 bytes.
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) return null;
  return out.map((b) => b.toString(16).padStart(2, '0')).join('');
}
