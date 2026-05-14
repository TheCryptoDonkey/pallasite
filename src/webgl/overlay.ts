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
 *   World is 960×720 with Y down (screen convention). The
 *   OrthographicCamera uses three.js's standard Y-up frustum
 *   (top=720, bottom=0); mesh positions invert Y at the boundary
 *   (mesh.position.y = WORLD_H - a.pos.y), and rotation is negated
 *   so the apparent spin direction matches the 2D path.
 *
 *   The Y-flipped projection alternative looked correct mathematically
 *   but tripped three.js's per-mesh frustum culling, which silently
 *   skipped every draw. We bypass culling anyway (frustumCulled =
 *   false) because our scene is tiny.
 */

import * as THREE from 'three';
import type { Asteroid, PowerUp, PowerUpType, Ship, Ufo } from '../types.js';
import { POWERUP_CONFIG, POWERUP_RADIUS } from '../types.js';
import { getMemberImage } from '../sanctum-avatars.js';
import { getFlavour } from '../flavour.js';

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
  /** Singleton ship mesh — built lazily on first ship frame. */
  shipMesh: THREE.Object3D | null;
  shipThrust: THREE.Mesh | null;
  /** Cached canvas.width × canvas.height so setSize only fires on
   *  actual size change (always-on setSize re-clears every frame). */
  lastSizeKey: number;
}

interface MeshEntry<M extends THREE.Material> {
  mesh: THREE.Mesh | THREE.Group;
  geometry: THREE.BufferGeometry;
  material: M;
  lastSeenFrame: number;
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
    grad.addColorStop(0, '#fff6c0');
    grad.addColorStop(0.5, '#ffd84a');
    grad.addColorStop(1, '#8a5800');
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
  ctx.strokeStyle = gold ? '#5a3a00' : '#ffd84a';
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
  // Dark inner ring + gold outer ring around the portrait — frames
  // the face against the coin gradient.
  ctx.strokeStyle = '#0a0418';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, portraitR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffd84a';
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
  ctx.fillStyle = '#ffd84a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 88px Georgia, serif';
  ctx.fillText(member.role, c.width / 2, c.height / 2 - 28);
  // Archetype below — wrap to two lines if longer than fits.
  ctx.fillStyle = '#d8c08a';
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
    color: 0xb87400,
    shininess: 200,
    specular: 0xfff0a0,
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
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, 960, 720, 0, 0.1, 1000);
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
    const ambient = new THREE.AmbientLight(0xa8b0b8, 0.75);
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
      shipMesh: null,
      shipThrust: null,
      lastSizeKey: 0,
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
 *      time-lock motif (and a wink to the conference crowd)
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
 *  "time-locked" iconography; the 4:20 reading is a deliberate
 *  conference-crowd wink. */
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

function build600bnCoinMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.Material } {
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
function buildUfoMesh(u: Ufo): { group: THREE.Group; geometry: THREE.BufferGeometry; material: THREE.Material } {
  // 600bn flavour: every UFO is the $600B coin (matches the 2D path).
  if (getFlavour() === '600bn') return build600bnCoinMesh(u);
  const palette = UFO_PALETTE[u.type];
  const group = new THREE.Group();
  // Body — flat disc (squashed cylinder). Radius scaled by type.
  const bodyR = u.radius * palette.scale;
  const bodyH = bodyR * 0.32;
  const bodyGeo = new THREE.CylinderGeometry(bodyR, bodyR * 0.85, bodyH, 24);
  bodyGeo.rotateX(Math.PI / 2);  // lay flat in XY plane (face camera)
  const bodyMat = new THREE.MeshPhongMaterial({
    color: palette.body,
    shininess: 50,
    specular: 0x808080,
    emissive: palette.glow,
    emissiveIntensity: 0.25,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.frustumCulled = false;
  group.add(bodyMesh);
  // Dome — half-sphere on top
  const domeR = bodyR * 0.55;
  const domeGeo = new THREE.SphereGeometry(domeR, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  domeGeo.rotateX(-Math.PI / 2);
  domeGeo.translate(0, 0, bodyH * 0.4);
  const domeMat = new THREE.MeshPhongMaterial({
    color: palette.dome,
    shininess: 120,
    specular: 0xffffff,
    emissive: palette.glow,
    emissiveIntensity: 0.6,
    transparent: true,
    opacity: 0.85,
  });
  const domeMesh = new THREE.Mesh(domeGeo, domeMat);
  domeMesh.frustumCulled = false;
  group.add(domeMesh);
  // Underglow — small additive sphere below body so the UFO reads as
  // hovering/lit from beneath.
  const glowGeo = new THREE.SphereGeometry(bodyR * 0.7, 12, 8);
  const glowMat = new THREE.MeshBasicMaterial({
    color: palette.glow,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
  });
  const glowMesh = new THREE.Mesh(glowGeo, glowMat);
  glowMesh.frustumCulled = false;
  glowMesh.position.z = -bodyH * 0.3;
  glowMesh.scale.set(1, 1, 0.4);
  group.add(glowMesh);
  return { group, geometry: bodyGeo, material: bodyMat };
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

export function renderOverlay(opts: {
  asteroids: ReadonlyArray<Asteroid>;
  ufos: ReadonlyArray<Ufo>;
  powerups: ReadonlyArray<PowerUp>;
  ship: Ship | null;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
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
  // Viewport matches the 2D ctx.setTransform so meshes pixel-align
  // with HUD/coins/etc. WebGL viewport y is bottom-up.
  const vpW = 960 * opts.scale * opts.dpr;
  const vpH = 720 * opts.scale * opts.dpr;
  const vpX = opts.tx * opts.dpr;
  const vpYTopDown = opts.ty * opts.dpr;
  const vpY = canvas.height - vpYTopDown - vpH;
  renderer.setViewport(vpX, vpY, vpW, vpH);
  renderer.setScissor(vpX, vpY, vpW, vpH);
  renderer.setScissorTest(true);
  frameCounter += 1;

  // ── Asteroids ────────────────────────────────────────────────────
  for (const a of opts.asteroids) {
    if (!a.alive || a.id == null) continue;
    let entry = handle.asteroidMeshes.get(a.id);
    if (!entry) {
      if (a.councilMember) {
        const built = buildCouncilMedallionMesh(a);
        scene.add(built.mesh);
        entry = { mesh: built.mesh, geometry: built.geometry, material: built.material, lastSeenFrame: frameCounter };
      } else {
        const geometry = buildAsteroidGeometry(a);
        const baseColor = ASTEROID_TYPE_COLOR[a.type] ?? 0xb0a090;
        const matCfg = ASTEROID_TYPE_MAT[a.type] ?? ASTEROID_TYPE_MAT.stony;
        const material = new THREE.MeshPhongMaterial({
          color: baseColor,
          shininess: matCfg.shininess,
          specular: matCfg.specular,
        });
        const cachedTypeMap = getDiffuseTexture(handle, a.type);
        if (cachedTypeMap) {
          material.map = cachedTypeMap;
          material.bumpMap = cachedTypeMap;
          material.bumpScale = 0.35;
        } else {
          kickDiffuseLoad(handle, a.type, material, false);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        entry = { mesh, geometry, material, lastSeenFrame: frameCounter };
      }
      handle.asteroidMeshes.set(a.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    entry.mesh.position.set(a.pos.x, 720 - a.pos.y, 0);
    if (a.councilMember) {
      // Medallion tumble — main rotation around Y (vertical axis) flips
      // the coin face↔back, with small X/Z wobble for life. Slower than
      // non-council asteroids so the portrait reads when facing camera.
      entry.mesh.rotation.set(
        Math.sin(a.rot * 0.5) * 0.18,
        a.rot,
        Math.cos(a.rot * 0.4) * 0.10,
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
      entry = { mesh: group, geometry, material, lastSeenFrame: frameCounter };
      handle.ufoMeshes.set(u.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    entry.mesh.position.set(u.pos.x, 720 - u.pos.y, 0);
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
      // Saucer: banking roll on direction + small sin-wave hover.
      entry.mesh.rotation.y = u.dir * 0.25;
      entry.mesh.rotation.z = Math.sin(frameCounter * 0.04 + u.id) * 0.08;
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
      entry = { mesh, geometry, material, lastSeenFrame: frameCounter };
      handle.powerupMeshes.set(p.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    const bob = Math.sin(frameCounter * 0.05 + p.id) * 2;
    entry.mesh.position.set(p.pos.x, 720 - p.pos.y + bob, 0);
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

  // ── Ship ─────────────────────────────────────────────────────────
  if (opts.ship && opts.ship.alive) {
    if (!handle.shipMesh) {
      const group = new THREE.Group();
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
        color: 0x9be7ff,
        shininess: 80,
        specular: 0xffffff,
        emissive: 0x4080a0,
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
        color: 0xb8f0ff,
        shininess: 240,
        specular: 0xffffff,
        emissive: 0x4080a0,
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
        color: 0x8ad4ff,
        shininess: 60,
        specular: 0xffffff,
        emissive: 0x305070,
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
        color: 0x6db4dc,
        shininess: 80,
        specular: 0xffffff,
        emissive: 0x305070,
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
        color: 0x4a7eb0,
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
        color: 0x6080a0,
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
      scene.add(group);
      handle.shipMesh = group;
      handle.shipThrust = thrustMesh;
    }
    const group = handle.shipMesh;
    group.visible = true;
    group.position.set(opts.ship.pos.x, 720 - opts.ship.pos.y, 0);
    group.rotation.set(0, 0, -opts.ship.rot);
    if (handle.shipThrust) {
      handle.shipThrust.visible = !!opts.ship.thrusting;
      const s = 0.85 + Math.random() * 0.3;
      handle.shipThrust.scale.set(s, s, s);
    }
  } else if (handle.shipMesh) {
    handle.shipMesh.visible = false;
    if (handle.shipThrust) handle.shipThrust.visible = false;
  }

  renderer.render(scene, camera);
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
      entry.geometry.dispose();
      entry.material.dispose();
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
