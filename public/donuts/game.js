(() => {
'use strict';
const FACE_SRC = "face.png";
const TAU = Math.PI * 2;
const W = 450, H = 800, FLOOR = H - 44, HORIZON = H - 196;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.random() * a.length | 0];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }
function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return [c, c.getContext('2d')]; }
const face = new Image(); face.src = FACE_SRC;
document.getElementById('heroFace').src = FACE_SRC;

/* ================= AUDIO ================= */
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
let ac = null, master, musicBus, sfxBus, noiseBuf, muted = store.get('di.muted', false);
function audioInit() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
  master = ac.createGain(); master.gain.value = muted ? 0 : .9; master.connect(comp); comp.connect(ac.destination);
  musicBus = ac.createGain(); musicBus.gain.value = .3; musicBus.connect(master);
  sfxBus = ac.createGain(); sfxBus.gain.value = .85; sfxBus.connect(master);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
function tone({ f = 440, f2, type = 'square', t = 0, dur = .1, vol = .2, dest, attack = .005, filter, q = 1, vib }) {
  if (!ac) return;
  const T = ac.currentTime + Math.max(0, t);
  const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, T);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), T + dur);
  const g = ac.createGain(); g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(vol, T + attack);
  g.gain.exponentialRampToValueAtTime(.0001, T + dur);
  let node = o;
  if (filter) { const fl = ac.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = filter; fl.Q.value = q; o.connect(fl); node = fl; }
  if (vib) { const l = ac.createOscillator(), lg = ac.createGain(); l.frequency.value = vib[0]; lg.gain.value = vib[1];
    l.connect(lg); lg.connect(o.frequency); l.start(T); l.stop(T + dur + .05); }
  node.connect(g); g.connect(dest || sfxBus); o.start(T); o.stop(T + dur + .05);
}
function noise({ t = 0, dur = .1, vol = .2, type = 'lowpass', f = 1000, f2, q = 1, dest }) {
  if (!ac) return;
  const T = ac.currentTime + Math.max(0, t);
  const s = ac.createBufferSource(); s.buffer = noiseBuf;
  const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, T);
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, T + dur); fl.Q.value = q;
  const g = ac.createGain(); g.gain.setValueAtTime(vol, T); g.gain.exponentialRampToValueAtTime(.0001, T + dur);
  s.connect(fl); fl.connect(g); g.connect(dest || sfxBus); s.start(T, Math.random() * .5); s.stop(T + dur + .05);
}
const sfx = {
  slurp() { noise({ dur: .11, vol: .16, type: 'bandpass', f: 500, f2: 2800, q: 4 }); tone({ f: 520, f2: 1150, type: 'sine', dur: .08, vol: .07 }); },
  knock() { tone({ f: 520, f2: 940, type: 'square', dur: .07, vol: .08, filter: 2600 }); tone({ f: 260, f2: 560, type: 'triangle', dur: .12, vol: .2 }); },
  chomp(c) {
    noise({ dur: .07, vol: .45, f: 2600, f2: 500 }); tone({ f: 190, f2: 70, type: 'square', dur: .08, vol: .16, filter: 900 });
    const sc = [0, 2, 4, 7, 9], n = 72 + sc[c % 5] + 12 * (Math.floor(c / 5) % 3);
    tone({ f: mtof(n), type: 'triangle', t: .03, dur: .16, vol: .2 }); tone({ f: mtof(n + 12), type: 'sine', t: .03, dur: .12, vol: .06 });
  },
  golden() { [0, 4, 7, 12, 16, 19, 24].forEach((k, i) => tone({ f: mtof(79 + k), type: 'square', t: i * .045, dur: .14, vol: .07, filter: 5000 })); },
  burp() { tone({ f: 118, f2: 60, type: 'sawtooth', dur: .85, vol: .6, filter: 650, q: 5, vib: [26, 30], attack: .04 }); noise({ dur: .6, vol: .16, f: 380, q: 2 }); },
  splat() { noise({ dur: .32, vol: .5, f: 1400, f2: 120 }); tone({ f: 160, f2: 40, type: 'sine', dur: .3, vol: .45 }); },
  zap() { tone({ f: 1800, f2: 200, type: 'sawtooth', dur: .15, vol: .08, filter: 4000 }); noise({ dur: .1, vol: .15, type: 'highpass', f: 3000 }); },
  boxHit() { tone({ f: 320, f2: 180, type: 'square', dur: .08, vol: .12, filter: 1600 }); noise({ dur: .05, vol: .2, f: 2500 }); },
  boom() { noise({ dur: .8, vol: .8, f: 2400, f2: 60 }); tone({ f: 130, f2: 28, type: 'sine', dur: .7, vol: .8 }); },
  power() { [0, 3, 7, 12, 15, 19, 24, 27].forEach((k, i) => tone({ f: mtof(62 + k), type: 'square', t: i * .035, dur: .1, vol: .07, filter: 3200 })); },
  hurt() { [67, 66, 65, 64].forEach((n, i) => tone({ f: mtof(n - 12), type: 'sawtooth', t: i * .24, dur: i === 3 ? .9 : .22, vol: .24, filter: 1100, q: 4, vib: i === 3 ? [7, 10] : null })); },
  rush() { tone({ f: 200, f2: 1600, type: 'sawtooth', dur: .6, vol: .12, filter: 3000 }); noise({ dur: .6, vol: .25, type: 'bandpass', f: 400, f2: 5000, q: 2 }); },
  wave() { [72, 76, 79, 84].forEach((n, i) => tone({ f: mtof(n), type: 'square', t: i * .1, dur: .14, vol: .09, filter: 3500 }));
    tone({ f: mtof(88), type: 'square', t: .42, dur: .45, vol: .09, filter: 3500, vib: [6, 6] }); },
  bossIn() { [45, 44, 43, 42].forEach((n, i) => tone({ f: mtof(n), type: 'sawtooth', t: i * .2, dur: .32, vol: .3, filter: 900, q: 3 })); },
  bossHit() { tone({ f: 230, f2: 140, type: 'square', dur: .06, vol: .1, filter: 2000 }); noise({ dur: .05, vol: .18, f: 3000 }); },
  clear() { [60, 64, 67, 72, 0, 67, 72, 76].forEach((n, i) => n && tone({ f: mtof(n + 12), type: 'square', t: i * .09, dur: .16, vol: .09, filter: 4000 })); },
  over() { [67, 63, 60, 55, 48].forEach((n, i) => tone({ f: mtof(n), type: 'triangle', t: i * .28, dur: .4, vol: .25 })); },
  pop() { tone({ f: 600, f2: 1400, type: 'sine', dur: .08, vol: .15 }); },
};

/* Music: tiny step sequencer. 16th-note steps, 8-bar loop. */
const MAIN_LEAD = [72, 0, 76, 79, 76, 0, 72, 74, 76, 0, 72, 69, 72, 0, 76, 0, 77, 0, 76, 74, 72, 0, 74, 76, 79, 0, 77, 76, 74, 0, 71, 74];
const BOSS_LEAD = [69, 0, 72, 76, 74, 72, 71, 72, 65, 0, 69, 72, 71, 69, 67, 69, 62, 0, 65, 69, 67, 65, 64, 65, 64, 68, 71, 74, 76, 0, 75, 76];
const SONGS = {
  main: { bpm: 128, tr: 0, chords: [[48, [0, 4, 7]], [45, [0, 3, 7]], [41, [0, 4, 7]], [43, [0, 4, 7]]], lead: MAIN_LEAD },
  rush: { bpm: 158, tr: 2, chords: [[48, [0, 4, 7]], [45, [0, 3, 7]], [41, [0, 4, 7]], [43, [0, 4, 7]]], lead: MAIN_LEAD, always: true, kick2: true },
  boss: { bpm: 144, tr: 0, chords: [[45, [0, 3, 7]], [41, [0, 4, 7]], [38, [0, 3, 7]], [40, [0, 4, 7]]], lead: BOSS_LEAD, always: true, kick2: true },
};
let song = SONGS.main, step = 0, nextT = 0, seqTimer = null;
function musicStart(name) { if (!ac) return; song = SONGS[name]; if (!seqTimer) { nextT = ac.currentTime + .06; step = 0; seqTimer = setInterval(schedule, 25); } }
function musicSet(name) { song = SONGS[name]; }
function musicStop() { clearInterval(seqTimer); seqTimer = null; }
function schedule() {
  while (nextT < ac.currentTime + .12) { playStep(step, nextT - ac.currentTime); nextT += 60 / song.bpm / 4; step = (step + 1) % 128; }
}
function playStep(s, t) {
  const bar = s >> 4, st = s & 15, [root, ch] = song.chords[bar % 4], tr = song.tr, M = musicBus;
  if (st % 8 === 0 || (song.kick2 && st === 10)) tone({ f: 150, f2: 40, type: 'sine', t, dur: .16, vol: .9, dest: M });
  if (st === 4 || st === 12) { noise({ t, dur: .12, vol: .32, type: 'bandpass', f: 1900, q: .8, dest: M }); tone({ f: 210, f2: 120, type: 'triangle', t, dur: .08, vol: .3, dest: M }); }
  if (st % 2 === 0) noise({ t, dur: .03, vol: st % 4 === 2 ? .12 : .06, type: 'highpass', f: 8000, dest: M });
  if (st % 2 === 0) { const n = root + tr + (st % 4 === 2 ? 12 : 0);
    tone({ f: mtof(n), type: 'triangle', t, dur: .18, vol: .55, dest: M }); tone({ f: mtof(n), type: 'square', t, dur: .1, vol: .07, filter: 600, dest: M }); }
  const arp = root + 24 + tr + ch[st % 3] + (st % 6 >= 3 ? 12 : 0);
  tone({ f: mtof(arp), type: 'square', t, dur: .07, vol: .045, filter: 3000, dest: M });
  if (st % 2 === 0 && (song.always || bar >= 4)) { const m = song.lead[(bar % 4) * 8 + st / 2];
    if (m) tone({ f: mtof(m + tr), type: 'square', t, dur: .2, vol: .11, filter: 4200, vib: [6, 4], dest: M }); }
}

/* ================= SPRITES ================= */
const SS = 2;
const FLAVORS = [
  { ic: ['#ff5fa8', '#ffc0dc'], spr: true },
  { ic: ['#5a2a14', '#9a5a34'], spr: true },
  { ic: ['#fff1d6', '#ffffff'], spr: true },
  { ic: ['#38b6ff', '#b5ecff'], dr: '#ffffff' },
  { ic: ['#9d5cff', '#d9c2ff'], spr: true },
  { ic: ['#ffd23f', '#fff4b0'], dr: '#ff5fa8' },
  { ic: ['#3fe3bb', '#c9fff1'], dr: '#5a2a14' },
  { ic: null, sugar: true },
];
const GOLD = { ic: ['#f5a300', '#fff3b0'], spr: false, gold: true };
const SPRINKLE_COLS = ['#ff3b5c', '#3bff8a', '#3bb4ff', '#ffffff', '#ffe03b', '#ff8af0', '#ff9a3b'];
function donutSprite(r, fl) {
  const pad = 6, half = r + pad, [c, g] = mk(half * 2 * SS, half * 2 * SS);
  g.scale(SS, SS); g.translate(half, half);
  const seed = Math.random() * 10;
  g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(2, 4, r, r * .95, 0, 0, TAU); g.fill();
  const dg = g.createRadialGradient(-r * .3, -r * .35, r * .15, 0, 0, r);
  dg.addColorStop(0, '#f8d596'); dg.addColorStop(.65, '#dc9a45'); dg.addColorStop(1, '#9c5a1c');
  g.fillStyle = dg; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.arc(0, 0, r * .34, 0, TAU, true); g.fill('evenodd');
  g.strokeStyle = 'rgba(80,38,8,.55)'; g.lineWidth = r * .08; g.beginPath(); g.arc(0, 0, r * .37, 0, TAU); g.stroke();
  if (fl.ic) {
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = i / 48 * TAU;
      let rr = r * (.84 + .045 * Math.sin(a * 5 + seed) + .03 * Math.sin(a * 11 + seed * 2));
      if (Math.sin(a * 3 + seed) > .82 && a > .3 && a < 2.8) rr += r * .1;
      i ? g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath(); g.moveTo(r * .45, 0); g.arc(0, 0, r * .45, 0, TAU, true);
    const ig = g.createRadialGradient(-r * .35, -r * .45, r * .05, 0, 0, r * 1.05);
    ig.addColorStop(0, fl.ic[1]); ig.addColorStop(.55, fl.ic[0]); ig.addColorStop(1, fl.ic[0]);
    g.fillStyle = ig; g.fill('evenodd');
    g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 1.2; g.stroke();
    if (fl.spr) for (let k = 0; k < 16; k++) {
      const a = rand(0, TAU), rr = rand(.55, .76) * r, rot = rand(0, Math.PI), x = Math.cos(a) * rr, y = Math.sin(a) * rr, l = r * .1;
      g.strokeStyle = SPRINKLE_COLS[k % SPRINKLE_COLS.length]; g.lineWidth = r * .085; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x - Math.cos(rot) * l, y - Math.sin(rot) * l); g.lineTo(x + Math.cos(rot) * l, y + Math.sin(rot) * l); g.stroke();
    }
    if (fl.dr) { g.strokeStyle = fl.dr; g.lineWidth = r * .07; g.lineCap = 'round'; g.beginPath();
      for (let i = 0; i <= 14; i++) { const x = -r * .78 + i * r * .112, y = (i % 2 ? -1 : 1) * r * .62 * Math.sqrt(Math.max(0, 1 - (x / (r * .85)) ** 2));
        i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.save(); g.beginPath(); g.arc(0, 0, r * .84, 0, TAU); g.arc(0, 0, r * .46, 0, TAU, true); g.clip('evenodd');
      g.beginPath(); for (let i = 0; i <= 14; i++) { const x = -r * .78 + i * r * .112, y = (i % 2 ? -1 : 1) * r * .7; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.restore(); }
    if (fl.gold) { g.fillStyle = 'rgba(255,255,255,.9)';
      for (let k = 0; k < 7; k++) { const a = rand(0, TAU), rr = rand(.55, .78) * r; star(g, Math.cos(a) * rr, Math.sin(a) * rr, r * .1); } }
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = r * .1; g.lineCap = 'round';
    g.beginPath(); g.arc(0, 0, r * .68, Math.PI * 1.1, Math.PI * 1.42); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.8)'; g.beginPath(); g.arc(Math.cos(Math.PI * 1.55) * r * .68, Math.sin(Math.PI * 1.55) * r * .68, r * .05, 0, TAU); g.fill();
  } else {
    g.fillStyle = 'rgba(255,255,255,.85)';
    for (let k = 0; k < 90; k++) { const a = rand(0, TAU), rr = rand(.38, .98) * r; g.fillRect(Math.cos(a) * rr, Math.sin(a) * rr, 1.3, 1.3); }
  }
  return { c, half };
}
function star(g, x, y, s) {
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU, rr = i % 2 ? s * .35 : s; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  g.closePath(); g.fill();
}
function broccoliSprite(r) {
  const half = r + 6, [c, g] = mk(half * 2 * SS, half * 2 * SS);
  g.scale(SS, SS); g.translate(half, half);
  const sg = g.createLinearGradient(-r * .3, 0, r * .3, 0); sg.addColorStop(0, '#b6e388'); sg.addColorStop(1, '#6fa33f');
  g.fillStyle = sg; g.beginPath(); g.moveTo(-r * .28, 0); g.lineTo(-r * .2, r * .95); g.quadraticCurveTo(0, r * 1.05, r * .2, r * .95); g.lineTo(r * .28, 0); g.fill();
  [[-.5, -.05, .42], [.5, -.05, .42], [-.25, -.45, .45], [.25, -.45, .45], [0, -.1, .48], [0, -.62, .35]].forEach(([x, y, s]) => {
    const fg = g.createRadialGradient(x * r - s * r * .3, y * r - s * r * .3, 1, x * r, y * r, s * r);
    fg.addColorStop(0, '#5fd35f'); fg.addColorStop(1, '#1d6b26'); g.fillStyle = fg;
    g.beginPath(); g.arc(x * r, y * r, s * r, 0, TAU); g.fill();
  });
  g.fillStyle = 'rgba(160,255,140,.5)'; for (let k = 0; k < 14; k++) { g.beginPath(); g.arc(rand(-.7, .7) * r, rand(-.85, .15) * r, r * .06, 0, TAU); g.fill(); }
  // angry little face
  g.fillStyle = '#fff'; [-1, 1].forEach(sd => { g.beginPath(); g.ellipse(sd * r * .24, -r * .16, r * .14, r * .16, 0, 0, TAU); g.fill(); });
  g.fillStyle = '#111'; [-1, 1].forEach(sd => { g.beginPath(); g.arc(sd * r * .21, -r * .12, r * .07, 0, TAU); g.fill(); });
  g.strokeStyle = '#0b3310'; g.lineWidth = r * .09; g.lineCap = 'round';
  [-1, 1].forEach(sd => { g.beginPath(); g.moveTo(sd * r * .42, -r * .38); g.lineTo(sd * r * .1, -r * .27); g.stroke(); });
  g.beginPath(); g.arc(0, r * .2, r * .14, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  return { c, half };
}
const POWERS = {
  triple: { emoji: '🌈', name: 'RAINBOW SLURP', dur: 9, col: '#9d5cff' },
  coffee: { emoji: '☕', name: 'ESPRESSO SHOT', dur: 9, col: '#c7861a' },
  magnet: { emoji: '🧲', name: 'SUGAR MAGNET', dur: 10, col: '#ff3b5c' },
  mega:   { emoji: '😮', name: 'MEGA MOUTH', dur: 10, col: '#38b6ff' },
  heart:  { emoji: '❤️', name: 'EXTRA LIFE', col: '#ff5fa8' },
};
function powerSprite(p) {
  const r = 17, half = r + 8, [c, g] = mk(half * 2 * SS, half * 2 * SS);
  g.scale(SS, SS); g.translate(half, half);
  const bg = g.createRadialGradient(-r * .3, -r * .4, 2, 0, 0, r);
  bg.addColorStop(0, '#ffffff'); bg.addColorStop(.35, p.col); bg.addColorStop(1, '#1a0a30');
  g.fillStyle = bg; g.globalAlpha = .9; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill(); g.globalAlpha = 1;
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  g.font = `${r * 1.15}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(p.emoji, 0, 1);
  g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(-r * .4, -r * .5, r * .25, r * .12, -.6, 0, TAU); g.fill();
  return { c, half };
}
const SPR = { donut: FLAVORS.map(f => [0, 1, 2].map(() => donutSprite(20, f))), gold: donutSprite(22, GOLD), broc: broccoliSprite(17), power: {} };
for (const k in POWERS) SPR.power[k] = powerSprite(POWERS[k]);
function blit(g, s, x, y, rot = 0, sc = 1) {
  g.save(); g.translate(x, y); if (rot) g.rotate(rot); if (sc !== 1) g.scale(sc, sc);
  g.drawImage(s.c, -s.half, -s.half, s.half * 2, s.half * 2); g.restore();
}
// legend icons on the menu
document.querySelectorAll('canvas[data-icon]').forEach(cnv => {
  const g = cnv.getContext('2d'), k = cnv.dataset.icon; g.scale(2, 2);
  const s = k === 'donut' ? SPR.donut[0][0] : k === 'broc' ? SPR.broc : k === 'golden' ? SPR.gold : SPR.power.triple;
  const sc = 30 / (s.half * 2); blit(g, s, 17, 17, 0, sc * 1.1);
});

/* ================= BACKGROUND ================= */
const [skyC, sky] = mk(W, H);
(() => {
  const gr = sky.createLinearGradient(0, 0, 0, HORIZON);
  gr.addColorStop(0, '#0d0721'); gr.addColorStop(.45, '#2a0f4a'); gr.addColorStop(.8, '#7a1d6e'); gr.addColorStop(1, '#ff6f91');
  sky.fillStyle = gr; sky.fillRect(0, 0, W, HORIZON + 1);
  const gg = sky.createLinearGradient(0, HORIZON, 0, H); gg.addColorStop(0, '#2b0b3f'); gg.addColorStop(1, '#0a0418');
  sky.fillStyle = gg; sky.fillRect(0, HORIZON, W, H - HORIZON);
})();
const [cityC, city] = mk(W * SS, H * SS);
(() => {
  const g = city; g.scale(SS, SS);
  // donut planet setting behind the city
  const R = 132, cx = W * .5, cy = HORIZON + 8;
  const glow = g.createRadialGradient(cx, cy, R * .6, cx, cy, R * 1.8); glow.addColorStop(0, 'rgba(255,111,145,.45)'); glow.addColorStop(1, 'rgba(255,111,145,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, HORIZON);
  const [pc, p] = mk(W, H);
  const pg = p.createLinearGradient(0, cy - R, 0, cy); pg.addColorStop(0, '#ffd36b'); pg.addColorStop(.6, '#ff8a7a'); pg.addColorStop(1, '#ff4f9a');
  p.fillStyle = pg; p.beginPath(); p.arc(cx, cy, R, 0, TAU); p.arc(cx, cy, R * .34, 0, TAU, true); p.fill('evenodd');
  p.fillStyle = 'rgba(255,255,255,.5)';
  for (let k = 0; k < 40; k++) { const a = rand(Math.PI, TAU), rr = rand(.45, .95) * R; p.save(); p.translate(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); p.rotate(rand(0, 3)); p.fillRect(-3, -1, 6, 2); p.restore(); }
  p.globalCompositeOperation = 'destination-out'; p.fillStyle = '#000';
  for (let i = 0, y = cy - 6; i < 9; i++) { const h = 1.5 + i * 1.3; p.fillRect(0, y - h, W, h); y -= 7 + i * 2.2; }
  p.fillRect(0, HORIZON, W, H);
  g.drawImage(pc, 0, 0);
  // skyline, back layer then front layer with lit windows
  let x = -10; g.fillStyle = '#3a1458';
  while (x < W) { const w = rand(26, 56), h = rand(50, 140); g.fillRect(x, HORIZON - h, w, h); x += w + rand(-4, 4); }
  x = -6;
  const wins = ['#ffcf6b', '#ff8fc8', '#7ef0ff'];
  while (x < W) {
    const w = rand(34, 64), h = (x > W * .66 && x < W * .8) ? 112 : rand(26, 90);
    g.fillStyle = '#170828'; g.fillRect(x, HORIZON - h, w, h);
    for (let wy = HORIZON - h + 7; wy < HORIZON - 6; wy += 9) for (let wx = x + 5; wx < x + w - 5; wx += 8)
      if (Math.random() < .28) { g.fillStyle = pick(wins); g.globalAlpha = rand(.45, .95); g.fillRect(wx, wy, 3, 4); g.globalAlpha = 1; }
    x += w + 2;
  }
})();
const [vigC, vig] = mk(W, H);
(() => { const r = vig.createRadialGradient(W / 2, H * .45, H * .25, W / 2, H * .5, H * .75);
  r.addColorStop(0, 'rgba(0,0,0,0)'); r.addColorStop(1, 'rgba(0,0,0,.55)'); vig.fillStyle = r; vig.fillRect(0, 0, W, H); })();
const stars = Array.from({ length: 90 }, () => ({ x: rand(0, W), y: rand(0, HORIZON - 40), s: rand(.6, 2), ph: rand(0, TAU), sp: rand(1, 4) }));

/* ================= CANVAS ================= */
const cv = document.getElementById('game'), ctx = cv.getContext('2d');
let scale = 1, dpr = 1;
const hudBtns = document.getElementById('hudBtns');
function resize() {
  const st = document.getElementById('stage').getBoundingClientRect();
  dpr = Math.min(2, window.devicePixelRatio || 1);
  scale = Math.min(st.width / W, st.height / H);
  cv.style.width = W * scale + 'px'; cv.style.height = H * scale + 'px';
  cv.width = Math.round(W * scale * dpr); cv.height = Math.round(H * scale * dpr);
  placeButtons();
}
function placeButtons() {
  const r = cv.getBoundingClientRect();
  hudBtns.style.top = (r.top + 12 * scale) + 'px';
  hudBtns.style.left = (r.right - 12 * scale - (hudBtns.offsetWidth || 84)) + 'px';
}
addEventListener('resize', resize); resize();

/* ================= STATE ================= */
const G = { state: 'menu', score: 0, best: store.get('di.best', 0), wave: 0, hearts: 3, strikes: 0, combo: 0, bestCombo: 0, eaten: 0,
  sugar: 0, rush: 0, inv: 0, timeScale: 1, hitstop: 0, shake: 0, flash: 0, flashCol: '#fff', clearing: 0, t: 0, gridT: 0, dying: 0,
  pw: { triple: 0, coffee: 0, magnet: 0, mega: 0 }, sign: 1, waveWasted: 0 };
const P = { x: W / 2, y: 0, vx: 0, lean: 0, chomp: 0, scale: 1, glasses: 0, sad: 0, cd: 0, prevX: W / 2 };
let fleet = [], fleetDir = 1, fleetSpeed = 30, fleetStart = 1, dropT = 0, brocT = 0;
let falling = [], beams = [], parts = [], texts = [], rings = [], decals = [], box = null, boxT = 10, boss = null, banner = null, attract = [];
document.getElementById('menuBest').textContent = G.best.toLocaleString();

/* ================= INPUT ================= */
const keys = {};
let touchX = null, touching = false;
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
});
addEventListener('keyup', e => { keys[e.code] = false; });
const toLogical = cx => (cx - cv.getBoundingClientRect().left) / scale;
cv.addEventListener('pointerdown', e => { touching = true; touchX = toLogical(e.clientX); e.preventDefault(); });
addEventListener('pointermove', e => { if (touching) touchX = toLogical(e.clientX); });
addEventListener('pointerup', () => { touching = false; });
addEventListener('pointercancel', () => { touching = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; touching = false; });

const $ = id => document.getElementById(id);
function show(id) { ['menu', 'over', 'pause'].forEach(s => $(s).hidden = s !== id); }
$('startBtn').onclick = () => { audioInit(); newGame(); };
$('againBtn').onclick = () => { audioInit(); newGame(); };
$('resumeBtn').onclick = () => togglePause();
$('pauseBtn').onclick = () => togglePause();
function setMuteIcon() { $('muteBtn').style.opacity = muted ? .45 : 1; $('muteBtn').setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound'); }
$('muteBtn').onclick = () => { muted = !muted; store.set('di.muted', muted); if (master) master.gain.value = muted ? 0 : .9; setMuteIcon(); };
setMuteIcon();
function togglePause() {
  if (G.state === 'play') { G.state = 'paused'; show('pause'); if (ac) ac.suspend(); }
  else if (G.state === 'paused') { G.state = 'play'; show(null); if (ac) ac.resume(); }
}
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play') togglePause(); });

/* ================= GAME FLOW ================= */
function newGame() {
  Object.assign(G, { state: 'play', score: 0, wave: 0, hearts: 3, strikes: 0, combo: 0, bestCombo: 0, eaten: 0, sugar: 0, rush: 0, inv: 0,
    timeScale: 1, hitstop: 0, clearing: 0, dying: 0, pw: { triple: 0, coffee: 0, magnet: 0, mega: 0 } });
  Object.assign(P, { x: W / 2, vx: 0, chomp: 0, scale: 1, glasses: 0, sad: 0, cd: .3 });
  fleet = []; falling = []; beams = []; parts = []; texts = []; rings = []; decals = []; box = null; boxT = rand(9, 14); boss = null; attract = [];
  show(null); hudBtns.hidden = false; placeButtons();
  musicStop(); musicStart('main');
  startWave();
}
function startWave() {
  G.wave++; G.waveWasted = 0; G.clearing = 0;
  if (G.wave % 4 === 0) { spawnBoss(); musicSet('boss'); sfx.bossIn();
    banner = { title: 'BOSS', sub: 'THE GLAZED GOLIATH', life: 2.6, max: 2.6, col: '#ff3b5c' }; }
  else { spawnFleet(); musicSet(G.rush > 0 ? 'rush' : 'main'); sfx.wave();
    const subs = ['EAT THEM ALL!', 'BEWARE THE BROCCOLI', 'SECOND HELPINGS', 'NO DIET TODAY', 'GLAZE FOR DAYS', 'ALL YOU CAN EAT'];
    banner = { title: 'WAVE ' + G.wave, sub: subs[Math.min(G.wave - 1, subs.length - 1)], life: 2.2, max: 2.2, col: '#ff5fa8' }; }
}
function spawnFleet() {
  fleet = [];
  const rows = Math.min(3 + Math.floor(G.wave / 2), 6), cols = 7, sx = (W - (cols - 1) * 54) / 2;
  const goldIdx = Math.random() * rows * cols | 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const gold = r * cols + c === goldIdx;
    const fi = (r + Math.floor(G.wave / 1.5)) % (FLAVORS.length);
    fleet.push({ x: sx + c * 54, y: 140 + r * 46 - 260, ty: 140 + r * 46, r: 20, gold, spr: gold ? SPR.gold : pick(SPR.donut[fi]), bob: rand(0, TAU) });
  }
  fleetStart = fleet.length; fleetDir = 1; fleetSpeed = 26 + G.wave * 6;
  dropT = 1.6; brocT = 3;
}
function spawnBoss() {
  const r = 78, s = donutSprite(r, FLAVORS[0]);
  const hp = 36 + G.wave * 4;
  boss = { x: W / 2, y: -140, r, hp, max: hp, t: 0, spr: s, hit: 0, attackT: 2.5, rainT: 1.5, enter: true };
}
function eatable(f) { return f.kind === 'donut' || f.kind === 'gold'; }
function checkClear() {
  if (G.clearing || boss || fleet.length || falling.some(eatable)) return;
  G.clearing = 2.6;
  const perfect = G.waveWasted === 0, bonus = 500 * G.wave + (perfect ? 2000 : 0);
  G.score += bonus; G.hearts = Math.min(5, G.hearts + 1);
  falling = falling.filter(f => f.kind !== 'broc');
  sfx.clear(); setTimeout(() => sfx.burp(), 650);
  G.timeScale = .35;
  banner = { title: perfect ? 'PERFECT!' : 'WAVE CLEAR', sub: `+${bonus.toLocaleString()}  +1 LIFE`, life: 2.4, max: 2.4, col: perfect ? '#ffc94a' : '#5ff5d0' };
  addText('BUUURP!', P.x, P.y - 90, 30, '#5ff5d0');
}

/* ================= EFFECTS ================= */
function addText(text, x, y, size = 18, col = '#ffc94a', life = 1) { texts.push({ text, x, y, size, col, life, max: life }); }
function burst(x, y, n, opts = {}) {
  for (let i = 0; i < n && parts.length < 500; i++) {
    const a = opts.up ? rand(-Math.PI * .95, -Math.PI * .05) : rand(0, TAU), v = rand(opts.min || 40, opts.speed || 220);
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(.5, 1.1) * (opts.life || 1), max: 1,
      type: opts.type || 'sprinkle', col: opts.cols ? pick(opts.cols) : pick(SPRINKLE_COLS), s: rand(2, 4) * (opts.size || 1),
      rot: rand(0, TAU), vr: rand(-12, 12), g: opts.g ?? 520 });
  }
}
function ring(x, y, col = '#fff', max = 80, life = .45) { rings.push({ x, y, r: 6, max, life, l0: life, col }); }
function shake(v) { G.shake = Math.max(G.shake, v * (reduceMotion ? .2 : 1)); }
function flash(col, v = .35) { G.flash = v; G.flashCol = col; }

/* ================= GAMEPLAY EVENTS ================= */
function faceDims() { const s = P.scale; return { fw: 100 * s, fh: 112 * s }; }
function eat(f) {
  G.combo++; G.bestCombo = Math.max(G.bestCombo, G.combo); G.eaten++;
  const mult = Math.min(8, 1 + Math.floor(G.combo / 5)) * (G.rush > 0 ? 2 : 1);
  const gold = f.kind === 'gold', pts = (gold ? 1000 : 100) * mult;
  G.score += pts; G.sugar = Math.min(100, G.sugar + (gold ? 45 : 7));
  P.chomp = 1; sfx.chomp(G.combo); vibrate(12);
  const { fh } = faceDims(), my = P.y + fh * .32;
  burst(P.x, my, 10, { type: 'crumb', cols: ['#dc9a45', '#f8d596', '#9c5a1c'], speed: 180, up: true });
  burst(P.x, my, 8, { speed: 200, up: true });
  addText('+' + pts, P.x + rand(-20, 20), P.y - fh * .6, 16 + Math.min(mult, 8), gold ? '#ffc94a' : '#fff4e3', .9);
  if (gold) { sfx.golden(); ring(P.x, my, '#ffc94a', 120); flash('#ffc94a', .25); G.hitstop = .06; addText('GOLDEN!', P.x, P.y - fh - 10, 30, '#ffc94a', 1.3); }
  else if (Math.random() < .3) addText(pick(['NOM!', 'YUM!', 'MMMM!', 'CHOMP!', 'GULP!', 'DELISH!', "D'OH-NUT!", 'SCRUMPTIOUS!']), P.x + rand(-60, 60), P.y - fh - rand(10, 40), 20, pick(['#ff5fa8', '#5ff5d0', '#ffc94a']), 1);
  if (G.combo % 10 === 0) { setTimeout(() => sfx.burp(), 120); addText('BUUURP!', P.x, P.y - fh - 40, 34, '#5ff5d0', 1.4); shake(.25); ring(P.x, my, '#5ff5d0', 140, .6);
    burst(P.x, my - 20, 12, { type: 'bubble', cols: ['#c9fff1'], speed: 90, g: -120, up: true, life: 1.4 }); }
  if (G.sugar >= 100 && G.rush <= 0) startRush();
}
function startRush() {
  G.rush = 9; G.sugar = 100; sfx.rush(); musicSet(boss ? 'boss' : 'rush'); flash('#ff5fa8', .5); shake(.3);
  banner = { title: 'SUGAR RUSH', sub: 'DOUBLE POINTS  AUTO SLURP', life: 2, max: 2, col: '#ffc94a' };
}
function waste(f) {
  G.combo = 0; G.strikes++; G.waveWasted++; sfx.splat(); shake(.12);
  const col = f.spr === SPR.gold ? '#f5a300' : pick(['#ff5fa8', '#dc9a45', '#9d5cff', '#38b6ff']);
  decals.push({ x: f.x, col, life: 7, w: rand(26, 36) });
  burst(f.x, FLOOR - 4, 16, { type: 'crumb', cols: ['#dc9a45', '#f8d596', col], speed: 200, up: true });
  addText('WASTED!', f.x, FLOOR - 30, 18, '#ff3b5c', 1);
  if (G.strikes >= 3) { G.strikes = 0; hurt('You wasted too many donuts.'); }
}
function hurt(why) {
  if (G.inv > 0 || G.state !== 'play') return;
  G.hearts--; G.inv = 1.8; G.combo = 0; P.sad = 1.2;
  sfx.hurt(); vibrate([60, 40, 90]); shake(.55); flash('#ff3b5c', .45);
  addText(pick(['OUCH!', 'BLEURGH!', 'NOT GREENS!']), P.x, P.y - 90, 26, '#ff3b5c', 1.1);
  if (G.hearts <= 0) gameOver(why);
}
function gameOver(why) {
  G.state = 'dying'; G.dying = 2; G.timeScale = .3; musicStop(); sfx.over();
  const isBest = G.score > G.best; if (isBest) { G.best = G.score; store.set('di.best', G.best); }
  const ranks = [[10, 'Light Snacker'], [30, 'Glazed Gourmand'], [60, 'Sprinkle Destroyer'], [100, 'Dough Master'], [1e9, 'Donut Deity']];
  $('overRank').textContent = ranks.find(r => G.eaten < r[0])[1];
  $('overWhy').textContent = why; $('overNew').hidden = !isBest;
  $('stScore').textContent = G.score.toLocaleString(); $('stEaten').textContent = G.eaten;
  $('stCombo').textContent = G.bestCombo; $('stWave').textContent = G.wave;
  $('overBest').textContent = G.best.toLocaleString(); $('menuBest').textContent = G.best.toLocaleString();
}
function givePower(k) {
  const p = POWERS[k]; sfx.power(); flash(p.col, .25);
  if (k === 'heart') G.hearts = Math.min(5, G.hearts + 1); else G.pw[k] = p.dur;
  addText(p.name, P.x, P.y - 100, 22, '#fff4e3', 1.4); ring(P.x, P.y, p.col, 130);
}
function dropPower(x, y, k) {
  k = k || pick(['triple', 'coffee', 'magnet', 'mega', 'triple', 'coffee', G.hearts < 3 ? 'heart' : 'mega']);
  falling.push({ kind: 'power', p: k, x, y, vx: rand(-30, 30), vy: -120, rot: 0, vr: 0, r: 17 });
}
function knockLoose(d) {
  falling.push({ kind: d.gold ? 'gold' : 'donut', x: d.x, y: d.y, vx: rand(-50, 50), vy: -150, rot: 0, vr: rand(-6, 6), r: d.r, spr: d.spr });
  burst(d.x, d.y, 8, { speed: 150 }); ring(d.x, d.y, '#fff4e3', 34, .25); sfx.knock(); G.score += 10;
  if (Math.random() < .045) dropPower(d.x, d.y);
}

/* ================= UPDATE ================= */
function update(rdt) {
  G.t += rdt;
  G.timeScale = lerp(G.timeScale, 1, Math.min(1, rdt * (G.state === 'dying' ? .3 : 2)));
  if (G.hitstop > 0) { G.hitstop -= rdt; return; }
  const dt = rdt * G.timeScale;
  G.gridT += dt * (G.rush > 0 ? 2.2 : 1);
  G.shake = Math.max(0, G.shake - rdt * 1.4); G.flash = Math.max(0, G.flash - rdt * 1.6);
  if (Math.random() < .01) G.sign = 0; else if (G.sign === 0 && Math.random() < .3) G.sign = 1;

  for (const p of parts) { p.life -= dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
    if (p.type !== 'bubble' && p.y > FLOOR && p.vy > 0) { p.y = FLOOR; p.vy *= -.3; p.vx *= .6; } }
  parts = parts.filter(p => p.life > 0);
  for (const t of texts) { t.life -= rdt; t.y -= 34 * rdt; } texts = texts.filter(t => t.life > 0);
  for (const r of rings) { r.life -= dt; r.r = lerp(r.max, 6, r.life / r.l0); } rings = rings.filter(r => r.life > 0);
  for (const d of decals) d.life -= dt; decals = decals.filter(d => d.life > 0);
  if (banner && (banner.life -= rdt) <= 0) banner = null;

  if (G.state === 'menu') {
    if (Math.random() < dt * 3) attract.push({ x: rand(20, W - 20), y: -30, vy: rand(80, 200), rot: 0, vr: rand(-3, 3), spr: Math.random() < .08 ? SPR.gold : pick(pick(SPR.donut)) });
    for (const a of attract) { a.y += a.vy * dt; a.rot += a.vr * dt; }
    attract = attract.filter(a => a.y < H + 40);
    return;
  }
  if (G.state === 'dying') {
    G.dying -= rdt; P.sad = 1; if (Math.random() < rdt * 3) addText('z', P.x + rand(10, 40), P.y - 60, rand(16, 26), '#c9fff1', 1.5);
    if (G.dying <= 0) { G.state = 'over'; show('over'); hudBtns.hidden = true; }
    return;
  }
  if (G.state !== 'play') return;

  // timers
  for (const k in G.pw) G.pw[k] = Math.max(0, G.pw[k] - dt);
  if (G.rush > 0) { G.rush -= dt; G.sugar = Math.max(0, 100 * G.rush / 9); if (G.rush <= 0) { G.sugar = 0; musicSet(boss ? 'boss' : 'main'); } }
  G.inv = Math.max(0, G.inv - dt); P.sad = Math.max(0, P.sad - dt); P.chomp = Math.max(0, P.chomp - dt * 4.5);
  P.glasses = lerp(P.glasses, G.rush > 0 ? 1 : 0, Math.min(1, dt * 6));
  P.scale = lerp(P.scale, G.pw.mega > 0 ? 1.5 : 1, Math.min(1, dt * 5));
  const { fw, fh } = faceDims();
  P.y = FLOOR - 50 - fh * .42;

  // player movement
  const fast = G.pw.coffee > 0 || G.rush > 0;
  let ax = (keys.ArrowLeft || keys.KeyA ? -1 : 0) + (keys.ArrowRight || keys.KeyD ? 1 : 0);
  if (touching && touchX !== null) { P.x = lerp(P.x, touchX, Math.min(1, dt * (fast ? 22 : 15))); P.vx = 0; }
  else { P.vx += ax * (fast ? 4200 : 3000) * dt; P.vx *= Math.pow(fast ? .0004 : .001, dt); P.x += P.vx * dt; }
  P.x = clamp(P.x, fw * .45, W - fw * .45);
  const v = (P.x - P.prevX) / Math.max(dt, 1e-4); P.prevX = P.x;
  P.lean = lerp(P.lean, clamp(v / 1400, -.3, .3), Math.min(1, dt * 10));

  // firing
  P.cd -= dt;
  const firing = keys.Space || keys.ArrowUp || keys.KeyW || touching || G.rush > 0;
  if (firing && P.cd <= 0) {
    const spread = G.pw.triple > 0 || G.rush > 0 ? [-.2, 0, .2] : [0];
    for (const a of spread) beams.push({ x: P.x, y: P.y - fh * .5, vx: Math.sin(a) * 780, vy: -Math.cos(a) * 780, hue: rand(0, 360) });
    P.cd = fast ? .13 : .3; sfx.slurp();
  }
  for (const b of beams) { b.x += b.vx * dt; b.y += b.vy * dt; }
  beams = beams.filter(b => {
    if (b.y < -30 || b.x < -20 || b.x > W + 20) return false;
    for (let i = 0; i < fleet.length; i++) { const d = fleet[i];
      if (Math.abs(b.x - d.x) < d.r + 4 && Math.abs(b.y - d.y) < d.r + 6) { fleet.splice(i, 1); knockLoose(d); return false; } }
    for (const f of falling) if (f.kind === 'broc' && Math.hypot(b.x - f.x, b.y - f.y) < f.r + 8) {
      f.dead = true; sfx.zap(); G.score += 25; burst(f.x, f.y, 14, { cols: ['#2f8a2f', '#5fd35f', '#b6e388'], speed: 200 }); addText('ZAPPED +25', f.x, f.y, 14, '#5ff5d0', .8); return false; }
    if (box && Math.abs(b.x - box.x) < 40 && Math.abs(b.y - box.y) < 26) {
      box.hp--; box.hit = .12; sfx.boxHit(); burst(b.x, b.y, 6, { cols: ['#ff5fa8', '#fff'], speed: 140 }); G.score += 50;
      if (box.hp <= 0) openBox(); return false; }
    if (boss && !boss.enter && Math.hypot(b.x - boss.x, b.y - boss.y) < boss.r) { hitBoss(b); return false; }
    return true;
  });

  // fleet
  if (fleet.length) {
    let minX = 1e9, maxX = -1e9, maxY = 0;
    for (const d of fleet) { minX = Math.min(minX, d.x - d.r); maxX = Math.max(maxX, d.x + d.r); maxY = Math.max(maxY, d.y + d.r); }
    const sp = fleetSpeed * (1 + (1 - fleet.length / fleetStart) * 1.3) * (G.clearing ? 0 : 1);
    if ((fleetDir > 0 && maxX > W - 10) || (fleetDir < 0 && minX < 10)) { fleetDir *= -1; for (const d of fleet) d.ty += 16; }
    for (const d of fleet) { d.x += fleetDir * sp * dt; d.bob += dt * 4; d.y = lerp(d.y, d.ty, Math.min(1, dt * 5)); }
    if (maxY > P.y - fh * .6) {
      hurt('The donut fleet landed on your head.'); for (const d of fleet) d.ty -= 180;
    }
    dropT -= dt;
    if (dropT <= 0) { const d = pick(fleet); fleet.splice(fleet.indexOf(d), 1);
      falling.push({ kind: d.gold ? 'gold' : 'donut', x: d.x, y: d.y, vx: 0, vy: 10, rot: 0, vr: rand(-3, 3), r: d.r, spr: d.spr });
      dropT = Math.max(.5, 1.9 - G.wave * .13) * rand(.6, 1.4); }
    if (G.wave >= 2) { brocT -= dt;
      if (brocT <= 0) { const d = pick(fleet); let low = d; for (const e of fleet) if (Math.abs(e.x - d.x) < 6 && e.y > low.y) low = e;
        falling.push({ kind: 'broc', x: low.x, y: low.y + 16, vx: 0, vy: 140 + G.wave * 8, rot: 0, vr: rand(-4, 4), r: 15 });
        brocT = Math.max(1, 4.2 - G.wave * .3) * rand(.6, 1.4); } }
  }

  // donut delivery box
  boxT -= dt;
  if (!box && boxT <= 0 && !boss && !G.clearing) { const dir = Math.random() < .5 ? 1 : -1;
    box = { x: dir > 0 ? -50 : W + 50, y: 96, dir, hp: 3, t: 0, hit: 0 }; boxT = rand(13, 20); sfx.pop(); }
  if (box) { box.t += dt; box.x += box.dir * 105 * dt; box.y = 96 + Math.sin(box.t * 3) * 6; box.hit = Math.max(0, box.hit - dt);
    if (box.x < -70 || box.x > W + 70) box = null; }

  // boss
  if (boss) updateBoss(dt);

  // falling things
  const grav = 520, cap = 290 + G.wave * 14;
  for (const f of falling) {
    if (f.dead) continue;
    if (f.kind === 'broc') { f.vy = Math.min(f.vy + 240 * dt, 400); }
    else if (f.kind === 'power') { f.vy = Math.min(f.vy + 300 * dt, 170); }
    else { f.vy = Math.min(f.vy + grav * dt, cap);
      if (G.pw.magnet > 0 && f.y > 160) { const dx = P.x - f.x; f.vx += clamp(dx * 9, -900, 900) * dt; f.vx *= Math.pow(.2, dt); } }
    f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt;
    if ((f.x < f.r && f.vx < 0) || (f.x > W - f.r && f.vx > 0)) f.vx *= -.8;
    const catchW = fw * .42 + f.r * .45;
    if (Math.abs(f.x - P.x) < catchW && f.y > P.y - fh * .4 && f.y < P.y + fh * .48) {
      f.dead = true;
      if (eatable(f)) eat(f);
      else if (f.kind === 'power') givePower(f.p);
      else { burst(f.x, f.y, 16, { cols: ['#2f8a2f', '#5fd35f'], speed: 220 }); hurt('You ate broccoli. Unforgivable.'); }
      continue;
    }
    if (f.y > FLOOR - 6) {
      f.dead = true;
      if (eatable(f)) waste(f);
      else if (f.kind === 'broc') burst(f.x, FLOOR - 4, 8, { cols: ['#2f8a2f', '#5fd35f'], speed: 120, up: true });
    }
  }
  falling = falling.filter(f => !f.dead);

  if (G.clearing > 0) { G.clearing -= rdt; if (G.clearing <= 0) startWave(); }
  else checkClear();
}
function openBox() {
  sfx.boom(); shake(.3); flash('#ff5fa8', .3); ring(box.x, box.y, '#ff5fa8', 120, .5);
  burst(box.x, box.y, 30, { cols: ['#ff5fa8', '#fff', '#ffc94a'], speed: 300 });
  for (let i = 0; i < 6; i++) falling.push({ kind: 'donut', x: box.x + rand(-20, 20), y: box.y, vx: rand(-140, 140), vy: rand(-320, -140), rot: 0, vr: rand(-8, 8), r: 20, spr: pick(pick(SPR.donut)) });
  if (Math.random() < .5) falling.push({ kind: 'gold', x: box.x, y: box.y, vx: rand(-60, 60), vy: -360, rot: 0, vr: 5, r: 22, spr: SPR.gold });
  dropPower(box.x, box.y);
  G.score += 300; addText('DELIVERY! +300', box.x, box.y + 30, 18, '#ff5fa8', 1.2); box = null;
}
function updateBoss(dt) {
  const b = boss; b.t += dt; b.hit = Math.max(0, b.hit - dt);
  const tx = W / 2 + Math.sin(b.t * .7) * (W / 2 - b.r - 6), ty = 200 + Math.sin(b.t * 1.4) * 34;
  if (b.enter) { b.y = lerp(b.y, ty, Math.min(1, dt * 1.6)); if (Math.abs(b.y - ty) < 4) b.enter = false; return; }
  b.x = lerp(b.x, tx, Math.min(1, dt * 3)); b.y = lerp(b.y, ty, Math.min(1, dt * 3));
  const rage = 1 - b.hp / b.max;
  b.attackT -= dt;
  if (b.attackT <= 0) { const n = rage > .5 ? 5 : 3;
    for (let k = 0; k < n; k++) { const a = (k - (n - 1) / 2) * .32;
      falling.push({ kind: 'broc', x: b.x + Math.sin(a) * b.r * .6, y: b.y + b.r * .55, vx: Math.sin(a) * 190, vy: 90, rot: 0, vr: rand(-5, 5), r: 15 }); }
    b.attackT = lerp(2.6, 1.5, rage); sfx.zap(); }
  b.rainT -= dt;
  if (b.rainT <= 0) { falling.push({ kind: 'donut', x: b.x + rand(-40, 40), y: b.y + 30, vx: rand(-80, 80), vy: -160, rot: 0, vr: rand(-6, 6), r: 20, spr: pick(pick(SPR.donut)) });
    b.rainT = rand(.8, 1.4); }
}
function hitBoss(bm) {
  const b = boss; b.hp--; b.hit = .1; sfx.bossHit(); G.score += 50;
  burst(bm.x, bm.y, 6, { type: 'crumb', cols: ['#dc9a45', '#f8d596', '#ff5fa8'], speed: 180 });
  if (b.hp % 2 === 0) { // take a bite out of it
    const g = b.spr.c.getContext('2d'), c = b.spr.half * SS, a = Math.atan2(bm.y - b.y, bm.x - b.x) + rand(-.4, .4);
    const br = b.r * rand(.16, .22) * SS, bx = c + Math.cos(a) * b.r * SS * .95, by = c + Math.sin(a) * b.r * SS * .95;
    g.save(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(bx, by, br, 0, TAU); g.fill();
    for (let k = -1; k <= 1; k++) { const aa = a + Math.PI / 2 * k * .7 + Math.PI; g.beginPath(); g.arc(bx + Math.cos(aa) * br * .9, by + Math.sin(aa) * br * .9, br * .32, 0, TAU); g.fill(); }
    g.restore();
  }
  if (b.hp <= 0) {
    sfx.boom(); setTimeout(() => sfx.clear(), 300); setTimeout(() => sfx.burp(), 1000);
    shake(.8); flash('#fff', .8); G.timeScale = .25; G.hitstop = .12;
    ring(b.x, b.y, '#ffc94a', 260, .8); ring(b.x, b.y, '#ff5fa8', 200, .6);
    burst(b.x, b.y, 80, { type: 'crumb', cols: ['#dc9a45', '#f8d596', '#9c5a1c', '#ff5fa8'], speed: 420, size: 1.4 });
    burst(b.x, b.y, 60, { speed: 380 });
    for (let i = 0; i < 14; i++) falling.push({ kind: 'donut', x: b.x + rand(-50, 50), y: b.y, vx: rand(-200, 200), vy: rand(-460, -200), rot: 0, vr: rand(-8, 8), r: 20, spr: pick(pick(SPR.donut)) });
    falling.push({ kind: 'gold', x: b.x, y: b.y, vx: 0, vy: -500, rot: 0, vr: 6, r: 22, spr: SPR.gold });
    dropPower(b.x, b.y);
    G.score += 5000; addText('GOLIATH DEVOURED! +5000', W / 2, b.y, 22, '#ffc94a', 2);
    boss = null; musicSet(G.rush > 0 ? 'rush' : 'main');
  }
}

/* ================= DRAW ================= */
function outlineText(str, x, y, size, col, font = 'Bungee', align = 'center', stroke = '#0d0721') {
  ctx.font = `${size}px "${font}", "Arial Black", Impact, sans-serif`; ctx.textAlign = align; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, size * .2); ctx.strokeStyle = stroke; ctx.strokeText(str, x, y);
  ctx.fillStyle = col; ctx.fillText(str, x, y);
}
function drawBackground() {
  ctx.drawImage(skyC, 0, 0, W, H);
  for (const s of stars) { ctx.globalAlpha = .35 + .65 * (.5 + .5 * Math.sin(G.t * s.sp + s.ph)); ctx.fillStyle = '#fff4e3'; ctx.fillRect(s.x, s.y, s.s, s.s); }
  ctx.globalAlpha = 1;
  ctx.drawImage(cityC, 0, 0, W, H);
  // neon sign on the tall building
  const sx = W * .77, sy = HORIZON - 88;
  ctx.save(); ctx.font = '15px "Bungee", "Arial Black", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (G.sign) { ctx.shadowColor = '#ff5fa8'; ctx.shadowBlur = 14; ctx.fillStyle = '#ffd6ea'; }
  else ctx.fillStyle = '#5a2a4a';
  ctx.fillText('DONUTS', sx, sy); ctx.lineWidth = 3; ctx.strokeStyle = G.sign ? '#ffc94a' : '#5a4a2a'; if (G.sign) ctx.shadowColor = '#ffc94a';
  ctx.beginPath(); ctx.arc(sx, sy - 22, 9, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(sx, sy - 22, 3, 0, TAU); ctx.stroke();
  ctx.restore();
  // neon grid floor
  ctx.save(); ctx.beginPath(); ctx.rect(0, HORIZON, W, H - HORIZON); ctx.clip();
  const hue = G.rush > 0 ? (G.t * 240) % 360 : null;
  const lineCol = hue !== null ? `hsl(${hue},100%,65%)` : '#ff5fa8';
  ctx.strokeStyle = lineCol; ctx.lineWidth = 1.5;
  for (let i = 0; i < 16; i++) { const z = ((i + (G.gridT * 1.2) % 1) / 16); const y = HORIZON + (H - HORIZON) * z * z;
    ctx.globalAlpha = .12 + z * .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  for (let k = -12; k <= 12; k++) { ctx.globalAlpha = .35; ctx.beginPath(); ctx.moveTo(W / 2 + k * 10, HORIZON); ctx.lineTo(W / 2 + k * 95, H); ctx.stroke(); }
  ctx.globalAlpha = 1;
  const hg = ctx.createLinearGradient(0, HORIZON, 0, HORIZON + 40); hg.addColorStop(0, 'rgba(255,111,145,.55)'); hg.addColorStop(1, 'rgba(255,111,145,0)');
  ctx.fillStyle = hg; ctx.fillRect(0, HORIZON, W, 40);
  ctx.restore();
  if (G.rush > 0) {
    ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = .45 * Math.min(1, G.rush);
    const rg = ctx.createLinearGradient(0, 0, W, H); for (let i = 0; i <= 6; i++) rg.addColorStop(i / 6, `hsl(${(G.t * 200 + i * 60) % 360},100%,60%)`);
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); ctx.restore();
  }
  // floor lip + splats
  ctx.fillStyle = 'rgba(255,95,168,.8)'; ctx.fillRect(0, FLOOR, W, 2);
  for (const d of decals) { ctx.globalAlpha = Math.min(1, d.life); ctx.fillStyle = d.col;
    ctx.beginPath(); ctx.ellipse(d.x, FLOOR + 3, d.w, 6, 0, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(d.x - d.w * .7, FLOOR + 6, 4, 0, TAU); ctx.arc(d.x + d.w * .8, FLOOR + 5, 3, 0, TAU); ctx.fill(); }
  ctx.globalAlpha = 1;
}
function drawBox() {
  if (!box) return;
  ctx.save(); ctx.translate(box.x, box.y); if (box.hit) ctx.translate(rand(-3, 3), rand(-3, 3));
  // propeller
  ctx.fillStyle = '#ddd'; ctx.fillRect(-2, -30, 4, 10);
  ctx.save(); ctx.translate(0, -31); ctx.scale(Math.cos(G.t * 40), 1); ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(-26, -2, 52, 4); ctx.restore();
  // box
  const bg = ctx.createLinearGradient(0, -20, 0, 20); bg.addColorStop(0, '#ffb3d6'); bg.addColorStop(1, '#ff5fa8');
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-38, -20, 76, 40, 6) : ctx.rect(-38, -20, 76, 40); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,.35)'; for (let i = -30; i < 38; i += 14) ctx.fillRect(i, -20, 5, 40);
  ctx.fillStyle = '#c23a7c'; ctx.fillRect(-40, -22, 80, 7);
  ctx.font = '11px "Bungee", "Arial Black", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 3; ctx.strokeStyle = '#7a1d4e'; ctx.strokeText('DONUTS', 0, 4); ctx.fillStyle = '#fff'; ctx.fillText('DONUTS', 0, 4);
  if (box.hit) { ctx.globalAlpha = .6; ctx.fillStyle = '#fff'; ctx.fillRect(-38, -20, 76, 40); }
  ctx.restore();
}
function drawBoss() {
  if (!boss) return;
  const b = boss, wob = b.hit > 0 ? 1.06 : 1 + Math.sin(G.t * 6) * .015;
  ctx.save(); ctx.translate(b.x, b.y);
  ctx.shadowColor = 'rgba(255,59,92,.7)'; ctx.shadowBlur = 30;
  ctx.rotate(Math.sin(b.t * 2) * .08); ctx.scale(wob, 2 - wob);
  ctx.drawImage(b.spr.c, -b.spr.half, -b.spr.half, b.spr.half * 2, b.spr.half * 2);
  ctx.shadowBlur = 0;
  // angry face on the icing
  const r = b.r, dx = clamp((P.x - b.x) / 200, -1, 1) * r * .04, dy = r * .04;
  ctx.fillStyle = '#fff'; [-1, 1].forEach(s => { ctx.beginPath(); ctx.ellipse(s * r * .36, -r * .58, r * .14, r * .12, 0, 0, TAU); ctx.fill(); });
  ctx.fillStyle = '#1a0a30'; [-1, 1].forEach(s => { ctx.beginPath(); ctx.arc(s * r * .36 + dx, -r * .58 + dy, r * .06, 0, TAU); ctx.fill(); });
  ctx.strokeStyle = '#1a0a30'; ctx.lineWidth = r * .07; ctx.lineCap = 'round';
  [-1, 1].forEach(s => { ctx.beginPath(); ctx.moveTo(s * r * .55, -r * .8); ctx.lineTo(s * r * .2, -r * .68); ctx.stroke(); });
  ctx.fillStyle = '#3a0d12'; ctx.beginPath(); ctx.ellipse(0, r * .62, r * .24, r * .1 + (b.attackT < .4 ? r * .08 : 0), 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#fff'; for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * r * .08 - r * .03, r * .54); ctx.lineTo(i * r * .08 + r * .03, r * .54); ctx.lineTo(i * r * .08, r * .6); ctx.fill(); }
  ctx.restore();
}
function drawPlayer() {
  const s = P.scale, fw = 100 * s, fh = 112 * s;
  if (G.inv > 0 && Math.floor(G.inv * 14) % 2 === 0) ctx.globalAlpha = .35;
  // floor shadow
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(P.x, FLOOR + 4, fw * .7, 7, 0, 0, TAU); ctx.fill();
  const bob = Math.sin(G.t * 3) * 2;
  ctx.save(); ctx.translate(P.x, P.y + bob);
  // torso: blue tee with lanyard
  ctx.save(); ctx.rotate(P.lean * .4);
  const by = FLOOR - P.y - bob + 2, ty = fh * .36;
  const tg = ctx.createLinearGradient(0, ty, 0, by); tg.addColorStop(0, '#4565f5'); tg.addColorStop(1, '#2232a8');
  ctx.fillStyle = tg; ctx.beginPath();
  ctx.moveTo(-fw * .7, by); ctx.lineTo(-fw * .66, ty + 22 * s); ctx.quadraticCurveTo(-fw * .6, ty, -fw * .2, ty);
  ctx.lineTo(fw * .2, ty); ctx.quadraticCurveTo(fw * .6, ty, fw * .66, ty + 22 * s); ctx.lineTo(fw * .7, by); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#1a2690'; ctx.lineWidth = 4 * s; ctx.beginPath(); ctx.arc(0, ty - 4 * s, fw * .2, .25, Math.PI - .25); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.5; ctx.strokeRect(-fw * .28, ty + 26 * s, fw * .5, Math.max(4, by - ty - 30 * s));
  ctx.strokeStyle = '#111'; ctx.lineWidth = 5 * s; ctx.beginPath(); ctx.moveTo(-fw * .2, ty + 2); ctx.lineTo(fw * .05, by); ctx.moveTo(fw * .2, ty + 2); ctx.lineTo(fw * .12, by); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(fw * .2, ty + 2); ctx.lineTo(fw * .12, by); ctx.stroke(); ctx.setLineDash([]);
  ctx.restore();
  // head
  ctx.rotate(P.lean + (P.sad > 0 ? Math.sin(G.t * 40) * .05 : 0));
  const sq = Math.sin(P.chomp * Math.PI);
  ctx.scale(1 + sq * .08, 1 - sq * .05);
  if (G.rush > 0 || G.pw.mega > 0) { ctx.shadowColor = G.rush > 0 ? `hsl(${(G.t * 300) % 360},100%,60%)` : '#38b6ff'; ctx.shadowBlur = 24; }
  if (face.complete && face.naturalWidth) {
    const split = .8, iw = face.naturalWidth, ih = face.naturalHeight, open = sq * 26 * s, my = -fh / 2 + fh * split;
    if (open > .5) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#3a0d12'; ctx.beginPath(); ctx.ellipse(0, my + open / 2, fw * .22, open / 2 + 4, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ff7a8f'; ctx.beginPath(); ctx.ellipse(0, my + open * .85, fw * .13, open * .28 + 1, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(-fw * .15, my - 1, fw * .3, Math.min(5 * s, open * .3));
    }
    ctx.drawImage(face, 0, ih * split, iw, ih * (1 - split), -fw / 2, my + open, fw, fh * (1 - split));
    ctx.drawImage(face, 0, 0, iw, ih * split, -fw / 2, -fh / 2, fw, fh * split);
  } else { ctx.fillStyle = '#e0a88a'; ctx.beginPath(); ctx.ellipse(0, 0, fw / 2, fh / 2, 0, 0, TAU); ctx.fill(); }
  ctx.shadowBlur = 0;
  // sugar rush shades
  if (P.glasses > .02) {
    const gy = -fh / 2 + fh * .49 - (1 - P.glasses) * fh * 1.2, lw = fw * .3, lh = fh * .13;
    ctx.globalAlpha *= Math.min(1, P.glasses * 2);
    ctx.fillStyle = '#0a0a12';
    [-1, 1].forEach(sd => { const cx = sd < 0 ? -fw / 2 + fw * .3 : -fw / 2 + fw * .68;
      ctx.beginPath(); ctx.moveTo(cx - lw / 2, gy - lh / 2); ctx.lineTo(cx + lw / 2, gy - lh / 2); ctx.lineTo(cx + lw * .4, gy + lh / 2); ctx.lineTo(cx - lw * .4, gy + lh / 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.fillRect(cx - lw * .3, gy - lh * .3, lw * .18, lh * .22); ctx.fillStyle = '#0a0a12'; });
    ctx.fillRect(-fw * .2, gy - lh / 2, fw * .44, lh * .25);
    ctx.globalAlpha = 1;
  }
  if (P.sad > 0) { ctx.globalCompositeOperation = 'source-atop'; }
  ctx.restore();
  if (P.sad > 0 && G.state === 'play') {
    ctx.save(); ctx.globalAlpha = Math.min(.45, P.sad * .4); ctx.fillStyle = '#ff3b5c';
    ctx.beginPath(); ctx.ellipse(P.x, P.y + bob, fw / 2, fh / 2, P.lean, 0, TAU); ctx.fill(); ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function drawParticles() {
  for (const p of parts) {
    ctx.globalAlpha = clamp(p.life * 2, 0, 1); ctx.fillStyle = p.col;
    if (p.type === 'sprinkle') { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.s, -p.s * .35, p.s * 2, p.s * .7); ctx.restore(); }
    else if (p.type === 'bubble') { ctx.strokeStyle = p.col; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * 1.6, 0, TAU); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(p.x, p.y, p.s * .8, 0, TAU); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  for (const r of rings) { ctx.globalAlpha = r.life / r.l0; ctx.strokeStyle = r.col; ctx.lineWidth = 4 * r.life / r.l0 + 1;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function drawHUD() {
  outlineText(G.score.toLocaleString(), 16, 30, 26, '#fff4e3', 'Bungee', 'left');
  const mult = Math.min(8, 1 + Math.floor(G.combo / 5)) * (G.rush > 0 ? 2 : 1);
  if (G.combo > 1) outlineText(`${G.combo} COMBO  x${mult}`, 16, 56, 13, G.rush > 0 ? '#ffc94a' : '#ff5fa8', 'Bungee', 'left');
  outlineText(boss ? 'BOSS' : 'WAVE ' + G.wave, W / 2, 26, 14, '#5ff5d0', 'Silkscreen');
  // hearts
  for (let i = 0; i < 5; i++) { const x = W - 24 - i * 22, y = 66; ctx.save(); ctx.translate(x, y); ctx.scale(.9, .9);
    ctx.fillStyle = i < G.hearts ? '#ff3b5c' : 'rgba(255,244,227,.15)'; ctx.beginPath(); ctx.moveTo(0, 7);
    ctx.bezierCurveTo(-12, -2, -6, -11, 0, -4); ctx.bezierCurveTo(6, -11, 12, -2, 0, 7); ctx.fill(); ctx.restore(); }
  // waste strikes
  ctx.font = '10px "Silkscreen", monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(255,244,227,.6)';
  ctx.fillText('WASTE', W - 82, 88);
  for (let i = 0; i < 3; i++) { const x = W - 68 + i * 18, y = 88; ctx.strokeStyle = i < G.strikes ? '#ff3b5c' : 'rgba(255,244,227,.25)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5); ctx.stroke(); }
  // sugar rush meter
  const mx = 16, my = 78, mw = 170, mh = 10;
  ctx.fillStyle = 'rgba(255,244,227,.12)'; ctx.fillRect(mx, my, mw, mh);
  const sg = ctx.createLinearGradient(mx, 0, mx + mw, 0);
  if (G.rush > 0) for (let i = 0; i <= 5; i++) sg.addColorStop(i / 5, `hsl(${(G.t * 300 + i * 70) % 360},100%,60%)`);
  else { sg.addColorStop(0, '#ff5fa8'); sg.addColorStop(1, '#ffc94a'); }
  ctx.fillStyle = sg; ctx.fillRect(mx, my, mw * G.sugar / 100, mh);
  ctx.strokeStyle = 'rgba(255,244,227,.5)'; ctx.lineWidth = 1; ctx.strokeRect(mx + .5, my + .5, mw - 1, mh - 1);
  ctx.font = '9px "Silkscreen", monospace'; ctx.textAlign = 'left'; ctx.fillStyle = G.rush > 0 ? '#ffc94a' : 'rgba(255,244,227,.7)';
  ctx.fillText(G.rush > 0 ? 'SUGAR RUSH!' : 'SUGAR', mx, my + 20);
  // active power-ups
  let px = 16; for (const k in G.pw) if (G.pw[k] > 0) { const p = POWERS[k];
    blit(ctx, SPR.power[k], px + 12, 120, 0, .5);
    ctx.fillStyle = 'rgba(255,244,227,.2)'; ctx.fillRect(px + 28, 116, 34, 6); ctx.fillStyle = p.col; ctx.fillRect(px + 28, 116, 34 * G.pw[k] / p.dur, 6); px += 70; }
  // boss bar
  if (boss) { const bw = W - 120, bx = 60, byy = 108;
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(bx, byy, bw, 9); ctx.fillStyle = '#ff3b5c'; ctx.fillRect(bx, byy, bw * Math.max(0, boss.hp) / boss.max, 9);
    ctx.strokeStyle = '#fff4e3'; ctx.strokeRect(bx + .5, byy + .5, bw - 1, 8);
    outlineText('THE GLAZED GOLIATH', W / 2, byy - 8, 11, '#fff4e3', 'Bungee'); }
}
function draw() {
  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
  ctx.save();
  if (G.shake > 0) ctx.translate(rand(-1, 1) * 14 * G.shake, rand(-1, 1) * 14 * G.shake);
  drawBackground();
  if (G.state === 'menu') { for (const a of attract) blit(ctx, a.spr, a.x, a.y, a.rot); }
  for (const d of fleet) { if (d.gold) { ctx.save(); ctx.shadowColor = '#ffc94a'; ctx.shadowBlur = 18; blit(ctx, d.spr, d.x, d.y + Math.sin(d.bob) * 2, Math.sin(d.bob) * .2); ctx.restore(); }
    else blit(ctx, d.spr, d.x, d.y + Math.sin(d.bob) * 2, Math.sin(d.bob) * .15); }
  drawBoss(); drawBox();
  for (const f of falling) {
    if (f.kind === 'broc') blit(ctx, SPR.broc, f.x, f.y, f.rot * .3);
    else if (f.kind === 'power') blit(ctx, SPR.power[f.p], f.x, f.y, 0, 1 + Math.sin(G.t * 8) * .08);
    else { if (f.kind === 'gold') { ctx.save(); ctx.shadowColor = '#ffc94a'; ctx.shadowBlur = 20; blit(ctx, f.spr, f.x, f.y, f.rot); ctx.restore(); } else blit(ctx, f.spr, f.x, f.y, f.rot);
      if (G.pw.magnet > 0 && f.y > 160) { ctx.strokeStyle = 'rgba(255,59,92,.35)'; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(P.x, P.y); ctx.stroke(); ctx.setLineDash([]); } }
  }
  // slurp beams
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const b of beams) { const rainbow = G.pw.triple > 0 || G.rush > 0, col = rainbow ? `hsl(${(b.hue + G.t * 600) % 360},100%,65%)` : '#ff5fa8';
    const ang = Math.atan2(b.vy, b.vx); ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(ang + Math.PI / 2);
    ctx.fillStyle = col; ctx.globalAlpha = .3; ctx.beginPath(); ctx.ellipse(0, 14, 10, 28, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = .85; ctx.beginPath(); ctx.ellipse(0, 8, 5, 16, 0, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(0, 4, 2.5, 10, 0, 0, TAU); ctx.fill(); ctx.restore(); }
  ctx.restore();
  if (G.state !== 'menu') drawPlayer();
  drawParticles();
  for (const t of texts) { const k = t.life / t.max, pop = 1 + Math.max(0, (k - .85)) * 3;
    ctx.globalAlpha = Math.min(1, k * 2.5); outlineText(t.text, t.x, t.y, t.size * pop, t.col); }
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.drawImage(vigC, 0, 0, W, H);
  if (G.state !== 'menu') drawHUD();
  if (banner) { const k = banner.life / banner.max, inn = Math.min(1, (1 - k) * 6), out = Math.min(1, banner.life * 2.5);
    ctx.globalAlpha = out; const sc = .6 + .4 * (1 - Math.pow(1 - inn, 3));
    ctx.save(); ctx.translate(W / 2, H * .42); ctx.scale(sc, sc);
    outlineText(banner.title, 0, 0, 46, banner.col); outlineText(banner.sub, 0, 40, 16, '#fff4e3', 'Bungee');
    ctx.restore(); ctx.globalAlpha = 1; }
  if (G.flash > 0) { ctx.globalAlpha = G.flash; ctx.fillStyle = G.flashCol; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
}

let last = performance.now();
function loop(now) {
  const rdt = Math.min(.05, (now - last) / 1000); last = now;
  if (G.state !== 'paused') update(rdt);
  draw(); requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeButtons());
})();
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
