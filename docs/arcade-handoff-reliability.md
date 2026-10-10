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
to the join screen for a subsequent visitor asks them to sign in; ordinary
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
