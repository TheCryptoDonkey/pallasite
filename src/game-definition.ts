import type { ControllerSpec } from './index.js';
import { isControllerSpec } from './controller-profile.js';
import type { ControllerProfileEvent } from './nostr-profile.js';

/** Existing NIP-89 application-handler information; no new event kind. */
export const GAME_DEFINITION_KIND = 31990;
export const GAME_DEFINITION_MAX_BYTES = 65_536;
export interface GameDefinitionController {
  adapter: 'native' | 'keyboard' | 'pointer' | 'hybrid';
  phoneProtocol?: 'gamestr-controller-v1';
  profile?: ControllerSpec;
}
/** Portable game identity and controller section. The definition schema validates
 * the complete catalogue, scoring, player and capability metadata. */
export interface GamestrGameDefinition {
  manifestVersion: 2;
  gameId: string;
  name: string;
  url: string;
  controller?: GameDefinitionController;
  [key: string]: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read only the controller section of a game definition. This is not a full
 * manifest validator or a grant to launch, execute, sign or pay for a game. */
export function controllerProfileFromGameDefinition(value: unknown): ControllerSpec | null {
  try {
    if (!object(value) || value.manifestVersion !== 2 || typeof value.gameId !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.gameId) || typeof value.name !== 'string'
      || !value.name.length || value.name.length > 80 || typeof value.url !== 'string'
      || new TextEncoder().encode(JSON.stringify(value)).length > GAME_DEFINITION_MAX_BYTES) return null;
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const controller = value.controller;
    if (!object(controller) || typeof controller.adapter !== 'string'
      || !['native', 'keyboard', 'pointer', 'hybrid'].includes(controller.adapter)
      || controller.phoneProtocol !== 'gamestr-controller-v1' || !isControllerSpec(controller.profile)) return null;
    return controller.profile;
  } catch { return null; }
}

/** Extract the profile from the same independently trusted, signed game
 * definition used by the catalogue. A valid signature is authorship, not trust. */
export function controllerProfileFromGameDefinitionEvent(
  event: ControllerProfileEvent, publisher: string, gameId: string,
  verifySignature: (event: ControllerProfileEvent) => boolean,
): ControllerSpec | null {
  try {
    // Work from a plain snapshot so a verifier's cache/mutations cannot replace
    // the definition which is consumed after verification.
    const snapshot: ControllerProfileEvent = JSON.parse(JSON.stringify(event));
    if (!/^[a-f0-9]{64}$/.test(publisher) || snapshot.pubkey !== publisher || snapshot.kind !== GAME_DEFINITION_KIND
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(gameId) || !Number.isInteger(snapshot.created_at) || snapshot.created_at < 0
      || !/^[a-f0-9]{64}$/.test(snapshot.id) || !/^[a-f0-9]{128}$/.test(snapshot.sig)
      || typeof snapshot.content !== 'string' || new TextEncoder().encode(snapshot.content).length > GAME_DEFINITION_MAX_BYTES
      || !Array.isArray(snapshot.tags) || snapshot.tags.length > 64
      || snapshot.tags.some(tag => !Array.isArray(tag) || tag.some(value => typeof value !== 'string'))) return null;
    const d = snapshot.tags.filter(tag => tag[0] === 'd');
    if (d.length !== 1 || d[0]?.length !== 2 || d[0][1] !== `gamestr-game:${gameId}`
      || !snapshot.tags.some(tag => tag.length === 2 && tag[0] === 't' && tag[1] === 'gamestr-game')) return null;
    if (verifySignature(JSON.parse(JSON.stringify(snapshot))) !== true) return null;
    const metadata: unknown = JSON.parse(snapshot.content);
    if (!object(metadata) || !object(metadata.gamestr_manifest) || metadata.gamestr_manifest.gameId !== gameId) return null;
    const definition = metadata.gamestr_manifest;
    if (metadata.website !== undefined && metadata.website !== definition.url) return null;
    const scoreKind = definition.scoreKind ?? 30762;
    if (scoreKind !== 30762 && scoreKind !== 5555
      || !snapshot.tags.some(tag => tag.length === 2 && tag[0] === 'k' && tag[1] === String(scoreKind))
      || !snapshot.tags.some(tag => tag.length === 2 && tag[0] === 'web' && tag[1] === definition.url)) return null;
    return controllerProfileFromGameDefinition(definition);
  } catch { return null; }
}
