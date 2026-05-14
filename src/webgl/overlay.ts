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
 *   The world is 960×720 with Y down (screen convention). The
 *   OrthographicCamera uses three.js's standard Y-up frustum
 *   (top > bottom) — flipping the frustum the other way looked
 *   correct mathematically but tripped three.js's per-mesh frustum
 *   culling, which silently skipped every draw. Instead we flip the
 *   Y axis at the mesh layer: mesh.position.y = WORLD_H - a.pos.y.
 *   Rotation is negated so the apparent spin direction matches the
 *   2D path (which reads a.rot in Y-down space).
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
  /** Cached `canvas.width * 1e5 + canvas.height` so setSize is only
   *  called when the backing store actually changes (otherwise three.js
   *  re-clears the canvas every frame). */
  lastSizeKey: number;
  /** TEMPORARY: spinning magenta debug cube at world center. Renders
   *  whenever the overlay is alive, regardless of game state. Lets
   *  the user verify "is the WebGL canvas actually visible?" without
   *  needing to inspect anything. Remove after the asteroid path is
   *  proven working. */
  debugCube: THREE.Mesh | null;
}

interface AsteroidMeshEntry {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshPhongMaterial;
  lastSeenFrame: number;
}

/** Per-type fallback base colour used while the diffuse texture is
 *  still loading (and as a tint multiplier once it has). Values picked
 *  to read bright against the dark space background so the player
 *  never sees the asteroids vanish at toggle time. */
const ASTEROID_TYPE_COLOR: Record<string, number> = {
  stony:     0xb0a090,
  iron:      0xc8a878,
  chondrite: 0xb8c8d8,
  pallasite: 0xe8c060,
};

let handle: OverlayHandle | null = null;
let loading: Promise<OverlayHandle> | null = null;
let frameCounter = 0;

/** Build (or fetch from cache) a diffuse texture for an asteroid type.
 *  The webp files already exist at /backgrounds/asteroid-{type}.webp
 *  from the SHADED tier work. We start without binding the texture to
 *  any material (which would render dark / unlit until the image
 *  decodes); the load callback below attaches it to every material in
 *  this type's cache, so newly-built meshes also inherit it via the
 *  cache hit. */
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
    // Icosahedron vertices sit on a sphere of radius a.radius, so
    // `displacement` (≈0.8–1.3 from shape[] + noise) is already the
    // correct multiplicative factor. The old code divided by a.radius
    // a second time, collapsing every rock to ~1 unit — rendered
    // sub-pixel and looked like "nothing on screen".
    const scale = shapeR + bumps * 0.08;
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
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    // Standard three.js Y-up frustum (top=720, bottom=0). World pixel
    // (0, 0) is top-left in screen space; mesh positions flip Y so a
    // world (x, y) lands at mesh (x, WORLD_H - y).
    const camera = new THREE.OrthographicCamera(0, 960, 720, 0, 0.1, 1000);
    camera.position.set(0, 0, 500);
    camera.lookAt(0, 0, 0);
    console.info('[webgl-overlay] init', {
      canvasW: canvas.width,
      canvasH: canvas.height,
      cssW: canvas.style.width,
      cssH: canvas.style.height,
      pixelRatio: renderer.getPixelRatio(),
      isContextLost: renderer.getContext().isContextLost?.(),
    });
    // Lights — directional key from upper-left, neutral ambient fill,
    // soft rim from below-right so the silhouette doesn't read flat.
    // Brighter than the first pass — Phong materials want enough fill
    // to push unlit faces above the dark space backdrop.
    const sun = new THREE.DirectionalLight(0xfff2da, 1.6);
    sun.position.set(-200, -200, 300);
    scene.add(sun);
    const ambient = new THREE.AmbientLight(0xa0a8b0, 0.8);
    scene.add(ambient);
    const rim = new THREE.DirectionalLight(0x80a0ff, 0.45);
    rim.position.set(250, 250, 200);
    scene.add(rim);
    handle = {
      renderer,
      scene,
      camera,
      canvas,
      asteroidMeshes: new Map(),
      diffuseCache: new Map(),
      shipMesh: null,
      shipThrust: null,
      lastSizeKey: 0,
      debugCube: null,
    };
    // Debug cube — always-visible magenta box at world center, so the
    // user can confirm the canvas/viewport pipeline is working without
    // any per-entity logic involvement.
    const debugGeo = new THREE.BoxGeometry(120, 120, 120);
    const debugMat = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const debugCube = new THREE.Mesh(debugGeo, debugMat);
    debugCube.frustumCulled = false;
    debugCube.position.set(480, 360, 0);
    scene.add(debugCube);
    handle.debugCube = debugCube;
    // Expose handle on window so the user can introspect it via
    // devtools without needing source-map access.
    (window as unknown as { __pallasiteWebGL?: unknown }).__pallasiteWebGL = handle;
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
  // Match renderer drawing-buffer size to the canvas backing store.
  // fit() in main.ts sets canvas.width/height directly when the
  // viewport resizes; three.js doesn't observe that change, so we
  // cache the last-known size and call setSize only when it actually
  // moves. (Always-on setSize would re-clear the canvas every frame
  // — visible flicker on some browsers.)
  const sizeKey = canvas.width * 100000 + canvas.height;
  if (sizeKey !== handle.lastSizeKey) {
    handle.lastSizeKey = sizeKey;
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
  // Spin the debug cube so it's obviously alive (not a static image
  // someone slipped in via CSS). Roughly 1 rotation/sec at 60fps.
  if (handle.debugCube) {
    handle.debugCube.rotation.y += 0.1;
    handle.debugCube.rotation.x += 0.05;
  }
  // Diagnostic log every 60 frames so it's visible whenever devtools
  // is opened, not just on the first frame.
  if (frameCounter % 60 === 1) {
    console.info('[webgl-overlay] render', {
      frame: frameCounter,
      viewport: { x: vpX, y: vpY, w: vpW, h: vpH },
      canvas: { w: canvas.width, h: canvas.height, classes: canvas.className, display: getComputedStyle(canvas).display },
      asteroids: opts.asteroids.length,
      asteroidMeshes: handle.asteroidMeshes.size,
      ship: opts.ship ? 'yes' : 'no',
      dpr: opts.dpr,
      scale: opts.scale,
    });
  }
  // Materialise / refresh each asteroid's mesh. Asteroids without an
  // id (very rare — only wire-bound replay frames omit it) are skipped
  // here and will fall through to the 2D shaded fallback path.
  for (const a of opts.asteroids) {
    if (!a.alive || a.id == null) continue;
    let entry = handle.asteroidMeshes.get(a.id);
    if (!entry) {
      const geometry = buildAsteroidGeometry(a);
      const baseColor = ASTEROID_TYPE_COLOR[a.type] ?? 0xb0a090;
      const cachedMap = getDiffuseTexture(handle, a.type);
      const material = new THREE.MeshPhongMaterial({
        color: baseColor,
        map: cachedMap,
        shininess: a.type === 'iron' ? 60 : 18,
        specular: a.type === 'iron' ? 0x806040 : 0x303030,
      });
      // Lazy-load the diffuse map if not in cache; until it lands the
      // material's `color` is what the player sees — readably bright
      // even against the dark space backdrop.
      if (!cachedMap) kickDiffuseLoad(handle, a.type, material);
      const mesh = new THREE.Mesh(geometry, material);
      // Frustum culling is broken with our Y-flipped projection
      // (top=0, bottom=720). The math renders correctly, but
      // three.js's Frustum.intersectsBox computes inverted plane
      // normals on the Y axis, so every mesh classifies as "outside"
      // and is silently skipped. Bypass per-mesh — the scene is
      // small enough that no-culling has zero perf cost.
      mesh.frustumCulled = false;
      scene.add(mesh);
      entry = { mesh, geometry, material, lastSeenFrame: frameCounter };
      handle.asteroidMeshes.set(a.id, entry);
    }
    entry.lastSeenFrame = frameCounter;
    // Y inverted so screen-Y-down world coords land correctly in the
    // Y-up frustum. Rotation negated for the same reason — keeps the
    // apparent spin direction matching the 2D path.
    entry.mesh.position.set(a.pos.x, 720 - a.pos.y, 0);
    entry.mesh.rotation.z = -a.rot;
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
      // Phong rather than Standard — no env map to reflect from, so
      // metallic PBR would render dark. Bright emissive keeps the
      // hull readable against any background.
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
      thrustMesh.frustumCulled = false;
      thrustMesh.visible = false;
      group.add(thrustMesh);
      scene.add(group);
      handle.shipMesh = group;
      handle.shipThrust = thrustMesh;
    }
    const group = handle.shipMesh;
    group.visible = true;
    // Y-inverted to match the Y-up frustum (see asteroid path).
    group.position.set(opts.ship.pos.x, 720 - opts.ship.pos.y, 0);
    group.rotation.set(0, 0, -opts.ship.rot);
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
