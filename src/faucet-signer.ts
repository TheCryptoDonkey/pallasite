/**
 * FaucetSigner — a SignetSigner that delegates signing to the self-hosted
 * faucet's /api/kiosk/sign endpoint.
 *
 * For an unattended booth: the kiosk's private key lives in the faucet's env
 * (KIOSK_NSEC) and NEVER reaches the browser. This signer just POSTs an event
 * template and gets a signed event back, so the client can publish (replays,
 * NIP-98 uploads) as the kiosk player without holding a key. The endpoint is
 * LAN-gated at the proxy — see pallasite-faucet/deploy/nginx-pallasite.conf.
 */
import type { EventTemplate, NostrEvent, SignetSigner } from 'signet-login';

const KIOSK_BASE = '/api/kiosk';

export interface KioskInfo {
  enabled: boolean;
  pubkey: string | null;
}

/**
 * Probe this deploy for a configured kiosk identity. Returns null on any
 * failure — no kiosk route (404 on a normal deploy), network error, or
 * disabled — so callers cleanly fall back to the normal sign-in picker.
 */
export async function fetchKioskInfo(): Promise<KioskInfo | null> {
  try {
    const res = await fetch(`${KIOSK_BASE}/info`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const info = (await res.json()) as KioskInfo;
    if (!info?.enabled || !info.pubkey || !/^[0-9a-f]{64}$/i.test(info.pubkey)) return null;
    return { enabled: true, pubkey: info.pubkey.toLowerCase() };
  } catch {
    return null;
  }
}

export class FaucetSigner implements SignetSigner {
  // Remote/delegated signing — closest existing method label.
  readonly method = 'bunker' as const;
  readonly capabilities = { canSignEvents: true, hasNip44: false };

  constructor(public readonly pubkey: string) {}

  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    const res = await fetch(`${KIOSK_BASE}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: template.kind,
        content: template.content,
        tags: template.tags ?? [],
        created_at: template.created_at,
      }),
    });
    if (!res.ok) {
      throw new Error(`kiosk sign failed: HTTP ${res.status}`);
    }
    const ev = (await res.json()) as NostrEvent;
    // Defence: the faucet must return our pubkey's signed event. A mismatch
    // means a misconfigured deploy — don't publish under a wrong identity.
    if (!ev || ev.pubkey !== this.pubkey || !/^[0-9a-f]{128}$/.test(ev.sig ?? '')) {
      throw new Error('kiosk sign returned an invalid event');
    }
    return ev;
  }

  async close(): Promise<void> {
    /* nothing to close — stateless HTTP delegation */
  }
}
