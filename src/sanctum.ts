/**
 * 600bn Sanctum — entity types + render helpers for the single-level
 * teaser at 600b.pallasite.app.
 *
 * Two phases:
 *   1. COUNCIL — 11 member-avatar asteroids orbit the centre. Player
 *      chips them. Member kills drop 6/21/60 sat fragments.
 *   2. STONE — once all council are down, the Sacred Stone (small,
 *      round, dense — per 600bn world canon) wakes at the centre.
 *      Player chips it; final shatter releases a 600-sat burst.
 *
 * Lazy-imported when getFlavour() === '600bn' so the main game ships
 * zero 600bn bytes. Pure module: data types + simulation tick + render
 * helpers; the main game loop drives the per-frame integration.
 *
 * Palette canon (orange / gold / ember + black metal / volcanic, storm
 * light). Sacred number rendered as the 4-line block, never compressed:
 *   600
 *   000
 *   000
 *   000
 */

import { drawAvatarAsteroid, getCouncil, type ReadonlyMember } from './sanctum-avatars.js';

// ── Tuning ───────────────────────────────────────────────────────────

/** World dimensions the entities are sized against. Matches the main
 *  game's playfield so existing collision/wrap utilities work without
 *  conversion. */
export const SANCTUM_WORLD_W = 1280;
export const SANCTUM_WORLD_H = 720;

/** Council ring radius and member-asteroid size. Members orbit around
 *  the world centre at this radius; chosen so the ring fills the
 *  playfield without crowding the edges. */
export const SANCTUM_RING_RADIUS = 260;
export const SANCTUM_MEMBER_RADIUS = 42;

/** Council orbital speed (radians per second). Slow — gives players
 *  time to read each member's face and the role banner that flashes
 *  on hit. */
export const SANCTUM_ORBIT_RATE = 0.18;

/** Per-member HP. Three hits to break feels right — gives a punctuation
 *  to each kill without dragging out the council phase. */
export const SANCTUM_MEMBER_HP = 3;

/** Sacred Stone tuning. Small / round / dense — per canon, never a
 *  giant slab. Sized smaller than a member so the centrepiece feels
 *  precious rather than imposing. */
export const SANCTUM_STONE_RADIUS = 60;
export const SANCTUM_STONE_HP = 12;

/** Sat-fragment denominations dropped on member kill. Cycles through
 *  6 / 21 / 60 — the 600bn numerology. The 600 denomination is reserved
 *  for the Sacred Stone shatter. */
export const SANCTUM_MEMBER_DROPS = [6, 21, 60] as const;
export const SANCTUM_STONE_FINAL_DROP = 600;

// ── Entity types ─────────────────────────────────────────────────────

export interface SanctumCouncilAsteroid {
  /** World-space position (centred coordinates, same convention as
   *  the main game's WORLD_W/WORLD_H). */
  x: number;
  y: number;
  /** Pixel radius. */
  r: number;
  /** Sprite rotation in radians (for the avatar texture; the ring
   *  stays steady). */
  rot: number;
  rotVel: number;
  /** HP remaining; 0 = broken. */
  hp: number;
  hpMax: number;
  /** Orbit angle around the council ring centre, radians. Drives
   *  per-frame x/y reposition so the council circles the centre. */
  orbitAngle: number;
  /** Each member has a fixed slot in the ring so positions feel
   *  deliberate (CEO at top, etc.) rather than randomised. */
  ringSlot: number;
  /** Index into the council manifest. */
  member: ReadonlyMember;
  /** Hit-flash 0..1, decays after each landed hit so the avatar
   *  pulses on damage. */
  hitFlash: number;
  /** Banner ttl ms remaining — when > 0, draws the role+archetype
   *  text near the asteroid. Set on each hit. */
  bannerTtl: number;
  /** Set true once HP reaches 0. The level loop sweeps these out
   *  next tick so death FX have a frame to fire. */
  dead: boolean;
}

export interface SanctumSacredStone {
  x: number;
  y: number;
  r: number;
  rot: number;
  hp: number;
  hpMax: number;
  /** Stone is dormant during the council phase — no collision, no
   *  hit response. Wakes when the last council asteroid dies. */
  awake: boolean;
  /** Ember pulse 0..1, breathes regardless of HP. */
  pulse: number;
  /** Hit-flash 0..1, decays after each landed hit. */
  hitFlash: number;
}

/** State container the level loop owns. Stays separate from the main
 *  game state so the entire Sanctum module can be tree-shaken out of
 *  the main bundle. */
export interface SanctumState {
  council: SanctumCouncilAsteroid[];
  stone: SanctumSacredStone;
  /** Cumulative sats earned across the run — paid out at game-over
   *  via the standard claim picker. */
  satsEarned: number;
  /** Run start in performance.now() ms. */
  startedAt: number;
  /** Phase — drives render branching + finish detection. */
  phase: 'council' | 'stone' | 'complete';
}

// ── Spawn / state construction ───────────────────────────────────────

/**
 * Spawn the council in a ring around the world centre. Each member
 * gets a fixed slot so the visual order matches the canonical roster:
 * CEO at 12 o'clock, then CTO, CCS, CMOs etc. distributed clockwise.
 * Members without an avatar (none in the current manifest, but the
 * shape supports it) still spawn — the avatar loader's fallback glyph
 * handles render.
 */
export function spawnCouncil(now: number): SanctumCouncilAsteroid[] {
  const members = getCouncil();
  const out: SanctumCouncilAsteroid[] = [];
  const cx = SANCTUM_WORLD_W / 2;
  const cy = SANCTUM_WORLD_H / 2;
  const n = members.length;
  for (let i = 0; i < n; i++) {
    // Start at -π/2 (12 o'clock) and walk clockwise so the visual
    // order reads naturally.
    const orbitAngle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({
      x: cx + Math.cos(orbitAngle) * SANCTUM_RING_RADIUS,
      y: cy + Math.sin(orbitAngle) * SANCTUM_RING_RADIUS,
      r: SANCTUM_MEMBER_RADIUS,
      rot: (i * 137.5) * (Math.PI / 180),  // golden-angle visual variety
      rotVel: 0.0009 + (i % 3) * 0.0002,
      hp: SANCTUM_MEMBER_HP,
      hpMax: SANCTUM_MEMBER_HP,
      orbitAngle,
      ringSlot: i,
      member: members[i],
      hitFlash: 0,
      bannerTtl: 0,
      dead: false,
    });
  }
  // Stamp a startedAt so consumers can age the spawn if needed —
  // currently unused but cheap to attach.
  void now;
  return out;
}

/** Sacred Stone is created up-front but starts dormant — only wakes
 *  in tickSanctum once the council is cleared. */
export function spawnSacredStone(): SanctumSacredStone {
  return {
    x: SANCTUM_WORLD_W / 2,
    y: SANCTUM_WORLD_H / 2,
    r: SANCTUM_STONE_RADIUS,
    rot: 0,
    hp: SANCTUM_STONE_HP,
    hpMax: SANCTUM_STONE_HP,
    awake: false,
    pulse: 0,
    hitFlash: 0,
  };
}

/** Build a fresh Sanctum state with council spawned and stone dormant. */
export function createSanctumState(now: number = performance.now()): SanctumState {
  return {
    council: spawnCouncil(now),
    stone: spawnSacredStone(),
    satsEarned: 0,
    startedAt: now,
    phase: 'council',
  };
}

// ── Per-frame tick ───────────────────────────────────────────────────

/**
 * Advance the Sanctum state by `dtMs`. Pure simulation — no rendering,
 * no input handling, no collision against external entities (bullets
 * are checked via applyMemberHit / applyStoneHit). The level loop
 * calls this once per frame.
 */
export function tickSanctum(state: SanctumState, dtMs: number): void {
  const dt = dtMs / 1000;

  // Council orbit + sprite rotation.
  if (state.phase === 'council') {
    const cx = SANCTUM_WORLD_W / 2;
    const cy = SANCTUM_WORLD_H / 2;
    for (const m of state.council) {
      if (m.dead) continue;
      m.orbitAngle += SANCTUM_ORBIT_RATE * dt;
      m.x = cx + Math.cos(m.orbitAngle) * SANCTUM_RING_RADIUS;
      m.y = cy + Math.sin(m.orbitAngle) * SANCTUM_RING_RADIUS;
      m.rot += m.rotVel * dtMs;
      // Flash + banner decay.
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt * 4);
      if (m.bannerTtl > 0) m.bannerTtl = Math.max(0, m.bannerTtl - dtMs);
    }
    // Transition: all council dead → wake the stone.
    if (state.council.every((m) => m.dead)) {
      state.phase = 'stone';
      state.stone.awake = true;
    }
  } else if (state.phase === 'stone') {
    state.stone.pulse = (state.stone.pulse + dt * 1.4) % (Math.PI * 2);
    state.stone.rot += dtMs * 0.0003;
    if (state.stone.hitFlash > 0) state.stone.hitFlash = Math.max(0, state.stone.hitFlash - dt * 4);
    if (state.stone.hp <= 0) state.phase = 'complete';
  }
}

/**
 * Land a hit on a council member. Returns the sat drop if the hit
 * broke them, or 0 otherwise. The level loop is responsible for
 * spawning the fragment + audio + particle FX based on the return.
 */
export function applyMemberHit(member: SanctumCouncilAsteroid): number {
  if (member.dead) return 0;
  member.hp -= 1;
  member.hitFlash = 1;
  member.bannerTtl = 1500;
  if (member.hp <= 0) {
    member.dead = true;
    return SANCTUM_MEMBER_DROPS[member.ringSlot % SANCTUM_MEMBER_DROPS.length];
  }
  return 0;
}

/**
 * Land a hit on the Sacred Stone. Returns the sat drop on the final
 * shatter, or 0 otherwise. No-op while dormant.
 */
export function applyStoneHit(stone: SanctumSacredStone): number {
  if (!stone.awake || stone.hp <= 0) return 0;
  stone.hp -= 1;
  stone.hitFlash = 1;
  if (stone.hp <= 0) return SANCTUM_STONE_FINAL_DROP;
  return 0;
}

// ── Render helpers ───────────────────────────────────────────────────

/**
 * Draw a council member at its current pose. Wraps drawAvatarAsteroid
 * with the hit-flash overlay and the role+archetype banner that
 * appears for ~1.5s after each hit.
 */
export function drawCouncilAsteroid(
  ctx: CanvasRenderingContext2D,
  m: SanctumCouncilAsteroid,
): void {
  if (m.dead) return;
  drawAvatarAsteroid(ctx, m.member, m.x, m.y, m.r, m.rot);
  // Hit-flash — white overlay alpha-keyed to hitFlash.
  if (m.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = m.hitFlash * 0.6;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Banner — role + archetype on hit. Pinned just above the asteroid
  // so multiple flashing banners don't overlap horizontally.
  if (m.bannerTtl > 0) {
    const a = Math.min(1, m.bannerTtl / 600);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4;
    const labelY = m.y - m.r - 8;
    ctx.fillText(`${m.member.role} · ${m.member.archetype.toUpperCase()}`, m.x, labelY);
    ctx.fillStyle = 'rgba(255, 245, 216, 0.9)';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText(m.member.name.toUpperCase(), m.x, labelY - 14);
    ctx.restore();
  }
  // HP pips — small dots above ring, dim once broken.
  if (m.hpMax > 1) {
    ctx.save();
    const gap = 6;
    const totalW = (m.hpMax - 1) * gap;
    const pipY = m.y + m.r + 10;
    for (let i = 0; i < m.hpMax; i++) {
      ctx.fillStyle = i < m.hp ? 'rgba(255, 138, 58, 0.9)' : 'rgba(255, 138, 58, 0.2)';
      ctx.beginPath();
      ctx.arc(m.x - totalW / 2 + i * gap, pipY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Draw the Sacred Stone. Renders dormant (low alpha, no pulse) until
 * `awake`; once awake, breathes an ember halo and shows an HP bar.
 * Small, round, dense — sized to feel precious rather than imposing,
 * per the 600bn world-canon rule against giant slabs.
 */
export function drawSacredStone(
  ctx: CanvasRenderingContext2D,
  s: SanctumSacredStone,
): void {
  ctx.save();
  const baseAlpha = s.awake ? 1 : 0.25;

  // Outer halo — only while awake. Breathing scale + alpha keyed to pulse.
  if (s.awake) {
    const haloR = s.r * (1.6 + 0.18 * Math.sin(s.pulse));
    const haloA = 0.28 + 0.18 * Math.sin(s.pulse);
    const grad = ctx.createRadialGradient(s.x, s.y, s.r * 0.5, s.x, s.y, haloR);
    grad.addColorStop(0, `rgba(255, 138, 58, ${haloA})`);
    grad.addColorStop(1, 'rgba(255, 138, 58, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Stone body — dense radial gradient (volcanic core → black edge).
  ctx.globalAlpha = baseAlpha;
  const bodyGrad = ctx.createRadialGradient(
    s.x - s.r * 0.3, s.y - s.r * 0.3, s.r * 0.1,
    s.x, s.y, s.r,
  );
  bodyGrad.addColorStop(0, '#ff8a3a');
  bodyGrad.addColorStop(0.55, '#7a2f12');
  bodyGrad.addColorStop(1, '#1a0a06');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  ctx.fill();

  // Glyph: 4-line sacred number, tiny, etched on the stone face.
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.font = `bold ${Math.floor(s.r * 0.22)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = s.r * 0.24;
  ctx.fillText('600',  s.x, s.y - lineH * 1.5);
  ctx.fillText('000',  s.x, s.y - lineH * 0.5);
  ctx.fillText('000',  s.x, s.y + lineH * 0.5);
  ctx.fillText('000',  s.x, s.y + lineH * 1.5);

  // Hit-flash.
  if (s.hitFlash > 0) {
    ctx.globalAlpha = s.hitFlash * 0.7;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // HP bar — drawn above only when awake.
  if (s.awake) {
    ctx.globalAlpha = 1;
    const barW = s.r * 1.8;
    const barH = 6;
    const barX = s.x - barW / 2;
    const barY = s.y - s.r - 18;
    ctx.fillStyle = 'rgba(40, 24, 12, 0.85)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = '#ff8a3a';
    ctx.fillRect(barX, barY, barW * (s.hp / s.hpMax), barH);
    ctx.strokeStyle = 'rgba(255, 216, 74, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
  }
  ctx.restore();
}

/**
 * Draw the standing brand chrome — the 4-line sacred number wordmark in
 * the upper sky. Doesn't depend on state; safe to call from any phase.
 * Per canon, the number is NEVER compressed: always written as four
 * separate lines with the canonical line breaks.
 */
export function drawSanctumChrome(
  ctx: CanvasRenderingContext2D,
  worldW: number = SANCTUM_WORLD_W,
  worldH: number = SANCTUM_WORLD_H,
): void {
  ctx.save();
  const cx = worldW / 2;
  const top = worldH * 0.08;
  const size = Math.min(worldH * 0.058, 44);
  ctx.font = `bold ${size}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.shadowColor = 'rgba(255, 138, 58, 0.55)';
  ctx.shadowBlur = 16;
  const lineGap = size * 0.95;
  ctx.fillText('600', cx, top);
  ctx.fillText('000', cx, top + lineGap);
  ctx.fillText('000', cx, top + lineGap * 2);
  ctx.fillText('000', cx, top + lineGap * 3);
  ctx.restore();
}

/**
 * Convenience full-pass render — draws chrome, then the active entities
 * in the right z-order. The main render path is encouraged to call the
 * pieces individually so explosion FX / particles can interleave, but
 * this works for the static preview page.
 */
export function renderSanctum(
  ctx: CanvasRenderingContext2D,
  state: SanctumState,
  worldW: number = SANCTUM_WORLD_W,
  worldH: number = SANCTUM_WORLD_H,
): void {
  drawSanctumChrome(ctx, worldW, worldH);
  drawSacredStone(ctx, state.stone);
  for (const m of state.council) drawCouncilAsteroid(ctx, m);
}

/** True once the player has destroyed every council member AND the
 *  Sacred Stone. The level loop ends the run on this transition. */
export function isSanctumComplete(state: SanctumState): boolean {
  return state.phase === 'complete';
}
