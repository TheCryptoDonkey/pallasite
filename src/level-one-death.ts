/** Cosmetic player-crash events; never serialised or fed into gameplay RNG. */
import type { GameState, Particle, Vec2 } from './types.js';
export interface PlayerBurst {time:number;x:number;y:number;vx:number;vy:number;rot:number;final:boolean;}
const bursts=new WeakMap<GameState,PlayerBurst[]>();
const crashParticles=new WeakSet<Particle>();
export interface MechanicalBurst extends PlayerBurst {scale:number;mechanical:true;}
const mechanicalBursts=new WeakMap<GameState,MechanicalBurst[]>();
export function recordMechanicalBurst(s:GameState,pos:Vec2,vel:Vec2,scale:number,final=false):void {
  const list=mechanicalBursts.get(s)??[];list.push({time:s.elapsed,x:pos.x,y:pos.y,vx:vel.x,vy:vel.y,rot:s.elapsed*.001,final,scale,mechanical:true});
  if(list.length>4)list.shift();mechanicalBursts.set(s,list);
}
export function liveMechanicalBursts(s:GameState):ReadonlyArray<MechanicalBurst>{
  const list=mechanicalBursts.get(s)??[];while(list.length&&(s.elapsed-list[0].time>playerBurstDuration(list[0])*1000||s.elapsed<list[0].time))list.shift();return list;
}
export function resetPlayerBursts(s:GameState):void {bursts.delete(s);mechanicalBursts.delete(s);}
export function recordPlayerBurst(s:GameState,pos:Vec2,vel:Vec2,rot:number,final=false):void {
  const list=bursts.get(s)??[];list.push({time:s.elapsed,x:pos.x,y:pos.y,vx:vel.x,vy:vel.y,rot,final});
  if(list.length>3)list.shift();bursts.set(s,list);
}
export function livePlayerBursts(s:GameState):ReadonlyArray<PlayerBurst> {
  const list=bursts.get(s);if(!list)return [];
  while(list.length&&(s.elapsed-list[0].time>playerBurstDuration(list[0])*1000||s.elapsed<list[0].time))list.shift();
  return list;
}
export function playerBurstDuration(b:PlayerBurst):number {return b.final?2.8:1.4;}
/** Tag existing particles without changing their colours, paths, lifetimes or RNG. */
export function markPlayerBurstParticles(s:GameState,start:number):void {
  for(let i=start;i<s.particles.length;i++)crashParticles.add(s.particles[i]);
}
export function isPlayerBurstParticle(p:Particle):boolean {return crashParticles.has(p);}
/** Inertial trajectories shared by live Blender shrapnel and baked fallback. */
export function playerShard(b:PlayerBurst,index:number,age:number) {
  const angle=b.rot+index*2.399963,speed=(72+(index%5)*27)*(b.final?1.2:1);
  return {x:b.x+(b.vx*.5+Math.cos(angle)*speed)*age,y:b.y+(b.vy*.5+Math.sin(angle)*speed)*age,
    rot:angle+age*(index%2?-3.2:4.1),size:2.2+(index%4)*.9};
}
