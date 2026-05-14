/**
 * 600bn Sanctum — member avatar texture loader.
 *
 * Fetches `/600bn/council.json` (the canonical member manifest) on first
 * call, loads each member's avatar as an HTMLImageElement, and exposes a
 * draw helper that renders an avatar as a circular asteroid sprite with
 * a thin ember ring (per 600bn palette canon — orange/gold/ember).
 *
 * Idempotent: concurrent boot races share a single promise. Lazy-imported
 * by the Sanctum module when getFlavour() === '600bn', so the main game
 * never pays the import or fetch cost.
 *
 * Failure mode: a member whose image 404s renders as a dark fill with a
 * yellow "?" glyph. Council manifest failure logs and falls back to an
 * empty roster so the level can degrade gracefully.
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

const COUNCIL_URL = '/600bn/council.json';
let cached: LoadedMember[] | null = null;
let loadingPromise: Promise<LoadedMember[]> | null = null;

/** Fetch the council manifest + preload all member avatars.
 *  Idempotent — first call kicks off the work, subsequent calls return
 *  the same promise. */
export async function loadCouncil(): Promise<readonly ReadonlyMember[]> {
  if (cached) return cached;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const resp = await fetch(COUNCIL_URL);
      if (!resp.ok) throw new Error(`council manifest ${resp.status}`);
      const json = (await resp.json()) as { members: CouncilMember[] };
      const members: LoadedMember[] = json.members.map((m) => ({
        ...m,
        image: null,
        ready: false,
      }));
      await Promise.all(members.map((m) => loadImage(m)));
      cached = members;
      return members;
    } catch (err) {
      console.warn('[sanctum-avatars] council load failed', err);
      cached = [];
      return cached;
    }
  })();
  return loadingPromise;
}

function loadImage(m: LoadedMember): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      m.image = img;
      m.ready = true;
      resolve();
    };
    img.onerror = () => {
      // Leave m.ready = false so the draw helper renders the fallback glyph.
      resolve();
    };
    img.src = m.img;
  });
}

/** Snapshot of the currently-loaded council. Empty until loadCouncil()
 *  has resolved at least once. */
export function getCouncil(): readonly ReadonlyMember[] {
  return cached ?? [];
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
 * Boot hook — start council loading early if we're on the 600bn flavour
 * so the avatars are warm in cache by the time the player taps PLAY. Safe
 * to call unconditionally; no-ops on other flavours. */
export function maybePreloadCouncil(): void {
  if (getFlavour() === '600bn') void loadCouncil();
}
