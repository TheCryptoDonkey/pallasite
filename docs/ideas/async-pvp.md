# Idea: Async PvP via dispatch + Lightning escrow

Parked for later. Sketches the design across three layers, in build order. The user-facing goal is "play 2P asteroids on a single TV"; the dispatch + escrow layer is what makes it ranked and stake-backed.

## Layer 1: Couch 2-player (no Nostr, no escrow)

The minimum playable thing. Validates whether 2P gameplay is actually fun before any protocol work.

- Two ships on one canvas. Two control schemes: WASD + Space for P1, Arrows + Numpad-Enter for P2. Two gamepads via the Gamepad API as the alternative.
- One game loop, two `PlayerState` records inside `GameState`. Length-1 array stays the current solo path; length-2 is couch.
- Modes:
  - Deathmatch: last alive scores. Friendly-fire on player bullets.
  - Score-rush: shared asteroid field, race to a target score.
  - Co-op: shared lives pool, waves harden a tier (extra spawns).
- Renderer already loops over entities; a second ship is one extra `drawShip` call. HUD splits into a left rail (P1) and right rail (P2).
- File touches:
  - New `src/multi.ts`: mode rules, lives accounting, win/end conditions.
  - `src/types.ts`: `GameState.players: PlayerState[]`.
  - `src/game.ts`: physics + collision loops iterate `players`.
  - `src/main.ts`: input mapping for the second control scheme + Gamepad API polling in the loop.
  - `src/render.ts`: ship loop + HUD split.
- Time: a day or two of work.

## Layer 2: Ranked couch (signet identities, no escrow)

Both players sign in on the device so 2P runs land on the leaderboard.

- `state.sessionP2` alongside the existing `state.session`. Two signet sessions held in memory, independent.
- "Add player" button on the title opens a QR. P2 scans with their phone bunker, the existing signet-login pairing flow completes, P2's session lands in `state.sessionP2`. Around 50 lines using existing primitives.
- Score publish at gameover splits into two: each player's session signs their own kind 30762 with a shared `seed` tag so observers can verify the run was a duel.
- Leaderboard surfaces a "couch run" badge when a score came from a 2P match.

## Layer 3: Async PvP via dispatch + Lightning escrow

The full ranked, stake-backed version. Multi-repo project: needs an oracle service in TROTT, a `pallasite-duel` capability published to the dispatch capability registry, and regtest LN integration tests.

### Dispatch shape

New `pallasite-duel` capability.

- `propose` event signed by P1 carries: `stake_sats`, `seed` (drives RNG so the run is deterministic), `mode`, `expiry` (NIP-40), `payment_hash` for the escrow lock, `lud16` for payout.
- `reply` event signed by P2 carries: acceptor's `payment_hash` + `lud16`. P2's reply is the binding act, no separate ack needed.
- Both kind 30762 score events `e`-tag the propose event. The oracle filters `#e=propose_id` to see exactly the two scores it needs.

Couch-with-stakes is this same flow with both pubkeys producing both events on one device. Async-remote is the same flow with one device per player and propose lingering on relays until someone matches.

### Lightning escrow

Two viable shapes; pick by trust appetite:

**Trusted oracle (recommended at Pallasite stakes).** Both players zap (NIP-57) to a known escrow npub. Oracle reads both scores after expiry, zaps winner 2x stake minus a small fee. One signing key on the same TROTT box as the score relay. Operationally cheap. Suits the 100-10k sat range.

**HOLD invoice + preimage release.** Each player creates a HOLD invoice, pays the other's. Oracle holds preimages and reveals the winner's on their invoice. Trustless-ish but operationally heavier (long-lived oracle, HOLD-aware LN nodes both ends). Only worth it if stakes outgrow trust in the oracle.

Migration between the two is straightforward: dispatch shape is unchanged, the oracle's settlement behaviour is the only thing that swaps.

### Signet's role

- Identity is the pubkey across all three layers.
- Payout target is the kind 0 profile's `lud16`.
- Every propose, reply, and score event is signed by the player's signet session via `canSignEvents`.
- Bunker, NIP-46 remote signing, and NIP-07 extensions all work; the existing signet-login flow already supports all three.
- The second player joins by QR-bunker pairing on the same TV without unsetting player 1.

## Build order

1. Layer 1 first to validate gameplay.
2. Layer 2 once couch is fun.
3. Layer 3 only once stakes start to matter to anyone. Multi-repo, needs oracle service + capability publish + regtest LN.

## Open decisions parked for later

- Match expiry default: 24h feels right for async, but couch should resolve immediately (both score events arrive within seconds of each other).
- Fee split for the trusted oracle: % of stake or flat sat fee?
- Anti-collusion: do we need a leaderboard rule against players sharing pubkeys to farm self-duels? Probably yes; flag duels where both pubkeys also have a high mutual-follow signal as "friendly".
- Reconnect / disconnect handling for async-remote: if P2 accepts but never publishes a score before expiry, P1 wins by default. Need a clear "expired without contest" UI.
