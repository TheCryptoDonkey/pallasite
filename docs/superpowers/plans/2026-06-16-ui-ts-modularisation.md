# ui.ts Modularisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/ui.ts` (14,979 lines) into ~16 focused modules under `src/ui/` with zero behaviour change, keeping `main.ts` untouched via a barrel.

**Architecture:** Folder + barrel. Implementation moves into `src/ui/*.ts`; `src/ui/index.ts` re-exports the same public surface so `import … from './ui'` keeps resolving. Each cluster carries its own module-level state. Extraction is verbatim — no logic, naming, or dead-code changes.

**Tech Stack:** TypeScript 5.7 (ESM, `tsc --noEmit`), Vite 6, pnpm 9, Playwright/`tsx` E2E tools.

**Spec:** `docs/superpowers/specs/2026-06-16-ui-ts-modularisation-design.md`

---

## How to read this plan (read before Task 0)

This is a **pure-move refactor**. There is no new code to test-drive. The safety
model is:

- **`tsc --noEmit` is the structural oracle.** After every move it must stay green.
  A dangling reference (a moved function that still calls a private helper left
  behind, or vice versa) shows up here immediately. The fix is always "move the
  helper too" or "import it" — never "change the logic".
- **The E2E suite is the behaviour oracle.** It must stay as green as the recorded
  baseline. A red that was green at baseline means the move changed behaviour —
  stop and revert that step.
- **The export-surface snapshot is the contract oracle.** The set of names exported
  from `./ui` must be identical before and after. Captured in Task 2, re-checked at
  the end.

**"Show the code" convention for this plan:** moved function/screen bodies are
**existing source, transplanted verbatim** — they are identified by their public
symbol(s) and approximate line range, not re-pasted (re-pasting 1,400-line bodies
would invite transcription errors). Steps *do* show the genuinely new code: each
new file's import header, and the exact barrel lines added to `index.ts`.

**Per-extraction recipe (every Task 3–17 follows this):**
1. Confirm a clean working tree on the refactor branch.
2. Create `src/ui/<name>.ts` with the import header shown, then **cut** the named
   public symbol(s) and their exclusively-used private helpers and module-level
   state out of `src/ui/index.ts` and **paste** them verbatim into the new file.
   Mark the public ones `export`.
3. In `index.ts`, add a re-export line (`export { … } from './<name>';`) for the
   public symbols, and an `import { … } from './<name>';` for any symbol still used
   *inside* `index.ts`.
4. `pnpm typecheck` → must pass. If it fails with "cannot find name X", X is a
   shared helper: move it to `core.ts` (Task 18 drains the rest) or import it.
5. Run the module's targeted E2E command → must pass (compare to baseline).
6. Commit.

**Conventions:** British English. Commit format `type: description` (`refactor:`,
`chore:`, `docs:`). **No `Co-Authored-By` lines.** ESM throughout.

**Branch:** do all work on a dedicated branch, e.g. `refactor/ui-modularisation`.
Create it in Task 0.

---

## Task 0: Establish the green baseline

**Files:** none (records baseline; creates branch).

- [ ] **Step 1: Create the refactor branch**

Run:
```bash
cd /Users/darren/WebstormProjects/pallasite
git switch -c refactor/ui-modularisation
git status   # expect: clean tree, on refactor/ui-modularisation
```

- [ ] **Step 2: Type-check and build the current tree**

Run:
```bash
pnpm typecheck
pnpm build
```
Expected: both succeed with no errors. If `tsc` already errors on `main`, stop and
report — the baseline is not green and must be fixed first.

- [ ] **Step 3: Run the full E2E sweep and record results**

Run each and note PASS/FAIL/flaky:
```bash
pnpm test
pnpm test:e2e
pnpm test:lobby
pnpm test:render
pnpm test:music
pnpm test:booth:join
pnpm test:booth:link
pnpm test:booth:display
pnpm test:coop-campaign
pnpm test:spectate-latejoin
pnpm test:deathmatch:nplayer
```
Expected: record which pass. **Any tool red or flaky here is quarantined** — write
it into the spec's Deferred section and exclude it from the oracle. It is NOT a
regression when it stays red later.

- [ ] **Step 4: Write the baseline record**

Create `docs/superpowers/plans/ui-modularisation-baseline.md` listing each command
and its baseline result (PASS / quarantined-FLAKY). This is the reference the rest
of the plan compares against.

- [ ] **Step 5: Commit the baseline record**

```bash
git add docs/superpowers/plans/ui-modularisation-baseline.md
git commit -m "chore: record E2E baseline before ui.ts modularisation"
```

---

## Task 1: Relocate ui.ts → src/ui/index.ts (no split)

**Files:**
- Move: `src/ui.ts` → `src/ui/index.ts`
- Modify: relative imports inside the moved file (depth `+1`)

- [ ] **Step 1: Move the file with git**

Run:
```bash
mkdir -p src/ui
git mv src/ui.ts src/ui/index.ts
```

- [ ] **Step 2: Fix the moved file's own relative-import depth**

In `src/ui/index.ts`, every `from './x'` / `from './x.js'` that points at a sibling
in `src/` must become `from '../x'`. (e.g. `from './render'` → `from '../render'`,
`from './game.js'` → `from '../game.js'`, `from './auth.js'` → `from '../auth.js'`.)
Do not change imports of npm packages (`three`, `qrcode`, …). Let `tsc` find any
missed one in Step 3.

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck`
Expected: PASS. Any "Cannot find module './…'" is an import-depth miss from Step 2 —
fix it (`./` → `../`) and re-run until green.

- [ ] **Step 4: Confirm main.ts is untouched**

Run:
```bash
git diff --name-only HEAD   # expect: only src/ui.ts (deleted) + src/ui/index.ts (added)
grep -n "from './ui'" src/main.ts   # expect: still present, unchanged
```
`from './ui'` now resolves to `src/ui/index.ts`. `main.ts` is not modified.

- [ ] **Step 5: Full behaviour check**

Run:
```bash
pnpm build
pnpm test:e2e
```
Expected: PASS (matches baseline). The game is identical — one big file, relocated.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: relocate ui.ts to src/ui/index.ts ahead of split"
```

---

## Task 2: Snapshot the export surface (contract oracle)

**Files:**
- Create: `tools/dump-ui-exports.ts`

- [ ] **Step 1: Create the export-dumper tool**

Create `tools/dump-ui-exports.ts`:
```ts
// Prints the sorted set of runtime value-exports from src/ui.
// Type-only exports (interfaces) are guaranteed by `tsc`, not listed here.
import * as ui from '../src/ui/index.ts';

const names = Object.keys(ui).sort();
console.error(`ui exports ${names.length} value symbols`);
for (const n of names) console.log(n);
```

- [ ] **Step 2: Capture the "before" snapshot**

Run:
```bash
pnpm exec tsx tools/dump-ui-exports.ts > docs/superpowers/plans/ui-exports-before.txt
cat docs/superpowers/plans/ui-exports-before.txt | wc -l   # note the count
```
Expected: a sorted list of the value-exports (the render* functions, bindActions,
clearOverlay, getPallasiteMark, etc.). This file is the contract: Task 18 re-runs
the dumper and diffs against it.

- [ ] **Step 3: Commit the snapshot and tool**

```bash
git add tools/dump-ui-exports.ts docs/superpowers/plans/ui-exports-before.txt
git commit -m "chore: snapshot ui export surface for refactor contract check"
```

---

## Extraction tasks (3–17)

Each task follows the **per-extraction recipe** in the preamble. The new file's
import header is shown; pull in only what the moved code actually uses, letting
`tsc` flag anything missing or unused. The barrel edit is shown exactly. Tiers
match the spec's extraction order (easy → moderate → hard).

> After completing each tier (end of Task 8, Task 13, Task 17) run the **milestone
> full sweep** in Task M before continuing.

---

### Task 3: Extract `pause.ts` (easy)

**Files:**
- Create: `src/ui/pause.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderPause`, `renderHowToPlay` (approx. lines
9452–9602 of the pre-split file) plus any private helpers used only by them.

- [ ] **Step 1: Clean tree**

Run: `git status` → expect clean, on `refactor/ui-modularisation`.

- [ ] **Step 2: Create `src/ui/pause.ts` with header, move the symbols**

Header (adjust the imported names to what the moved bodies actually reference):
```ts
import { clearOverlay } from './index.ts'; // temporary; moves to './core.ts' in Task 18
import type { GameState } from '../types.js';
// add other imports the moved bodies use (audio, visual-style, etc.)
```
Cut `renderPause` and `renderHowToPlay` (and their private-only helpers) out of
`index.ts`, paste verbatim into `pause.ts`, keep the `export` keyword on the two
public ones.

- [ ] **Step 3: Re-export from the barrel**

In `src/ui/index.ts` add:
```ts
export { renderPause, renderHowToPlay } from './pause.ts';
```

- [ ] **Step 4: Type-check**

Run: `pnpm typecheck`
Expected: PASS. If "Cannot find name 'clearOverlay'" appears inside `pause.ts`,
confirm the Step 2 import line is present; if a helper is reported missing, move it
across too.

- [ ] **Step 5: Behaviour check (pause/help screens are on the campaign path)**

Run: `pnpm test:e2e`
Expected: PASS (matches baseline).

- [ ] **Step 6: Commit**

```bash
git add src/ui/pause.ts src/ui/index.ts
git commit -m "refactor: extract pause/how-to screens into src/ui/pause.ts"
```

---

### Task 4: Extract `music-player.ts` (easy)

**Files:**
- Create: `src/ui/music-player.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderMusicPlayer` (approx. lines 8933–9450) + private
helpers used only by it.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/music-player.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add music.js imports the body uses (track lists, playback control, preview)
```
Cut `renderMusicPlayer` + its private helpers from `index.ts`, paste verbatim.

- [ ] **Step 3: Barrel** — add to `index.ts`:
```ts
export { renderMusicPlayer } from './music-player.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:music` → PASS (baseline).

- [ ] **Step 6: Commit**
```bash
git add src/ui/music-player.ts src/ui/index.ts
git commit -m "refactor: extract music player into src/ui/music-player.ts"
```

---

### Task 5: Extract `onboarding.ts` (easy)

**Files:**
- Create: `src/ui/onboarding.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderOnboarding`, `gateBehindOnboarding` (approx.
463–617), plus the onboarding storage constant `ONBOARDING_KEY` and
`hasCompletedOnboarding()` helper if used only here.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/onboarding.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add imports the bodies use (visual-style, gamepads input-kind detection, etc.)
```
Cut the two screens + onboarding storage/helpers, paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderOnboarding, gateBehindOnboarding } from './onboarding.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` (first-run gate is on boot path)
→ PASS (baseline).

- [ ] **Step 6: Commit**
```bash
git add src/ui/onboarding.ts src/ui/index.ts
git commit -m "refactor: extract onboarding into src/ui/onboarding.ts"
```

---

### Task 6: Extract `replay-theatre.ts` (easy)

**Files:**
- Create: `src/ui/replay-theatre.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderReplayTheatre` and its `ReplayTheatreInput`
type (approx. 3652–4110) + private helpers used only here.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/replay-theatre.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import { render } from '../render.ts'; // playback draws via the renderer
// add types.js / ghost.js imports the body uses
```
Cut `renderReplayTheatre`, `ReplayTheatreInput`, and private helpers; paste
verbatim. Keep `export` on the public symbol and the input type.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderReplayTheatre } from './replay-theatre.ts';
export type { ReplayTheatreInput } from './replay-theatre.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` (death-replay path) → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/replay-theatre.ts src/ui/index.ts
git commit -m "refactor: extract replay theatre into src/ui/replay-theatre.ts"
```

---

### Task 7: Extract `moderation.ts` (easy)

**Files:**
- Create: `src/ui/moderation.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderAdminPanel`, `renderJuryPage`,
`renderAdminV2Panel` (approx. 6748–7310 and the v2 panel at 13717–14233), plus the
`shortPubkey`/`formatFlaggedAt` helpers and `ADMIN_TOKEN_KEY` if used only here.
Move `renderAdminV2Panel` **by symbol** — it is interleaved in the tail with
`renderToast`/`renderDuelLobby` (Task 11), so cut only the v2-panel body, not the
whole 13681–14979 range.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/moderation.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add faucet.js (fetchFlagged, requestDeleteFlag, adjustAdminPlayerBalance) and
// jury.js (submitVote, case fetch) imports the bodies use
```
Cut the three screens + their private helpers, paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderAdminPanel, renderJuryPage, renderAdminV2Panel } from './moderation.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — token-gated, no E2E. Run `pnpm build` and
manually smoke `/admin` and `/jury` in `pnpm dev` if convenient; otherwise rely on
`tsc`.

- [ ] **Step 6: Commit**
```bash
git add src/ui/moderation.ts src/ui/index.ts
git commit -m "refactor: extract admin/jury moderation into src/ui/moderation.ts"
```

---

### Task 8: Extract `pickers.ts` (easy/moderate)

**Files:**
- Create: `src/ui/pickers.ts`
- Modify: `src/ui/index.ts`

**Symbols to move:** the mode / difficulty / daily row pickers, balance chip,
withdraw dialog + error handler, streak chip, daily-leader chip (approx.
2900–3650). These are internal helpers (not in `main.ts`'s import set), so most
need no barrel re-export — only an `import` line in `index.ts` for any the barrel
file still references. Leave the `window.__pallasiteFit` / `__pallasiteExitMultiplayerSession`
**call sites** behaving exactly as before (the hooks themselves are attached
elsewhere; do not move the attachment here).

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/pickers.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add score.js, faucet.js, zap.js, difficulty.js, mode.js imports the bodies use
export {}; // module marker if no public exports remain
```
Cut the picker/balance/withdraw/streak helpers, paste verbatim. Export any symbol
that `index.ts` or another module still calls.

- [ ] **Step 3: Barrel** — add an `import { … } from './pickers.ts';` for whatever
`index.ts` still calls (e.g. the mode/difficulty rows used by `renderAuth` before
that moves in Task 10). No `export` line unless a moved symbol is in the 44.

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` + `pnpm test:lobby` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/pickers.ts src/ui/index.ts
git commit -m "refactor: extract mode/difficulty/withdraw pickers into src/ui/pickers.ts"
```

---

### Task M (milestone): full sweep after the easy tier

- [ ] **Step 1: Full type-check and build** — `pnpm typecheck && pnpm build` → PASS.

- [ ] **Step 2: Full E2E sweep** — run every command from Task 0 Step 3. Expected:
matches baseline (quarantined tools may stay red; nothing previously-green is red).

- [ ] **Step 3: If all green, tag progress (optional)**
```bash
git tag refactor/ui-easy-tier-done
```
Repeat this milestone after Task 13 and Task 17 (re-tag accordingly).

---

### Task 9: Extract `settings.ts` (moderate)

**Files:**
- Create: `src/ui/settings.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderSettings`, `renderRelaySettings` (approx.
9591–10850) + the skins panel and private helpers. `renderSettings` calls
`window.__pallasiteFit` — keep that call verbatim.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/settings.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add visual-style.js, a11y.js, parallax.js, radar.js, relays.js, music.js,
// gamepads.js, skins.js imports the bodies use
```
Cut both screens + skins panel + private helpers, paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderSettings, renderRelaySettings } from './settings.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:render` + `pnpm test:e2e` → PASS
(visual-style toggles drive the renderer, so `test:render` is the sharp check).

- [ ] **Step 6: Commit**
```bash
git add src/ui/settings.ts src/ui/index.ts
git commit -m "refactor: extract settings overlay into src/ui/settings.ts"
```

---

### Task 10: Extract `post-run.ts` (moderate)

**Files:**
- Create: `src/ui/post-run.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderGameOver`, `renderCompletion`, `getPallasiteMark`
(approx. 10851–12663) + private helpers and the module var `lastSoloScorePublishedRun`
and `publishSoloScoreForRun`. **Note:** `getPallasiteMark` is consumed by
`game.ts`, so it MUST stay re-exported from the barrel.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/post-run.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import { getStoredLnAddress, setStoredLnAddress } from './index.ts'; // → './core.ts' in Task 18
// add score.js, faucet.js, zap.js, social.js imports the bodies use
```
Cut the three public symbols + `lastSoloScorePublishedRun` + private helpers, paste
verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderGameOver, renderCompletion, getPallasiteMark } from './post-run.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS. (Verifies `game.ts`'s import
of `getPallasiteMark` still resolves through the barrel.)

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` (campaign reaches game-over and
completion) → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/post-run.ts src/ui/index.ts
git commit -m "refactor: extract game-over/completion into src/ui/post-run.ts"
```

---

### Task 11: Extract `auth.ts` (moderate)

**Files:**
- Create: `src/ui/auth.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderAuth`, `renderSignerRecovery`, `renderEventLobby`
(approx. 141, 1534–1575, 2493–2870) + the pool chip, guest-create flow, event-lobby
config helpers, and private helpers. Move by symbol.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/auth.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import * as auth from '../auth.js';
// add ghost.js, visual-style.js, score.js imports the bodies use; import any
// picker row from './pickers.ts' that renderAuth shows
```
Cut the three screens + helpers, paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderAuth, renderSignerRecovery, renderEventLobby } from './auth.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` + `pnpm test:lobby` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/auth.ts src/ui/index.ts
git commit -m "refactor: extract auth/onboarding flow screens into src/ui/auth.ts"
```

---

### Task 12: Extract `title.ts` (moderate)

**Files:**
- Create: `src/ui/title.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderTitle`, `renderAttract`, `showUpdateBanner`
(approx. 1049–2490, excluding the booth-lobby block which goes to Task 14 and the
auth block already moved in Task 11) + download panel, arcade-name rendering,
QWERTY name input, attract-phase state (`titleBgStartedAt`, phase rotation).
`renderTitle` calls `renderBoothLobby` (Task 14) and `renderAttract`; it references
`window.__pallasiteState` — keep that verbatim.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/title.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import { renderBoothLobby } from './index.ts'; // still in barrel until Task 14
// add ghost.js, music.js, skins.js imports the bodies use
```
Cut `renderTitle`, `renderAttract`, `showUpdateBanner`, name-input + attract state,
paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderTitle, renderAttract, showUpdateBanner } from './title.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:e2e` (boots through title/attract)
→ PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/title.ts src/ui/index.ts
git commit -m "refactor: extract title/attract screens into src/ui/title.ts"
```

---

### Task 13: Extract `duel.ts` (moderate)

**Files:**
- Create: `src/ui/duel.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderDuelLobby`, `renderToast`, `renderDuelConnecting`,
`renderGamepadTestPage` (approx. 234, 275, 13681–13716 toast, 14234–14979 duel
lobby). Move by symbol — `renderAdminV2Panel` between them already left in Task 7.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/duel.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add deathmatch.js, zap.js, qrcode imports the bodies use
```
Cut the four screens + private helpers, paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderDuelLobby, renderToast, renderDuelConnecting, renderGamepadTestPage } from './duel.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:deathmatch:nplayer` → PASS.

- [ ] **Step 6: Commit**
```bash
git add src/ui/duel.ts src/ui/index.ts
git commit -m "refactor: extract duel lobby/toast screens into src/ui/duel.ts"
```

- [ ] **Step 7: Milestone sweep** — run **Task M** (re-tag `refactor/ui-moderate-tier-done`).

---

### Task 14: Extract `booth.ts` (hard — gamepad state machine)

**Files:**
- Create: `src/ui/booth.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderBoothLobby`, `startBoothJoinWizard`,
`boothPilotSessionWasClaimed` (approx. 1711–2215) + ALL booth module state
(`boothWizard`, `boothPilotSessionClaimed`, `boothAudioPrimed`, `boothGateRaf`,
`boothGateKeyup`), the join-wizard polling, audio-prime gate, control legend, scheme
picker, and `PAD_SCHEME_OPTS`. The gate sets/clears RAF and keyup handlers — these
teardown paths must move intact.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/booth.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
// add gamepads.js, audio.js imports the bodies use
```
Cut the public symbols + the five booth state vars + all booth private helpers,
paste verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderBoothLobby, startBoothJoinWizard, boothPilotSessionWasClaimed } from './booth.ts';
```
`title.ts` (Task 12) imported `renderBoothLobby` from `./index.ts`; change that line
to `import { renderBoothLobby } from './booth.ts';`.

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check (the sharp one for teardown)**

Run:
```bash
pnpm test:booth:join
pnpm test:booth:link
pnpm test:booth:display
```
Expected: PASS (baseline). These exercise the gate RAF/keyup lifecycle — a leaked
handler or lost audio-prime shows up here.

- [ ] **Step 6: Commit**
```bash
git add src/ui/booth.ts src/ui/index.ts src/ui/title.ts
git commit -m "refactor: extract booth wizard into src/ui/booth.ts"
```

---

### Task 15: Extract `controller.ts` (hard — canvas input + stream lifecycle)

**Files:**
- Create: `src/ui/controller.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderControllerPage`, `renderControllerHostPairing`,
`hasActiveControllerHost`, `disconnectActiveControllerHost` (approx. 5315–6740) +
the `activeControllerHost` module var, QR pairing/scan code, joystick/D-pad/button
canvas wiring. The QR scanner opens a camera stream — its teardown must move intact.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/controller.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import jsQR from 'jsqr';
import QRCode from 'qrcode';
// add controller-host.js, controller-mobile.js, zap.js, profile.js imports used
```
Cut the four public symbols + `activeControllerHost` + private helpers, paste
verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderControllerPage, renderControllerHostPairing, hasActiveControllerHost, disconnectActiveControllerHost } from './controller.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — no dedicated E2E. Run `pnpm build`, then in
`pnpm dev` manually smoke: open the controller pairing page, pair, drive the
joystick, disconnect, and confirm the camera light goes off (stream teardown).
Rely on `tsc` for the structural guarantee.

- [ ] **Step 6: Commit**
```bash
git add src/ui/controller.ts src/ui/index.ts
git commit -m "refactor: extract phone-as-controller into src/ui/controller.ts"
```

---

### Task 16: Extract `live-theatre.ts` (hard — stream state machine)

**Files:**
- Create: `src/ui/live-theatre.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderLiveTheatre` and the `Live*` interfaces
(`LiveAsteroid`, `LiveUfo`, `LiveMine`, `LiveBullet`, `LiveCoin`, `LivePowerup`,
`LiveEventCode`, `LiveSfxEvent`, `LiveFrame`) (approx. 3890–5310) + the SFX state
machine, coin/powerup animation tracking, frame parsing, and WebSocket subscription
loop. The subscription cleanup must move intact. `theatre-adapter.ts` imports the
`Live*` types — they MUST stay re-exported.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/live-theatre.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import { render } from '../render.ts';
// add types.js, audio.js, music.js imports the bodies use
```
Cut `renderLiveTheatre`, the nine `Live*` interfaces, and private helpers, paste
verbatim.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderLiveTheatre } from './live-theatre.ts';
export type { LiveAsteroid, LiveUfo, LiveMine, LiveBullet, LiveCoin, LivePowerup, LiveEventCode, LiveSfxEvent, LiveFrame } from './live-theatre.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS. (Confirms `theatre-adapter.ts`
still resolves the `Live*` types through the barrel.)

- [ ] **Step 5: Behaviour check** — `pnpm test:spectate-latejoin` (live-stream
rendering path) → PASS, plus a manual smoke of a live theatre view in `pnpm dev`.

- [ ] **Step 6: Commit**
```bash
git add src/ui/live-theatre.ts src/ui/index.ts
git commit -m "refactor: extract live theatre into src/ui/live-theatre.ts"
```

---

### Task 17: Extract `watch.ts` (hard — subscription teardown)

**Files:**
- Create: `src/ui/watch.ts`
- Modify: `src/ui/index.ts`

**Public symbols to move:** `renderWatchPage` (approx. 7314–8565) + the internal
`makeMiniLiveTile`, the three teardown vars (`watchActiveUnsubscribe`,
`watchActiveMiniTeardown`, `watchActiveZapTeardown`), `titleNamePickerGetName`, the
recent-runs subscription loop, card rendering, zap UI, dismiss logic, and the
session/leaderboard mini-components. `renderWatchPage` opens `renderLiveTheatre`
(Task 16) on deep-link — import it from `./live-theatre.ts`. The teardown dance is
the highest-risk part of the whole refactor: every unsubscribe path must move
exactly.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/watch.ts`**

Header:
```ts
import { clearOverlay } from './index.ts'; // temporary; → './core.ts' in Task 18
import { renderLiveTheatre } from './live-theatre.ts';
// add watch.js, ghost.js, zap.js, score.js imports the bodies use
```
Cut `renderWatchPage`, `makeMiniLiveTile`, the three teardown vars,
`titleNamePickerGetName`, and private helpers, paste verbatim. Export
`makeMiniLiveTile` for any internal caller; it is not in the 44 barrel exports.

- [ ] **Step 3: Barrel** — add:
```ts
export { renderWatchPage } from './watch.ts';
```

- [ ] **Step 4: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 5: Behaviour check** — `pnpm test:spectate-latejoin` + manual smoke of
the watch grid (open it, watch a tile, navigate away, confirm sockets close — check
the network panel for closed WS). → PASS (baseline).

- [ ] **Step 6: Commit**
```bash
git add src/ui/watch.ts src/ui/index.ts
git commit -m "refactor: extract watch page into src/ui/watch.ts"
```

- [ ] **Step 7: Milestone sweep** — run **Task M** (re-tag `refactor/ui-hard-tier-done`).

---

## Task 18: Drain core.ts and finalise the barrel

**Files:**
- Create: `src/ui/core.ts`
- Modify: `src/ui/index.ts`, and every `src/ui/*.ts` that imports from `./index.ts`

**What remains in `index.ts` after Task 17:** `bindActions`, the start-callback
registry (`onStartCb`, `onResumeCb`, `onStartCouchCb`), `clearOverlay`,
`simulateStart`, the shared LN-address helpers (`getStoredLnAddress`,
`setStoredLnAddress`), shared DOM helpers, and the re-export lines.

- [ ] **Step 1: Clean tree** — `git status` clean.

- [ ] **Step 2: Create `src/ui/core.ts`**

Header:
```ts
import type { GameState } from '../types.js';
// add the few imports the moved helpers use
```
Move `bindActions`, the callback registry + their accessor functions, `clearOverlay`,
`simulateStart`, `getStoredLnAddress`, `setStoredLnAddress`, and the shared DOM
helpers out of `index.ts` into `core.ts`. Mark `export` the ones other modules use.

- [ ] **Step 3: Repoint the temporary imports**

In every `src/ui/*.ts` that has `import { clearOverlay } from './index.ts';` (and
the post-run LN-helper import), change `'./index.ts'` → `'./core.ts'`. Find them:
```bash
grep -rn "from './index.ts'" src/ui/
```
Expected after edits: no module imports from `./index.ts` except the barrel itself
re-exporting.

- [ ] **Step 4: Make `index.ts` a pure barrel**

`index.ts` now contains only re-export lines. Add the `core.ts` public surface:
```ts
export { bindActions, clearOverlay, simulateStart } from './core.ts';
```
(Plus any other `core.ts` symbol that is in the 44.)

- [ ] **Step 5: Type-check** — `pnpm typecheck` → PASS.

- [ ] **Step 6: Verify the export-surface contract**

Run:
```bash
pnpm exec tsx tools/dump-ui-exports.ts > docs/superpowers/plans/ui-exports-after.txt
diff docs/superpowers/plans/ui-exports-before.txt docs/superpowers/plans/ui-exports-after.txt
```
Expected: **no diff** — the value-export set is identical to the pre-split snapshot.
If the diff is non-empty, a symbol was dropped or renamed; fix before continuing.

- [ ] **Step 7: Full sweep** — run **Task M** Steps 1–2 (typecheck, build, full E2E).
Expected: matches baseline.

- [ ] **Step 8: Confirm main.ts never changed**

Run:
```bash
git diff --stat refactor/ui-modularisation~$(git rev-list --count HEAD ^$(git merge-base HEAD main)) -- src/main.ts 2>/dev/null || git log --oneline -- src/main.ts | head
```
Simpler check: `git log --oneline main..HEAD -- src/main.ts` → expected: **no
commits touched `src/main.ts`**.

- [ ] **Step 9: Commit**
```bash
git add src/ui/core.ts src/ui/index.ts src/ui/*.ts docs/superpowers/plans/ui-exports-after.txt
git commit -m "refactor: drain shared ui helpers into core.ts, finalise barrel"
```

---

## Task 19: Wrap up

- [ ] **Step 1: Confirm the file-size win**

Run:
```bash
wc -l src/ui/*.ts | sort -n
```
Expected: no single file near 15,000 lines; `index.ts` is a thin barrel; the largest
module is well under ~1,500 lines.

- [ ] **Step 2: Update the spec's Deferred section** with any smells logged en route
(oversized within-cluster screens, duplicate DOM helpers), then commit:
```bash
git add docs/superpowers/specs/2026-06-16-ui-ts-modularisation-design.md
git commit -m "docs: log deferred ui cleanups found during modularisation"
```

- [ ] **Step 3: Finish the branch** — use superpowers:finishing-a-development-branch
to decide merge/PR. Do NOT auto-merge; present options.

---

## Self-review (author's check against the spec)

- **Spec coverage:** scope (ui.ts only) ✓ Task 1+; strict behaviour-preserving ✓
  (every task is verbatim move + green gate, no logic steps); folder+barrel end-state
  ✓ Tasks 1/18; all 16 modules ✓ Tasks 3–18; shared-state strategy ✓ Tasks 14–18 +
  core drain; window hooks preserved ✓ called out in Tasks 8/9/12; verification
  (baseline, per-step tsc + targeted E2E, milestone sweeps) ✓ Tasks 0/M/each;
  export-surface contract ✓ Tasks 2/18; `getPallasiteMark`→game.ts and
  `Live*`→theatre-adapter and `renderBoothLobby`→title cross-consumers ✓ flagged in
  Tasks 10/16/14.
- **Placeholder scan:** no "TBD"/"add error handling"/"similar to Task N" — moved
  bodies are existing verbatim code referenced by symbol + range, deliberately not
  re-pasted (stated in the preamble).
- **Type consistency:** barrel re-export names match the spec's owned-exports table;
  temporary `./index.ts` imports are consistently repointed to `./core.ts` in Task 18.
