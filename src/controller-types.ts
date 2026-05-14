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
 *  name (or a slot-name + suffix for joystick sub-events). The optional
 *  `p` field is set by the broker in multi-player mode (see WelcomeFrame). */
export interface ControllerInputFrame {
  k: string;
  v: string;
  /** Player slot (multi-player mode only). Broker injects on phone→host
   *  frames; hosts may set on host→phone frames to target one phone, omit
   *  to broadcast to all paired phones. */
  p?: number;
}

/**
 * Multi-player wire additions. The broker opts a session into multi-player
 * mode when the host connects with the ?multi=1 URL param. In single-player
 * mode (default) the broker forwards frames verbatim and peer-up / peer-down
 * carry no `p` field. In multi-player mode:
 *
 *   - Each phone is assigned a player slot 0..N-1 on connect.
 *   - Broker sends the phone a WelcomeFrame on connect with the slot.
 *   - Phone-to-host JSON frames have `p:<slot>` injected by the broker.
 *   - Host-to-phone frames may include `p:<slot>` to target one player,
 *     or omit `p` to broadcast to all paired phones.
 *   - peer-up / peer-down to the host carry `p:<slot>`.
 *   - Phones receive `host-up` / `host-down` (no `p`) when the host
 *     (re-)connects or drops, mirroring single-mode's peer-up/down.
 */
export interface WelcomeFrame {
  type: 'welcome';
  /** Player slot assigned by the broker for this phone. */
  p: number;
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

/** Unsigned event template the host wants the phone to sign. Minimal
 *  Nostr event shape — kind + content + tags + optional created_at. */
export interface RemoteEventTemplate {
  kind: number;
  content: string;
  tags?: string[][];
  created_at?: number;
}

/** Signed Nostr event the phone sends back in response. */
export interface RemoteSignedEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Host → phone: please sign this template. */
export interface SignRequestFrame {
  type: 'sign-request';
  /** Correlation id — phone echoes back in sign-response so the host
   *  can match concurrent requests. UUID or 8+ hex chars. */
  id: string;
  template: RemoteEventTemplate;
}

/** Phone → host: result of a sign-request. */
export type SignResponseFrame =
  | { type: 'sign-response'; id: string; ok: true; event: RemoteSignedEvent }
  | { type: 'sign-response'; id: string; ok: false; error: string };

/**
 * Haptic feedback — host → phone.
 *
 * Hosts trigger short vibrations on paired phones for tactile feedback
 * (hit, kill, button press, wall thud, race finish). Phones honour
 * requests via navigator.vibrate; iOS Safari ignores them silently,
 * Android browsers respect them.
 *
 * Two ways to specify the pattern:
 *   - `pattern: 'tap' | 'pulse' | 'thud' | 'win' | 'fail'` — one of
 *     the named presets the mobile SDK maps to a vibration sequence.
 *   - `pattern: number[]` — raw on/off durations in ms, passed straight
 *     to navigator.vibrate (e.g. [40, 30, 80]).
 *
 * The `p` field targets one phone in multi-player mode; omit it to
 * broadcast to all paired phones. Phones can suppress haptics
 * client-side (e.g. via a settings toggle); host should not assume
 * the vibration ran.
 */
export type HapticPreset = 'tap' | 'pulse' | 'thud' | 'win' | 'fail';

export interface HapticFrame {
  type: 'haptic';
  pattern: HapticPreset | number[];
  /** Player slot to target (multi-player only). Omit to broadcast. */
  p?: number;
}

/**
 * Tournament context — phone → host on pair-up.
 *
 * Phones can carry a running cross-game score in localStorage (set
 * by the pad PWA, incremented every time a game sends a GameScoreFrame
 * at the end of a round). On every pair-up the phone announces this
 * total so the game host can show "P3 entered with 17 pts" in its
 * lobby and treat the score as a tournament-wide leaderboard.
 *
 * Optional. Phones that don't keep a tournament score simply skip
 * sending the frame and games carry on as before.
 */
export interface PhoneContextFrame {
  type: 'phone-context';
  /** Running tournament total this phone has accumulated. */
  tournamentTotal: number;
  /** Optional short display name set by the pad's tournament UI. */
  name?: string;
}

/**
 * Per-game score award — host → phone, at the end of a game's final
 * round. The phone adds the award to its running total and updates
 * localStorage. Games choose their own scoring (winner = 5 + N for
 * extra effort, etc.); the protocol carries the numeric result only.
 *
 * The `p` field targets one phone in multi-player mode.
 */
export interface GameScoreFrame {
  type: 'game-score';
  /** Points to add to the phone's running tournament total. */
  score: number;
  /** Short label for the toast the phone shows (e.g. '1st!', 'right answer'). */
  label?: string;
  /** Player slot in multi-player mode. */
  p?: number;
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
