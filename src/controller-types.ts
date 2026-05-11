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

/** Input kinds the host understands. The mobile controller is a
 *  thumb-driven virtual joystick (matches the in-game touch joystick
 *  mode), so the primary inputs are an analog heading + a thrust flag.
 *  Action buttons stay discrete one-shots. */
export type ControllerInputKind =
  | 'heading'      // value: angle * 1000 (rad → integer 0..6283)
  | 'heading-end'  // value: '1' — joystick released, clear targetHeading
  | 'thrust'       // value: 0|1 — joystick past deflection threshold
  | 'fire'         // value: 0|1 — hold-to-fire
  | 'hyperspace'   // one-shot
  | 'shield'       // one-shot
  | 'pause';       // one-shot toggle

export interface ControllerInputEvent {
  kind: ControllerInputKind;
  /** Value-as-string for wire-portability. Booleans encode as '0'/'1',
   *  angle for heading encodes as Math.round(angle * 1000). */
  value: string;
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
