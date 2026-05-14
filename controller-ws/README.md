# Pallasite controller WebSocket relay

> **Note (2026-05-14):** This directory is a one-week rollback path.
> The canonical broker source has moved out of this repo. Edits made
> here no longer deploy to production. Track changes upstream and
> delete this directory after the rollback window has passed (target
> 2026-05-21).

Tiny Node service that pairs phone controllers with the big-screen
game host. Bypasses the higher-latency Nostr publish/subscribe path
used in v1 of the phone-as-controller MVP.

## Wire shape

```
wss://controller.pallasite.app/?s=<sessionId>&r=<host|phone>
```

- `s` — 4-32 char alphanumeric session id (same value the QR code
  carries; effectively a shared secret between the paired devices).
- `r` — `host` (big screen) or `phone` (controller).

Once both sides are connected on the same session id, every message
from one is forwarded verbatim to the other. The server also sends
`{"type":"peer-up"}` / `{"type":"peer-down"}` JSON frames whenever
the pair state changes, so clients can show a connection indicator.

There is no auth beyond the session id. Discoverability is the only
defence — a 32-bit random id displayed via QR for ~30s gives any
attacker a ~1-in-4-billion guess window. Brute force is infeasible
and the payoff (driving someone's ship for a few seconds) is zero.

## Deploy (Caddy + systemd, first time)

1. Copy the directory to the Hetzner box:
   ```
   rsync -av controller-ws/ deploy@95.217.39.110:/opt/pallasite-controller-ws/
   ```
2. Install runtime deps (one-off):
   ```
   ssh deploy@95.217.39.110 'cd /opt/pallasite-controller-ws && npm ci --omit=dev'
   ```
3. Install the systemd unit:
   ```
   ssh deploy@95.217.39.110 'sudo cp /opt/pallasite-controller-ws/pallasite-controller-ws.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now pallasite-controller-ws'
   ```
4. Add the Caddy block:
   ```
   ssh deploy@95.217.39.110 'sudo tee -a /etc/caddy/Caddyfile < /opt/pallasite-controller-ws/Caddyfile.snippet && sudo systemctl reload caddy'
   ```
5. DNS: A record `controller.pallasite.app → 95.217.39.110` (same as
   `pallasite.app`, `watch.pallasite.app`, `mobile.pallasite.app`).
6. Verify:
   ```
   curl -i https://controller.pallasite.app/
   # should respond with 404 'controller relay — open a websocket'
   ```

## Subsequent deploys

The CI workflow rsyncs the directory + restarts the service. Hands-
free unless `package.json` deps change (then ssh in and `npm ci`).

## Why not Nostr?

The phone-as-controller v1 used kind 22770 ephemeral events on
relay.trotters.cc. Costs per input:

- `schnorr.sign` on phone: 5-10ms
- Relay round-trip: 30-80ms
- Signature verify on host: 3-10ms

Total ~40-100ms felt laggy on the joystick. The signing+verify is
unavoidable on Nostr (relays reject unsigned events). The relay hop
is also unavoidable on Nostr (no direct peer addressing).

This service drops both. Pairing handshake still uses Nostr (one
shot, latency doesn't matter); the high-rate input stream goes
raw over WS.

## Local dev

```
cd controller-ws
npm install
PORT=8788 npm start
```

In another shell:
```
# host
websocat 'ws://127.0.0.1:8788/?s=abc123&r=host'
# phone
websocat 'ws://127.0.0.1:8788/?s=abc123&r=phone'
```

Anything typed into one shows up in the other.
