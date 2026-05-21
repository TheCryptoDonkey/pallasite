# Pallasite: Shared-Arena Multiplayer

**Status:** plan v1.1 (progress log updated 2026-05-21)
**Purpose:** scope real-time 2-player shared-arena multiplayer. Supersedes the
Layer 3 sketch in `async-pvp.md`, whose `pallasite-duel` "dispatch capability"
assumption was wrong: dispatch is encrypted-DM agent negotiation, not a public
matchmaking board.

**One line:** two remote players in one shared arena, both ships live and
interacting, kept in sync by deterministic lockstep over the existing
controller-ws WebSocket relay.

## 1. Decision record

- Real-time *shared* arena with two interacting ships. Not async score-compare,
  not couch-only.
- Friendly only: no sats, no stakes, no escrow. A multiplayer run never pays
  out a faucet claim.
- Transport: the existing controller-ws broker (`joystick` repo,
  `packages/broker/server.js`), made bidirectional. Not WebRTC — a purpose-built
  60Hz WebSocket relay already exists and removes NAT traversal entirely.
- Netcode: deterministic lockstep. v1 is delay-based; rollback is a later
  additive upgrade, kept reachable by the B3 determinism work.
- v1 rules: shared seeded arena, two ships, separate scores, friendly-fire off,
  the run ends when both ships are out, higher score wins. Co-op (shared lives,
  combined score) is a later variant.

## 2. Architecture

Both clients run the identical deterministic sim and exchange only input
bitfields, roughly one byte per player per step. The shared 32-bit seed gives
both the same arena; the exchanged inputs drive both ships; B3.0 determinism
(fixed timestep, sim clock, seeded RNG) keeps the two clients bit-identical. The
B3 state hash doubles as a live desync detector.

The controller-ws relay today is one-publisher-to-many-subscribers. It gains a
bidirectional `peer` role (~20 lines) so two clients cross-feed.

Latency: client to relay to client is two hops. Nearby players see roughly
60-120ms round trip. Delay-based netcode absorbs that with a few frames of input
delay, and since both players are delayed equally it stays fair. Rollback
(predict the remote input, roll back and re-simulate on a miss) is the upgrade
if the feel needs it; it adds GameState snapshot/restore and prediction, which
is additive, not a rewrite. The Doom-demo input-log model is the foundation: the
same input log is the replay artefact, the live netcode payload, and the
prerequisite for rollback.

## 3. Phases

| Phase | Scope | Deliverable | Est. |
|---|---|---|---|
| M1 Two-ship sim | `GameState.ship` to `players[]`; per-player state split; bullet owner; game-over rework; setTimeout to frame-deadlines; two-ship render; local two-keyboard control | Couch 2-player local; determinism harness green for solo | 1.5-2 wk |
| M2 Lockstep core | Input bitfield; per-step input exchange; input-delay buffer; hit-stop into the sim; tested on a simulated-latency loopback | Lockstep proven deterministic offline | ~1 wk |
| M3 Transport | Broker `peer` role + backpressure drop; two browsers on a duel session; jitter buffer; stall + disconnect handling; periodic state-hash desync check | Two real browsers, two locations, one shared arena | 1-1.5 wk |
| M4 Matchmaking + polish | Invite/find an opponent over Nostr (npub/QR); duel lobby UI (d-pad navigable); connection-status UI; versus rules; spectate via existing watch tech | Shippable | ~1 wk |

Total roughly 5-6 weeks. Netcode has a long bug tail; treat M3 as a floor.

## 4. M1 — two-ship sim (detail)

The invasive phase. `GameState.ship: Ship` becomes `GameState.players:
PlayerState[]`. Length 1 is every existing solo mode and must stay
byte-identical, guarded by the determinism harness.

**PlayerState** holds everything inherently per-ship: the `Ship` body, `lives`,
`score`, `sats` / `displaySats`, `combo` / `comboExpiresAt`, the powerup timers
(`rapidExpiresAt` / `satboostExpiresAt` / `tridentExpiresAt` / `magnetExpiresAt`),
`fireCooldownUntil`, respawn state, the lurk fields, per-player run stats,
`cameraTrauma`.

**Stays global on GameState:** the entity arrays (asteroids, ufos, mines,
bullets, coins, powerups, particles, debris), `wave` / arena cage / spawn
timers, `phase` / `elapsed` / `frame` / `seed`.

Three hard problems:

1. **Game-over.** `killShip` decrements `lives` and flips `phase='gameover'`.
   With two ships, game-over is "all players out"; `phase` is global, so one
   death cannot flip it.
2. **Deferred actions.** Hyperspace, shield and respawn use wall-clock
   `setTimeout` today. Determinism needs these as absolute sim-frame deadlines
   consumed inside `updateGame`. This is also a latent B3 fix, so it pays
   double. It is M1's first step: independent of the array refactor and it
   leaves the build green.
3. **Bullet ownership.** `Bullet` gains an `owner` index so score, combo and
   sat credit go to the player who fired.

Roughly 254 `.ship` reference sites across 8 files; `game.ts` is the bulk. The
determinism harness is the safety net: after the refactor it must still report
DETERMINISM-PASS for a 1-player run.

M1 also yields couch 2-player on two local keyboards (Layer 1 from
`async-pvp.md`, as a side effect) — the milestone that validates two-ship
gameplay before any netcode.

## 5. Risks

- The 254-site `.ship` refactor is broad and error-prone. The determinism
  harness mitigates it, but it is careful work.
- The setTimeout to frame-deadline change is determinism-critical.
- Netcode long tail in M3: jitter, late-input stalls, disconnects.
- Latency feel is only provable on the real relay with two genuinely distant
  players.

## 6. Repos

- `asteroid-sats` — the game; the bulk of the work.
- `joystick` — the controller-ws broker `peer` role (M3).
- `pallasite-faucet` or plain Nostr — matchmaking (M4).

## 6.1 M3 — transport detail

### Wire format (v1, JSON over WebSocket)

Two clients, one session, mirrored through the broker. JSON for v1 readability;
a binary frame replaces it later if bandwidth ever bites.

**Client → broker:**

```
{ type: "hello-peer", session: string, slot: 0 | 1, version: 1 }
{ type: "frame", frame: number, slot: 0 | 1, input: number }
{ type: "hash",  frame: number, slot: 0 | 1, hash:  number }
{ type: "bye",   slot: 0 | 1 }
```

**Broker → client (mirrors messages from the other slot):**

```
{ type: "frame",         frame: number, slot: 0 | 1, input: number }
{ type: "hash",          frame: number, slot: 0 | 1, hash:  number }
{ type: "peer-joined",   slot: 0 | 1 }
{ type: "peer-left",     slot: 0 | 1, reason: string }
{ type: "session-error", code:  string }
```

`input` is the 24-bit packed `encodePlayerInput` value. `hash` is the same
FNV1a-32 the determinism harness uses, sent every 60 frames as a desync canary.

### Broker change (joystick repo, ~20 lines)

`packages/broker/server.js` today is one-publisher-many-subscribers. The
`peer` role adds a `sessions: Map<sessionId, [ws0, ws1]>`. On `hello-peer`,
populate the slot; on `frame` / `hash`, forward to the OTHER slot only
(never echo back); on socket close, send `peer-left` to the partner and
clear the slot. Backpressure: if a slot's send buffer exceeds N messages,
drop the oldest frame and bump a counter. Two clients per session; a third
`hello-peer` gets `session-error: full`.

### Client (`src/peer.ts`)

A `Peer` interface with two implementations:

- `WebSocketPeer` — real transport against the broker. JSON encoded.
- `LoopbackPeer` — pairs two instances locally; one's `send` lands in the
  other's `pollFrames` inbox after a configurable delay. Used by the M3
  test harness to drive both sides of a duel in one process.

Both expose `sendFrame(frame, encoded)`, `sendHash(frame, hash)`,
`drainFrames()`, `drainHashes()`, `isConnected()`, `lastReceivedFrame()`.

### Lockstep loop integration

The main loop, when a peer is wired:

1. Sample local input; record under `(state.frame, localSlot)` in InputLog;
   `peer.sendFrame(state.frame, encoded)`.
2. Drain `peer.drainFrames()` into InputLog under `(frame, remoteSlot)`.
3. Read both slots at `state.frame - inputDelay`. If either is missing,
   STALL (do not advance the sim this tick); accumulate stall time.
4. If both are present, dispatch edges + `updateGame`.
5. Every 60 frames: hash `GameState`, send via `peer.sendHash`; on receive,
   compare to local hash for that frame; mismatch -> log + UI flag (do not
   resync v1, just observe).

### Stall and disconnect policy

- Up to ~6 frames (100ms): silent stall, render the last frame.
- 6 to ~30 frames: stalled overlay shown ("waiting for OPPONENT").
- > ~120 frames: declare disconnect; show "OPPONENT LEFT", end the run.

### Why this is small in scope

Lockstep input is one number per player per step. The protocol is five
message kinds. The broker change is ~20 lines because the broker is already
WebSocket-based. The bulk of M3 is the polish: stall UI, the desync
canary, reconnect on a brief drop. The transport itself is shallow.

## 7. Progress log (as of 2026-05-21)

### M1 — two-ship sim — done

Done and committed to `main`:

- **#44** deterministic sim-transition scheduler — wall-clock `setTimeout`
  deferrals replaced with sim-clock-scheduled transitions (`178d119`).
- **#45 / #46** the `players[]` pivot — `GameState.ship` and the 20 other
  per-player fields moved into a new `PlayerState`; `GameState` now holds
  `players: PlayerState[]`; ~539 sites across 13 files routed through
  `players[0]`, behaviour byte-identical, determinism harness green
  (`ed309b5`).
- **#47** bullet ownership — `Bullet.owner` carries the firing player's
  index (`-1` for enemy bullets); `fireBullet` stamps it; score/combo/sat
  credit routes via `players[owner]`.
- **#48** per-player game-over — `killShip(s, p)` kills one player;
  `phase='gameover'` only flips when every player is out; per-player
  respawn points.
- **#49** two-ship render — `for (const p of s.players)` in update and
  render loops, camera frames both, per-player HUD rails.
- **#50** two-player start path — `startGame(s, seed?, { players: 1 | 2 })`;
  P2 keyboard scheme in `main.ts` routes physical keys to
  `players[1].keys`.
- Per-player sim helpers threaded: `tryHyperspace`, `tryActivateShield`,
  `fireBullet`, `killShip`, `applyPowerUp`, `recordCombo`, `resetCombo`,
  `updateLurkState`, `maybeExtraLife`, `damageUfo`, `destroyUfo`,
  `damageAsteroid`, `breakAsteroid`, `damageMine`, `destroyMine`.

Couch 2-player works on two local keyboards. Solo determinism harness
still green for length-1 runs.

### M2 — lockstep core — done

- **`5351cf9`** `PlayerInput` type + 24-bit encode/decode + `InputLog`
  ring buffer.
- **`2451418`** sample local input into the log each sim step.
- **`b46696d`** drive the sim through the input log.
- **`b500605`** dispatch hyperspace and shield from the input log.
- **`c46ea94`** input-delay buffer + simulated-latency loopback harness.

Lockstep proven deterministic offline.

### M3 — transport — done modulo live smoke test

asteroid-sats side (client):

- **`da02ed0`** wire protocol + `Peer` interface + `LoopbackPeer` +
  `WebSocketPeer` (`src/peer.ts`).
- **`f1511b4`** paired-loopback convergence harness.
- **`39880c9`** `WebSocketPeer` wired into the main lockstep loop.
- **`232b71d`** M2/M3 lockstep pipeline gated behind an active peer
  (solo path stays untouched).
- **`e05bd46`** stall overlay (`body[data-peer-stall="waiting"]`) at
  ~100ms and disconnect end-of-run at ~2s; `toastNow('Opponent left')`
  + transition to gameover phase.
- **`68ee16a`** desync canary every 60 frames (`src/peer-canary.ts`);
  mismatch surfaces via `body[data-peer-desync]` + console warn. v1
  observes, does not resync.
- **`69a50d3`** auto-reconnect (3 backoff attempts: 250 / 500 / 1000 ms)
  with input-frame replay on `setOnReconnected()` so the partner can
  refill the input log over the drop.

joystick side (broker, this session):

- **`d467867`** `peer` role added: `slot.peers = [ws0, ws1]` populated
  from `hello-peer`; `frame` / `hash` forwarded only to the OTHER slot;
  `peer-joined` / `peer-left` notifications; `session-error: full` on
  third joiner; backpressure drops at 64KB buffered. Orphan-sweep +
  empty-session checks now account for peer slots. 17 new smoke
  assertions.

Outstanding M3 work:

- [ ] two real browsers, two locations, one shared arena smoke test on
      the live relay (requires broker deployment + an invite UI from M4).

### M4 — matchmaking + polish — done

- [x] **`3eb9449`** `/duel` route with HOST + JOIN tabs. HOST generates an
      8-char session ID, renders the invite URL as a QR + copy button +
      READY navigation. JOIN takes a pasted invite URL, validates the
      `peer`/`session`/`slot` triplet, then navigates. d-pad-navigable
      via `setupOverlayArrowNav`.
- [x] Versus-rules text on the lobby ("Shared seeded arena. Both ships
      in the same field. Friendly fire is off. Run ends when both ships
      are out — higher score wins.").
- [x] Session-derived seed: `mpSeed = fnv1a32(mpSession)` so both
      clients build the same arena from frame 0.
- [x] Auto-IGNITE on peer-joined: `simulateStart()` (new exported helper
      in `ui.ts`) runs the same code path as the IGNITE button. Both
      sims start at near-identical wall-times, well inside the 5-frame
      input-delay buffer.
- [x] `renderAttract` skipped when peer is wired so the attract screen
      doesn't flash between connect and game start.
- [x] Title-screen `⚔ DUEL` button added to the existing menu row,
      navigates to `/duel`. Solo path otherwise untouched.
- [x] **`ffa0bd3`** versus banner on gameover: when `players.length === 2`
      (couch or duel), renderRunCredits prepends a side-by-side score
      card with a WINNER call-out (yellow highlight) or DRAW heading.
      Single-player recap (publish / claim / honours) unchanged below.
- [x] **`ffa0bd3`** `renderDuelConnecting()` overlay shown between
      `new WebSocketPeer()` and the resolve of `peer.connect()`. CANCEL
      bounces back to /duel. Cleared by simulateStart's clearOverlay()
      on success, or by renderAttract on connect failure.
- [x] **`d72753a`** camera QR scanner on the JOIN tab. Live video via
      getUserMedia + jsQR (downscaled to 640px, attemptBoth inversion)
      with FROM PHOTO fallback for file-picker single-pass decode. Both
      validate that the QR is a Pallasite duel invite URL before
      navigating; random QRs are silently rejected and scanning
      continues.

### M5 — spectate duels via watch.* — not started

The `watch.pallasite.app` surface already streams kind 30764 replay
frames from solo runs via the broker's `subscribe` role. Spectating a
LIVE duel needs:

- [ ] broker: a `r=peerwatch` subscribe-only role that mirrors frame /
      hash messages from both peer slots to any number of watchers
      without ever forwarding to peers (read-only tap of a peer
      session)
- [ ] watch UI: a duel-session picker / direct deep-link, so a
      spectator can open `watch.pallasite.app/?duel=<session>` and
      drop into the lockstep sim with both ships rendered
- [ ] spectator renderer: re-uses the lockstep loop but in
      read-only mode (no local input sampling, only drains both
      slots' frame inputs from the broker tap)

### Cross-repo status

| Repo | State |
|---|---|
| `asteroid-sats` | M1 + M2 + M3 + M4 done; live two-browser smoke pending broker deploy |
| `joystick` | broker `peer` role landed (`d467867`); **needs deploy** to controller.pallasite.app |
| `pallasite-faucet` | clean; no M4 dependency (Nostr invite is just "send the URL over any channel") |

### Next concrete step

Deploy the updated `controller-ws` (joystick `main`, commit `d467867`)
to controller.pallasite.app. Once live, two browsers can:

1. Player A: open `pallasite.app/duel`, HOST tab, tap READY (lands on
   `/?peer=…&session=…&slot=0`). Sees "Connecting · Waiting for
   opponent to join the arena."
2. Player B: scans Player A's QR with the JOIN-tab camera, pastes the
   COPY-INVITE-LINK URL, or opens the URL directly. Lands on
   `/?peer=…&session=…&slot=1`.
3. Both WebSocketPeers send `hello-peer`. Broker binds the slots and
   fires `peer-joined` to both. Auto-IGNITE triggers. Shared arena
   runs in lockstep from the session-derived seed.
4. On run end: versus banner shows WINNER · P1/P2 (or DRAW) with both
   scores. Toast "Opponent left" + gameover on partner disconnect.

If that smoke test passes, M3 + M4 close out for real and the only
work remaining on the original plan is M5 (watch spectate).
