# Pallasite — Story Arc

**Status:** draft v0.1
**Purpose:** the connective tissue between the 25 named waves. Turns a museum catalogue into a hero quest. Drives intertitle copy, game-over copy, completion mark, and 600bn canon.

**What this does not change:** wave names (the meteorites), factual subtitles (Meteoritical Bulletin data), tactical taglines (already tied to gameplay beats). Those are load-bearing and stay.

---

## 1. Premise

The pallasites are not loot. They are **witness stones**. Each one fell at a place where a beacon went silent. The chain of falls is the trail of a vanished forge, drawing the player inward. By the time you understand what you have been hunting, it is already hunting you.

You are following the chain back to the source.

## 2. Protagonist and stake

You signed the salvage contract because the sats were good. You stay because by Wave 4 you realise the falls are aimed. By Wave 12 you realise the line bends toward you. By Wave 25 you find out what was being silenced, and who.

The stake is encoded in an existing mechanic: **the chain pays in sats**. You can bank what you carry between waves and walk away with a known amount, or you can press on and risk it. The longer the chain, the more you are owed, and the less the field will let you keep.

That choice is the trial. It is already in the game. The arc just names it.

## 3. The three acts

The 25 waves fold into three acts plus the gate.

| Act | Waves | Title | Posture | What changes |
|---|---|---|---|---|
| I | 1 – 8 | The Outer Drift | Naïve scavenger | The falls stop being random |
| II | 9 – 16 | The Reclassification | Suspect, then committed | The chain reveals it is a spiral |
| III | 17 – 24 | The Anomalous Run | Hunted | The line draws toward you |
| Boss | 25 | Event Horizon | Witness | You meet the maker |

### 3.1 Act I — The Outer Drift (W1 – W8)

Easy chain. Long lanes. You believe the falls are random and the work is salvage.

Key beats (existing wave taglines drive these; copy below is the arc gloss, not a tagline rewrite):

- **W1 Krasnojarsk** — first contract. You are raw. The contract pays per stone.
- **W4 Fukang** — the 1,003 kg main mass. Elite UFOs arrive. The chain is rich enough that the field has competition. *First crack in the story you told yourself.*
- **W7 Zaisho** — tanks. Kit upgrades because the threat upgrades. You earn the upgrade by surviving.
- **W8 Marjalahti** — mines arm. The field begins laying mines for you. *End of Act I.*

**Closing image:** you came to mine the salvage line. Someone is now mining the line.

### 3.2 Act II — The Reclassification (W9 – W16)

Bonus level (between W9 → W10) is the turning point. You find a specimen that was not on the list. It carries something.

- **W9 Omolon** — *Breather. Bank the chain.* The system offers the exit. Take it and you walk away with a known number. Refuse it and you stay in the story.
- **Bonus wave** — the unlisted specimen. It carries a name you knew. (Copy hook: tie to streak, recent zappers, or "the one before you who did not come back". Procedural.)
- **W10 Springwater** — snipers calibrate. Someone is reading your trajectories now.
- **W12 Seymchan** — *reclassified iron to pallasite.* The central twist. Things you thought were dead are still ringing. The chain is not a chain. It is a spiral.
- **W16 Itzawisis** — Eagle Station group. Named territory. The 600bn Council canon docks here (see §8).

**Closing image:** the catalogue is wrong. The forge is still speaking. You stopped being the hunter several waves ago.

### 3.3 Act III — The Anomalous Run (W17 – W24)

Specimens are older, weirder. Subtitles repeatedly say *anomalous*. The line draws inward.

- **W17 Eagle Station** — type specimen. Past halfway. Lanes thin.
- **W20 Conception Jct** — *anomalous main group.* Five wells. The pattern is no longer a pattern.
- **W22 Phillips County** — *anomalous main group.* "Trust no orbit." The map fails.
- **W23 Admire** — strewn field, two tonnes. The biggest haul of the act, sat in the middle of the storm.
- **W24 Hambleton** — sulphide-rich, North Yorkshire. The last quiet specimen. You hear it. (A British wave naturally lands the moment of recognition.)

**Closing image:** the silence that was hunting you was not an enemy. It was a question, asked very slowly.

### 3.4 Event Horizon (W25)

The source. The forge is not a weapon. It is a singer that was forced to forge.

The boss is not an enemy in the genre sense. It is a gatekeeper. Beat it and you earn the choice:

- **Return** — carry the chain home. Warn the others. Bank the run.
- **Step through** — keep the chain. Become one of the makers. The next run knows your name.

Mechanically: the chosen ending writes a **Pallasite Mark** to the player's Nostr profile (see §7). Cosmetic and narrative. No power.

## 4. Intertitles

Four story cards, two lines each, on a black hold. Shown once per beat. Skippable.

| Slot | When | Card |
|---|---|---|
| I | Before W1 wavestart | *The contract pays per stone.*<br>*The chain pays only if you finish it.* |
| II | After the W9→W10 bonus | *That one was not on the list.*<br>*Someone is placing them.* |
| III | Before W17 wavestart | *Past halfway. The catalogue grows anomalous.*<br>*You are no longer the one reading it.* |
| IV | Before W25 wavestart | *The line ends here.*<br>*Stand or fall. Then choose.* |

Voice: sharp, sovereign, wry, cold (per brand-identity.md §3). Verb-noun, no fluff, no exclamation marks.

## 5. Game-over arc lines

Current: "WAVE N · score". Add a single line of arc-aware copy below the score, keyed off the act in which the player fell.

| Act | Pattern | Example |
|---|---|---|
| I | "You fell at <NAME>, the contract unfilled." | *You fell at Fukang, the contract unfilled.* |
| II | "You fell at <NAME>. The catalogue holds your line for the next hunter." | *You fell at Seymchan. The catalogue holds your line for the next hunter.* |
| III | "You fell at <NAME>, within sight of the gate." | *You fell at Admire, within sight of the gate.* |
| Boss | "You fell at the horizon. The forge sang on." | *You fell at the horizon. The forge sang on.* |

Beating W25 replaces this with the completion screen (§7).

## 6. Completion and mark

First W25 clear:

1. **Completion screen** plays the chosen ending (Return / Step Through) as a five-second hold with two lines of copy, then rolls credits.
2. **Pallasite Mark** is written. Design is **zero-trust**: no authority issues the Mark. The player self-publishes a claim; consumers verify it independently against public, deterministic data. The faucet is not in the trust path.
   - **Claim layer — self-published NIP-85 assertion** (kind 30382, signed by the player's own master). Carries `pallasite-mark: "return" | "forged"` and `run_id` (the kind 30764 replay event id). This is a *claim*, not proof. It is the discovery and indexing layer.
   - **Proof layer — deterministic re-simulation.** A verifier fetches the `run_id` replay, runs the headless sim, and confirms it reaches W25 with the claimed ending. The engine is already deterministic (seeded `gameRng`, "replays remain bit-identical"), so the same inputs reproduce the same run. Verdict is reproducible by anyone; nobody is trusted.
   - **NIP-58 badge** — optional cosmetic mirror for clients that render badges. Marked *unverified* unless the rendering client also re-simulates. Not a proof.

   See §7 and the prerequisite in §10.
3. **Attract welcome** reads the mark on next visit. Three tiers:
   - No mark: *Welcome, scavenger.*
   - Returned: *Welcome back. The chain is shorter than you remember.*
   - Forged: *Welcome back, forgesworn.*

Posture: the NIP-85 assertion is the *index* (cheap to read, tells you a claim exists). The replay re-simulation is the *proof* (anyone can run it, trusts nobody). The game shows a Mark as "claimed" on sight and upgrades it to "verified" after a background re-sim, then caches the verdict.

## 7. Reputation web — Mark, NIP-85, jury, veil

The Mark is not a trophy that sits in isolation. It is the entry point to a reputation web that already exists in the codebase. The arc's narrative loop closes when the player joins the community of judges.

```
W25 clear  ──>  Mark (NIP-85 assertion)  ──>  jury eligibility  ──>  anonymous veil ballot
                       │
                       └─>  NIP-58 badge mirror (for clients that render badges)
```

Pieces, in dependency order:

1. **Player self-publishes NIP-85.** On W25 clear, the player's client publishes a kind 30382 assertion signed by the player's own master: `{ pallasite_mark: "return" | "forged", at_wave: 25, run_id: <replay-event-id> }`. No faucet signature. The assertion is a claim and an index entry, nothing more.
2. **Proof is re-simulation.** Any consumer (the game reading another player's Mark, a jury-eligibility check, an outside auditor) verifies by fetching the `run_id` replay and re-running it headless. See §10 for the prerequisite: the current kind 30764 replay is a world-state frame stream, which is forgeable. Zero-trust verification needs an input-log replay (seed + per-frame inputs) so the run can be reproduced rather than merely played back.
3. **Badge mirror.** Optionally the client also self-issues a NIP-58 kind 8 award against a game-published kind 30009 definition for clients that render badges. Cosmetic only. Since it is self-issued it carries no trust weight; it is a display convenience, not evidence.
4. **Jury eligibility = Mark + N badges.** `src/jury.ts` already requires ≥3 NIP-58 badges on the master pubkey for jury eligibility. **Decision:** the Pallasite Mark counts as *one* qualifying credential toward the threshold, not a mandatory gate. Reason: FUCHS2 is weeks out (11 June 2026) with a near-zero population of W25 clearers; a mandatory Mark would empty the jury. Revisit a forgesworn-only jury once a population exists.
5. **Veil ballots.** kind 31766 LSAG-signed contributions to flagged-player review cases. Anonymous within the eligible ring. Already wired in jury.ts. Blocked on **task #60 (phase 2c deploy)**. Shipping phase 2c is what brings this live.

Narrative payoff: the arc says "step through the gate and become one of the makers". The mechanic that backs that promise is: forgesworn players judge the next generation, and the proof they earned it is something anyone can re-run for themselves. The Mark is not flavour, it is access, and it answers to no authority.

## 8. How 600bn fits

The 600bn flavour is a side chapter, not a parallel game. Canonically:

- The Council of 600 is one of the **guilds of survivors** from an Act II fall.
- They held the Eagle Station group (W16 – W17 territory) before scattering.
- The Sacred Stone is one of the unlisted specimens — the kind the bonus level surfaces.
- The Sanctum encounter is a *single fall in their history*, replayed for the visiting party.

Nothing in the main-app code changes. The 600bn title screen, lore, Sanctum encounter, and FUCHS2 framing remain as they are. This document just makes the canon coherent so future copy does not contradict itself.

## 9. Implementation hooks

Code touch-points if and when we wire the arc into the game. Listed for scoping, not prescribing order.

### 9.1 Slice A — arc and intertitles (client, smallest change, biggest narrative lift)

| Hook | File | Change |
|---|---|---|
| Act helper | `src/types.ts` | `waveAct(wave): 1 \| 2 \| 3 \| 'boss'` derived from wave index. No data churn on `WAVE_LORE`. |
| Intertitle records | `src/types.ts` | New `ACT_INTROS` with the four cards from §4 and the trigger wave set `{1, 10, 17, 25}`. |
| Intertitle render | `src/render.ts` | New `drawIntertitle`; black hold, two lines, fade. Drawn during an extended wavestart on trigger waves, before the normal wave banner. |
| Wavestart extension | `src/game.ts` `beginWave` | Add intertitle hold to `wavestartMs` on trigger waves. Existing `skipWaveStart` already cuts it short on input. |
| Game-over arc line | `src/ui.ts` game-over screen | Read `waveAct(wave)`, render line from §5 below the score. |

### 9.2 Slice B — completion and Mark (client, zero-trust, later)

| Hook | File | Change |
|---|---|---|
| Completion ending | `src/ui.ts` | New screen between W25 clear and credits. Two ending variants; choice persists to the Mark. |
| Mark publish | new `src/mark.ts` | Self-sign a kind 30382 NIP-85 assertion with the player's master: `pallasite-mark` + `run_id`. No faucet. |
| Mark verify | `src/mark.ts` | Fetch the `run_id` replay, headless re-sim, confirm W25 + ending. Cache the verdict. Depends on §10 prerequisite. |
| Mark read | `src/mark.ts` | Query kind 30382 by author pubkey. Show "claimed" on sight, "verified" after re-sim. |
| Attract welcome tiering | `src/ui.ts` attract panel | Read verified Mark via `src/mark.ts`; pick welcome variant from §6. |

### 9.3 Faucet (separate repo)

The faucet is **not** in the Mark trust path. The only faucet-side item is:

| Hook | Change |
|---|---|
| Phase 2c deploy (task #60) | Ships the jury / veil code already written and waiting. Required for veil ballots to go live. Independent of the arc; can ship any time. |

Estimated effort: Slice A is a long weekend, mostly copy plus one render function. Slice B depends on the §10 replay prerequisite and is the larger build.

## 10. Open questions

- **PREREQUISITE — input-log replay for zero-trust verification.** The Mark design in §6/§7 is zero-trust: proof is re-simulation of the run. But the current kind 30764 replay is a *world-state frame stream* (`ReplayFrameRaw[]` in `src/stream-session.ts`), which is trivially forgeable — anyone can author a frame stream that ends at W25. Re-simulation needs a deterministic *input-log* replay: the `gameRng` seed plus the per-frame input log, from which the run reproduces bit-identically (the engine already claims "replays remain bit-identical"). This is a real piece of work and a hard dependency for Slice B. Options: (a) add an input-log track alongside the existing frame stream in the 30764 bundle; (b) a new event kind for the input log; (c) accept a weaker trust model for the Mark and revisit. Slice A (arc + intertitles) has no such dependency and can ship first. Full scope, design and effort estimate: `docs/b3-verifiable-replay.md`.
- **Bonus-level integration.** §4 says "after the W9→W10 bonus". Bonus is probabilistic per `bonus_wave_chance`. If the player never sees it, the Act II intertitle still needs to fire. Resolved for Slice A: trigger on first wave-start at W = 10 regardless of whether the bonus fired. Revisit a guaranteed-once-per-run bonus separately.
- **Mark visibility for guests.** Guest signers can publish kind 0 / kind 8. The mark works for them too, but only on devices that hold their nsec. We already export nsec (task #130). Acceptable.
- **Replay framing.** Recorded replays loaded from kind 30764 should show the arc-aware game-over too (the wave is on the wire). Watch page should respect intertitle skips by default (no hold during replay) so theatre flows.
- **Difficulty pressure.** The narrative says "the line draws toward you" through Act III. If the gameplay does not match (e.g. W19 feels easier than W14), the story collapses. Audit the late-wave tuning against `bonus_wave_chance`, UFO cadence, and asteroid density once the arc is wired.
