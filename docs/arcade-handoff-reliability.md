# Arcade identity in the booth

Fresh launches from the 600 Billion Arcade could accept their signed proof and
connect their signing port, then lose both when the service worker first took
control and reloaded the page. The launch fragment had already been consumed;
the replacement page could not recover the temporary port. The booth also asked
player one to sign in again despite receiving the selected arcade account.

First worker installation now keeps the document. Worker updates wait for the
page's activation policy. A live arcade session offers RETURN TO ARCADE for a
fresh launch rather than silently refreshing its one-use connection. Other
clients retain their normal safe-surface update flow and mid-run prompt.

Player one can use the supplied live arcade session once, on the first booth
setup for that launch. Player two still chooses a separate identity. Returning
to the join screen for a subsequent visitor closes the old arcade signing port
and asks them to sign in; ordinary
persisted personal accounts and booth guests are not automatically reused.

The vendored SDK now matches the published Signet Login 0.17.3 bundle. Its
SHA-256 is `d689b4e72aa562b3fe3272504057d7b1b474a89f19bc1c4ec03c20c4245fb1be`.
The existing bundle drift check verifies the published artifact independently.

`pnpm build && pnpm test:arcade` runs the production client with native browser
service workers and a canonically signed proof from disposable local peers.
It checks first worker control, a waiting worker update, the selected first
pilot, the next booth visitor, a separate second pilot and ordinary walk-up
login. External relay sockets and payout requests are blocked; private test
keys stay in process memory. CI and both deployment workflows run this gate.

This regression proves the client lifecycle and booth selection behaviour. It
does not prove a published My Signet Bunker run, a physical controller/phone,
real Lightning settlement or one player through all four games. Those remain
separate acceptance checks in Gamestr Arcade's reliability evidence.

## Remaining verification

The shared signing queue now stores each request's bound signer. Previously,
the signer that started the runner was reused for all queued requests, including
another pilot's request arriving during an in-flight signature. The new
`pnpm test:sign-queue` regression fails on the previous implementation with
the second account's event signed by the first. It verifies canonical Schnorr
signatures for overlapping accounts, rejection followed by another account's
request, and queue re-entry. CI and deployment gates run it. This fixes request
ownership; the personal-score guest fallback described below is still open.

The co-op forge timing gate failed with a maximum P2 stall of 96 frames during
parallel checks and 188 frames on the isolated candidate. The unchanged
`bfab5e2` source also failed the same 90-frame limit at 102 frames. Simulation
agreement and active forge pulses passed in these runs. This is evidence of an
unresolved timing gate, not a demonstrated cause or fix; the limit is retained.

Source review also found a separate public-score fallback that can substitute
a guest after a personal signer fails. Same-account failure/retry behaviour
needs its own correction and verification before broad signer continuity can
be claimed. The normal successful-signing path is a separate live-run gate.
