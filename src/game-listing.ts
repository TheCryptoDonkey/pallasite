import type { ControllerSlot, ControllerSpec } from './index.js';
import { isControllerSpec } from './controller-profile.js';

/** Publisher-managed game listing: an addressable event whose `d` tag is the
 * gameId and whose content is the listing JSON. A signed listing is authorship,
 * not catalogue inclusion, and grants no launch, signing or payment authority.
 * Draft kind, beside the Gamestr score kind 30762; not yet allocated. */
export const GAME_LISTING_KIND = 30761;
/** strfry's default maxEventSize; the complete serialised event must fit. */
export const GAME_LISTING_MAX_EVENT_BYTES = 65_536;
export const GAME_SCORE_KINDS = [30762, 5555] as const;
export const GAME_INPUT_METHODS = ['keyboard', 'gamepad', 'pointer', 'touch', 'phone'] as const;
export const GAME_PLATFORMS = ['web', 'windows', 'macos', 'linux', 'android', 'ios'] as const;
/** Served from the origin of a listing's `url` to prove the publisher controls it. */
export const GAME_ORIGIN_PROOF_PATH = '/.well-known/gamestr.json';

export type ScoreDirection = 'asc' | 'desc';
export type ScoreFormat = 'number' | 'time';
/** Field names follow gamestr.io's LeaderboardConfig. */
export interface GameLeaderboard {
  label: string;
  scoreTag: string;
  direction: ScoreDirection;
  displayTag?: string;
  displayLabel?: string;
  filterTag?: string;
  filterValue?: string;
  scoreFormat?: ScoreFormat;
  scoreUnit?: 'ms' | 's';
  deduplicateByPlayer?: boolean | 'best' | 'latest';
}
/** Field names follow gamestr.io's LeaderboardSplitConfig. */
export interface GameLeaderboardSplit {
  splitTag: string;
  scoreTag?: string;
  direction: ScoreDirection;
  scoreFormat?: ScoreFormat;
  scoreUnit?: 'ms' | 's';
  layout?: 'tabs' | 'grid';
  values: { value: string; label: string }[];
}
export interface GameListingScores {
  /** `developer` (default): a game key signs and the player is in `p`.
   * `player`: players sign their own score events. */
  signer?: 'developer' | 'player';
  kinds?: (typeof GAME_SCORE_KINDS)[number][];
  /** Additional `game` tag values that belong to this listing. */
  identifiers?: string[];
  /** Developer-signed score keys; defaults to the listing publisher. */
  authorities?: string[];
  leaderboards?: GameLeaderboard[];
  leaderboardSplit?: GameLeaderboardSplit;
}

export type GameActionType = 'button' | 'axis1' | 'axis2';
export interface GameAction { type: GameActionType; label: string; role?: 'menu' | 'back' | 'confirm' }
/** KeyboardEvent.code values: physical key positions, independent of layout. */
export type KeyboardBinding =
  | string[]
  | { negative?: string[]; positive?: string[] }
  | { up?: string[]; down?: string[]; left?: string[]; right?: string[] };
/** W3C Standard Gamepad mapping indices. */
export type GamepadBinding =
  | { button: number }
  | { axis: number }
  | { stick: 'left' | 'right' }
  | { stick: 'left' | 'right'; direction: 'up' | 'down' | 'left' | 'right' }
  | { dpad: true };
export interface GameListingInput {
  methods: (typeof GAME_INPUT_METHODS)[number][];
  actions?: Record<string, GameAction>;
  keyboard?: Record<string, KeyboardBinding>;
  gamepad?: Record<string, GamepadBinding[]>;
  phone?: { profile: ControllerSpec; bind?: Partial<Record<ControllerSlot, string>> };
  hints?: string[];
}

export interface GamePlatform { platform: (typeof GAME_PLATFORMS)[number]; url?: string }
/** Definitions for the ids score events carry in their `achievements` tag. */
export interface GameAchievement {
  id: string; name: string; description?: string; image?: string;
  /** NIP-58 badge definition awarded for it: `30009:<pubkey>:<d>`. */
  badge?: string;
}

export interface GameListing {
  listingVersion: 1;
  gameId: string;
  name: string;
  description: string;
  image: string;
  genres: string[];
  url: string;
  tagline?: string;
  banner?: string;
  developer?: string;
  lud16?: string;
  players?: { min: number; max: number };
  network?: 'required' | 'optional' | 'offline';
  ageRating?: string;
  capabilities?: { nostrSign?: boolean; walletPay?: boolean; persistentStorage?: boolean; externalNavigation?: boolean };
  platforms?: GamePlatform[];
  orientation?: 'landscape' | 'portrait' | 'any';
  /** Whether the web game works inside a catalogue or cabinet iframe. */
  embeddable?: boolean;
  /** SPDX licence identifier. */
  license?: string;
  repository?: string;
  achievements?: GameAchievement[];
  scores?: GameListingScores;
  input?: GameListingInput;
  [extension: string]: unknown;
}

export interface GameListingEvent {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
}
export interface VerifiedGameListing { publisher: string; gameId: string; createdAt: number; listing: GameListing }
export type GameListingCheck = { ok: true; listing: GameListing } | { ok: false; errors: string[] };

const STICKS = new Set(['joyL', 'joyR']);
const HEX64 = /^[0-9a-f]{64}$/;
const ACTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** Tag names are matched exactly; existing boards use names such as `score:highestword`. */
const TAG_NAME = /^[^\s\u0000-\u001f\u007f]{1,64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
function httpsUrl(value: unknown): boolean {
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
/** Score identifiers are the existing `game` tag values, so spaces and capitals
 * remain valid for legacy games. Colons are reserved by `<pubkey>:<gameId>` keys. */
export const isGameIdentifier = (value: unknown): value is string =>
  text(value, 64) && !value.includes(':') && value.trim() === value;

function checkLeaderboard(board: unknown, at: string, errors: string[]): void {
  if (!object(board)) { errors.push(`${at} must be an object`); return; }
  if (!text(board.label, 64)) errors.push(`${at}.label must be 1-64 characters`);
  for (const key of ['scoreTag', 'displayTag', 'filterTag'] as const)
    if ((key === 'scoreTag' || board[key] !== undefined) && !(typeof board[key] === 'string' && TAG_NAME.test(board[key] as string)))
      errors.push(`${at}.${key} must be a tag name`);
  if (board.direction !== 'asc' && board.direction !== 'desc') errors.push(`${at}.direction must be asc or desc`);
  for (const key of ['displayLabel', 'filterValue'] as const)
    if (board[key] !== undefined && !text(board[key], 128)) errors.push(`${at}.${key} must be 1-128 characters`);
  if ((board.filterTag === undefined) !== (board.filterValue === undefined)) errors.push(`${at} needs both filterTag and filterValue`);
  if (board.scoreFormat !== undefined && board.scoreFormat !== 'number' && board.scoreFormat !== 'time') errors.push(`${at}.scoreFormat must be number or time`);
  if (board.scoreUnit !== undefined && board.scoreUnit !== 'ms' && board.scoreUnit !== 's') errors.push(`${at}.scoreUnit must be ms or s`);
  if (board.deduplicateByPlayer !== undefined && typeof board.deduplicateByPlayer !== 'boolean'
    && board.deduplicateByPlayer !== 'best' && board.deduplicateByPlayer !== 'latest') errors.push(`${at}.deduplicateByPlayer must be a boolean, best or latest`);
}

function checkScores(scores: unknown, errors: string[]): void {
  if (!object(scores)) { errors.push('scores must be an object'); return; }
  if (scores.signer !== undefined && scores.signer !== 'developer' && scores.signer !== 'player') errors.push('scores.signer must be developer or player');
  if (scores.kinds !== undefined && !(Array.isArray(scores.kinds) && scores.kinds.length >= 1
    && scores.kinds.every(kind => (GAME_SCORE_KINDS as readonly unknown[]).includes(kind)) && new Set(scores.kinds).size === scores.kinds.length))
    errors.push('scores.kinds must list distinct supported score kinds');
  if (scores.identifiers !== undefined && !(Array.isArray(scores.identifiers) && scores.identifiers.length <= 8
    && scores.identifiers.every(isGameIdentifier) && new Set(scores.identifiers).size === scores.identifiers.length))
    errors.push('scores.identifiers must be at most 8 distinct game identifiers');
  if (scores.authorities !== undefined && !(Array.isArray(scores.authorities) && scores.authorities.length >= 1 && scores.authorities.length <= 8
    && scores.authorities.every(key => typeof key === 'string' && HEX64.test(key)) && new Set(scores.authorities).size === scores.authorities.length))
    errors.push('scores.authorities must be 1-8 distinct hex public keys');
  if (scores.signer === 'player' && scores.authorities !== undefined) errors.push('player-signed scores have no score authorities');
  if (scores.leaderboards !== undefined) {
    if (!Array.isArray(scores.leaderboards) || scores.leaderboards.length < 1 || scores.leaderboards.length > 16)
      errors.push('scores.leaderboards must list 1-16 boards');
    else scores.leaderboards.forEach((board, index) => checkLeaderboard(board, `scores.leaderboards[${index}]`, errors));
  }
  const split = scores.leaderboardSplit;
  if (split === undefined) return;
  if (!object(split)) { errors.push('scores.leaderboardSplit must be an object'); return; }
  if (!(typeof split.splitTag === 'string' && TAG_NAME.test(split.splitTag))) errors.push('scores.leaderboardSplit.splitTag must be a tag name');
  if (split.scoreTag !== undefined && !(typeof split.scoreTag === 'string' && TAG_NAME.test(split.scoreTag))) errors.push('scores.leaderboardSplit.scoreTag must be a tag name');
  if (split.direction !== 'asc' && split.direction !== 'desc') errors.push('scores.leaderboardSplit.direction must be asc or desc');
  if (split.scoreFormat !== undefined && split.scoreFormat !== 'number' && split.scoreFormat !== 'time') errors.push('scores.leaderboardSplit.scoreFormat must be number or time');
  if (split.scoreUnit !== undefined && split.scoreUnit !== 'ms' && split.scoreUnit !== 's') errors.push('scores.leaderboardSplit.scoreUnit must be ms or s');
  if (split.layout !== undefined && split.layout !== 'tabs' && split.layout !== 'grid') errors.push('scores.leaderboardSplit.layout must be tabs or grid');
  if (!(Array.isArray(split.values) && split.values.length >= 1 && split.values.length <= 32
    && split.values.every(entry => object(entry) && text(entry.value, 128) && text(entry.label, 64))
    && new Set(split.values.map(entry => (entry as { value: string }).value)).size === split.values.length))
    errors.push('scores.leaderboardSplit.values must list 1-32 distinct value/label pairs');
}

const codes = (value: unknown): boolean =>
  Array.isArray(value) && value.length >= 1 && value.length <= 8 && value.every(code => typeof code === 'string' && KEY_CODE.test(code));

function checkKeyboard(action: GameAction, binding: unknown): boolean {
  if (action.type === 'button') return codes(binding);
  const sides = action.type === 'axis1' ? ['negative', 'positive'] : ['up', 'down', 'left', 'right'];
  return object(binding) && Object.keys(binding).length > 0
    && Object.entries(binding).every(([side, value]) => sides.includes(side) && codes(value));
}

function checkGamepad(action: GameAction, bindings: unknown): boolean {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 8) return false;
  return bindings.every(binding => {
    if (!object(binding)) return false;
    const keys = Object.keys(binding).length;
    if ('stick' in binding) {
      if (binding.stick !== 'left' && binding.stick !== 'right') return false;
      // A stick direction acts as a digital button, as in many arcade games.
      if (keys === 2) return ['up', 'down', 'left', 'right'].includes(binding.direction as string) && action.type === 'button';
      return keys === 1 && action.type === 'axis2';
    }
    if (keys !== 1) return false;
    if ('button' in binding) return integer(binding.button, 0, 16) && action.type !== 'axis2';
    if ('axis' in binding) return integer(binding.axis, 0, 3) && action.type === 'axis1';
    return binding.dpad === true && action.type === 'axis2';
  });
}

function checkInput(input: unknown, errors: string[]): void {
  if (!object(input)) { errors.push('input must be an object'); return; }
  const methods = input.methods;
  if (!(Array.isArray(methods) && methods.length >= 1 && new Set(methods).size === methods.length
    && methods.every(method => (GAME_INPUT_METHODS as readonly unknown[]).includes(method)))) {
    errors.push('input.methods must list distinct supported input methods');
    return;
  }
  const actions = new Map<string, GameAction>();
  if (input.actions !== undefined) {
    if (!object(input.actions) || Object.keys(input.actions).length < 1 || Object.keys(input.actions).length > 32)
      errors.push('input.actions must declare 1-32 actions');
    else for (const [id, action] of Object.entries(input.actions)) {
      if (!ACTION_ID.test(id)) errors.push(`input.actions.${id} has an invalid action id`);
      else if (!object(action) || !['button', 'axis1', 'axis2'].includes(action.type as string) || !text(action.label, 48)
        || (action.role !== undefined && !['menu', 'back', 'confirm'].includes(action.role as string)))
        errors.push(`input.actions.${id} needs a type, a 1-48 character label and an optional known role`);
      else actions.set(id, action as unknown as GameAction);
    }
  }
  for (const method of ['keyboard', 'gamepad'] as const) {
    const section = input[method];
    if (section === undefined) continue;
    if (!methods.includes(method)) errors.push(`input.${method} requires ${method} in input.methods`);
    if (!object(section)) { errors.push(`input.${method} must be an object`); continue; }
    for (const [id, binding] of Object.entries(section)) {
      const action = actions.get(id);
      if (!action) errors.push(`input.${method}.${id} binds an undeclared action`);
      else if (!(method === 'keyboard' ? checkKeyboard(action, binding) : checkGamepad(action, binding)))
        errors.push(`input.${method}.${id} does not suit a ${action.type} action`);
    }
  }
  if (input.phone !== undefined) {
    const phone = input.phone;
    if (!methods.includes('phone')) errors.push('input.phone requires phone in input.methods');
    if (!object(phone) || !isControllerSpec(phone.profile)) errors.push('input.phone.profile must be a valid controller profile');
    else if (phone.bind !== undefined) {
      if (!object(phone.bind)) errors.push('input.phone.bind must be an object');
      else for (const [slot, id] of Object.entries(phone.bind)) {
        const action = typeof id === 'string' ? actions.get(id) : undefined;
        if (!(slot in phone.profile.slots)) errors.push(`input.phone.bind.${slot} is not a profile slot`);
        else if (!action) errors.push(`input.phone.bind.${slot} binds an undeclared action`);
        else if (action.type !== (STICKS.has(slot) ? 'axis2' : 'button')) errors.push(`input.phone.bind.${slot} does not suit a ${action.type} action`);
      }
    }
  }
  if (input.hints !== undefined && !(Array.isArray(input.hints) && input.hints.length <= 8 && input.hints.every(hint => text(hint, 80))))
    errors.push('input.hints must be at most 8 lines of 1-80 characters');
}

/** Validate a listing's structure and semantic rules. Unknown top-level and
 * section fields are ignored so later revisions stay readable. */
export function checkGameListing(value: unknown): GameListingCheck {
  const errors: string[] = [];
  try {
    if (!object(value)) return { ok: false, errors: ['listing must be an object'] };
    if (value.listingVersion !== 1) return { ok: false, errors: ['listingVersion must be 1'] };
    if (!isGameIdentifier(value.gameId)) errors.push('gameId must be 1-64 characters without colons or surrounding spaces');
    if (!text(value.name, 80)) errors.push('name must be 1-80 characters');
    if (!(typeof value.description === 'string' && value.description.length >= 1 && value.description.length <= 1200))
      errors.push('description must be 1-1200 characters');
    if (!httpsUrl(value.image)) errors.push('image must be an https URL');
    if (!httpsUrl(value.url)) errors.push('url must be an https URL');
    if (!(Array.isArray(value.genres) && value.genres.length >= 1 && value.genres.length <= 8
      && value.genres.every(genre => text(genre, 32)) && new Set(value.genres).size === value.genres.length))
      errors.push('genres must list 1-8 distinct genres');
    if (value.tagline !== undefined && !text(value.tagline, 140)) errors.push('tagline must be 1-140 characters');
    if (value.banner !== undefined && !httpsUrl(value.banner)) errors.push('banner must be an https URL');
    if (value.developer !== undefined && !text(value.developer, 100)) errors.push('developer must be 1-100 characters');
    if (value.lud16 !== undefined && !(text(value.lud16, 320) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.lud16)))
      errors.push('lud16 must be a Lightning address');
    if (value.players !== undefined && !(object(value.players) && integer(value.players.min, 1, 64)
      && integer(value.players.max, 1, 64) && value.players.min <= value.players.max))
      errors.push('players must have 1 <= min <= max <= 64');
    if (value.network !== undefined && !['required', 'optional', 'offline'].includes(value.network as string))
      errors.push('network must be required, optional or offline');
    if (value.ageRating !== undefined && !text(value.ageRating, 32)) errors.push('ageRating must be 1-32 characters');
    if (value.capabilities !== undefined && !(object(value.capabilities) && Object.entries(value.capabilities).every(([key, flag]) =>
      ['nostrSign', 'walletPay', 'persistentStorage', 'externalNavigation'].includes(key) && typeof flag === 'boolean')))
      errors.push('capabilities must contain known boolean requests');
    if (value.platforms !== undefined && !(Array.isArray(value.platforms) && value.platforms.length >= 1 && value.platforms.length <= 6
      && value.platforms.every(entry => object(entry) && (GAME_PLATFORMS as readonly unknown[]).includes(entry.platform)
        && (entry.url === undefined || httpsUrl(entry.url)))
      && new Set(value.platforms.map(entry => (entry as { platform: string }).platform)).size === value.platforms.length))
      errors.push('platforms must list 1-6 distinct platforms with optional https URLs');
    if (value.achievements !== undefined && !(Array.isArray(value.achievements) && value.achievements.length >= 1 && value.achievements.length <= 64
      && value.achievements.every(entry => object(entry) && typeof entry.id === 'string' && /^[^\s,\u0000-\u001f\u007f]{1,64}$/.test(entry.id)
        && text(entry.name, 64) && (entry.description === undefined || text(entry.description, 280))
        && (entry.image === undefined || httpsUrl(entry.image))
        && (entry.badge === undefined || (typeof entry.badge === 'string' && /^30009:[0-9a-f]{64}:[^:]{1,64}$/.test(entry.badge))))
      && new Set(value.achievements.map(entry => (entry as { id: string }).id)).size === value.achievements.length))
      errors.push('achievements must list 1-64 distinct ids with names');
    if (value.orientation !== undefined && !['landscape', 'portrait', 'any'].includes(value.orientation as string))
      errors.push('orientation must be landscape, portrait or any');
    if (value.embeddable !== undefined && typeof value.embeddable !== 'boolean') errors.push('embeddable must be a boolean');
    if (value.license !== undefined && !(typeof value.license === 'string' && /^[A-Za-z0-9.+()\- ]{1,64}$/.test(value.license)))
      errors.push('license must be an SPDX licence expression');
    if (value.repository !== undefined && !httpsUrl(value.repository)) errors.push('repository must be an https URL');
    if (value.scores !== undefined) checkScores(value.scores, errors);
    if (value.input !== undefined) checkInput(value.input, errors);
  } catch {
    errors.push('listing could not be read');
  }
  return errors.length ? { ok: false, errors } : { ok: true, listing: value as GameListing };
}

/** Read a signed listing event. The caller supplies a NIP-01 verifier and
 * applies its own catalogue policy to the returned publisher and gameId. */
export function gameListingFromEvent(
  event: GameListingEvent,
  verifySignature: (event: GameListingEvent) => boolean,
): VerifiedGameListing | null {
  try {
    const serialised = JSON.stringify(event);
    if (new TextEncoder().encode(serialised).length > GAME_LISTING_MAX_EVENT_BYTES) return null;
    // Verify and read the same plain snapshot, so a verifier cannot swap content.
    const snapshot: GameListingEvent = JSON.parse(serialised);
    if (snapshot.kind !== GAME_LISTING_KIND || !HEX64.test(snapshot.pubkey) || !HEX64.test(snapshot.id)
      || !/^[0-9a-f]{128}$/.test(snapshot.sig) || !Number.isInteger(snapshot.created_at) || snapshot.created_at < 0
      || typeof snapshot.content !== 'string' || !Array.isArray(snapshot.tags) || snapshot.tags.length > 64
      || snapshot.tags.some(tag => !Array.isArray(tag) || tag.some(value => typeof value !== 'string'))) return null;
    const d = snapshot.tags.filter(tag => tag[0] === 'd');
    const gameId = d.length === 1 && d[0]?.length === 2 ? d[0][1] : undefined;
    if (!isGameIdentifier(gameId)) return null;
    if (verifySignature(JSON.parse(serialised)) !== true) return null;
    const checked = checkGameListing(JSON.parse(snapshot.content));
    if (!checked.ok || checked.listing.gameId !== gameId) return null;
    const listing = checked.listing;
    return { publisher: snapshot.pubkey, gameId: listing.gameId, createdAt: snapshot.created_at, listing };
  } catch { return null; }
}

/** Declared actions each declared binding method leaves unmapped. A partial
 * binding is valid; a cabinet or catalogue decides whether the gap matters. */
export function unboundGameActions(listing: GameListing): Partial<Record<'keyboard' | 'gamepad' | 'phone', string[]>> {
  const input = listing.input;
  const ids = Object.keys(input?.actions ?? {});
  if (!input || !ids.length) return {};
  const result: Partial<Record<'keyboard' | 'gamepad' | 'phone', string[]>> = {};
  if (input.methods.includes('keyboard')) result.keyboard = ids.filter(id => !input.keyboard?.[id]);
  if (input.methods.includes('gamepad')) result.gamepad = ids.filter(id => !input.gamepad?.[id]);
  if (input.phone) {
    const bound = new Set(Object.values(input.phone.bind ?? {}));
    result.phone = ids.filter(id => !bound.has(id));
  }
  return result;
}

/** Where a catalogue fetches the origin proof for a listing. */
export function gameOriginProofUrl(listing: GameListing): string {
  return new URL(GAME_ORIGIN_PROOF_PATH, listing.url).href;
}

/** True when an origin proof document, `{"games": {"<gameId>": ["<hex pubkey>"]}}`,
 * names the publisher for this game. The caller fetches the document from
 * `gameOriginProofUrl` without following redirects to another origin. */
export function gameOriginProofMatches(document: unknown, gameId: string, publisher: string): boolean {
  if (!object(document) || !object(document.games) || !HEX64.test(publisher)) return false;
  const keys = Object.prototype.hasOwnProperty.call(document.games, gameId) ? document.games[gameId] : undefined;
  return Array.isArray(keys) && keys.length <= 8 && keys.includes(publisher);
}

/** The listing's phone profile, ready to send as a `controller-spec`. */
export function controllerSpecFromListing(listing: GameListing): ControllerSpec | null {
  return listing.input?.phone?.profile ?? null;
}

/** Map a phone slot to the listing action it is bound to, so a game can read
 * actions instead of slot names. Unbound slots return undefined. */
export function phoneSlotAction(listing: GameListing, slot: string): string | undefined {
  const bind = listing.input?.phone?.bind as Record<string, string> | undefined;
  return bind && Object.prototype.hasOwnProperty.call(bind, slot) ? bind[slot] : undefined;
}
