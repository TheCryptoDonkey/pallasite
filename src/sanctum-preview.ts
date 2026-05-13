/**
 * 600bn Sanctum — static debug preview at /sanctum-preview.
 *
 * Mounts a standalone canvas, loads the council manifest + avatars,
 * and renders the Sanctum entity layout in a slow orbit. No input,
 * no gameplay, no audio — purely a visual sanity check before the
 * level is wired into the main game loop.
 *
 * Lazy-imported by main.ts when window.location.pathname is
 * '/sanctum-preview'. Skipped on every other path so the main game's
 * boot path doesn't take a hit.
 */

import {
  createSanctumState,
  tickSanctum,
  drawSanctumChrome,
  drawCouncilAsteroid,
  drawSacredStone,
  SANCTUM_WORLD_W,
  SANCTUM_WORLD_H,
  applyMemberHit,
  type SanctumState,
} from './sanctum.js';
import { loadCouncil } from './sanctum-avatars.js';

/** Tear down the main game's DOM chrome so the preview owns the screen.
 *  The main canvas + ui-root are hidden (not removed) so a manual back-
 *  navigation lands on a sane state without a reload. */
function hideMainChrome(): void {
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui-root');
  const touch = document.getElementById('touch-controls');
  if (canvas) (canvas as HTMLElement).style.display = 'none';
  if (ui) (ui as HTMLElement).style.display = 'none';
  if (touch) (touch as HTMLElement).style.display = 'none';
  document.body.style.background = 'radial-gradient(ellipse at center, #2a1408 0%, #060201 70%)';
}

/** Try to load the Sanctum WebP background (Madeira volcanic / storm
 *  light). Generated separately via `pnpm gen-backgrounds -- --sanctum`
 *  + optimise-backgrounds. Until it lands, the gradient fallback in
 *  hideMainChrome() remains. */
function applySanctumBackgroundIfPresent(): void {
  const img = new Image();
  img.onload = () => {
    document.body.style.backgroundImage = "url('/backgrounds/sanctum.webp')";
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  };
  // 404 is the expected pre-generation state — leave the gradient.
  img.onerror = () => { /* silent */ };
  img.src = '/backgrounds/sanctum.webp';
}

/** Build the preview surface — canvas + footer caption. */
function mountPreview(): HTMLCanvasElement {
  const wrap = document.createElement('div');
  wrap.id = 'sanctum-preview-root';
  wrap.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:12px', 'padding:20px',
  ].join(';');
  document.body.appendChild(wrap);

  const canvas = document.createElement('canvas');
  canvas.width = SANCTUM_WORLD_W;
  canvas.height = SANCTUM_WORLD_H;
  canvas.style.cssText = [
    'max-width:100%', 'max-height:80vh',
    'aspect-ratio:' + SANCTUM_WORLD_W + '/' + SANCTUM_WORLD_H,
    'border:1px solid rgba(255,138,58,0.35)',
    'border-radius:6px',
    'box-shadow:0 0 60px rgba(255,138,58,0.25)',
    'background:#060201',
  ].join(';');
  wrap.appendChild(canvas);

  const caption = document.createElement('div');
  caption.style.cssText = 'font:13px ui-monospace,monospace;color:rgba(255,216,74,0.85);letter-spacing:0.18em;text-align:center;';
  caption.innerHTML = 'SANCTUM PREVIEW · COUNCIL OF 600 · FUCHS2 PRAGUE · 11 JUNE<br><span style="font-size:11px;color:rgba(255,245,216,0.55);letter-spacing:0.08em;">click a council member to dry-run a hit · refresh to reset</span>';
  wrap.appendChild(caption);

  return canvas;
}

/** Bind click-to-hit so the preview can demo the hit-flash + role
 *  banner animation. Doesn't break anything (no sat plumbing), just
 *  flashes the appropriate member. */
function bindClickHit(canvas: HTMLCanvasElement, state: SanctumState): void {
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / rect.width;
    const sy = (e.clientY - rect.top) / rect.height;
    const x = sx * SANCTUM_WORLD_W;
    const y = sy * SANCTUM_WORLD_H;
    for (const m of state.council) {
      if (m.dead) continue;
      const dx = m.x - x;
      const dy = m.y - y;
      if (dx * dx + dy * dy < m.r * m.r) {
        applyMemberHit(m);
        return;
      }
    }
    // Click outside any member while stone is awake → hit the stone.
    if (state.stone.awake) {
      const dx = state.stone.x - x;
      const dy = state.stone.y - y;
      if (dx * dx + dy * dy < state.stone.r * state.stone.r) {
        // Inline stone hit since applyStoneHit needs the awake check.
        if (state.stone.hp > 0) {
          state.stone.hp -= 1;
          state.stone.hitFlash = 1;
        }
      }
    }
  });
}

export async function renderSanctumPreview(): Promise<void> {
  hideMainChrome();
  applySanctumBackgroundIfPresent();
  const canvas = mountPreview();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  await loadCouncil();
  const state = createSanctumState();
  bindClickHit(canvas, state);

  let last = performance.now();
  const loop = (now: number): void => {
    const dt = now - last;
    last = now;
    tickSanctum(state, dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSanctumChrome(ctx);
    drawSacredStone(ctx, state.stone);
    for (const m of state.council) drawCouncilAsteroid(ctx, m);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
