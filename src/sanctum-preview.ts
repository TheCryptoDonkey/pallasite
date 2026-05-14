/**
 * 600bn Sanctum — standalone game surface at /sanctum (and the
 * legacy /sanctum-preview alias for first-pass viewers).
 *
 * Self-contained loop: own canvas, own simulation, own audio, own
 * game-over screen. Lives separately from the main game's
 * updateGame / render pipeline because the conference surface needs
 * a hard-isolated runtime — no chance of bleeding back into the
 * standard Pallasite campaign.
 *
 * What it does:
 *   - Mounts a centred 960x720 canvas with ember-glow border
 *   - Loads the council manifest + 11 member avatars
 *   - Plays the-cult.opus on first click (audio-context unlock)
 *   - Drives the 240s tickSanctum simulation + render
 *   - Click-to-hit collision for the four entity classes
 *   - On time-up OR Bullbear-defeat: full-screen FUCHS2 game-over
 *     overlay with sacred number, party banner, QR to 600.wtf, and
 *     a PLAY AGAIN button that resets the run
 *
 * No claim flow yet — sat-credit hand-off is a follow-up. For now the
 * teaser is "play the level, look at the party card, click through".
 */

import {
  createSanctumState,
  tickSanctum,
  renderSanctum,
  SANCTUM_WORLD_W,
  SANCTUM_WORLD_H,
  SANCTUM_TOTAL_MS,
  applyMemberHit,
  applyStoneHit,
  applyRacooHit,
  applyBullbearHit,
  applyMeteorHit,
  isSanctumComplete,
  type SanctumState,
} from './sanctum.js';
import { loadCouncil } from './sanctum-avatars.js';
import * as audio from './audio.js';
import { crossfadeTo, musicStop } from './music.js';
import QRCode from 'qrcode';

function hideMainChrome(): void {
  const canvas = document.getElementById('game');
  const ui = document.getElementById('ui-root');
  const touch = document.getElementById('touch-controls');
  if (canvas) (canvas as HTMLElement).style.display = 'none';
  if (ui) (ui as HTMLElement).style.display = 'none';
  if (touch) (touch as HTMLElement).style.display = 'none';
  document.body.style.background = 'radial-gradient(ellipse at center, #2a1408 0%, #060201 70%)';
}

function applySanctumBackgroundIfPresent(): void {
  const img = new Image();
  img.onload = () => {
    document.body.style.backgroundImage = "url('/backgrounds/sanctum.webp')";
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
  };
  img.onerror = () => { /* silent — gradient fallback stays */ };
  img.src = '/backgrounds/sanctum.webp';
}

function mountPreview(): { canvas: HTMLCanvasElement; wrap: HTMLDivElement } {
  // Tear down any prior mount so a PLAY AGAIN re-entry starts clean.
  const existing = document.getElementById('sanctum-preview-root');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'sanctum-preview-root';
  wrap.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:12px', 'padding:20px',
  ].join(';');
  document.body.appendChild(wrap);

  const canvas = document.createElement('canvas');
  canvas.width = SANCTUM_WORLD_W;
  canvas.height = SANCTUM_WORLD_H;
  canvas.style.cssText = [
    'max-width:100%', 'max-height:80vh',
    'aspect-ratio:' + SANCTUM_WORLD_W + '/' + SANCTUM_WORLD_H,
    'border:1px solid rgba(255,138,58,0.35)',
    'border-radius:6px',
    'box-shadow:0 0 60px rgba(255,138,58,0.25)',
    'background:#060201',
    'cursor:crosshair',
  ].join(';');
  wrap.appendChild(canvas);

  const caption = document.createElement('div');
  caption.style.cssText = 'font:13px ui-monospace,monospace;color:rgba(255,216,74,0.85);letter-spacing:0.18em;text-align:center;';
  caption.innerHTML = 'THE SANCTUM · 240 SECONDS · COUNCIL · STONE · RACOO · BULLBEAR<br><span style="font-size:11px;color:rgba(255,245,216,0.55);letter-spacing:0.08em;">click any entity to land a hit · refresh to reset</span>';
  wrap.appendChild(caption);

  return { canvas, wrap };
}

/** Click-to-hit. First click also unlocks audio + starts the music. */
function bindClickHit(
  canvas: HTMLCanvasElement,
  state: SanctumState,
  onFirstClick: () => void,
): void {
  let firstClick = true;
  canvas.addEventListener('click', (e) => {
    if (firstClick) {
      firstClick = false;
      onFirstClick();
    }
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) / rect.width;
    const sy = (e.clientY - rect.top) / rect.height;
    const x = sx * SANCTUM_WORLD_W;
    const y = sy * SANCTUM_WORLD_H;
    const hit = (cx: number, cy: number, r: number): boolean => {
      const dx = cx - x;
      const dy = cy - y;
      return dx * dx + dy * dy < r * r;
    };
    if (state.bullbear && hit(state.bullbear.x, state.bullbear.y, state.bullbear.r)) {
      const drop = applyBullbearHit(state.bullbear);
      if (drop > 0) {
        state.satsEarned += drop;
        state.score += 4200;
      }
      return;
    }
    if (state.racoo && hit(state.racoo.x, state.racoo.y, state.racoo.r)) {
      const drop = applyRacooHit(state.racoo);
      if (drop > 0) {
        state.satsEarned += drop;
        state.score += 600;
      }
      return;
    }
    for (const m of state.council) {
      if (m.dead) continue;
      if (hit(m.x, m.y, m.r)) {
        const drop = applyMemberHit(m);
        if (drop > 0) {
          state.satsEarned += drop;
          state.score += 100;
        }
        return;
      }
    }
    if (state.stone && !state.stone.shattering && hit(state.stone.x, state.stone.y, state.stone.r)) {
      const drop = applyStoneHit(state);
      if (drop > 0) {
        state.satsEarned += drop;
        state.score += 2100;
      }
      return;
    }
    for (const meteor of state.meteors) {
      if (hit(meteor.x, meteor.y, meteor.r)) {
        applyMeteorHit(meteor);
        state.score += 25;
        return;
      }
    }
  });
}

/** Full-screen game-over overlay with FUCHS2 party card + PLAY AGAIN. */
function renderGameOverOverlay(state: SanctumState, onReplay: () => void): void {
  const overlay = document.createElement('div');
  overlay.id = 'sanctum-gameover';
  overlay.style.cssText = [
    'position:fixed', 'inset:0',
    'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center',
    'gap:16px', 'padding:20px',
    'background:rgba(6,2,1,0.92)',
    'backdrop-filter:blur(8px)',
    'z-index:1000',
    'animation:fade-in 600ms ease',
  ].join(';');
  document.body.appendChild(overlay);

  const header = document.createElement('h1');
  header.textContent = state.bullbearDefeated ? 'BULLBEAR DOWN' : 'TIME UP';
  header.style.cssText = 'font:bold 38px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.22em;margin:0;text-shadow:0 0 16px rgba(255,138,58,0.7);';
  overlay.appendChild(header);

  const stats = document.createElement('div');
  stats.style.cssText = 'display:flex;gap:32px;font:bold 16px ui-monospace,monospace;letter-spacing:0.18em;';
  stats.innerHTML = `
    <span style="color:#3afc7c;">${state.satsEarned} SATS</span>
    <span style="color:rgba(255,245,216,0.85);">${state.score.toLocaleString()} PTS</span>
  `;
  overlay.appendChild(stats);

  // FUCHS2 card.
  const card = document.createElement('div');
  card.style.cssText = [
    'display:flex', 'flex-direction:column', 'align-items:center',
    'gap:8px', 'padding:20px 28px', 'margin:12px 0',
    'background:linear-gradient(180deg, rgba(255,138,58,0.12), rgba(40,16,8,0.85))',
    'border:1px solid rgba(255,216,74,0.5)', 'border-radius:8px',
    'max-width:440px', 'width:90%',
    'box-shadow:0 0 30px rgba(255,138,58,0.25)',
  ].join(';');
  overlay.appendChild(card);

  const number = document.createElement('div');
  number.style.cssText = 'font:bold 22px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.16em;line-height:1.1;text-align:center;text-shadow:0 0 12px rgba(255,138,58,0.5);';
  number.innerHTML = '600<br>000<br>000<br>000';
  card.appendChild(number);

  const banner = document.createElement('div');
  banner.textContent = 'PRAGUE PARTY · 11 JUNE 2026';
  banner.style.cssText = 'font:bold 14px ui-monospace,monospace;color:#fff5d8;letter-spacing:0.22em;margin-top:6px;';
  card.appendChild(banner);

  const venue = document.createElement('div');
  venue.textContent = 'FUCHS2 · OSTROV ŠTVANICE';
  venue.style.cssText = 'font:12px ui-monospace,monospace;color:rgba(255,245,216,0.75);letter-spacing:0.16em;';
  card.appendChild(venue);

  const link = document.createElement('a');
  link.href = 'https://600.wtf';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:8px;text-decoration:none;';
  card.appendChild(link);

  const qrCanvas = document.createElement('canvas');
  qrCanvas.style.cssText = 'background:#fff5d8;padding:6px;border-radius:4px;';
  link.appendChild(qrCanvas);
  void QRCode.toCanvas(qrCanvas, 'https://600.wtf', {
    width: 160,
    margin: 0,
    color: { dark: '#0a0418', light: '#fff5d8' },
  }).catch(() => undefined);

  const url = document.createElement('div');
  url.textContent = '600.wtf · TAP';
  url.style.cssText = 'font:bold 13px ui-monospace,monospace;color:#ffd84a;letter-spacing:0.2em;margin-top:4px;';
  link.appendChild(url);

  // Buttons row.
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center;margin-top:8px;';
  overlay.appendChild(btnRow);

  const replayBtn = document.createElement('button');
  replayBtn.textContent = 'PLAY AGAIN ▶';
  replayBtn.style.cssText = [
    'padding:14px 28px',
    'font:bold 16px ui-monospace,monospace',
    'letter-spacing:0.24em',
    'background:rgba(255,216,74,0.18)',
    'border:2px solid #ffd84a',
    'color:#ffd84a',
    'border-radius:4px',
    'cursor:pointer',
    'text-shadow:0 0 8px rgba(255,216,74,0.5)',
  ].join(';');
  replayBtn.addEventListener('click', () => {
    overlay.remove();
    onReplay();
  });
  btnRow.appendChild(replayBtn);

  const backBtn = document.createElement('button');
  backBtn.textContent = 'BACK TO TITLE';
  backBtn.style.cssText = [
    'padding:14px 28px',
    'font:bold 14px ui-monospace,monospace',
    'letter-spacing:0.22em',
    'background:rgba(255,138,58,0.08)',
    'border:1px solid rgba(255,138,58,0.45)',
    'color:rgba(255,245,216,0.85)',
    'border-radius:4px',
    'cursor:pointer',
  ].join(';');
  backBtn.addEventListener('click', () => {
    musicStop(400);
    window.location.assign('/');
  });
  btnRow.appendChild(backBtn);
}

/** Run a single Sanctum session. Resolves when the run ends (timer or
 *  Bullbear-defeat). The caller's onReplay re-enters this. */
async function runSanctumSession(): Promise<void> {
  applySanctumBackgroundIfPresent();
  const { canvas } = mountPreview();
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  await loadCouncil();
  const state = createSanctumState();

  let musicStarted = false;
  const startMusic = (): void => {
    if (musicStarted) return;
    musicStarted = true;
    void audio.unlockAudio();
    crossfadeTo('the-cult', 1200);
  };

  bindClickHit(canvas, state, startMusic);

  let ended = false;
  let last = performance.now();
  const loop = (now: number): void => {
    if (ended) return;
    const dt = now - last;
    last = now;
    tickSanctum(state, dt);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    renderSanctum(ctx, state);

    if (isSanctumComplete(state)) {
      ended = true;
      // Fade music down slightly so the FUCHS2 card lands clean.
      audio.setMusicDuck(0.35);
      renderGameOverOverlay(state, () => {
        audio.setMusicDuck(1);
        void runSanctumSession();
      });
      return;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // Visible-time fallback: if the user idles + the timer expires
  // entirely without interaction, isSanctumComplete still fires via
  // the elapsed-since-startedAt comparison inside tickSanctum, so
  // the loop catches it. No extra setTimeout needed.
  void SANCTUM_TOTAL_MS;
}

export async function renderSanctumPreview(): Promise<void> {
  hideMainChrome();
  await runSanctumSession();
}
