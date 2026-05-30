/**
 * Run mode: campaign, co-op campaign, drift, arena, deathmatch, sanctum,
 * duel, plus a bossrush stub.
 *
 * Selection persists in localStorage and is locked in at startGame, mirroring
 * the difficulty pattern. Mid-run mode changes are not supported.
 *
 * - campaign: 25-wave run ending at the boss. Default.
 * - coop-campaign: two-player lockstep campaign. Same waves as campaign,
 *                  separate leaderboard, no sats payouts.
 * - drift:    after the wave-25 boss is downed, the run continues procedurally
 *             into wave 26+. Score events tag mode='drift' so the leaderboard
 *             can separate.
 * - bossrush: stub — picker shows it but tapping toasts COMING SOON and reverts.
 * - arena:    hard-walled cage with no wrap. The walls bounce entities and
 *             steadily close in; endless score-attack run, ends on death.
 * - deathmatch: large non-wrapping square arena with radar, cover-scale
 *               asteroids, and AI ships. First slice for future N-player MP.
 * - sanctum:  the 600bn Sanctum experience (previously hostname-gated to
 *             600b.pallasite.app) made selectable from the main site. Council
 *             roster + the-cult bed + textured fillers. Same gameplay as
 *             flavour=600bn wave 1 but reachable from pallasite.app via Mode.
 * - duel:     meta-mode that routes IGNITE to the /duel lobby instead of
 *             starting a solo run. lockInMode normalises it back to 'campaign'
 *             so the gameplay code (currentMode, isEndlessMode, etc.) never
 *             observes it — the stored value just remembers the player's
 *             choice between sessions and drives the title-screen IGNITE
 *             label + navigation.
 */

export type RunMode = 'campaign' | 'coop-campaign' | 'drift' | 'bossrush' | 'arena' | 'deathmatch' | 'sanctum' | 'defender' | 'duel';

const STORAGE_KEY = 'pallasite:mode';

export function getStoredMode(): RunMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // 'defender' used to be exposed in the Mode picker as a visual demo.
    // It has since been removed from MODE_LIST in favour of splitting
    // Defender out into its own game, so a stored 'defender' from an
    // earlier build is normalised back to 'campaign'. The ?defenderMode=1
    // URL flag in main.ts is unaffected — it doesn't read this storage.
    if (v === 'campaign' || v === 'coop-campaign' || v === 'drift' || v === 'bossrush' || v === 'arena' || v === 'deathmatch' || v === 'sanctum' || v === 'duel') return v;
    if (v === 'defender') {
      try { localStorage.setItem(STORAGE_KEY, 'campaign'); } catch { /* ignore */ }
      return 'campaign';
    }
  } catch { /* ignore */ }
  return 'campaign';
}

export function setStoredMode(m: RunMode): void {
  try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
}

let active: RunMode = 'campaign';

export function lockInMode(m: RunMode): void {
  // 'duel' is a title-screen meta-mode that routes to /duel — gameplay code
  // should never see it as the active mode. The duel lobby + peer arena run
  // on campaign rules; normalise here so currentMode() callers stay simple.
  active = m === 'duel' ? 'campaign' : m;
}

export function currentMode(): RunMode {
  return active;
}

/** True for modes that aren't fully wired yet — UI uses this to gate
 *  selection and show a COMING SOON toast instead of locking in. */
export function isModeReady(m: RunMode): boolean {
  return m === 'campaign' || m === 'coop-campaign' || m === 'drift' || m === 'arena' || m === 'deathmatch' || m === 'sanctum' || m === 'defender';
}

/** True when the active run mode has no fixed end and continues until the
 *  player dies. Drift carries on past the wave-25 boss; arena/deathmatch are endless by
 *  design. Used where campaign's wave-25 completion path must keep going. */
export function isEndlessMode(): boolean {
  const m = currentMode();
  return m === 'drift' || m === 'arena' || m === 'deathmatch' || m === 'sanctum' || m === 'defender';
}

/** True when the run is the 600bn Sanctum experience — either through
 *  the 600bn hostname-driven flavour or through the explicit Mode
 *  selection. Use this anywhere the runtime needs to branch on "is
 *  this a Sanctum run?". */
export function isSanctumMode(): boolean {
  return currentMode() === 'sanctum';
}

/** True for the two-player campaign mode. It deliberately follows the
 *  campaign wave table, but score and payout surfaces branch on this helper
 *  so co-op never mixes with the sats-paying solo board. */
export function isCoopCampaignMode(): boolean {
  return currentMode() === 'coop-campaign';
}

/** True when the run is the Defender bonus wave — currently driven
 *  only by the Mode picker. The `?defender=1` URL flag also reaches
 *  the same gameplay path via startGame's `defender` opt, but for
 *  in-run "are we in defender" checks (radar forced on, parallax bg,
 *  follow camera in landscape), use this helper. */
export function isDefenderMode(): boolean {
  return currentMode() === 'defender';
}

/** Stored-mode flavour of isDefenderMode — used at boot in fit()
 *  before lockInMode runs in startGame. Reading the stored mode
 *  lets the follow camera + parallax bg engage from the first
 *  frame after the player picks DEFENDER, rather than only after
 *  IGNITE. */
export function isStoredDefenderMode(): boolean {
  return getStoredMode() === 'defender';
}

export interface ModeInfo {
  id: RunMode;
  label: string;
  hint: string;
  ready: boolean;
}

export const MODE_LIST: readonly ModeInfo[] = [
  { id: 'campaign', label: 'CAMPAIGN', hint: '25 waves, boss at the horizon.',                           ready: true },
  { id: 'coop-campaign', label: 'CO-OP', hint: 'Two pilots clear campaign together. Separate board, no sats.', ready: true },
  { id: 'drift',    label: 'DRIFT',    hint: 'Endless. Continue past wave 25.',                          ready: true },
  { id: 'bossrush', label: 'BOSS RUSH', hint: 'Boss after boss. Coming soon.',                           ready: false },
  { id: 'arena',    label: 'ARENA',    hint: 'No wrap. Hard walls that close in.',                       ready: true },
  { id: 'deathmatch', label: 'DEATHMATCH', hint: 'Host 2 or 4 pilots in a large radar arena.',            ready: true },
  { id: 'sanctum',  label: 'SANCTUM',  hint: '600bn Sanctum — Council roster, the-cult bed, endless.',   ready: true },
  { id: 'duel',     label: 'DUEL',     hint: 'Two ships, one arena. Host or join over the broker.',      ready: true },
];
