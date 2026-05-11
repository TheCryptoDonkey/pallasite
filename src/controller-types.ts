/**
 * Phone-as-controller — shared types + transport endpoint.
 *
 * v2 transport: raw WebSocket relay at controller.pallasite.app. Pair
 * by sessionId — both sides connect with the same id, one as
 * `role=host`, the other as `role=phone`, and the relay forwards bytes
 * between them. No signing, no Nostr semantics on the input stream;
 * the sessionId in the QR code is the only auth (32-bit random,
 * displayed for a brief pairing window).
 *
 * The earlier v1 transport used Nostr ephemeral events (kind 22770 +
 * 22771) on relay.trotters.cc. We retain the v1 module shape (claim →
 * input events) at the API level so the UI is unchanged; only the
 * underlying transport swapped.
 */

/** Default WS endpoint in production. Overridable per-host via the
 *  `relay` field on the pairing token so dev / staging builds can
 *  point at a local controller-ws server. */
export const CONTROLLER_WS_ENDPOINT_DEFAULT = 'wss://controller.pallasite.app/';

/** Input kinds the host understands. The mobile controller is a
 *  thumb-driven virtual joystick (matches the in-game touch joystick
 *  mode), so the primary inputs are an analog heading + a thrust flag.
 *  Action buttons stay discrete one-shots. */
export type ControllerInputKind =
  | 'heading'      // value: angle * 1000 (rad → integer 0..6283)
  | 'heading-end'  // joystick released, clear targetHeading
  | 'thrust'       // value: 0|1 — joystick past deflection threshold
  | 'fire'         // value: 0|1 — hold-to-fire
  | 'hyperspace'   // one-shot
  | 'shield'       // one-shot
  | 'pause';       // one-shot toggle

/** Frame the controller sends over the WS data channel. Stringified
 *  JSON; the relay forwards it byte-for-byte to the host. */
export interface ControllerInputFrame {
  k: ControllerInputKind;
  /** Value string. Booleans are '0'/'1'; heading is the angle * 1000
   *  as a base-10 integer (positive, 0..6283). */
  v: string;
}

/** Pairing token — encoded into the QR-code URL. */
export interface PairingToken {
  /** Session id (4-32 alphanumeric chars). Shared secret between
   *  host and phone during the pairing window; the WS relay matches
   *  the two sides on it. */
  sessionId: string;
  /** WS endpoint. Defaults to CONTROLLER_WS_ENDPOINT_DEFAULT. */
  ws: string;
}
