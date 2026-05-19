/**
 * Render a 1200×630 share card from a finished run and trigger the system
 * share sheet (or fall back to download on desktop).
 *
 * 1.91:1 aspect — works as both an OG meta image and an X/Bluesky/Nostr
 * timeline card. Composed in pure Canvas 2D matching the game's vector
 * aesthetic so it reads as the same product, not a marketing one-pager.
 */

import type { GameState } from './types.js';
import { BUILD_ID } from './version.js';

const CARD_W = 1200;
const CARD_H = 630;

export function renderShareCard(state: GameState): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // ── Background ─────────────────────────────────────────────────────────
  // Deep space gradient + scattered stars + a single faint pallasite glow
  // top-right so the card has a focal weight beyond the wordmark.
  const bg = ctx.createRadialGradient(CARD_W * 0.78, CARD_H * 0.32, 50, CARD_W * 0.5, CARD_H * 0.5, CARD_W * 0.9);
  bg.addColorStop(0, '#1a0c2e');
  bg.addColorStop(1, '#03020a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  const p0 = state.players[0];
  // Stars — deterministic seed by run identifier so the same run always
  // produces the same card (handy if the user re-shares).
  let seed = (p0.score ^ (state.wave << 16) ^ state.runStartedAt) >>> 0;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 90; i++) {
    const x = rand() * CARD_W;
    const y = rand() * CARD_H;
    const r = rand() * 1.4 + 0.3;
    ctx.globalAlpha = rand() * 0.6 + 0.2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Pallasite-style glow accent (top right corner)
  const accent = ctx.createRadialGradient(CARD_W * 0.85, CARD_H * 0.22, 0, CARD_W * 0.85, CARD_H * 0.22, 200);
  accent.addColorStop(0, 'rgba(255, 216, 74, 0.32)');
  accent.addColorStop(1, 'rgba(255, 216, 74, 0)');
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // ── Wordmark ───────────────────────────────────────────────────────────
  ctx.fillStyle = '#7fffb0';
  ctx.shadowColor = 'rgba(127, 255, 176, 0.55)';
  ctx.shadowBlur = 18;
  ctx.font = 'bold 80px ui-monospace, "Courier New", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('PALLASITE', 64, 64);

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.font = '22px ui-monospace, "Courier New", monospace';
  ctx.fillText('SHOOT ROCKS · STACK SATS', 68, 158);

  // ── Headline numbers ───────────────────────────────────────────────────
  const isComplete = state.wave >= 25 && state.bossDefeated;
  const headline = isComplete ? 'EVENT HORIZON CLEARED' : `WAVE ${state.wave} · ${p0.score.toLocaleString()}`;
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(255, 255, 255, 0.4)';
  ctx.shadowBlur = 14;
  ctx.font = 'bold 56px ui-monospace, "Courier New", monospace';
  ctx.fillText(headline, 64, 248);

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(220, 210, 255, 0.9)';
  ctx.font = '32px ui-monospace, "Courier New", monospace';
  const subParts: string[] = [];
  if (state.session) subParts.push(`${p0.sats.toLocaleString()} sats`);
  subParts.push(formatRunTime(state.runTimeMs));
  if (p0.runStats.largestCombo >= 2) subParts.push(`×${p0.runStats.largestCombo} combo`);
  ctx.fillText(subParts.join('  ·  '), 64, 322);

  // ── Stat strip (small mineral-type / ufo summary) ──────────────────────
  const stats = p0.runStats;
  const ufoTotal = Object.values(stats.ufoKills).reduce((a: number, b: number) => a + b, 0);
  const strip: string[] = [];
  if (ufoTotal > 0) strip.push(`${ufoTotal} UFOS`);
  if (stats.minesDestroyed > 0) strip.push(`${stats.minesDestroyed} MINES`);
  if (stats.ufoKills.boss > 0) strip.push(`${stats.ufoKills.boss} BOSS`);
  if (stats.powerupsCollected > 0) strip.push(`${stats.powerupsCollected} POWERUPS`);

  if (strip.length > 0) {
    ctx.fillStyle = 'rgba(180, 140, 255, 0.85)';
    ctx.font = '22px ui-monospace, "Courier New", monospace';
    ctx.fillText(strip.join('   ·   '), 64, 402);
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(180, 180, 200, 0.55)';
  ctx.font = '18px ui-monospace, "Courier New", monospace';
  ctx.fillText('pallasite.app', 64, CARD_H - 56);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(180, 180, 200, 0.45)';
  ctx.font = '14px ui-monospace, "Courier New", monospace';
  ctx.fillText(`v ${BUILD_ID}`, CARD_W - 64, CARD_H - 56);

  return canvas;
}

function formatRunTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildShareText(state: GameState): string {
  const t = formatRunTime(state.runTimeMs);
  const isComplete = state.wave >= 25 && state.bossDefeated;
  if (isComplete) {
    return `Pallasite — completed all 24 specimens + Event Horizon in ${t}. Shoot rocks. Stack sats.`;
  }
  return `Pallasite — wave ${state.wave}, score ${state.players[0].score.toLocaleString()}, ${t}. Shoot rocks. Stack sats.`;
}

/**
 * Trigger the system share sheet with the rendered card, falling back to a
 * download on platforms without Web Share. Resolves when the share is either
 * consumed by the OS or the fallback fires; the caller doesn't need to know
 * which path ran.
 */
export async function shareRunCard(state: GameState): Promise<void> {
  const canvas = renderShareCard(state);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
  if (!blob) return;
  const filename = `pallasite-${state.wave >= 25 ? 'complete' : `wave-${state.wave}`}-${state.players[0].score}.png`;
  const file = new File([blob], filename, { type: 'image/png' });
  const text = buildShareText(state);
  const url = 'https://pallasite.app';

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };

  // canShare with files lights up the iOS / Android system sheet path.
  if (nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share!({ files: [file], text, url });
      return;
    } catch (err) {
      // User cancellation throws — silent. Other errors fall through to
      // the desktop download path.
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }

  // Desktop / unsupported: download
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
