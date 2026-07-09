# Controller broker divergence — consolidation needed

**Status:** parked, to revisit. Written 2 Jul 2026 after tidying stale branches.
**Companion to:** [`../joystick-extraction-plan.md`](../joystick-extraction-plan.md) (the original staged extraction plan, 16 May 2026).

## TL;DR

The phone-controller WebSocket broker now exists as **two diverging copies** — one still live in pallasite, one in `forgesworn/joystick` — because the May extraction plan was executed only through its early, pre-event stages and never finished. The June 2026 joystick public-flip gate has now passed, so the deferred consolidation is due. We need to decide which repo owns the broker and reconcile the two copies. **No code action taken yet.**

## What the broker is

Tiny Node WebSocket service that pairs phone controllers with the big-screen game host (bypasses the higher-latency Nostr pub/sub path from the v1 phone-as-controller MVP). Serves **controller.pallasite.app**, deployed to the production Hetzner host.

## The two copies (as of 2 Jul 2026)

| | pallasite `controller-ws/` | joystick `packages/broker/` |
|---|---|---|
| In repo | pallasite `main` | forgesworn/joystick `main` |
| Deployed? | **Yes** — pallasite's `.github/workflows/deploy.yml` rsyncs it on every deploy | Has its own deploy path per the extraction plan |
| Last edited | **7 Jun 2026** | 5 Jun 2026 (`feat(broker): multi-slot peer ownership for linked-booth coop`) |
| File set | `server.js`, `Caddyfile.snippet`, `pallasite-controller-ws.service`, `package.json`, `README.md`, `pnpm-lock.yaml` | same set (`server.js`, `Caddyfile.snippet`, `pallasite-controller-ws.service`, `README.md`, `package.json`, `test/`) |

Same origin, now **diverged** — both edited independently in early June. Pallasite's copy is the *newer* of the two and is the one actually serving traffic.

## How we got here

The [joystick extraction plan](../joystick-extraction-plan.md) deliberately staged this:

- *"Pallasite keeps its own `/controller` route through the live-event gate."* — so pallasite's live copy was **meant** to stay and keep being edited up to that gate.
- *"Stage 1 broker move uses option A (deploy job migrates to joystick repo)."*
- *"Stages 3 and 4 (mobile + host SDK extraction) are post-event only."*

Two pallasite branches proposed Stage 1 on 14 May:
- `feat/broker-extraction-stage1` (PR #1) — remove the `controller-ws` rsync from pallasite's deploy, add a README pointer to `forgesworn/joystick`.
- `feat/protocol-types-multiplayer` (PR #2) — mirror the multi-player wire types from joystick.

**Both PRs were closed without merging.** PR #2's payload (the `WelcomeFrame` interface + `p?` player-slot fields) landed in pallasite `main`'s `src/controller-types.ts` by another route, so that half is fine. PR #1's cleanup never landed — pallasite kept owning and deploying `controller-ws/`. Both branches were deleted 2 Jul 2026 during a branch cleanup (they held nothing unique/unmerged of value; this doc replaces them as the record).

Net: the extraction stopped after the "keep pallasite's copy alive" phase and the post-event stages were never picked up, leaving the duplication.

## The open decision (for another day)

Now that the event gate has passed, resolve the duplication:

1. **Which repo owns the broker?** joystick (`packages/broker/`) is the intended long-term home per the extraction plan's open-core model; pallasite's `controller-ws/` was the interim live copy.
2. **Reconcile the diverged copies** — diff pallasite's 7 Jun `controller-ws/server.js` against joystick's 5 Jun `packages/broker/server.js`; fold any pallasite-only fixes into joystick (or vice versa) so nothing is lost.
3. **Cut over the deploy** — point `controller.pallasite.app` at joystick's deploy, remove the `controller-ws/` rsync from pallasite's `deploy.yml`, and (once verified) delete `pallasite/controller-ws/`. This is the original PR #1 intent, now doable after the event gate.
4. **Confirm the protocol types are the single source** — pallasite's `src/controller-types.ts` and joystick's `packages/protocol` should not drift; decide which is canonical.

### Risks / watch-outs
- controller.pallasite.app is **live** — any cutover needs the joystick-deployed broker verified working before removing pallasite's rsync, with a rollback path.
- Confirm the joystick broker's `multi-slot peer ownership` (5 Jun) is compatible with whatever pallasite's copy gained by 7 Jun before assuming joystick is a superset.
