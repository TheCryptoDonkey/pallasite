# Joystick extraction plan — forgesworn/joystick

Goal: lift the controller-host + phone-as-controller pieces out of asteroid-sats into a repo `forgesworn/joystick`, structured from day one to serve **any game dev**, Nostr-native or not, with an open-core / managed-service business model on top.

## Status / decisions so far

- **Historical note:** this plan was written before the June 11 2026 public-flip gate. Public-readiness work is now expected to live in the active repos, with MIT licensing and README-level adoption docs at the root.
- **Business model: open-core.** Free OSS self-host path; managed hosted broker + PWA for those who want zero ops. Free tier gated by account; paid tiers for higher quotas.
- **Pallasite keeps its own `/controller` route through June 11.** No migration to the hosted PWA before then.
- **Stages 3 and 4 (mobile + host SDK extraction) are post-FUCHS2 only.** Touching `ui.ts` or `controller-host.ts` while Pallasite is live is too risky.
- **Stage 1 broker move uses option A (deploy job migrates to joystick repo).** See migration plan.
- **No bespoke CDN.** Use jsDelivr / unpkg pointing at npm packages.

## Design principle: three layers, not one

The current asteroid-sats implementation conflates transport, identity, and Nostr extensions. A non-Nostr dev (Unity WebGL exporter, Phaser hobbyist, Godot HTML5 game, museum installation, trade-show kiosk) bounces off the current spec because the wire format mentions Nostr in passing. The extracted repo must clean this up.

### Layer 0, Transport
Short-code pairing, WS broker, joystick / button / haptic / display messages. JSON over WebSocket. **Zero Nostr surface.**

### Layer 1, Identity (optional, pluggable)
Defaults to guest pair. Drop-in signet-login for Nostr identities. A Unity dev never sees this layer; a Nostr-native dev opts in.

### Layer 2, Nostr extensions
kind 30030 game manifest, kind 30040 player overrides, kind 30762 score publishing, paid-feature gating via kind 21236. Pure addons for those who already speak Nostr.

These three layers must be **independent npm packages**, not feature flags inside one package. Bundle size of `joystick-host` must not carry `nostr-tools`.

## Repo layout

```
forgesworn/joystick/
├── packages/
│   ├── protocol/                     @forgesworn/joystick-protocol
│   │   ├── src/
│   │   │   ├── messages.ts           wire types
│   │   │   ├── controls.ts           control variants
│   │   │   └── version.ts            protocol version, capability flags
│   │   ├── schemas/                  JSON Schema, language-agnostic
│   │   └── package.json              zero runtime deps
│   ├── host/                         @forgesworn/joystick-host
│   │   ├── src/
│   │   │   ├── JoystickHost.ts       SDK entry point
│   │   │   ├── pair.ts               QR + pairing flow
│   │   │   └── transport/            WS client
│   │   └── package.json              deps: protocol, no Nostr
│   ├── mobile/                       @forgesworn/joystick-mobile
│   │   ├── src/
│   │   │   ├── JoystickClient.ts     phone-side SDK
│   │   │   ├── stick.ts              floating-origin joystick
│   │   │   └── buttons.ts            button rendering / haptics
│   │   └── package.json              deps: protocol
│   ├── nostr/                        @forgesworn/joystick-nostr
│   │   ├── src/
│   │   │   ├── withNostrAuth.ts      signet-login adapter
│   │   │   ├── manifest.ts           kind 30030
│   │   │   └── overrides.ts          kind 30040
│   │   └── package.json              deps: host, signet-login
│   └── broker/                       WS broker (Node server)
│       ├── server.js
│       ├── systemd/
│       └── package.json
├── apps/
│   ├── pad/                          pad.forgesworn.dev, hosted phone PWA
│   └── demo/                         StackBlitz-able demo (post-public-flip)
├── docs/
│   ├── protocol.md                   wire spec, language-agnostic
│   ├── cookbook.md                   "add this to my Unity WebGL game"
│   ├── self-host.md                  broker + PWA self-hosting (first-class)
│   ├── managed.md                    free + paid tier docs
│   └── nostr-extensions.md           what Nostr buys you on top
├── .github/workflows/
│   └── deploy.yml                    rsync broker to VPS (migrated from asteroid-sats)
├── pnpm-workspace.yaml
├── LICENSE                           MIT
└── README.md
```

## Package dependency graph

```
protocol ← host   ← nostr
        ← mobile
        ← broker
```

Load-bearing invariant: no package depends on Nostr unless its name contains "nostr". CI should enforce it, a script that fails if `packages/host` or `packages/mobile` resolves `nostr-tools` anywhere in their dependency tree. (Adds in Stage 2; not in commit 1.)

## What moves out of asteroid-sats

| Current location | Target package | Stage |
|------------------|----------------|-------|
| `controller-ws/` | `packages/broker/` | 1 |
| `.github/workflows/deploy.yml` (controller-ws lines) | new `.github/workflows/deploy.yml` in joystick repo | 1 |
| `src/controller-types.ts` | `packages/protocol` | 2 |
| `src/controller-mobile.ts` | `packages/mobile` | 3 (post-FUCHS2) |
| `src/ui.ts:5485-5980` (phone joystick rendering) | `packages/mobile` | 3 (post-FUCHS2) |
| `src/controller-host.ts` | `packages/host` (after game-deps refactor) | 4 (post-FUCHS2) |
| `src/touch.ts` (host-side stick) | `packages/host` | 4 (post-FUCHS2) |
| `docs/joystick-protocol.md` | `docs/protocol.md` | 2 |

## What stays in asteroid-sats

- `src/game.ts` and game logic (`tryHyperspace`, `tryActivateShield`, etc).
- Thin adapter wiring `JoystickHost` to game callbacks.
- Game-specific UI: HUD, leaderboard, asteroid rendering, lore overlays.

After full extraction the controller surface in asteroid-sats is roughly:

```ts
import { JoystickHost } from '@forgesworn/joystick-host';
import { withNostrAuth } from '@forgesworn/joystick-nostr';

const host = withNostrAuth(new JoystickHost({ brokerUrl: BROKER }), { appName: 'Asteroid Sats' });

host.on('input', state => {
  if (state.buttons.thrust) thrust();
  if (state.buttons.hyperspace) tryHyperspace();
});
```

## Non-Nostr dev story (post-public-flip)

```html
<script src="https://cdn.jsdelivr.net/npm/@forgesworn/joystick-host/dist/joystick-host.iife.js"></script>
<script>
  const host = new Joystick.Host({ brokerUrl: 'wss://broker.forgesworn.dev', apiKey: 'YOUR_KEY' });
  host.suggestLayout({
    sticks:  [{ id: 'move', mode: 'floating' }],
    buttons: [{ id: 'jump', label: 'A' }, { id: 'fire', label: 'B' }],
  });
  host.showQR('#qr');         // QR points at https://pad.forgesworn.dev?code=ABCD
  host.on('input', state => {
    if (state.buttons.jump) player.jump();
    movePlayer(state.sticks.move);
  });
</script>
```

`apiKey` is omitted on self-host (anonymous mode on the dev's own broker), required for our hosted broker.

## Nostr dev story

```ts
import { JoystickHost } from '@forgesworn/joystick-host';
import { withNostrAuth, publishScore } from '@forgesworn/joystick-nostr';
import * as Signet from 'signet-login';

const host = withNostrAuth(new JoystickHost({ brokerUrl: BROKER }), {
  appName: 'My Nostr Game',
  signetLogin: Signet,
});

host.on('login', session => { /* session.pubkey, session.signer */ });
host.on('input', /* ... */);

await publishScore(host.session, { game: 'my-game', score: 12350 });
```

For our hosted broker, account can be a Nostr pubkey rather than an API key, paid via Lightning zap.

## Hosting tiers (the business model)

| Tier | What | Who |
|------|------|-----|
| OSS / self-host | Clone the repo, run broker + PWA on your own box | Privacy-first deployments, museum installs, indie devs with infra |
| Free | Hosted broker, quota-gated (concurrent pairs, message rate, message size). Requires sign-up. | Tyre-kickers, weekend hackers, evaluators |
| Paid | Higher quotas, custom subdomain, priority support, SLA | Indie studios, small productions, anything with real users |

**Self-host is first-class, not a footnote.** Docker image, one-command bring-up (Caddy + broker + PWA), polished docs. If self-host is painful no one chooses it and the "open" half of open-core collapses.

**Broker auth modes (designed Stage 5b, not built in Stage 1):**

- `anonymous`, the current shape. Used on self-host. Hard caps per IP. Free tier disables this.
- `token`, an API key issued via email sign-up. Lowest friction for non-Nostr devs.
- `pubkey`, a Nostr pubkey, upgrade via Lightning zap. Trustless, aligns with stack.

The broker source eventually grows to support all three modes via config. The wire protocol stays the same; only the pair-code issuance / quota gate changes.

**gameId registry tied to accounts.** Game registration is account-scoped, so duplicate / squatted gameIds are not a problem; the account is the namespace.

**Payment.** Lightning (zaps) for trustless small subscriptions, Stripe for traditional devs. Decision deferred; not on the critical path until Stage 5c.

## Wire-spec durability

The protocol must be implementable from another language (Unity C#, Godot GDScript, Unreal C++, native Swift / Kotlin). To make that real:

- Wire format is JSON over WebSocket. No JS-isms, no `Date`, no functions, integers stay integers.
- JSON Schema published in `packages/protocol/schemas/` alongside TypeScript types. Generation method TBD (typescript-json-schema, ts-to-zod + zod-to-json-schema, or hand-maintained).
- Protocol version field on every `pair` message. Reserved capability flags for forward-compat.
- Unknown message types: log and ignore, never fatal.
- Unknown control types in `layout`: skip the control, render the rest.
- Canonical units: milliseconds for time, normalised [-1, 1] for sticks, [0, 1] for triggers.

## Open questions to resolve before v1.0

Not blockers for Stage 1; tracked here so we don't lose them:

1. **Code namespace.** 4-letter codes cap at ~760 concurrent if we exclude confusables (no `0/O`, `1/l/I`). Bump to 5 letters, or add a TTL-eviction policy?
2. **Encrypted broker mode.** X25519 + ChaCha20-Poly1305 design exists. v1.0 or v1.1?
3. **kind 30030 game manifest.** Publish layouts to relays so phones can pre-fetch before pairing. v1.0 or deferred?
4. **kind 30040 portable overrides.** Player customisations as parametrised replaceable events. v1.0 or deferred?
5. **Hosted broker abuse policy.** Rate limits, max pair duration, max payload size, max concurrent pairs per IP / per account.
6. **Per-package semver, or single repo version?**
7. **Engine plugin priorities.** Unity vs Godot vs Phaser first, driven by demand.
8. **npm scope.** `@forgesworn/joystick-*` (requires claiming the org on npm) or unscoped `joystick-*` (collision risk)?
9. **Build system per package.** tsup, vite library mode, or rollup. (Apps use Vite either way.)
10. **JSON Schema generation method.** typescript-json-schema, zod-based, or hand-maintained.
11. **gameId registry implementation.** kind 30030 events scoped by account pubkey on Nostr side; account-scoped DB rows on token side.

## Out of scope

- Native iOS / Android SDKs (web-first, plugin-able later).
- WebRTC fallback (WS-via-broker is low-latency enough for our targets).
- Cloud-saved overrides for non-Nostr / non-account devs (Nostr-native gets this via kind 30040; non-Nostr devs roll their own or use the paid tier).
- ESP32 / Bluetooth controllers, explicit out-of-scope.

## Migration plan, staged

### Stage 1 (this session), broker move + deploy migration

- Create repo `forgesworn/joystick`.
- Initial commit: `pnpm-workspace.yaml` + `LICENSE` (MIT, dormant) + `README.md` (placeholder) + `packages/broker/` (copy of `asteroid-sats/controller-ws/`) + `.github/workflows/deploy.yml` (adapted from asteroid-sats's deploy.yml, only the controller-ws rsync + restart steps).
- Add `HETZNER_SSH_KEY` secret to the joystick repo (same value as asteroid-sats's).
- Workflow-dispatch a deploy from the joystick repo. Verify broker still works (curl WS endpoint, smoke-test pair on Pallasite production).
- PR on asteroid-sats: remove controller-ws rsync + restart steps from `deploy.yml`, leave a `# broker source moved to forgesworn/joystick` comment in `controller-ws/README.md`. **Do not delete `controller-ws/` yet** — keep it for a one-week transition window as the rollback path.
- Update `docs/600b-caddy.snippet` to mention the new source location for the Caddyfile snippet.

**Open question for this stage:** does the very first commit include empty skeletons for `protocol/`, `host/`, `mobile/`, `nostr/`, or just `broker/` plus a `ROADMAP.md` placeholder? My current preference is **just broker + ROADMAP**. Empty packages can't be depended on so the skeleton is theatre; placeholder doc keeps the intent visible without the rot. Decision needed.

**Risk: low-medium.** Production behaviour identical (same rsync, same VPS path, same systemd unit, same WS endpoint). The CI cutover is the real one-time work; verify before removing the asteroid-sats deploy step.

### Stage 2 (later), protocol package

- Lift `controller-types.ts` into `packages/protocol`.
- Move `docs/joystick-protocol.md` to `docs/protocol.md` in the joystick repo.
- Add the no-Nostr-in-host CI invariant.
- Workspace path import; npm publish once the package is stable (could be while still private if scope is taken; npm packages can be public even when source repo is private).
- Asteroid-sats imports the package via workspace ref or git URL initially; npm dep after publish.
- Old `controller-types.ts` becomes a re-export shim, then deleted.

**Risk: medium.** Touches type imports across asteroid-sats. Type-only, caught at typecheck.

### Stage 3 (post-FUCHS2 only), mobile SDK

- Lift `controller-mobile.ts` + phone-side joystick from `ui.ts:5485-5980` into `packages/mobile`.
- Asteroid-sats's `/controller` route consumes the package.

**Risk: medium-high.** `ui.ts` is large; joystick code is entangled with name-entry, layout switching, audio unlock. **Do not start before June 12 2026.**

### Stage 4 (post-FUCHS2 only), host SDK

- Refactor `controller-host.ts` to be game-agnostic; accept input callbacks instead of importing `tryHyperspace` / `tryActivateShield` directly.
- Lift the refactored generic version into `packages/host`.
- Asteroid-sats becomes a consumer with a thin adapter.

**Risk: high.** Behavioural refactor. Easy to regress input latency or state-machine timing. Sequence after Stages 2 and 3.

### Stage 5a (post-FUCHS2), public flip + self-host

- Repo goes public.
- Polish README, examples, self-host docs.
- Docker image for the broker; one-command bring-up.
- Drop into awesome-lists, set GitHub topics, Show HN at 1.0.

### Stage 5b (later), free tier broker

- Hosted broker at `broker.forgesworn.dev`. Account-required (token or pubkey), quota-gated.
- Hosted phone PWA at `pad.forgesworn.dev`.
- Sign-up flow (email magic-link + Nostr pubkey).
- Abuse policy + monitoring.

### Stage 5c (much later), paid tiers

- Billing integration (Lightning + Stripe).
- Dashboard for accounts.
- Higher quotas, custom subdomains, SLA.

### Stage 6 (later), Nostr addons package

- `withNostrAuth`, manifest publishing, score publishing, override sync.
- Asteroid-sats migrates from inline auth wiring to using this package.

### Stage 7 (much later), engine plugins

- Unity asset, Godot addon. Whichever shows demand first.

## Names and brand

| Item | Choice | Note |
|------|--------|------|
| Repo | `forgesworn/joystick` | public after the June 11 2026 gate |
| npm org | `@forgesworn/joystick-*` (proposed) | requires claiming `@forgesworn` on npm |
| Hosted PWA | `pad.forgesworn.dev` | "pad" reads as "controller" |
| Hosted broker | `broker.forgesworn.dev` | |
| Spec | "Joystick Protocol v1.0" | versioned in wire `pair` message |
| SDK CDN | jsDelivr / unpkg of npm packages | no bespoke CDN |

## Licence

MIT, mirroring signet-login. Same rationale for the post-flip era: zero friction for adoption.

## Stage 1 sign-off needed

1. **Skeleton scope in commit 1.** Just `broker/` + `ROADMAP.md` placeholder, or full 5-package skeleton? (My preference: just broker.)
2. **OK to add `HETZNER_SSH_KEY` to the joystick repo as a secret** (same value as asteroid-sats's)? Required for the deploy workflow to run from there.
3. **Transition window length for keeping `controller-ws/` in asteroid-sats** as a rollback path? My default: one week.
4. **Anything else to add, cut, or change before Stage 1 begins?**
