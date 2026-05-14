/**
 * 600bn Sanctum — standalone game surface at /sanctum.
 *
 * Self-contained Pallasite-style game: ship + bullets + asteroid-style
 * collision, but every "asteroid" is a 600bn entity (council avatar /
 * Sacred Stone / racoo / Bullbear / ember meteor). Runs an entirely
 * private game loop so the main-game updateGame is never touched —
 * keeps the conference deployment hard-isolated.
 *
 * Controls:
 *   - ←/→ or A/D — rotate ship
 *   - ↑ or W or thrust pad — thrust
 *   - Space or fire pad — shoot
 *
 * Mobile: same touch controls as the main game (#touch-controls is
 * the existing virtual joystick + fire button — we just stop hiding
 * them on the Sanctum surface).
 *
 * Sat scale 1 / 2 / 6 / 21 — member kill 1 sat, racoo 6, Stone 21,
 * Bullbear 21. ~50-60 sats per perfect run. Music: the-cult.opus on
 * first user gesture.
 *
 * 240s timer OR Bullbear-defeat OR ship-death ends the run with the
 * FUCHS2 game-over overlay (party banner + QR to 600.wtf).
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
  };
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
  audio.fire();
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
  caption.innerHTML = '←→ ROTATE · ↑ THRUST · SPACE FIRE · or drag/tap canvas on mobile';
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
  firePressed: boolean;
}

function bindPointer(canvas: HTMLCanvasElement, state: PointerState, onFire: () => void): void {
  // Left half = joystick (rotate + thrust). Right half = fire.
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
        state.firePressed = true;
        onFire();
        // Auto-release after one shot — held-fire would need a timer.
        window.setTimeout(() => { state.firePressed = false; }, 50);
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

// ── Ship draw + bullet draw ──────────────────────────────────────────

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  if (!ship.alive) return;
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.rot);

  ctx.strokeStyle = '#fff5d8';
  ctx.fillStyle = 'rgba(255,245,216,0.15)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, -9);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (ship.thrusting) {
    const flicker = 0.6 + 0.4 * Math.sin(ship.thrustFrame * 1.3);
    ctx.fillStyle = `rgba(255,138,58,${flicker})`;
    ctx.beginPath();
    ctx.moveTo(-6, -5);
    ctx.lineTo(-14 - 4 * flicker, 0);
    ctx.lineTo(-6, 5);
    ctx.closePath();
    ctx.fill();
  }

  if (now < ship.invulnerableUntil) {
    const t = Math.max(0, Math.min(1, (ship.invulnerableUntil - now) / 3000));
    ctx.globalAlpha = 0.6 * t;
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 18, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawBullets(ctx: CanvasRenderingContext2D, bullets: readonly Bullet[]): void {
  ctx.save();
  ctx.fillStyle = '#fff5d8';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 6;
  for (const b of bullets) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
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
  const keys: Record<string, boolean> = {};
  const pointer: PointerState = { active: false, centreX: 0, centreY: 0, dx: 0, dy: 0, firePressed: false };
  let lastFireAt = 0;

  let musicStarted = false;
  const startMusic = (): void => {
    if (musicStarted) return;
    musicStarted = true;
    void audio.unlockAudio();
    crossfadeTo('the-cult', 1200);
  };

  // Bind keys at window level — captures even when canvas isn't focused.
  const onKeyDown = (e: KeyboardEvent): void => {
    keys[e.code] = true;
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (!musicStarted) startMusic();
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
  const loop = (now: number): void => {
    if (ended) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Ship input.
    if (ship.alive) {
      // Pointer joystick (mobile).
      const POINTER_DEAD = 14;
      const POINTER_MAX = 60;
      const len = Math.hypot(pointer.dx, pointer.dy);
      if (pointer.active && len > POINTER_DEAD) {
        const targetRot = Math.atan2(pointer.dy, pointer.dx);
        // Lerp ship.rot toward target.
        let diff = targetRot - ship.rot;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const lerpRate = 9;
        const step = lerpRate * dt;
        if (Math.abs(diff) <= step) ship.rot = targetRot;
        else ship.rot += Math.sign(diff) * step;
        // Stick deflection past 50% of max = thrust.
        if (len > POINTER_MAX * 0.5) ship.thrusting = true;
        else ship.thrusting = false;
      } else {
        // Keyboard.
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

      // Keyboard fire.
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
    // Cull dead bullets.
    for (let i = bullets.length - 1; i >= 0; i--) if (!bullets[i].alive) bullets.splice(i, 1);

    // Ship × entity body collisions (lethal).
    if (ship.alive && now >= ship.invulnerableUntil) {
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
        ship.alive = false;
        audio.explosion(2.0);
        // Short delay before showing game-over so the explosion lands.
        window.setTimeout(() => {
          if (ended) return;
          ended = true;
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          audio.setMusicDuck(0.35);
          renderGameOverOverlay(state, false, () => {
            audio.setMusicDuck(1);
            void runSanctumSession();
          });
        }, 1200);
      }
    }

    // Render.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(6,2,1,0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    renderSanctum(ctx, state);
    drawBullets(ctx, bullets);
    drawShip(ctx, ship, now);

    // End conditions: timer expired OR Bullbear defeated.
    if (!ended && isSanctumComplete(state)) {
      ended = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      audio.setMusicDuck(0.35);
      const victory = state.bullbearDefeated;
      renderGameOverOverlay(state, victory, () => {
        audio.setMusicDuck(1);
        void runSanctumSession();
      });
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
