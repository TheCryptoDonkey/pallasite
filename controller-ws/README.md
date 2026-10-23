# Controller broker

Node/WebSocket service for the Joystick hosted pilot at
`wss://controller.pallasite.app/`. It assigns controller slots, emits lifecycle
frames and carries controller inputs and game state between a phone and a game
screen, nothing else. TLS ends at the reverse proxy; the broker can read the
frames it forwards.

## The one rule

Every frame a paired endpoint (host or phone) sends is parsed, checked field by
field against a closed grammar and **rebuilt** from the validated fields. Anything
outside the grammar is dropped (the socket stays open), never forwarded. This
holds on legacy (versionless) and `v=2` sessions alike, in single and multi mode.
Strings that survive are members of the operator's closed vocabulary
(`vocabulary.json`) or templates whose only parameters are bounded integers.
Wire field names do not change, so existing clients keep working.

The relay therefore carries no chat, typed names, profile pictures, binary
payloads or signing requests. Any channel of bounded integers (input axes, scores,
totals) could in principle carry data at very low bandwidth; the position rests on
every field having a game meaning and a validated range, not on zero capacity.

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

Only the broker emits welcome/host/peer lifecycle frames. The broker stamps phone
player slots (a `p` sent by a phone is discarded) and rejects endpoint-supplied
lifecycle frames. A phone heartbeat every 500 ms keeps its three-second
application lease alive; native ping/pong handles network liveness separately.
Multi-player recovery reserves a slot for fifteen seconds; explicit
`controller-leave` releases it immediately.

Versionless clients use a separate legacy namespace. They retain code-based
host replacement and optional recovery/heartbeat, and get the same content
rules as `v=2`. Lockstep peers (`r=peer`) do not inherit v2 controller host
authentication.

Roles are `host`, `phone` and `peer`. The former `publish`, `subscribe` and
`peerwatch` roles are removed: an upgrade for any of them is answered
`410 Gone` by the broker, and `Caddyfile.snippet` refuses them at the proxy too.

## Wire allowlist

Phone to host. A phone's text frame over 4 KiB (`PHONE_FRAME_BYTES`) and every
binary frame is dropped.

| Frame | Accepted shape | Forwarded as |
| --- | --- | --- |
| input | `{k, v}` with no `type`. `k` is one of the 16 slots (`joyL joyR A B X Y L1 L2 R1 R2 start select dpadU dpadD dpadL dpadR`), or for `joyL`/`joyR` only, the slot plus `-x -y -thrust -power -end -tap`. `v` is a string matching `^-?\d{1,4}$` inside the range for its key | `{k, v}` (plus `p` in multi mode) |
| `phone-context` | `tournamentTotal` an integer from 0, capped at 1000000 (the score ceiling); optional `name`, forwarded only if it is exactly three capital letters A to Z (arcade initials, `^[A-Z]{3}$`), otherwise omitted | `{type, tournamentTotal, name?}` |
| `controller-join`, `controller-heartbeat`, `controller-leave` | as before | consumed by the broker, never forwarded |

Input ranges: bare stick key (heading) -6284 to 6284 (the pad sends -3142 to
3142, Pallasite a normalised 0 to 6283); `-x`/`-y` -1000 to 1000; `-power` 0 to
1000; `-thrust` 0 or 1; `-end` and `-tap` 1; every non-stick slot 0 or 1. Phone
frames of any other type, including `signer-announce`, `signer-revoke` and
`sign-response`, are dropped.

Host to phone. Accepted only from the current host socket. `p` must be an integer
below `MAX_PHONES` to route one phone in multi mode, and is removed in single
mode. Unknown keys are dropped. The inbound budget is still 64 KiB so an
oversized third-party spec reaches the rebuild step instead of closing the host.

| Frame | Rebuilt as |
| --- | --- |
| `controller-spec` | `version` 1. `name` must be a game name from the vocabulary (optionally ` · MENU`, ` · P<n>` or ` · SPECTATOR <n>`), else `GAME`. At most 16 known slots; per slot `mode` (`heading xy tilt`), `tapAction` (a slot), `label` and `icon` only if in the vocabulary, `colour` only if a valid hex or `rgba()` colour, `graphic` only if the SHA-256 of the exact PNG is listed and its base64 is the canonical encoding. `theme` colours and `layout` geometry are kept if valid (layout numbers rounded to three decimal places); a broken `layout` is dropped and the rest kept |
| `controller-feedback` | `message` must match a vocabulary template (`{n}` is an integer 0 to 1000000, `{slot}` one of `A B X Y`), else an empty string; `selected`, `locked` and `tone` are checked |
| `haptic` | `pattern` is `tap pulse thud win fail`, or 1 to 16 integers 0 to 5000 |
| `game-score` | `score` integer 0 to 1000000; `label` only if it matches a score-label template |
| `spectator-view` | `title` must be `<game> · <phase>`, else `SPECTATOR`; at most 8 leaderboard rows with `p` 0 to 63, `label` of the form `P3`, `P3 · BOT` or `P3 · ABC` (optionally `1. ` first), else `P<p+1>`, an integer `score`, optional `tournamentTotal` and a valid `colour`; `highlight` only if it matches a vocabulary highlight. Initials in a row label or highlight (`P3 · ABC`) are kept only if the phone in that player slot sent exactly those letters in this session (`BOT` is the host's own marker); otherwise they are dropped to `P3`. `tournamentTotal` is capped at 1000000 |

`sign-request`, binary frames and every other type are dropped. An unknown string
becomes a placeholder (`GAME`, an empty string, `SPECTATOR`, `P<n>`) or the field
is removed; it is never forwarded.

### Vocabulary

`vocabulary.json` is a byte-identical copy of `packages/protocol/src/vocabulary.json`
(`scripts/check-vocabulary-sync.mjs` fails if they differ). It lists game names,
slot labels, icons, phases, feedback templates, score-label templates,
highlights and button graphics (by name and SHA-256 of the exact PNG). Tokens
match exactly, including case and the ` · ` separator. It contains every string
ForgeSworn's own games send; a new string needs a reviewed commit. A self-hoster
can supply their own file with `CONTROLLER_VOCABULARY=/path/to/vocabulary.json`
(same shape). The host SDK takes an optional `vocabulary` to warn about text the
relay would replace.

### Host origin allowlist

The hosted relay accepts game screens (`r=host`) only from ForgeSworn's own
sites. `CONTROLLER_HOST_ORIGINS` is a comma-separated list of exact origins
(for example `https://tank.forgesworn.dev`). Unset or empty accepts any origin,
which is the default for people who run their own relay. With a list set, a host
upgrade with a missing or unlisted `Origin` is refused with `403 Forbidden`.
`CONTROLLER_ALLOW_LOOPBACK=1` additionally admits `http://127.0.0.1:<port>` and
`http://localhost:<port>` when a list is set; do not set it on a public relay.
Phones and lockstep peers are not restricted by this check.

Browsers always send `Origin` on a WebSocket upgrade and a page cannot forge it,
so this stops other websites from using the relay as a game screen. A script
that is not a browser can send any `Origin` header: it is a boundary between
sites, not authentication.

### Peer play

Lockstep peers may only exchange game inputs. The broker parses every peer
message and forwards, replays and fans out a copy rebuilt from validated fields
only; it never relays the sender's bytes. Everything else is dropped, and the
`peer.rejected` counter in `/metrics` counts it.

| Type | Forwarded fields |
| --- | --- |
| `frame` | `slot`, `frame`, `input` |
| `frame-set` | `frame`, `entries`: 1 to 64 pairs of `[slot, input]` |
| `frames` | `slot`, `base`, `inputs`: 1 to 32 integers |
| `hash` | `slot`, `frame`, `hash` |

Every `slot` must be one the sending socket bound in its `hello-peer`. `frame`,
`base` and `input` are integers from 0 to 2^24-1 and `hash` is a uint32; the
bounds live in `PEER_LIMITS` in `controller-policy.js` and must move with the
game's input encoding. Unknown fields are stripped. Unknown types, strings,
nested objects, broker-owned lifecycle types and out-of-range numbers are
dropped. The negotiated binary frames are exact-length (12, 12 or 9+4n bytes)
and are re-encoded from the same fields. `hello-peer` and `bye` are consumed by
the broker and never forwarded. A peer message over `PEER_FRAME_BYTES` closes the
socket with 1008. Recent frames are kept so a late-joining human peer can replay
them; replay history and receivers remain bounded as below.

## Default budgets

| Setting | Default |
| --- | --- |
| `MAX_CONNECTIONS` / `MAX_CONNECTIONS_PER_CLIENT` | 128 / 64 |
| `CONNECTION_ATTEMPTS_PER_MINUTE` | 120 per client |
| `MAX_FRAME_BYTES` | 1 MiB WebSocket payload |
| `CONTROLLER_FRAME_BYTES` | 64 KiB inbound for host and phone; a larger frame closes the socket with 1008 `message-budget` |
| `PHONE_FRAME_BYTES` | 4 KiB for a phone text frame (fixed); a larger one is dropped, the socket stays open |
| `PEER_FRAME_BYTES` | 2 KiB for a lockstep peer (largest valid message is about 1 KiB) |
| `MESSAGES_PER_SECOND` | 240 per connection |
| `PEER_MESSAGES_PER_SECOND` | 2000 per lockstep peer connection |
| `FORWARD_BUFFER_BYTES` | 256 KiB; terminate a slow controller |
| `HEARTBEAT_MS` / `CONTROLLER_LEASE_MS` | 5 seconds / 3 seconds |
| `OWNER_RETENTION_MS` / `RECONNECT_GRACE_MS` | 5 minutes / 15 seconds |
| `PEER_REPLAY_BYTES` / `PEER_SESSION_REPLAY_BYTES` | 8 MiB total / 1 MiB per session |

When the optional Foregather gateway is enabled, its bodies have a three-second
absolute deadline, eight requests per client and eighty total may run
concurrently, and requests, public lookups and allocations have separate
per-minute budgets. Addresses are hashed in bounded transient
memory; trust forwarded addresses only from the loopback reverse proxy. Keep the
broker bound to loopback in production. These limits are regression-tested
bounds; sustained-load qualification remains open.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | Listen address; defaults `8788` and `127.0.0.1` |
| `CONTROLLER_HOST_ORIGINS` | Comma-separated exact origins allowed to open a host (game screen) socket. Unset or empty allows any origin (self-hosters). See above |
| `CONTROLLER_ALLOW_LOOPBACK` | `1` also admits `http://127.0.0.1:*` and `http://localhost:*` hosts when a list is set |
| `CONTROLLER_VOCABULARY` | Path to your own vocabulary file, same shape as `vocabulary.json`; defaults to the bundled copy |
| `FOREGATHER_GATEWAY`, `FOREGATHER_API_URL` | The `/foregather/` gateway is off unless **both** are set (with `FOREGATHER_CREATE_TOKEN`); otherwise it answers `410 Gone`. See [Foregather](../../docs/foregather.md) |
| the budget variables above | Connection, frame, rate and replay bounds |

## Development and deployment

```sh
pnpm install
pnpm --filter pallasite-controller-ws start
pnpm --filter pallasite-controller-ws test
```

The service defaults to `127.0.0.1:8788`; put a TLS-terminating reverse proxy
in front (`Caddyfile.snippet` is the pattern) and give games the resulting
`wss://` URL as `ws`. Production deployment is defined in
`.github/workflows/deploy.yml`, targeting `deploy@62.238.98.53` at
`/opt/pallasite-controller-ws/` with pinned SSH host keys and
`pallasite-controller-ws.service`. Reuse the workflow's pinned trust. Its health
check gates success.

The production origin list is the `Environment=CONTROLLER_HOST_ORIGINS=` line in
`pallasite-controller-ws.service`. Release activation only restarts the service
and never rewrites the live unit, so the live unit (or a drop-in from
`systemctl edit`) must carry the same line; check it after any change to the list.
Add a new ForgeSworn game origin to both places.

`deploy-foregather.sh` installs the checksum-pinned Rust relay v0.4.0, licences
and its dedicated service for people who want to run their own Foregather
pairing gateway. The hosted gateway is switched off by default and ForgeSworn's
apps no longer offer it. The relay listens on loopback; the operator token stays
in a root-owned environment file and the private database persists. See the
[hardening review](../../docs/hardening-review.md) for qualification gaps.
