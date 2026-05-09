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
  lightningAddress: '7292beaf42208125@coinos.io',
  /** X / Twitter handle, surfaced only on the guest-mode dev card so people
   *  who don't use Nostr still get a way to follow + recognise the dev. */
  twitter: 'TheCryptoDonkey',
  twitterUrl: 'https://x.com/TheCryptoDonkey',
} as const;

/** Bootstrap relay set — the defaults a fresh install ships with. The active
 *  list at runtime comes from `getActiveRelays()` which honours any user
 *  override saved in localStorage. */
export const DEFAULT_RELAYS = [
  'wss://relay.trotters.cc',
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://nostr.wine',
] as const;
