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

/** Asteroid type a council member is themed to — each archetype maps
 *  to one of the four canonical Pallasite mineral types, giving the
 *  council wave the difficulty variety the player expects:
 *    pallasite = jackpot (1 HP, gem aura, 2x score)
 *    iron      = armoured (2 HP large → 1 HP after first hit)
 *    chondrite = fragile (1 HP, breaks into 3 fragments)
 *    stony     = baseline (1 HP, breaks into 2) */
export type CouncilAsteroidType = 'stony' | 'iron' | 'chondrite' | 'pallasite';

export interface CouncilMember {
  name: string;
  role: string;
  archetype: string;
  /** Path under public/ — e.g. /600bn/img/dni2.jpg */
  img: string;
  /** Hex pubkey (32 bytes). */
  pubkey: string;
  /** Which Pallasite asteroid mineral type this member spawns as. */
  asteroidType: CouncilAsteroidType;
}

interface LoadedMember extends CouncilMember {
  image: HTMLImageElement | null;
  /** Pre-baked off-screen canvas at TEX_SIZE×TEX_SIZE. drawImage from
   *  this canvas is significantly faster than from the full-resolution
   *  source JPEG/PNG because the browser doesn't re-scale per frame. */
  texture: HTMLCanvasElement | null;
  ready: boolean;
}

/** Pre-bake size for council member portraits. 128×128 is enough for
 *  the largest asteroid radius (38px * 2 = 76px) plus DPI headroom,
 *  and is fast to draw at any smaller size. */
const TEXTURE_SIZE = 128;

export type ReadonlyMember = Readonly<LoadedMember>;

/** Canonical 11-member council roster + portrait paths + hex pubkeys.
 *  Mirrors public/600bn/council.json — that file stays in place so
 *  external tooling can still hit it, but the runtime is driven by
 *  this inline copy so spawn-time has zero async dependency. */
const COUNCIL_ROSTER: CouncilMember[] = [
  // Pallasite (jackpot) — signal-carrying archetypes
  { name: 'dni',           role: 'CEO', archetype: 'The Signal Bearer',     asteroidType: 'pallasite', img: '/600bn/img/dni2.jpg',             pubkey: '1c94c0b44577edf41509d473a92d9f7b6bc04e3ae07f705e709c2999b1d3e074' },
  { name: 'sat',           role: 'CMO', archetype: 'The Signal Amplifier',  asteroidType: 'pallasite', img: '/600bn/img/sat2.jpg',             pubkey: '67aa1421e1d47146e4a91212a12c63752da7279202e0d6393fdfd05b2db4226f' },
  { name: 'benarc',        role: 'CVO', archetype: 'Vision Crafter',        asteroidType: 'pallasite', img: '/600bn/img/benarc.jpg',           pubkey: 'e9e4276490374a0daf7759fd5f475deff6ffb9b0fc5fa98c902b5f4b2fe3bba2' },
  { name: 'TheCryptoDonkey', role: 'CIO', archetype: 'The Pathfinder',      asteroidType: 'pallasite', img: '/600bn/img/thecryptodonkey.png',  pubkey: 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd' },
  // Iron (2 HP, armoured) — structural / machine / shadow archetypes
  { name: 'nind',          role: 'CCS', archetype: 'The Architect',         asteroidType: 'iron',      img: '/600bn/img/nind.jpg',             pubkey: 'cb33c1d6d3381b3117059cc292b5a8cc868a01ddf84f0c630318042a7b58454a' },
  { name: 'michael1011',   role: 'CTO', archetype: 'The Machine Whisperer', asteroidType: 'iron',      img: '/600bn/img/m2.png',               pubkey: '3dcc157a0304ec26ea131a0f4e576e2da67ff5c66980949c55bd7f0bb1b5efa1' },
  { name: 'arbadacarba',   role: 'CMO', archetype: 'The Strategist',        asteroidType: 'iron',      img: '/600bn/img/arbadacarba.jpg',      pubkey: '9a83779e75080556c656d4d418d02a4d7edbe288a2f9e6dd2b48799ec935184c' },
  { name: 'BlackCoffee',   role: 'CHO', archetype: 'The Shadow Operator',   asteroidType: 'iron',      img: '/600bn/img/blackcoffee600bn.jpg', pubkey: '683211bd155c7b764e4b99ba263a151d81209be7a566a2bb1971dc1bbd3b715e' },
  // Chondrite (fragile, breaks into 3) — chaos archetype
  { name: 'flx',           role: 'CWO', archetype: 'The Chaos Engineer',    asteroidType: 'chondrite', img: '/600bn/img/flx.jpg',              pubkey: '872b60fdd8ec73ce1323d9798057384fb9836500d9b7201594c71ae3fce2b680' },
  // Stony (baseline, breaks into 2) — wave-rider / connector
  { name: 'shillie',       role: 'CDO', archetype: 'The Wave Rider',        asteroidType: 'stony',     img: '/600bn/img/quillie2.jpg',         pubkey: '547d0c9e272e5b379a386812722b56661e46688e7f738191f77473aad969a354' },
  { name: 'tobo',          role: 'CDO', archetype: 'The Connector',         asteroidType: 'stony',     img: '/600bn/img/tobo.jpg',             pubkey: '1cf75683d02b4ec0aa4d2127ff45d335fe2ef5a884b5794775d608bace006a16' },
];

/** Pre-populated roster — every member present synchronously at module
 *  load. Images get filled in lazily by loadImage() as they decode. */
const cached: LoadedMember[] = COUNCIL_ROSTER.map((m) => ({ ...m, image: null, texture: null, ready: false }));
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
  img.onload = () => {
    // Pre-bake to a small canvas so per-frame drawImage during gameplay
    // doesn't re-scale a multi-hundred-KB source PNG/JPEG each frame.
    // ~10× faster on mobile in our measurements.
    try {
      const canvas = document.createElement('canvas');
      canvas.width = TEXTURE_SIZE;
      canvas.height = TEXTURE_SIZE;
      const tctx = canvas.getContext('2d');
      if (tctx) {
        tctx.drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
        m.texture = canvas;
      }
    } catch { /* ignore — m.image fallback still works */ }
    m.ready = true;
  };
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

/** Look up a member's cached portrait by name. Returns the pre-baked
 *  texture canvas (much faster to drawImage than the source JPEG/PNG)
 *  if available, falls back to the raw HTMLImageElement, finally null
 *  if the image hasn't decoded yet. */
export function getMemberImage(name: string): HTMLCanvasElement | HTMLImageElement | null {
  for (const m of cached) {
    if (m.name === name) {
      if (!m.ready) return null;
      return m.texture ?? m.image;
    }
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
  // Hostname 600bn OR Mode-picker Sanctum / Defender both need the
  // Council portraits warm before wave 1's first frame. Read the
  // stored mode (not currentMode()) so the warm-up runs at module-
  // init, before startGame's lockInMode call.
  if (getFlavour() === '600bn') { kickImageLoads(); return; }
  try {
    const m = localStorage.getItem('pallasite:mode');
    if (m === 'sanctum' || m === 'defender') kickImageLoads();
  } catch { /* ignore */ }
}

// Eager image-load kick at module-init on 600bn — game.ts imports
// this module statically, so this fires the moment main.ts loads,
// well before the player can press IGNITE. Means portrait textures
// arrive in cache during initial page load (parallel with other
// asset fetches) instead of starting from the first frame of wave 1.
if (typeof window !== 'undefined' && (getFlavour() === '600bn' || (() => {
  try { const m = localStorage.getItem('pallasite:mode'); return m === 'sanctum' || m === 'defender'; } catch { return false; }
})())) {
  kickImageLoads();
}
