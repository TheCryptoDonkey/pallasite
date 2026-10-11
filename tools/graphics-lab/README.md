# Pallasite Ultra graphics

The approved first-level presentation now runs throughout the normal game.
The historical `level-one` module names and asset directory remain stable so
existing cached URLs and art tooling continue to work. The standalone
`/tools/graphics-lab/index.html` gallery remains an isolated before/after study.

## Playing and comparing

### Sanctum relics

The 600B name secret, `?flavour=600bn`, the 600b hostname and the SANCTUM
mode share the enhanced presentation. All eleven council portraits are inset
into beveled mineral-metal medallions with engraved names/roles, matching
reverse faces and restrained tilt that keeps members recognizable. Identity
labels and remaining-health arcs survive loading, Low, mobile and WebGL failure.
Portrait crops are square and cached at 256px; late images update already
visible mesh clones and plates. Missing images show member initials.

`src/sanctum-art.ts` is the editable procedural texture/plate master;
`src/webgl/sanctum-relic.ts` is its live geometry/material master. Canvas
masters are shared by the live renderer, fallback plates, entrance emblem
and end-of-run card. The signal UFO has a milled rim, warm drive light and
the canonical four-line number, with its 04:20 clock reverse. The shared
scene supplies lighting/shadows; there is no per-member renderer or light.
The sixteen 128px fallback poses are cached by roster identity, never body
ID or time (at most fourteen identities, including an unknown-member fallback).

The Sanctum's warm space background takes precedence over the campaign's
first-wave Ultra backdrop. Its dust and sat drops both keep the Bitcoin coin
art; their original score/collection rules are preserved. Live drops reuse
the existing instanced coin batches, with baked overflow after the 256-copy
budget. Saved Classic categories keep their prior art. Cosmetic clocks stop
on pause; reduced motion holds a readable face and retains health/hit cues.

Run `node tools/graphics-lab/check-sanctum.mjs` against the local Vite server
(default `http://127.0.0.1:5181`, override with `PALLASITE_REVIEW_URL`). It
enters the real game and checks movement/fire, all eleven members, the
signal UFO, Bitcoin drops, real shrink/destruction/collection, render state
and RNG invariance, bounded caches, pause and reduced motion. Desktop, Low,
phone, short landscape, WebGL failure, missing/late portraits and WebKit
captures/results go to the ignored `tools/record-out/graphics-refresh/`.
It also starts the stored SANCTUM mode on the main flavour and checks Classic
switching plus 72-member/300-drop overflow in a controlled unranked scene.
Viewport checks are not physical-device performance certification.

Use the normal game at `http://127.0.0.1:5180/?menu=1`, or open
`http://127.0.0.1:5180/?graphicsReview=1` for unranked fixed-seed practice.
The latter starts level 1, offers a selector for all 25 campaign levels and Drift waves 26–31,
current/refreshed comparison, a restart, real power-up/collectible drops,
real ship/final-death collision controls, quality and shadow controls.
Arrows/WASD move, Space fires, Down activates shields, Shift/H teleports,
and Escape pauses. Comparison switches leave bodies and gameplay RNG alone.
Practice forfeits sat credit under the existing cheat rule.

Ultra is the normal enhanced presentation, respecting saved Classic settings
and per-category art choices. Auto retains the frame-budget governor.
Desktop Ultra uses the approved live Blender ship, UFOs, power-up spheres,
collectible coins/crystals, thermal explosions and hull fragments, with PBR
lighting, banking, tumbling, rotor motion and received/cast shadows.
Phones, Balanced and Low retain the same art through baked Blender plates;
failed GLBs or a lost WebGL context also retain baked or existing shaded art.
No frame-rate promise is made for untested hardware.

## Whole-game coverage

- All twelve minerals use the approved fractured rock or pallasite geology,
  with distinct surface colour, roughness, metal content, light emission and
  proportions. Two shared live rock models/maps bound memory. Low uses
  64px, other baked tiers 128px sixteen-frame mineral turntables, loaded by
  encountered type. Veins retain the readable gold health arc; terrain cover
  uses the same geometry without changing its collision or invulnerability.
- Cruiser, Elite, Tank, Sniper and Boss retain distinct Blender silhouettes.
  New classes add armour, weapons or sensor hardware to the approved hull and
  independent rotor. Purple/blue glow stays below each banked hull. Boss
  phase escalation retains its existing attack timing and brighter reactors.
  All five classes now have larger authoritative radii (30/19/40/21/64px),
  so the enlarged bodies remain shootable in every graphics tier.
- Eagle Station and the Forge use beveled Blender containment hardware,
  exposed green energy crystals, conduits and hot emitter lenses. The Forge
  has its own layered armour and rectangular weapon pods. Gravity mines use
  a metal shell, spines, an accretion glow and a persistent true-range boundary.
  Alternate default wells from wave 14 have 18px cores, the Maelstrom has
  20px cores and the Forge meltdown has 22px cores, with matching collision
  radii. Pull ranges are unchanged. The Forge containment pull is 155px/s²
  after the boss balance pass; the other wells retain their existing strength. Boss warning rings, HUD, pulse deadlines and phase rules are retained.
- Ordinary bolts, shield, teleport, recoil, thrust, power-ups and collectibles
  carry the accepted treatment into every wave and mode. Homing missiles use
  a baked Blender metal seeker; hostile shards use the mineral turntable.
  Green collectible minerals have no DUST caption; gold retains N SAT.
- Normal crashes keep the classic four authoritative debris bodies and real
  particle paths, with orange/red/blue Blender thermal gas and 12 extra
  cosmetic fragments (24 on final death; reduced motion skips those shards).
  The last impact remains live for 650ms before rewind, with a three-second
  aftermath and repeatable replay explosion. Aliens, mines and station parts
  use bounded local thermal destruction bursts as well.
- Multiple pilots retain their HUD colours, individual shields and complete
  ship bodies. Large-world cameras move the shared shadow box with the view.
  Sanctum portraits, names and roles are retained on reflective rimmed
  medallions; its sacred-number UFO retains the branded silhouette.
- Each campaign level retains its existing location background. Level 1 uses
  the approved generated nebula. Beyond level 25, Drift cycles through three
  new generated panoramas every two waves: a turquoise lagoon, sapphire rings,
  and a rose-gold galaxy. These finite asset/cache keys replace missing
  `wave-26+.webp` requests and keep long runs from growing the image cache.
- Enhanced power-ups always use the spherical models/plates. All six use an
  explicit `rounded-2` URL revision; a shaded sphere is available immediately
  during loading or complete asset failure. How-to-play previews show the
  same plates. Classic remains the saved per-category choice.
- Enhanced inter-wave warps use a generated plasma tunnel, lit apertures, curled streaks and up
  to four textured mineral flybys. The aperture treatment also appears on
  actual ship departure/arrival. Reduced motion uses a destination fade with
  no moving tunnel or flybys; Low/Balanced use bounded cheaper paths.
  Arrival fades the complete tunnel layer over the next level's actual
  background, sharing its full-screen crop, breathing motion and exposure.
  A reusable 1280×720 surface keeps every effect under the same opacity;
  there is no expanding destination border or letterbox edge at the handoff.

## Runtime budgets

One Ultra scene/environment/shadow map is shared by the refreshed objects.
Live visible copies cap at 48 rocks, 16 aliens, 24 power-ups, eight pilots and
16 mines; overflow stays visible through baked art. Collectibles instance to
256 visible seam copies per kind, two material batches per kind, with baked
overflow. Ship armour batches to seven materials and pickup spheres to five.
The extra rendering surface caps at 2560x1440; shadow resolution is 2048.
Four shared local lights remain fixed regardless of pilot/pickup counts.
Mechanical explosions cap at four events and player bursts at three, with a
72-instance hull-shard pool. Cosmetic state stays outside snapshots and RNG.
Later-class/station models load only on first encounter. Missing additions
remain baked and do not retry every frame. There is no per-pickup light.

Campaign difficulty through wave 25 and other modes are retained. Drift
waves 26+ repeat a five-wave breathing cycle: 8/9/10/10/11 large rocks before
operator multipliers, speed bands equivalent to waves 12/14/16/17/18, and
bounded inherited fragment speeds. UFO arrivals have 18-second recovery /
14-second ordinary base gaps before the selected difficulty multiplier;
attack intervals lengthen by 30%. Shield/hyperspace cooldowns shorten by 25%. A fetchable
heart appears on each recovery wave when below the existing five-life cap.
Wave-intro holds shorten to 2.4 seconds. This permits extended runs without
unbounded speed escalation; survival still depends on play.

Normal collision preferences are retained. The review forces
contacts on at every level. Wrapped contacts and coincident-centre separation
now use the accepted collision correction throughout the normal wrapped
world; enclosed arenas and deathmatch do not use toroidal contact distances.
These are circular gameplay bodies with bounded cosmetic ejecta, not a mesh
fracture solver. Every graphics budget now uses the same crash-debris RNG path.

## Rebuilding and checking

Run Blender `--background --factory-startup --python` with
`tools/graphics-lab/build-campaign.py`, followed by
`tools/graphics-lab/build-bosses.py`, then
`node tools/graphics-lab/optimise-campaign.mjs`. The campaign authoring script
reads mineral profiles from `src/ultra-materials.ts`, preserves packed Blender
sources and uses CPU Cycles for fallback plates. It adds about 10MB compressed
art across the entire campaign, mostly lazy-loaded alien models, plus the
shared pallasite GLB. Assets are local; no new CDN dependency is added.
The original authors remain in `build-ufo.py`, `build-flight-assets.py`,
`build-pickups.py`, `build-death-burst.py`, `build-collectables.py`,
`optimise-flight-assets.mjs` and `optimise-collectables.mjs`.

Installed-Chrome checks against the local development server:

- `node tools/graphics-lab/check-campaign.mjs`: normal menu entry; all 25
  actual wave layouts; station/Forge models; all twelve minerals and five
  alien classes; before/after state/RNG stability; multiple pilot/shield
  rendering; 120-rock bounded overflow; budget switches, Classic selection,
  phone layout and failed-model/no-WebGL fallbacks.
- `check-playable.mjs`: real keyboard flight, fire, shield and teleport;
  actual contacts, seam/coincident/unequal-mass collision cases; UFO firing;
  pickups, crash and replay; context loss and phone layout.
- `check-refinements.mjs`: underside bank, rotor, under-hull glow, shadows,
  pause freeze, spherical pickups and Blender debris.
- `check-death.mjs`: actual normal/final crashes in Ultra, Low and reduced
  motion; visible live beat before replay, palette, cleanup and re-arming.
- `check-drift-warp.mjs`: all six revised pickup URLs and live models;
  all three actual Drift backgrounds; Easy/Normal/Hard wave construction
  through wave 1,000,000; actual heart collection and defensive cooldowns;
  repeated 30-second deterministic simulations; warp state/RNG invariance;
  reduced motion and total pickup-art failure on phone layout. Pass
  `--harnesses` to run the seven existing simulation harnesses in Chrome.
  Pass `--arrival` to compare late/final warp frames with actual next-wave
  rendering on desktop, wide, portrait, retro and reduced-motion layouts.
- `check-collectables.mjs`: real collection, credit forfeiture, mineral score,
  pause/compare stability, all twelve mineral sources in Ultra/Low/phone,
  distinct fallback plates, state/RNG invariance and 300-drop bounded
  instancing. Also available as `check-drift-warp.mjs --collectables`.
- `check-release.mjs <commit-sha>`: production version and entry-bundle identity,
  exact bytes for all shipped Ultra assets, Drift/warp backgrounds, Signet
  bundle and service worker; deployed Ultra pickup rendering, actual flight
  and firing, Drift wave construction/backgrounds and phone fallback. Set
  `TARGET` to use another deployment. Practice fixtures remain unranked.

Collectible mineral shards use the shared faceted geometry and material
profiles in `src/mineral-shards.ts`. Per-instance colour, metalness, roughness
and shape proportions keep the Ultra path at two shard material batches
across every source type. The canvas fallback shades the same vertices and
faces into at most twelve-by-sixteen cached 64 px plates. Source-less drops
retain the green mineral identity; gold SAT coins keep their existing art,
value labels and collection rules. This is a presentation change; it adds
no asteroid types or new pickup rewards.

Screenshots/results live in ignored `tools/record-out/graphics-refresh/`.
These checks exercise rendered fixtures and controlled gameplay, not a full
25-level completion or sustained physical-device/thermal certification.
The seven existing simulation harnesses are run in installed Chrome because
Playwright's bundled Chromium is absent on this machine.

## Art pipeline

`render-assets.py` authors the models and materials in Blender, saves packed
source `.blend` files, renders 1536 px Cycles plates and 32 turntable frames.
`export-cinematic.py` authors the Ultra-only fractured cores and partly buried
rubble, exporting one joined mesh per rock with efficiently packed 2048 px
albedo and tangent-space normal maps. The baked maps are compressed as WebP
in the GLBs; their full PNG/JPEG sources remain available. `optimise-assets.mjs` makes
the WebP gallery images, 128/256 px rotation atlases and background variants.

The level-one background was generated with the available image tool.
The new Drift panoramas use the built-in image generator; originals are in
`assets/drift/`, shipping WebP files in `public/backgrounds/`, and the exact
prompts are in `drift-art-prompts.json`. Its model was
not exposed; the native image is 1672 x 941, not 4K. The lab contains the
master image. Existing Pallasite asteroid textures supply the source mineral
and rock colours. Real rubble surfaces were referenced from NASA's Bennu
imagery: https://science.nasa.gov/solar-system/asteroids/101955-bennu/ . No NASA
model or texture is used at runtime. The palette and fill lighting are richer
than natural imagery to keep target materials readable during fast combat.
This remains an art iteration, not final cinematic art.

## Runtime budgets

| Tier | Rendering | Collision particles | Scene assets, belt |
| --- | --- | --- | --- |
| Low | 128 px baked atlas, DPR capped at 1 | 8 chips, 16 cached dust sprites | about 411 KiB |
| Balanced | 128 px baked atlas, DPR capped at 1.5 | 16 chips, 32 cached dust sprites | about 449 KiB |
| Ultra | live PBR GLBs, DPR capped at 2, optional 2048 shadow map and bloom | 24 instanced chips, 72 dust points | about 7179 KiB |

Close-up atlas frames are 256 px. Asset counts exclude JavaScript, gallery
images and the existing renderer. The preview starts Balanced below 600 px;
this is a conservative viewport default, not a hardware capability test.
Ultra falls back to Balanced if its renderer cannot initialize. Inspect stony
and Inspect pallasite enlarge each material for review; Compare with Previous
Ultra lets you directly compare the first live model pass with the latest.
Each new rock has an independent, steady spin axis, rather than synchronized
oscillation. The new meshes have about 12,760 and 9,820 triangles, versus 20,480
each in the previous pass. Loading a
new quality tier suspends After drawing until that tier's assets are ready.

Collision motion uses volume-based masses, conserved linear momentum and
restitution 0.72. Fragments inherit contact drift and disperse mainly along
the tangent, with no atmospheric drag or invented gravity. Dust fades as it
spreads. This is a scripted central contact fixture, not general rigid-body
collision or fracture simulation. Replay impact restarts just before contact.

## Acceptance so far

Chrome automation on this development machine passed scene switching, an
80-rock fixture, Low/Ultra switching, image loading and 390 px layout without
page errors. A deterministic effect-on/effect-off capture confirmed visible
collision particles. The headless preview recorded 60 fps median cadence
and approximately 17 ms p95 intervals with both panels running, including
the 80-rock fixture. These short measurements include the comparison page,
not sustained game simulation. JavaScript draw-submission timings exclude
asynchronous GPU time and must not be reported as a game speedup.

The integrated game now uses `src/rock-dust.ts` for material-specific hit,
collision and breakup ejecta across all twelve asteroid types. Powder, metal
chips, chondrule beads, carbon flakes and mineral/glass splinters differ in
colour, silhouette and spread. Mixed collisions retain both materials.
Cosmetic events and legacy-particle tags live outside simulation snapshots;
simulation particle creation and gameplay RNG calls are unchanged. The game
caps this layer at twelve live bursts, sixteen grains per burst (six on Low
or reduced motion), 1.8 seconds and twelve cached 64 px powder sprites.
Reduced motion removes spinning and glints and limits dispersal. Classic
asteroid rendering retains its existing effects.

Run `node tools/graphics-lab/check-drift-warp.mjs --dust` against Vite on port
5180 to exercise actual non-fatal shots, breakups and mixed collisions, state
and RNG invariance, lifetime cleanup and the reduced budget. It writes the
twelve-material contact sheet and JSON evidence under `tools/record-out/graphics-refresh/`.

Before integration, run sustained real gameplay on physical older phones,
integrated-GPU laptops and high-end desktops, including portrait controls,
thermal throttling, high pixel density, busy waves and context loss. Use
measured frame budgets to choose defaults, mesh LOD, resolution and effect
caps. Do not enable Ultra universally based on screen size or this fixture.

The final compressed Ultra scene is about 7179 KiB (down from roughly
17,561 KiB with PNG maps). WebP compression reduces download size, not GPU
texture memory. Balanced and Low still use the original lightweight atlases.
