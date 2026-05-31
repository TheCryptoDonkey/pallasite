# Multiplayer latency: adaptive delay → rollback

_2026-05-30. Goal: world-class feel / "zero lag" in the shared-arena modes
(co-op, duel, 4P deathmatch)._

## Diagnosis (measured, not guessed)

A 4P deathmatch soak (`pnpm test:deathmatch:soak`, 60+120 ms injected network)
shows the per-frame cost is already excellent and is **not** the problem:

| p95 / p99 | value |
|---|---|
| sim step | 0.2–0.5 / 0.6 ms |
| render | 0.5 / 0.7 ms |
| long tasks / worker→main lag / desync / drops | 0 / 0 / false / 0 |

The felt lag is entirely the **lockstep input-delay buffer**. Because lockstep
applies every slot from the same delayed read frame (`state.frame − delay`) for
determinism, the delay is applied to *your own ship too*. The shipped static
tiers (`peerInputDelayFrames`, `main.ts`) were:

| mode | delay | felt input lag |
|---|---|---|
| co-op campaign | 24f | 400 ms |
| duel / 2P deathmatch | 30f | 500 ms |
| 4P deathmatch | 36f | 600 ms |
| AI-filled / large | 56f | 933 ms |

The design doc budgeted "a few frames" for a 60–120 ms RTT; the shipped values
were ~3–7× that, cranked up by the "Stabilize" commits to kill stalls. The soak
proved the headroom: at 36f under a 180 ms network, blocked ticks were ~0.

## Phase 1 — adaptive input delay (DONE)

**Hard constraint:** all peers must apply the same input at the same sim frame,
so the session must share **one identical delay**, frozen before frame 0. A
per-client measured value would desync. So the **broker** (single authority)
measures and assigns it.

- **Broker** (`controller-ws/server.js`): measures socket RTT to each peer via
  protocol ping/pong (`ws.ping()` + `'pong'` — transparent to the browser, no
  client cooperation). Once the human roster is bound, it probes for ~160 ms,
  computes one delay from `oneWay(slowest)+oneWay(2nd) + brokerForward +
  safety`, clamps to `[2, 60]`, and ships it in `session-config` to peers and
  spectators. One-shot per session; late joiners inherit it.
- **Client** (`src/peer.ts`): `WebSocketPeer`/`SpectatorPeer`/worker capture
  `inputDelay` from `session-config`; `getNegotiatedInputDelay()`.
- **Main** (`src/main.ts`): after connect, `captureNegotiatedInputDelay` freezes
  the value before `setPeerActive(true)`; the read site clamps it to
  `[ADAPT_MIN_DELAY_FRAMES, staticTier]` so a session is **never worse than the
  old default, usually much snappier**. `?inputDelay=` is a hard override.
- **AI-filled sessions are excluded** from adaptation (broker skips negotiation,
  client skips the await → byte-identical startup). Their late-human takeover
  handoff is co-tuned to the 56f static tier; a session can gain a late human at
  any time, so they stay static. The human modes (co-op, duel, full-roster
  deathmatch) are where the win lands.

**Determinism safety:** single broker-broadcast value, frozen pre-frame-0,
constant for the run. Timeout fallback (1000 ms) is reached consistently by all
peers because every peer's connect resolves at the same all-bound moment and
waits together → no static-vs-negotiated split.

**Results:** soak negotiates **14f** (vs 36f) under the 180 ms adversarial net,
`desync=false`, `frameSpread≤2`, maxStall 1–4f. Co-op e2e drops to **4f (67 ms)**
on a clean local link. In production (broker forward = 0, RTT 60–120 ms) expect
~7–10f (≈120–170 ms). Validated: typecheck, prod build, 4 determinism harnesses,
coop e2e, n-player e2e (incl. all AI-fill/late-takeover scenarios), soak,
spectate-latejoin.

## Phase 2 — rollback netcode (IN PROGRESS, the real "zero lag")

Run local input at delay 0–1 (instant own-ship response); predict remote inputs
(repeat-last); on a misprediction, restore a snapshot and re-simulate forward.
For inertial Asteroids movement, remote mispredictions are visually tiny.

**Prerequisites — met:**
- Determinism audited (B3 verifiable replay; `docs/b3-verifiable-replay.md`).
- RNG is a single 32-bit number with `get/setRngState` (`src/seed.ts`).
- Per-frame `InputLog` ring already exists, with "(later) rollback" hooks.
- Sim is ~0.5 ms → re-simming 10–15 frames ≈ 5–8 ms, well inside budget.

### Stage A — snapshot/restore foundation (DONE, 2026-05-31)

The bedrock: a fast, complete, byte-exact snapshot/restore of the whole
simulation, with **zero change to live behaviour** (not yet wired into the
loop). Shipped:

- **`src/rollback.ts`** — `snapshotSim(state, out?)` / `restoreSim(state, snap)`
  + a frame-keyed `SnapshotRing` (default cap 16). Captures the sim-relevant
  subset of `GameState` (omitting only the cosmetic pools + non-sim output
  sinks — exactly what the canary omits) into pooled, reused entity buffers
  (alloc-light hot path); restore allocates fresh live objects so a stored
  snapshot stays pristine across repeated restores. **Restore ordering is
  load-bearing:** after deep-restoring `state`, it sets the module RNG
  (`setRngState`), entity-id counter (`setEntityIdCounter`), and the
  sanctum/arena/sampling-cursor globals (`setSimModuleState`) — the values
  `gameRng()`/`nextStreamEntityId()`/spawners actually read.
- **`src/game.ts`** — added `SimModuleState` + `getSimModuleState`/
  `setSimModuleState` (the 9 non-mirrored module globals, incl. `arenaSpawnTimer`
  which the deathmatch arena depends on).
- **`rollback-harness.html`** (registered in `tools/run-harnesses.ts`, runs under
  `pnpm test`) — proves byte-identity: A1 baseline, A2 restore-then-re-sim
  reproduces the tail, A3 rewind exactness incl. module globals, A4
  `structuredClone` oracle agreement, A5 ring eviction. **ROLLBACK-PASS.**

Verified: typecheck + prod build clean, all 5 harnesses PASS, deathmatch soak
PASS (desync=false, zero drift).

### Stage B — live-loop rollback (NEXT)

Wire the foundation into `src/main.ts`, behind a default-off `?rollback=1`,
excluding aiFill/spectator (same fragile-startup exclusion as Phase 1):

1. Per-slot read delay: local at 0–1 (instant own ship), remote predicted.
2. Prediction (repeat-last-input) for un-received remote frames, **with the
   edge bits (5 hyperspace, 6 shield) masked** so a held prediction can't
   re-fire them every frame.
3. Misprediction detect on real-input arrival → `restoreSim` + re-sim. Reuse the
   desync-canary hash to assert re-sim correctness.
4. **Canary on confirmed frames only** — predicted/tentative frames must never
   be hashed or compared, or peers raise false desync alarms.
5. Cap the rollback window (≈ ring cap); on overrun, fall back to the Phase-1
   delay path (predicting↔stalling state machine).
6. Adaptive delay stays as the floor/fallback when prediction is disabled.
