// Deterministic review fixture: linear momentum is conserved and some
// kinetic energy is lost to deformation/fracture. No atmospheric drag.
export const contactTime = 5;
export const cycleTime = 12;
export const lifetime = 2.8;
const m1=130**3, m2=100**3, u1=27, u2=-27, restitution=.72;
export const contactDrift=(m1*u1+m2*u2)/(m1+m2);
const v1=(m1*u1+m2*u2-m2*restitution*(u1-u2))/(m1+m2);
const v2=(m1*u1+m2*u2+m1*restitution*(u1-u2))/(m1+m2);
export function rockOffsets(seconds) {
  const phase=seconds%cycleTime;
  return phase<contactTime?[-250+u1*phase,250+u2*phase]:[-115+v1*(phase-contactTime),115+v2*(phase-contactTime)];
}
export function impactAge(seconds) { return seconds%cycleTime-contactTime; }
export function fragment(i,age,portrait,dust=false) {
  const angle=i*2.399963;
  const speed=dust?6+(i*13%29):14+(i*17%39);
  const tangent=Math.cos(angle)*speed*age;
  const normal=(contactDrift+Math.sin(angle)*speed*.24)*age;
  return {x:(portrait?640:655)+(portrait?tangent:normal),y:(portrait?375:360)+(portrait?normal:tangent),z:42+Math.sin(angle*1.7)*speed*.2*age,size:.85+(i%5)*.45};
}
export function dustOpacity(age) { return Math.min(1,age/.06)*Math.pow(Math.max(0,1-age/lifetime),1.8); }
