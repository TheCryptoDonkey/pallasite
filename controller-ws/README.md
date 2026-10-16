# Controller broker

Node/WebSocket service for the Joystick hosted pilot at
`wss://controller.pallasite.app/`. It assigns controller slots, emits lifecycle
frames and routes bounded game messages. TLS ends at the reverse proxy; the
broker can read traffic and optional identity announcements.

## Controller protocol v2

Hosts connect with `?s=<code>&r=host&v=2` and optionally `&multi=1`. The first
frame is `{"type":"host-join","hostToken":"<64 lowercase hex>"}`. Generate
that credential from 32 CSPRNG bytes; never include it in a QR, URL or invitation.
The broker stores a purpose-bound hash and responds with
`{"type":"host-ready","version":2}` before pairing. An existing session
requires the same credential. Empty sessions retain ownership for five minutes
by default; broker restart loses this in-memory state.

Phones use `?s=<code>&r=phone&v=2&recover=1`, then send
`{"type":"controller-join"}` or include their private `resumeToken`. A phone
cannot create a v2 session before its host establishes ownership. The default
SDK code has six letters; codes permit controller admission, not host ownership
or named identity proof. V2 session IDs require 6–128 characters.

Only the broker emits welcome/host/peer lifecycle frames. Phones send bounded
input and signer/context responses; hosts send controller specs, signing
requests, haptics, scores and spectator views. The broker stamps phone player
slots and rejects endpoint-supplied lifecycle frames. A phone heartbeat every
500 ms keeps its three-second application lease alive; native ping/pong handles
network liveness separately. Multi-player recovery reserves a slot for fifteen
seconds; explicit `controller-leave` releases it immediately.

Versionless clients use a separate legacy namespace. They retain code-based
host replacement and optional recovery/heartbeat. Stream publisher/subscriber
and lockstep peer/peerwatch roles retain their existing protocol; they do not
inherit v2 controller host authentication. Peer fan-out canonicalises the
owned-slot frame schema and bounds replay history and receivers.

## Default budgets

| Setting | Default |
| --- | --- |
| `MAX_CONNECTIONS` / `MAX_CONNECTIONS_PER_CLIENT` | 128 / 64 |
| `CONNECTION_ATTEMPTS_PER_MINUTE` | 120 per client |
| `MAX_WATCHERS` / `MAX_SUBSCRIBERS` | 32 per session |
| `MAX_FRAME_BYTES` | 1 MiB WebSocket payload |
| `CONTROLLER_FRAME_BYTES` | 64 KiB for host, phone and peer |
| `MESSAGES_PER_SECOND` | 240 per connection |
| `PEER_MESSAGES_PER_SECOND` | 2000 per lockstep peer connection |
| `FORWARD_BUFFER_BYTES` | 256 KiB; terminate a slow controller/subscriber |
| `HEARTBEAT_MS` / `CONTROLLER_LEASE_MS` | 5 seconds / 3 seconds |
| `OWNER_RETENTION_MS` / `RECONNECT_GRACE_MS` | 5 minutes / 15 seconds |
| `PEER_REPLAY_BYTES` / `PEER_SESSION_REPLAY_BYTES` | 8 MiB total / 1 MiB per session |

Gateway bodies have a three-second absolute deadline. Eight requests per client
and eighty total may run concurrently. Requests, public lookups and allocations
have separate per-minute budgets. Addresses are hashed in bounded transient
memory; trust forwarded addresses only from the loopback reverse proxy. Keep the
broker bound to loopback in production. These limits are regression-tested
bounds; sustained-load qualification remains open.

## Development and deployment

```sh
pnpm install
pnpm --filter pallasite-controller-ws start
pnpm --filter pallasite-controller-ws test
```

The service defaults to `127.0.0.1:8788`. Production deployment is defined in
`.github/workflows/deploy.yml`, targeting `deploy@62.238.98.53` at
`/opt/pallasite-controller-ws/` with pinned SSH host keys and
`pallasite-controller-ws.service`. Reuse the workflow's pinned trust. Its health
check gates success.

`deploy-foregather.sh` installs the checksum-pinned Rust relay v0.4.0, licences
and its dedicated service. It listens on loopback; the operator token stays in
a root-owned environment file and the private database persists. The public
gateway is `/foregather/`; operator routes stay private. Browser package patch
releases do not require changing this Rust service version. See the
[hardening review](../../docs/hardening-review.md) for qualification gaps.
