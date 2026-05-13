# 600bn Sanctum — overnight build report

Date: 2026-05-14 (overnight session)

## What shipped tonight

The 600bn Sanctum cross-promo for the FUCHS2 Prague party (11 June 2026)
is now a complete end-to-end experience on `600b.pallasite.app`:

1. **Sanctum entity module** (`src/sanctum.ts`) — 5-phase timed arc over
   240 seconds (invocation → ascendant → ritual → inferno → finale →
   complete), 11 council member-avatar asteroids on a slow orbit that
   respawn 9s after each kill, Sacred Stone with triple-shatter at
   escalating HP, racooDNI cameo at the start of the RITUAL phase
   (canonical 04:20 GMT "GM" banner), Bullbear final-30s boss with
   crackling orange-lightning trail, ember meteor filler at phase-driven
   spawn cadence.

2. **Game-loop integration** (`src/sanctum-loop.ts` + `src/sanctum-render.ts`)
   — Wires the Sanctum into the standard Pallasite ship + bullet system.
   Three single-line early-return guards added to `game.ts` /
   `render.ts` / `music.ts`; main-flavour codepaths are byte-identical
   to before. Bullet × member / stone / racoo / Bullbear / meteor
   collisions resolve via dedicated `applyXxxHit` helpers and accumulate
   into `state.sats`. Ship-body collision with any sanctum entity ends
   the run.

3. **FUCHS2 party card** on the game-over screen, with a clickable
   tappable QR code to `600.wtf`. Renders for every Sanctum run via the
   `state.sanctum` check in `renderRunCredits`.

4. **Bespoke attract screen** for the 600bn flavour — 4-line sacred
   number wordmark, 'THE SANCTUM' banner, 3-line mission brief, single
   ENTER button. Bypasses the standard auth flow; guest path runs and
   sign-in is offered at game-over for Lightning payouts.

5. **Faucet pipework** — `daily_cap_600bn` setting (default 10,000 sats)
   in the admin panel's LIVE SETTINGS card, `room='600bn'` on claim
   payload, `['t','600bn']` Nostr attestation tag on the kind 30762
   score event. Migration 012 added the `claims.room` column; existing
   claim test suite still passes 11/11.

6. **Madeira backdrop** — generated via gpt-image-2 from a canon-faithful
   prompt (volcanic basalt cliffs at storm-light golden hour, ember/gold
   palette, lower-centre dark void for legibility). Applied as the body
   background while the canvas paints over it.

7. **Caddy block** for `600b.pallasite.app` — folded into the existing
   pallasite block so a single Let's Encrypt cert covers all four
   subdomains. Backup of pre-change Caddyfile at
   `/etc/caddy/Caddyfile.bak.2026-05-14-012349` on the Hetzner box.

8. **Service worker bumped** to `v78` to invalidate cached old bundles
   on next visit.

## What to test on first sign-in

Visit https://600b.pallasite.app — you should see:

1. **Attract screen** with sacred number wordmark + ENTER button. The
   Madeira backdrop should be visible behind a moody vignette. Music
   bed (`the-cult.opus`) should start on first interaction.

2. Tap **ENTER** to drop into the Sanctum. Ship spawns lower-centre with
   3s intro invulnerability (yellow ring). Use ←→ / W A S D / joystick
   to rotate, ↑ to thrust, Space to fire. On mobile/touch the existing
   pointer-driven joystick + fire button should still work.

3. The **council ring** (11 member-avatar asteroids) orbits slowly. Hit
   one twice to break it; the member name + role + archetype banner
   flashes briefly. A dead slot respawns ~9s later.

4. **At 90s** racooDNI scuttles in from the left, dropping a "GM ·
   04:20 GMT · RITUAL" banner. One hit → 6 sat burst.

5. **At 150s** the Sacred Stone wakes at the centre with its ember halo
   pulsing. Chip it down for a 21-sat shatter; up to 3 shatters per run
   (HP escalates 10 → 16 → 24).

6. **At 210s** Bullbear charges in from the left edge, sweeping back
   and forth. 8 HP, 21-sat drop on defeat.

7. **At 240s** (or on Bullbear-defeat / ship-death) the game ends. The
   FUCHS2 party card surfaces above the existing claim picker (lud16 /
   LNURL-w / balance).

## Known gaps / follow-ups

- **No live-streaming or heartbeat** for Sanctum runs — they're filtered
  out of `STREAM_PHASES` and `HEARTBEAT_PHASES` in `main.ts` by virtue
  of `'sanctum'` not being in those sets. Intentional for a teaser, but
  if you want Sanctum runs to appear on `watch.pallasite.app` it's a
  one-word addition to each phase set.

- **No death replay buffer** for Sanctum — same reason as above; the
  buffer captures only during `'playing'`. Adding `'sanctum'` to the
  recording set would enable replays + ghost trails for the teaser.

- **No `cameraTrauma` shake** wired through `sanctum-loop.ts` —
  collisions don't push trauma into the existing render shake. Easy to
  add: `s.cameraTrauma = Math.min(1, s.cameraTrauma + 0.4)` on Bullbear
  defeat / Stone shatter. Skipped tonight to keep the diff tight.

- **Particle effects** for breaks/shatters are minimal (no `spawnParticles`
  calls from sanctum-loop). Sanctum entities don't currently emit the
  same explosion burst the main game's asteroids do. A future pass
  could call `spawnParticles` from inside the applyXxxHit branches.

- **Music intensification** is not phased — `the-cult.opus` plays at its
  base mix throughout. Layered stems would be ideal but absent; the
  bed's natural envelope carries the run.

- **#155** (admin daily_cap_600bn surface) — surfaced as a settingRow in
  LIVE SETTINGS card. No dedicated "600bn today" mini status card yet;
  the row is enough for the conference.

## Tuning knobs (admin panel)

Pop to https://600b.pallasite.app/admin and toggle these live:

- `daily_cap_600bn` — default 10,000 sats. Bump to e.g. 50,000 if the
  teaser gets busier than expected, or drop to 2,000 to throttle.
- Standard caps (per-claim, daily, hourly) apply on top of the room
  sub-cap — Sanctum claims need to satisfy BOTH.

Everything else (drop denominations 1/2/6/21, phase boundaries, HP
progression) lives as compile-time constants in `src/sanctum.ts`.
Adjust + redeploy.

## Commit ledger

This session's pushed commits on `main`:

- `7616758` — deepen Sanctum module (racoo, Bullbear, meteors, phases)
- `d787f69` — wire Sanctum into game loop
- `69fca20` — FUCHS2 game-over card + room=600bn on claim
- `6608971` — bespoke 600bn attract screen
- (+ SW bump + admin daily_cap_600bn row in next commit)

Earlier in the session (yesterday/today):

- `7c01684` — sanctum.webp background
- `6fb75ee` — bg generation tooling + preview hook
- `0cccede` — Sanctum entity module + /sanctum-preview route
- `de0b705` — flavour module + the-cult.opus + 11 member avatars
- `e910bf5` (faucet) — daily_cap_600bn + room field + t=600bn tag

## Safety verifications run

- `pnpm typecheck` clean at every checkpoint
- `pnpm build` clean — main bundle 514KB → 531KB (+17KB for the
  statically-imported sanctum-loop module)
- Faucet claim test suite — 11/11 still pass
- All four Caddy hostnames return 200 after the config reload
