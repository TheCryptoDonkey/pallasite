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
ownership; personal-score recovery is described below.

The co-op forge timing gate failed with a maximum P2 stall of 96 frames during
parallel checks and 188 frames on the isolated candidate. The unchanged
`bfab5e2` source also failed the same 90-frame limit at 102 frames. Simulation
agreement and active forge pulses passed in these runs. This is evidence of an
unresolved timing gate, not a demonstrated cause or fix; the limit is retained.

Personal score submissions no longer fall back to a different guest key when
signing fails. The run captures its account at start; the finished score,
wave, duration, run id and public display metadata are saved before signing.
The outbox stores public receipts only, retains failures and unconfirmed relay
publication, and only retries with the matching session and signer pubkey.
Confirmed publication clears that receipt; other accounts' pending runs remain.
If storage is unavailable, the banner explains that the page must stay open.
RETRY SCORE uses the original snapshot, while RECONNECT TO RETRY opens signer
recovery. Arcade-origin sessions also offer RECONNECT IN ARCADE, even after
the original signing port closes. This returns to the Pallasite launch page so
the player can reconnect the same arcade account and launch again. It does not
extend the signer's serving window automatically. Pending scores appear again
when the same account returns. Both recovery actions participate in menu
keyboard navigation.

Seven recovery/client regressions cover wrong accounts/signers, auth-only identity,
failure/reload, snapshot retention, unconfirmed/malformed publication,
overlapping retries, storage denial, malformed persisted entries and a provider returning another
account’s signature before HTTP submission. The seventh
production-browser arcade case seeds private fixture receipts, declines the
first signature, returns to the arcade using Enter, relaunches, verifies a canonical same-account NIP-98 signature
and matching payload on retry, and preserves another account's receipt.
The case uses a 320px viewport, checks for horizontal overflow and verifies a
44px reconnect touch target. HTTP responses are fixtures and external writes remain blocked; this does not
prove real gameplay publication.

Live browser acceptance now passes on deployed Pallasite `14e969f` and arcade
`4aa7661`. A normal 190-second pause preceded an earned 16,490-point run whose
first score signature timed out. The public receipt retained its original
account and score. RECONNECT IN ARCADE, explicit same-account My Signet approval
and RETRY SCORE in a new game tab published that receipt: canonical matching
player NIP-98 signing, HTTP 200 and publication to all seven relays pass.
Independent relay verification and fresh displays in both arcade editions
match the score and player. No game state, score, clock or event was injected.
See [recovery evidence](https://github.com/TheCryptoDonkey/gamestr-arcade/blob/1577de7/docs/evidence/gamestr-pallasite-pause-recovery-live-run.json).
A subsequent shared-account matrix also passes: Pallasite earned 19,295 under
the same fresh My Signet account as Ledger, Hang On Fren and Neon Sentinel.
Explicit approval preceded each game; canonical player-bound signatures,
independent reviewed-authority events and eight score-page displays across
both arcade editions pass. See [matrix evidence](https://github.com/TheCryptoDonkey/gamestr-arcade/blob/2af5cfa/docs/evidence/gamestr-shared-account-matrix.json).
Physical acceptance remains open. These browser results do not establish the
exact cause of signer expiry or public 600 DNS cutover.
