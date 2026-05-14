/**
 * 600bn Sanctum — standalone game surface at /sanctum.
 *
 * Self-contained Pallasite-style game: ship + bullets + asteroid-style
 * collision, but every "asteroid" is a 600bn entity (council avatar /
 * Sacred Stone / racoo / Bullbear / ember meteor). Runs an entirely
 * private game loop so the main-game updateGame is never touched —
 * keeps the conference deployment hard-isolated.
 *
 * Controls (desktop):
 *   ←/→ or A/D  — rotate
 *   ↑   or W    — thrust
 *   Space       — fire
 *   X           — shield (2s up, 8s cooldown)
 *   Shift       — hyperspace (random teleport, 6s cooldown)
 *
 * Mobile (canvas-only): tap-and-drag left half = joystick (rotate +
 * thrust), tap right half = fire single shot.
 *
 * Lives: 3 — on death you respawn at centre with 2s invuln; on the
 * third death the game-over overlay lands.
 *
 * Run length: 240s, OR Bullbear-defeat, OR last life lost.
 *
 * Sat tier: only smallest-size council fragments drop sats (1 each).
 * racooDNI 6, Sacred Stone shatter 21, Bullbear defeat 21. Per-run
 * max ~135 sats; realistic high score ~50-70.
 */

import {
  createSanctumState,
  tickSanctum,
  renderSanctum,
  SANCTUM_WORLD_W,
  SANCTUM_WORLD_H,
  applyMemberHit,
  applyStoneHit,
  applyRacooHit,
  applyBullbearHit,
  applyMeteorHit,
  isSanctumComplete,
  type SanctumState,
} from './sanctum.js';
import { loadCouncil } from './sanctum-avatars.js';
import * as audio from './audio.js';
import { crossfadeTo, musicStop } from './music.js';
import QRCode from 'qrcode';

// ── Ship + bullet types ──────────────────────────────────────────────

interface Ship {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  rotVel: number;
  thrusting: boolean;
  alive: boolean;
  invulnerableUntil: number;
  thrustFrame: number;
  recoilOffset: number;
  // Shield power-up state.
  shieldUp: boolean;
  shieldExpiresAt: number;
  shieldReadyAt: number;
  // Hyperspace state — ship is invisible while cloakMs > 0 then warps.
  hyperspaceCloakMs: number;
  hyperspaceReadyAt: number;
}

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  ttl: number;
  alive: boolean;
}

// Tuning — matched to Pallasite main-game values where it makes sense.
const SHIP_THRUST = 240;
const SHIP_DRAG = 0.4;
const SHIP_ROT_ACCEL = 14;
const SHIP_ROT_DAMPING = 9;
const SHIP_MAX_ROT = 7;
const FIRE_COOLDOWN_MS = 145;
const BULLET_SPEED = 460;
const BULLET_TTL_MS = 1400;
const BULLET_RADIUS = 3;
const SHIP_RADIUS = 12;
const SHIELD_DURATION_MS = 2200;
const SHIELD_COOLDOWN_MS = 8000;
const HYPERSPACE_COOLDOWN_MS = 6000;
const HYPERSPACE_CLOAK_MS = 600;
const RESPAWN_INVULN_MS = 2200;
const INITIAL_LIVES = 3;
const IGNITE_BANNER_MS = 1400;

function makeShip(): Ship {
  return {
    x: SANCTUM_WORLD_W / 2,
    y: SANCTUM_WORLD_H * 0.78,
    vx: 0, vy: 0,
    r: SHIP_RADIUS,
    rot: -Math.PI / 2,
    rotVel: 0,
    thrusting: false,
    alive: true,
    invulnerableUntil: performance.now() + 3000,
    thrustFrame: 0,
    recoilOffset: 0,
    shieldUp: false,
    shieldExpiresAt: 0,
    shieldReadyAt: 0,
    hyperspaceCloakMs: 0,
    hyperspaceReadyAt: 0,
  };
}

function respawnShip(ship: Ship, now: number): void {
  ship.x = SANCTUM_WORLD_W / 2;
  ship.y = SANCTUM_WORLD_H * 0.78;
  ship.vx = 0; ship.vy = 0;
  ship.rot = -Math.PI / 2;
  ship.rotVel = 0;
  ship.thrusting = false;
  ship.alive = true;
  ship.invulnerableUntil = now + RESPAWN_INVULN_MS;
  ship.recoilOffset = 0;
  ship.shieldUp = false;
  ship.shieldExpiresAt = 0;
  ship.hyperspaceCloakMs = 0;
}

function fireBullet(ship: Ship, bullets: Bullet[]): void {
  bullets.push({
    x: ship.x + Math.cos(ship.rot) * (ship.r + 4),
    y: ship.y + Math.sin(ship.rot) * (ship.r + 4),
    vx: Math.cos(ship.rot) * BULLET_SPEED,
    vy: Math.sin(ship.rot) * BULLET_SPEED,
    r: BULLET_RADIUS,
    ttl: BULLET_TTL_MS,
    alive: true,
  });
  ship.recoilOffset = 1.8;
  audio.fire();
}

function tryShield(ship: Ship, now: number): boolean {
  if (!ship.alive) return false;
  if (ship.shieldUp) return false;
  if (now < ship.shieldReadyAt) return false;
  ship.shieldUp = true;
  ship.shieldExpiresAt = now + SHIELD_DURATION_MS;
  ship.shieldReadyAt = now + SHIELD_DURATION_MS + SHIELD_COOLDOWN_MS;
  audio.shieldUp();
  return true;
}

function tryHyperspace(ship: Ship, now: number): boolean {
  if (!ship.alive) return false;
  if (ship.hyperspaceCloakMs > 0) return false;
  if (now < ship.hyperspaceReadyAt) return false;
  ship.hyperspaceCloakMs = HYPERSPACE_CLOAK_MS;
  ship.hyperspaceReadyAt = now + HYPERSPACE_COOLDOWN_MS;
  // Schedule the actual teleport at the end of the cloak window so the
  // departure/arrival reads as a real "warp" beat.
  audio.warpJump();
  window.setTimeout(() => {
    if (!ship.alive) return;
    ship.x = 80 + Math.random() * (SANCTUM_WORLD_W - 160);
    ship.y = 80 + Math.random() * (SANCTUM_WORLD_H - 160);
    ship.vx = 0; ship.vy = 0;
    ship.invulnerableUntil = performance.now() + 600;
  }, HYPERSPACE_CLOAK_MS);
  return true;
}

function wrap(p: { x: number; y: number }): void {
  if (p.x < 0) p.x += SANCTUM_WORLD_W;
  else if (p.x > SANCTUM_WORLD_W) p.x -= SANCTUM_WORLD_W;
  if (p.y < 0) p.y += SANCTUM_WORLD_H;
  else if (p.y > SANCTUM_WORLD_H) p.y -= SANCTUM_WORLD_H;
}

function hitCircle(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): boolean {
  const dx = x1 - x2;
  const dy = y1 - y2;
  const rr = r1 + r2;
  return dx * dx + dy * dy < rr * rr;
}

// ── DOM scaffold ─────────────────────────────────────────────────────

function hideMainChrome(): void {
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui-root');
  const touch = document.getElementById('touch-controls');
  if (canvas) (canvas as HTMLElement).style.display = 'none';
  if (ui) (ui as HTMLElement).style.display = 'none';
  if (touch) (touch as HTMLElement).style.display = 'none';
  document.body.style.background = 'radial-gradient(ellipse at center, #2a1408 0%, #060201 70%)';
}

function applySanctumBackgroundIfPresent(): void {
  const img = new Image();
  img.onload = () => {
    document.body.style.backgroundImage = "url('/backgrounds/sanctum.webp')";
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  };
  img.onerror = () => { /* silent — gradient fallback stays */ };
  img.src = '/backgrounds/sanctum.webp';
}

function mountSurface(): { canvas: HTMLCanvasElement; wrap: HTMLDivElement } {
  const existing = document.getElementById('sanctum-preview-root');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'sanctum-preview-root';
  wrap.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:8px', 'padding:12px',
  ].join(';');
  document.body.appendChild(wrap);

  const canvas = document.createElement('canvas');
  canvas.width = SANCTUM_WORLD_W;
  canvas.height = SANCTUM_WORLD_H;
  canvas.style.cssText = [
    'max-width:100%', 'max-height:85vh',
    'aspect-ratio:' + SANCTUM_WORLD_W + '/' + SANCTUM_WORLD_H,
    'border:1px solid rgba(255,138,58,0.35)',
    'border-radius:6px',
    'box-shadow:0 0 60px rgba(255,138,58,0.35)',
    'background:#060201',
    'touch-action:none',
  ].join(';');
  wrap.appendChild(canvas);

  const caption = document.createElement('div');
  caption.style.cssText = 'font:11px ui-monospace,monospace;color:rgba(255,216,74,0.85);letter-spacing:0.16em;text-align:center;';
  caption.innerHTML = '←→ ROTATE · ↑ THRUST · SPACE FIRE · X SHIELD · SHIFT WARP';
  wrap.appendChild(caption);

  return { canvas, wrap };
}

// ── Touch / pointer joystick on the canvas (mobile path) ─────────────

interface PointerState {
  active: boolean;
  centreX: number;
  centreY: number;
  dx: number;
  dy: number;
}

function bindPointer(canvas: HTMLCanvasElement, state: PointerState, onFire: () => void): void {
  let lastFireAt = 0;
  const halfW = (): number => canvas.getBoundingClientRect().width / 2;

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < halfW()) {
      state.active = true;
      state.centreX = px;
      state.centreY = py;
      state.dx = 0;
      state.dy = 0;
      canvas.setPointerCapture(e.pointerId);
    } else {
      const now = performance.now();
      if (now - lastFireAt > 80) {
        lastFireAt = now;
        onFire();
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.active) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    state.dx = px - state.centreX;
    state.dy = py - state.centreY;
  });
  const release = (e: PointerEvent): void => {
    if (!state.active) return;
    state.active = false;
    state.dx = 0;
    state.dy = 0;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
}

// ── Ship + bullets draw (matched to main-game line-art style) ────────

const SHIP_COLOUR = '#9bf9ff';
const SHIP_SHADOW = '#a6e3ff';
const THRUST_COLOUR = '#ffbe40';
const THRUST_SHADOW = '#ff8a3a';

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  if (!ship.alive) return;
  // Hide ship entirely during hyperspace cloak.
  if (ship.hyperspaceCloakMs > 0) return;
  // Invulnerability flicker.
  const flickerOff = ship.invulnerableUntil > now && Math.floor(now / 80) % 2 === 0;
  if (flickerOff) return;

  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.rot);
  if (ship.recoilOffset > 0) ctx.translate(-ship.recoilOffset, 0);

  // Hull — line art triangle, classic Pallasite proportions.
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = SHIP_COLOUR;
  ctx.shadowColor = SHIP_SHADOW;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.stroke();

  // Thrust bloom + flame.
  if (ship.thrusting && Math.floor(ship.thrustFrame) % 2 === 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bloom = ctx.createRadialGradient(-10, 0, 0, -10, 0, 24);
    bloom.addColorStop(0, 'rgba(255, 190, 60, 0.7)');
    bloom.addColorStop(0.5, 'rgba(255, 138, 58, 0.4)');
    bloom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(-10, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = THRUST_COLOUR;
    ctx.shadowColor = THRUST_SHADOW;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(-6, 4);
    ctx.lineTo(-14, 0);
    ctx.lineTo(-6, -4);
    ctx.stroke();
  }

  ctx.restore();

  // Shield bubble (drawn in screen space so it doesn't rotate with ship).
  if (ship.shieldUp) {
    const remaining = (ship.shieldExpiresAt - now) / SHIELD_DURATION_MS;
    const alpha = Math.max(0.25, Math.min(1, remaining + 0.25));
    ctx.save();
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = `rgba(255, 216, 74, ${alpha})`;
    ctx.shadowColor = 'rgba(255, 138, 58, 0.85)';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(ship.x, ship.y, ship.r + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBullets(ctx: CanvasRenderingContext2D, bullets: readonly Bullet[]): void {
  ctx.save();
  for (const b of bullets) {
    if (!b.alive) continue;
    const speed = Math.hypot(b.vx, b.vy);
    const len = Math.max(6, speed * 0.012);
    const ux = b.vx / speed;
    const uy = b.vy / speed;
    // Trail.
    ctx.strokeStyle = 'rgba(255,170,40,0.30)';
    ctx.lineWidth = 1.6;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - ux * len * 3.5, b.y - uy * len * 3.5);
    ctx.stroke();
    // Head.
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = '#ff6a00';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(b.x - ux * len * 0.5, b.y - uy * len * 0.5);
    ctx.lineTo(b.x + ux * len * 0.5, b.y + uy * len * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/** HUD: lives, shield/warp cooldown chips, IGNITE banner. */
function drawSanctumHUD(
  ctx: CanvasRenderingContext2D,
  ship: Ship,
  lives: number,
  igniteUntil: number,
  now: number,
): void {
  ctx.save();
  // Lives (small ship icons, top-left under the phase label).
  for (let i = 0; i < lives; i++) {
    const cx = 20 + i * 16;
    const cy = 42;
    ctx.strokeStyle = '#9bf9ff';
    ctx.lineWidth = 1.4;
    ctx.shadowColor = '#a6e3ff';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(cx + 6, cy);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx - 2, cy);
    ctx.lineTo(cx - 4, cy - 4);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Cooldown chips (bottom-left).
  const baseY = ctx.canvas.height - 22;
  const chip = (label: string, ready: boolean, x: number): void => {
    ctx.fillStyle = ready ? 'rgba(255,216,74,0.85)' : 'rgba(140,140,140,0.55)';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x, baseY);
  };
  chip('X SHIELD',  now >= ship.shieldReadyAt && !ship.shieldUp, 20);
  chip('SHIFT WARP', now >= ship.hyperspaceReadyAt, 110);

  // IGNITE banner.
  if (now < igniteUntil) {
    const t = (igniteUntil - now) / IGNITE_BANNER_MS;
    const alpha = Math.min(1, t * 2);
    const scale = 1 + (1 - t) * 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.font = 'bold 52px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = '#ff8a3a';
    ctx.shadowBlur = 24;
    ctx.fillText('IGNITE', 0, -22);
    ctx.font = 'bold 14px ui-monospace, monospace';
    ctx.fillStyle = '#fff5d8';
    ctx.fillText('240 SECONDS · STACK SATS', 0, 18);
    ctx.restore();
  }
  ctx.restore();
}

// ── Game-over overlay ────────────────────────────────────────────────

function renderGameOverOverlay(state: SanctumState, victory: boolean, onReplay: () => void): void {
  const existing = document.getElementById('sanctum-gameover');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'sanctum-gameover';
  overlay.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:14px', 'padding:20px',
    'background:rgba(6,2,1,0.92)',
    'backdrop-filter:blur(8px)',
    'z-index:1000',
  ].join(';');
  document.body.appendChild(overlay);

  const header = document.createElement('h1');
  header.textContent = victory ? 'BULLBEAR DOWN' : (state.bullbearDefeated ? 'BULLBEAR DOWN' : 'GAME OVER');
  header.style.cssText = 'font:bold 38px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.22em;margin:0;text-shadow:0 0 16px rgba(255,138,58,0.7);';
  overlay.appendChild(header);

  const stats = document.createElement('div');
  stats.style.cssText = 'display:flex;gap:32px;font:bold 16px ui-monospace,monospace;letter-spacing:0.18em;';
  stats.innerHTML = `
    <span style="color:#3afc7c;">${state.satsEarned} SATS</span>
    <span style="color:rgba(255,245,216,0.85);">${state.score.toLocaleString()} PTS</span>
  `;
  overlay.appendChild(stats);

  const card = document.createElement('div');
  card.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center',
    'gap:8px', 'padding:18px 26px', 'margin:10px 0',
    'background:linear-gradient(180deg, rgba(255,138,58,0.12), rgba(40,16,8,0.85))',
    'border:1px solid rgba(255,216,74,0.5)', 'border-radius:8px',
    'max-width:420px', 'width:90%',
    'box-shadow:0 0 30px rgba(255,138,58,0.25)',
  ].join(';');
  overlay.appendChild(card);

  const number = document.createElement('div');
  number.style.cssText = 'font:bold 20px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.16em;line-height:1.1;text-align:center;text-shadow:0 0 12px rgba(255,138,58,0.5);';
  number.innerHTML = '600<br>000<br>000<br>000';
  card.appendChild(number);

  const banner = document.createElement('div');
  banner.textContent = 'PRAGUE PARTY · 11 JUNE 2026';
  banner.style.cssText = 'font:bold 13px ui-monospace,monospace;color:#fff5d8;letter-spacing:0.22em;margin-top:6px;';
  card.appendChild(banner);

  const venue = document.createElement('div');
  venue.textContent = 'FUCHS2 · OSTROV ŠTVANICE';
  venue.style.cssText = 'font:11px ui-monospace,monospace;color:rgba(255,245,216,0.75);letter-spacing:0.16em;';
  card.appendChild(venue);

  const link = document.createElement('a');
  link.href = 'https://600.wtf';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:6px;text-decoration:none;';
  card.appendChild(link);

  const qrCanvas = document.createElement('canvas');
  qrCanvas.style.cssText = 'background:#fff5d8;padding:6px;border-radius:4px;';
  link.appendChild(qrCanvas);
  void QRCode.toCanvas(qrCanvas, 'https://600.wtf', {
    width: 140,
    margin: 0,
    color: { dark: '#0a0418', light: '#fff5d8' },
  }).catch(() => undefined);

  const url = document.createElement('div');
  url.textContent = '600.wtf · TAP';
  url.style.cssText = 'font:bold 12px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.2em;margin-top:4px;';
  link.appendChild(url);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:6px;';
  overlay.appendChild(btnRow);

  const replayBtn = document.createElement('button');
  replayBtn.textContent = 'PLAY AGAIN ▶';
  replayBtn.style.cssText = [
    'padding:14px 28px',
    'font:bold 16px ui-monospace,monospace',
    'letter-spacing:0.24em',
    'background:rgba(255,216,74,0.18)',
    'border:2px solid #ffd84a',
    'color:#ffd84a',
    'border-radius:4px',
    'cursor:pointer',
    'text-shadow:0 0 8px rgba(255,216,74,0.5)',
  ].join(';');
  replayBtn.addEventListener('click', () => {
    overlay.remove();
    onReplay();
  });
  btnRow.appendChild(replayBtn);

  const backBtn = document.createElement('button');
  backBtn.textContent = 'BACK TO TITLE';
  backBtn.style.cssText = [
    'padding:14px 28px',
    'font:bold 14px ui-monospace,monospace',
    'letter-spacing:0.22em',
    'background:rgba(255,138,58,0.08)',
    'border:1px solid rgba(255,138,58,0.45)',
    'color:rgba(255,245,216,0.85)',
    'border-radius:4px',
    'cursor:pointer',
  ].join(';');
  backBtn.addEventListener('click', () => {
    musicStop(400);
    window.location.assign('/');
  });
  btnRow.appendChild(backBtn);
}

// ── Run loop ─────────────────────────────────────────────────────────

async function runSanctumSession(): Promise<void> {
  applySanctumBackgroundIfPresent();
  const { canvas } = mountSurface();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  await loadCouncil();
  const state = createSanctumState();
  const ship = makeShip();
  const bullets: Bullet[] = [];
  let lives = INITIAL_LIVES;
  const keys: Record<string, boolean> = {};
  const pointer: PointerState = { active: false, centreX: 0, centreY: 0, dx: 0, dy: 0 };
  let lastFireAt = 0;

  const sessionStart = performance.now();
  const igniteUntil = sessionStart + IGNITE_BANNER_MS;

  let musicStarted = false;
  const startMusic = (): void => {
    if (musicStarted) return;
    musicStarted = true;
    void audio.unlockAudio();
    crossfadeTo('the-cult', 1200);
  };

  // Keyboard input — bound to window so canvas focus doesn't matter.
  const onKeyDown = (e: KeyboardEvent): void => {
    keys[e.code] = true;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (!musicStarted) startMusic();
    // Edge-triggered actions (avoid auto-repeat firing them every frame).
    if (!e.repeat) {
      if (e.code === 'KeyX') tryShield(ship, performance.now());
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyH') {
        tryHyperspace(ship, performance.now());
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => { keys[e.code] = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  bindPointer(canvas, pointer, () => {
    if (!musicStarted) startMusic();
    if (!ship.alive) return;
    const now = performance.now();
    if (now - lastFireAt >= FIRE_COOLDOWN_MS) {
      lastFireAt = now;
      fireBullet(ship, bullets);
    }
  });

  let ended = false;
  let last = performance.now();
  const cleanupAndEnd = (victory: boolean): void => {
    if (ended) return;
    ended = true;
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    audio.setMusicDuck(0.35);
    renderGameOverOverlay(state, victory, () => {
      audio.setMusicDuck(1);
      void runSanctumSession();
    });
  };

  const loop = (now: number): void => {
    if (ended) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Shield + hyperspace housekeeping.
    if (ship.shieldUp && now >= ship.shieldExpiresAt) {
      ship.shieldUp = false;
      audio.shieldDown();
    }
    if (ship.hyperspaceCloakMs > 0) ship.hyperspaceCloakMs -= dt * 1000;
    if (ship.recoilOffset > 0) ship.recoilOffset = Math.max(0, ship.recoilOffset - dt * 24);

    // Ship input only while alive AND not cloaked.
    if (ship.alive && ship.hyperspaceCloakMs <= 0) {
      const POINTER_DEAD = 14;
      const POINTER_MAX = 60;
      const len = Math.hypot(pointer.dx, pointer.dy);
      if (pointer.active && len > POINTER_DEAD) {
        const targetRot = Math.atan2(pointer.dy, pointer.dx);
        let diff = targetRot - ship.rot;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const lerpRate = 9;
        const step = lerpRate * dt;
        if (Math.abs(diff) <= step) ship.rot = targetRot;
        else ship.rot += Math.sign(diff) * step;
        ship.thrusting = len > POINTER_MAX * 0.5;
      } else {
        const turnL = keys['ArrowLeft'] || keys['KeyA'];
        const turnR = keys['ArrowRight'] || keys['KeyD'];
        if (turnL) ship.rotVel -= SHIP_ROT_ACCEL * dt;
        if (turnR) ship.rotVel += SHIP_ROT_ACCEL * dt;
        if (!turnL && !turnR) {
          const s = Math.sign(ship.rotVel);
          const v = ship.rotVel - s * SHIP_ROT_DAMPING * dt;
          ship.rotVel = Math.sign(v) === s ? v : 0;
        }
        ship.rotVel = Math.max(-SHIP_MAX_ROT, Math.min(SHIP_MAX_ROT, ship.rotVel));
        ship.rot += ship.rotVel * dt;
        ship.thrusting = !!(keys['ArrowUp'] || keys['KeyW']);
      }

      if (ship.thrusting) {
        ship.thrustFrame += dt * 30;
        ship.vx += Math.cos(ship.rot) * SHIP_THRUST * dt;
        ship.vy += Math.sin(ship.rot) * SHIP_THRUST * dt;
        audio.thrustOn();
      } else {
        audio.thrustOff();
      }

      const dragK = Math.exp(-SHIP_DRAG * dt);
      ship.vx *= dragK;
      ship.vy *= dragK;
      ship.x += ship.vx * dt;
      ship.y += ship.vy * dt;
      wrap(ship);

      if (keys['Space'] && now - lastFireAt >= FIRE_COOLDOWN_MS) {
        lastFireAt = now;
        fireBullet(ship, bullets);
      }
    }

    // Bullet motion.
    for (const b of bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt * 1000;
      if (b.ttl <= 0) b.alive = false;
      else wrap(b);
    }

    // Sanctum tick.
    tickSanctum(state, dt * 1000);

    // Bullet × entity collisions.
    for (const b of bullets) {
      if (!b.alive) continue;
      if (state.bullbear && hitCircle(b.x, b.y, b.r, state.bullbear.x, state.bullbear.y, state.bullbear.r)) {
        const drop = applyBullbearHit(state.bullbear);
        b.alive = false;
        if (drop > 0) { state.satsEarned += drop; state.score += 4200; audio.explosion(1.4); }
        else audio.hit();
        continue;
      }
      if (state.racoo && hitCircle(b.x, b.y, b.r, state.racoo.x, state.racoo.y, state.racoo.r)) {
        const drop = applyRacooHit(state.racoo);
        b.alive = false;
        if (drop > 0) { state.satsEarned += drop; state.score += 600; audio.coinPickup(); }
        continue;
      }
      let hitC = false;
      for (const m of state.council) {
        if (m.dead) continue;
        if (hitCircle(b.x, b.y, b.r, m.x, m.y, m.r)) {
          const drop = applyMemberHit(m, state);
          b.alive = false;
          hitC = true;
          if (drop > 0) { state.satsEarned += drop; state.score += 100; audio.explosion(0.6); }
          else audio.hit();
          break;
        }
      }
      if (hitC) continue;
      if (state.stone && !state.stone.shattering && hitCircle(b.x, b.y, b.r, state.stone.x, state.stone.y, state.stone.r)) {
        const drop = applyStoneHit(state);
        b.alive = false;
        if (drop > 0) { state.satsEarned += drop; state.score += 2100; audio.explosion(1.4); }
        else audio.hit();
        continue;
      }
      for (const m of state.meteors) {
        if (m.hp <= 0) continue;
        if (hitCircle(b.x, b.y, b.r, m.x, m.y, m.r)) {
          applyMeteorHit(m);
          b.alive = false;
          state.score += 25;
          audio.hit();
          break;
        }
      }
    }
    for (let i = bullets.length - 1; i >= 0; i--) if (!bullets[i].alive) bullets.splice(i, 1);

    // Ship × entity body collisions (lethal unless shielded).
    if (ship.alive && now >= ship.invulnerableUntil && ship.hyperspaceCloakMs <= 0) {
      let lethal = false;
      for (const m of state.council) {
        if (m.dead) continue;
        if (hitCircle(ship.x, ship.y, ship.r, m.x, m.y, m.r)) { lethal = true; break; }
      }
      if (!lethal && state.stone && !state.stone.shattering &&
          hitCircle(ship.x, ship.y, ship.r, state.stone.x, state.stone.y, state.stone.r)) lethal = true;
      if (!lethal && state.bullbear &&
          hitCircle(ship.x, ship.y, ship.r, state.bullbear.x, state.bullbear.y, state.bullbear.r)) lethal = true;
      if (!lethal) {
        for (const m of state.meteors) {
          if (m.hp <= 0) continue;
          if (hitCircle(ship.x, ship.y, ship.r, m.x, m.y, m.r)) { lethal = true; break; }
        }
      }
      if (lethal) {
        if (ship.shieldUp) {
          // Shield eats the hit — fizzle the shield, brief invuln, no life lost.
          ship.shieldUp = false;
          ship.shieldExpiresAt = 0;
          ship.invulnerableUntil = now + 700;
          audio.shieldHit();
        } else {
          ship.alive = false;
          audio.explosion(1.6);
          lives -= 1;
          if (lives > 0) {
            // Respawn after a short death beat.
            window.setTimeout(() => {
              if (ended) return;
              respawnShip(ship, performance.now());
            }, 900);
          } else {
            // Out of lives — game over.
            window.setTimeout(() => cleanupAndEnd(false), 1000);
          }
        }
      }
    }

    // Render.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(6,2,1,0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderSanctum(ctx, state);
    drawBullets(ctx, bullets);
    drawShip(ctx, ship, now);
    drawSanctumHUD(ctx, ship, lives, igniteUntil, now);

    // End conditions: timer expired OR Bullbear defeated.
    if (!ended && isSanctumComplete(state)) {
      cleanupAndEnd(state.bullbearDefeated);
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export async function renderSanctumPreview(): Promise<void> {
  hideMainChrome();
  await runSanctumSession();
}
