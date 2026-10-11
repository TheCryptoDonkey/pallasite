import type { AsteroidType } from './types.js';

interface MineralShard {
  colour: string; accent: string; metal: number; rough: number;
  stretch: readonly [number, number, number];
}
/** Collectible fragments match the mineral, while gold coins retain their SAT identity. */
export const MINERAL_SHARDS: Record<AsteroidType, MineralShard> = {
  stony: { colour: '#bfa886', accent: '#ead8b8', metal: .05, rough: .9, stretch: [.9, .8, .7] },
  iron: { colour: '#aebfd1', accent: '#e3f1ff', metal: .92, rough: .25, stretch: [1.1, .6, .3] },
  chondrite: { colour: '#a7cbd1', accent: '#e6ede0', metal: .08, rough: .85, stretch: [.78, .8, .78] },
  pallasite: { colour: '#b4d957', accent: '#b1c4b1', metal: .3, rough: .3, stretch: [.8, 1.12, .65] },
  carbonaceous: { colour: '#776784', accent: '#b3a0bd', metal: .02, rough: 1, stretch: [1.12, .8, .2] },
  mesosiderite: { colour: '#c49b88', accent: '#dbe1df', metal: .65, rough: .45, stretch: [.95, .9, .55] },
  achondrite: { colour: '#db8867', accent: '#ffd3ad', metal: .05, rough: .88, stretch: [.9, .93, .6] },
  kinetic: { colour: '#6cded4', accent: '#d1fff4', metal: .55, rough: .28, stretch: [.55, 1.12, .4] },
  volatile: { colour: '#f39355', accent: '#ffe1a4', metal: .12, rough: .6, stretch: [.92, .83, .65] },
  ballast: { colour: '#8fa8cf', accent: '#d2e1ef', metal: .5, rough: .7, stretch: [1.08, .88, .8] },
  tektite: { colour: '#68ddb0', accent: '#d8ffea', metal: .22, rough: .12, stretch: [.46, 1.28, .32] },
  lodestone: { colour: '#cc87c6', accent: '#ffe0f4', metal: .8, rough: .32, stretch: [.75, 1.05, .5] },
};
export const DEFAULT_SHARD_TYPE: AsteroidType = 'pallasite';

// Shared faceted body for the live instanced meshes and the baked canvas plates.
// Positions already use the game's 3D axes (Y up, Z toward the camera).
export const SHARD_VERTICES: readonly (readonly [number, number, number])[] = (() => {
  const vertices: [number, number, number][] = [[0, 1.05, 0]];
  for (const [row, [radius, height]] of [[.58, .55], [.91, -.05], [.49, -.65]].entries()) {
    for (let i = 0; i < 7; i++) {
      const a = i * Math.PI * 2 / 7 + row * .14, r = radius * (1 + .12 * Math.sin(i * 3 + row));
      vertices.push([r * Math.cos(a), height + .08 * Math.sin(i * 2), -r * Math.sin(a)]);
    }
  }
  vertices.push([.12, -1, .08]); return vertices;
})();
export const SHARD_FACES: readonly (readonly [number, number, number])[] = (() => {
  const faces: [number, number, number][] = [];
  for (let i = 0; i < 7; i++) {
    const n = (i + 1) % 7;
    faces.push([0, 1 + i, 1 + n], [22, 15 + n, 15 + i]);
    for (let row = 0; row < 2; row++) {
      const j = 1 + row * 7;
      faces.push([j + i, j + 7 + i, j + n], [j + n, j + 7 + i, j + 7 + n]);
    }
  }
  return faces;
})();
export function shardAccentFace(index: number): boolean { return index % 11 === 5 || index % 13 === 8; }

const plates = new Map<string, HTMLCanvasElement>();
/** A bounded, lit turntable fallback, including thin metal and glass silhouettes. */
export function mineralShardPlate(type: AsteroidType, frame: number): HTMLCanvasElement {
  const key = `${type}:${frame}`; const existing = plates.get(key); if (existing) return existing;
  const m = MINERAL_SHARDS[type], phase = frame * Math.PI * 2 / 16;
  const rx = .32 + .18 * Math.sin(phase), ry = phase, rz = phase * .5;
  const vertices = SHARD_VERTICES.map(v => {
    const x = v[0] * m.stretch[0], y = v[1] * m.stretch[1], z = v[2] * m.stretch[2];
    const a = x * Math.cos(rz) - y * Math.sin(rz), b = x * Math.sin(rz) + y * Math.cos(rz);
    const c = a * Math.cos(ry) + z * Math.sin(ry), d = -a * Math.sin(ry) + z * Math.cos(ry);
    return [c, b * Math.cos(rx) - d * Math.sin(rx), b * Math.sin(rx) + d * Math.cos(rx)];
  });
  const plate = document.createElement('canvas'); plate.width = plate.height = 64;
  const ctx = plate.getContext('2d')!;
  const faces = SHARD_FACES.map((face, i) => ({face, i, depth: face.reduce((sum, v) => sum + vertices[v][2], 0)})).sort((a,b) => a.depth - b.depth);
  for (const {face, i} of faces) {
    const [a,b,c] = face.map(v => vertices[v]);
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,len=Math.hypot(nx,ny,nz)||1;
    const light = Math.max(0, (-nx*.4+ny*.55+nz*.72)/len);
    const shine = Math.pow(light, 6) * (1 - m.rough) * .5;
    const colour = shardAccentFace(i) ? m.accent : m.colour;
    const rgb = [1,3,5].map(j => parseInt(colour.slice(j,j+2),16));
    ctx.fillStyle = `rgb(${rgb.map(v => Math.min(255, Math.round(v*(.4+light*.75)+shine*255))).join(',')})`;
    ctx.beginPath(); face.forEach((v,j) => {const p=vertices[v];if(j===0)ctx.moveTo(32+p[0]*21,32-p[1]*21);else ctx.lineTo(32+p[0]*21,32-p[1]*21);});ctx.closePath();ctx.fill();
  }
  // Twelve materials by sixteen frames, never keyed by pickup identity or time.
  plates.set(key,plate); return plate;
}
