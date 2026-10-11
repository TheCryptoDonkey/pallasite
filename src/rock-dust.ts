import type { AsteroidType, GameState } from './types.js';
import { liveRockImpacts, ROCK_DUST_LIFETIME_MS } from './level-one-impacts.js';

type Grain = 'chip' | 'flake' | 'crystal' | 'splinter' | 'bead';
interface DustMaterial {
  powder: string; grain: string; highlight: string; shape: Grain;
  haze: number; spread: number; size: number; sparks?: string;
}
// Match the Ultra rock materials; each has its own powder, silhouette and motion.
export const ROCK_DUST: Record<AsteroidType, DustMaterial> = {
  stony: { powder: '179,157,125', grain: '#bba080', highlight: '#ead6b6', shape: 'chip', haze: .85, spread: 1, size: 1 },
  iron: { powder: '127,148,171', grain: '#8eabc0', highlight: '#e5f4ff', shape: 'splinter', haze: .2, spread: 1.35, size: .85, sparks: '#ffc982' },
  chondrite: { powder: '158,181,184', grain: '#9fafaa', highlight: '#d4e4d9', shape: 'bead', haze: .75, spread: .8, size: .8 },
  pallasite: { powder: '131,157,94', grain: '#a6c653', highlight: '#e6f5ab', shape: 'crystal', haze: .35, spread: 1.1, size: 1.25, sparks: '#fff1bc' },
  carbonaceous: { powder: '98,91,116', grain: '#6f667e', highlight: '#aba0b6', shape: 'flake', haze: 1, spread: .65, size: 1.35 },
  mesosiderite: { powder: '164,139,131', grain: '#bf9385', highlight: '#e9d6ca', shape: 'chip', haze: .5, spread: 1.1, size: 1.2, sparks: '#dcefff' },
  achondrite: { powder: '184,112,91', grain: '#b86650', highlight: '#f6b08c', shape: 'chip', haze: .85, spread: .95, size: 1.15 },
  kinetic: { powder: '90,184,175', grain: '#56beb7', highlight: '#c8fff3', shape: 'splinter', haze: .25, spread: 1.6, size: .8, sparks: '#8ffff0' },
  volatile: { powder: '171,97,68', grain: '#dd7847', highlight: '#ffe0a3', shape: 'flake', haze: .9, spread: 1.45, size: 1, sparks: '#ffab5b' },
  ballast: { powder: '117,135,158', grain: '#788aab', highlight: '#b7cbe5', shape: 'chip', haze: .65, spread: .55, size: 1.65 },
  tektite: { powder: '78,150,123', grain: '#53b18b', highlight: '#d3ffe8', shape: 'splinter', haze: .12, spread: 1.75, size: 1.3 },
  lodestone: { powder: '139,96,141', grain: '#b16aaa', highlight: '#f4c7eb', shape: 'crystal', haze: .35, spread: .9, size: 1, sparks: '#f6bbeb' },
};
const puffs = new Map<AsteroidType, HTMLCanvasElement>();
function dustPuff(type: AsteroidType): HTMLCanvasElement {
  let puff = puffs.get(type);
  if (!puff) {
    puff = document.createElement('canvas'); puff.width = puff.height = 64;
    const c = puff.getContext('2d')!, g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    const rgb = ROCK_DUST[type].powder;
    g.addColorStop(0, `rgba(${rgb},.52)`); g.addColorStop(.4, `rgba(${rgb},.24)`); g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g; c.fillRect(0, 0, 64, 64); puffs.set(type, puff);
  }
  return puff;
}
function grain(ctx: CanvasRenderingContext2D, m: DustMaterial, r: number): void {
  ctx.beginPath();
  if (m.shape === 'bead') ctx.ellipse(0, 0, r, r * .8, 0, 0, Math.PI * 2);
  else if (m.shape === 'crystal') {
    ctx.moveTo(-r, 0); ctx.lineTo(-r * .35, -r * .7); ctx.lineTo(r * .55, -r * .45);
    ctx.lineTo(r, 0); ctx.lineTo(r * .3, r * .8); ctx.lineTo(-r * .55, r * .5); ctx.closePath();
  }
  else {
    const width = m.shape === 'splinter' ? .28 : m.shape === 'flake' ? .42 : .7;
    ctx.moveTo(-r, -r * width); ctx.lineTo(r * .35, -r * width * 1.4);
    ctx.lineTo(r, r * width * .5); ctx.lineTo(-r * .45, r * width); ctx.closePath();
  }
  ctx.fill();
  ctx.strokeStyle = m.highlight; ctx.lineWidth = .55; ctx.beginPath();
  ctx.moveTo(-r * .6, -r * .25); ctx.lineTo(r * .3, -r * .4); ctx.stroke();
}
/** Entirely analytic: no gameplay RNG, physics, snapshots or wall-clock animation. */
export function drawRockDust(ctx: CanvasRenderingContext2D, s: GameState, low: boolean, reduced: boolean): void {
  ctx.save(); ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over';
  for (const hit of liveRockImpacts(s)) {
    const age = (s.elapsed - hit.time) / 1000;
    const fade = Math.pow(Math.max(0, 1 - age / (ROCK_DUST_LIFETIME_MS / 1000)), 1.8);
    const count = low || reduced ? 6 : 16;
    const broken = hit.kind === 'break', energy = Math.min(1.5, hit.speed / 80);
    const mass = broken ? Math.min(1.8, Math.max(.7, (hit.radius ?? 20) / 25)) : .7;
    for (let i = 0; i < count; i++) {
      const type = hit.otherType && i % 2 ? hit.otherType : hit.type, m = ROCK_DUST[type];
      const angle = i * 2.399963 + hit.time * .001;
      const speed = (14 + i % 5 * 9) * energy * m.spread * (reduced ? .35 : 1);
      // Breaking throws debris radially; contacts eject sideways from the surface.
      const side = hit.otherType && i % 2 ? -1 : 1;
      const dx = broken ? Math.cos(angle) * speed : -hit.ny * Math.cos(angle) * speed + side * hit.nx * Math.abs(Math.sin(angle)) * speed * .45;
      const dy = broken ? Math.sin(angle) * speed : hit.nx * Math.cos(angle) * speed + side * hit.ny * Math.abs(Math.sin(angle)) * speed * .45;
      const travel = m.shape === 'flake' ? age * .65 : age;
      const x = hit.x + hit.vx * age + dx * travel, y = hit.y + hit.vy * age + dy * travel;
      const r = (3 + age * (m.shape === 'flake' ? 14 : 9)) * mass * (1 + i % 3 * .25);
      ctx.globalAlpha = fade * m.haze;
      if (m.haze > .15) ctx.drawImage(dustPuff(type), x - r, y - r, r * 2, r * 2);
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle + (reduced ? 0 : age * (i % 2 ? -2 : 3)));
      ctx.globalAlpha = fade * .95; ctx.fillStyle = i % 3 ? m.grain : m.highlight;
      grain(ctx, m, (1.3 + i % 3 * .5) * m.size * mass);
      // A few brief glints, rather than making the whole dust cloud glow.
      if (m.sparks && !reduced && i % 4 === 0 && age < .28) {
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = (1 - age / .28) * .8;
        ctx.strokeStyle = m.sparks; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(-3 - energy * 3, 0); ctx.lineTo(2, 0); ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}
