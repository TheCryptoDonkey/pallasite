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

/**
 * Draw a member's avatar as a circular asteroid sprite at (x, y) with
 * radius r. The image is clipped to a circle, surrounded by an ember
 * ring (canonical 600bn palette). `angle` rotates the image while the
 * ring stays steady, so the sprite feels alive without the silhouette
 * looking off-axis.
 *
 * Fallback: if member.image is null (load failed or pending), draws a
 * dark volcanic fill with a yellow "?" glyph so the level keeps reading
 * as an asteroid even before/without textures.
 */
export function drawAvatarAsteroid(
  ctx: CanvasRenderingContext2D,
  member: ReadonlyMember,
  x: number,
  y: number,
  r: number,
  angle = 0,
): void {
  ctx.save();

  // Ember ring (always drawn, even before image loads). Soft outer glow
  // sells the volcanic / charged feel without a heavy shader pass.
  const ringWidth = Math.max(1.5, r * 0.07);
  ctx.lineWidth = ringWidth;
  ctx.strokeStyle = 'rgba(255, 138, 58, 0.85)';
  ctx.shadowColor = 'rgba(255, 138, 58, 0.5)';
  ctx.shadowBlur = r * 0.4;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (member.ready && member.image) {
    // Clip image to circle (inset by half ring-width so the stroke stays
    // visible on top of the texture).
    ctx.beginPath();
    ctx.arc(x, y, r - ringWidth * 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const d = r * 2 - ringWidth;
    ctx.drawImage(member.image, -d / 2, -d / 2, d, d);
  } else {
    // Volcanic fill + glyph fallback.
    ctx.fillStyle = 'rgba(40, 24, 12, 0.85)';
    ctx.beginPath();
    ctx.arc(x, y, r - ringWidth * 0.5, 0, Math.PI * 2);
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
