/** Public run receipts only. Signing keys and credentials never enter storage. */
import type { SignetSession } from 'signet-login';
import type { SoloScoreInput, SoloScoreResult } from './faucet.js';

export const SOLO_SCORE_OUTBOX_KEY = 'pallasite.pending-solo-scores.v1';
export interface PendingSoloScore { pubkey: string; input: SoloScoreInput; lastError?: string; rejected?: boolean; }
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
    && (input.cheated === undefined || typeof input.cheated === 'boolean')
    && (input.started_at === undefined || Number.isSafeInteger(input.started_at) && input.started_at > 0)
    && (input.finished_at === undefined || Number.isSafeInteger(input.finished_at) && input.finished_at > 0)
    && (record.lastError === undefined || typeof record.lastError === 'string' && record.lastError.length <= 160)
    && (record.rejected === undefined || typeof record.rejected === 'boolean');
}

export class SoloScoreOutbox {
  private readonly records = new Map<string, PendingSoloScore>();
  private readonly active = new Map<string, Promise<SoloScoreResult>>();
  durable = true;
  storageProblem: 'unavailable' | 'corrupt' | null = null;
  constructor(private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => localStorage) {
    try {
      const text = storage().getItem(SOLO_SCORE_OUTBOX_KEY);
      if (text) {
        if (text.length > MAX_STORED_BYTES) throw new Error('outbox-too-large');
        const entries: unknown = JSON.parse(text);
        if (!Array.isArray(entries)) throw new Error('invalid-outbox');
        for (const record of entries) {
          if (valid(record) && !this.records.has(id(record))) this.records.set(id(record), record);
          else this.storageProblem = 'corrupt';
        }
        if (this.storageProblem) this.durable = false;
      }
    } catch {
      this.durable = false;
      // Preserve unreadable existing data, including oversize/corrupt JSON.
      try { this.storageProblem = storage().getItem(SOLO_SCORE_OUTBOX_KEY) ? 'corrupt' : 'unavailable'; }
      catch { this.storageProblem = 'unavailable'; }
    }
  }
  private persist(): void {
    if (this.storageProblem === 'corrupt') { this.durable = false; return; }
    try {
      const text = JSON.stringify([...this.records.values()]);
      if (text.length > MAX_STORED_BYTES) throw new Error('outbox-full');
      this.storage().setItem(SOLO_SCORE_OUTBOX_KEY, text);
      this.durable = true;
      this.storageProblem = null;
    } catch { this.durable = false; this.storageProblem = 'unavailable'; }
  }
  enqueue(pubkey: string, input: SoloScoreInput): PendingSoloScore {
    const record = { pubkey, input: { ...input } };
    if (!valid(record)) throw new Error('invalid-score-receipt');
    const existing = this.records.get(id(record));
    if (existing) return { ...existing, input: { ...existing.input } };
    this.records.set(id(record), record);
    this.persist();
    return { pubkey, input: { ...record.input } };
  }
  pending(pubkey: string): PendingSoloScore[] {
    return [...this.records.values()].filter(record => record.pubkey === pubkey)
      .map(record => ({ ...record, input: { ...record.input } }));
  }
  /** Remove only the selected owner's retry copy; never a published score. */
  remove(record: PendingSoloScore, pubkey: string): boolean {
    const key = id(record);
    if (record.pubkey !== pubkey || !this.records.has(key) || this.active.has(key) || this.storageProblem === 'corrupt') return false;
    const stored = this.records.get(key)!;
    this.records.delete(key);
    this.persist();
    if (!this.durable) { this.records.set(key, stored); return false; }
    return true;
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
        if (!result || typeof result.ok !== 'boolean' || !result.ok && (typeof result.error !== 'string' || !result.error)) result = { ok: false, error: 'bad-response' };
        if (result.ok && Number.isInteger(result.published?.ok) && result.published.ok > 0 && Number.isInteger(result.published.total) && result.published.total >= result.published.ok && typeof result.id === 'string' && /^[0-9a-f]{64}$/.test(result.id)) {
          this.records.delete(key);
          this.persist();
        } else {
          const failure = result.ok ? { ok: false as const, error: 'publication-unconfirmed' } : result;
          stored.lastError = failure.error.slice(0, 160);
          stored.rejected = 'status' in failure && [400, 409, 422].includes(failure.status as number);
          this.persist();
          return failure;
        }
        return result;
      }).finally(() => { this.active.delete(key); });
    this.active.set(key, attempt);
    return attempt;
  }
}
