// Closed vocabulary for host-to-phone text. `vocabulary.json` is a byte-identical
// copy of packages/protocol/src/vocabulary.json (scripts/check-vocabulary-sync.mjs
// fails when they differ). A self-hoster may point CONTROLLER_VOCABULARY at their
// own file with the same shape; the owner's deployment uses the bundled one.
//
// This module is the broker half of packages/protocol/src/vocabulary.ts. Keep the
// grammar in step with it; scripts/check-vocabulary-sync.mjs runs the same cases
// through both.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SCORE_MAX = 1_000_000;
export const INITIALS_RE = /^[A-Z]{3}$/;
export const COLOUR_RE = /^(?:#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?|rgba\((?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:25[0-5]|2[0-4]\d|1?\d?\d), ?(?:0|1|0\.\d{1,3})\))$/;
export const SLOTS = Object.freeze(['joyL', 'joyR', 'A', 'B', 'X', 'Y', 'L1', 'L2', 'R1', 'R2', 'start', 'select', 'dpadU', 'dpadD', 'dpadL', 'dpadR']);
export const FEEDBACK_SLOTS = Object.freeze(['A', 'B', 'X', 'Y']);

const LISTS = ['games', 'labels', 'icons', 'phases', 'feedback', 'scoreLabels', 'highlights'];

export function loadVocabulary(path) {
  const data = JSON.parse(readFileSync(path ?? new URL('./vocabulary.json', import.meta.url), 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.graphics)) throw Error('Invalid controller vocabulary');
  for (const list of LISTS) if (!Array.isArray(data[list]) || data[list].some(item => typeof item !== 'string' || item.length > 128)) throw Error(`Invalid controller vocabulary: ${list}`);
  if (!data.games.length || !data.phases.length || !data.highlights.length) throw Error('Invalid controller vocabulary');
  for (const item of data.graphics) if (typeof item?.name !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) throw Error('Invalid controller vocabulary: graphics');
  return data;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = items => items.map(escape).join('|');
const N = '(0|[1-9][0-9]{0,6})';
function template(text) {
  const pattern = new RegExp('^' + escape(text).replace(/\\\{n\\\}/g, N).replace(/\\\{slot\\\}/g, `(${FEEDBACK_SLOTS.join('|')})`) + '$');
  const counted = text.includes('{n}');
  return value => {
    const match = pattern.exec(value);
    if (!match) return false;
    return !counted || match.slice(1).every(part => !/^\d+$/.test(part) || Number(part) <= SCORE_MAX);
  };
}

export function compileVocabulary(vocabulary = loadVocabulary()) {
  const index = '(?:[1-9]|[1-5][0-9]|6[0-4])';
  const game = alternation([...vocabulary.games].sort((a, b) => b.length - a.length));
  const player = `P${index}(?: · (?:BOT|[A-Z]{3}))?`;
  const specName = new RegExp(`^(?:${game})(?: · MENU)?(?: · P${index}| · SPECTATOR ${index})?$`);
  const title = new RegExp(`^(?:${game}) · (?:${alternation(vocabulary.phases)})$`);
  const rowLabel = new RegExp(`^(?:${index}\\. )?${player}$`);
  const highlight = new RegExp(`^${player} (?:${alternation(vocabulary.highlights)})$`);
  const feedback = vocabulary.feedback.map(template), scoreLabels = vocabulary.scoreLabels.map(template);
  const labels = new Set(vocabulary.labels), icons = new Set(vocabulary.icons), graphics = new Set(vocabulary.graphics.map(item => item.sha256));
  const string = value => typeof value === 'string';
  return {
    vocabulary,
    specName: value => string(value) && specName.test(value),
    title: value => string(value) && title.test(value),
    rowLabel: value => string(value) && rowLabel.test(value),
    highlight: value => string(value) && highlight.test(value),
    feedback: value => string(value) && feedback.some(match => match(value)),
    scoreLabel: value => string(value) && scoreLabels.some(match => match(value)),
    label: value => string(value) && labels.has(value),
    icon: value => string(value) && icons.has(value),
    /** True when `png` is base64 of exactly one of the allowed PNG files. */
    graphic: value => {
      if (!string(value) || value.length > 12288 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
      const bytes = Buffer.from(value, 'base64');
      // Only the canonical encoding passes, so stray padding bits cannot carry anything.
      return bytes.toString('base64') === value && graphics.has(createHash('sha256').update(bytes).digest('hex'));
    },
  };
}

const object = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const bounded = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Same geometry rules as validPlacement in packages/protocol/src/controller-profile.ts. */
export function validPlacement(value, stick) {
  if (!object(value) || !bounded(value.x, 0, 1) || !bounded(value.y, 0, 1) || !bounded(value.size, stick ? 96 : 48, 192)
    || value.shape !== undefined && (typeof value.shape !== 'string' || !['circle', 'rounded'].includes(value.shape))) return false;
  if (value.zone !== undefined) {
    const z = value.zone;
    if (!stick || !object(z) || !bounded(z.x, 0, 1) || !bounded(z.y, 0, 1) || !bounded(z.width, .1, 1) || !bounded(z.height, .1, 1)
      || z.x + z.width > 1.000001 || z.y + z.height > 1.000001 || value.x < z.x || value.x > z.x + z.width || value.y < z.y || value.y > z.y + z.height) return false;
  }
  return true;
}

/** Layout geometry carries three decimal places, plenty for a thumb and no spare precision for a side channel. */
const round3 = number => Math.round(number * 1000) / 1000;

function canonicaliseLayout(value, keys) {
  if (!object(value) || value.version !== 1 || value.portrait === undefined && value.landscape === undefined) return null;
  const layout = { version: 1 };
  for (const orientation of ['portrait', 'landscape']) {
    const map = value[orientation];
    if (map === undefined) continue;
    if (!object(map) || Object.keys(map).length !== keys.length) return null;
    const rebuilt = {};
    for (const key of keys) {
      const placement = map[key];
      if (!validPlacement(placement, key.startsWith('joy'))) return null;
      const r = round3;
      rebuilt[key] = {
        x: r(placement.x), y: r(placement.y), size: r(placement.size),
        ...(placement.shape !== undefined ? { shape: placement.shape } : {}),
        ...(placement.zone !== undefined ? { zone: { x: r(placement.zone.x), y: r(placement.zone.y), width: r(placement.zone.width), height: r(placement.zone.height) } } : {}),
      };
    }
    layout[orientation] = rebuilt;
  }
  return layout;
}

/**
 * Rebuild a controller spec from validated fields. Returns { spec, stripped } or
 * null when the value is not a spec at all. Mirrors canonicaliseSpec in
 * packages/protocol/src/vocabulary.ts.
 */
export function canonicaliseSpec(value, compiled) {
  if (!object(value) || value.version !== 1 || !object(value.slots)) return null;
  const stripped = [];
  const name = compiled.specName(value.name) ? value.name : 'GAME';
  if (name !== value.name) stripped.push('name');
  const slots = {};
  const keys = Object.keys(value.slots).filter(key => SLOTS.includes(key));
  if (keys.length !== Object.keys(value.slots).length) stripped.push('slots');
  for (const key of keys.slice(0, 16)) {
    const source = value.slots[key];
    if (!object(source)) { stripped.push(`slots.${key}`); continue; }
    const slot = {};
    if (source.mode !== undefined) { if (['heading', 'xy', 'tilt'].includes(source.mode)) slot.mode = source.mode; else stripped.push(`slots.${key}.mode`); }
    if (source.tapAction !== undefined) { if (typeof source.tapAction === 'string' && SLOTS.includes(source.tapAction)) slot.tapAction = source.tapAction; else stripped.push(`slots.${key}.tapAction`); }
    if (source.label !== undefined) { if (compiled.label(source.label)) slot.label = source.label; else stripped.push(`slots.${key}.label`); }
    if (source.icon !== undefined) { if (compiled.icon(source.icon)) slot.icon = source.icon; else stripped.push(`slots.${key}.icon`); }
    if (source.colour !== undefined) { if (typeof source.colour === 'string' && COLOUR_RE.test(source.colour)) slot.colour = source.colour; else stripped.push(`slots.${key}.colour`); }
    if (source.graphic !== undefined) {
      if (object(source.graphic) && compiled.graphic(source.graphic.png)) slot.graphic = { png: source.graphic.png };
      else stripped.push(`slots.${key}.graphic`);
    }
    slots[key] = slot;
  }
  const spec = { version: 1, name, slots };
  if (object(value.theme)) {
    const theme = {};
    for (const field of ['background', 'accent']) {
      const colour = value.theme[field];
      if (colour === undefined) continue;
      if (typeof colour === 'string' && COLOUR_RE.test(colour)) theme[field] = colour; else stripped.push(`theme.${field}`);
    }
    spec.theme = theme;
  } else if (value.theme !== undefined) stripped.push('theme');
  if (value.layout !== undefined) {
    const layout = canonicaliseLayout(value.layout, Object.keys(slots));
    if (layout) spec.layout = layout; else stripped.push('layout');
  }
  return { spec, stripped };
}
