# ui.ts modularisation — design spec

- **Date:** 2026-06-16
- **Status:** approved (design); pending implementation plan
- **Scope:** `src/ui.ts` only. `src/render.ts` is a deliberate follow-on (separate spec, same pattern).

## Context

`src/ui.ts` is 14,979 lines spanning ~18 distinct concerns (title, attract, auth,
onboarding, booth wizard, phone-as-controller, replay theatre, live theatre, watch
page, moderation/jury, music player, settings, game-over/completion, duel lobby,
toast, leaderboard pickers). It exports 44 symbols, all consumed by `main.ts`
(which is the sole orchestrator). Nothing imports back into `ui.ts`, and there are
no circular dependencies between `ui.ts` and `render.ts` (`ui.ts` imports
`render.ts`, never the reverse).

The file's size is the project's single largest maintainability drag. Splitting it
makes the subsequent graphics and tooling workstreams (which edit code that lives
inside it and inside `render.ts`) materially easier.

## Goals

- Break `ui.ts` into ~16 focused modules under `src/ui/`, each owning one concern.
- **Zero behaviour change.** The running game is byte-for-byte equivalent in
  behaviour before and after.
- `main.ts` is untouched: its `from './ui'` imports continue to resolve.
- Every step independently verifiable and bisectable.

## Non-goals

- No logic changes, no renaming of symbols, no dead-code removal, no helper
  de-duplication. Smells spotted en route are logged in §10, not fixed here.
- No changes to `render.ts`, `game.ts`, `main.ts`, or any netcode.
- No new abstractions (no router, no component framework). This is extraction, not
  redesign.

## Decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Scope | `ui.ts` only; `render.ts` is a follow-on spec reusing this pattern |
| Philosophy | Strict behaviour-preserving extraction — pure code moves |
| End-state | Folder + barrel: `src/ui/*.ts` modules, `src/ui/index.ts` re-exports |
| Verification | `tsc` after every step + targeted E2E per screen + full sweep at milestones; green baseline first |

## End-state structure

```
src/ui/
  index.ts        barrel — re-exports the 44 public symbols. main.ts keeps `from './ui'`.
  core.ts         bindActions, callback registry, clearOverlay, shared DOM helpers
  onboarding.ts
  title.ts
  auth.ts
  pickers.ts
  pause.ts
  settings.ts
  post-run.ts
  music-player.ts
  replay-theatre.ts
  moderation.ts
  duel.ts
  booth.ts
  controller.ts
  live-theatre.ts
  watch.ts
```

`from './ui'` resolves to `src/ui/index.ts`, so `main.ts`'s import block never
changes. The barrel may be retired in a later, separate change if direct imports
are ever preferred — out of scope here.

## Module decomposition

Public-export ownership (the contract the barrel must preserve). Line boundaries
are finalised in the implementation plan; clusters and ranges below come from the
structural survey of the current file.

| Module | Public exports owned | Approx. source range | Risk |
|---|---|---|---|
| `core.ts` | `bindActions`, `clearOverlay`, `simulateStart`, start-callback registry, shared DOM helpers | 118–355 (+ residual) | hub |
| `onboarding.ts` | `renderOnboarding`, `gateBehindOnboarding` | 463–617 | easy |
| `title.ts` | `renderTitle`, `renderAttract`, `showUpdateBanner` (+ download panel, QWERTY name input) | 1049–2490 | moderate |
| `auth.ts` | `renderAuth`, `renderSignerRecovery`, `renderEventLobby` | ~141, ~1534–1575, ~2493–2870 | moderate |
| `pickers.ts` | mode/difficulty/daily/balance/withdraw rows, streak & daily chips | 2900–3650 | moderate |
| `pause.ts` | `renderPause`, `renderHowToPlay` | 9452–9602 | easy |
| `settings.ts` | `renderSettings`, `renderRelaySettings`, skins panel | 9591–10850 | moderate |
| `post-run.ts` | `renderGameOver`, `renderCompletion`, `getPallasiteMark` | 10851–12663 | moderate |
| `music-player.ts` | `renderMusicPlayer` | 8933–9450 | easy |
| `replay-theatre.ts` | `renderReplayTheatre` | 3652–4110 | easy |
| `moderation.ts` | `renderAdminPanel`, `renderAdminV2Panel`, `renderJuryPage` | 5301–5312, 6748–7310, 13717–14233 (v2 panel) | easy |
| `duel.ts` | `renderDuelLobby`, `renderToast`, `renderDuelConnecting`, `renderGamepadTestPage` | ~234, ~275, 13681–13716, 14234–14979 | moderate |
| `booth.ts` | `renderBoothLobby`, `startBoothJoinWizard`, `boothPilotSessionWasClaimed` | 1711–2215 | hard |
| `controller.ts` | `renderControllerPage`, `renderControllerHostPairing`, `hasActiveControllerHost`, `disconnectActiveControllerHost` | 5315–6740 | hard |
| `live-theatre.ts` | `renderLiveTheatre`, `LiveAsteroid`/`LiveUfo`/`LiveMine`/`LiveBullet`/`LiveCoin`/`LivePowerup`/`LiveEventCode`/`LiveSfxEvent`/`LiveFrame` | 3890–5310 | hard |
| `watch.ts` | `renderWatchPage`, `makeMiniLiveTile` (internal) | 7314–8565 | hard |

Several screens are interleaved in the file's tail (13681–14979): `renderToast`
and `renderDuelLobby` → `duel.ts`, `renderAdminV2Panel` → `moderation.ts`. The plan
separates them by symbol, not by contiguous range. Any small top-level screen not
explicitly named above is assigned to its nearest owning module during planning
(cross-cutting → `core.ts`). The plan must account for all 44 exports; none may be
dropped — a final diff of `index.ts`'s export surface against the pre-refactor list
must match exactly.

## Shared-state strategy

The current file has 14 mutable module-scope variables. The survey shows most are
**cluster-local** and move with their owning module:

- `boothWizard`, `boothPilotSessionClaimed`, `boothAudioPrimed`, `boothGateRaf`,
  `boothGateKeyup` → `booth.ts`
- `activeControllerHost` → `controller.ts`
- `watchActiveUnsubscribe`, `watchActiveMiniTeardown`, `watchActiveZapTeardown`,
  `titleNamePickerGetName` → `watch.ts`
- `lastSoloScorePublishedRun` → `post-run.ts`

Genuinely cross-cutting state stays in `core.ts` and is imported where needed:

- start-callback registry: `onStartCb`, `onResumeCb`, `onStartCouchCb` (set by
  `bindActions`, read by title/auth/booth flows) — exposed via small accessor
  functions so call sites do not reach into another module's mutable binding.
- `clearOverlay` (20+ internal call sites across clusters) lives in `core.ts`;
  every screen imports it.
- LN-address storage helpers (`getStoredLnAddress`/`setStoredLnAddress`, defined
  ~11219 but used by both the withdraw flow in `pickers.ts` and the completion flow
  in `post-run.ts`) are internal — not in `main.ts`'s import set. To keep them
  single-defined they live in `core.ts` and both consumers import them.

`core.ts` imports from no sibling module, so the dependency graph stays acyclic.
Where one screen opens another (`renderTitle` → `renderBoothLobby`,
`renderWatchPage` → `renderLiveTheatre`, `renderSettings` → `renderRelaySettings`),
that is a one-directional cluster→cluster import; `tsc`/Vite will surface any
accidental cycle introduced during extraction.

### Window hooks (test contract)

The three `window.__pallasite*` hooks must survive verbatim — the E2E suite reads
them:

- `__pallasiteExitMultiplayerSession`
- `__pallasiteFit`
- `__pallasiteState`

They move with the code that currently attaches them; the attachment is not
rewritten.

## Migration mechanics

1. **Step A — relocate, no split.** `git mv src/ui.ts src/ui/index.ts`. Fix that
   file's own relative-import depth (`./render` → `../render`, etc.). It remains one
   large file, merely moved; `main.ts` is untouched because `from './ui'` now
   resolves to `src/ui/index.ts`. Verify green. This makes the entire operation
   reversible before any real splitting begins.
2. **Steps B…N — extract one cluster per step.** Lift a cluster into
   `src/ui/<name>.ts`; have `index.ts` import the symbols it still needs internally
   and re-export the cluster's public symbols. Move the cluster's own module-level
   state with it. Verify after each step.
3. **Final — drain `core.ts`.** Move residual shared helpers and the callback
   registry into `core.ts`, leaving `index.ts` as a near-pure barrel.

Each step is a single commit (`refactor: extract <cluster> from ui.ts`), so history
bisects cleanly.

## Extraction order (leaf-first, easy → hard)

1. Relocate (Step A).
2. Easy leaves: `pause`, `music-player`, `onboarding`, `replay-theatre`,
   `moderation`, `pickers`.
3. Moderate: `settings`, `post-run`, `auth`, `title`, `duel`.
4. Hard (lifecycle/closure-heavy): `booth`, `controller`, `live-theatre`, `watch`.
5. Drain `core.ts`; finalise the barrel.

Doing the hard, teardown-heavy clusters last means the extraction pattern is
well-worn before we touch the subscription/cleanup dances most prone to leaking
sockets or RAF handles.

## Verification

Toolchain (from `package.json`): `pnpm typecheck` (`tsc --noEmit`), `pnpm build`
(runs `tsc --noEmit` then `vite build`), and `tsx`-driven E2E tools.

- **Baseline (before touching anything):** run and record green —
  `pnpm typecheck`, `pnpm build`, and a full E2E sweep (`pnpm test`,
  `pnpm test:e2e`, `pnpm test:lobby`, `pnpm test:render`, `pnpm test:music`,
  `pnpm test:booth:join`, `pnpm test:booth:link`, `pnpm test:booth:display`,
  `pnpm test:coop-campaign`, `pnpm test:spectate-latejoin`,
  `pnpm test:deathmatch:nplayer`). If any is flaky/red at baseline, it is
  documented and excluded from the oracle rather than treated as a regression.
- **Every step:** `pnpm typecheck` (always) plus the targeted tool(s) for the
  screen just moved (mapping below).
- **Milestones (end of each tier in the extraction order):** full E2E sweep.

### Module → targeted test mapping

| Module(s) | Targeted command(s) |
|---|---|
| `title`, `auth`, `onboarding`, `pickers`, `post-run`, `pause` | `pnpm test:e2e`, `pnpm test:lobby` |
| `settings` | `pnpm test:render`, `pnpm test:e2e` |
| `music-player` | `pnpm test:music` |
| `booth` | `pnpm test:booth:join`, `pnpm test:booth:link`, `pnpm test:booth:display` |
| `live-theatre`, `watch` | `pnpm test:spectate-latejoin` (+ manual smoke of watch/live) |
| `duel` | `pnpm test:deathmatch:nplayer` |
| `replay-theatre` | `pnpm test:e2e` (death-replay path) + manual smoke |
| `moderation` | token-gated, no E2E → `pnpm typecheck` + manual smoke |

## Risks & mitigations

- **Closure/lifecycle leakage in hard clusters** (watch subscriptions, controller
  QR-scanner stream, booth gate RAF/keyup handlers, warp/live transient state):
  extract these last; preserve teardown paths exactly; assert no leaked handles via
  the targeted E2E and manual smoke before moving on.
- **Accidental import cycles** between screen modules: caught by `tsc`/Vite; keep
  `core.ts` sibling-import-free.
- **Missed export:** the plan enumerates all 44 exports against modules; a final
  diff of `index.ts`'s export surface against the pre-refactor export list must
  match exactly.
- **Baseline flakiness** masking a real regression: establish and record the green
  baseline first; quarantine known-flaky tools explicitly.

## Deferred (smells logged, not fixed here)

To be appended during implementation as smells surface. Initial candidates noted
in the survey:

- Large within-cluster screens that could split further later (`renderSettings`
  ~1000 lines, `renderWatchPage` ~800 lines, `renderCompletion` path ~640 lines).
- Possible duplicate small DOM helpers across clusters (de-dupe is a later pass).

## Follow-on

- `render.ts` modularisation: separate spec, identical folder+barrel pattern and
  strict behaviour-preserving philosophy. `render.ts` has 26 module-level mutables
  (≈19 are cluster-local caches) and a `~900`-line `render()` orchestrator that
  stays intact as the coordination hub.
