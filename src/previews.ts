/**
 * Inline graphic previews for the HOW TO PLAY screen.
 *
 * Each helper returns a small <canvas> rendering a recognisable mini of the
 * matching in-game entity. These are simplified (no animations, no shape
 * jitter) — the goal is "I can see at a glance which thing the description
 * is talking about", not pixel-fidelity to the gameplay render. Keeping
 * them separate from `render.ts` avoids exporting the live-render internals
 * just to feed them with synthetic entities.
 */

import type { AsteroidType, PowerUpType } from './types.js';
import { ASTEROID_TYPE_CONFIG, POWERUP_CONFIG } from './types.js';

const PREVIEW_SIZE = 38;

function makeCanvas(size = PREVIEW_SIZE): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.style.cssText = `width:${size}px;height:${size}px;display:block;`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.translate(size / 2, size / 2);
  return { canvas, ctx };
}

export function asteroidPreview(type: AsteroidType): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const cfg = ASTEROID_TYPE_CONFIG[type];
  const r = PREVIEW_SIZE * 0.38;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = `hsl(${cfg.hueBase}, 78%, 70%)`;
  ctx.shadowColor = cfg.glow;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  const verts = 12;
  for (let i = 0; i < verts; i++) {
    const ang = (i / verts) * Math.PI * 2;
    const lump = 0.82 + 0.28 * Math.sin(ang * 3 + i * 1.3);
    const x = Math.cos(ang) * r * lump;
    const y = Math.sin(ang) * r * lump;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  return canvas;
}

export function minePreview(): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const r = PREVIEW_SIZE * 0.28;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#ff5050';
  ctx.shadowColor = '#ff5050';
  ctx.shadowBlur = 6;
  // Core
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  // Spikes
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const x1 = Math.cos(ang) * r;
    const y1 = Math.sin(ang) * r;
    const x2 = Math.cos(ang) * (r + 5);
    const y2 = Math.sin(ang) * (r + 5);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  // Gravity-well halo
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.arc(0, 0, r + 8, 0, Math.PI * 2);
  ctx.stroke();
  return canvas;
}

export function sniperPreview(): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const w = PREVIEW_SIZE * 0.42;
  const h = PREVIEW_SIZE * 0.18;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#ff5050';
  ctx.shadowColor = '#ff5050';
  ctx.shadowBlur = 5;
  // Saucer body — flatter than other UFOs to read as a sniper
  ctx.beginPath();
  ctx.moveTo(-w, 0);
  ctx.lineTo(-w * 0.5, -h);
  ctx.lineTo(w * 0.5, -h);
  ctx.lineTo(w, 0);
  ctx.lineTo(w * 0.5, h);
  ctx.lineTo(-w * 0.5, h);
  ctx.closePath();
  ctx.stroke();
  // Cockpit dome
  ctx.beginPath();
  ctx.arc(0, -h * 0.3, h * 0.7, Math.PI, 0);
  ctx.stroke();
  // Targeting reticle
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, h + 4);
  ctx.stroke();
  return canvas;
}

export function powerupPreview(type: PowerUpType): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const cfg = POWERUP_CONFIG[type];
  const r = PREVIEW_SIZE * 0.32;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = cfg.colour;
  ctx.shadowColor = cfg.colour;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = cfg.colour;
  ctx.font = `bold ${Math.round(r * 1.2)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.glyph, 0, 1);
  return canvas;
}

export function dustPreview(sourceType?: AsteroidType): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const r = PREVIEW_SIZE * 0.3;
  const colour = sourceType ? ASTEROID_TYPE_CONFIG[sourceType].glow : '#7fffb0';
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 7;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.78, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.78, 0);
  ctx.closePath();
  ctx.stroke();
  // Inner facets
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.6);
  ctx.lineTo(0, r * 0.6);
  ctx.moveTo(-r * 0.5, 0);
  ctx.lineTo(r * 0.5, 0);
  ctx.stroke();
  return canvas;
}

export function satCoinPreview(): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const r = PREVIEW_SIZE * 0.32;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 7;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffd84a';
  ctx.font = `bold ${Math.round(r * 1.3)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('₿', 0, 1);
  return canvas;
}

export function shipPreview(): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas();
  const r = PREVIEW_SIZE * 0.38;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#58ff58';
  ctx.shadowColor = '#58ff58';
  ctx.shadowBlur = 6;
  // Triangle pointed up
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.7, r * 0.7);
  ctx.lineTo(0, r * 0.4);
  ctx.lineTo(-r * 0.7, r * 0.7);
  ctx.closePath();
  ctx.stroke();
  return canvas;
}
