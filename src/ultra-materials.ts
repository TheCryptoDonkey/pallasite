import type { AsteroidType, UfoType } from './types.js';
export const ULTRA_PILOT_COLOURS=['#58ff58','#5bd0ff','#ffb24a','#ff7ad0','#b48cff','#8cffb4','#ff6b6b','#ffd84a'];

/** Shared geology keeps texture memory bounded; mineral surfaces and silhouettes
 * remain distinct. These values also drive the Blender fallback plates. */
export const ULTRA_ROCKS:Record<AsteroidType,{source:'stony'|'pallasite';color:number;metal:number;rough:number;emission:number;stretch:[number,number,number]}>={
  stony:{source:'stony',color:0xffffff,metal:0,rough:.93,emission:0,stretch:[1,1,1]},
  iron:{source:'stony',color:0xb7c6d2,metal:.9,rough:.32,emission:0,stretch:[1.05,.9,1.08]},
  chondrite:{source:'stony',color:0xb7d3dd,metal:.12,rough:.84,emission:0,stretch:[.94,1.04,.91]},
  pallasite:{source:'pallasite',color:0xffffff,metal:.35,rough:.48,emission:0,stretch:[1,1,1]},
  carbonaceous:{source:'stony',color:0x68627d,metal:.03,rough:1,emission:0,stretch:[1.06,.88,.92]},
  mesosiderite:{source:'pallasite',color:0xe0b3a0,metal:.7,rough:.48,emission:0,stretch:[.94,1.07,.96]},
  achondrite:{source:'stony',color:0xf39277,metal:.08,rough:.82,emission:0,stretch:[1.07,.94,.9]},
  kinetic:{source:'stony',color:0x72e9df,metal:.45,rough:.4,emission:.09,stretch:[.94,.94,1.08]},
  volatile:{source:'stony',color:0xff9052,metal:.18,rough:.65,emission:.12,stretch:[1.07,.92,.96]},
  ballast:{source:'stony',color:0x819bbf,metal:.6,rough:.66,emission:0,stretch:[1.02,1.08,.92]},
  tektite:{source:'pallasite',color:0x72edbe,metal:.4,rough:.12,emission:.035,stretch:[.87,.94,1.08]},
  lodestone:{source:'pallasite',color:0xeb8fde,metal:.75,rough:.35,emission:.07,stretch:[.94,1.07,.95]},
};
export const ULTRA_UFOS:Record<UfoType,{asset:string;accent:number}>={
  cruiser:{asset:'ufo-cinematic',accent:0xffa84c},
  elite:{asset:'ufo-elite',accent:0xff587b},
  tank:{asset:'ufo-tank',accent:0xff884c},
  sniper:{asset:'ufo-sniper',accent:0x63e9e8},
  boss:{asset:'ufo-boss',accent:0xffd56b},
};
