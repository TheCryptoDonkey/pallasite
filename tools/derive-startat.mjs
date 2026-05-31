// One-off: derive a gameplay startAt for each RELAY VAULT track by finding the
// most energetic ~55s window (the "good minute" a player hears per level).
// Heuristic: per-second RMS → rolling 55s mean power → argmax window start.
// Only proposes a non-zero start when that window is meaningfully louder than
// the opening minute, so already-hot tracks stay at 0. Tweak by ear after.
import { execSync } from 'node:child_process';

const IDS = [
  'relaykeep-title', 'the-drift', 'eternal-vigilance', 'space-invaders-march',
  'alien-swarm-rising', 'defenders-resolve', 'blasterz', 'planetary-defense',
  'smart-bombz', 'the-survivor', 'rescue-run', 'wave-after-wave', 'mutant-invasion',
  'the-swarm', 'cosmic-high-score', 'laser-barrage', 'missile-command', 'the-fury',
  'the-tempest', 'the-siege', 'the-descent', '600b-hole', 'phoenix-reborn',
  'hyperspace-chase',
];
const WIN = 55;       // heard-window seconds
const MIN_GAIN = 1.5; // dB the best window must beat the opening by
const MIN_START = 12; // don't bother seeking less than this

const out = {};
for (const id of IDS) {
  const file = `public/music/${id}.opus`;
  let dur = 0;
  try { dur = parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`).toString().trim()); } catch {}
  let raw = '';
  try {
    raw = execSync(
      `ffmpeg -hide_banner -nostats -i "${file}" -af "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level" -f null - 2>&1`,
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString();
  } catch (e) { raw = (e.stdout || '').toString() + (e.stderr || '').toString(); }

  // Parse interleaved "pts_time:N" then "RMS_level=-X" lines → per-second dB.
  const db = [];
  let t = null;
  for (const line of raw.split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) { t = Math.round(parseFloat(mt[1])); continue; }
    const mr = line.match(/RMS_level=(-?[\d.]+)/);
    if (mr && t !== null) { db[t] = parseFloat(mr[1]); t = null; }
  }
  const n = db.length;
  if (n < WIN + 5) { out[id] = 0; console.log(`${id.padEnd(22)} dur=${dur.toFixed(0)}s  short → 0`); continue; }
  // linear power prefix sums (treat missing/-inf as very quiet)
  const pw = db.map((d) => Math.pow(10, ((Number.isFinite(d) ? d : -90)) / 10));
  const pre = [0];
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + pw[i];
  const winAvgDb = (s) => 10 * Math.log10((pre[s + WIN] - pre[s]) / WIN);
  const opening = winAvgDb(0);
  let best = 0, bestDb = -Infinity;
  const maxStart = Math.min(n - WIN, Math.floor(dur * 0.55), Math.floor(dur - WIN));
  for (let s = 0; s <= maxStart; s++) {
    const v = winAvgDb(s);
    if (v > bestDb) { bestDb = v; best = s; }
  }
  let startAt = 0;
  if (best >= MIN_START && bestDb - opening >= MIN_GAIN) startAt = best;
  out[id] = startAt;
  console.log(`${id.padEnd(22)} dur=${dur.toFixed(0)}s  open=${opening.toFixed(1)}dB  best@${best}s=${bestDb.toFixed(1)}dB  Δ=${(bestDb - opening).toFixed(1)}  → startAt=${startAt}`);
}
console.log('\nJSON:\n' + JSON.stringify(out));
