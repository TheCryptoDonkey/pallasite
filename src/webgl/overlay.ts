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
import type { Asteroid, Ship, Ufo } from '../types.js';
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
  stony:     0xd0c0a8,
  iron:      0xe0c898,
  chondrite: 0xd8e4ee,
  pallasite: 0xf0c860,
};

/** Per-type Phong tuning — specular highlight + shininess. Emissive
 *  dropped entirely (was reading as "ghostly/see-through" because it
 *  brightened the rock regardless of view angle). Higher shininess
 *  across the board so the rocks read as solid lit bodies with
 *  distinct highlight points. */
interface AsteroidTypeMaterial {
  shininess: number;
  specular: number;
}
const ASTEROID_TYPE_MAT: Record<string, AsteroidTypeMaterial> = {
  stony:     { shininess: 60,  specular: 0x707070 },
  iron:      { shininess: 140, specular: 0xc0a880 },
  chondrite: { shininess: 35,  specular: 0x506070 },
  pallasite: { shininess: 110, specular: 0xd0a040 },
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
  // Higher detail than before — modern GPUs handle these counts easily
  // and the silhouette is what reads "asteroid" vs "lumpy sphere".
  const detail = a.size === 'large' ? 5 : a.size === 'medium' ? 4 : 3;
  const geo = new THREE.IcosahedronGeometry(a.radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const shape = a.shape;
  const shapeN = shape.length;
  const seedBase = a.id != null
    ? ((a.id * 2654435761) >>> 0)
    : hashStr(`${a.pos.x | 0},${a.pos.y | 0}`);
  // Type-keyed terrain character. Iron crisp, chondrite porous,
  // pallasite gem-smooth, stony in between. Values pushed up overall
  // — was reading as too pebble-like.
  const ruggedness = a.type === 'chondrite' ? 0.36
                   : a.type === 'iron'      ? 0.30
                   : a.type === 'pallasite' ? 0.18
                                            : 0.28;
  // Asymmetric stretch — each asteroid is slightly ovoid, never a
  // perfect sphere. Seed-derived so identity persists across frames.
  const stretchX = 0.85 + ((seedBase >>> 0) & 0xff) / 0xff * 0.3;       // 0.85..1.15
  const stretchY = 0.85 + ((seedBase >>> 8) & 0xff) / 0xff * 0.3;
  const stretchZ = 0.85 + ((seedBase >>> 16) & 0xff) / 0xff * 0.3;
  // Crater pass — pick 4-6 random points on the unit sphere; each
  // carves a bowl-shaped depression. Number + position deterministic
  // from seed so the same rock craters the same way each frame.
  const craterCount = 4 + (seedBase & 0x3);
  const craters: Array<{ cx: number; cy: number; cz: number; r: number; depth: number }> = [];
  for (let c = 0; c < craterCount; c++) {
    const s = (seedBase * (c + 1) * 2654435761) >>> 0;
    // Random point on unit sphere via cylindrical mapping.
    const theta = ((s & 0xffff) / 0xffff) * Math.PI * 2;
    const z01 = ((s >>> 16) & 0xffff) / 0xffff * 2 - 1;       // -1..1
    const rxy = Math.sqrt(1 - z01 * z01);
    craters.push({
      cx: Math.cos(theta) * rxy,
      cy: Math.sin(theta) * rxy,
      cz: z01,
      r: 0.18 + ((s >>> 4) & 0xff) / 0xff * 0.20,             // 0.18..0.38 of sphere
      depth: 0.10 + ((s >>> 12) & 0xff) / 0xff * 0.18,        // 0.10..0.28
    });
  }
  for (let i = 0; i < n; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    // Longitudinal angle drives shape[] sampling — links 3D silhouette
    // to the 2D one the player has been seeing.
    const ang = Math.atan2(y, x);
    const t = (ang / (Math.PI * 2) + 1) % 1;
    const f = t * shapeN;
    const i0 = Math.floor(f) % shapeN;
    const i1 = (i0 + 1) % shapeN;
    const blend = f - Math.floor(f);
    const shapeR = shape[i0] * (1 - blend) + shape[i1] * blend;
    // Five-octave layered noise. Unit-sphere coords so the pattern is
    // size-independent and small fragments echo their parent.
    const r0 = Math.hypot(x, y, z) || 1;
    const ux = x / r0, uy = y / r0, uz = z / r0;
    const seedOff = (seedBase ^ (i * 2654435761)) >>> 0;
    const p1 = (seedOff & 0x3ff) * 0.01;
    const p2 = ((seedOff >> 10) & 0x3ff) * 0.011;
    const p3 = ((seedOff >> 20) & 0x3ff) * 0.013;
    const n1 = Math.sin(ux * 2.7 + p1) * Math.sin(uy * 2.5 + p2) * Math.sin(uz * 2.9 + p3);
    const n2 = Math.sin(ux * 5.3 + p2) * Math.sin(uy * 5.7 + p3) * Math.sin(uz * 5.1 + p1);
    const n3 = Math.sin(ux * 10.5 + p3) * Math.sin(uy * 11.1 + p1) * Math.sin(uz * 10.7 + p2);
    const n4 = Math.sin(ux * 21.0 + p1) * Math.sin(uy * 20.3 + p2) * Math.sin(uz * 21.7 + p3);
    const n5 = Math.sin(ux * 42.0 + p2) * Math.sin(uy * 41.7 + p3) * Math.sin(uz * 42.3 + p1);
    const bumps = n1 * 0.5 + n2 * 0.25 + n3 * 0.13 + n4 * 0.07 + n5 * 0.05;
    // Crater pass — for each crater, distance from this vertex (as a
    // unit-direction) to the crater centre. Inside crater radius,
    // carve a smoothstep bowl.
    let craterDepth = 0;
    for (const c of craters) {
      const d = Math.hypot(ux - c.cx, uy - c.cy, uz - c.cz);
      if (d < c.r) {
        const t2 = d / c.r;                  // 0 at centre, 1 at rim
        const fall = 1 - t2 * t2 * (3 - 2 * t2);  // smoothstep falloff
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

  // Council asteroids: planar UV mapping from the +Z hemisphere so the
  // portrait reads as a face stamped on the front of the rock rather
  // than wrapping around the sphere. ClampToEdge then ensures the back
  // face shows the texture's edge pixels, not a mirrored portrait.
  if (a.councilMember) {
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const maxExtent = a.radius * 1.5;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // Project onto the XY plane. Range [-1, 1] → UV [0, 1].
      const u = (x / maxExtent) * 0.5 + 0.5;
      const v = 0.5 - (y / maxExtent) * 0.5;
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }
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

function kickDiffuseLoad(h: OverlayHandle, type: string, attachTo: THREE.MeshPhongMaterial): void {
  const existing = h.diffuseCache.get(type);
  if (existing) {
    attachTo.map = existing;
    attachTo.needsUpdate = true;
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.load(`/backgrounds/asteroid-${type}.webp`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    h.diffuseCache.set(type, tex);
    attachTo.map = tex;
    attachTo.needsUpdate = true;
  });
}

/** Build (or fetch from cache) a council member's portrait texture.
 *  getMemberImage returns the pre-baked 128px canvas from
 *  sanctum-avatars; we wrap it in a CanvasTexture. Returns null if
 *  the image hasn't decoded yet (caller retries on subsequent
 *  frames via attachCouncilTextureWhenReady). */
function getCouncilTexture(h: OverlayHandle, name: string): THREE.Texture | null {
  const cached = h.councilTextureCache.get(name);
  if (cached) return cached;
  const img = getMemberImage(name);
  if (!img) return null;
  const tex = new THREE.CanvasTexture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  // ClampToEdge keeps the portrait from repeating across the sphere
  // surface; sphere UVs already wrap longitudinally so the back of
  // the rock shows the seam, not a tiled face.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  h.councilTextureCache.set(name, tex);
  return tex;
}

/** Per-frame retry — if a council asteroid's material doesn't have a
 *  portrait map yet (because the image hadn't decoded when the mesh
 *  was built), try again. Cheap when nothing's pending. */
function attachCouncilTextureWhenReady(
  h: OverlayHandle,
  mat: THREE.MeshPhongMaterial,
  name: string,
): void {
  if (mat.map) return;
  const tex = getCouncilTexture(h, name);
  if (!tex) return;
  mat.map = tex;
  mat.color = new THREE.Color(0xffffff);
  mat.needsUpdate = true;
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
    // Lights — strong key from upper-left, warm-neutral ambient fill,
    // cool rim from below-right. Ambient bumped to 0.85 so the unlit
    // hemisphere doesn't fall to pitch-black against the dark space
    // backdrop (that's what was reading as "see-through"); the key +
    // rim still provide plenty of contrast for shading to read.
    const sun = new THREE.DirectionalLight(0xfff2da, 1.8);
    sun.position.set(-200, -200, 300);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0xa8b0b8, 0.85);
    scene.add(ambient);
    const rim = new THREE.DirectionalLight(0x80a0ff, 0.5);
    rim.position.set(250, 250, 200);
    scene.add(rim);
    handle = {
      renderer, scene, camera, canvas,
      asteroidMeshes: new Map(),
      ufoMeshes: new Map(),
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
 *  gold coin: thick cylinder + canvas-rendered wordmark texture on
 *  both faces + bright specular so it catches the key light. */
let sixHundredBnFaceTexture: THREE.CanvasTexture | null = null;
function getSixHundredBnFaceTexture(): THREE.CanvasTexture {
  if (sixHundredBnFaceTexture) return sixHundredBnFaceTexture;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d')!;
  // Radial gold gradient — brighter centre fades to deep gold edge.
  const grad = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  grad.addColorStop(0, '#fff6c0');
  grad.addColorStop(0.5, '#ffd84a');
  grad.addColorStop(1, '#8a5800');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fill();
  // Outer rim stroke for the "coin edge" feel.
  ctx.strokeStyle = '#5a3a00';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(128, 128, 121, 0, Math.PI * 2);
  ctx.stroke();
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
  sixHundredBnFaceTexture = tex;
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
  // Faces carry the 4-line wordmark texture.
  const capMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getSixHundredBnFaceTexture(),
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
  const mesh = new THREE.Mesh(geo, [sideMat, capMat, capMat]);
  mesh.frustumCulled = false;
  group.add(mesh);
  group.add(rimTop);
  group.add(rimBot);
  return { group, geometry: geo, material: capMat };
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

export function renderOverlay(opts: {
  asteroids: ReadonlyArray<Asteroid>;
  ufos: ReadonlyArray<Ufo>;
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
      const geometry = buildAsteroidGeometry(a);
      const baseColor = ASTEROID_TYPE_COLOR[a.type] ?? 0xb0a090;
      const matCfg = ASTEROID_TYPE_MAT[a.type] ?? ASTEROID_TYPE_MAT.stony;
      const material = new THREE.MeshPhongMaterial({
        color: baseColor,
        shininess: matCfg.shininess,
        specular: matCfg.specular,
      });
      // Council members get their portrait as the diffuse map.
      // Photoreal type texture is loaded as a fallback so the rock is
      // never blank if the portrait hasn't decoded yet — once the
      // image is ready, attachCouncilTextureWhenReady (run per frame
      // below) swaps the portrait in.
      const cachedTypeMap = getDiffuseTexture(handle, a.type);
      if (cachedTypeMap) material.map = cachedTypeMap;
      else kickDiffuseLoad(handle, a.type, material);
      if (a.councilMember) {
        const portrait = getCouncilTexture(handle, a.councilMember.name);
        if (portrait) {
          material.map = portrait;
          material.color = new THREE.Color(0xffffff);
        }
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      scene.add(mesh);
      entry = { mesh, geometry, material, lastSeenFrame: frameCounter };
      handle.asteroidMeshes.set(a.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    entry.mesh.position.set(a.pos.x, 720 - a.pos.y, 0);
    entry.mesh.rotation.z = -a.rot;
    entry.mesh.rotation.x = a.rot * 0.55;
    entry.mesh.rotation.y = a.rot * 0.37;
    entry.mesh.visible = true;
    // If this is a council asteroid and the portrait wasn't ready at
    // mesh-build time, try again now. Cheap once the texture has been
    // attached (the map check short-circuits).
    if (a.councilMember) {
      attachCouncilTextureWhenReady(handle, entry.material, a.councilMember.name);
    }
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

  // ── Ship ─────────────────────────────────────────────────────────
  if (opts.ship && opts.ship.alive) {
    if (!handle.shipMesh) {
      const group = new THREE.Group();
      const hullGeo = new THREE.ExtrudeGeometry(
        new THREE.Shape([
          new THREE.Vector2(14, 0),
          new THREE.Vector2(-10, 8),
          new THREE.Vector2(-6, 0),
          new THREE.Vector2(-10, -8),
        ]),
        { depth: 4, bevelEnabled: true, bevelSize: 1.2, bevelThickness: 1.2, bevelSegments: 2 },
      );
      hullGeo.translate(0, 0, -2);
      const hullMat = new THREE.MeshPhongMaterial({
        color: 0x9be7ff,
        shininess: 80,
        specular: 0xffffff,
        emissive: 0x4080a0,
        emissiveIntensity: 0.5,
      });
      const hullMesh = new THREE.Mesh(hullGeo, hullMat);
      hullMesh.frustumCulled = false;
      group.add(hullMesh);
      const thrustGeo = new THREE.ConeGeometry(5, 14, 12);
      thrustGeo.rotateZ(Math.PI / 2);
      thrustGeo.translate(-14, 0, 0);
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
