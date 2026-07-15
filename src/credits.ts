/**
 * Game credits — public-facing developer info for the completion screen.
 *
 * The npub is sufficient for a follow link via njump.me. Relay hints from the
 * original nprofile are kept separately in DEFAULT_RELAYS so the public
 * identity reference and the publishing transport can be tuned independently.
 */

export const DEV = {
  name: 'The Crypto Donkey',
  pubkey: 'da19f1cd34beca44be74da4b306d9d1dd86b6343cef94ce22c49c6f59816e5bd',
  npub: 'npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2',
  profileUrl: 'https://njump.me/npub1mgvlrnf5hm9yf0n5mf9nqmvarhvxkc6remu5ec3vf8r0txqkuk7su0e7q2',
  /** LUD-16 lightning address (also published in kind 0). Used for NIP-57 zap requests. */
  lightningAddress: 'profusemeat89@walletofsatoshi.com',
  /** X / Twitter handle, surfaced only on the guest-mode dev card so people
   *  who don't use Nostr still get a way to follow + recognise the dev. */
  twitter: 'TheCryptoDonkey',
  twitterUrl: 'https://x.com/TheCryptoDonkey',
} as const;

/** Experimental-track relay set — during the C4 / watch roll-out we route
 *  the new event kinds (live-presence kind 30762 active, kind 31764 cases,
 *  kind 30765 delegations, kind 31766 ballots) through a single relay we
 *  control so we can iterate without polluting public relays. Established
 *  traffic (finals, ghosts, badges) still fans out across DEFAULT_RELAYS
 *  so leaderboards and replays remain public. Drop this back to
 *  DEFAULT_RELAYS once the surfaces stabilise. */
export const EXPERIMENTAL_RELAYS: readonly string[] = ['wss://relay.trotters.cc'];

/** Bootstrap relay set — the defaults a fresh install ships with. The active
 *  list at runtime comes from `getActiveRelays()` which honours any user
 *  override saved in localStorage. */
export const DEFAULT_RELAYS = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  // Gamestr.io reads scores from these four — keep them in the set so the
  // in-game leaderboard and gamestr stay in sync. (Dropped nostr.wine, a
  // paid relay that rejected our writes.)
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
] as const;
