/** Public run receipts only. Signing keys and credentials never enter storage. */
import type { SignetSession } from 'signet-login';
import type { SoloScoreInput, SoloScoreResult } from './faucet.js';

export const SOLO_SCORE_OUTBOX_KEY = 'pallasite.pending-solo-scores.v1';
export interface PendingSoloScore { pubkey: string; input: SoloScoreInput; }
type Submit = (session: SignetSession, input: SoloScoreInput) => Promise<SoloScoreResult>;
const MAX_STORED_BYTES = 256_000;
const id = (record: PendingSoloScore): string => `${record.pubkey}:${record.input.run_id}`;
function valid(value: unknown): value is PendingSoloScore {
  if (!value || typeof value !== 'object') return false;
  const record = value as PendingSoloScore;
  const input = record.input;
  return typeof record.pubkey === 'string' && /^[0-9a-f]{64}$/.test(record.pubkey)
    && !!input && typeof input === 'object'
    && Number.isFinite(input.score) && input.score > 0
    && Number.isInteger(input.wave) && input.wave >= 0
    && Number.isFinite(input.duration_ms) && input.duration_ms >= 0
    && typeof input.run_id === 'string' && /^\d{1,20}$/.test(input.run_id)
    && ['campaign', 'drift', 'bossrush', 'arena'].includes(input.mode ?? '')
    && (input.room === undefined || ['main', '600bn'].includes(input.room))
    && (input.player_name === undefined || typeof input.player_name === 'string' && input.player_name.length <= 256)
    && (input.nip05 === undefined || typeof input.nip05 === 'string' && input.nip05.length <= 320)
    && (input.cheated === undefined || typeof input.cheated === 'boolean');
}

export class SoloScoreOutbox {
  private readonly records = new Map<string, PendingSoloScore>();
  private readonly active = new Map<string, Promise<SoloScoreResult>>();
  durable = true;
  constructor(private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {
    try {
      const text = storage().getItem(SOLO_SCORE_OUTBOX_KEY);
      if (text && text.length <= MAX_STORED_BYTES) {
        const entries: unknown = JSON.parse(text);
        if (Array.isArray(entries)) for (const record of entries) {
          if (valid(record)) this.records.set(id(record), record);
        }
      }
    } catch { this.durable = false; }
  }
  private persist(): void {
    try {
      const text = JSON.stringify([...this.records.values()]);
      if (text.length > MAX_STORED_BYTES) throw new Error('outbox-full');
      this.storage().setItem(SOLO_SCORE_OUTBOX_KEY, text);
      this.durable = true;
    } catch { this.durable = false; }
  }
  enqueue(pubkey: string, input: SoloScoreInput): PendingSoloScore {
    const record = { pubkey, input: { ...input } };
    if (!valid(record)) throw new Error('invalid-score-receipt');
    const existing = this.records.get(id(record));
    if (existing) return { pubkey: existing.pubkey, input: { ...existing.input } };
    this.records.set(id(record), record);
    this.persist();
    return { pubkey, input: { ...record.input } };
  }
  pending(pubkey: string): PendingSoloScore[] {
    return [...this.records.values()].filter(record => record.pubkey === pubkey)
      .map(record => ({ pubkey, input: { ...record.input } }));
  }
  retry(record: PendingSoloScore, session: SignetSession | null, submit: Submit): Promise<SoloScoreResult> {
    const key = id(record);
    const stored = this.records.get(key);
    if (!stored) return Promise.resolve({ ok: false, error: 'receipt-unavailable' });
    if (!session || session.pubkey !== stored.pubkey || session.signer.pubkey !== stored.pubkey) {
      return Promise.resolve({ ok: false, error: 'wrong-account' });
    }
    if (!session.signer.capabilities.canSignEvents) return Promise.resolve({ ok: false, error: 'no_signer' });
    const running = this.active.get(key);
    if (running) return running;
    const selected = { ...session, signer: session.signer };
    const attempt = Promise.resolve().then(() => {
      if (selected.signer.pubkey !== stored.pubkey) return { ok: false as const, error: 'wrong-account' };
      return submit(selected, { ...stored.input });
    })
      .catch((): SoloScoreResult => ({ ok: false, error: 'submission-failed' }))
      .then((result): SoloScoreResult => {
        if (!result || typeof result.ok !== 'boolean') return { ok: false, error: 'bad-response' };
        if (result.ok && Number.isInteger(result.published?.ok) && result.published.ok > 0 && typeof result.id === 'string' && result.id.length > 0) {
          this.records.delete(key);
          this.persist();
        } else if (result.ok) return { ok: false, error: 'publication-unconfirmed' };
        return result;
      }).finally(() => { this.active.delete(key); });
    this.active.set(key, attempt);
    return attempt;
  }
}
