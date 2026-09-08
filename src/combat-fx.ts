/** Bounded, cached light sprites: all tiers share the same combat information. */
import type { Asteroid, GameState, Particle } from './types.js';
import { FORGE_RING_R, FORGE_SEGMENTS, FORGE_PULSE_WARNING_MS } from './types.js';

const TAU = Math.PI * 2;
const lights = new Map<string, HTMLCanvasElement>();
function light(colour: string): HTMLCanvasElement {
  const existing = lights.get(colour);
  if (existing) return existing;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff8df');
  gradient.addColorStop(0.13, colour);
  gradient.addColorStop(0.4, colour);
  gradient.addColorStop(1, 'transparent');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  // A bounded cache also covers dynamically coloured particles in long runs.
  if (lights.size >= 48) lights.delete(lights.keys().next().value!);
  lights.set(colour, canvas);
  return canvas;
}

export function drawLitParticles(ctx: CanvasRenderingContext2D, particles: ReadonlyArray<Particle>, budget: number, trails: boolean): void {
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'lighter';
  const stride = Math.max(1, Math.ceil(particles.length / budget));
  for (let i = 0; i < particles.length; i += stride) {
    const p = particles[i];
    const alpha = Math.max(0, Math.min(1, p.ttl / p.maxTtl));
    if (alpha < 0.05) continue;
    const r = p.size * (1 + alpha);
    ctx.globalAlpha = alpha * 0.8;
    if (trails && p.vel.x * p.vel.x + p.vel.y * p.vel.y > 18_000) {
      ctx.strokeStyle = p.colour;
      ctx.lineWidth = Math.max(0.6, p.size * 0.45);
      ctx.beginPath();
      ctx.moveTo(p.pos.x, p.pos.y);
      ctx.lineTo(p.pos.x - p.vel.x * 0.025 * alpha, p.pos.y - p.vel.y * 0.025 * alpha);
      ctx.stroke();
    }
    ctx.drawImage(light(p.colour), p.pos.x - r, p.pos.y - r, r * 2, r * 2);
  }
  ctx.restore();
}

/** Matches the simulation cadence; presentation never advances an attack. */
export function forgeCharge(state: GameState, core: Asteroid): number {
  if (state.wave !== 25 || state.forgeEscaped || core.hp >= core.hpMax) return 0;
  if (!state.forgePulseAt) return 0;
  return Math.max(0, Math.min(1, 1 - (state.forgePulseAt - state.elapsed) / FORGE_PULSE_WARNING_MS));
}

export function bossReadout(state: GameState) {
  if ((state.wave !== 17 && state.wave !== 25) || state.phase !== 'playing') return null;
  const core = state.asteroids.find(a => a.alive && a.stationPart === 'core');
  if (!core) return null;
  const forge = state.wave === 25;
  const pods = state.asteroids.filter(a => a.alive && a.stationPart === 'emitter').length;
  const charge = forgeCharge(state, core);
  const phase = !forge ? 'STATION' : state.forgeEscaped ? 'CHASE' : state.forgeMeltdown ? 'MELTDOWN' : state.forgeBreached ? 'EXPOSED' : 'BREACH';
  const colour = charge > 0 ? '#ffd480' : forge && state.forgeMeltdown ? '#ff7856' : '#a8ecce';
  const instruction = charge > 0 ? 'PULSE CHARGING · MAKE SPACE'
    : !forge ? 'DISABLE THE PODS · HIT THE CORE'
    : state.forgeEscaped ? 'RUN DOWN THE CORE'
    : state.forgeMeltdown ? 'KEEP MOVING · FINISH THE CORE'
    : pods > 0 && !state.forgeBreached ? 'BREAK THE PODS · OPEN A FIRING LINE'
    : 'CORE EXPOSED · PRESS THE ATTACK';
  return { core, pods, charge, phase, colour, instruction, name: forge ? 'THE FORGE' : 'EAGLE STATION' };
}

/** Reactor light, shell circuitry and an unmistakable contracting charge ring.
 * Light uses one cached sprite; low quality keeps the warning and core rings. */
export function drawBossReactor(ctx: CanvasRenderingContext2D, state: GameState, detailed: boolean, reducedMotion: boolean): void {
  const boss = bossReadout(state);
  if (!boss) return;
  const { core, charge, colour } = boss;
  const time = reducedMotion ? 0 : state.elapsed * 0.00018;
  const r = core.radius;
  ctx.save();
  ctx.translate(core.pos.x, core.pos.y);
  ctx.shadowBlur = 0;
  if (detailed) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.14 + charge * 0.2;
    const halo = r * (4 + charge);
    ctx.drawImage(light(colour), -halo, -halo, halo * 2, halo * 2);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.55;
  if (state.wave === 25 && !state.forgeEscaped) {
    // Conduits connect only the surviving pods, so breaches stay legible.
    for (const pod of state.asteroids) {
      if (!pod.alive || pod.stationPart !== 'emitter') continue;
      const ang = Math.atan2(pod.pos.y - core.pos.y, pod.pos.x - core.pos.x);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * (r + 7), Math.sin(ang) * (r + 7));
      ctx.lineTo(pod.pos.x - core.pos.x, pod.pos.y - core.pos.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, FORGE_RING_R + 21, ang - 0.11, ang + 0.11);
      ctx.stroke();
    }
  }
  for (let i = 0; i < (detailed ? 3 : 1); i++) {
    ctx.lineWidth = i === 0 ? 2 : 0.8;
    const turn = time * (i % 2 ? -1 : 1) + i * 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, r + 8 + i * 5, turn, turn + Math.PI * 1.3);
    ctx.stroke();
  }
  if (charge > 0) {
    ctx.globalAlpha = 0.65 + charge * 0.35;
    ctx.lineWidth = 2.5;
    const chargeR = r + 12 + (reducedMotion ? 28 : (1 - charge) * 65);
    ctx.beginPath(); ctx.arc(0, 0, chargeR, 0, TAU); ctx.stroke();
    // Fixed warning teeth never imply safe bullet trajectories.
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (chargeR + 5), Math.sin(a) * (chargeR + 5));
      ctx.lineTo(Math.cos(a) * (chargeR + 10), Math.sin(a) * (chargeR + 10));
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawBossStatus(ctx: CanvasRenderingContext2D, state: GameState, width: number, top: number, compact = false): void {
  const boss = bossReadout(state);
  if (!boss) return;
  const w = Math.min(440, width - 32), x = (width - w) / 2;
  const height = compact ? 48 : 66;
  const labelY = top + (compact ? 4 : 9);
  const barY = top + (compact ? 20 : 28);
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(4,12,19,0.88)';
  ctx.fillRect(x, top, w, height);
  ctx.fillStyle = boss.colour;
  ctx.fillRect(x, top, 2, height);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = 'bold 12px ui-monospace, monospace';
  ctx.fillText(boss.name, x + 12, labelY);
  ctx.textAlign = 'right';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(boss.phase, x + w - 12, labelY + 1);
  const barW = w - 24;
  ctx.fillStyle = '#24383c'; ctx.fillRect(x + 12, barY, barW, 4);
  ctx.fillStyle = boss.colour;
  ctx.fillRect(x + 12, barY, barW * Math.max(0, Math.min(1, boss.core.hp / boss.core.hpMax)), 4);
  if (state.wave === 25 && !state.forgeEscaped) {
    for (let i = 0; i < FORGE_SEGMENTS; i++) {
      ctx.fillStyle = i < boss.pods ? '#dfae69' : '#293336';
      ctx.fillRect(x + 12 + i * barW / FORGE_SEGMENTS, barY + (compact ? 6 : 8), barW / FORGE_SEGMENTS - 3, 2);
    }
  }
  ctx.textAlign = 'center';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#d6e5e6';
  ctx.fillText(boss.instruction, width / 2, top + (compact ? 33 : 47), w - 20);
  ctx.restore();
}
