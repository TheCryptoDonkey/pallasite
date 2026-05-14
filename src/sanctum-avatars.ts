/**
 * 600bn Sanctum — member avatar texture loader.
 *
 * Council roster is BAKED INTO THE BUNDLE (not async-fetched) so the
 * 11 members are available synchronously the moment the page boots.
 * Previously this fetched /600bn/council.json on first call, which
 * meant fast IGNITE clicks saw an empty roster and the spawn helper
 * fell back to standard asteroids. Inline manifest = always populated.
 *
 * Avatar images still load asynchronously via new Image(); the polygon
 * outline draws immediately and the texture pops in once the JPEG/PNG
 * decode finishes. A member whose image 404s renders the polygon with
 * the standard rock fill — no broken state.
 */

import { getFlavour } from './flavour.js';

export interface CouncilMember {
  name: string;
  role: string;
  archetype: string;
  /** Path under public/ — e.g. /600bn/img/dni2.jpg */
  img: string;
  /** Hex pubkey (32 bytes). */
  pubkey: string;
}

interface LoadedMember extends CouncilMember {
  image: HTMLImageElement | null;
  ready: boolean;
}

export type ReadonlyMember = Readonly<LoadedMember>;

/** Canonical 11-member council roster + portrait paths + hex pubkeys.
 *  Mirrors public/600bn/council.json — that file stays in place so
 *  external tooling can still hit it, but the runtime is driven by
 *  this inline copy so spawn-time has zero async dependency. */
const COUNCIL_ROSTER: CouncilMember[] = [
  { name: 'dni',           role: 'CEO', archetype: 'The Signal Bearer',     img: '/600bn/img/dni2.jpg',             pubkey: '1c94c0b44577edf41509d473a92d9f7b6bc04e3ae07f705e709c2999b1d3e074' },
  { name: 'nind',          role: 'CCS', archetype: 'The Architect',         img: '/600bn/img/nind.jpg',             pubkey: 'cb33c1d6d3381b3117059cc292b5a8cc868a01ddf84f0c630318042a7b58454a' },
  { name: 'michael1011',   role: 'CTO', archetype: 'The Machine Whisperer', img: '/600bn/img/m2.png',               pubkey: '3dcc157a0304ec26ea131a0f4e576e2da67ff5c66980949c55bd7f0bb1b5efa1' },
  { name: 'sat',           role: 'CMO', archetype: 'The Signal Amplifier',  img: '/600bn/img/sat2.jpg',             pubkey: '67aa1421e1d47146e4a91212a12c63752da7279202e0d6393fdfd05b2db4226f' },
  { name: 'flx',           role: 'CWO', archetype: 'The Chaos Engineer',    img: '/600bn/img/flx.jpg',              pubkey: '872b60fdd8ec73ce1323d9798057384fb9836500d9b7201594c71ae3fce2b680' },
  { name: 'shillie',       role: 'CDO', archetype: 'The Wave Rider',        img: '/600bn/img/quillie2.jpg',         pubkey: '547d0c9e272e5b379a386812722b56661e46688e7f738191f77473aad969a354' },
  { name: 'arbadacarba',   role: 'CMO', archetype: 'The Strategist',        img: '/600bn/img/arbadacarba.jpg',      pubkey: '9a83779e75080556c656d4d418d02a4d7edbe288a2f9e6dd2b48799ec935184c' },
  { name: 'benarc',        role: 'CVO', archetype: 'Vision Crafter',        img: '/600bn/img/benarc.jpg',           pubkey: 'e9e4276490374a0daf7759fd5f475deff6ffb9b0fc5fa98c902b5f4b2fe3bba2' },
  { name: 'tobo',          role: 'CDO', archetype: 'The Connector',         img: '/600bn/img/tobo.jpg',             pubkey: '1cf75683d02b4ec0aa4d2127ff45d335fe2ef5a884b5794775d608bace006a16' },
  { name: 'BlackCoffee',   role: 'CHO', archetype: 'The Shadow Operator',   img: '/600bn/img/blackcoffee600bn.jpg', pubkey: '683211bd155c7b764e4b99ba263a151d81209be7a566a2bb1971dc1bbd3b715e' },
  { name: 'TheCryptoDonkey', role: 'CIO', archetype: 'The Pathfinder',      img: '/600bn/img/thecryptodonkey.png',  pubkey: 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd' },
];

/** Pre-populated roster — every member present synchronously at module
 *  load. Images get filled in lazily by loadImage() as they decode. */
const cached: LoadedMember[] = COUNCIL_ROSTER.map((m) => ({ ...m, image: null, ready: false }));
let imagesKicked = false;

/** Kick off image loads for every member (idempotent). Called from
 *  loadCouncil + maybePreloadCouncil so portraits arrive in cache by
 *  the time wave 1's first frame draws. Spawn-time doesn't wait —
 *  the polygon still draws with the canonical rock fill until the
 *  image lands. */
function kickImageLoads(): void {
  if (imagesKicked) return;
  imagesKicked = true;
  for (const m of cached) loadImage(m);
}

/** Compatibility shim — older callers awaited the promise. Now it
 *  resolves with the always-populated roster after kicking off image
 *  decoding. Useful when the caller wants to wait for textures (e.g.
 *  the static preview surface), but most call sites use getCouncil()
 *  directly. */
export async function loadCouncil(): Promise<readonly ReadonlyMember[]> {
  kickImageLoads();
  await Promise.all(cached.map((m) => new Promise<void>((resolve) => {
    if (m.ready) { resolve(); return; }
    const img = m.image;
    if (img) {
      if (img.complete) { resolve(); return; }
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      return;
    }
    resolve();
  })));
  return cached;
}

function loadImage(m: LoadedMember): void {
  if (m.image) return;
  const img = new Image();
  m.image = img;
  img.onload = () => { m.ready = true; };
  img.onerror = () => { /* leave m.ready=false; renderer falls back */ };
  img.src = m.img;
}

/** Snapshot of the council roster. Always returns the 11 members
 *  synchronously — images may not be loaded yet, in which case
 *  getMemberImage returns null and the renderer draws the polygon
 *  with the standard rock fill. */
export function getCouncil(): readonly ReadonlyMember[] {
  return cached;
}

/** Look up a member's cached HTMLImageElement by name. Returns null
 *  until the image has finished decoding; render.ts falls back to
 *  the polygon rock fill in the meantime. */
export function getMemberImage(name: string): HTMLImageElement | null {
  for (const m of cached) {
    if (m.name === name) return m.ready ? m.image : null;
  }
  return null;
}

/** Per-asteroid lumpy outline — deterministic per `seed` so the same
 *  member keeps the same silhouette across frames. Returns 12 points
 *  in [angle, radius-multiplier] pairs, packed flat. */
function makeAsteroidShape(seed: number): number[] {
  const points = 12;
  const out: number[] = [];
  // Simple LCG so the shape is deterministic per ringSlot but varied
  // across the council. Math.random would make every frame redraw a
  // new silhouette which reads wrong on a static asteroid.
  let s = (seed * 9301 + 49297) & 0x7fffffff;
  const next = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s & 0xffff) / 0xffff;
  };
  for (let i = 0; i < points; i++) {
    out.push(0.78 + next() * 0.32);
  }
  return out;
}

/** Cache shapes by seed so we don't re-rng them every frame. */
const SHAPE_CACHE = new Map<number, number[]>();
function shapeFor(seed: number): number[] {
  let s = SHAPE_CACHE.get(seed);
  if (!s) {
    s = makeAsteroidShape(seed);
    SHAPE_CACHE.set(seed, s);
  }
  return s;
}

/** Trace a closed lumpy polygon at (x, y) with base radius r, rotated
 *  by `angle`, using `shape` as per-vertex radius multipliers. */
function tracePolygon(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  angle: number,
  shape: number[],
): void {
  const n = shape.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = angle + (i / n) * Math.PI * 2;
    const rr = r * shape[i];
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Draw a member's avatar as a council asteroid at (x, y) with base
 * radius r. The silhouette is a 12-point lumpy polygon (canonical
 * Pallasite asteroid shape, deterministic per member); the avatar
 * image is clipped to that polygon so each "asteroid" is a rocky
 * council portrait. An ember ring outlines the silhouette.
 *
 * Fallback: if member.image is null (load failed or pending), draws a
 * dark volcanic fill inside the polygon so the silhouette still reads
 * as an asteroid even before textures land.
 */
export function drawAvatarAsteroid(
  ctx: CanvasRenderingContext2D,
  member: ReadonlyMember,
  x: number,
  y: number,
  r: number,
  angle = 0,
): void {
  // Stable shape per member via name hash (cheap, deterministic).
  let nameSeed = 0;
  for (let i = 0; i < member.name.length; i++) nameSeed = (nameSeed * 31 + member.name.charCodeAt(i)) | 0;
  const shape = shapeFor(nameSeed);
  const lineWidth = Math.max(1.5, r * 0.07);

  // Outer ember glow + outline trace.
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = 'rgba(255, 138, 58, 0.85)';
  ctx.shadowColor = 'rgba(255, 138, 58, 0.55)';
  ctx.shadowBlur = r * 0.45;
  tracePolygon(ctx, x, y, r, angle, shape);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.restore();

  // Texture / fallback inside the polygon (separate save so the clip
  // path doesn't leak to the outline pass).
  ctx.save();
  tracePolygon(ctx, x, y, r - lineWidth * 0.5, angle, shape);
  ctx.clip();
  if (member.ready && member.image) {
    // Centre the image within the silhouette's bounding box, scaled to
    // fit the asteroid's max diameter. Rotation goes around the centre
    // so the texture aligns with the polygon's spin.
    ctx.translate(x, y);
    ctx.rotate(angle);
    const d = r * 2.05;  // slight oversize so corners reach the lumpy peaks
    ctx.drawImage(member.image, -d / 2, -d / 2, d, d);
  } else {
    ctx.fillStyle = 'rgba(40, 24, 12, 0.85)';
    tracePolygon(ctx, x, y, r, angle, shape);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 216, 74, 0.9)';
    ctx.font = `bold ${Math.floor(r * 1.2)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', x, y);
  }
  ctx.restore();
}

/**
 * Boot hook — start image loads early if we're on the 600bn flavour
 * so portraits are warm by the time wave 1 draws. No-op on other
 * flavours. The roster itself is already populated synchronously at
 * module load. */
export function maybePreloadCouncil(): void {
  if (getFlavour() === '600bn') kickImageLoads();
}
