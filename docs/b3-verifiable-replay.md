# Pallasite: B3 Verifiable Replay

**Status:** draft v0.1 (2026-05-15)
**Purpose:** scope the deterministic input-log replay and zero-trust verification layer. This is the §10 prerequisite named in `docs/pallasite-arc.md`: the keystone the Pallasite Mark, a future tournament, and skill-based clip awards all depend on. B3 in the Slice B decomposition (B1 completion screen, B2 Mark claim and read, B3 verification).

**One line:** make a Pallasite run reproducible from a recorded seed and input log, so anyone can re-simulate it and verify the outcome, with no server in the trust path.

---

## 1. The problem

The Pallasite Mark (`pallasite-arc.md` §6, §7) is designed zero-trust: a player self-publishes a claim, and consumers verify it independently. Today they cannot.

The only replay artefact is the kind 30764 stream: a `ReplayFrameRaw[]` sequence of full world-state snapshots, every asteroid, UFO and bullet position, frame by frame. It is a recording, not a run. Anyone can author a frame stream that ends at wave 25 with any score. It is trivially forgeable, so it cannot back a Mark, a leaderboard, or a tournament.

Zero-trust verification needs the run itself: the seed and the inputs, from which the outcome is recomputed rather than asserted. That is B3.

## 2. Current state (audit, 2026-05-15)

Seven findings from reading the loop, the RNG, the input path, and the replay format (the seventh added 2026-05-17).

1. **Variable timestep.** `src/main.ts` runs a requestAnimationFrame loop with `dt = Math.min(0.05, (now - lastFrame) / 1000)`. `updateGame(s, dt, now)` (`src/game.ts`) receives both the variable `dt` and wall-clock `now`. A run cannot be reproduced from inputs alone: the same inputs at different frame rates produce different runs.
2. **The campaign sim is nearly clean.** `game.ts` routes gameplay randomness through the seeded `gameRng()` in `src/seed.ts` (Mulberry32, fnv1a32-hashed seed). It reads `performance.now()` for deadlines (invulnerability, powerup expiry, phase timing), but it already maintains an internal clock, `s.elapsed`.
3. **The 600bn Sanctum is not clean.** `src/sanctum.ts` has 25-plus raw `Math.random()` calls feeding gameplay state (meteor spawns, fragment trajectories, bullbear charge lanes). Out of scope for v1 (see §6).
4. **Inputs are already one clean surface.** Keyboard, touch and the phone controller all converge into `s.keys` (a `Record<string, boolean>`) plus `s.targetHeading` and `s.thrustOverride` on `GameState`. There is no separate event queue to untangle.
5. **Audio is welded into the sim.** `updateGame` calls `audio.explosion()`, `audio.coinPickup()` and similar directly. The sim cannot run headless without a seam.
6. **The replay is a forgeable world-state stream.** `ReplayFrameRaw` (`src/stream-session.ts`) captured at 30Hz, 14k to 28k frames per run, gzipped to 300-600KB, uploaded as a blob with the kind 30764 event carrying only a pointer.
7. **Display mode leaked into the sim (found 2026-05-17, resolved).** `game.ts` imported `getCollisionWrap()` and `getVisibleBoundsW()` from `render.ts`, both of which returned viewport-dependent values. In modern portrait the collision wrap distance and the UFO spawn/despawn coordinates therefore depended on screen size and orientation, so a phone-recorded run would not re-simulate identically on a desktop. Finding 2 ("nearly clean") missed this. Resolved by decoupling the sim: it now wraps the fixed `WORLD_W` x `WORLD_H` world unconditionally, and a render-only follow camera adapts the view instead. The B3.0 harness now replays under both retro and modern-portrait render modes and asserts an identical hash sequence, so the coupling cannot return silently.

The headline: the campaign simulation is closer to deterministic than expected. The randomness is already seeded. Three gaps were found: variable time (finding 1), viewport coupling (finding 7), and the audio seam (finding 5). The first two are now closed; the audio coupling remains.

## 3. Design

B3 adds a verifiable recorded-replay track. It does not replace live streaming: the kind 30764 world-state stream stays for live spectators, who cannot re-simulate in real time and need the current truth. Live keeps frames; the canonical recorded run becomes the input log.

Six pieces, ordered by dependency, not by size.

### 3.1 Fixed timestep

The simulation must advance in fixed quanta, decoupled from the display refresh rate. Standard accumulator:

```
accumulator += min(CAP, wallDt)
while (accumulator >= STEP) {
  updateGame(s)        // exactly one fixed step
  accumulator -= STEP
}
render(interpolate(prev, s, accumulator / STEP))
```

`STEP` is the fixed sim period. Recommended 1/60s for v1: it matches the current implicit target, keeps sim cost flat, and the existing 50ms `dt` cap shows the game already tolerates a fixed floor. Render gains an interpolation pass so high-refresh displays stay smooth.

This is a behavioural change and a player-facing improvement: the game currently simulates faster on a 144Hz screen than a 60Hz one. A fixed step makes feel identical on every device. It needs playtesting; it is not a free swap.

### 3.2 One sim clock

`updateGame` stops taking `now`. All in-sim time derives from a frame counter (`s.frame`) or the existing `s.elapsed`, both advancing by exactly `STEP` each step. Every deadline currently stored as a wall-clock millisecond (`invulnerableUntil`, `hitStopUntil`, `veinSwarmDueAt`, phase timers) becomes an absolute frame number. Hit-stop becomes "skip N steps", which is cleaner deterministically than a millisecond compare.

### 3.3 Deterministic RNG

`gameRng()` already exists and is sound. Two changes: seed it for every run (a per-run 32-bit seed, generated at run start and recorded), not only in daily mode; and confirm no gameplay `Math.random()` leaks into `GameState`. The audit found `game.ts` clean and `sanctum.ts` not. The rule: any `Math.random()` whose result is stored in `GameState` must become `gameRng()`. Purely visual jitter (particle directions, blink phase) may stay on `Math.random()`, because the verifier never renders, as long as it never feeds back into state. A focused pass during B3.0 confirms this.

### 3.4 Input log

Each fixed step records the resolved input state, not raw key events. This collapses keyboard, touch and phone controller into one representation and makes the log input-source-agnostic:

- One bitfield byte: thrust, turn-left, turn-right, fire, hyperspace, shield.
- Joystick mode adds a quantised `targetHeading` (16-bit fixed angle) and the `thrustOverride` bit.

Inputs are held across many steps, so run-length encoding shrinks the log dramatically. Pause and menu inputs are excluded; they do not affect the sim outcome.

### 3.5 Replay container

A single self-contained object, gzipped to roughly 10-20KB, small enough to live in a Nostr event's `content` with no blob store and no pointer:

```
{
  v: 1,                          // container format version
  gameVersion: "<sim version>",  // verifier must run the matching sim
  flavour: "campaign",
  seed: <uint32>,
  simHz: 60,
  config: { <getGameConfig() snapshot> },  // faucet-tuned constants the sim reads
  inputLog: "<RLE bytes, base64>",
  claim: { wave, score, ending, durationFrames }  // display only; the verifier recomputes
}
```

`config` matters: the simulation reads server-tuned constants (`powerup_drop_chance` and so on) via `getGameConfig()`. The exact config used is a determinism input alongside the seed and must be snapshotted.

Event kind: a decision (see §10). Leaning towards a new regular (immutable) kind rather than overloading kind 30764, whose current semantics are a pointer to a world-state blob. The Mark (NIP-85 kind 30382) references this event's id as `run_id`.

### 3.6 Headless verifier

`verify(replay) -> { ok, computed, claim }`. It builds a fresh `GameState`, seeds the RNG, applies the config snapshot, then loops: set the input state from the log, call `updateGame(s)`, advance, for every recorded step. No render. Audio stubbed. At the end it reads `s.wave`, `s.score` and the ending and compares them to the claim.

Audio seam: v1 ships a headless audio sink (every audio call a no-op behind a flag), required because a Web Worker has no `AudioContext`. Cleaner future: the sim already emits structured events via `recordStreamEvent`; routing audio off that event stream would make the sim genuinely side-effect-free. Not required for v1.

Environment: v1 runs the verifier in a Web Worker on the watch page, so a Mark verifies in-browser. v2 ships a standalone CLI verifier as the public artefact anyone can audit with.

## 4. The hard part: floating-point divergence

In a conforming JS engine, `+`, `-`, `*`, `/` and `Math.sqrt` are correctly rounded and bit-identical. The transcendentals are not: `Math.sin`, `cos`, `tan`, `atan2`, `pow`, `hypot`, `exp`, `log` are left implementation-approximated by ECMAScript, so their low bits differ across engines and versions. The sim uses about 35 trig calls. An asteroid field is a chaotic system: a one-ULP difference compounds, frame over frame, into a divergent run.

So "re-simulate on any engine and match" is not free. The v1 answer is a **pinned reference verifier**: one open, reproducible verifier build (a fixed engine version, later compiled to WASM). Zero-trust does not require every engine to agree; it requires that anyone can run the open verifier and get the same verdict. This is the right v1 bar and it removes any need for a fixed-point maths rewrite.

Future hardening, if cross-engine verification is ever wanted, is narrower than it sounds: only the transcendentals need a deterministic implementation (a fixed polynomial or CORDIC `sin`/`cos`/`atan2`), not the whole arithmetic layer. Noted, not scoped here.

## 5. Trust model

Precise, so nobody over-claims.

- The faucet is **not** in the trust path. It may store and relay replay events; it signs nothing load-bearing.
- The replay event is signed by the **player**. That proves "this player claims this run". It does not, alone, prove the run is legitimate.
- The proof is **re-simulation**: anyone fetches the replay, runs the open verifier, and obtains a verdict. The verdict is reproducible by anyone, so no party is trusted.
- The Mark (NIP-85 kind 30382) is the claim and index layer. The replay event plus the verifier is the proof layer.

This is **deterministic recomputation**, not a zero-knowledge proof. The honest analogy is a Bitcoin full node: it does not trust miners, it revalidates every block itself. B3 is that for game runs. "Zero-trust" here means no party's say-so is required, because verification is a computation anyone can redo.

## 6. Effort and phasing

Roughly 4 to 6 weeks of focused solo work, deliberately front-loaded with the risk.

| Phase | Scope | Estimate |
|---|---|---|
| B3.0 | Determinism foundation: fixed timestep, sim clock, seed always on, plus a regression test that records a run and asserts the re-sim is bit-identical | 1 to 2 weeks |
| B3.1 | Input log capture and the replay container | a few days |
| B3.2 | Headless verifier, audio seam, Worker harness, Mark verification wired into the watch page | about a week |
| B3.3 | Standalone CLI verifier, format documented, the public proof artefact | about a week |

**B3.0 is a timeboxed spike.** It is the make-or-break: if the campaign sim will not go deterministic cleanly, that surfaces here, in two weeks, not after the container and verifier are built. The regression test (record, re-sim, assert identical) is both the deliverable and the proof.

v1 targets the **main campaign only**. The 600bn Sanctum's raw `Math.random()` calls are a separate later fix, and the Mark is a campaign wave-25 achievement regardless.

## 7. Value to Pallasite

- Cheat-resistant leaderboards: a forged result cannot survive re-simulation.
- The real Pallasite Mark, verified rather than merely claimed.
- A credible tournament later, almost for free, once the sim is deterministic and seedable.
- Recorded replays shrink 20 to 50x and drop the blob store: the run fits in the event.
- A "verified" badge on the watch page.
- A side effect of the fixed timestep: consistent game feel across devices.

## 8. Wider community

The reusable pattern: **tamper-evident, independently-verifiable game runs anchored to signed Nostr events.** Any result is auditable by anyone with an open verifier, with no server trusted.

Input-log determinism is thirty years proven: Doom and Quake demos, RTS replays, speedrun verification all work this way. The novelty here is the anchoring. The replay is a public, signed Nostr event; the achievement is a NIP-85 assertion that cites it; the reputation it grants (jury eligibility, per `pallasite-arc.md` §7) is itself on Nostr. The whole chain is open and portable.

Deliverables that outlast the game:

- A documented replay-container format, a natural NIP (a `nip-drafts` repo already exists to house it).
- An open standalone verifier anyone can run.
- A write-up: how to make a JavaScript game simulation deterministic (the fixed-timestep, seeded-RNG, pinned-verifier recipe, and the transcendental-divergence trap).

Pallasite is the prototype and the proof. Not a whitepaper: a real, shipping, fun game that demonstrates the entire chain end to end, deterministic sim to signed replay to verifiable assertion to on-Nostr reputation, every step re-runnable by a stranger. It is a working argument that achievement and reputation do not need a trusted authority.

## 9. Risks and open questions

- **Refactor breadth.** The fixed-timestep change touches every wall-clock deadline in `game.ts`. Mechanical, but broad, and it needs real playtesting since the timestep affects game feel.
- **Pinned-verifier limitation.** v1 verification is "run the reference verifier", not "any engine agrees". Honest and sufficient for zero-trust, but some will want cross-engine determinism. Hardening exists (§4) but is real work.
- **Versioning.** A replay pins a `gameVersion`. When the sim changes, old verifier builds must be archived or old replays stop verifying. The policy must be decided up front.
- **Population.** The social payoff (Marks worth verifying, tournaments worth entering) needs a player base. The artefact (pattern, verifier, NIP) has community value regardless.

## 10. Decisions before B3.0

1. Sim rate: 60Hz recommended.
2. Event kind: new regular kind (recommended) versus extending kind 30764.
3. v1 verifier environment: Web Worker on the watch page, with the CLI verifier as B3.3.
4. Game-version archival policy: how long old verifier builds are kept, and whether old replays expire.
5. Audio seam: v1 headless flag versus the cleaner event-sourced refactor.
6. 600bn Sanctum determinism: confirmed out of v1 scope.
