/**
 * WebGL overlay for the MESH visual tier. Sits over the 2D canvas and
 * renders only the entities the player has opted into mesh tier for.
 *
 * three.js is statically imported here, but THIS module is dynamically
 * imported by the consumer (visual-style.ts / render.ts). Vite splits
 * the resulting chunk so the base bundle stays free of three.js until a
 * user actually flips a category to MESH.
 *
 * Coordinate system:
 *   World is Y down (screen convention). The default campaign world is
 *   1280×720; modes with larger worlds pass their dimensions at render time.
 *   The
 *   OrthographicCamera uses three.js's standard Y-up frustum
 *   (top=worldH, bottom=0); mesh positions invert Y at the boundary
 *   (mesh.position.y = worldH - a.pos.y), and rotation is negated
 *   so the apparent spin direction matches the 2D path.
 *
 *   The Y-flipped projection alternative looked correct mathematically
 *   but tripped three.js's per-mesh frustum culling, which silently
 *   skipped every draw. We bypass culling anyway (frustumCulled =
 *   false) because our scene is tiny.
 */

import * as THREE from 'three';
import type { Asteroid, PowerUp, PowerUpType, Ship, Ufo } from '../types.js';
import { POWERUP_CONFIG, POWERUP_RADIUS, UFO_RADIUS, WORLD_W, WORLD_H } from '../types.js';
import { getMemberImage } from '../sanctum-avatars.js';
import { getFlavour } from '../flavour.js';
import { DEPTH_CONFIGS } from '../parallax.js';

function mobileOverlayRuntime(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const uaMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  // Match visual-style.ts mobileRuntimeActive: a modern iPad reports a Mac UA,
  // so detect it via touch points or the overlay runs with antialias +
  // preserveDrawingBuffer (the desktop path) on iPad Sanctum and stutters.
  const iPadAsMac = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const coarse = (() => {
    try { return window.matchMedia?.('(pointer: coarse)').matches === true; }
    catch { return false; }
  })();
  const smallViewport = Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 640
    || Math.max(window.innerWidth || 0, window.innerHeight || 0) <= 960;
  return uaMobile || iPadAsMac || ((coarse || touch) && smallViewport);
}

interface OverlayHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  canvas: HTMLCanvasElement;
  /** Per-asteroid mesh cache. Keyed by asteroid id; entries hold the
   *  Mesh + the procedural BufferGeometry, both shared across frames so
   *  long as the asteroid lives. Disposed when the asteroid is gone. */
  asteroidMeshes: Map<number, MeshEntry<THREE.MeshPhongMaterial>>;
  /** Per-UFO mesh cache, same pattern as asteroidMeshes. */
  ufoMeshes: Map<number, MeshEntry<THREE.Material>>;
  /** Per-powerup mesh cache, keyed by powerup id. */
  powerupMeshes: Map<number, MeshEntry<THREE.Material>>;
  /** Diffuse textures per asteroid type, kept alive across the renderer's
   *  lifetime — 4 textures total, each ~265-360KB raw. */
  diffuseCache: Map<string, THREE.Texture>;
  /** Per-council-member portrait texture cache. */
  councilTextureCache: Map<string, THREE.Texture>;
  /** Per-slot ship meshes — built lazily on each slot's first ship
   *  frame. Index 0 = player slot 0, etc. A slot with no mesh yet is
   *  null; an unused slot keeps a hidden mesh around (rebuild is more
   *  expensive than holding 50KB of geometry). */
  shipMeshes: (THREE.Object3D | null)[];
  shipThrusts: (THREE.Mesh | null)[];
  /** Per-slot identity tint the cached mesh was built with (null = the
   *  default cyan hull). Tracked so a slot whose tint changes between runs
   *  in the same page session — e.g. solo (untinted) → couch 2P (green/blue)
   *  reusing this handle — rebuilds instead of keeping the stale colour. */
  shipMeshTints: (string | null)[];
  /** Per-slot shield dome — built lazily on each slot's first
   *  shield-up frame. Faceted icosphere + edge wireframe parented
   *  under one group per slot so a single position.set() per frame
   *  is enough to track the corresponding ship. */
  shieldMeshes: (THREE.Group | null)[];
  shieldSphereMats: (THREE.MeshPhongMaterial | null)[];
  shieldEdgeMats: (THREE.LineBasicMaterial | null)[];
  /** Cached canvas.width × canvas.height so setSize only fires on
   *  actual size change (always-on setSize re-clears every frame). */
  lastSizeKey: number;
  /** Live ship-explosion chunk meshes — flies outward + tumbles + fades.
   *  Spawned by spawnShipMeshExplosion(), ticked per frame in
   *  renderOverlay, removed when ttl <= 0. */
  shipChunks: ShipChunk[];
  /** Wall-clock ms of the previous renderOverlay call; used to derive
   *  dt for the chunk physics tick (renderOverlay doesn't take a dt
   *  argument from callers). */
  lastFrameMs: number;
  worldW: number;
  worldH: number;
}

interface ShipChunk {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshPhongMaterial;
  vel: { x: number; y: number; z: number };
  rotVel: { x: number; y: number; z: number };
  ttl: number;
  maxTtl: number;
}

interface MeshEntry<M extends THREE.Material> {
  mesh: THREE.Mesh | THREE.Group;
  geometry: THREE.BufferGeometry;
  material: M;
  lastSeenFrame: number;
  /** Radius the geometry was built at. Mesh.scale tracks the live
   *  asteroid radius / builtRadius so runtime shrinks (council
   *  members losing mass per hit) read visually without rebuilding
   *  the GPU geometry. */
  builtRadius: number;
}

/** Per-type fallback base colour. Brighter than the visible-against-
 *  dark-bg minimum: with the dark space backdrop, the unlit hemisphere
 *  of a rock blends into the background and the player only sees the
 *  lit silhouette, which reads as "see-through". Brighter base colour
 *  + ambient fill (see lights) keeps the unlit side readable so the
 *  rock reads as a solid body. */
const ASTEROID_TYPE_COLOR: Record<string, number> = {
  stony:        0xd0c0a8,
  iron:         0xe0c898,
  chondrite:    0xd8e4ee,
  pallasite:    0xf0c860,
  // New types — base colour shown until the diffuse webp finishes
  // loading; chosen to read as the type when seen against space.
  carbonaceous: 0x4a4858,  // very dark, primitive
  mesosiderite: 0xc8a880,  // bronze stony-iron
  achondrite:   0xc06848,  // basaltic red
  // Behavioural types — flat-coloured 3D rocks tinting a reused rock webp.
  kinetic:      0x3ad6c8,  // electric teal
  volatile:     0xff8a2a,  // hot orange
  ballast:      0x6c8cb8,  // dull steel blue
  tektite:      0x5fe0a0,  // glassy green
  lodestone:    0xd060e0,  // magnetic magenta
};

/** Per-type Phong tuning — specular highlight + shininess. Real rocks
 *  are mostly matte; only pallasite (olivine inclusions) reads as
 *  gem-like. Previous values were too high across the board and were
 *  producing per-facet specular hotspots that read as a ball of shards
 *  rather than a solid lit body. Pallasite kept at 110 because that
 *  one was already landing well. */
interface AsteroidTypeMaterial {
  shininess: number;
  specular: number;
  /** Self-illumination — gives the behavioural types a mesh-tier glow
   *  tell. Omitted (treated as 0) for the inert meteorite types. */
  emissive?: number;
}
const ASTEROID_TYPE_MAT: Record<string, AsteroidTypeMaterial> = {
  stony:        { shininess: 18,  specular: 0x404040 },
  iron:         { shininess: 50,  specular: 0x806840 },
  chondrite:    { shininess: 8,   specular: 0x202830 },
  pallasite:    { shininess: 110, specular: 0xd0a040 },
  // Very matte, very dark — primitive material absorbs nearly all
  // light. Just enough specular to catch the rim light.
  carbonaceous: { shininess: 4,   specular: 0x181820 },
  // Semi-metallic — patches of iron sheen between stony zones.
  mesosiderite: { shininess: 70,  specular: 0x806040 },
  // Volcanic basalt — matte with a hint of glaze from fusion crust.
  achondrite:   { shininess: 22,  specular: 0x4a2818 },
  // Behavioural types — emissive gives the mesh tier its glow tell.
  kinetic:      { shininess: 60,  specular: 0x308078, emissive: 0x0c3a34 },
  volatile:     { shininess: 40,  specular: 0x804020, emissive: 0x5a2008 },
  ballast:      { shininess: 30,  specular: 0x303840, emissive: 0x000000 },
  tektite:      { shininess: 95,  specular: 0x70b090, emissive: 0x0c3826 },
  lodestone:    { shininess: 70,  specular: 0x603068, emissive: 0x381040 },
};

/** Per-UFO-type palette + form factor. */
const UFO_PALETTE: Record<Ufo['type'], { body: number; dome: number; glow: number; scale: number }> = {
  cruiser: { body: 0xff8a3a, dome: 0xffe9c0, glow: 0xff6020, scale: 1.0 },
  elite:   { body: 0xff5050, dome: 0xff9090, glow: 0xff3030, scale: 1.1 },
  tank:    { body: 0xff3a3a, dome: 0xff7070, glow: 0xff2020, scale: 1.3 },
  sniper:  { body: 0x7fffea, dome: 0xcffffd, glow: 0x30c0a0, scale: 0.9 },
  boss:    { body: 0xff5050, dome: 0xffd84a, glow: 0xffd84a, scale: 1.6 },
};

let handle: OverlayHandle | null = null;
let loading: Promise<OverlayHandle> | null = null;
let frameCounter = 0;
let meshPrewarmDone = false;
const meshPrewarmKeepAlive: THREE.Object3D[] = [];

/** ── Asteroid geometry ────────────────────────────────────────────────
 *  Displaced icosphere with three distinct displacement layers:
 *
 *    1. The 2D `shape[]` array drives the longitudinal silhouette so
 *       the 3D body echoes the 2D outline the player saw on lower tiers.
 *    2. Five octaves of trig-product noise add bumpy surface texture.
 *    3. A crater pass carves bowl-shaped depressions at 4-6 deterministic
 *       points on the sphere — the thing that turns "lumpy ball" into
 *       "actual asteroid".
 *
 *  Plus per-asteroid asymmetric scale so no two rocks have the same
 *  silhouette even before the shape array kicks in.
 *
 *  Council asteroids get a planar UV remap so their portrait reads
 *  front-on rather than wrapping around the sphere like an equirect
 *  projection.
 */
function buildAsteroidGeometry(a: Asteroid): THREE.BufferGeometry {
  // Detail dropped from 5/4/3 (up to 10242 verts) to 3/2/2 (642/162/162).
  // Combined with the continuous-noise fix below, fewer verts read as
  // SMOOTHER, not rougher — the previous high-detail meshes were just
  // producing per-vertex spike chaos. Real game-ready asteroid models
  // (the reference packs you linked) sit around 1–3k tris.
  const detail = a.size === 'large' ? 3 : a.size === 'medium' ? 2 : 2;
  const geo = new THREE.IcosahedronGeometry(a.radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const shape = a.shape;
  const shapeN = shape.length;
  const seedBase = a.id != null
    ? ((a.id * 2654435761) >>> 0)
    : hashStr(`${a.pos.x | 0},${a.pos.y | 0}`);
  // Gentler ruggedness than before. With the continuous-noise fix the
  // same numeric value reads as smooth lumps where it previously read
  // as spike-balls; we can back off and still look "rocky" rather than
  // "ball of glass shards".
  const ruggedness = a.type === 'chondrite' ? 0.20
                   : a.type === 'iron'      ? 0.16
                   : a.type === 'pallasite' ? 0.10
                                            : 0.16;
  const stretchX = 0.85 + ((seedBase >>> 0) & 0xff) / 0xff * 0.3;       // 0.85..1.15
  const stretchY = 0.85 + ((seedBase >>> 8) & 0xff) / 0xff * 0.3;
  const stretchZ = 0.85 + ((seedBase >>> 16) & 0xff) / 0xff * 0.3;
  // CRITICAL: per-asteroid noise phase offsets, computed ONCE outside
  // the per-vertex loop. The previous code derived these from a seed
  // that included the vertex index — so adjacent vertices used
  // completely different sine phases and ended up independently
  // displaced, producing a ball of spikes instead of a continuous
  // lumpy surface. Pulling them out makes the noise function
  // continuous across the sphere.
  const p1 = (seedBase & 0x3ff) * 0.01;
  const p2 = ((seedBase >>> 10) & 0x3ff) * 0.011;
  const p3 = ((seedBase >>> 20) & 0x3ff) * 0.013;
  // Crater pass — bowl depressions at 3-6 deterministic points.
  // Depths roughly halved (was 0.10–0.28) so they read as visible
  // dimples rather than gouges.
  const craterCount = 3 + (seedBase & 0x3);
  const craters: Array<{ cx: number; cy: number; cz: number; r: number; depth: number }> = [];
  for (let c = 0; c < craterCount; c++) {
    const s = (seedBase * (c + 1) * 2654435761) >>> 0;
    const theta = ((s & 0xffff) / 0xffff) * Math.PI * 2;
    const z01 = ((s >>> 16) & 0xffff) / 0xffff * 2 - 1;
    const rxy = Math.sqrt(1 - z01 * z01);
    craters.push({
      cx: Math.cos(theta) * rxy,
      cy: Math.sin(theta) * rxy,
      cz: z01,
      r: 0.22 + ((s >>> 4) & 0xff) / 0xff * 0.18,             // 0.22..0.40
      depth: 0.08 + ((s >>> 12) & 0xff) / 0xff * 0.10,        // 0.08..0.18
    });
  }
  for (let i = 0; i < n; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const ang = Math.atan2(y, x);
    const t = (ang / (Math.PI * 2) + 1) % 1;
    const f = t * shapeN;
    const i0 = Math.floor(f) % shapeN;
    const i1 = (i0 + 1) % shapeN;
    const blend = f - Math.floor(f);
    const shapeR = shape[i0] * (1 - blend) + shape[i1] * blend;
    // Three-octave continuous noise — big lumps, medium bumps, small
    // surface roughness. Dropped the 21/42-Hz octaves entirely; on a
    // 642-vert sphere those were just spatial aliasing.
    const r0 = Math.hypot(x, y, z) || 1;
    const ux = x / r0, uy = y / r0, uz = z / r0;
    const n1 = Math.sin(ux * 2.0 + p1) * Math.sin(uy * 1.7 + p2) * Math.sin(uz * 2.3 + p3);
    const n2 = Math.sin(ux * 4.3 + p2) * Math.sin(uy * 4.7 + p3) * Math.sin(uz * 4.1 + p1);
    const n3 = Math.sin(ux * 8.5 + p3) * Math.sin(uy * 8.1 + p1) * Math.sin(uz * 8.7 + p2);
    const bumps = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
    let craterDepth = 0;
    for (const c of craters) {
      const d = Math.hypot(ux - c.cx, uy - c.cy, uz - c.cz);
      if (d < c.r) {
        const t2 = d / c.r;
        const fall = 1 - t2 * t2 * (3 - 2 * t2);
        craterDepth = Math.max(craterDepth, c.depth * fall);
      }
    }
    const scale = shapeR + bumps * ruggedness - craterDepth;
    x *= scale * stretchX;
    y *= scale * stretchY;
    z *= scale * stretchZ;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

/** Maps an asteroid type to the webp diffuse it loads. The five
 *  behavioural types have no bespoke texture, so they reuse the nearest
 *  stock rock surface; their identity comes from the base colour tint and
 *  their behaviour, not the diffuse. Avoids a 404 per new-type mesh. */
function diffuseTypeFor(type: string): string {
  switch (type) {
    case 'kinetic':   return 'chondrite';
    case 'volatile':  return 'iron';
    case 'ballast':   return 'stony';
    case 'tektite':   return 'chondrite';
    case 'lodestone': return 'pallasite';
    default:          return type;
  }
}

/** Build (or fetch from cache) the diffuse texture for an asteroid type.
 *  Returns null when the texture hasn't been loaded yet — the caller
 *  shows the material's base colour until kickDiffuseLoad's callback
 *  fires. */
function getDiffuseTexture(h: OverlayHandle, type: string): THREE.Texture | null {
  return h.diffuseCache.get(type) ?? null;
}

function kickDiffuseLoad(h: OverlayHandle, type: string, attachTo: THREE.MeshPhongMaterial, isCouncil: boolean): void {
  const existing = h.diffuseCache.get(type);
  if (existing) {
    if (!isCouncil) {
      // Council members get their portrait as the diffuse; the rock
      // texture must NOT be attached or it would stomp the portrait
      // when this load completes after the portrait one (current code
      // path used to do exactly that).
      attachTo.map = existing;
      attachTo.bumpMap = existing;
      attachTo.bumpScale = 0.35;
    }
    attachTo.needsUpdate = true;
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.load(`/backgrounds/asteroid-${type}.webp`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    h.diffuseCache.set(type, tex);
    if (!isCouncil) {
      attachTo.map = tex;
      // Bump-mapping the diffuse gives free micro-detail: the
      // luminance variation in the rock webp drives surface height
      // perturbation under lighting. Subtle bumpScale because the
      // textures have strong colour contrast that would over-bump.
      attachTo.bumpMap = tex;
      attachTo.bumpScale = 0.35;
      attachTo.needsUpdate = true;
    }
  });
}

/** ── Council medallion ───────────────────────────────────────────────
 *  Council members render as flat round medallions (like the 600bn
 *  coin). Front face shows the member's portrait inside a gold rim;
 *  back face shows their role + archetype in serif type on a sacred-
 *  stone gradient. The rock tumbles around its Y axis with small X/Z
 *  wobble so both faces flash past, and the chip below the asteroid
 *  (drawn in render.ts) carries the name + role for redundancy.
 *
 *  Spherical-asteroid approach was abandoned because the planar UV
 *  projection of the portrait stretched as the rock rotated — players
 *  couldn't recognise members at-a-glance. A flat medallion sidesteps
 *  the projection problem entirely: when the face is toward camera
 *  the portrait reads cleanly; when not, you see the back or edge. */
const COUNCIL_FRONT_TEX = new Map<string, THREE.CanvasTexture>();
const COUNCIL_BACK_TEX = new Map<string, THREE.CanvasTexture>();
/** Tracks which front textures already have the portrait drawn into
 *  them — so per-frame `ensureCouncilFrontPortrait` is a single Map
 *  lookup once the image has landed. */
const COUNCIL_FRONT_PORTRAIT_DRAWN = new Set<string>();

const COUNCIL_TEX_SIZE = 384;

function paintCouncilCoinBase(ctx: CanvasRenderingContext2D, gold: boolean): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = w / 2 - 4;
  const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, r);
  if (gold) {
    grad.addColorStop(0, '#ffe0e0');
    grad.addColorStop(0.5, '#d62020');
    grad.addColorStop(1, '#3a0000');
  } else {
    grad.addColorStop(0, '#241834');
    grad.addColorStop(0.7, '#0a0418');
    grad.addColorStop(1, '#000010');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Outer rim.
  ctx.strokeStyle = gold ? '#4a0000' : '#ff4040';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
  ctx.stroke();
}

function getCouncilFrontTexture(member: NonNullable<Asteroid['councilMember']>): THREE.CanvasTexture {
  const cached = COUNCIL_FRONT_TEX.get(member.name);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = COUNCIL_TEX_SIZE; c.height = COUNCIL_TEX_SIZE;
  const ctx = c.getContext('2d')!;
  paintCouncilCoinBase(ctx, true);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  COUNCIL_FRONT_TEX.set(member.name, tex);
  return tex;
}

/** Draw the portrait into the front-face canvas if it hasn't been
 *  done yet AND the portrait image has decoded. Returns true once
 *  the portrait is in place. Cheap to call every frame: short-
 *  circuits after the first successful draw. */
function ensureCouncilFrontPortrait(member: NonNullable<Asteroid['councilMember']>): void {
  if (COUNCIL_FRONT_PORTRAIT_DRAWN.has(member.name)) return;
  const portrait = getMemberImage(member.name);
  if (!portrait) return;
  const tex = COUNCIL_FRONT_TEX.get(member.name);
  if (!tex) return;
  const c = tex.image as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  const cx = c.width / 2;
  const cy = c.height / 2;
  const portraitR = c.width * 0.36;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, portraitR, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(portrait, cx - portraitR, cy - portraitR, portraitR * 2, portraitR * 2);
  ctx.restore();
  // Dark inner ring + red outer ring around the portrait — frames
  // the face against the coin gradient (council = baddies, not BTC gold).
  ctx.strokeStyle = '#0a0418';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, portraitR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ff4040';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, portraitR + 4, 0, Math.PI * 2);
  ctx.stroke();
  // Member name in a strip below the portrait.
  ctx.fillStyle = '#0a0418';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 26px Georgia, serif';
  ctx.fillText(member.name.toUpperCase(), cx, cy + portraitR + 32);
  tex.needsUpdate = true;
  COUNCIL_FRONT_PORTRAIT_DRAWN.add(member.name);
}

function getCouncilBackTexture(member: NonNullable<Asteroid['councilMember']>): THREE.CanvasTexture {
  const cached = COUNCIL_BACK_TEX.get(member.name);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = COUNCIL_TEX_SIZE; c.height = COUNCIL_TEX_SIZE;
  const ctx = c.getContext('2d')!;
  paintCouncilCoinBase(ctx, false);
  // Role big in the centre.
  ctx.fillStyle = '#ff5a5a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 88px Georgia, serif';
  ctx.fillText(member.role, c.width / 2, c.height / 2 - 28);
  // Archetype below — wrap to two lines if longer than fits.
  ctx.fillStyle = '#e0a8a8';
  ctx.font = 'bold 22px ui-monospace, monospace';
  const arch = (member.archetype || '').toUpperCase();
  if (arch.length > 18) {
    const words = arch.split(' ');
    const mid = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, mid).join(' '), c.width / 2, c.height / 2 + 50);
    ctx.fillText(words.slice(mid).join(' '), c.width / 2, c.height / 2 + 80);
  } else {
    ctx.fillText(arch, c.width / 2, c.height / 2 + 60);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  COUNCIL_BACK_TEX.set(member.name, tex);
  return tex;
}

function buildCouncilMedallionMesh(a: Asteroid): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const member = a.councilMember!;
  const r = a.radius;
  const h = r * 0.34;
  const sideMat = new THREE.MeshPhongMaterial({
    color: 0x8a0d0d,
    shininess: 200,
    specular: 0xffb0b0,
  });
  const frontMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getCouncilFrontTexture(member),
    shininess: 220,
    specular: 0xffffff,
  });
  const backMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getCouncilBackTexture(member),
    shininess: 220,
    specular: 0xffffff,
  });
  const geo = new THREE.CylinderGeometry(r, r, h, 64);
  // Rotate so axis points along Z (toward camera). +Z cap = front,
  // -Z cap = back. Cylinder material slot order is [side, top, bot],
  // unchanged by the geometry rotation, so the cap that ends up at
  // +Z (toward camera) is still slot 1 (frontMat).
  geo.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geo, [sideMat, frontMat, backMat]);
  mesh.frustumCulled = false;
  return { mesh, geometry: geo, material: frontMat };
}

/** Trigger async load of three.js + scene construction. Idempotent. */
export function ensureWebGLOverlay(): Promise<OverlayHandle> {
  if (handle) return Promise.resolve(handle);
  if (loading) return loading;
  loading = (async () => {
    const canvas = document.getElementById('game3d') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('WebGL overlay canvas missing');
    const mobile = mobileOverlayRuntime();
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !mobile,
      // Desktop presentation themes can composite the overlay into the 2D
      // canvas (see main.ts applyThemeFrame). Mobile forces theme='none', so
      // avoid the preserved-buffer/readback cost on iOS/Android GPUs.
      preserveDrawingBuffer: !mobile,
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, WORLD_W, WORLD_H, 0, 0.1, 1000);
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);
    console.info('[webgl-overlay] init', {
      canvasW: canvas.width, canvasH: canvas.height,
      pixelRatio: renderer.getPixelRatio(),
    });
    // Lights:
    //   - sun: strong warm key from upper-left-FRONT
    //   - ambient: medium fill so the unlit hemisphere is visible
    //   - rim: strong warm BACK light. Catches the silhouette edge
    //     of every entity so darker rocks read against the dark space
    //     background as if there's a star behind the scene.
    const sun = new THREE.DirectionalLight(0xfff2da, 1.5);
    sun.position.set(-200, -200, 350);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0xa8b0b8, 1.3);
    scene.add(ambient);
    const rim = new THREE.DirectionalLight(0xfff0c0, 2.4);
    rim.position.set(180, 100, -450);
    scene.add(rim);
    handle = {
      renderer, scene, camera, canvas,
      asteroidMeshes: new Map(),
      ufoMeshes: new Map(),
      powerupMeshes: new Map(),
      diffuseCache: new Map(),
      councilTextureCache: new Map(),
      shipMeshes: [],
      shipThrusts: [],
      shipMeshTints: [],
      shieldMeshes: [],
      shieldSphereMats: [],
      shieldEdgeMats: [],
      lastSizeKey: 0,
      shipChunks: [],
      lastFrameMs: 0,
      worldW: WORLD_W,
      worldH: WORLD_H,
    };
    canvas.classList.add('is-active');
    return handle;
  })();
  return loading;
}

export function getReadyOverlay(): OverlayHandle | null {
  return handle;
}

/** ── 600bn coin UFO ──────────────────────────────────────────────────
 *  On 600bn flavour the 2D path renders every UFO as the $600B sacred
 *  number badge (drawSixHundredBnLogoUfo). For 3D parity we build a
 *  gold coin with TWO different faces:
 *
 *    - obverse: the "600/000/000/000" sacred-number wordmark
 *    - reverse: a clock face permanently fixed at 4:20pm, the
 *      time-lock motif
 *
 *  As the coin tumbles in 3D both faces flash past — players catch
 *  one or the other depending on the moment of the rotation. */
let sixHundredBnWordmarkTexture: THREE.CanvasTexture | null = null;
let sixHundredBnClockTexture: THREE.CanvasTexture | null = null;

/** Paint the shared coin base (gold gradient disc + rim). Both faces
 *  start from this so the obverse and reverse read as the same coin. */
function paintCoinBase(ctx: CanvasRenderingContext2D): void {
  const grad = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, '#fff6c0');
  grad.addColorStop(0.5, '#ffd84a');
  grad.addColorStop(1, '#8a5800');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#5a3a00';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(128, 128, 121, 0, Math.PI * 2);
  ctx.stroke();
}

function getSixHundredBnFaceTexture(): THREE.CanvasTexture {
  if (sixHundredBnWordmarkTexture) return sixHundredBnWordmarkTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  paintCoinBase(ctx);
  // 4-line sacred number wordmark — same canonical layout as the 2D
  // game-over card.
  ctx.fillStyle = '#0a0418';
  ctx.font = 'bold 42px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = ['600', '000', '000', '000'];
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], 128, 76 + i * 36);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  sixHundredBnWordmarkTexture = tex;
  return tex;
}

/** Clock face fixed at 4:20pm. Minute hand on the "4" (120° from top),
 *  hour hand at 130° (4 + 20/60 hours = 4.333 × 30°/hour). Reads as
 *  "time-locked" iconography. */
function getSixHundredBnClockTexture(): THREE.CanvasTexture {
  if (sixHundredBnClockTexture) return sixHundredBnClockTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  paintCoinBase(ctx);
  // Hour ticks — 12 around the dial, cardinals (12/3/6/9) drawn bolder.
  ctx.strokeStyle = '#0a0418';
  ctx.lineCap = 'butt';
  for (let h = 0; h < 12; h++) {
    const angle = (h / 12) * Math.PI * 2 - Math.PI / 2;
    const isCardinal = h % 3 === 0;
    const r1 = isCardinal ? 92 : 102;
    const r2 = 115;
    ctx.lineWidth = isCardinal ? 7 : 3;
    ctx.beginPath();
    ctx.moveTo(128 + Math.cos(angle) * r1, 128 + Math.sin(angle) * r1);
    ctx.lineTo(128 + Math.cos(angle) * r2, 128 + Math.sin(angle) * r2);
    ctx.stroke();
  }
  // Roman numerals at the cardinals — gives the coin a heritage feel
  // rather than wristwatch.
  ctx.fillStyle = '#0a0418';
  ctx.font = 'bold 22px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('XII', 128, 38);
  ctx.fillText('III', 218, 128);
  ctx.fillText('VI',  128, 218);
  ctx.fillText('IX',   38, 128);
  // "TIME LOCKED" wordmark above centre.
  ctx.font = 'bold 13px ui-monospace, monospace';
  ctx.fillStyle = '#3a2400';
  ctx.fillText('TIME LOCKED', 128, 78);
  // Hands at 4:20. Canvas angle = degrees-clockwise-from-top minus 90°.
  const handAngle = (degFromTop: number): number => (degFromTop - 90) * Math.PI / 180;
  ctx.strokeStyle = '#0a0418';
  ctx.lineCap = 'round';
  // Minute hand — long, thin — at 4 (= 20 min = 120° from top).
  const minA = handAngle(120);
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(128, 128);
  ctx.lineTo(128 + Math.cos(minA) * 78, 128 + Math.sin(minA) * 78);
  ctx.stroke();
  // Hour hand — short, thick — at 4 + 20 min = 130° from top.
  const hourA = handAngle(130);
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(128, 128);
  ctx.lineTo(128 + Math.cos(hourA) * 52, 128 + Math.sin(hourA) * 52);
  ctx.stroke();
  // Centre boss.
  ctx.fillStyle = '#0a0418';
  ctx.beginPath();
  ctx.arc(128, 128, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffd84a';
  ctx.beginPath();
  ctx.arc(128, 128, 3, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  sixHundredBnClockTexture = tex;
  return tex;
}

function build600bnCoinMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const r = u.radius * 1.6;             // 1.6× matches the 2D oversized badge
  const h = r * 0.38;                    // thick coin — visible depth when it tumbles
  const group = new THREE.Group();
  // Side wall — darker gold ring without text. Higher specular here
  // gives a glinting edge as the coin rotates past the key light.
  const sideMat = new THREE.MeshPhongMaterial({
    color: 0xb87400,
    shininess: 200,
    specular: 0xfff0a0,
  });
  // Obverse: "600/000/000/000" wordmark.
  const obverseMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getSixHundredBnFaceTexture(),
    shininess: 220,
    specular: 0xffffff,
  });
  // Reverse: clock face frozen at 4:20pm (time-lock motif).
  const reverseMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getSixHundredBnClockTexture(),
    shininess: 220,
    specular: 0xffffff,
  });
  // CylinderGeometry material slots: [side, top, bottom]. Geometry
  // built upright (axis along Y); we'll tumble it in renderOverlay.
  const geo = new THREE.CylinderGeometry(r, r, h, 64);
  // Small edge bevel via a slightly smaller torus ring at each cap
  // edge — sells the "milled rim" look without an extrude pass.
  const rimGeo = new THREE.TorusGeometry(r, h * 0.18, 12, 64);
  const rimMat = new THREE.MeshPhongMaterial({
    color: 0xd09000,
    shininess: 240,
    specular: 0xffe080,
  });
  const rimTop = new THREE.Mesh(rimGeo, rimMat);
  rimTop.rotation.x = Math.PI / 2;
  rimTop.position.y = h / 2;
  rimTop.frustumCulled = false;
  const rimBot = new THREE.Mesh(rimGeo, rimMat);
  rimBot.rotation.x = Math.PI / 2;
  rimBot.position.y = -h / 2;
  rimBot.frustumCulled = false;
  const mesh = new THREE.Mesh(geo, [sideMat, obverseMat, reverseMat]);
  mesh.frustumCulled = false;
  group.add(mesh);
  group.add(rimTop);
  group.add(rimBot);
  return { group, geometry: geo, material: obverseMat };
}

/** Build a UFO mesh once per type. Saucer body (squashed cylinder) +
 *  hemisphere dome + emissive cockpit ring + glow underglow. */
/** Each UFO type gets its own bespoke silhouette so the player reads
 *  the threat from shape alone, before colour. Shared helpers below
 *  build the recurring bits (rim port-hole ring, abductor beam) so
 *  per-type builders stay focused on what makes that type unique.
 *
 *  Each built body is wrapped in an outer Group with a baked-in x-tilt
 *  so the orthographic camera sees a 3/4 view (looking down ONTO the
 *  saucer) rather than a flat top-down disc. Per-frame rotation
 *  (banking / direction tracking / wobble) operates on the outer
 *  wrapper so the tilt survives. */
function buildUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  if (getFlavour() === '600bn') return build600bnCoinMesh(u);

  let built: { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial };
  switch (u.type) {
    case 'elite':  built = buildEliteUfoMesh(u); break;
    case 'tank':   built = buildTankUfoMesh(u); break;
    case 'sniper': built = buildSniperUfoMesh(u); break;
    case 'boss':   built = buildBossUfoMesh(u); break;
    case 'cruiser':
    default:       built = buildCruiserUfoMesh(u); break;
  }

  // Cinematic 3/4 tilt. Saucer types (cruiser/elite/tank/boss) tip
  // forward ~32° so the dome reads "up there" and the rim+beam read
  // "down here" — the iconic UFO silhouette instead of a roundel.
  // Sniper is elongated so heavy tilt would flip its dorsal optic to
  // the underside; a gentle roll exposes the side detail without
  // hiding the barrel.
  const inner = built.group;
  inner.rotation.x = u.type === 'sniper' ? -0.18 : -0.55;
  const outer = new THREE.Group();
  outer.add(inner);
  // Mirror every userData ref from the inner build group onto the outer
  // wrapper so renderOverlay's per-frame animation hooks can grab
  // them off entry.mesh without traversing children.
  Object.assign(outer.userData, inner.userData);
  return { group: outer, geometry: built.geometry, material: built.material };
}

/** Shared port-hole rim builder. Returns a Group so renderOverlay can
 *  spin it independently of the parent hull's banking roll. */
function buildRimRing(bodyR: number, glow: number, portCount: number, portR: number, ringZ: number): THREE.Group {
  const ring = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.95 });
  const geo = new THREE.SphereGeometry(portR, 10, 8);
  for (let i = 0; i < portCount; i++) {
    const angle = (Math.PI * 2 * i) / portCount;
    const port = new THREE.Mesh(geo, mat);
    port.position.set(Math.cos(angle) * bodyR, Math.sin(angle) * bodyR, ringZ);
    port.frustumCulled = false;
    ring.add(port);
  }
  return ring;
}

/** Shared abductor-beam cone tapering down from the underbelly. */
function buildAbductorBeam(bodyR: number, glow: number, topZ: number, height: number, opacity: number): THREE.Mesh {
  const geo = new THREE.ConeGeometry(bodyR * 0.7, height, 18, 1, true);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, topZ - height * 0.5);
  const mat = new THREE.MeshBasicMaterial({
    color: glow,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Cruiser — the canonical Roswell saucer. Two-tier hull, dome,
 *  antenna spike + glowing tip, rotating rim of 10 port-holes,
 *  abductor beam. Reads as "basic enemy scout". */
function buildCruiserUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  const bodyR = u.radius * palette.scale;
  const bodyH = bodyR * 0.22;

  const bodyGeo = new THREE.CylinderGeometry(bodyR * 0.85, bodyR, bodyH, 32);
  bodyGeo.rotateX(Math.PI / 2);
  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body, shininess: 60, specular: 0xa0a0a0,
    emissive: palette.glow, emissiveIntensity: 0.18,
  });
  group.add(setupMesh(new THREE.Mesh(bodyGeo, bodyMat)));

  const baseGeo = new THREE.CylinderGeometry(bodyR, bodyR * 0.6, bodyH * 0.65, 32);
  baseGeo.rotateX(Math.PI / 2);
  baseGeo.translate(0, 0, -bodyH * 0.6);
  group.add(setupMesh(new THREE.Mesh(baseGeo, bodyMat)));

  const ringGroup = buildRimRing(bodyR * 0.95, palette.glow, 10, bodyR * 0.07, -bodyH * 0.05);
  group.add(ringGroup);

  const domeR = bodyR * 0.55;
  const domeGeo = new THREE.SphereGeometry(domeR, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateX(-Math.PI / 2);
  domeGeo.translate(0, 0, bodyH * 0.4);
  const domeMat = new THREE.MeshPhongMaterial({
    color: palette.dome, shininess: 200, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 0.55,
    transparent: true, opacity: 0.82,
  });
  group.add(setupMesh(new THREE.Mesh(domeGeo, domeMat)));

  const antennaH = bodyR * 0.42;
  const antennaGeo = new THREE.CylinderGeometry(bodyR * 0.02, bodyR * 0.045, antennaH, 8);
  antennaGeo.rotateX(Math.PI / 2);
  antennaGeo.translate(0, 0, bodyH * 0.4 + domeR + antennaH * 0.5);
  group.add(setupMesh(new THREE.Mesh(antennaGeo, new THREE.MeshPhongMaterial({
    color: 0x909090, shininess: 100, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 0.1,
  }))));

  const tipMat = new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
  });
  const tipGeo = new THREE.SphereGeometry(bodyR * 0.075, 10, 8);
  tipGeo.translate(0, 0, bodyH * 0.4 + domeR + antennaH + bodyR * 0.04);
  group.add(setupMesh(new THREE.Mesh(tipGeo, tipMat)));

  // 4 radial horns at the cardinal rim positions — short stubby antennas
  // that read as comm / sensor protrusions. Adds silhouette interest.
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i + Math.PI / 4;
    const hornR = bodyR * 0.025;
    const hornL = bodyR * 0.16;
    const hornGeo = new THREE.CylinderGeometry(hornR * 0.5, hornR, hornL, 6);
    hornGeo.rotateZ(Math.PI / 2);
    hornGeo.translate(bodyR + hornL * 0.45, 0, bodyH * 0.05);
    const horn = new THREE.Mesh(hornGeo, bodyMat);
    horn.frustumCulled = false;
    horn.rotation.z = angle;
    group.add(horn);
  }

  // Bottom comm mast — small downward antenna with its own glowing tip.
  // Doubles the antenna read so the saucer feels properly instrumented.
  const mastH = bodyR * 0.28;
  const mastGeo = new THREE.CylinderGeometry(bodyR * 0.025, bodyR * 0.04, mastH, 6);
  mastGeo.rotateX(Math.PI / 2);
  mastGeo.translate(0, 0, -bodyH * 0.6 - mastH * 0.5);
  group.add(setupMesh(new THREE.Mesh(mastGeo, new THREE.MeshPhongMaterial({
    color: 0x707070, shininess: 60,
    emissive: palette.glow, emissiveIntensity: 0.15,
  }))));
  const mastTipMat = new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
  });
  const mastTipGeo = new THREE.SphereGeometry(bodyR * 0.05, 8, 6);
  mastTipGeo.translate(0, 0, -bodyH * 0.6 - mastH - bodyR * 0.02);
  group.add(setupMesh(new THREE.Mesh(mastTipGeo, mastTipMat)));

  group.add(setupMesh(buildAbductorBeam(bodyR, palette.glow, -bodyH * 0.6, bodyR * 1.25, 0.18)));

  group.userData.ringGroup = ringGroup;
  group.userData.pulseTipMat = tipMat;
  group.userData.pulseMastTipMat = mastTipMat;
  return { group, geometry: bodyGeo, material: bodyMat };
}

/** Elite — angular aggressor. Hexagonal hull, 6 outward spikes around
 *  the rim, single sensor eye on top (no dome), twin underbelly
 *  weapon pods. Reads as "this one is sharper". */
function buildEliteUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  const bodyR = u.radius * palette.scale;
  const bodyH = bodyR * 0.26;

  // Hexagonal hull — radial 6-sided cylinder reads as a war-machine
  // gem rather than the cruiser's smooth saucer.
  const bodyGeo = new THREE.CylinderGeometry(bodyR * 0.8, bodyR, bodyH, 6);
  bodyGeo.rotateX(Math.PI / 2);
  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body, shininess: 90, specular: 0xff8060,
    emissive: palette.glow, emissiveIntensity: 0.25,
    flatShading: true,
  });
  group.add(setupMesh(new THREE.Mesh(bodyGeo, bodyMat)));

  // Six outward spikes at the hex corners — cones lying flat in the
  // hull plane, points radiating away from centre.
  const spikeL = bodyR * 0.55;
  const spikeR = bodyR * 0.18;
  const spikeGeo = new THREE.ConeGeometry(spikeR, spikeL, 6);
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * 2 * i) / 6 + Math.PI / 6;  // offset so spikes align with hex corners
    const spike = new THREE.Mesh(spikeGeo, bodyMat);
    spike.frustumCulled = false;
    spike.position.set(Math.cos(angle) * bodyR * 1.0, Math.sin(angle) * bodyR * 1.0, 0);
    spike.rotation.set(0, 0, angle - Math.PI / 2);  // tilt cones outward in XY plane
    group.add(spike);
  }

  // Iris ring — dark torus around the eye base, so the sensor reads
  // as a proper iris-mounted optic rather than a glowing tumour. The
  // inset between the iris and the body adds depth.
  const irisR = bodyR * 0.42;
  const irisGeo = new THREE.TorusGeometry(irisR, bodyR * 0.05, 8, 24);
  irisGeo.translate(0, 0, bodyH * 0.42);
  group.add(setupMesh(new THREE.Mesh(irisGeo, new THREE.MeshPhongMaterial({
    color: 0x281008, shininess: 80, specular: 0x606060,
    emissive: palette.glow, emissiveIntensity: 0.35,
  }))));

  // Single sensor eye on top — half-sphere of bright emissive glow.
  // Captured in eyeMat for the per-frame predatory pulse.
  const eyeR = bodyR * 0.4;
  const eyeGeo = new THREE.SphereGeometry(eyeR, 16, 12);
  eyeGeo.translate(0, 0, bodyH * 0.45 + eyeR * 0.4);
  const eyeMat = new THREE.MeshPhongMaterial({
    color: palette.dome, shininess: 240, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 1.4,
    transparent: true, opacity: 0.9,
  });
  group.add(setupMesh(new THREE.Mesh(eyeGeo, eyeMat)));

  // Eye inner core — small bright point at the centre so the "pupil"
  // reads even when the player is offset from the sensor's gaze axis.
  const pupilMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
  });
  const pupilGeo = new THREE.SphereGeometry(eyeR * 0.3, 10, 8);
  pupilGeo.translate(0, 0, bodyH * 0.45 + eyeR * 0.4);
  group.add(setupMesh(new THREE.Mesh(pupilGeo, pupilMat)));

  // Spike tip bulbs — small glowing additive spheres at the end of
  // each spike, so the spike tips read as energy weapons rather than
  // pure pointy hull.
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI * 2 * i) / 6 + Math.PI / 6;
    const tipGeo = new THREE.SphereGeometry(bodyR * 0.06, 8, 6);
    tipGeo.translate(Math.cos(angle) * bodyR * 1.4, Math.sin(angle) * bodyR * 1.4, 0);
    group.add(setupMesh(new THREE.Mesh(tipGeo, new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
    }))));
  }

  // Twin underbelly weapon pods — short cylinders flanking the
  // centreline, glowing tips suggesting charged barrels.
  const podR = bodyR * 0.14;
  const podL = bodyR * 0.5;
  for (const sign of [-1, 1]) {
    const podGeo = new THREE.CylinderGeometry(podR, podR * 0.85, podL, 12);
    podGeo.rotateX(Math.PI / 2);
    podGeo.translate(sign * bodyR * 0.55, 0, -bodyH * 0.45);
    group.add(setupMesh(new THREE.Mesh(podGeo, new THREE.MeshPhongMaterial({
      color: 0x301010, shininess: 80, specular: 0x808080,
      emissive: palette.glow, emissiveIntensity: 0.4,
    }))));
    const tipGeo = new THREE.SphereGeometry(podR * 0.95, 10, 8);
    tipGeo.translate(sign * bodyR * 0.55, 0, -bodyH * 0.45 - podL * 0.5);
    group.add(setupMesh(new THREE.Mesh(tipGeo, new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
    }))));
  }

  // Twin rear thruster cones — additive blue-tinted glows behind the
  // hull. Doesn't track rotation; just there as the "engines running"
  // backdrop to the predatory wobble.
  for (const sign of [-1, 1]) {
    const thrR = bodyR * 0.12;
    const thrL = bodyR * 0.35;
    const thrGeo = new THREE.ConeGeometry(thrR, thrL, 10);
    thrGeo.rotateZ(Math.PI / 2);
    thrGeo.translate(-bodyR * 0.45 - thrL * 0.5, sign * bodyR * 0.25, 0);
    group.add(setupMesh(new THREE.Mesh(thrGeo, new THREE.MeshBasicMaterial({
      color: 0xff8060, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
    }))));
  }

  group.userData.eyeMat = eyeMat;
  group.userData.pupilMat = pupilMat;
  return { group, geometry: bodyGeo, material: bodyMat };
}

/** Tank — heavy gunship. Thick wide armoured plate hull with 4 cardinal
 *  armour pauldrons, central turret on top with 4 protruding gun
 *  barrels. No dome — armoured cap instead. Reads as "this one shoots
 *  hard and doesn't budge". */
function buildTankUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  const bodyR = u.radius * palette.scale;
  const bodyH = bodyR * 0.32;  // thicker than cruiser

  // Thick octagonal hull plate.
  const bodyGeo = new THREE.CylinderGeometry(bodyR * 0.95, bodyR, bodyH, 8);
  bodyGeo.rotateX(Math.PI / 2);
  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body, shininess: 30, specular: 0x606060,
    emissive: palette.glow, emissiveIntensity: 0.15,
    flatShading: true,
  });
  group.add(setupMesh(new THREE.Mesh(bodyGeo, bodyMat)));

  // 4 cardinal armour pauldrons — boxes attached to the hull edges.
  const paulW = bodyR * 0.45;
  const paulD = bodyR * 0.3;
  const paulH = bodyH * 1.4;
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i;
    const paulGeo = new THREE.BoxGeometry(paulW, paulD, paulH);
    paulGeo.translate(Math.cos(angle) * bodyR * 0.95, Math.sin(angle) * bodyR * 0.95, 0);
    const paul = new THREE.Mesh(paulGeo, bodyMat);
    paul.frustumCulled = false;
    paul.rotation.z = angle;
    group.add(paul);
  }

  // Heavy turret on top — wide squat cylinder.
  const turretR = bodyR * 0.55;
  const turretH = bodyH * 0.9;
  const turretGeo = new THREE.CylinderGeometry(turretR * 0.9, turretR, turretH, 16);
  turretGeo.rotateX(Math.PI / 2);
  turretGeo.translate(0, 0, bodyH * 0.45 + turretH * 0.4);
  const turretMat = new THREE.MeshPhongMaterial({
    color: 0x4a1818, shininess: 50, specular: 0x808080,
    emissive: palette.glow, emissiveIntensity: 0.2,
  });
  group.add(setupMesh(new THREE.Mesh(turretGeo, turretMat)));

  // Turret cap — flat disc on top of the turret, slightly emissive.
  const capGeo = new THREE.CylinderGeometry(turretR, turretR * 0.95, bodyH * 0.18, 16);
  capGeo.rotateX(Math.PI / 2);
  capGeo.translate(0, 0, bodyH * 0.45 + turretH + bodyH * 0.08);
  group.add(setupMesh(new THREE.Mesh(capGeo, new THREE.MeshPhongMaterial({
    color: palette.dome, shininess: 100, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 0.6,
  }))));

  // Hex armour plates on each pauldron — small box decoration that
  // sells "this thing is layered armour" rather than a smooth box.
  // Captured nothing; pure visual texture.
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i;
    const plateGeo = new THREE.BoxGeometry(paulW * 0.55, paulD * 0.35, paulH * 0.4);
    plateGeo.translate(Math.cos(angle) * (bodyR * 0.95 + paulW * 0.3), Math.sin(angle) * (bodyR * 0.95 + paulW * 0.3), 0);
    const plate = new THREE.Mesh(plateGeo, new THREE.MeshPhongMaterial({
      color: 0x4a1818, shininess: 40, specular: 0x808080,
      emissive: palette.glow, emissiveIntensity: 0.25,
      flatShading: true,
    }));
    plate.frustumCulled = false;
    plate.rotation.z = angle;
    group.add(plate);
  }

  // 4 gun barrels protruding in cardinal directions from the central
  // turret. Tip glow per barrel is captured so renderOverlay can fire
  // them in a chase pattern — each barrel "charges" then "fires" so
  // the silhouette feels mechanical and busy.
  const barrelL = bodyR * 0.45;
  const barrelR = bodyR * 0.09;
  const barrelTipMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i;
    const bGeo = new THREE.CylinderGeometry(barrelR, barrelR, barrelL, 10);
    bGeo.rotateZ(Math.PI / 2);  // lay along X
    bGeo.translate(barrelL * 0.5, 0, bodyH * 0.45 + turretH * 0.4);
    const barrel = new THREE.Mesh(bGeo, turretMat);
    barrel.frustumCulled = false;
    barrel.rotation.z = angle;
    group.add(barrel);

    // Tip glow at the muzzle end of each barrel.
    const tipMat = new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending,
    });
    const tipGeo = new THREE.SphereGeometry(barrelR * 1.5, 8, 6);
    tipGeo.translate(barrelL + barrelR, 0, bodyH * 0.45 + turretH * 0.4);
    const tipMesh = new THREE.Mesh(tipGeo, tipMat);
    tipMesh.frustumCulled = false;
    tipMesh.rotation.z = angle;
    group.add(tipMesh);
    barrelTipMats.push(tipMat);
  }

  // Slow-glow rim slits — 8 narrow emissive bars around the equator
  // suggest armoured viewports rather than a full port-hole ring.
  const ringGroup = buildRimRing(bodyR * 0.92, palette.glow, 8, bodyR * 0.05, -bodyH * 0.1);
  group.add(ringGroup);

  // Heavy underbelly base plate — wide flat cylinder, looks anchored.
  const baseGeo = new THREE.CylinderGeometry(bodyR * 0.8, bodyR * 0.5, bodyH * 0.55, 16);
  baseGeo.rotateX(Math.PI / 2);
  baseGeo.translate(0, 0, -bodyH * 0.7);
  group.add(setupMesh(new THREE.Mesh(baseGeo, bodyMat)));

  // 4 anchor spikes on the underbelly — small downward cones at
  // diagonal positions, sells the "anchored / dropped" feel.
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i + Math.PI / 4;
    const spkR = bodyR * 0.05;
    const spkL = bodyR * 0.22;
    const spkGeo = new THREE.ConeGeometry(spkR, spkL, 6);
    spkGeo.rotateX(Math.PI / 2);  // point along +Z
    spkGeo.translate(Math.cos(angle) * bodyR * 0.45, Math.sin(angle) * bodyR * 0.45, -bodyH * 0.9 - spkL * 0.5);
    spkGeo.rotateX(Math.PI);  // flip so tip points down
    group.add(setupMesh(new THREE.Mesh(spkGeo, bodyMat)));
  }

  group.userData.barrelTipMats = barrelTipMats;

  group.userData.ringGroup = ringGroup;
  return { group, geometry: bodyGeo, material: bodyMat };
}

/** Sniper — elongated rail-ship. NOT a saucer. Capsule body along the
 *  +X axis (forward), long thin barrel forward, twin fins, sensor
 *  optic at the muzzle, tail thruster. Reads as "this thing aims and
 *  shoots from far away". */
function buildSniperUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  const bodyR = u.radius * palette.scale;

  // Capsule hull — cylinder along +X with hemispheres at each end.
  const hullL = bodyR * 1.6;
  const hullR = bodyR * 0.35;
  const hullGeo = new THREE.CylinderGeometry(hullR, hullR, hullL, 16);
  hullGeo.rotateZ(Math.PI / 2);  // lay along X
  const hullMat = new THREE.MeshPhongMaterial({
    color: palette.body, shininess: 110, specular: 0xc0fff0,
    emissive: palette.glow, emissiveIntensity: 0.25,
  });
  group.add(setupMesh(new THREE.Mesh(hullGeo, hullMat)));

  // Rear cap — half-sphere closing the back of the capsule.
  const rearGeo = new THREE.SphereGeometry(hullR, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  rearGeo.rotateZ(Math.PI / 2);
  rearGeo.translate(-hullL * 0.5, 0, 0);
  group.add(setupMesh(new THREE.Mesh(rearGeo, hullMat)));

  // Front cap — half-sphere closing the muzzle end.
  const frontGeo = new THREE.SphereGeometry(hullR, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  frontGeo.rotateZ(-Math.PI / 2);
  frontGeo.translate(hullL * 0.5, 0, 0);
  group.add(setupMesh(new THREE.Mesh(frontGeo, hullMat)));

  // Long thin sniper barrel — extends forward from the front cap.
  const barrelL = bodyR * 1.4;
  const barrelR = bodyR * 0.09;
  const barrelGeo = new THREE.CylinderGeometry(barrelR * 0.85, barrelR, barrelL, 12);
  barrelGeo.rotateZ(Math.PI / 2);
  barrelGeo.translate(hullL * 0.5 + hullR + barrelL * 0.5, 0, 0);
  group.add(setupMesh(new THREE.Mesh(barrelGeo, new THREE.MeshPhongMaterial({
    color: 0x404a4a, shininess: 80, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 0.15,
  }))));

  // Muzzle glow — additive sphere at the very tip of the barrel. Captured
  // so renderOverlay can run the build-and-fire charge cycle: opacity
  // ramps up slowly then snaps back to baseline. Reads as "the sniper
  // is charging its shot."
  const muzzleMat = new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
  });
  const muzzleR = barrelR * 1.4;
  const muzzleGeo = new THREE.SphereGeometry(muzzleR, 10, 8);
  muzzleGeo.translate(hullL * 0.5 + hullR + barrelL + muzzleR * 0.6, 0, 0);
  group.add(setupMesh(new THREE.Mesh(muzzleGeo, muzzleMat)));

  // Dorsal scope — small forward-mounted box with a glowing lens
  // disc, reads as the precision optic the rail-ship is famous for.
  const scopeW = bodyR * 0.18;
  const scopeH = bodyR * 0.12;
  const scopeD = bodyR * 0.35;
  const scopeGeo = new THREE.BoxGeometry(scopeD, scopeW, scopeH);
  scopeGeo.translate(hullL * 0.2, 0, hullR + scopeH * 0.4);
  group.add(setupMesh(new THREE.Mesh(scopeGeo, new THREE.MeshPhongMaterial({
    color: 0x303838, shininess: 80, specular: 0xc0fff0,
    emissive: palette.glow, emissiveIntensity: 0.2,
  }))));
  // Scope lens disc — bright cyan, at the front of the scope.
  const lensGeo = new THREE.CylinderGeometry(scopeH * 0.45, scopeH * 0.45, scopeW * 0.2, 12);
  lensGeo.rotateZ(Math.PI / 2);
  lensGeo.translate(hullL * 0.2 + scopeD * 0.5, 0, hullR + scopeH * 0.4);
  group.add(setupMesh(new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
  }))));

  // Body emissive stripe — thin glowing band along the hull, reads
  // as a power conduit. Cyan accent on the otherwise muted body.
  const stripeGeo = new THREE.BoxGeometry(hullL * 0.85, hullR * 0.12, hullR * 0.08);
  stripeGeo.translate(0, 0, -hullR * 0.7);
  group.add(setupMesh(new THREE.Mesh(stripeGeo, new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
  }))));

  // Twin fins — small flat plates on left and right of the hull.
  const finW = bodyR * 0.7;
  const finH = bodyR * 0.35;
  for (const sign of [-1, 1]) {
    const finGeo = new THREE.BoxGeometry(finW, 0.06 * bodyR, finH);
    finGeo.translate(-hullL * 0.05, sign * (hullR + finW * 0.4), 0);
    group.add(setupMesh(new THREE.Mesh(finGeo, hullMat)));
  }

  // Top sensor optic — small glowing cyan dot on the dorsal hull.
  const optR = bodyR * 0.12;
  const optGeo = new THREE.SphereGeometry(optR, 10, 8);
  optGeo.translate(hullL * 0.2, 0, hullR * 0.95);
  group.add(setupMesh(new THREE.Mesh(optGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
  }))));

  // Tail thruster — small cone glowing at the rear, additive blend.
  const thrR = hullR * 0.6;
  const thrL = bodyR * 0.4;
  const thrGeo = new THREE.ConeGeometry(thrR, thrL, 10);
  thrGeo.rotateZ(-Math.PI / 2);
  thrGeo.translate(-hullL * 0.5 - hullR - thrL * 0.4, 0, 0);
  group.add(setupMesh(new THREE.Mesh(thrGeo, new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending,
  }))));

  // Twin rear stabiliser fins — small angled plates behind the
  // capsule, gives the sniper a "thrust + control surfaces" look
  // rather than a featureless tube.
  const stabW = bodyR * 0.18;
  const stabH = bodyR * 0.4;
  for (const sign of [-1, 1]) {
    const stabGeo = new THREE.BoxGeometry(stabW, hullR * 0.08, stabH);
    stabGeo.translate(-hullL * 0.45, sign * hullR * 0.7, hullR * 0.4);
    const stab = new THREE.Mesh(stabGeo, hullMat);
    stab.frustumCulled = false;
    stab.rotation.x = sign * 0.35;
    group.add(stab);
  }

  group.userData.muzzleMat = muzzleMat;
  return { group, geometry: hullGeo, material: hullMat };
}

/** Boss — massive multi-tier carrier. Large saucer base with 18
 *  port-holes, double-tier dome with inner core, crown of 4 spires,
 *  triple-cone abductor beam. The wave-25 finale silhouette. */
function buildBossUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  const bodyR = u.radius * palette.scale;
  const bodyH = bodyR * 0.24;

  // Main hull plate — wide and slightly thicker than cruiser.
  const bodyGeo = new THREE.CylinderGeometry(bodyR * 0.85, bodyR, bodyH, 36);
  bodyGeo.rotateX(Math.PI / 2);
  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body, shininess: 80, specular: 0xc08040,
    emissive: palette.glow, emissiveIntensity: 0.25,
  });
  group.add(setupMesh(new THREE.Mesh(bodyGeo, bodyMat)));

  // Lower flared rim — wider than cruiser to sell the mass.
  const baseGeo = new THREE.CylinderGeometry(bodyR * 1.05, bodyR * 0.5, bodyH * 0.7, 36);
  baseGeo.rotateX(Math.PI / 2);
  baseGeo.translate(0, 0, -bodyH * 0.6);
  group.add(setupMesh(new THREE.Mesh(baseGeo, bodyMat)));

  // Upper deck — smaller disc above the main hull, like a layered cake.
  const deckGeo = new THREE.CylinderGeometry(bodyR * 0.55, bodyR * 0.7, bodyH * 0.6, 24);
  deckGeo.rotateX(Math.PI / 2);
  deckGeo.translate(0, 0, bodyH * 0.55);
  group.add(setupMesh(new THREE.Mesh(deckGeo, bodyMat)));

  // 18 port-holes orbiting the main rim — more than the cruiser, sold
  // as "bigger ship, more crew".
  const ringGroup = buildRimRing(bodyR * 0.98, palette.glow, 18, bodyR * 0.06, -bodyH * 0.05);
  group.add(ringGroup);

  // Outer translucent dome — the public-facing canopy.
  const domeR = bodyR * 0.45;
  const domeGeo = new THREE.SphereGeometry(domeR, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateX(-Math.PI / 2);
  domeGeo.translate(0, 0, bodyH * 0.85);
  const domeMat = new THREE.MeshPhongMaterial({
    color: palette.dome, shininess: 220, specular: 0xffffff,
    emissive: palette.glow, emissiveIntensity: 0.7,
    transparent: true, opacity: 0.7,
    depthWrite: false,
  });
  group.add(setupMesh(new THREE.Mesh(domeGeo, domeMat)));

  // Inner core — bright emissive sphere visible through the dome. The
  // material is captured for per-frame pulse modulation: scale + opacity
  // breathe at ~0.7Hz so the core reads as "powered up" rather than
  // a stuck glow. Sells the "alien core powering this thing" idea.
  const coreMat = new THREE.MeshBasicMaterial({
    color: palette.glow, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
  });
  const coreR = bodyR * 0.22;
  const coreGeo = new THREE.SphereGeometry(coreR, 14, 10);
  coreGeo.translate(0, 0, bodyH * 0.85 + coreR * 0.4);
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreMesh.frustumCulled = false;
  group.add(coreMesh);

  // Crown of 4 spires — vertical glowing pillars around the dome.
  // Tip materials captured per spire so renderOverlay can alternate
  // their glow in a chase pattern around the crown.
  const spireR = bodyR * 0.04;
  const spireH = bodyR * 0.55;
  const spireTipMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i + Math.PI / 4;
    const spireGeo = new THREE.CylinderGeometry(spireR, spireR * 1.5, spireH, 8);
    spireGeo.rotateX(Math.PI / 2);
    spireGeo.translate(Math.cos(angle) * bodyR * 0.45, Math.sin(angle) * bodyR * 0.45, bodyH * 0.55 + spireH * 0.5);
    group.add(setupMesh(new THREE.Mesh(spireGeo, new THREE.MeshPhongMaterial({
      color: 0x602030, shininess: 100, specular: 0xffffff,
      emissive: palette.glow, emissiveIntensity: 0.9,
    }))));
    // Spire tip — small bright bulb, captured for crown alternation.
    const tipMat = new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
    });
    const tipGeo = new THREE.SphereGeometry(spireR * 2, 8, 6);
    tipGeo.translate(Math.cos(angle) * bodyR * 0.45, Math.sin(angle) * bodyR * 0.45, bodyH * 0.55 + spireH + spireR);
    group.add(setupMesh(new THREE.Mesh(tipGeo, tipMat)));
    spireTipMats.push(tipMat);
  }

  // Orbital escort drones — 2 small saucer satellites that orbit the
  // boss. Stored in a group whose rotation.z spins each frame so they
  // sweep around the boss. The "command flotilla" silhouette.
  const escortGroup = new THREE.Group();
  for (const sign of [-1, 1]) {
    const droneR = bodyR * 0.14;
    const droneH = droneR * 0.4;
    const droneGeo = new THREE.CylinderGeometry(droneR * 0.7, droneR, droneH, 16);
    droneGeo.rotateX(Math.PI / 2);
    droneGeo.translate(sign * bodyR * 1.4, 0, bodyH * 0.2);
    const droneMat = new THREE.MeshPhongMaterial({
      color: 0x4a1818, shininess: 80, specular: 0xc08040,
      emissive: palette.glow, emissiveIntensity: 0.6,
    });
    escortGroup.add(setupMesh(new THREE.Mesh(droneGeo, droneMat)));
    // Drone glow underside — small additive sphere.
    const dGlowGeo = new THREE.SphereGeometry(droneR * 0.55, 8, 6);
    dGlowGeo.translate(sign * bodyR * 1.4, 0, bodyH * 0.2 - droneH * 0.6);
    escortGroup.add(setupMesh(new THREE.Mesh(dGlowGeo, new THREE.MeshBasicMaterial({
      color: palette.glow, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending,
    }))));
  }
  group.add(escortGroup);

  // Triple abductor beam — central wide cone + 2 narrower side cones.
  group.add(setupMesh(buildAbductorBeam(bodyR, palette.glow, -bodyH * 0.6, bodyR * 1.6, 0.16)));
  for (const sign of [-1, 1]) {
    const sideBeam = buildAbductorBeam(bodyR * 0.4, palette.glow, -bodyH * 0.6, bodyR * 1.1, 0.14);
    sideBeam.position.x = sign * bodyR * 0.4;
    group.add(setupMesh(sideBeam));
  }

  group.userData.ringGroup = ringGroup;
  group.userData.coreMat = coreMat;
  group.userData.coreMesh = coreMesh;
  group.userData.spireTipMats = spireTipMats;
  group.userData.escortGroup = escortGroup;
  return { group, geometry: bodyGeo, material: bodyMat };
}

/** Shared mesh setup — frustumCulled = false for everything inside the
 *  saucers since the scene is small enough that culling per-piece
 *  costs more than the skipped draw saves. */
function setupMesh<T extends THREE.Object3D>(m: T): T {
  m.frustumCulled = false;
  return m;
}

/** Build a powerup mesh: a spinning sphere with the glyph painted at
 *  four longitudes so a player always sees at least one glyph face
 *  regardless of rotation. Strong emissive + bright base colour so it
 *  reads as a glowing pickup against the dark backdrop. */
const POWERUP_TEX_CACHE = new Map<PowerUpType, THREE.CanvasTexture>();
function getPowerupTexture(type: PowerUpType): THREE.CanvasTexture {
  const cached = POWERUP_TEX_CACHE.get(type);
  if (cached) return cached;
  const cfg = POWERUP_CONFIG[type];
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const ctx = c.getContext('2d')!;
  // Coloured background — slightly darker than the glyph so the
  // emissive on the material lifts the glyph clear.
  ctx.fillStyle = cfg.colour;
  ctx.fillRect(0, 0, 512, 256);
  // Four glyph stamps around the equator so spinning always shows one
  // face-on. Inset from canvas edges so wrapping at u=0/1 doesn't
  // produce a cropped glyph at the seam.
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 150px ui-monospace, "Helvetica Neue", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Sat-boost ₿ is bold serif territory; trident ⋔ and magnet ◎ need
  // a sans fallback for glyph coverage.
  for (let i = 0; i < 4; i++) {
    ctx.fillText(cfg.glyph, 64 + i * 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  POWERUP_TEX_CACHE.set(type, tex);
  return tex;
}

function parseHexColor(s: string): number {
  return parseInt(s.replace('#', ''), 16);
}

function buildPowerupMesh(p: PowerUp): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry; material: THREE.Material } {
  const cfg = POWERUP_CONFIG[p.type];
  const color = parseHexColor(cfg.colour);
  const geo = new THREE.SphereGeometry(POWERUP_RADIUS, 24, 16);
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getPowerupTexture(p.type),
    shininess: 140,
    specular: 0xffffff,
    emissive: color,
    emissiveIntensity: 0.55,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, geometry: geo, material: mat };
}

// ── Ship-mesh explosion ──────────────────────────────────────────────
// On death we shatter the ship into a fixed roster of fragment meshes
// loosely matching the parts that build the live ship (hull wedges,
// cockpit dome half, fin, wings, engine pods, barrel, plus a few
// generic shards). Each chunk flies outward from its local-space
// offset, tumbles, and fades. Ticked in renderOverlay below.

/** Fragment specs — the geometry / colour / local-space anchor of each
 *  chunk a destroyed ship breaks into. Anchors mirror the ship mesh
 *  layout so the explosion reads as the ship coming apart, not as a
 *  generic debris cloud. Colours pulled from the ship material palette
 *  plus an orange engine-flare colour. */
interface ShipChunkSpec {
  build: () => THREE.BufferGeometry;
  colour: number;
  emissive: number;
  emissiveIntensity: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

let SHIP_CHUNK_SPECS: ReadonlyArray<ShipChunkSpec> | null = null;
function getShipChunkSpecs(): ReadonlyArray<ShipChunkSpec> {
  if (SHIP_CHUNK_SPECS) return SHIP_CHUNK_SPECS;
  SHIP_CHUNK_SPECS = [
    // Front nose wedge
    { build: () => new THREE.ConeGeometry(4, 9, 4),
      colour: 0x9be7ff, emissive: 0x4080a0, emissiveIntensity: 0.5,
      offsetX: 12, offsetY: 0, offsetZ: 0 },
    // Mid-hull box
    { build: () => new THREE.BoxGeometry(8, 7, 5),
      colour: 0x9be7ff, emissive: 0x4080a0, emissiveIntensity: 0.5,
      offsetX: 2, offsetY: 0, offsetZ: 0 },
    // Tail hull box
    { build: () => new THREE.BoxGeometry(7, 6, 5),
      colour: 0x6db4dc, emissive: 0x305070, emissiveIntensity: 0.45,
      offsetX: -7, offsetY: 0, offsetZ: 0 },
    // Cockpit dome (half-sphere)
    { build: () => new THREE.SphereGeometry(4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      colour: 0xb8f0ff, emissive: 0x4080a0, emissiveIntensity: 0.55,
      offsetX: 1, offsetY: 0, offsetZ: 4 },
    // Dorsal fin
    { build: () => new THREE.BoxGeometry(6, 1.4, 4),
      colour: 0x8ad4ff, emissive: 0x305070, emissiveIntensity: 0.45,
      offsetX: -3, offsetY: 0, offsetZ: 3 },
    // Wing left
    { build: () => new THREE.BoxGeometry(6, 1.2, 3),
      colour: 0x6db4dc, emissive: 0x305070, emissiveIntensity: 0.4,
      offsetX: -6, offsetY: 8, offsetZ: 0 },
    // Wing right
    { build: () => new THREE.BoxGeometry(6, 1.2, 3),
      colour: 0x6db4dc, emissive: 0x305070, emissiveIntensity: 0.4,
      offsetX: -6, offsetY: -8, offsetZ: 0 },
    // Engine pod left
    { build: () => new THREE.CylinderGeometry(2.0, 2.4, 7, 10),
      colour: 0x4a7eb0, emissive: 0xff8040, emissiveIntensity: 0.7,
      offsetX: -10, offsetY: 7.5, offsetZ: 0 },
    // Engine pod right
    { build: () => new THREE.CylinderGeometry(2.0, 2.4, 7, 10),
      colour: 0x4a7eb0, emissive: 0xff8040, emissiveIntensity: 0.7,
      offsetX: -10, offsetY: -7.5, offsetZ: 0 },
    // Nose barrel
    { build: () => new THREE.CylinderGeometry(1.3, 1.3, 6, 8),
      colour: 0x6080a0, emissive: 0xff8040, emissiveIntensity: 0.75,
      offsetX: 18, offsetY: 0, offsetZ: 0 },
    // Generic shards x4 — small cubes/tetrahedra for variety
    { build: () => new THREE.TetrahedronGeometry(2.2, 0),
      colour: 0x9be7ff, emissive: 0x4080a0, emissiveIntensity: 0.5,
      offsetX: 5, offsetY: 4, offsetZ: 2 },
    { build: () => new THREE.TetrahedronGeometry(2.0, 0),
      colour: 0x6db4dc, emissive: 0x305070, emissiveIntensity: 0.4,
      offsetX: -2, offsetY: -5, offsetZ: 1 },
    { build: () => new THREE.BoxGeometry(2.4, 2.4, 2.4),
      colour: 0x8ad4ff, emissive: 0x4080a0, emissiveIntensity: 0.45,
      offsetX: 8, offsetY: -3, offsetZ: -1 },
    { build: () => new THREE.OctahedronGeometry(2.0, 0),
      colour: 0xffb84a, emissive: 0xff8040, emissiveIntensity: 0.8,
      offsetX: -12, offsetY: 0, offsetZ: 0 },
  ];
  return SHIP_CHUNK_SPECS;
}

/** Shatter the ship at the given world position. Each chunk inherits a
 *  fraction of the ship's velocity (so a ship dying mid-thrust scatters
 *  forward) plus an outward kick from its local-space anchor (so chunks
 *  fly away from the explosion centre, not collapse inward). */
export function spawnShipMeshExplosion(pos: { x: number; y: number }, shipVel: { x: number; y: number }, rot: number): void {
  if (!handle) return;
  const { scene } = handle;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const specs = getShipChunkSpecs();
  for (const spec of specs) {
    const geometry = spec.build();
    const material = new THREE.MeshPhongMaterial({
      color: spec.colour,
      shininess: 80,
      specular: 0xffffff,
      emissive: spec.emissive,
      emissiveIntensity: spec.emissiveIntensity,
      transparent: true,
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    // Rotate the local-space anchor into world space, place mesh.
    // Y in mesh-world is inverted vs game-world.
    const localX = spec.offsetX;
    const localY = spec.offsetY;
    const worldDX = localX * cosR - localY * sinR;
    const worldDY = localX * sinR + localY * cosR;
    mesh.position.set(pos.x + worldDX, handle.worldH - (pos.y + worldDY), spec.offsetZ);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    // Outward direction in world space. Anchor's distance from ship
    // origin sets the kick magnitude — peripheral parts fly faster.
    const distLocal = Math.hypot(localX, localY) || 1;
    const dirX = worldDX / distLocal;
    // Note the Y flip: outward in *mesh* space (game-y inverted) needs
    // a flipped y on the velocity vector too so chunks fly away from
    // the visible explosion centre, not toward it.
    const dirY = -worldDY / distLocal;
    const kick = 90 + Math.random() * 130;
    scene.add(mesh);
    handle.shipChunks.push({
      mesh,
      geometry,
      material,
      vel: {
        x: dirX * kick + shipVel.x * 0.5,
        y: dirY * kick - shipVel.y * 0.5,
        z: (Math.random() - 0.5) * 60,
      },
      rotVel: {
        x: (Math.random() - 0.5) * 9,
        y: (Math.random() - 0.5) * 9,
        z: (Math.random() - 0.5) * 9,
      },
      ttl: 1500 + Math.random() * 600,
      maxTtl: 2100,
    });
  }
}

/** Drop every live chunk now. Called on final-life cleanup before the
 *  death-replay re-spawns its own explosion, so the previous live death
 *  doesn't leak into the replay's first frame. */
export function clearShipChunks(): void {
  if (!handle) return;
  for (const c of handle.shipChunks) {
    handle.scene.remove(c.mesh);
    c.geometry.dispose();
    c.material.dispose();
  }
  handle.shipChunks.length = 0;
}

/** Build a fresh ship mesh group (hull + cockpit + fin + wings + pods +
 *  barrel + thrust cone). Called once per ship slot — the renderOverlay
 *  ship loop caches the returned group per slot so the geometry isn't
 *  rebuilt on every respawn.
 *
 *  Returns the group + the thrust cone so callers can toggle the cone
 *  on/off based on the live ship.thrusting flag. */
function buildShipMesh(tint?: string): { group: THREE.Group; thrust: THREE.Mesh } {
  const group = new THREE.Group();
  // Per-player identity tint (2P couch / duel): re-hue each hull material
  // onto the player's hue while KEEPING the piece's original lightness, so
  // the depth shading (bright hull → dark pods) survives but P1 reads green
  // and P2 reads blue — matching the HUD identity chips so players can tell
  // which ship is theirs. Undefined tint (solo / title) leaves the stock
  // cyan untouched. Orange engine-glow emissives and the thrust flame are
  // left alone: they read as heat/exhaust, not identity.
  const tintHSL = tint ? new THREE.Color(tint).getHSL({ h: 0, s: 0, l: 0 }) : null;
  const reHue = (hex: number): number => {
    if (!tintHSL) return hex;
    const c = new THREE.Color(hex);
    const hsl = c.getHSL({ h: 0, s: 0, l: 0 });
    c.setHSL(tintHSL.h, tintHSL.s, hsl.l);
    return c.getHex();
  };
  // Beefed-up hull — slightly larger, deeper extrude for more
  // visible 3D form at the player ship's small on-screen size.
  const hullGeo = new THREE.ExtrudeGeometry(
    new THREE.Shape([
      new THREE.Vector2(16, 0),
      new THREE.Vector2(-12, 10),
      new THREE.Vector2(-8, 0),
      new THREE.Vector2(-12, -10),
    ]),
    { depth: 5, bevelEnabled: true, bevelSize: 1.5, bevelThickness: 1.5, bevelSegments: 3 },
  );
  hullGeo.translate(0, 0, -2.5);
  const hullMat = new THREE.MeshPhongMaterial({
    color: reHue(0x9be7ff),
    shininess: 80,
    specular: 0xffffff,
    emissive: reHue(0x4080a0),
    emissiveIntensity: 0.45,
  });
  const hullMesh = new THREE.Mesh(hullGeo, hullMat);
  hullMesh.frustumCulled = false;
  group.add(hullMesh);
  // Cockpit canopy — translucent dome on top of hull, sells the
  // 3D form better than a flat extrude alone.
  const cockpitGeo = new THREE.SphereGeometry(4.5, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  cockpitGeo.rotateX(-Math.PI / 2);
  const cockpitMat = new THREE.MeshPhongMaterial({
    color: reHue(0xb8f0ff),
    shininess: 240,
    specular: 0xffffff,
    emissive: reHue(0x4080a0),
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.78,
  });
  const cockpitMesh = new THREE.Mesh(cockpitGeo, cockpitMat);
  cockpitMesh.position.set(1, 0, 4.5);
  cockpitMesh.frustumCulled = false;
  group.add(cockpitMesh);
  // Dorsal fin — small vertical spike behind the cockpit. Reads
  // as a stabiliser/comms array from above.
  const finShape = new THREE.Shape([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(-7, 0),
    new THREE.Vector2(-5, 5),
    new THREE.Vector2(0, 4),
  ]);
  const finGeo = new THREE.ExtrudeGeometry(finShape, {
    depth: 1.4, bevelEnabled: true, bevelSize: 0.3, bevelThickness: 0.3, bevelSegments: 1,
  });
  const finMat = new THREE.MeshPhongMaterial({
    color: reHue(0x8ad4ff),
    shininess: 60,
    specular: 0xffffff,
    emissive: reHue(0x305070),
    emissiveIntensity: 0.4,
  });
  const finMesh = new THREE.Mesh(finGeo, finMat);
  finMesh.position.set(-2, -0.7, 3);
  finMesh.frustumCulled = false;
  group.add(finMesh);
  // Stub wings — short angled fins on each side of the hull.
  const wingShape = new THREE.Shape([
    new THREE.Vector2(0, 0),
    new THREE.Vector2(7, 0),
    new THREE.Vector2(5, 4),
    new THREE.Vector2(0, 3),
  ]);
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
    depth: 1.2, bevelEnabled: true, bevelSize: 0.3, bevelThickness: 0.3, bevelSegments: 1,
  });
  const wingMat = new THREE.MeshPhongMaterial({
    color: reHue(0x6db4dc),
    shininess: 80,
    specular: 0xffffff,
    emissive: reHue(0x305070),
    emissiveIntensity: 0.35,
  });
  const wingL = new THREE.Mesh(wingGeo, wingMat);
  wingL.position.set(-8, 6, -0.5);
  wingL.frustumCulled = false;
  group.add(wingL);
  const wingR = new THREE.Mesh(wingGeo, wingMat);
  wingR.position.set(-8, -6, -0.5);
  wingR.rotation.x = Math.PI;
  wingR.frustumCulled = false;
  group.add(wingR);
  // Side engine pods — two cylinders flanking the rear thrust.
  const podGeo = new THREE.CylinderGeometry(2.2, 2.6, 8, 12);
  podGeo.rotateZ(Math.PI / 2);
  const podMat = new THREE.MeshPhongMaterial({
    color: reHue(0x4a7eb0),
    shininess: 100,
    specular: 0xffffff,
    emissive: 0xff8040,
    emissiveIntensity: 0.45,
  });
  const podL = new THREE.Mesh(podGeo, podMat);
  podL.position.set(-10, 7.5, 0);
  podL.frustumCulled = false;
  group.add(podL);
  const podR = new THREE.Mesh(podGeo, podMat);
  podR.position.set(-10, -7.5, 0);
  podR.frustumCulled = false;
  group.add(podR);
  // Nose laser barrel — small cylinder protruding from the bow.
  const barrelGeo = new THREE.CylinderGeometry(1.4, 1.4, 7, 10);
  barrelGeo.rotateZ(Math.PI / 2);
  barrelGeo.translate(19, 0, 0);
  const barrelMat = new THREE.MeshPhongMaterial({
    color: reHue(0x6080a0),
    shininess: 140,
    specular: 0xffffff,
    emissive: 0xff8040,
    emissiveIntensity: 0.6,
  });
  const barrelMesh = new THREE.Mesh(barrelGeo, barrelMat);
  barrelMesh.frustumCulled = false;
  group.add(barrelMesh);
  // Thrust cone — additive flame at the rear, shown only when
  // thrusting. Larger and centred between the engine pods now.
  const thrustGeo = new THREE.ConeGeometry(6, 16, 12);
  thrustGeo.rotateZ(Math.PI / 2);
  thrustGeo.translate(-18, 0, 0);
  const thrustMat = new THREE.MeshBasicMaterial({
    color: 0xffb84a,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
  });
  const thrustMesh = new THREE.Mesh(thrustGeo, thrustMat);
  thrustMesh.frustumCulled = false;
  thrustMesh.visible = false;
  group.add(thrustMesh);
  return { group, thrust: thrustMesh };
}

/** Build a fresh shield dome — faceted icosphere + edge wireframe in
 *  one group so a single position.set per frame tracks the ship.
 *  Sized off the SHIP's radius (NOT ship.radius * x) so per-slot
 *  shields can each follow a possibly-different ship radius if we
 *  ever introduce size-mod ships. */
function buildShieldDome(shipRadius: number): {
  group: THREE.Group;
  sphereMat: THREE.MeshPhongMaterial;
  edgeMat: THREE.LineBasicMaterial;
} {
  const group = new THREE.Group();
  const radius = shipRadius * 2.2;
  const sphereGeo = new THREE.IcosahedronGeometry(radius, 1);
  const sphereMat = new THREE.MeshPhongMaterial({
    color: 0x5b9dff,
    emissive: 0x305070,
    emissiveIntensity: 0.5,
    shininess: 90,
    specular: 0xffffff,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const sphereMesh = new THREE.Mesh(sphereGeo, sphereMat);
  sphereMesh.frustumCulled = false;
  group.add(sphereMesh);
  const edgesGeo = new THREE.EdgesGeometry(sphereGeo);
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0xb4d8ff,
    transparent: true,
    opacity: 0.85,
  });
  const edges = new THREE.LineSegments(edgesGeo, edgeMat);
  edges.frustumCulled = false;
  group.add(edges);
  return { group, sphereMat, edgeMat };
}

// ── EAGLE STATION (wave 17) rig meshes ───────────────────────────────────────
// Built from primitives so the whole rig reads as ARTIFICIAL against the organic
// rocks. Each part is its own entity (core = vein, arm = terrain, emitter =
// small rock), so the rig spins because the entities' positions/rotations do;
// the meshes just track them. Animation material refs live on group.userData.
const STATION_METAL = { color: 0x6d7684, shininess: 90, specular: 0xaab3c2 };
const STATION_ENERGY = 0x9be15d;   // anomalous olivine-green reactor light
const STATION_HOT = 0xffb24a;      // emitter pod glow

function newMesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  return m;
}

const STATION_DARK = { color: 0x3b414e, shininess: 60, specular: 0x6a7384 };  // shadowed underplate

/** The reactor core — the weak point. A multi-ring gimbal field generator
 *  caging a faceted energy crystal, wrapped in a metal containment hub with
 *  pylons, and lit from within by a green point-light that washes the arms.
 *  Built at the vein radius; scales with the HP-shrink so it collapses as it
 *  dies. The crystal + corona + light all ramp + go white-hot as it fails. */
function buildStationCore(radius: number): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const group = new THREE.Group();
  const metal = new THREE.MeshPhongMaterial(STATION_METAL);
  const dark = new THREE.MeshPhongMaterial(STATION_DARK);
  // Containment hub — a faceted metal shell the crystal sits inside.
  const hub = newMesh(new THREE.DodecahedronGeometry(radius * 0.5, 0), dark);
  group.add(hub);
  // Triple gimbal — thick inner rings.
  const ringGeo = new THREE.TorusGeometry(radius * 0.92, radius * 0.11, 12, 40);
  const r1 = newMesh(ringGeo, metal);
  const r2 = newMesh(ringGeo, metal); r2.rotation.x = Math.PI / 2;
  const r3 = newMesh(ringGeo, metal); r3.rotation.y = Math.PI / 2;
  group.add(r1, r2, r3);
  // Outer field ring — a thin wide hoop, the "generator".
  const fieldGeo = new THREE.TorusGeometry(radius * 1.22, radius * 0.045, 8, 48);
  const field = newMesh(fieldGeo, metal); field.rotation.x = Math.PI / 2.4;
  group.add(field);
  // Containment pylons — four stubby cones aimed inward at the crystal.
  const pylonGeo = new THREE.ConeGeometry(radius * 0.14, radius * 0.4, 6);
  for (let i = 0; i < 4; i++) {
    const ang = (Math.PI / 2) * i + Math.PI / 4;
    const py = newMesh(pylonGeo, metal);
    py.position.set(Math.cos(ang) * radius * 0.78, Math.sin(ang) * radius * 0.78, 0);
    py.rotation.z = -ang - Math.PI / 2;  // tip toward centre
    group.add(py);
  }
  // Energy crystal — sharp octahedron, emissive.
  const coreGeo = new THREE.OctahedronGeometry(radius * 0.58, 0);
  const energyMat = new THREE.MeshPhongMaterial({ color: 0x14240c, emissive: STATION_ENERGY, emissiveIntensity: 1.3, shininess: 140, specular: 0xffffff });
  const crystal = newMesh(coreGeo, energyMat);
  group.add(crystal);
  // Corona — a soft additive glow shell so the reactor blooms. Low-poly sphere
  // (8×6) to keep mobile fill-rate down; the emissive crystal carries the glow.
  const coronaMat = new THREE.MeshBasicMaterial({ color: STATION_ENERGY, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false });
  const corona = newMesh(new THREE.SphereGeometry(radius * 0.86, 8, 6), coronaMat);
  group.add(corona);
  // NOTE: a green PointLight used to wash the arms here, but a dynamic per-pixel
  // light tanked iOS GPUs (the whole game slowed to a crawl on wave 17). Dropped
  // it — the emissive crystal + corona + emissive arm conduits carry the glow.
  group.userData.energyMat = energyMat;
  group.userData.crystal = crystal;
  group.userData.coronaMat = coronaMat;
  return { group, geometry: coreGeo, material: energyMat };
}

/** A rotating arm — a greebled gunmetal spar: main beam, panel ribs, a pipe
 *  run, an inner gimbal joint and an outer pod housing, with an emissive power
 *  conduit + warning stripes. Bridges core → emitter pod. */
function buildStationArm(): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const group = new THREE.Group();
  const metal = new THREE.MeshPhongMaterial(STATION_METAL);
  const dark = new THREE.MeshPhongMaterial(STATION_DARK);
  const L = 84;  // beam length — bridges the (now compact) core → emitter spoke
  const beamGeo = new THREE.BoxGeometry(L, 16, 20);
  group.add(newMesh(beamGeo, metal));
  // Underplate (darker, slightly larger) for depth.
  const under = newMesh(new THREE.BoxGeometry(L, 9, 27), dark); under.position.y = -9; group.add(under);
  // Panel ribs.
  const ribGeo = new THREE.BoxGeometry(5, 27, 29);
  for (const x of [-29, -11, 8, 26]) { const rib = newMesh(ribGeo, metal); rib.position.x = x; group.add(rib); }
  // Pipe run along the top edge.
  const pipe = newMesh(new THREE.CylinderGeometry(2.8, 2.8, L, 8), dark);
  pipe.rotation.z = Math.PI / 2; pipe.position.set(0, 7, -10);
  group.add(pipe);
  // Inner gimbal joint (toward the core) + outer pod housing (toward the tip).
  group.add((() => { const j = newMesh(new THREE.CylinderGeometry(13, 13, 23, 10), dark); j.rotation.x = Math.PI / 2; j.position.x = -39; return j; })());
  group.add((() => { const h = newMesh(new THREE.BoxGeometry(23, 27, 27), metal); h.position.x = 38; return h; })());
  // Emissive conduit + two warning stripes.
  const conduitMat = new THREE.MeshPhongMaterial({ color: 0x0d160a, emissive: STATION_ENERGY, emissiveIntensity: 0.8 });
  const conduit = newMesh(new THREE.BoxGeometry(L - 6, 4, 7), conduitMat); conduit.position.set(0, 9, 0); group.add(conduit);
  const stripeMat = new THREE.MeshPhongMaterial({ color: 0x141414, emissive: 0xffb24a, emissiveIntensity: 0.5 });
  for (const x of [-19, 19]) { const st = newMesh(new THREE.BoxGeometry(5, 17, 21), stripeMat); st.position.x = x; group.add(st); }
  group.userData.conduitMat = conduitMat;
  return { group, geometry: beamGeo, material: metal };
}

/** An emitter pod — the placer head: a ringed barrel cowl with fins and a hot
 *  emissive lens at the muzzle (+X / outward), plus a soft glow corona. */
function buildStationEmitter(radius: number): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  const group = new THREE.Group();
  const metal = new THREE.MeshPhongMaterial(STATION_METAL);
  const dark = new THREE.MeshPhongMaterial(STATION_DARK);
  // Barrel cowl (mouth → +X) + a back plate.
  const cowl = newMesh(new THREE.CylinderGeometry(radius * 1.05, radius * 1.5, radius * 2.2, 10, 1, true), metal);
  cowl.rotation.z = Math.PI / 2;
  group.add(cowl);
  const back = newMesh(new THREE.CylinderGeometry(radius * 1.5, radius * 1.5, radius * 0.3, 10), dark);
  back.rotation.z = Math.PI / 2; back.position.x = -radius * 1.0;
  group.add(back);
  // Barrel rings (torus bands around the cowl).
  const bandGeo = new THREE.TorusGeometry(radius * 1.2, radius * 0.13, 8, 16);
  for (const x of [-radius * 0.4, radius * 0.4]) { const b = newMesh(bandGeo, dark); b.rotation.y = Math.PI / 2; b.position.x = x; group.add(b); }
  // Fins.
  const finGeo = new THREE.BoxGeometry(radius * 1.4, radius * 0.2, radius * 1.0);
  for (let i = 0; i < 3; i++) { const f = newMesh(finGeo, metal); f.rotation.x = (Math.PI / 3) * i; group.add(f); }
  // Hot emissive lens at the muzzle.
  const lensGeo = new THREE.IcosahedronGeometry(radius * 1.0, 1);
  const emitterMat = new THREE.MeshPhongMaterial({ color: 0x2a1500, emissive: STATION_HOT, emissiveIntensity: 1.1, shininess: 110, specular: 0xffd9a0 });
  const lens = newMesh(lensGeo, emitterMat);
  lens.position.x = radius * 1.05;
  group.add(lens);
  const coronaMat = new THREE.MeshBasicMaterial({ color: STATION_HOT, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false });
  const corona = newMesh(new THREE.SphereGeometry(radius * 0.9, 12, 8), coronaMat);
  corona.position.x = radius * 1.05;
  group.add(corona);
  group.userData.emitterMat = emitterMat;
  group.userData.emitterCorona = coronaMat;
  return { group, geometry: lensGeo, material: emitterMat };
}

function buildStationPart(a: Asteroid): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.MeshPhongMaterial } {
  if (a.stationPart === 'core') return buildStationCore(a.radius);
  if (a.stationPart === 'emitter') return buildStationEmitter(a.radius);
  return buildStationArm();
}

function addWarmupLights(scene: THREE.Scene): void {
  const sun = new THREE.DirectionalLight(0xfff2da, 1.5);
  sun.position.set(-200, -200, 350);
  scene.add(sun);
  const ambient = new THREE.AmbientLight(0xa8b0b8, 1.3);
  scene.add(ambient);
  const rim = new THREE.DirectionalLight(0xfff0c0, 2.4);
  rim.position.set(180, 100, -450);
  scene.add(rim);
}

function warmupUfo(type: Ufo['type'], id: number): Ufo {
  const radius = UFO_RADIUS[type];
  return {
    pos: { x: WORLD_W / 2, y: WORLD_H / 2 },
    vel: { x: 0, y: 0 },
    radius,
    alive: true,
    id,
    type,
    hp: 1,
    dir: 1,
    zigTimer: 0,
    shootTimer: 0,
    lifetime: 1_000,
    blink: 0,
    hitFlash: 0,
    bossPhase: 1,
  };
}

function warmupStation(part: NonNullable<Asteroid['stationPart']>, id: number): Asteroid {
  const radius = part === 'core' ? 58 : part === 'emitter' ? 24 : 30;
  return {
    id,
    alive: true,
    pos: { x: WORLD_W / 2, y: WORLD_H / 2 },
    vel: { x: 0, y: 0 },
    radius,
    rot: 0,
    shape: [1, 1, 1, 1],
    size: 'large',
    type: 'iron',
    hp: 1,
    hpMax: 1,
    hitFlash: 0,
    stationPart: part,
    stationSlot: 0,
    depth: 3,
  } as Asteroid;
}

/** One-shot compile pass for meshes that otherwise first appear mid-run.
 *  Kept out of boot by visual-style.ts; callers schedule this after IGNITE. */
export function prewarmWebGLOverlayMeshes(): void {
  if (!handle || meshPrewarmDone) return;
  meshPrewarmDone = true;

  const { renderer, camera } = handle;
  const warmScene = new THREE.Scene();
  addWarmupLights(warmScene);

  let x = 260;
  const add = (obj: THREE.Object3D): void => {
    obj.position.set(x, WORLD_H / 2, 0);
    x += 150;
    warmScene.add(obj);
    meshPrewarmKeepAlive.push(obj);
  };

  for (const [i, type] of (['cruiser', 'elite', 'tank', 'sniper'] as const).entries()) {
    add(buildUfoMesh(warmupUfo(type, -10_000 - i)).group);
  }
  for (const [i, part] of (['core', 'arm', 'emitter'] as const).entries()) {
    add(buildStationPart(warmupStation(part, -20_000 - i)).group);
  }

  const autoClear = renderer.autoClear;
  try {
    renderer.compile(warmScene, camera);
    renderer.autoClear = true;
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, 1, 1);
    renderer.setScissor(0, 0, 1, 1);
    renderer.render(warmScene, camera);
  } catch (e) {
    console.warn('[webgl-overlay] mesh prewarm failed', e);
  } finally {
    renderer.setScissorTest(false);
    renderer.autoClear = autoClear;
  }
}

export function renderOverlay(opts: {
  asteroids: ReadonlyArray<Asteroid>;
  ufos: ReadonlyArray<Ufo>;
  powerups: ReadonlyArray<PowerUp>;
  /** Every live ship to render. Array index == player slot, so per-slot
   *  mesh handles are kept stable across frames. Empty = no ships
   *  (e.g. during an intertitle hold). See WebGLOverlayCall jsdoc. */
  ships: ReadonlyArray<Ship | null | undefined>;
  /** Per-slot identity tint (index == player slot, parallel to `ships`).
   *  When set, the slot's ship mesh is re-hued onto that colour so 2P couch
   *  / duel ships match their HUD chips (P1 green, P2 blue). Undefined entry
   *  or absent array = stock cyan hull (solo). */
  shipTints?: ReadonlyArray<string | undefined>;
  /** Sim clock (ms) — time base for the shield-dome expiry fade. */
  elapsed: number;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
  worldW?: number;
  worldH?: number;
  /** World-X seam offsets for the portrait follow camera; one render pass
   *  per entry so mesh entities wrap. Absent / [0] off the follow camera. */
  wrapXs?: number[];
}): void {
  if (!handle) return;
  const { renderer, scene, camera, canvas } = handle;
  // Renderer size sync — setSize re-clears the canvas, so only call it
  // when the backing store actually changed.
  const sizeKey = canvas.width * 100000 + canvas.height;
  if (sizeKey !== handle.lastSizeKey) {
    handle.lastSizeKey = sizeKey;
    renderer.setSize(canvas.width, canvas.height, false);
  }
  const worldW = opts.worldW ?? WORLD_W;
  const worldH = opts.worldH ?? WORLD_H;
  if (handle.worldW !== worldW || handle.worldH !== worldH) {
    handle.worldW = worldW;
    handle.worldH = worldH;
    camera.left = 0;
    camera.right = worldW;
    camera.top = worldH;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
  }

  // Viewport matches the 2D ctx.setTransform so meshes pixel-align
  // with HUD/coins/etc. WebGL viewport y is bottom-up.
  const vpW = worldW * opts.scale * opts.dpr;
  const vpH = worldH * opts.scale * opts.dpr;
  const vpX = opts.tx * opts.dpr;
  const vpYTopDown = opts.ty * opts.dpr;
  const vpY = canvas.height - vpYTopDown - vpH;
  frameCounter += 1;

  // ── Asteroids ────────────────────────────────────────────────────
  for (const a of opts.asteroids) {
    if (!a.alive || a.id == null) continue;
    let entry = handle.asteroidMeshes.get(a.id);
    if (!entry) {
      if (a.stationPart) {
        const built = buildStationPart(a);
        scene.add(built.group);
        entry = { mesh: built.group, geometry: built.geometry, material: built.material, lastSeenFrame: frameCounter, builtRadius: a.radius };
      } else if (a.councilMember) {
        const built = buildCouncilMedallionMesh(a);
        scene.add(built.mesh);
        entry = { mesh: built.mesh, geometry: built.geometry, material: built.material, lastSeenFrame: frameCounter, builtRadius: a.radius };
      } else {
        const geometry = buildAsteroidGeometry(a);
        const baseColor = ASTEROID_TYPE_COLOR[a.type] ?? 0xb0a090;
        const matCfg = ASTEROID_TYPE_MAT[a.type] ?? ASTEROID_TYPE_MAT.stony;
        const material = new THREE.MeshPhongMaterial({
          color: baseColor,
          shininess: matCfg.shininess,
          specular: matCfg.specular,
          emissive: matCfg.emissive ?? 0x000000,
        });
        const diffuseKey = diffuseTypeFor(a.type);
        const cachedTypeMap = getDiffuseTexture(handle, diffuseKey);
        if (cachedTypeMap) {
          material.map = cachedTypeMap;
          material.bumpMap = cachedTypeMap;
          material.bumpScale = 0.35;
        } else {
          kickDiffuseLoad(handle, diffuseKey, material, false);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        entry = { mesh, geometry, material, lastSeenFrame: frameCounter, builtRadius: a.radius };
      }
      handle.asteroidMeshes.set(a.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    // Parallax z-offset — non-3 depth bands render behind/in-front of
    // the gameplay plane. Camera is at z=500, scene origin at z=0; depth
    // 1 sits at z=-80 (behind everything), depth 5 at z=+80 (in front).
    const depthCfg = DEPTH_CONFIGS[a.depth ?? 3];
    const zOffset = depthCfg?.meshZ ?? 0;
    entry.mesh.position.set(a.pos.x, worldH - a.pos.y, zOffset);
    // Per-band alpha — backgrounds fade into the void, gameplay plane
    // + foregrounds stay opaque (foregrounds must occlude what's
    // behind them, not see through). Always-set opacity so a rock that
    // changes depth (no current callers, but cheap to support) doesn't
    // stay translucent.
    const alphaMul = depthCfg?.alphaMul ?? 1;
    if ('opacity' in entry.material) {
      const mat = entry.material as THREE.MeshPhongMaterial;
      mat.transparent = alphaMul < 1;
      mat.opacity = alphaMul;
    }
    // Live radius can shift mid-life (council shrink-on-hit); scale
    // the mesh to match without re-building the GPU buffer.
    if (a.radius !== entry.builtRadius) {
      const s = a.radius / entry.builtRadius;
      entry.mesh.scale.set(s, s, s);
    }
    if (a.stationPart) {
      const ud = entry.mesh.userData;
      const flash = Math.max(0, Math.min(1, a.hitFlash));
      if (a.stationPart === 'core') {
        // The reactor sits flat; its crystal tumbles and the light throbs. As HP
        // drops it DESTABILISES — strobes faster, the emissive ramps up and
        // shifts hot toward white, so the core's health reads with no HP bar.
        entry.mesh.rotation.set(0, 0, 0);
        const crystal = ud.crystal as THREE.Object3D | undefined;
        const instab = a.hpMax > 0 ? 1 - Math.max(0, Math.min(1, a.hp / a.hpMax)) : 0;
        if (crystal) crystal.rotation.set(frameCounter * (0.011 + instab * 0.03), frameCounter * (0.014 + instab * 0.03), 0);
        const throb = Math.sin(frameCounter * (0.07 + instab * 0.18));
        const em = ud.energyMat as THREE.MeshPhongMaterial | undefined;
        if (em) {
          em.emissiveIntensity = 1.0 + instab * 0.8 + (0.4 + instab * 0.6) * throb + flash * 1.5;
          // Shift olivine-green toward overloading white-hot as it fails.
          em.emissive.setRGB(0.6 * instab + flash, 0.88 + 0.12 * flash, 0.36 + 0.5 * instab + flash);
        }
        const corona = ud.coronaMat as THREE.MeshBasicMaterial | undefined;
        if (corona) {
          corona.opacity = 0.22 + instab * 0.22 + 0.1 * throb + flash * 0.3;
          corona.color.setRGB(0.6 * instab + flash, 0.88, 0.36 + 0.5 * instab);
        }
      } else {
        // Arms + pods orient along their radial (negated for the Y-flip).
        entry.mesh.rotation.set(0, 0, -a.rot);
        const em = ud.emitterMat as THREE.MeshPhongMaterial | undefined;
        const lit = a.hpMax > 0 ? 0.3 + 0.7 * Math.max(0, Math.min(1, a.hp / a.hpMax)) : 1;  // dims as the pod breaks
        const pod = lit * (0.8 + 0.5 * Math.sin(frameCounter * 0.09 + (a.stationSlot ?? 0) * 3));
        if (em) {
          em.emissiveIntensity = pod + flash * 2.6;
          // Pop the orange toward white-hot on a hit/spit so it reads clearly.
          em.emissive.setRGB(1.0, 0.7 + 0.3 * flash, 0.29 + 0.7 * flash);
        }
        const pc = ud.emitterCorona as THREE.MeshBasicMaterial | undefined;
        if (pc) pc.opacity = 0.18 * lit + flash * 0.85;  // flares bright when the pod is hit / spits
        const conduit = ud.conduitMat as THREE.MeshPhongMaterial | undefined;  // arm flash
        if (conduit) conduit.emissiveIntensity = 0.8 + flash * 1.6;
      }
    } else if (a.councilMember) {
      // Medallion rotation: Y axis does the full face↔back flip so
      // both sides come round; X and Z axes WOBBLE within ±17° / ±9°
      // (bounded sin) so the portrait + back text always read right-
      // side-up when facing the camera. The previous unbounded X
      // rotation flipped the image upside-down every half cycle —
      // user couldn't read it. Wobble keeps it lively without that.
      entry.mesh.rotation.set(
        Math.sin(a.rot * 0.7) * 0.30,
        a.rot,
        Math.cos(a.rot * 0.5) * 0.15,
      );
      // Draw the portrait into the front-face canvas as soon as the
      // image lands. Cheap after the first successful draw.
      ensureCouncilFrontPortrait(a.councilMember);
    } else {
      entry.mesh.rotation.z = -a.rot;
      entry.mesh.rotation.x = a.rot * 0.55;
      entry.mesh.rotation.y = a.rot * 0.37;
    }
    entry.mesh.visible = true;
  }
  sweepStale(scene, handle.asteroidMeshes, frameCounter);

  // ── UFOs ─────────────────────────────────────────────────────────
  for (const u of opts.ufos) {
    if (!u.alive || u.id == null) continue;
    let entry = handle.ufoMeshes.get(u.id);
    if (!entry) {
      const { group, geometry, material } = buildUfoMesh(u);
      scene.add(group);
      entry = { mesh: group, geometry, material, lastSeenFrame: frameCounter, builtRadius: u.radius };
      handle.ufoMeshes.set(u.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    entry.mesh.position.set(u.pos.x, worldH - u.pos.y, 0);
    if (getFlavour() === '600bn') {
      // Proper zero-g tumble. Y is the fast face-revealing spin (the
      // cylinder is built upright so Y shows face → edge → back); X
      // and Z drift slower so the coin tumbles end-over-end and
      // sideways as it spins. Three incommensurate frequencies =
      // never repeats exactly.
      entry.mesh.rotation.set(
        frameCounter * 0.011,
        frameCounter * 0.027,
        frameCounter * 0.007,
      );
    } else {
      // Per-type idle motion. Each silhouette earns its own "personality"
      // so the threat reads from movement as well as shape. Animation
      // material refs are stashed on entry.mesh.userData by the build
      // functions and modulated here per frame.
      const ud = entry.mesh.userData;
      switch (u.type) {
        case 'sniper': {
          // Nose tracks direction of travel — the barrel always points
          // along the dir vector.
          entry.mesh.rotation.set(0, 0, -u.dir);
          // Muzzle charge cycle: opacity ramps up over ~1.6s then snaps
          // back to baseline, so the sniper visibly "winds up" before
          // each shot.
          const muzzle = ud.muzzleMat as THREE.MeshBasicMaterial | undefined;
          if (muzzle) {
            const cycle = (frameCounter * 0.012 + u.id * 0.7) % 1;
            muzzle.opacity = cycle < 0.92 ? 0.35 + cycle * 0.7 : 0.25;
          }
          break;
        }
        case 'tank': {
          entry.mesh.rotation.y = u.dir * 0.15;
          entry.mesh.rotation.z = frameCounter * 0.012;
          // Gun barrel chase — each tip glows brightly in sequence
          // around the turret, sells "cycling fire" without actually
          // firing.
          const tips = ud.barrelTipMats as THREE.MeshBasicMaterial[] | undefined;
          if (tips) {
            const lead = Math.floor((frameCounter * 0.04 + u.id) % tips.length);
            for (let i = 0; i < tips.length; i++) {
              tips[i].opacity = i === lead ? 0.95 : 0.3;
            }
          }
          break;
        }
        case 'elite': {
          entry.mesh.rotation.y = u.dir * 0.22;
          entry.mesh.rotation.z = frameCounter * 0.018 + Math.sin(frameCounter * 0.05 + u.id) * 0.12;
          // Predatory eye pulse — emissive intensity breathes between
          // 1.0 and 2.2, pupil tracks it. Reads as a sensor scanning
          // for prey.
          const eye = ud.eyeMat as THREE.MeshPhongMaterial | undefined;
          const pupil = ud.pupilMat as THREE.MeshBasicMaterial | undefined;
          const eyePulse = 0.5 + 0.5 * Math.sin(frameCounter * 0.07 + u.id);
          if (eye) eye.emissiveIntensity = 1.0 + eyePulse * 1.2;
          if (pupil) pupil.opacity = 0.7 + eyePulse * 0.3;
          break;
        }
        case 'boss': {
          entry.mesh.rotation.y = u.dir * 0.14;
          entry.mesh.rotation.z = Math.sin(frameCounter * 0.02 + u.id) * 0.05;
          // Core breath — opacity + scale pulse at ~0.7Hz. Sells the
          // "powered up" feel.
          const coreMat = ud.coreMat as THREE.MeshBasicMaterial | undefined;
          const coreMesh = ud.coreMesh as THREE.Mesh | undefined;
          const corePulse = 0.5 + 0.5 * Math.sin(frameCounter * 0.04);
          if (coreMat) coreMat.opacity = 0.65 + corePulse * 0.3;
          if (coreMesh) {
            const s = 0.9 + corePulse * 0.2;
            coreMesh.scale.set(s, s, s);
          }
          // Spire crown alternation — chase glow around the 4 spires.
          const spires = ud.spireTipMats as THREE.MeshBasicMaterial[] | undefined;
          if (spires) {
            const lead = Math.floor((frameCounter * 0.03) % spires.length);
            for (let i = 0; i < spires.length; i++) {
              spires[i].opacity = i === lead ? 1.0 : 0.45;
            }
          }
          // Orbital escort drones — the satellite group spins around
          // the boss centre. Slow enough to read as ceremonial flotilla.
          const escortGroup = ud.escortGroup as THREE.Group | undefined;
          if (escortGroup) escortGroup.rotation.z = frameCounter * 0.015;
          break;
        }
        case 'cruiser':
        default: {
          entry.mesh.rotation.y = u.dir * 0.25;
          entry.mesh.rotation.z = Math.sin(frameCounter * 0.04 + u.id) * 0.08;
          // Antenna tips pulse — top spike + bottom mast both breathe
          // gently. Tagged by id so multiple cruisers pulse out of phase.
          const tip = ud.pulseTipMat as THREE.MeshBasicMaterial | undefined;
          const mast = ud.pulseMastTipMat as THREE.MeshBasicMaterial | undefined;
          const p = 0.6 + 0.4 * Math.sin(frameCounter * 0.06 + u.id);
          if (tip) tip.opacity = 0.55 + p * 0.4;
          if (mast) mast.opacity = 0.5 + (1 - p) * 0.45;  // out of phase with tip
          break;
        }
      }
      // Rim port-hole ring spins independently of the hull bank/turret
      // sweep. Only saucer types stash a ringGroup (cruiser / tank /
      // boss). Speed tagged via id so multiple UFOs don't pulse in lockstep.
      const ringGroup = ud.ringGroup as THREE.Group | undefined;
      if (ringGroup) ringGroup.rotation.z = frameCounter * 0.06 + u.id * 0.3;
    }
    entry.mesh.visible = true;
  }
  sweepStale(scene, handle.ufoMeshes, frameCounter);

  // ── Powerups ─────────────────────────────────────────────────────
  // Each is a sphere with the glyph stamped four times around its
  // equator. Spin on Y so a glyph face rotates into view continuously;
  // small vertical bob makes them feel alive rather than static props.
  for (const p of opts.powerups) {
    if (!p.alive || p.collected || p.id == null) continue;
    let entry = handle.powerupMeshes.get(p.id);
    if (!entry) {
      const { mesh, geometry, material } = buildPowerupMesh(p);
      scene.add(mesh);
      entry = { mesh, geometry, material, lastSeenFrame: frameCounter, builtRadius: p.radius };
      handle.powerupMeshes.set(p.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    const bob = Math.sin(frameCounter * 0.05 + p.id) * 2;
    entry.mesh.position.set(p.pos.x, worldH - p.pos.y + bob, 0);
    // Three-axis tumble at incommensurate frequencies — the glyph
    // travels around the sphere in 3D rather than just spinning on Y.
    // Per-powerup phase (p.id) so the same powerup type at different
    // positions aren't lock-stepped.
    entry.mesh.rotation.set(
      frameCounter * 0.018 + p.id * 0.7,
      frameCounter * 0.045,
      frameCounter * 0.011 + p.id * 0.3,
    );
    entry.mesh.visible = true;
  }
  sweepStale(scene, handle.powerupMeshes, frameCounter);

  // ── Ships ────────────────────────────────────────────────────────
  // One mesh per slot; cached per-slot in handle.shipMeshes so 2P duel
  // / couch (which feed both players' ships) gets two distinct meshes
  // moving independently. Slots absent from opts.ships keep a hidden
  // mesh around so the rebuild cost (one ExtrudeGeometry per piece)
  // doesn't repeat on every respawn.
  for (let slot = 0; slot < opts.ships.length; slot++) {
    const ship = opts.ships[slot];
    if (ship && ship.alive) {
      const tint = opts.shipTints?.[slot] ?? null;
      let group = handle.shipMeshes[slot] as THREE.Object3D | undefined;
      let thrust = handle.shipThrusts[slot] as THREE.Mesh | undefined;
      // (Re)build when there's no mesh yet, OR when this slot's identity tint
      // changed since the cached mesh was built (the tint is baked into the
      // materials, so a colour change needs a fresh group). Dispose the old
      // group's geometry/materials first or rebuilds leak GPU memory.
      if (!group || handle.shipMeshTints[slot] !== tint) {
        if (group) {
          scene.remove(group);
          group.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.geometry) m.geometry.dispose();
            const mat = m.material;
            if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
          });
        }
        const built = buildShipMesh(tint ?? undefined);
        group = built.group;
        thrust = built.thrust;
        scene.add(group);
        handle.shipMeshes[slot] = group;
        handle.shipThrusts[slot] = thrust;
        handle.shipMeshTints[slot] = tint;
      }
      group.visible = true;
      group.position.set(ship.pos.x, worldH - ship.pos.y, 0);
      group.rotation.set(0, 0, -ship.rot);
      if (thrust) {
        thrust.visible = !!ship.thrusting;
        const s = 0.85 + Math.random() * 0.3;
        thrust.scale.set(s, s, s);
      }
    } else {
      const group = handle.shipMeshes[slot];
      if (group) group.visible = false;
      const thrust = handle.shipThrusts[slot];
      if (thrust) thrust.visible = false;
    }
  }
  // Hide any cached meshes for slots that are NO LONGER present in opts
  // (e.g. a player slot was removed between renders — uncommon but
  // possible during mode swap).
  for (let slot = opts.ships.length; slot < handle.shipMeshes.length; slot++) {
    const group = handle.shipMeshes[slot];
    if (group) group.visible = false;
    const thrust = handle.shipThrusts[slot];
    if (thrust) thrust.visible = false;
  }

  // ── Shield domes ─────────────────────────────────────────────────
  // Faceted icosphere + edge wireframe per ship slot, parented at the
  // ship's world position (NOT the ship group, so the shield doesn't
  // roll with hull rotation — it's a sphere around the ship, not a
  // fixed shape). Lazy-create on first activation per slot; kept
  // around invisible afterwards because re-creating the geometry every
  // shield burst is wasteful.
  for (let slot = 0; slot < opts.ships.length; slot++) {
    const ship = opts.ships[slot];
    if (ship && ship.alive && ship.shieldUp && ship.hyperspaceCloakMs <= 0) {
      let shield = handle.shieldMeshes[slot] as THREE.Group | undefined;
      let sphereMat = handle.shieldSphereMats[slot] as THREE.MeshPhongMaterial | undefined;
      let edgeMat = handle.shieldEdgeMats[slot] as THREE.LineBasicMaterial | undefined;
      if (!shield) {
        const built = buildShieldDome(ship.radius);
        shield = built.group;
        sphereMat = built.sphereMat;
        edgeMat = built.edgeMat;
        scene.add(shield);
        handle.shieldMeshes[slot] = shield;
        handle.shieldSphereMats[slot] = sphereMat;
        handle.shieldEdgeMats[slot] = edgeMat;
      }
      shield.visible = true;
      shield.position.set(ship.pos.x, worldH - ship.pos.y, 0);
      // Slow drift rotation — gives the dome a living-energy feel without
      // chasing ship rotation (so the player reads it as a field, not armour).
      shield.rotation.x += 0.004;
      shield.rotation.y += 0.006;
      // Final-300ms fade so the shield isn't yanked off the screen at expiry.
      const remaining = Math.max(0, ship.shieldExpiresAt - opts.elapsed);
      const fade = Math.min(1, remaining / 300);
      const hit = Math.max(0, Math.min(1, ship.shieldHitFlash));
      if (sphereMat) {
        sphereMat.opacity = (0.18 + hit * 0.45) * fade;
        sphereMat.emissiveIntensity = 0.5 + hit * 1.6;
      }
      if (edgeMat) {
        edgeMat.opacity = (0.85 + hit * 0.15) * fade;
      }
    } else {
      const shield = handle.shieldMeshes[slot];
      if (shield) shield.visible = false;
    }
  }
  for (let slot = opts.ships.length; slot < handle.shieldMeshes.length; slot++) {
    const shield = handle.shieldMeshes[slot];
    if (shield) shield.visible = false;
  }

  // ── Ship-explosion chunks ────────────────────────────────────────
  // Wall-clock dt — renderOverlay isn't fed a dt by callers. Clamp on
  // the first frame (when lastFrameMs is 0) so a freshly-loaded overlay
  // doesn't burn a huge dt and instantly age out every chunk.
  if (handle.shipChunks.length > 0) {
    const nowMs = performance.now();
    const rawDt = handle.lastFrameMs === 0 ? 0.016 : (nowMs - handle.lastFrameMs) / 1000;
    const dt = Math.min(0.05, Math.max(0, rawDt));
    for (let i = handle.shipChunks.length - 1; i >= 0; i--) {
      const c = handle.shipChunks[i];
      c.mesh.position.x += c.vel.x * dt;
      c.mesh.position.y += c.vel.y * dt;
      c.mesh.position.z += c.vel.z * dt;
      c.mesh.rotation.x += c.rotVel.x * dt;
      c.mesh.rotation.y += c.rotVel.y * dt;
      c.mesh.rotation.z += c.rotVel.z * dt;
      // Mild outward expansion damping so chunks don't sail off-screen
      // too quickly — they should hang in the explosion zone briefly.
      c.vel.x *= Math.exp(-0.5 * dt);
      c.vel.y *= Math.exp(-0.5 * dt);
      c.vel.z *= Math.exp(-0.5 * dt);
      c.ttl -= dt * 1000;
      // Fade in the last 40% of life — readable longer if the chunk
      // happened to be in shadow at full alpha.
      const fadeStart = c.maxTtl * 0.4;
      if (c.ttl < fadeStart) {
        c.material.opacity = Math.max(0, c.ttl / fadeStart);
      }
      if (c.ttl <= 0) {
        scene.remove(c.mesh);
        c.geometry.dispose();
        c.material.dispose();
        handle.shipChunks.splice(i, 1);
      }
    }
    handle.lastFrameMs = nowMs;
  } else {
    handle.lastFrameMs = 0;
  }

  // Wrap-aware draw. The world is a torus; under the portrait follow camera
  // the visible strip can straddle the x=0 / WORLD_W seam, so render the scene
  // once per visible world copy, shifting the viewport a full world width each
  // time. The framebuffer bounds clip each pass. Off the follow camera wrapXs
  // is a single [0] and this is one ordinary pass.
  const wrapXs = opts.wrapXs ?? [0];
  renderer.autoClear = false;
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.setScissorTest(true);
  for (const dx of wrapXs) {
    const ox = vpX + dx * opts.scale * opts.dpr;
    renderer.setViewport(ox, vpY, vpW, vpH);
    renderer.setScissor(ox, vpY, vpW, vpH);
    renderer.render(scene, camera);
  }
}

/** Drop entries the renderer hasn't seen for ≥30 frames (entity died
 *  / left the field). Disposes GPU resources to keep memory flat. */
function sweepStale<M extends THREE.Material>(
  scene: THREE.Scene,
  map: Map<number, MeshEntry<M>>,
  frame: number,
): void {
  for (const [id, entry] of map) {
    if (frame - entry.lastSeenFrame > 30) {
      scene.remove(entry.mesh);
      // entry.geometry/material is only the representative pair. Multi-mesh
      // GROUPS (station parts, council medallions) own many more — traverse and
      // dispose every one, or they leak (which on iOS compounds into the
      // "slows to a stop" GPU-memory creep across W17 retries).
      entry.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
      });
      map.delete(id);
    } else {
      entry.mesh.visible = entry.lastSeenFrame === frame;
    }
  }
}

export function hideOverlay(): void {
  handle?.canvas.classList.remove('is-active');
}

export function showOverlay(): void {
  handle?.canvas.classList.add('is-active');
}
