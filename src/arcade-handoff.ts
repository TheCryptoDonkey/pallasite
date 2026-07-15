import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { EventTemplate, NostrEvent, SignetAuthEvent, SignetSession, SignetSigner } from 'signet-login';

const ARCADE_ORIGIN = 'https://arcade.600.wtf';
const ARCADE_APP = '600 Billion Arcade';
const FRAGMENT_KEY = 'gamestr-auth';
const PROTOCOL = 'gamestr-auth-v1';
const MAX_PROOF_AGE_SECONDS = 30 * 24 * 60 * 60;
const CONNECT_TIMEOUT_MS = 4_000;
const SIGN_TIMEOUT_MS = 45_000;

interface HandoffPayload {
  v: 1;
  game: string;
  target: string;
  channel: string;
  canSign: boolean;
  profile?: { name?: string; nip05?: string; picture?: string };
  event: NostrEvent;
}

interface PendingSign {
  template: Required<EventTemplate>;
  resolve: (event: NostrEvent) => void;
  reject: (error: Error) => void;
  timer: number;
}

function eventTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(tag => tag[0] === name)?.[1];
}

function decodePayload(token: string): HandoffPayload | null {
  if (!/^[A-Za-z0-9_-]{1,12000}$/.test(token)) return null;
  try {
    const padded = token.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - token.length % 4) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return JSON.parse(new TextDecoder().decode(bytes)) as HandoffPayload;
  } catch {
    return null;
  }
}

function isNostrEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<NostrEvent>;
  return typeof event.id === 'string' && /^[0-9a-f]{64}$/.test(event.id)
    && typeof event.pubkey === 'string' && /^[0-9a-f]{64}$/.test(event.pubkey)
    && typeof event.sig === 'string' && /^[0-9a-f]{128}$/.test(event.sig)
    && Number.isSafeInteger(event.kind)
    && Number.isSafeInteger(event.created_at)
    && typeof event.content === 'string'
    && Array.isArray(event.tags)
    && event.tags.every(tag => Array.isArray(tag) && tag.every(item => typeof item === 'string'));
}

function verifyEvent(event: NostrEvent): boolean {
  try {
    const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
    const id = bytesToHex(sha256(new TextEncoder().encode(canonical)));
    return event.id === id && schnorr.verify(hexToBytes(event.sig), hexToBytes(id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

function validPayload(payload: HandoffPayload | null, gameId: string, targetOrigin: string, now: number): payload is HandoffPayload {
  if (!payload || payload.v !== 1 || payload.game !== gameId || payload.target !== targetOrigin) return false;
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(payload.channel) || typeof payload.canSign !== 'boolean') return false;
  const event = payload.event;
  if (!isNostrEvent(event) || event.kind !== 21236 || !verifyEvent(event)) return false;
  if (event.created_at > now + 300 || event.created_at < now - MAX_PROOF_AGE_SECONDS) return false;
  return eventTag(event, 'origin') === ARCADE_ORIGIN && eventTag(event, 'app') === ARCADE_APP;
}

function stripHandoffFragment(): void {
  const fragment = new URLSearchParams(location.hash.slice(1));
  fragment.delete(FRAGMENT_KEY);
  const remaining = fragment.toString();
  history.replaceState(null, '', `${location.pathname}${location.search}${remaining ? `#${remaining}` : ''}`);
}

function profileName(profile: HandoffPayload['profile']): string | undefined {
  return typeof profile?.name === 'string' ? profile.name.trim().slice(0, 80) || undefined : undefined;
}

function sameTemplate(event: NostrEvent, template: Required<EventTemplate>): boolean {
  return event.kind === template.kind
    && event.created_at === template.created_at
    && event.content === template.content
    && JSON.stringify(event.tags) === JSON.stringify(template.tags);
}

class ArcadeSigner implements SignetSigner {
  readonly method = 'bunker' as const;
  readonly capabilities: { canSignEvents: boolean; hasNip44: false };
  private readonly pending = new Map<string, PendingSign>();
  private connected = false;
  private closed = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;

  constructor(readonly pubkey: string, private readonly port: MessagePort, canSign: boolean) {
    this.capabilities = { canSignEvents: canSign, hasNip44: false };
    port.onmessage = message => this.handleMessage(message.data);
    port.start();
  }

  waitUntilConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.connectResolve = null;
        this.connectReject = null;
        reject(new Error('arcade-connect-timeout'));
      }, CONNECT_TIMEOUT_MS);
      this.connectResolve = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.connectReject = error => {
        window.clearTimeout(timer);
        reject(error);
      };
    });
  }

  signEvent(template: EventTemplate): Promise<NostrEvent> {
    if (this.closed || !this.capabilities.canSignEvents) return Promise.reject(new Error('signer-unavailable'));
    const normalized: Required<EventTemplate> = {
      kind: template.kind,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      tags: template.tags ?? [],
      content: template.content,
    };
    const id = crypto.randomUUID();
    return new Promise<NostrEvent>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('arcade-sign-timeout'));
      }, SIGN_TIMEOUT_MS);
      this.pending.set(id, { template: normalized, resolve, reject, timer });
      this.port.postMessage({ protocol: PROTOCOL, type: 'sign', id, event: normalized });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    this.connectReject?.(new Error('arcade-signer-closed'));
    this.connectResolve = null;
    this.connectReject = null;
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timer);
      request.reject(new Error('arcade-signer-closed'));
    }
    this.pending.clear();
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { protocol?: unknown; type?: unknown; id?: unknown; ok?: unknown; event?: unknown; error?: unknown };
    if (message.protocol !== PROTOCOL) return;
    if (message.type === 'connected') {
      this.connected = true;
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
      return;
    }
    if (message.type !== 'result' || typeof message.id !== 'string') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    window.clearTimeout(request.timer);
    if (message.ok !== true || !isNostrEvent(message.event)) {
      request.reject(new Error(typeof message.error === 'string' ? message.error : 'arcade-sign-failed'));
      return;
    }
    if (message.event.pubkey !== this.pubkey || !verifyEvent(message.event) || !sameTemplate(message.event, request.template)) {
      request.reject(new Error('invalid-arcade-signature'));
      return;
    }
    request.resolve(message.event);
  }
}

export async function consumeArcadeHandoff(gameId: string): Promise<SignetSession | null> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get(FRAGMENT_KEY);
  if (!token) return null;
  stripHandoffFragment();
  const payload = decodePayload(token);
  if (!validPayload(payload, gameId, location.origin, Math.floor(Date.now() / 1000))) return null;
  if (!window.opener || typeof MessageChannel === 'undefined') return null;

  const channel = new MessageChannel();
  const signer = new ArcadeSigner(payload.event.pubkey, channel.port1, payload.canSign);
  try {
    window.opener.postMessage({ protocol: PROTOCOL, type: 'connect', channel: payload.channel }, ARCADE_ORIGIN, [channel.port2]);
    window.opener = null;
    await signer.waitUntilConnected();
  } catch {
    await signer.close();
    return null;
  }

  return {
    pubkey: payload.event.pubkey,
    method: 'bunker',
    signer,
    authEvent: payload.event as SignetAuthEvent,
    displayName: profileName(payload.profile),
  };
}
