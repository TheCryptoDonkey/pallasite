import type {Asteroid, Coin} from './types.js';
/** Authored Blender dimensions, shared by the live models and baked fallback. */
export const SHIP_ART_SCALE=1.25;
export const SHIP_BLENDER_SCALE=14/1.38*SHIP_ART_SCALE;
export const UFO_PLATE_WIDTH=2.6;
/** The Forge has distinct containment hardware, loaded only at the finale. */
export function stationArt(a:Asteroid,wave:number):string {
  return `${wave===25&&a.stationPart!=='arm'?'forge':'station'}-${a.stationPart}`;
}
export const PICKUP_ART_SCALE=1.4;
/** Revised spherical art must not share the cached URL of the old capsules. */
export const PICKUP_ART_REVISION='rounded-2';
export function pickupArtUrl(type:string,extension:string):string {
  return `/graphics/level-one/pickup-${type}.${extension}?art=${PICKUP_ART_REVISION}`;
}
export const PICKUP_KINDS=['rapid','satboost','nova','trident','magnet','extralife'] as const;
export const DEBRIS_KINDS=['wing','engine','canopy','hull'] as const;
export const COLLECTABLE_KINDS=['sat','dust'] as const;
export const COLLECTABLE_ART_SCALE=1.5;
export function collectableAlpha(ttl:number):number {return Math.max(0,Math.min(1,(8000-ttl)/200))*Math.max(0,Math.min(1,ttl/1500));}
const collectablePhases=new WeakMap<Coin,number>();
export function collectablePhase(c:Coin):number {let phase=collectablePhases.get(c);if(phase===undefined){phase=c.pos.x*.017+c.pos.y*.031;collectablePhases.set(c,phase);}return phase;}
export function debrisKind(index:number,length:number) { return length>20?(index%4===3?'hull':'wing'):index%2?'engine':'canopy'; }
export function debrisScale(length:number) { return length>20?length*.85:Math.max(9,length*1.4); }
