# Pallasite

Cosmic arcade Asteroids with Lightning sat payouts, Nostr leaderboards, replays, zaps, and kiosk-friendly controller flows.

Default public screen: <https://pallasite.app/?p1>

Normal player menu: <https://pallasite.app/?menu=1>

## Run Locally

```bash
pnpm install
pnpm dev
```

The Vite dev server runs on port `5180` and proxies `/api/*` to a local faucet on `127.0.0.1:8787`.

## Verify

```bash
pnpm run check:signet-login
pnpm test
pnpm build
```

`pnpm build` typechecks and emits the static app into `dist/`. It uses the committed Signet Login bundle by default; set `SIGNET_LOGIN_SYNC_LOCAL=1 pnpm build` only when intentionally testing a sibling Signet Login build.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: install, Signet bundle drift check, harness tests, build, then rsync `dist/` to the configured Hetzner static-app path.

Required GitHub secrets:

- `HETZNER_SSH_KEY`
- `HETZNER_HOST`
- `HETZNER_USER`
- `HETZNER_PATH`

Manual fallback deploy is `.github/workflows/release-static.yml`, which runs the same checks and rsync path.

## Donations

Pallasite accepts Lightning and on-chain Bitcoin donations:

- Lightning address: `profusemeat89@walletofsatoshi.com`
- Bitcoin (on-chain): `bc1qc75tj6gs06r0hjwy8z6tdkg92tm39wnzwj4lah`
- Silent payment (private on-chain, needs a wallet like Cake or BlueWallet): `sp1qq0s22v57t06499r29yfnwsf408uqzneufpzvy4ennd8dedfwdm08qqes6lwp8uzapmf2x2dhpsfcrhh6j70grs5dfyx7235ae6yl0jr3tcqfym4g`
- Nostr: `npub1mgvlrnf5hm9yf0nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2`

In-game donation QR codes use the same addresses — the booth DONATE screen offers zap, on-chain and silent-payment tabs.

## License

MIT. See [LICENSE](./LICENSE).
