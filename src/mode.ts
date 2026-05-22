/**
 * Run mode: campaign, drift, arena, sanctum, plus a bossrush stub.
 *
 * Selection persists in localStorage and is locked in at startGame, mirroring
 * the difficulty pattern. Mid-run mode changes are not supported.
 *
 * - campaign: 25-wave run ending at the boss. Default.
 * - drift:    after the wave-25 boss is downed, the run continues procedurally
 *             into wave 26+. Score events tag mode='drift' so the leaderboard
 *             can separate.
 * - bossrush: stub — picker shows it but tapping toasts COMING SOON and reverts.
 * - arena:    hard-walled cage with no wrap. The walls bounce entities and
 *             steadily close in; endless score-attack run, ends on death.
 * - sanctum:  the 600bn Sanctum experience (previously hostname-gated to
 *             600b.pallasite.app) made selectable from the main site. Council
 *             roster + the-cult bed + textured fillers. Same gameplay as
 *             flavour=600bn wave 1 but reachable from pallasite.app via Mode.
 */

export type RunMode = 'campaign' | 'drift' | 'bossrush' | 'arena' | 'sanctum' | 'defender';

const STORAGE_KEY = 'pallasite:mode';

export function getStoredMode(): RunMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'campaign' || v === 'drift' || v === 'bossrush' || v === 'arena' || v === 'sanctum' || v === 'defender') return v;
  } catch { /* ignore */ }
  return 'campaign';
}

export function setStoredMode(m: RunMode): void {
  try { localStorage.setItem(STORAGE_KEY, m); } catch { /* ignore */ }
}

let active: RunMode = 'campaign';

export function lockInMode(m: RunMode): void {
  active = m;
}

export function currentMode(): RunMode {
  return active;
}

/** True for modes that aren't fully wired yet — UI uses this to gate
 *  selection and show a COMING SOON toast instead of locking in. */
export function isModeReady(m: RunMode): boolean {
  return m === 'campaign' || m === 'drift' || m === 'arena' || m === 'sanctum' || m === 'defender';
}

/** True when the active run mode has no fixed end and continues until the
 *  player dies. Drift carries on past the wave-25 boss; arena is endless by
 *  design. Used where campaign's wave-25 completion path must keep going. */
export function isEndlessMode(): boolean {
  const m = currentMode();
  return m === 'drift' || m === 'arena' || m === 'sanctum' || m === 'defender';
}

/** True when the run is the 600bn Sanctum experience — either through
 *  the 600bn hostname-driven flavour or through the explicit Mode
 *  selection. Use this anywhere the runtime needs to branch on "is
 *  this a Sanctum run?". */
export function isSanctumMode(): boolean {
  return currentMode() === 'sanctum';
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
  { id: 'drift',    label: 'DRIFT',    hint: 'Endless. Continue past wave 25.',                          ready: true },
  { id: 'bossrush', label: 'BOSS RUSH', hint: 'Boss after boss. Coming soon.',                           ready: false },
  { id: 'arena',    label: 'ARENA',    hint: 'No wrap. Hard walls that close in.',                       ready: true },
  { id: 'sanctum',  label: 'SANCTUM',  hint: '600bn Sanctum — Council roster, the-cult bed, endless.',   ready: true },
  { id: 'defender', label: 'DEFENDER', hint: 'Protect the Council. 90s. 6 of 11 must survive.',          ready: true },
];
