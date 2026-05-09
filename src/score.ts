/**
 * Score persistence and Nostr leaderboard publishing.
 *
 * Local: top-10 in localStorage.
 * Nostr: kind 30762 player-signed events (gamestr.io spec).
 *        Server-side faucet payout endpoint deferred — first session ships read-only leaderboards.
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { GAME_ID } from './auth.js';
import { getActiveRelays } from './relays.js';

const HIGHSCORE_KEY = 'pallasite:highscores';
const MAX_LOCAL = 10;

export interface HighScoreEntry {
  /** Initials or display name */
  name: string;
  score: number;
  sats: number;
  wave: number;
  /** ISO timestamp */
  at: string;
  /** Nostr pubkey if signed (may be local-only) */
  pubkey?: string;
  /** kind 30762 event id if published */
  eventId?: string;
}

export function getLocalHighScores(): HighScoreEntry[] {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is HighScoreEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as HighScoreEntry).name === 'string' &&
      typeof (e as HighScoreEntry).score === 'number',
    );
  } catch {
    return [];
  }
}

export function addLocalHighScore(entry: HighScoreEntry): HighScoreEntry[] {
  const existing = getLocalHighScores();
  existing.push(entry);
  existing.sort((a, b) => b.score - a.score);
  const trimmed = existing.slice(0, MAX_LOCAL);
  try {
    localStorage.setItem(HIGHSCORE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage unavailable
  }
  return trimmed;
}

export function isHighScore(score: number): boolean {
  const list = getLocalHighScores();
  if (list.length < MAX_LOCAL) return score > 0;
  return score > list[list.length - 1].score;
}

/**
 * Publish a kind 30762 score event to Nostr relays.
 *
 * Uses the consumer-side player-signed approach (gamestr.io). The signer is
 * the player's own NIP-07/bunker session. Score is signed by the player.
 */
export async function publishScore(
  session: SignetSession,
  scoreData: { score: number; sats: number; wave: number; durationSeconds: number; state?: 'active' | 'completed'; seed?: string | null },
  relays: readonly string[] = getActiveRelays(),
): Promise<{ event: NostrEvent; publishedTo: string[]; failed: string[] } | null> {
  if (!session.signer.capabilities.canSignEvents) {
    return null;
  }

  const state = scoreData.state ?? 'active';
  const seedSuffix = scoreData.seed ? `:daily-${scoreData.seed}` : '';
  const dTag = `${GAME_ID}:${session.pubkey}:wave-${scoreData.wave}${seedSuffix}`;

  const tags: string[][] = [
    ['d', dTag],
    ['game', GAME_ID],
    ['score', scoreData.score.toString()],
    ['p', session.pubkey],
    ['state', state],
    ['wave', scoreData.wave.toString()],
    ['sats', scoreData.sats.toString()],
    ['duration', scoreData.durationSeconds.toString()],
    ['t', 'arcade'],
    ['t', 'asteroids'],
    ['t', 'lightning'],
  ];
  if (scoreData.seed) {
    tags.push(['seed', scoreData.seed]);
    tags.push(['t', 'daily']);
  }

  const template = {
    kind: 30762,
    content: scoreData.sats > 0 ? `Earned ${scoreData.sats} sats on wave ${scoreData.wave}` : '',
    tags,
  };

  const signed = await session.signer.signEvent(template);

  const publishedTo: string[] = [];
  const failed: string[] = [];
  await Promise.all(relays.map(url => publishToRelay(url, signed).then(
    () => publishedTo.push(url),
    () => failed.push(url),
  )));

  return { event: signed, publishedTo, failed };
}

function publishToRelay(url: string, event: NostrEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('relay-timeout'));
    }, 5000);

    ws.onopen = () => {
      ws.send(JSON.stringify(['EVENT', event]));
    };
    ws.onmessage = ev => {
      try {
        const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (msg[2] === true) resolve();
          else reject(new Error(typeof msg[3] === 'string' ? msg[3] : 'rejected'));
        }
      } catch {
        // ignore
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('relay-error'));
    };
  });
}
