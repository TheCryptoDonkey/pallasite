# Pallasite desktop / AppImage

Wraps the built game in Electron and produces a self-contained Linux
**AppImage**. Bundles:

- the **game** (`dist/`), served over `http://127.0.0.1:8123` — a secure-context
  origin, so the service worker and WebGL behave exactly like production;
- the **controller-ws broker** on `:8788`, which the in-page lobby auto-targets
  whenever the page is served from localhost — so duel / co-op / spectate work
  with no production round-trip.

The **Lightning faucet is _not_ bundled** (it custodies sats). `/api/*` is
reverse-proxied to a remote faucet origin instead — default `https://pallasite.app`.

## Build

```bash
# 1. Build the game + broker deps (from the repo root)
pnpm build
( cd controller-ws && npm ci )      # or pnpm i — installs `ws`

# 2. Build the AppImage
cd desktop
npm install                          # electron + electron-builder
npm run dist                         # → out/Pallasite-0.1.0-x86_64.AppImage
# npm run dist:arm64                 # aarch64 build (e.g. ARM mini-PC)
```

`scripts/prepare.mjs` stages `../dist`, `../controller-ws`, and the icon into
`resources/`+`build/` before electron-builder runs; `npm run dist` calls it for you.

> **Cross-building from macOS:** there are no native modules in the runtime
> (`ws` is pure JS, the static server uses Node built-ins), so electron-builder
> can usually emit a Linux AppImage straight from macOS. If the host toolchain
> fights you, build inside the official container instead:
> ```bash
> docker run --rm -v "$PWD/..":/project -w /project/desktop \
>   electronuserland/builder:latest \
>   sh -c "npm install && npm run dist"
> ```

## Build variants

Two variants share this wrapper (chosen with `PALLASITE_VARIANT`, baked into
`resources/app-config.json` at prepare time):

| | **booth** (default) | **public** |
| --- | --- | --- |
| Window | fullscreen kiosk | normal resizable window |
| Boot | `?p1&fullfx=1` join wizard | title screen |
| Broker | bundled local `:8788` (linked booths) | production `controller.pallasite.app` |
| Audio | autoplay (pad kiosk) | normal (gesture) |
| Use | event kiosk | pallasite.app download |

The page is served from `127.0.0.1`, so the public build injects the real
faucet + broker hosts into the shell (`__PALLASITE_API_ORIGIN__`,
`__PALLASITE_BROKER_URL__`) — otherwise it would sign auth for localhost (401)
and target a non-existent local broker.

## Public downloads (Windows / macOS / Linux)

Cross-platform installers are built on each OS's native runner via CI and
published to a GitHub Release:

- **Trigger:** Actions → **Desktop release** → Run workflow (or push a
  `desktop-v*` tag). It builds `.exe` (NSIS), `.dmg` (arm64 + x64), and
  `.AppImage`, all **unsigned** (Gatekeeper/SmartScreen show a warning — install
  notes needed on the download page), and uploads them to a draft release
  `v<version>` (from `desktop/package.json`). Review + publish the draft, then
  point the pallasite.app download section at the latest release assets.
- **Local:** `npm run dist:public` builds the current OS's installer into
  `out-public/` (e.g. a `.dmg` on macOS). `npm run start:public` runs the public
  variant in a dev window.

## Run / smoke-test locally

```bash
cd desktop && npm start            # builds resources, opens the kiosk window
```

## Configuration (env vars)

| Var | Default | Purpose |
| --- | --- | --- |
| `PALLASITE_FAUCET_URL` | `https://pallasite.app` | Remote faucet origin for `/api/*`. |
| `PALLASITE_HTTP_PORT` | `8123` | Local game port (fixed so the SW cache survives launches). |
| `PALLASITE_CONTROLLER_HOST` | `127.0.0.1` | Broker bind address. Set `0.0.0.0` to expose it on the LAN. |
| `PALLASITE_CONTROLLER_PORT` | `8788` | Broker port. |
| `PALLASITE_KIOSK` | _(kiosk on)_ | Set `0` for a normal resizable window. |
| `PALLASITE_BOOT_QUERY` | `p1&fullfx=1` | Query string appended to the game URL — boots the kiosk join wizard at max FX. See 4K notes below. |

In kiosk mode: **F11** toggles fullscreen, **Ctrl/Cmd+Shift+Q** quits.

## 4K booth / TV

Tuned for a large TV out of the box:

- **Native 4K render.** A 4K TV reports `devicePixelRatio` 1, and the game caps
  DPR at 2×, so it renders the full 3840×2160 backing store with no upscaling.
- **Booth mode + max visual tier.** The default `PALLASITE_BOOT_QUERY=p1&fullfx=1`
  boots the kiosk join wizard (`p1`), pins the highest FX tier, and
  disables the adaptive frame-time governor that would otherwise shed effects.
  If the booth GPU can't hold 60fps at 4K, drop `fullfx`:
  `PALLASITE_BOOT_QUERY=p1` (the governor then protects framerate). Swap `p1`
  for `couch=1` for the local-couch gamepad variant.
- **GPU forced on.** The wrapper sets `ignore-gpu-blocklist`,
  `enable-gpu-rasterization`, `enable-zero-copy`, and `force_high_performance_gpu`
  so Chromium never falls back to software rendering (unplayable at 4K) and uses
  the discrete GPU on a multi-GPU box.

Verify the GPU path is live in-app via the on-screen diag (`?diag=1`) or, in a
windowed build, `chrome://gpu` — "WebGL: Hardware accelerated" is what you want.

## Known limitation — phone-as-controller on a LAN

The duel/co-op/spectate broker auto-resolves to the bundled `:8788` on
localhost. The **phone-as-controller** path, however, still hands phones the
public `wss://controller.pallasite.app/` endpoint, so it needs internet. Making
phones pair to the bundled broker offline requires the QR token to carry the
booth's LAN `ws://<ip>:8788/` URL — a small frontend change, tracked separately.
