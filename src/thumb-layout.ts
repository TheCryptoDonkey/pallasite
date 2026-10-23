import type { ControlZone, ResolvedPlacement } from './controller-profile.js';
/** Same bounded default geometry as the Swift and Kotlin clients. */
export function defaultControllerLayout(w: number,h: number,keys: string[]): Record<string,ResolvedPlacement> {
  const result: Record<string,ResolvedPlacement> = {}; const has = (key: string) => keys.includes(key);
  if(w < 200 || h < 160) return result;
  const box = (key: string,x: number,y: number,width: number,height: number,shape: 'circle'|'rounded' = 'rounded') => {
    result[key] = {x:x+width/2,y:y+height/2,size:Math.min(width,height),shape,zone:{x,y,width,height}};
  };
  const circle = (key: string,x: number,y: number,size: number) => box(key,x-size/2,y-size/2,size,size,'circle');
  const faceKeys = ['A','B','X','Y'].filter(has);
  // Small game-specific trigger sets belong beside the action thumb, not in the menu bar.
  const actionShoulders = !has('joyR') && (has('joyL') || keys.some(k=>k.startsWith('dpad'))) && faceKeys.length && faceKeys.length+['R1','R2'].filter(has).length <= 4 ? ['R1','R2'].filter(has) : [];
  const utility = ['L2','L1',...(has('joyL') ? ['dpadU','dpadL','dpadR','dpadD'] : []),'select','start','R1','R2'].filter(key=>has(key) && !actionShoulders.includes(key));
  const columns = Math.max(1,Math.min(utility.length,Math.floor((w-8)/52)));
  const rows = Math.ceil(utility.length/columns), cell = Math.min(80,(w-8)/columns), uw = cell*columns;
  utility.forEach((key,i)=>box(key,(w-uw)/2+(i%columns)*cell+2,Math.floor(i/columns)*52+4,cell-4,48));
  const top = rows*52+(rows === 0 ? 8 : 12), available = h-top-16;
  const hasLeft = has('joyL') || keys.some(k=>k.startsWith('dpad')), faces = ['A','B','X','Y'].filter(has);
  const leftX = Math.max(96,Math.min(116,w*.24)), rightX = w-leftX;
  const diameter = Math.min(152,w*.4,available*.78), thumbY = Math.min(h-diameter/2-16,h-Math.min(112,available*.4));
  if(!hasLeft && !has('joyR') && faces.length) {
    const cols = faces.length === 1 ? 1 : 2, count = Math.ceil(faces.length/cols);
    const bw = Math.min(180,(w-40)/cols), bh = Math.min(100,(available-(count-1)*12)/count), y = h-16-count*bh-(count-1)*12;
    faces.forEach((key,i)=>box(key,cols === 1 ? (w-bw)/2 : i%2 === 0 ? 16 : w-bw-16,y+Math.floor(i/cols)*(bh+12),bw,bh));
  } else if(faces.length && !has('joyR')) {
    // A broad primary pad sits under the resting thumb. Secondary actions form
    // a bounded cluster above it; tablet space never increases the reach.
    const actions = [...faces,...actionShoulders], secondary = actions.slice(1);
    const cols = w >= 560 && available < 200 ? 3 : 2;
    const count = Math.ceil(secondary.length/cols), gap = 10, bw = Math.min(cols === 3 ? 184 : 160,w*.5-32);
    const size = Math.max(48,Math.min(64,(bw-(cols-1)*gap)/cols,count ? (available-48-count*gap)/count : 64));
    const bh = Math.min(80,available-count*(size+gap)), x = w-16-bw, y = h-16-bh;
    box(actions[0]!,x,y,bw,bh);
    secondary.forEach((key,i)=>box(key,w-16-size-(i%cols)*(size+gap),y-(Math.floor(i/cols)+1)*(size+gap),size,size));
  } else if(faces.length) {
    const dual = has('joyR'), inboard = dual && w >= 560;
    const cx = inboard ? rightX-184 : rightX+(!has('joyL') && hasLeft ? Math.min(16,w*.04) : 0);
    const cy = dual && !inboard ? thumbY-diameter/2-100 : thumbY;
    const space = dual && !inboard ? Math.max(96,available-diameter-20) : available;
    if(faces.length === 1) circle(faces[0]!,cx,Math.max(top+44,cy),Math.min(92,space*.7));
    else if(faces.length <= 2) {
      const size = Math.min(76,space*.4,w*.19);
      circle(faces[0]!,cx+size*.46,Math.max(top+size/2,cy+size*.42),size);
      circle(faces[1]!,cx-size*.58,Math.max(top+size/2,cy-size*.58),size*.88);
    } else {
      const size = Math.min(64,Math.max(48,Math.min(w*.16,space/2.9))), gap = size*.88;
      const centreY = Math.min(h-size/2-gap-16,Math.max(top+size/2+gap,cy));
      if(space >= size+gap*2) {
        for(const [key,dx,dy] of [['A',0,1],['B',1,0],['X',-1,0],['Y',0,-1]] as const) if(has(key)) circle(key,cx+dx*gap,centreY+dy*gap,size);
      } else {
        const d = Math.min(56,(space-8)/2);
        faces.forEach((key,i)=>circle(key,cx+(i%2 === 0 ? -1 : 1)*(d+8)/2,top+space-d/2-Math.floor(i/2)*(d+8),d));
      }
    }
  }
  if(!has('joyL')) {
    const size = Math.min(56,Math.max(48,(w*.5-32)/3),available/3), cy = Math.min(h-size*1.5-12,Math.max(top+size*1.5,thumbY));
    for(const [key,dx,dy] of [['dpadU',0,-1],['dpadD',0,1],['dpadL',-1,0],['dpadR',1,0]] as const) if(has(key)) box(key,leftX+dx*size-size/2,cy+dy*size-size/2,size,size);
  }
  for(const key of ['joyL','joyR']) if(has(key)) {
    const y = Math.max(top,Math.min(h*.34,h-180));
    const zone: ControlZone = {x:key === 'joyL' ? 4 : w*.51,y,width:w*.49-4,height:h-y-12};
    result[key] = {x:key === 'joyL' ? leftX : rightX,y:thumbY,size:diameter,shape:'circle',zone};
  }
  return result;
}
