/**
 * One-shot achievements — milestone toasts that fire the first time a
 * player triggers a notable event in any run. Persistent in localStorage
 * so each one fires exactly once per device. Cosmetic only; no gameplay
 * effect, but the toast feels like progression dripping into the game.
 *
 * Storage: pallasite:achievements = JSON array of unlocked ids.
 */

import type { GameState } from './types.js';
import * as audio from './audio.js';

export type AchievementId =
  // First-time milestones (the meaty narrative ones)
  | 'first-kill'           // first asteroid broken
  | 'first-ufo'            // first UFO killed (any type)
  | 'first-tank'           // first tank UFO down
  | 'first-elite'          // first elite UFO down
  | 'first-sniper'         // first sniper UFO down
  | 'first-mine'           // first mine destroyed
  | 'first-vein'           // first pallasite vein collapsed
  | 'first-warp'           // first hyperspace jump
  | 'first-warp-detonate'  // first warp-through-mine clear
  | 'first-shield'         // first shield activation
  | 'first-heist'          // first wave-5 heist cleared
  | 'first-curtain'        // first bullet-curtain wave cleared
  | 'first-boss'           // first wave-25 boss kill
  | 'first-wave-25'        // first time reaching wave 25
  | 'first-drift'          // first entry into drift territory (wave 26)
  // Wave-end bonus achievements
  | 'first-carom'          // first carom kill
  | 'first-wrap'           // first wrap kill
  | 'first-risk'           // first RISK proximity tier kill
  | 'first-max-combo'      // first time hitting 5x combo
  | 'first-no-miss'        // first NO MISS wave bonus
  | 'first-no-shield'      // first NO SHIELD wave bonus
  | 'first-pacifist'       // first PACIFIST UFO wave bonus
  // Easter eggs + retention
  | 'lurker'               // discovered the lurking easter egg
  | 'streak-5'             // 5-day daily streak
  | 'streak-30';           // 30-day daily streak

interface AchievementDef {
  id: AchievementId;
  label: string;
}

export const ACHIEVEMENTS: ReadonlyArray<AchievementDef> = [
  { id: 'first-kill',          label: 'FIRST KILL' },
  { id: 'first-ufo',           label: 'UFO DOWN' },
  { id: 'first-tank',          label: 'TANK BUSTED' },
  { id: 'first-elite',         label: 'ELITE DOWN' },
  { id: 'first-sniper',        label: 'SNIPER PICKED' },
  { id: 'first-mine',          label: 'MINE CLEARED' },
  { id: 'first-vein',          label: 'FIRST VEIN COLLAPSED' },
  { id: 'first-warp',          label: 'FIRST WARP' },
  { id: 'first-warp-detonate', label: 'WARP DETONATION' },
  { id: 'first-shield',        label: 'SHIELDS UP' },
  { id: 'first-heist',         label: 'HEIST CRACKED' },
  { id: 'first-curtain',       label: 'CURTAIN CLOSED' },
  { id: 'first-boss',          label: 'EVENT HORIZON CLEARED' },
  { id: 'first-wave-25',       label: 'REACHED THE HORIZON' },
  { id: 'first-drift',         label: 'BEYOND THE HORIZON' },
  { id: 'first-carom',         label: 'CAROM KILL' },
  { id: 'first-wrap',          label: 'WRAP KILL' },
  { id: 'first-risk',          label: 'RISK BONUS' },
  { id: 'first-max-combo',     label: 'COMBO ×5 MAX' },
  { id: 'first-no-miss',       label: 'NO MISS WAVE' },
  { id: 'first-no-shield',     label: 'NO SHIELD WAVE' },
  { id: 'first-pacifist',      label: 'PACIFIST' },
  { id: 'lurker',              label: '1979 RESPECT' },
  { id: 'streak-5',            label: 'FIVE-DAY STREAK' },
  { id: 'streak-30',           label: 'THIRTY-DAY STREAK' },
];

/** All-unlocked count + total — for a future BADGES panel in settings.
 *  Cheap to compute since the list is tiny. */
export function getAchievementProgress(): { unlocked: number; total: number } {
  return { unlocked: unlocked().size, total: ACHIEVEMENTS.length };
}

const KEY = 'pallasite:achievements';

function loadSet(): Set<AchievementId> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed as AchievementId[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveSet(set: Set<AchievementId>): void {
  try { localStorage.setItem(KEY, JSON.stringify(Array.from(set))); } catch { /* quota */ }
}

let memo: Set<AchievementId> | null = null;
function unlocked(): Set<AchievementId> {
  if (memo === null) memo = loadSet();
  return memo;
}

/** True if the player has already unlocked this achievement on this
 *  device. */
export function hasAchievement(id: AchievementId): boolean {
  return unlocked().has(id);
}

/**
 * Award an achievement — idempotent. First call persists and fires a
 * gold toast + chime; subsequent calls are no-ops. Looks up the label
 * from the ACHIEVEMENTS table by id so call sites stay terse.
 */
export function markAchievement(s: GameState, id: AchievementId): void {
  const set = unlocked();
  if (set.has(id)) return;
  set.add(id);
  saveSet(set);
  const def = ACHIEVEMENTS.find(a => a.id === id);
  const label = def?.label ?? id.toUpperCase();
  // Distinct toast — prefixed so it reads as a milestone rather than
  // a per-event flash. The toast slot is single-line; chiming via the
  // existing level-up sting + the ★ prefix lifts it above wave-end
  // bonus toasts.
  s.toast = `★ ${label}`;
  s.toastUntil = performance.now() + 3000;
  try { audio.levelUp(); } catch { /* ignore */ }
}
