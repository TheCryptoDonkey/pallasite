# Wave-25 Forge Boss — Build Spec

**Status:** Slices 1–2 + finale polish **BUILT + verified**. S1 = the Forge is the real wave-25 boss (UFO boss retired). S2 = the meltdown gravity-ring squeeze, escalating into **the chase** (below 20% HP the core breaks free and flees like a UFO — you run it down) and an **end-of-game detonation** (screen flash + screen-filling shockwaves, held 5s before completion). S3 = the forge places recognisable earlier-wave foes (elites / iron / chondrite) instead of generic rocks. Difficulty-scaled throughout (eased hard on easy). Slices 4–6 pending.
**Purpose:** replace the weak wave-25 finale (a bouncing gun-UFO) with **THE FORGE** — a multi-layer structural boss that pays off the arc's "you meet the maker" promise. This doc is the buildable spec for **Slice 1**, plus the roadmap for Slices 2–6.
**Provenance:** every number below was tuned in a live, in-engine spike (behind `?forge=1`, on wave 2) and playtested on desktop + a 390 px portrait phone, across difficulties. See the spike in `src/game.ts` (search `FORGE SPIKE`).

---

## 1. Why

Today's W25 (`makeBossUfo`) is mechanically a souped-up UFO: one bouncing entity that sprays bullets and drops mines. It is the **weakest** of the campaign's signature beats — EAGLE STATION (W17) out-engineers it — and it under-delivers on the arc (`docs/pallasite-arc.md` §3.4: *Event Horizon — you meet the maker… the forge… a gatekeeper*).

THE FORGE escalates EAGLE STATION's own structural DNA into the climax: where the station was *the placer's rig* (an outrider), the Forge is **the source** — the machine that has been placing the stones all game.

**Tier chosen: A (full capstone).** This doc specs **Slice 1** (the fight); Slices 2–6 are the additive layers (§5).

## 2. The validated loop

The spike proved this loop is fun and fair, solo, on a phone, on easy:

> **Peel the rotating shell → the core wakes on first hit → ride its 360° pulse + dodge the forged rocks while threading shots through the sweeping gap → kill the core → the rig detonates.**

Three concurrent threat axes, each de-risked: **shell homing missiles** (sealed phase), the core's **360° pulse** (exposed phase), and **forged lethal rocks** (throughout).

Reuses EAGLE STATION tech wholesale — `stationPart` `core`/`arm`/`emitter` render on **both** the 2D (`drawStationPart`) and mesh (`buildStationPart`, overlay.ts) tiers, keyed off `stationPart` not the wave — so **zero new render code** for the rig itself.

## 3. Mechanics & tuned numbers

### 3.1 Geometry (rig at `scale` 0.6 — sized for the portrait strip)

| Part | Value | Notes |
|---|---|---|
| Core | vein, radius **22.8**, `stationPart:'core'` | the weak point; silent until first hit |
| Shell | **12** destructible pods (`stationPart:'emitter'`), radius **15.6**, on a ring radius **67** | peel them to open a firing line on the core |
| Spin | `STATION_ROT_SPEED × 1.6` (~12 s/rev) | the gap sweeps; randomised-rotation pulse stops camping a fixed gap |
| Centre | `(640, 300)` | fits full world height (portrait shows full height) |
| Breach beat | at ≤ half the shell down | `SHELL BREACHED · CORE EXPOSED` + shockwave/trauma |
| Clear | core death → `stationCoreFinale` | blows the rig, scatters loot |

The whole rig spans ~166 px — comfortably inside the ~324 px portrait strip with room for the ship to move (§4).

### 3.2 Difficulty scaling

| Lever | Easy | Normal | Hard |
|---|---|---|---|
| Core HP | 90 | 140 | 200 |
| Vent HP | 4 | 5 | 5 |
| Missile cap (concurrent) | 1 | 2 | 3 |
| Missile cadence (ms) | 3400 | 2500 | 1800 |
| Missile speed × | 0.78 | 1 | 1 |
| Missile TTL × | 0.6 | 1 | 1 |
| Missile **turn** × | **0.45** | 1 | 1 |
| Pulse density × | 0.6 | 1 | 1 |
| Pulse cadence × | 1.3 (slower) | 1 | 1 |
| Forged-rock cap | 2 | 3 | 3 |

The missile **turn** scale is the big easy lever (1.8 → 0.81 rad/s) — they become out-jukeable instead of inescapable. It lives in the **shared** homing loop, so EAGLE STATION's easy missiles ease too (consistent).

### 3.3 The core pulse (`forgeCorePulse`)

- A dense **360° ring**, rotation **randomised each beat** (anti-camp).
- **Telegraphed**: the core glows + sheds sparks for ~440 ms before release, so it reads as a wind-up.
- **Ramps as HP drops** — density `{fresh 10, mid 13, low 18}`, cadence `{fresh 3800, mid 3200, low 2600} ms` (× difficulty above).
- Bullet speed `UFO_BULLET_SPEED × MUL.boss × 0.75`.
- Gated on `core.hp < core.hpMax` — **wakes on first hit only** (confirmed as the wanted behaviour, not pulse-from-start).

### 3.4 Forged rocks

- One **lethal depth-3** rock every 4500 ms, capped at 2–3 live.
- Spawns from the **top band** (x ∈ centre ± 150) drifting down — visible/threatening on a narrow phone, not creeping in from a cropped side edge. Forged-flash at spawn = "placed".
- Campaign rule (`parallax.ts:26`): every visible asteroid must be shootable + lethal — forge rocks are **never** decorative parallax bands.

### 3.5 Spawn + camera

- Player spawns at a **bottom corner** `(510, 640)` — diagonal to the central Forge, not dead-below.
- **Camera** (`render.ts`, `CAM_BOSS_BIAS` = **0.3**): the portrait follow-cam is biased gently toward a `stationPart:'core'` so the corner ship + the boss frame together. **Must stay gentle** — 0.7 locked the camera to the boss and the ship flew off-screen. Render-only → co-op-safe.

## 4. Portrait — the load-bearing constraint

The campaign sim is a fixed **1280×720**, aspect-agnostic; portrait uses a render-only **follow-camera centred on the ship**, showing a ~324 px-wide world slice (narrowest phones). Consequences, all handled above:

1. The rig must be **small** (≤ ~170 px) and **central** — hence `scale` 0.6.
2. A big boss + an off-centre ship can't both frame under a pure follow-cam → the gentle **core bias** (0.3).
3. The spawn is a **fixed world coord** (the sim can't read the local viewport, or co-op desyncs) → "corner" = a corner of the safe band, not a landscape corner.
4. Threats must originate **on-screen** → forged rocks from the top band.

## 5. Slice plan

**Slice 1 — The Forge fortress (this spec).** Productionise the spike as the real W25. Checklist in §6.
**Slice 2 — Meltdown / Event Horizon. ✅ BUILT.** Below `FORGE_MELTDOWN_FRAC` (0.34) the containment fails: a ring of 5 indestructible gravity wells (`makeMine`, hp 99999) spawns and tightens `FORGE_MELTDOWN_R_START`→`R_MIN` (180→110) as the core is pushed to death, slowly counter-rotating — squeezing the fight into the pulse zone. Driven from the Forge tick; `forgeMeltdown` flag on GameState + rollback (4 sites). Wells kept **escapable** — peak strength (`FORGE_MELTDOWN_WELL_STRENGTH` 190) MUST stay < `SHIP_THRUST` (240) or you can't thrust out; the *wide range* (240) is the anti-camp, not raw strength. Wave-25's black-hole background reinforces it.

**Finale: the chase + the detonation. ✅ BUILT.** Below `FORGE_ESCAPE_FRAC` (0.2) the core **breaks containment**: the rig + wells tear apart and the bare core flees like a UFO — flies straight, bounces off the walls, zig-zags to a new heading every `FORGE_ESCAPE_ZIG_MS`, leans away only when you're right on it (else roams, crossing your aim), and fires aimed shots (the 360° pulse stops). Pinned to a hittable size (the vein would otherwise shrink to a dot); speed + fire-rate difficulty-scaled (`forgeEscaped` flag). On core death (`stationCoreFinale`, gated to W25): a full-screen **white flash** (`s.flash` — a new screen-flash field rendered in `drawScreenFlash`, decayed in updateGame, rollback-serialised), screen-filling shockwaves + a ~390-particle storm + a SHORT punch (140ms, not a long freeze that would stall the burst), held by `bossHold` for the 5s grace so it plays out before the completion card. **Difficulty rebalance** baked in: easy pulse density/cadence + homing-missile turn/speed/ttl much gentler.
**Slice 3 — Forge callbacks. ✅ BUILT.** The forge's "places stones" now births recognisable earlier-run foes instead of generic rocks — W4 **elite UFOs**, W7/W12 **iron** (tanky), and **chondrite** (splits into a swarm) — the "I placed all of these" payoff + sustaining targets. Difficulty-weighted (easy = fewer elites, gentler rocks), capped across all placed foes (rocks + ufos), stops once the core breaks free, and the detonation clears lingering elites. NB: the EAGLE-STATION-pod callback (W17) was tried and **dropped** — a free `stationPart` emitter careens off the pinned shell ring (asteroid bounce) and reads as a glitch. Right way (future): a *deployed turret* that parks away from the ring and holds position firing.
**Slice 4 — The Song.** The forge is *a singer forced to forge* — a signature attack tied to the soundtrack. NOTE: gameplay can't be driven by the audio clock (wall-clock, device-dependent → co-op desync); it must be a deterministic timer with audio *dressing*.
**Slice 5 — Return / Step-Through ending.** The completion choice screen. Build with a **local** Mark first (no Nostr).
**Slice 6 — Pallasite Mark (Nostr).** Self-published NIP-85 kind 30382. **Blocked** on input-log replay (`docs/b3-verifiable-replay.md`) for a zero-trust Mark — keep off the critical path.

## 6. Slice 1 — productionisation checklist

The spike is solo-correct but throwaway. To become the real W25:

- [ ] **Wave wiring.** Register the Forge as `WAVE_SET_PIECES[25]` (replacing the `wave === FINAL_WAVE` → `makeBossUfo` branch in `beginWave`). The wave-25 clear gate is `wave25Clear = s.bossDefeated && asteroidsClear && ufosClear` — so the **core's death must set `s.bossDefeated`** (hook into `stationCoreFinale`, or the set-piece `isCleared`). Verify the victory → halo-skin → drift transition still fires.
- [ ] **Co-op determinism.** Move the spike's module-level `forgeBreached` onto `GameState` (lockstep + rollback replay state). All spawn RNG already routes through `gameRng` — keep it that way; the only `Math.random` is cosmetic (rot/hue/shape).
- [ ] **Mobile perf budget.** The finale is now the heaviest scene in the game (mesh rig + up to 3 missiles + a pulse curtain + forged rocks). Gate behind `reducedFxActive()` per [[mobile-perf-model]]: cap pulse density, drop `shadowBlur` on the curtain, trim particle counts. Hold the target frame-rate on an iPhone — measure, don't assume.
- [ ] **Bake the numbers.** Fold §3 values into named constants (`FORGE_*` in types.ts); delete the `?forge=1` gate, the wave-2 registration, and the URL tunables (`seg/scale/cap/pulsen/…`). Keep difficulty scaling.
- [ ] **Keep (already real).** `CAM_BOSS_BIAS` (render.ts) and the easy homing-turn scale — both general, both also fix EAGLE STATION on portrait/easy.
- [ ] **Lore + presentation.** W25 already has the `THE GATE` intertitle + "the forge sang on" game-over line. Add the FORGE naming/banner and make the core-death detonation hold its beat (cf. the W17 `bossHold` grace beat).
- [ ] **Difficulty pass.** Re-verify on easy *and* hard end-to-end (cheat-jump to 25), not just the spike on wave 2.

## 7. Open design questions (for Slice 1 review / Slice 2)

1. **Meltdown shape** — when the core is near death, what changes? Arena clamp (W9 closing cage / W20 well pentagon), shell behaviour, a timed "kill it before it completes a final forge"? (Slice 2, but decide the hook now.)
2. **One-way peel, or re-arm?** Does the shell stay open once peeled, or partially re-arm to keep pressure? (Spike = one-way; felt fine.)
3. **Combined low-HP load** — pulse + missiles + rocks all at once at low HP: re-check it's fair on the smallest phone on normal/hard (perf *and* difficulty).
4. **Music** — does the finale get its own track, and is the Song (Slice 4) part of it or separate?
5. **Ending scope** — ship Slice 1 clearing into drift as today (with a proper "THE FORGE FALLS" beat), and treat the Return/Step-Through screen (Slice 5) as a distinct follow-up.

## 8. References

- Arc / narrative: `docs/pallasite-arc.md` §3.4 (Event Horizon), §6–7 (Mark).
- Mark dependency: `docs/b3-verifiable-replay.md` (input-log replay).
- Spike code: `src/game.ts` (`FORGE SPIKE` block, `forgeCorePulse`), `src/render.ts` (`CAM_BOSS_BIAS`).
- Precedent: EAGLE STATION = `WAVE_SET_PIECES[17]`; rig render `drawStationPart` (render.ts) + `buildStationPart` (overlay.ts).
- Perf: `docs/dev-mobile-testing.md`; the reducedFxActive governor.
