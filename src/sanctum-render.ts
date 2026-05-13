/**
 * 600bn Sanctum — render path.
 *
 * Called from src/render.ts when state.phase === 'sanctum'. Self-contained
 * so we don't have to export the main game's drawShip/drawBullet/etc.,
 * keeping the surgery on render.ts to one early-return.
 *
 * Visuals:
 *   - Black canvas backdrop (the Madeira webp lives on body CSS, painted
 *     beneath the canvas via document.body.backgroundImage)
 *   - Sacred number + HUD chrome via drawSanctumChrome
 *   - Ember meteors (behind everything)
 *   - Sacred Stone (centre)
 *   - Council asteroids (member-avatars, ring)
 *   - racooDNI (cameo overlay)
 *   - Bullbear (boss overlay)
 *   - Player ship (white wire triangle, identical to main-game style)
 *   - Player bullets (warm cream dots)
 *   - Brief intro grace shield ring while ship is invulnerable
 */

import type { GameState, Ship } from './types.js';
import { renderSanctum } from './sanctum.js';

/** Apply the body-level Madeira backdrop the first time we render a
 *  Sanctum frame, then no-op. document.body painting persists across
 *  frames, so this only fires once per session. */
let bodyBackgroundApplied = false;
function applySanctumBodyBackground(): void {
  if (bodyBackgroundApplied) return;
  bodyBackgroundApplied = true;
  if (typeof document === 'undefined') return;
  // The Caddy server serves /backgrounds/sanctum.webp — if the file
  // is missing the fallback gradient still reads as a moody ember bed.
  document.body.style.backgroundImage = "url('/backgrounds/sanctum.webp')";
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundPosition = 'center';
  document.body.style.backgroundAttachment = 'fixed';
}

/** Reset the once-only flag — used by the game-over transition so a
 *  second Sanctum run within the same session re-applies the bg. */
export function clearSanctumBodyBackground(): void {
  bodyBackgroundApplied = false;
}

function drawShipTriangle(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.rot);
  ctx.translate(-ship.recoilOffset, 0);

  // Triangle body — pointed along +x because rotation rotates the world
  // around the ship's local frame, +x = forward.
  ctx.strokeStyle = '#fff5d8';
  ctx.fillStyle = 'rgba(255, 245, 216, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, -9);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Thrust flame.
  if (ship.thrusting) {
    const flicker = 0.6 + 0.4 * Math.sin(ship.thrustFrame * 1.3);
    ctx.fillStyle = `rgba(255, 138, 58, ${flicker})`;
    ctx.beginPath();
    ctx.moveTo(-6, -5);
    ctx.lineTo(-14 - 4 * flicker, 0);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
  }

  // Invulnerability shimmer.
  if (now < ship.invulnerableUntil) {
    const t = (ship.invulnerableUntil - now) / 3000;
    ctx.globalAlpha = 0.6 * Math.max(0, Math.min(1, t));
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawBullets(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();
  ctx.fillStyle = '#fff5d8';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 6;
  for (const b of state.bullets) {
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Render the complete Sanctum scene to the canvas. */
export function renderSanctumScene(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  now: number,
): void {
  applySanctumBodyBackground();
  if (!state.sanctum) return;

  // Subtle vignette over the body background so the entities pop.
  ctx.fillStyle = 'rgba(6, 2, 1, 0.35)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  renderSanctum(ctx, state.sanctum, ctx.canvas.width, ctx.canvas.height);
  drawBullets(ctx, state);
  if (state.ship.alive) drawShipTriangle(ctx, state.ship, now);
}
