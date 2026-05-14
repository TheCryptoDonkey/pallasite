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

/** Per-type fallback base colour. Visible immediately so a slow texture
 *  decode doesn't show pitch-black meshes against the dark background. */
const ASTEROID_TYPE_COLOR: Record<string, number> = {
  stony:     0xb0a090,
  iron:      0xc8b888,
  chondrite: 0xc0d0e0,
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
 *  Displaced icosphere. The 2D `shape[]` array drives the longitudinal
 *  silhouette so the 3D body echoes the 2D outline; layered octave noise
 *  on top adds crater/bump detail the flat shape array can't express.
 *  Identity is preserved across the vector → shaded → mesh tier hop. */
function buildAsteroidGeometry(a: Asteroid): THREE.BufferGeometry {
  const detail = a.size === 'large' ? 4 : a.size === 'medium' ? 3 : 2;
  const geo = new THREE.IcosahedronGeometry(a.radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const shape = a.shape;
  const shapeN = shape.length;
  const seedBase = a.id != null
    ? ((a.id * 2654435761) >>> 0)
    : hashStr(`${a.pos.x | 0},${a.pos.y | 0}`);
  // Type-keyed terrain character. Iron gets sharper craters from a
  // stronger high-frequency band; chondrite chunks read as porous
  // pock-marks; pallasite stays smooth (gem-like).
  const ruggedness = a.type === 'chondrite' ? 0.22
                   : a.type === 'iron'      ? 0.18
                   : a.type === 'pallasite' ? 0.08
                                            : 0.14;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Longitudinal angle drives shape[] sampling — links 3D silhouette
    // to the 2D one the player has been seeing.
    const ang = Math.atan2(y, x);
    const t = (ang / (Math.PI * 2) + 1) % 1;
    const f = t * shapeN;
    const i0 = Math.floor(f) % shapeN;
    const i1 = (i0 + 1) % shapeN;
    const blend = f - Math.floor(f);
    const shapeR = shape[i0] * (1 - blend) + shape[i1] * blend;
    // Layered octave noise — three frequencies with halving amplitude.
    // Coordinates are normalised to unit-sphere space (x/r) so the
    // noise pattern is independent of asteroid size and reads
    // consistently across small/medium/large fragments.
    const r0 = Math.hypot(x, y, z) || 1;
    const ux = x / r0, uy = y / r0, uz = z / r0;
    const seedOff = (seedBase ^ (i * 2654435761)) >>> 0;
    const phase1 = (seedOff & 0x3ff) * 0.01;
    const phase2 = ((seedOff >> 10) & 0x3ff) * 0.011;
    const phase3 = ((seedOff >> 20) & 0x3ff) * 0.013;
    const n1 = Math.sin(ux * 3.1 + phase1) * Math.sin(uy * 3.0 + phase2) * Math.sin(uz * 3.3 + phase3);
    const n2 = Math.sin(ux * 6.7 + phase2) * Math.sin(uy * 7.1 + phase3) * Math.sin(uz * 6.9 + phase1);
    const n3 = Math.sin(ux * 13.0 + phase3) * Math.sin(uy * 12.5 + phase1) * Math.sin(uz * 13.5 + phase2);
    const bumps = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
    const scale = shapeR + bumps * ruggedness;
    pos.setXYZ(i, x * scale, y * scale, z * scale);
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
    // Lights — strong key from upper-left, modest ambient fill,
    // cool rim from the opposite side. Ambient kept low so the
    // lit/unlit contrast on rock surfaces is dramatic enough for
    // specular highlights to read clearly.
    const sun = new THREE.DirectionalLight(0xfff2da, 1.8);
    sun.position.set(-200, -200, 300);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0x8090a0, 0.55);
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
  const h = r * 0.18;
  const group = new THREE.Group();
  // Side wall (gold ring without text) + textured caps.
  const sideMat = new THREE.MeshPhongMaterial({
    color: 0xc88a00,
    shininess: 180,
    specular: 0xfff0a0,
  });
  const capMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    map: getSixHundredBnFaceTexture(),
    shininess: 220,
    specular: 0xffffff,
    emissive: 0x402000,
    emissiveIntensity: 0.35,
  });
  // CylinderGeometry materials: [side, capTop, capBottom]
  const geo = new THREE.CylinderGeometry(r, r, h, 48);
  geo.rotateX(Math.PI / 2);             // disc faces +Z (camera)
  const mesh = new THREE.Mesh(geo, [sideMat, capMat, capMat]);
  mesh.frustumCulled = false;
  group.add(mesh);
  // Subtle additive halo so the coin reads as glowing against the
  // dark space backdrop.
  const haloGeo = new THREE.RingGeometry(r * 1.05, r * 1.35, 48);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffd84a,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.frustumCulled = false;
  group.add(halo);
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
      // Coin: spin around Z (face-axis) like the 2D rotating badge.
      // No banking — it's a flat coin, not a banking saucer.
      entry.mesh.rotation.set(0, 0, frameCounter * 0.02);
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
