import type { ControllerSpec } from './index.js';
import { isControllerSpec } from './controller-profile.js';
/** @deprecated Initial standalone-profile draft only. New discovery embeds
 * controller.profile in the NIP-89 Gamestr game definition; see game-definition. */
export const CONTROLLER_PROFILE_KIND_DRAFT = 30393;
export interface ControllerProfileEvent {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
}
/** The caller supplies its NIP-01 verifier and independently trusted game publisher. */
export function controllerProfileFromEvent(
  event: ControllerProfileEvent, publisher: string, gameId: string,
  verifySignature: (event: ControllerProfileEvent) => boolean,
  kind = CONTROLLER_PROFILE_KIND_DRAFT,
): ControllerSpec | null {
  try {
    if (!/^[a-f0-9]{64}$/.test(publisher) || event.pubkey !== publisher || event.kind !== kind
      || !Number.isInteger(event.created_at) || event.created_at < 0 || event.content.length > 49152
      || !/^[a-f0-9]{64}$/.test(event.id) || !/^[a-f0-9]{128}$/.test(event.sig)
      || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(gameId) || !Array.isArray(event.tags) || event.tags.length > 32) return null;
    const d = event.tags.filter(tag=>tag[0] === 'd'), protocol = event.tags.filter(tag=>tag[0] === 'protocol');
    if(d.length !== 1 || d[0]?.length !== 2 || d[0][1] !== gameId || protocol.length !== 1 || protocol[0]?.length !== 3
      || protocol[0][1] !== 'nostr-game-controller' || protocol[0][2] !== '1') return null;
    if(verifySignature(event) !== true) return null;
    const spec: unknown = JSON.parse(event.content);
    return isControllerSpec(spec) ? spec : null;
  } catch { return null; }
}
