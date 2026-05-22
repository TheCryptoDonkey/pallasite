/**
 * Seamless wraparound starfield for parallax-scrolling backgrounds.
 *
 * Foundation for a future wide-arena bonus wave where the playfield
 * extends beyond the viewport and the camera scrolls horizontally. The
 * radar (see src/radar.ts getRadarLandscape) becomes useful there
 * because the player needs to know what's off-screen.
 *
 * Why a new module rather than extending render.ts's
 * buildProceduralBackground?
 *   The current procedural fallback draws planets, atmospheric rim
 *   glows, and nebula gradients — none of which tile horizontally. The
 *   wave-N webp images are even less tileable: each has a deliberate
 *   composition (gas giant on the right, nebula in the upper-left,
 *   etc.) keyed to its lore. Both layers must stay STATIC when the
 *   camera scrolls; this module is the dedicated layer that DOES
 *   scroll, drawn either underneath or on top depending on the
 *   bonus-wave director's intent.
 *
 * The 5-band asteroid parallax in src/parallax.ts is unrelated —
 * that's the gameplay-plane depth system; this is the bg starfield.
 *
 * Usage pattern (when the bonus wave lands):
 *
 *   // Once, at boot or wave start:
 *   const layer = buildSeamlessStarfield({ width: WORLD_W, height: WORLD_H, seed: wave * 31 });
 *
 *   // Every frame, inside drawBackground or its replacement:
 *   drawParallaxStarfield(ctx, layer, {
 *     viewportW: WORLD_W,
 *     parallaxX: cameraX * 0.4,  // 0.4 = distant, 0.8 = near-field
 *   });
 *
 * The layer is composed of stars at wrap-symmetric positions: every
 * star near x < edgeBlend gets a twin at x + width, and similarly near
 * the right edge. drawParallaxStarfield then draws the layer twice at
 * offset positions to cover the wraparound seam without any visible
 * tearing.
 */

interface SeamlessStarfieldOpts {
  width: number;
  height: number;
  /** Deterministic seed so the same wave always gets the same starfield. */
  seed: number;
  /** Total star count across the WHOLE layer (not per-wrap-tile). 200 reads
   *  as a sparse field; 600 as a dense one. Default 280. */
  stars?: number;
  /** Distance (px) from each edge inside which a star gets a wrap-twin.
   *  Matches the largest plausible star radius + a healthy margin so the
   *  twin is visible across the seam. Default 12. */
  edgeBlend?: number;
}

export function buildSeamlessStarfield(opts: SeamlessStarfieldOpts): HTMLCanvasElement {
  const { width, height, seed, stars = 280, edgeBlend = 12 } = opts;
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d')!;
  ctx.clearRect(0, 0, width, height);

  // Tiny seeded PRNG (same shape as render.ts's seededRand). Wave seed
  // makes the field stable across reloads; offsetting seed by a constant
  // lets multiple parallax layers share the helper without overlapping.
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };

  // Stars in three depth bands. Brightest/largest = nearest. The bands
  // are aesthetic-only; per-band parallax speed is the caller's call
  // via separate drawParallaxStarfield invocations at different offsets.
  for (let i = 0; i < stars; i++) {
    const depth = rand();
    const x = rand() * width;
    const y = rand() * height;
    let r: number, alpha: number;
    if (depth < 0.55) {
      r = 0.6 + rand() * 0.8;
      alpha = 0.25 + rand() * 0.25;
    } else if (depth < 0.88) {
      r = 0.9 + rand() * 1.6;
      alpha = 0.45 + rand() * 0.30;
    } else {
      r = 1.4 + rand() * 2.2;
      alpha = 0.7 + rand() * 0.25;
    }
    const hue = 200 + rand() * 60 - 20;
    const saturation = depth > 0.88 ? 25 + rand() * 25 : 0;
    const colour = saturation > 0
      ? `hsla(${hue}, ${saturation}%, 85%, ${alpha})`
      : `rgba(220, 224, 235, ${alpha})`;

    drawStar(ctx, x, y, r, colour);

    // Wrap-twin so the seam between two adjacent blits reads continuously.
    if (x < edgeBlend) drawStar(ctx, x + width, y, r, colour);
    else if (x > width - edgeBlend) drawStar(ctx, x - width, y, r, colour);
  }

  return off;
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

interface ParallaxBlitOpts {
  viewportW: number;
  /** Horizontal scroll offset in source-pixels. Positive scrolls the
   *  starfield left under the camera (camera moves right). Any value
   *  is valid — the helper modulo-normalises into [0, layer.width). */
  parallaxX: number;
}

/** Composite a seamless starfield layer with a horizontal parallax
 *  offset. Draws the layer at (-norm, 0) AND at (layer.width - norm, 0)
 *  so the wraparound seam is always covered no matter where the
 *  offset lands. */
export function drawParallaxStarfield(
  ctx: CanvasRenderingContext2D,
  layer: HTMLCanvasElement,
  opts: ParallaxBlitOpts,
): void {
  const { parallaxX, viewportW } = opts;
  const lw = layer.width;
  const norm = ((parallaxX % lw) + lw) % lw;
  ctx.drawImage(layer, -norm, 0);
  ctx.drawImage(layer, lw - norm, 0);
  // viewportW currently unused — kept on the opts shape so a future
  // tile-per-viewport optimisation has somewhere to live without an
  // API break.
  void viewportW;
}
