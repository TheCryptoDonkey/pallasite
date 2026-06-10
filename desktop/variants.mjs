/**
 * Build variants for the Pallasite desktop wrapper.
 *
 *   booth  — the BTC-booth kiosk: fullscreen, boots the ?p1 join wizard at max
 *            FX, runs a bundled local controller-ws broker (linked booths).
 *   public — the pallasite.app download: a normal window that boots the title
 *            screen and talks to the PRODUCTION broker + faucet, so a home
 *            player reaches real opponents and the real leaderboard.
 *
 * The chosen variant is baked into the build at prepare time (resources/
 * app-config.json) and read by main.js; env vars still override per field.
 * Both serve the same built dist/ over http://127.0.0.1 and proxy /api to the
 * faucet — only the window/boot/broker policy differs.
 */

export const FAUCET_ORIGIN = 'https://pallasite.app';
export const PRODUCTION_BROKER = 'wss://controller.pallasite.app/';

export const VARIANTS = {
  booth: {
    variant: 'booth',
    kiosk: true,
    bootQuery: 'p1&fullfx=1',
    faucetOrigin: FAUCET_ORIGIN,
    // null → the game's own localhost detection picks the bundled local broker.
    brokerUrl: null,
    bundleBroker: true,
  },
  public: {
    variant: 'public',
    kiosk: false,
    bootQuery: '',
    faucetOrigin: FAUCET_ORIGIN,
    brokerUrl: PRODUCTION_BROKER,
    bundleBroker: false,
  },
};

export function resolveVariant(name) {
  return VARIANTS[name] ?? VARIANTS.booth;
}
