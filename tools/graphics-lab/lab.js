const frames = ['before', 'after'].map(id => document.getElementById(id));
const config = { scene: 'collision', budget: innerWidth<600?'balanced':'high', shadows:true, bloom:true, debris:true, paused: matchMedia('(prefers-reduced-motion: reduce)').matches };
const query=new URLSearchParams(location.search);
if([...document.querySelectorAll('[data-scene]')].some(button=>button.dataset.scene===query.get('scene')))config.scene=query.get('scene');
if(['low','balanced','high'].includes(query.get('budget')))config.budget=query.get('budget');
let time = 4600;
let previous = performance.now();
let cadence=[];
let lastCadenceReport=0;
const motion = document.getElementById('motion');
function updateMotion() { motion.textContent = config.paused ? 'Resume motion' : 'Pause motion'; motion.setAttribute('aria-pressed', String(config.paused)); }
function sendConfig() { frames.forEach(frame => frame.contentWindow.postMessage({ type: 'config', ...config }, location.origin)); }
document.querySelectorAll('[data-scene]').forEach(button => button.addEventListener('click', () => {
  config.scene = button.dataset.scene;
  document.querySelectorAll('[data-scene]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  sendConfig();
}));
document.querySelectorAll('[data-frame]').forEach(button => button.addEventListener('click', () => {
  document.body.classList.toggle('phone', button.dataset.frame === 'phone');
  document.querySelectorAll('[data-frame]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
}));
document.getElementById('budget').addEventListener('change', event => { config.budget = event.target.value;if(config.budget!=='high'&&document.getElementById('comparison').value==='previous'){document.getElementById('comparison').value='before';document.getElementById('comparison').dispatchEvent(new Event('change'));} sendConfig(); });
document.getElementById('comparison').addEventListener('change',event=>{document.getElementById('before').src=`./scene.html?look=${event.target.value}`;document.querySelector('article h2').textContent=event.target.value==='previous'?'Previous Ultra':'Current Pallasite';document.querySelector('article .tag').textContent=event.target.value==='previous'?'PREVIOUS ART PASS':'EXISTING RENDERER';if(event.target.value==='previous'){config.budget='high';document.getElementById('budget').value='high';}sendConfig();});
document.querySelectorAll('[data-effect]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.effect;config[key]=!config[key];button.setAttribute('aria-pressed',String(config[key]));sendConfig();}));
motion.addEventListener('click', () => { config.paused = !config.paused; updateMotion(); sendConfig(); });
document.getElementById('replay').addEventListener('click',()=>{config.scene='collision';time=4500;config.paused=false;updateMotion();document.querySelectorAll('[data-scene]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scene==='collision')));sendConfig();});
// Read-only review controls for deterministic captures, separate from game state.
window.graphicsLab={seek(milliseconds){time=milliseconds;config.paused=true;updateMotion();sendConfig();},status(){return {time,...config};}};
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const frame = frames.find(frame => frame.contentWindow === event.source);
  if (!frame) return;
  if (event.data.type === 'ready') sendConfig();
  if (event.data.type === 'loading') { document.getElementById(frame.id+'-stats').textContent='Loading selected quality…';document.getElementById('asset-stats').textContent='Loading…'; }
  if(event.data.type==='fallback'){config.budget='balanced';document.getElementById('budget').value='balanced';sendConfig();document.getElementById('after-stats').textContent=event.data.message;}
  if (event.data.type === 'stats') {
    const timing = event.data.ms < .1 ? '<0.1' : event.data.ms.toFixed(1);
    document.getElementById(frame.id + '-stats').textContent = `${event.data.renderer} · ${timing} ms draw submission`;
    if (frame.id === 'after') document.getElementById('asset-stats').textContent = `${event.data.kb} KB scene assets · ${event.data.bgWidth} px background`;
  }
  if (event.data.type === 'error') document.getElementById(frame.id + '-stats').textContent = event.data.message;
});
function tick(now) {
  if(!document.hidden){const interval=now-previous;if(interval>0&&interval<1000)cadence.push(interval);if(cadence.length>180)cadence.shift();if(now-lastCadenceReport>1200&&cadence.length>20){lastCadenceReport=now;const sorted=[...cadence].sort((a,b)=>a-b);document.getElementById('cadence').textContent=`Preview cadence: ${Math.round(1000/sorted[Math.floor(sorted.length/2)])} fps median · ${Math.round(sorted[Math.floor(sorted.length*.95)])} ms p95 interval (both panels)`;}}
  if (!config.paused && !document.hidden) time += Math.min(50, now - previous);
  previous = now;
  if (!document.hidden) frames.forEach(frame => frame.contentWindow.postMessage({ type: 'tick', time }, location.origin));
  requestAnimationFrame(tick);
}
updateMotion();
document.getElementById('budget').value=config.budget;
document.querySelectorAll('[data-scene]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.scene===config.scene)));
if(query.get('compare')==='previous'){document.getElementById('comparison').value='previous';document.getElementById('comparison').dispatchEvent(new Event('change'));}
requestAnimationFrame(tick);
