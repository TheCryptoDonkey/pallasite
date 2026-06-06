/**
 * NIP-57 zaps.
 *
 * Flow:
 *   1. Resolve LUD-16 → fetch lnurlp metadata
 *   2. If signed-in and the endpoint allows nostr: build kind 9734 zap request
 *   3. Fetch BOLT11 invoice from the callback (with the zap request encoded)
 *   4. Caller pays via WebLN, copy-paste, or `lightning:` URI
 *
 * If the player isn't signed in or the endpoint rejects nostr, we fall back to
 * a plain LNURL pay (no zap receipt, but the dev still gets the sats).
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { DEV } from './credits.js';
import { getActiveRelays } from './relays.js';
import { encodeLNURL } from './bech32.js';

export interface LNURLPMetadata {
  callback: string;
  minSendable: number;  // millisats
  maxSendable: number;  // millisats
  metadata: string;
  tag: string;
  allowsNostr?: boolean;
  nostrPubkey?: string;
  commentAllowed?: number;
}

async function resolveLightningAddress(addr: string): Promise<{ url: string; meta: LNURLPMetadata }> {
  const [name, domain] = addr.split('@');
  if (!name || !domain) throw new Error('invalid lightning address');
  const url = `https://${domain}/.well-known/lnurlp/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lnurlp ${res.status}`);
  const meta = await res.json() as LNURLPMetadata;
  if (meta.tag !== 'payRequest') throw new Error('not a payRequest endpoint');
  return { url, meta };
}

async function buildZapRequest(
  session: SignetSession,
  recipientPubkey: string,
  amountMsats: number,
  comment: string,
  lnurlEncoded: string,
  relays: readonly string[],
): Promise<NostrEvent> {
  return await session.signer.signEvent({
    kind: 9734,
    content: comment,
    tags: [
      ['relays', ...relays],
      ['amount', amountMsats.toString()],
      ['lnurl', lnurlEncoded],
      ['p', recipientPubkey],
    ],
  });
}

async function fetchInvoice(callback: string, amountMsats: number, zapRequest: NostrEvent | null, comment?: string): Promise<string> {
  const params = new URLSearchParams();
  params.set('amount', amountMsats.toString());
  if (zapRequest) params.set('nostr', JSON.stringify(zapRequest));
  else if (comment) params.set('comment', comment);
  const sep = callback.includes('?') ? '&' : '?';
  const url = `${callback}${sep}${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`invoice ${res.status}`);
  const data = await res.json();
  if (data.status === 'ERROR') throw new Error(data.reason || 'lnurl error');
  if (typeof data.pr !== 'string') throw new Error('no invoice in response');
  return data.pr;
}

export interface ZapResult {
  invoice: string;
  /** True if this was a NIP-57 zap (signed request); false for plain LNURL pay. */
  isZap: boolean;
  amountSats: number;
}

export interface ZapRecipient {
  /** Hex pubkey — the kind 9734 zap request's `p` tag. */
  pubkey: string;
  /** name@domain — resolved via /.well-known/lnurlp/{name}. */
  lightningAddress: string;
}

/**
 * Request an invoice that zaps `recipient`. NIP-57 zap receipt when the
 * endpoint allows nostr AND the session can sign events; plain LNURL pay
 * otherwise. The sats still land at the recipient either way — the
 * receipt is optional.
 *
 * Generalised from the original dev-only path so the watch page can zap
 * any player by their lud16.
 */
export async function requestZapTo(opts: {
  recipient: ZapRecipient;
  session: SignetSession | null;
  amountSats: number;
  comment?: string;
  relays?: readonly string[];
}): Promise<ZapResult> {
  const { recipient, session, amountSats } = opts;
  const comment = opts.comment ?? '';
  const relays = opts.relays ?? getActiveRelays();
  if (amountSats <= 0 || !Number.isFinite(amountSats)) throw new Error('invalid amount');
  const amountMsats = Math.floor(amountSats) * 1000;

  const { url, meta } = await resolveLightningAddress(recipient.lightningAddress);
  if (amountMsats < meta.minSendable) throw new Error(`min ${Math.ceil(meta.minSendable / 1000)} sats`);
  if (amountMsats > meta.maxSendable) throw new Error(`max ${Math.floor(meta.maxSendable / 1000)} sats`);

  const canZap = meta.allowsNostr === true && session?.signer.capabilities.canSignEvents === true;
  if (canZap && session) {
    const lnurlEncoded = encodeLNURL(url);
    const zapRequest = await buildZapRequest(session, recipient.pubkey, amountMsats, comment, lnurlEncoded, relays);
    const invoice = await fetchInvoice(meta.callback, amountMsats, zapRequest);
    return { invoice, isZap: true, amountSats: Math.floor(amountSats) };
  }

  const allowedComment = meta.commentAllowed ?? 0;
  const trimmedComment = allowedComment > 0 ? comment.slice(0, allowedComment) : '';
  const invoice = await fetchInvoice(meta.callback, amountMsats, null, trimmedComment);
  return { invoice, isZap: false, amountSats: Math.floor(amountSats) };
}

/**
 * Static LNURL-pay string (bech32, uppercase `LNURL1…`) for the operator's
 * lightning address — derived deterministically from the lud16, no network
 * round-trip. The "zap us" QR encodes this: any wallet scans it, resolves the
 * LNURL, and the payer picks the amount. One always-valid QR, no expiring
 * invoice. (For a fixed amount / NIP-57 zap receipt use {@link requestZapInvoice}.)
 */
export function devLnurl(): string {
  const [name, domain] = DEV.lightningAddress.split('@');
  if (!name || !domain) throw new Error('invalid dev lightning address');
  return encodeLNURL(`https://${domain}/.well-known/lnurlp/${name}`);
}

/** Zap the dev (sugar over {@link requestZapTo}). */
export async function requestZapInvoice(
  session: SignetSession | null,
  amountSats: number,
  comment: string,
  relays: readonly string[] = getActiveRelays(),
): Promise<ZapResult> {
  return requestZapTo({
    recipient: { pubkey: DEV.pubkey, lightningAddress: DEV.lightningAddress },
    session,
    amountSats,
    comment,
    relays,
  });
}

// ── WebLN bridge ─────────────────────────────────────────────────────────────

declare global {
  interface Window {
    webln?: {
      enable: () => Promise<void>;
      sendPayment: (paymentRequest: string) => Promise<{ preimage: string }>;
    };
  }
}

export function hasWebLN(): boolean {
  return typeof window !== 'undefined' && typeof window.webln !== 'undefined';
}

export async function payViaWebLN(invoice: string): Promise<{ preimage: string }> {
  if (!window.webln) throw new Error('No WebLN provider — install Alby or similar');
  await window.webln.enable();
  return window.webln.sendPayment(invoice);
}
