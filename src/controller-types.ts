/**
 * Phone-as-controller — shared types + Nostr event kinds.
 *
 * Architecture: the big-screen browser generates an ephemeral
 * `sessionPubkey` and displays a QR code carrying it + a relay URL.
 * The mobile browser opens that URL, generates its own ephemeral
 * `pairPubkey`, and publishes a single CONTROLLER_CLAIM event addressed
 * to the session. Once the big screen accepts that claim, all later
 * input events from that pairPubkey are translated into game state.
 *
 * This mirrors the streamkey delegation pattern (NIP draft #1) in the
 * opposite direction: instead of "master authorises a sub-key to
 * publish on its behalf", here the big-screen "host" authorises a
 * mobile sub-key to drive its game. Both sides discard the ephemeral
 * keys at session end.
 *
 * Wire kinds (Nostr ephemeral range, 20000-29999):
 *   22770  CONTROLLER_INPUT — discrete input events (thrust, fire,
 *          rotate, hyperspace, shield, pause).
 *   22771  CONTROLLER_CLAIM — one-shot "I am your phone, here is my
 *          pairPubkey". The host either accepts (first valid claim per
 *          session wins) or rejects (multiple claims, host already
 *          paired).
 */

export const CONTROLLER_INPUT_KIND = 22770;
export const CONTROLLER_CLAIM_KIND = 22771;

/** Input kinds the host understands. Maps onto keyboard codes inside
 *  controller-host so the existing game input plumbing (state.keys[],
 *  tryHyperspace, etc.) doesn't need to know it's been remoted. */
export type ControllerInputKind =
  | 'left'        // hold-to-rotate-left  (maps to ArrowLeft held)
  | 'right'       // hold-to-rotate-right (maps to ArrowRight held)
  | 'thrust'      // hold-to-thrust       (maps to ArrowUp held)
  | 'fire'        // hold-to-fire         (maps to Space held)
  | 'hyperspace'  // one-shot
  | 'shield'      // one-shot
  | 'pause';      // one-shot toggle

export interface ControllerInputEvent {
  kind: ControllerInputKind;
  /** For hold-style inputs (left/right/thrust/fire), 1 = pressed,
   *  0 = released. One-shot inputs (hyperspace/shield/pause) always
   *  carry 1 — release is ignored. */
  value: 0 | 1;
}

/** Pairing token — encoded into the QR-code URL. Mobile reads these
 *  params, builds its claim event accordingly. */
export interface PairingToken {
  /** Session pubkey (hex) — host's ephemeral, regenerated each pair. */
  hostPubkey: string;
  /** Random short id so multiple QR codes from the same host don't
   *  collide if a stale tab is still listening. Six lowercase alphanum
   *  chars. */
  sessionId: string;
  /** Relay URL. Defaults to relay.trotters.cc in the encoder. */
  relay: string;
}

export const CONTROLLER_TAG = 'pallasite-controller';
