/**
 * WebGL overlay for the MESH visual tier. Sits over the 2D canvas and
 * renders only the entities the player has opted into mesh tier for
 * (asteroids today; ship/bullets/particles arriving in phase 2.x).
 *
 * three.js is statically imported here, but THIS module is dynamically
 * imported by the consumer (visual-style.ts / render.ts). Vite splits
 * the resulting chunk so the base bundle stays free of three.js until a
 * user actually flips a category to MESH.
 *
 * Lifecycle:
 *   1. visual-style.ts calls ensureWebGLOverlay() the first time any
 *      category is set to 'mesh'. The dynamic-import resolves, three.js
 *      downloads, the renderer/scene/camera are constructed.
 *   2. After init, `getReadyOverlay()` returns the singleton handle
 *      synchronously and render.ts can populate it each frame.
 *   3. Each render() call clears the scene's transient entity meshes,
 *      repopulates from the frame's entity list, and renders one frame.
 *      Mesh caching is per-Asteroid-id so we don't rebuild geometry
 *      each frame.
 *
 * Coordinate system:
 *   The world is 960×720 with Y down (screen convention). Our
 *   OrthographicCamera frustum maps (left=0, right=960, top=0,
 *   bottom=720) so mesh positions can be passed in raw world pixels.
 *   Mesh rotation in three.js follows right-hand: rotating +Z therefore
 *   rotates counter-clockwise as drawn, matching how the 2D context
 *   reads `a.rot` when y is down.
 */

import * as THREE from 'three';
import type { Asteroid, Ship } from '../types.js';

interface OverlayHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  canvas: HTMLCanvasElement;
  /** Per-asteroid mesh cache. Keyed by asteroid id; entries hold the
   *  Mesh + the procedural BufferGeometry, both shared across frames so
   *  long as the asteroid lives. Disposed when the asteroid is gone. */
  asteroidMeshes: Map<number, AsteroidMeshEntry>;
  /** Diffuse textures per asteroid type, kept alive across the renderer's
   *  lifetime — 4 textures total, each ~265-360KB raw. */
  diffuseCache: Map<string, THREE.Texture>;
  /** Singleton ship mesh — built lazily on first ship frame. The same
   *  geometry/material is reused across the lifetime of the overlay;
   *  only position/rotation/visibility change per frame. */
  shipMesh: THREE.Object3D | null;
  shipThrust: THREE.Mesh | null;
}

interface AsteroidMeshEntry {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  lastSeenFrame: number;
}

let handle: OverlayHandle | null = null;
let loading: Promise<OverlayHandle> | null = null;
let frameCounter = 0;

/** Build (or fetch from cache) a diffuse texture for an asteroid type.
 *  The webp files already exist at /backgrounds/asteroid-{type}.webp from
 *  the SHADED tier work — we just bind them to a three.js Texture. */
function getDiffuseTexture(h: OverlayHandle, type: string): THREE.Texture {
  const cached = h.diffuseCache.get(type);
  if (cached) return cached;
  const loader = new THREE.TextureLoader();
  const tex = loader.load(`/backgrounds/asteroid-${type}.webp`);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  h.diffuseCache.set(type, tex);
  return tex;
}

/** Build a displaced-icosphere geometry for the given asteroid identity.
 *  `shape[]` (the 2D polygon's per-vertex radial scale) is sampled along
 *  the longitudinal angle to drive the displacement, so the 3D rock
 *  visually echoes the 2D silhouette the player has been seeing. A small
 *  3D simplex-style noise on top adds craters/bumps that the flat shape
 *  array can't express. Result: identity is preserved across the
 *  vector→shaded→mesh tier hop. */
function buildAsteroidGeometry(a: Asteroid): THREE.BufferGeometry {
  const detail = a.size === 'large' ? 3 : a.size === 'medium' ? 2 : 2;
  const geo = new THREE.IcosahedronGeometry(a.radius, detail);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const shape = a.shape;
  const shapeN = shape.length;
  // Cheap deterministic noise — seeded by the asteroid id so the same
  // rock always shapes the same way. Asteroid ids are always set by
  // spawnAsteroid (nextStreamEntityId), so we can rely on a.id here;
  // fall back to a position hash for the rare case it's absent (e.g.
  // wire snapshot replay).
  const seedBase = a.id != null
    ? ((a.id * 2654435761) >>> 0)
    : hashStr(`${a.pos.x | 0},${a.pos.y | 0}`);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y, z);
    // Angle around the camera axis (z), 0..2π — used to index shape[].
    const ang = Math.atan2(y, x);
    const t = (ang / (Math.PI * 2) + 1) % 1;
    // Smooth-step blend between adjacent shape samples.
    const f = t * shapeN;
    const i0 = Math.floor(f) % shapeN;
    const i1 = (i0 + 1) % shapeN;
    const blend = f - Math.floor(f);
    const shapeR = shape[i0] * (1 - blend) + shape[i1] * blend;
    // 3D bumps — three sin frequencies xor'd with the seed for surface
    // detail. Strength scales with radius so larger rocks get bigger
    // craters in absolute terms, similar amplitude in relative terms.
    const seedOff = (seedBase ^ (i * 2654435761)) >>> 0;
    const sx = Math.sin(x * 0.18 + (seedOff & 0x3ff) * 0.01);
    const sy = Math.sin(y * 0.22 + ((seedOff >> 10) & 0x3ff) * 0.013);
    const sz = Math.sin(z * 0.16 + ((seedOff >> 20) & 0x3ff) * 0.017);
    const bumps = (sx + sy + sz) / 3;
    const displacement = shapeR + bumps * 0.08;
    const norm = r > 0 ? displacement * a.radius / r : 1;
    pos.setXYZ(i, x * norm / a.radius, y * norm / a.radius, z * norm / a.radius);
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

/** Trigger async load of three.js + scene construction. Idempotent —
 *  subsequent calls return the same promise so it's safe to call from
 *  every relevant settings click. */
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
      premultipliedAlpha: false,
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    // OrthographicCamera frustum maps (0,0)→(960,720) so mesh positions
    // are raw world pixels. Y-down convention preserved by passing
    // top=0, bottom=720 (flipped from three.js default).
    const camera = new THREE.OrthographicCamera(0, 960, 0, 720, 0.1, 1000);
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);
    // Lights — directional from upper-left, soft ambient fill.
    const sun = new THREE.DirectionalLight(0xfff2da, 1.4);
    sun.position.set(-200, -200, 300);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0x6080a0, 0.55);
    scene.add(ambient);
    handle = {
      renderer,
      scene,
      camera,
      canvas,
      asteroidMeshes: new Map(),
      diffuseCache: new Map(),
      shipMesh: null,
      shipThrust: null,
    };
    canvas.classList.add('is-active');
    return handle;
  })();
  return loading;
}

/** Synchronous accessor for the loaded handle. Returns null until the
 *  dynamic import + scene construction has resolved. */
export function getReadyOverlay(): OverlayHandle | null {
  return handle;
}

/** Render one frame. Caller passes the asteroids currently in mesh tier
 *  and any other entity lists (TODO ship/bullet/particle). Meshes are
 *  cached per-asteroid id; missing meshes get built on first sight,
 *  stale ones (asteroid disappeared) are disposed.
 *
 *  The viewport is set up to mirror the 2D canvas's setTransform(): the
 *  world (0..960, 0..720) is mapped to the same pixel rect on the
 *  WebGL canvas as the 2D context maps it on its canvas, so meshes
 *  line up pixel-perfect with HUD / coins / ship rendered in 2D.
 */
export function renderOverlay(opts: {
  asteroids: ReadonlyArray<Asteroid>;
  /** Ship to render in 3D, or null if the player has ship tier set to
   *  vector/shaded (in which case the 2D path handles it). */
  ship: Ship | null;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
}): void {
  if (!handle) return;
  const { renderer, scene, camera, canvas } = handle;
  // Match renderer drawing-buffer size to the canvas backing store. We
  // set canvas.width/height in main.ts's fit(), so just read those.
  if (renderer.domElement.width !== canvas.width || renderer.domElement.height !== canvas.height) {
    renderer.setSize(canvas.width, canvas.height, false);
  }
  // Mirror the 2D setTransform. Canvas pixel rect for the 960×720
  // world = (tx*dpr, ty*dpr, 960*scale*dpr, 720*scale*dpr). WebGL
  // viewport is y-bottom-up, so we flip the y origin.
  const vpW = 960 * opts.scale * opts.dpr;
  const vpH = 720 * opts.scale * opts.dpr;
  const vpX = opts.tx * opts.dpr;
  const vpYTopDown = opts.ty * opts.dpr;
  const vpY = canvas.height - vpYTopDown - vpH;
  renderer.setViewport(vpX, vpY, vpW, vpH);
  renderer.setScissor(vpX, vpY, vpW, vpH);
  renderer.setScissorTest(true);
  frameCounter += 1;
  // Materialise / refresh each asteroid's mesh. Asteroids without an
  // id (very rare — only wire-bound replay frames omit it) are skipped
  // here and will fall through to the 2D shaded fallback path.
  for (const a of opts.asteroids) {
    if (!a.alive || a.id == null) continue;
    let entry = handle.asteroidMeshes.get(a.id);
    if (!entry) {
      const geometry = buildAsteroidGeometry(a);
      const material = new THREE.MeshStandardMaterial({
        map: getDiffuseTexture(handle, a.type),
        roughness: 0.95,
        metalness: a.type === 'iron' ? 0.35 : 0.05,
      });
      const mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
      entry = { mesh, geometry, material, lastSeenFrame: frameCounter };
      handle.asteroidMeshes.set(a.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    entry.mesh.position.set(a.pos.x, a.pos.y, 0);
    // Rotation: a.rot rotates the 2D silhouette around its centre. In
    // mesh space we rotate around +Z. We also drift around X+Y so the
    // 3D body reads as actually tumbling, not just spinning in plane.
    entry.mesh.rotation.z = a.rot;
    entry.mesh.rotation.x = a.rot * 0.55;
    entry.mesh.rotation.y = a.rot * 0.37;
    entry.mesh.visible = true;
  }
  // Sweep stale entries (asteroid gone for ≥30 frames → dispose).
  for (const [id, entry] of handle.asteroidMeshes) {
    if (frameCounter - entry.lastSeenFrame > 30) {
      scene.remove(entry.mesh);
      entry.geometry.dispose();
      entry.material.dispose();
      handle.asteroidMeshes.delete(id);
    } else {
      // Visible only if seen this frame — keeps the cache warm but
      // hides last-frame ghosts during gaps (entity briefly off-list).
      entry.mesh.visible = entry.lastSeenFrame === frameCounter;
    }
  }
  // ── Ship ──────────────────────────────────────────────────────────
  // Build on first sighting; otherwise just hide/show + position.
  if (opts.ship && opts.ship.alive) {
    if (!handle.shipMesh) {
      const group = new THREE.Group();
      // Hull — flat triangular wedge in the XY plane. World coords:
      // ship points along +X by convention so a rot of 0 = facing
      // right, matching the 2D drawShip orientation. Vertices are
      // the same as the 2D path scaled up to read at world distance:
      // tip (14,0), back-left (-10,8), notch (-6,0), back-right (-10,-8).
      // Extruded slightly along Z so the lighting catches the body.
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
      const hullMat = new THREE.MeshStandardMaterial({
        color: 0x9be7ff,
        metalness: 0.4,
        roughness: 0.45,
        emissive: 0x4080a0,
        emissiveIntensity: 0.35,
      });
      const hullMesh = new THREE.Mesh(hullGeo, hullMat);
      group.add(hullMesh);
      // Thrust plume — separate mesh, toggled per frame, additive
      // material so it reads as fire rather than plastic.
      const thrustGeo = new THREE.ConeGeometry(5, 14, 12);
      thrustGeo.rotateZ(Math.PI / 2);        // point along -X (rear of ship)
      thrustGeo.translate(-14, 0, 0);
      const thrustMat = new THREE.MeshBasicMaterial({
        color: 0xffb84a,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
      });
      const thrustMesh = new THREE.Mesh(thrustGeo, thrustMat);
      thrustMesh.visible = false;
      group.add(thrustMesh);
      scene.add(group);
      handle.shipMesh = group;
      handle.shipThrust = thrustMesh;
    }
    const group = handle.shipMesh;
    group.visible = true;
    group.position.set(opts.ship.pos.x, opts.ship.pos.y, 0);
    group.rotation.set(0, 0, opts.ship.rot);
    if (handle.shipThrust) {
      handle.shipThrust.visible = !!opts.ship.thrusting;
      // Flame breathes — scale jitter to read as a flickering plume.
      const s = 0.85 + Math.random() * 0.3;
      handle.shipThrust.scale.set(s, s, s);
    }
  } else if (handle.shipMesh) {
    handle.shipMesh.visible = false;
    if (handle.shipThrust) handle.shipThrust.visible = false;
  }

  renderer.render(scene, camera);
}

/** Hide the overlay canvas when no mesh-tier entities are active. The
 *  WebGL context stays alive so the next frame's first mesh entity gets
 *  an instant render rather than a context-creation hitch. */
export function hideOverlay(): void {
  handle?.canvas.classList.remove('is-active');
}

export function showOverlay(): void {
  handle?.canvas.classList.add('is-active');
}
