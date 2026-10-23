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
 *   hidden. Games can supply declarative portrait and landscape layouts, theme colours
 *   and bounded inline graphics; omitted layouts use the client defaults.
 *
 *   Transport: role-filtered WebSocket routing through a controller relay.
 *   Pair by sessionId and protocol version. V2 hosts prove ownership with
 *   a separate private credential; the visible code admits controllers.
 *   The relay carries controller inputs and game state only: every frame is
 *   checked against a closed grammar and rebuilt (see vocabulary.ts), so
 *   there is no free text, binary payload or signing request in transit.
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

/** The owner's own hosted relay. Used by the owner's pad and Pallasite and to
 *  shorten their pairing links. The SDKs never apply it implicitly: a host must
 *  pass its own `ws`. Run your own broker (packages/broker) for your own game. */
export const CONTROLLER_WS_ENDPOINT_DEFAULT = 'wss://controller.pallasite.app/';
export * from './controller-profile.js';
export * from './thumb-layout.js';
export * from './nostr-profile.js';
export * from './game-definition.js';
export * from './game-listing.js';
export * from './vocabulary.js';
import type { InlineGraphic, ControllerLayout, ControllerTheme } from './controller-profile.js';

/** Group human-facing six-character codes without changing wire identifiers. */
export function formatPairingCode(code: string): string {
  return /^[a-z0-9]{6}$/i.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
/** Only bare grouped codes are normalised; pairing URLs keep their exact IDs. */
export function normalizePairingCode(input: string): string {
  const value = input.trim();
  return /^[a-z0-9]{3}[\s-]+[a-z0-9]{3}$/i.test(value) ? value.replace(/[\s-]/g, '').toUpperCase() : value.toUpperCase();
}


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
  /** Inline PNG. The broker forwards only PNGs whose SHA-256 is listed in
   *  vocabulary.json; any other graphic is removed. */
  graphic?: InlineGraphic;
  /** Heading/tilt emit angle × 1000 and thrust/power. XY emits
   *  `<slot>-x`/`<slot>-y` axes in [-1000, 1000], with down-positive Y.
   *  Every mode neutralises on release, cancellation and backgrounding. */
  mode?: 'heading' | 'xy' | 'tilt';
  /** For joystick slots: which face-button slot is "tap-fired" when
   *  the joystick gets a short press with no drag. Set to e.g. 'A' to
   *  match a quick-fire feel — the PWA emits a `joyL-tap` event the
   *  host maps to the A button's game action. */
  tapAction?: ControllerSlot;
  /** Glyph or short emoji shown on the button. Must be in the vocabulary. */
  icon?: string;
  /** One-line label under the icon. Short — fits the button. Must be in the vocabulary. */
  label?: string;
  /** CSS colour for the button glow + border tint. */
  colour?: string;
}

/** Controller spec — host → PWA on pair. */
export interface ControllerSpec {
  layout?: ControllerLayout;
  theme?: ControllerTheme;
  /** Game name shown on the PWA's status bar. Must match the vocabulary's name
   *  grammar, otherwise the broker shows `GAME`. */
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

/** Host-owned answer/status feedback. Lock suppresses new input while
 * releases still pass through. It grants no execution authority. */
export interface ControllerFeedbackFrame {
  type: 'controller-feedback';
  /** Must match a vocabulary feedback template, otherwise the broker sends an empty message. */
  message: string;
  selected?: ControllerSlot | null;
  locked?: boolean;
  tone?: 'neutral' | 'success' | 'error';
  p?: number;
}

/**
 * Multi-player wire additions. The broker opts a session into multi-player
 * mode when the host connects with the ?multi=1 URL param. In single-player
 * mode (default) peer-up / peer-down
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
  /** Private capability for this session's reconnect reservation. Never put in a URL. */
  resumeToken?: string;
  resumed?: boolean;
}

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
 * Phones also send their arcade initials (three letters A to Z, entered on
 * the controller). No other text leaves a phone.
 *
 * Optional. Phones that don't keep a tournament score simply skip
 * sending the frame and games carry on as before.
 */
export interface PhoneContextFrame {
  type: 'phone-context';
  /** Running tournament total this phone has accumulated. */
  tournamentTotal: number;
  /** Optional arcade initials chosen on the controller: exactly three letters
   *  A to Z. The broker drops any other value. */
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
  /** Toast label. Must match a vocabulary score-label template. */
  label?: string;
  /** Player slot in multi-player mode. */
  p?: number;
}

/**
 * Spectator view — host → phone.
 *
 * Some games support more paired phones than they have player slots.
 * Phones beyond the player cap become spectators: they receive a
 * stripped-down ControllerSpec (typically just a CHEER button) plus
 * periodic SpectatorViewFrame updates with the current leaderboard
 * so the audience can follow along on their device.
 *
 * The leaderboard is opaque to the SDK; games supply whatever shape
 * fits their model (score, position, tournament total). The pad
 * renders it as a compact card above the controls.
 */
export interface SpectatorRow {
  /** Player slot the row represents. */
  p: number;
  /** Row label: `P2`, `P2 · BOT` or `P2 · ABC` (initials), optionally `1. ` first. */
  label: string;
  /** Primary numeric score for this game / round. */
  score: number;
  /** Optional secondary score (e.g. cross-game tournament total). */
  tournamentTotal?: number;
  /** CSS colour for the row accent stripe. */
  colour: string;
}

export interface SpectatorViewFrame {
  type: 'spectator-view';
  /** Headline: `<game> · <phase>`, e.g. "TANK ROYALE · ROUND LIVE". */
  title: string;
  /** Current standings — caller orders by relevance. */
  leaderboard: SpectatorRow[];
  /** Optional one-line highlight: `P2 · ABC cheered!` or `P2 · ABC took the round`. */
  highlight?: string;
  /** Player slot to target. Must be set in multi-player mode. */
  p?: number;
}

/** Pairing token — encoded into the QR-code URL. */
export interface PairingToken {
  sessionId: string;
  ws: string;
  /** Authenticated host ownership. Omitted only for legacy controller sessions. */
  version?: 2;
}

/** Backwards-compat re-export for any callers still importing the
 *  legacy event-kind enum. ControllerInputKind is no longer used on
 *  the wire — it's just an alias of the slot-name string for older
 *  call sites. */
export type ControllerInputKind = string;
