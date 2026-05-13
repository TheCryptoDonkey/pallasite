/**
 * Phone-as-controller — shared types + transport endpoint.
 *
 * Architecture (v2 PWA):
 *
 *   mobile.pallasite.app is a generic game-controller PWA. It renders
 *   a fixed gamepad layout (joystick + ABXY face buttons + L1/L2/R1/R2
 *   shoulders + start/select). The game it pairs with sends a
 *   ControllerSpec describing which slots it cares about and what
 *   icon/label/colour to put on each. Buttons not in the spec are
 *   hidden. Different game → different icons, same physical layout.
 *
 *   Transport: raw WebSocket pass-through at controller.pallasite.app.
 *   Pair by sessionId (8-hex random in the QR code).
 *
 * Wire shape:
 *
 *   On pair, host sends:
 *     { type: 'controller-spec', spec: ControllerSpec }
 *
 *   PWA sends slot-keyed input frames:
 *     { k: 'joyL',        v: '<angle * 1000>' }  // heading update
 *     { k: 'joyL-thrust', v: '0'|'1' }            // thrust state
 *     { k: 'joyL-end',    v: '1' }                // joystick released
 *     { k: 'joyL-tap',    v: '1' }                // tap-fire (one-shot)
 *     { k: 'A',  v: '0'|'1' }                    // face button down/up
 *     { k: 'R1', v: '0'|'1' }                    // shoulder press/release
 *     ...
 *
 *   Host dispatches by slot name into game-specific actions.
 */

export const CONTROLLER_WS_ENDPOINT_DEFAULT = 'wss://controller.pallasite.app/';

/** Standard gamepad slots. The PWA always reserves screen real estate
 *  for these; the spec controls which become visible + how they're
 *  labelled. `joyL` and `joyR` are analog sticks (multi-frame: heading
 *  + thrust + end + tap). Everything else is a binary press. */
export type ControllerSlot =
  | 'joyL' | 'joyR'
  | 'A' | 'B' | 'X' | 'Y'
  | 'L1' | 'L2' | 'R1' | 'R2'
  | 'start' | 'select'
  | 'dpadU' | 'dpadD' | 'dpadL' | 'dpadR';

/** Per-slot configuration the host can ship to the PWA. */
export interface SlotConfig {
  /** For joystick slots only — how the analog input is interpreted.
   *  'heading' sends an angle and a thrust flag (the only mode we
   *  support today). 'xy' would send normalised x/y axes (future). */
  mode?: 'heading' | 'xy';
  /** For joystick slots: which face-button slot is "tap-fired" when
   *  the joystick gets a short press with no drag. Set to e.g. 'A' to
   *  match a quick-fire feel — the PWA emits a `joyL-tap` event the
   *  host maps to the A button's game action. */
  tapAction?: ControllerSlot;
  /** Glyph or short emoji shown on the button. */
  icon?: string;
  /** One-line label under the icon. Short — fits the button. */
  label?: string;
  /** CSS colour for the button glow + border tint. */
  colour?: string;
}

/** Controller spec — host → PWA on pair. */
export interface ControllerSpec {
  /** Human-readable game name. Shown on the PWA's status bar. */
  name: string;
  /** Spec protocol version. Bump on breaking changes. */
  version: 1;
  /** Map of slot name → config. Slots not present are hidden in the UI. */
  slots: Partial<Record<ControllerSlot, SlotConfig>>;
}

/** Frame the PWA sends over the data channel. The `k` field is a slot
 *  name (or a slot-name + suffix for joystick sub-events). */
export interface ControllerInputFrame {
  k: string;
  v: string;
}

/**
 * Paired Companion Protocol — identity layer.
 *
 * The controller PWA can carry its own Nostr identity (NIP-46 bunker,
 * NIP-07 extension, Amber, Signet, pasted nsec, or a local guest
 * keypair). On pair, the phone tells the host who it is so the host
 * can show a banner ("signing as @name") and, later, route signEvent
 * requests through the phone instead of the host's local signer.
 *
 * Step 2 ships announce + revoke only. Step 3 adds sign-request /
 * sign-response frames that turn this into a full remote signer.
 *
 * Caps describe what the signer can do (NIP-44 encrypt/decrypt, age
 * verification, etc.) so the host doesn't have to probe.
 */
export interface SignerCaps {
  canSignEvents: boolean;
  hasNip44?: boolean;
  hasAgeVerify?: boolean;
}

export interface SignerAnnounceFrame {
  type: 'signer-announce';
  /** 64-char hex secp256k1 public key. */
  pubkey: string;
  /** Optional NIP-19 npub — host can derive from pubkey if absent. */
  npub?: string;
  /** Optional display name pulled from kind 0 / guest record. */
  name?: string;
  /** Which signing method the phone is using. */
  method?: 'nip07' | 'redirect' | 'bunker' | 'nsec' | 'amber' | 'guest' | 'unknown';
  /** Signer capabilities. */
  caps?: SignerCaps;
}

export interface SignerRevokeFrame {
  type: 'signer-revoke';
}

/** Pairing token — encoded into the QR-code URL. */
export interface PairingToken {
  sessionId: string;
  ws: string;
}

/** Backwards-compat re-export for any callers still importing the
 *  legacy event-kind enum. ControllerInputKind is no longer used on
 *  the wire — it's just an alias of the slot-name string for older
 *  call sites. */
export type ControllerInputKind = string;
