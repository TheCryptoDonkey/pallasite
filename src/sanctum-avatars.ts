/**
 * 600bn Sanctum — member avatar texture loader.
 *
 * Council roster is BAKED INTO THE BUNDLE (not async-fetched) so the
 * members are available synchronously the moment the page boots.
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
import councilManifest from './sanctum-roster.json';

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

/** Pre-bake size for council member portraits. 256×256 provides detail for
 *  the largest asteroid radius (38px * 2 = 76px) plus DPI headroom,
 *  and is fast to draw at any smaller size. */
const TEXTURE_SIZE = 256;

export type ReadonlyMember = Readonly<LoadedMember>;

/** Bundled manifest: available synchronously, shared with external tooling. */
const COUNCIL_ROSTER: CouncilMember[] = councilManifest.members.map(m => ({
  ...m, asteroidType: m.asteroidType as CouncilAsteroidType,
}));

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
        // Centre crop rather than stretching non-square faces across a relic.
        const side=Math.min(img.naturalWidth,img.naturalHeight);
        tctx.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,TEXTURE_SIZE,TEXTURE_SIZE);
        m.texture = canvas;
      }
    } catch { /* ignore — m.image fallback still works */ }
    m.ready = true;
  };
  img.onerror = () => { /* leave m.ready=false; renderer falls back */ };
  img.src = m.img;
}

/** Snapshot of the council roster. Always returns the current members
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
  kickImageLoads();
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
  // Hostname 600bn OR Mode-picker SANCTUM need the Council portraits
  // warm before wave 1's first frame. DEFENDER mode no longer uses
  // the Council (it's being rebuilt as classic Defender), so it does
  // NOT preload here.
  if (getFlavour() === '600bn') { kickImageLoads(); return; }
  try {
    const m = localStorage.getItem('pallasite:mode');
    if (m === 'sanctum') kickImageLoads();
  } catch { /* ignore */ }
}

// Eager image-load kick at module-init on 600bn — game.ts imports
// this module statically, so this fires the moment main.ts loads,
// well before the player can press IGNITE. Means portrait textures
// arrive in cache during initial page load (parallel with other
// asset fetches) instead of starting from the first frame of wave 1.
if (typeof window !== 'undefined' && (getFlavour() === '600bn' || (() => {
  try { return localStorage.getItem('pallasite:mode') === 'sanctum'; } catch { return false; }
})())) {
  kickImageLoads();
}
