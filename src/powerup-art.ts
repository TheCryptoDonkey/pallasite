import { POWERUP_CONFIG, type PowerUpType } from './types.js';

/** Immediate rounded fallback while the Blender plate loads, or if it fails. */
export function drawRoundedPowerCell(ctx:CanvasRenderingContext2D,type:PowerUpType,r:number):void {
  const color=POWERUP_CONFIG[type].colour;
  ctx.save();ctx.shadowBlur=0;
  const shell=ctx.createRadialGradient(-r*.4,-r*.5,r*.05,0,0,r);
  shell.addColorStop(0,'#d6e3e9');shell.addColorStop(.25,color);
  shell.addColorStop(.65,'#263e50');shell.addColorStop(1,'#08141e');
  ctx.fillStyle=shell;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#b3c6d2';ctx.lineWidth=1;ctx.stroke();
  ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.beginPath();ctx.ellipse(0,0,r*.94,r*.32,-.25,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle='#07121d';ctx.beginPath();ctx.arc(r*.08,-r*.1,r*.61,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=1.4;ctx.stroke();
  ctx.fillStyle=color;ctx.font=`bold ${r*.85}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(POWERUP_CONFIG[type].glyph,r*.08,-r*.06);
  ctx.restore();
}
