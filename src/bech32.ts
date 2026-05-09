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
