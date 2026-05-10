/**
 * Run mode — campaign vs drift vs (future) boss rush + arena.
 *
 * Selection persists in localStorage and is locked in at startGame, mirroring
 * the difficulty pattern. Mid-run mode changes are not supported.
 *
 * - campaign: 25-wave run ending at the boss. Default.
 * - drift:    after the wave-25 boss is downed, the run continues procedurally
 *             into wave 26+. Score events tag mode='drift' so the leaderboard
 *             can separate.
 * - bossrush: stub — picker shows it but tapping toasts COMING SOON and reverts.
 * - arena:    stub — same.
 */

export type RunMode = 'campaign' | 'drift' | 'bossrush' | 'arena';

const STORAGE_KEY = 'pallasite:mode';

export function getStoredMode(): RunMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'campaign' || v === 'drift' || v === 'bossrush' || v === 'arena') return v;
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
  return m === 'campaign' || m === 'drift';
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
  { id: 'arena',    label: 'ARENA',    hint: 'No wrap, shrinking borders. Coming soon.',                 ready: false },
];
