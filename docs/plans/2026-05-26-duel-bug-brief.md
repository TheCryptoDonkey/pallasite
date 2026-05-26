# 2P duel reliability postmortem - May 2026

## Status

Fixed, pushed, and deployed to production on May 26, 2026.

Production tip:

- `8bd60b0 fix(peer): smooth production duel lockstep`
- Deploy workflow: `26442884889`, completed successfully
- Production smoke: `pnpm exec tsx tools/check-prod-duel.ts`, healthy after deploy

## Original symptom

Two production players reached `phase='playing'`, but each peer's partner
ship appeared frozen. Spectator recordings showed both ships frozen or
recovering too slowly, which meant the lockstep loop was not receiving a
usable remote input window.

## Root cause shape

The broker was forwarding frames, but the browser-side lockstep loop was too
fragile under production scheduling and network jitter. Short input delay,
short stall windows, worker teardown, and bounded retry behavior combined into
an unrecoverable stall when one side missed a remote frame burst.

## Fixes that landed

- Keep the peer worker/socket recoverable instead of terminating it on transient disconnect paths.
- Leave local input resend active while stalled so the remote peer continues to receive fresh windows.
- Increase production peer input delay to absorb real jitter.
- Extend the stall watchdog so a temporary receive gap does not collapse a live duel into solo play.
- Harden production duel smoke coverage so both clients must see remote motion.

## Current proof tools

| Tool | Purpose |
|---|---|
| `tools/check-prod-duel.ts` | Production 2P health check. Verifies both peers advance and see remote ship motion. |
| `tools/check-prod-bare-ws.ts` | Minimal browser main-thread WebSocket broker sanity check. |
| `tools/check-prod-bare-worker.ts` | Minimal browser Worker WebSocket broker sanity check. |
| `tools/check-prod-sustained.ts` | Node-only sustained broker delivery check. |
| `tools/record-prod-watch.ts` | Records production spectator-view MP4 proof of two AI players. Uses image-sequence capture from the real canvas stack to avoid browser recorder frame drops. |

## Latest visual proof

`tools/record-prod-watch.ts` now:

- joins a real production peerwatch spectator plus two production player pages,
- warms asteroid/background assets before capture,
- captures composited 2D + WebGL frames as a deterministic image sequence,
- encodes `tools/record-out/prod-duel-watch.mp4` as H.264,
- avoids Playwright and MediaRecorder video pacing artifacts.

## Follow-on: deathmatch scale

The 2P duel architecture is still slot-oriented. N-player deathmatch should be
treated as a new mode and transport target, not just a larger duel:

- dynamic player slots,
- larger non-wrapping arena,
- radar-first situational awareness,
- cover-scale asteroid terrain,
- server/host authoritative movement with local prediction,
- production scale harness for `N=2,4,8+`.
