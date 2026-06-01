// One-off visual QA for the vein chip/shrink feel: jump to the wave-16 Mother
// Lode (a stationary mega-vein directly above the player spawn), pour fire into
// it, and capture tight clips around the vein plus its live radius / particle
// stats so the shrink and impact-chip spray can be eyeballed. Run ad hoc
// against the dev server: `pnpm exec tsx tools/shoot-vein-feel.ts`.
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5180/';
const OUT = '/tmp/vein-feel';
const CLIP = { x: 440, y: 160, width: 400, height: 360 };

async function clickButton(page: Page, label: string, exact = false): Promise<void> {
  await page.evaluate(({ text, exactMatch }) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const t = (b.textContent ?? '').trim();
      return exactMatch ? t === text : t.includes(text);
    });
    (btn as HTMLButtonElement | undefined)?.click();
  }, { text: label, exactMatch: exact });
}

async function waitPhase(page: Page, phase: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(
    (p) => (window as unknown as { __pallasiteState?: { phase?: string } }).__pallasiteState?.phase === p,
    phase, { timeout },
  );
}

function veinStats(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { enemyBullets: Array<{ alive: boolean; radius: number }>; powerups: Array<{ pos: { x: number; y: number } }>; asteroids: Array<{ isVein: boolean; alive: boolean; hp: number; hpMax: number; radius: number; pos: { x: number; y: number }; veinBaseRadius?: number; veinRetaliates?: boolean }> } }).__pallasiteState!;
    const v = s.asteroids.find((a) => a.isVein && a.alive);
    if (!v) return null;
    let puMax = 0;
    for (const pu of s.powerups) puMax = Math.max(puMax, Math.hypot(pu.pos.x - v.pos.x, pu.pos.y - v.pos.y));
    const shards = s.enemyBullets.filter((b) => b.alive);
    const bigShards = shards.filter((b) => b.radius >= 4).length;  // VEIN_SHARD_RADIUS=5
    return {
      hp: v.hp, hpMax: v.hpMax,
      radius: Math.round(v.radius * 10) / 10,
      base: v.veinBaseRadius ? Math.round(v.veinBaseRadius * 10) / 10 : null,
      retaliates: v.veinRetaliates === true,
      shards: shards.length,
      bigShards,
      powerups: s.powerups.length,
      puFurthest: Math.round(puMax),
    };
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // SwiftShader software GL so the WebGL mesh overlay actually renders headless
  // — otherwise isWebGLOverlayReady() stays false and we'd only ever see the
  // 2D fallback, never the mesh-tier vein the player on default settings sees.
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', 'campaign');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({ asteroid: 'mesh', ship: 'mesh', bullet: 'mesh', particle: 'mesh' }));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => !!(window as unknown as { __pallasiteState?: unknown }).__pallasiteState, { timeout: 15000 });
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (s) s.session = { pubkey: '0'.repeat(64), displayName: 'VEIN QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } };
  });
  await clickButton(page, 'PLAY');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'), { timeout: 15000 });
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')), { timeout: 15000 });
  await clickButton(page, 'IGNITE');
  await waitPhase(page, 'playing');

  await page.keyboard.press('Equal');
  await page.waitForTimeout(120);
  for (const ch of '16') await page.keyboard.press(ch);
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __pallasiteState?: { wave?: number } }).__pallasiteState?.wave === 16, { timeout: 15000 });
  await waitPhase(page, 'playing').catch(() => undefined);
  // Let the WebGL overlay warm (lazy three.js chunk + first mesh frames) so the
  // mesh-tier vein + seam ring are actually painted before we shoot.
  await page.waitForFunction(() => {
    const c = document.getElementById('game3d');
    return !!c && c.classList.contains('is-active');
  }, { timeout: 10000 }).catch(() => undefined);
  const meshActive = await page.evaluate(() => document.getElementById('game3d')?.classList.contains('is-active') ?? false);
  console.log('mesh overlay active:', meshActive);
  await page.waitForTimeout(1800);

  // Keep the camped ship invulnerable so it survives the shard barrage and
  // keeps firing long enough to cross a 25-hit power-up milestone (under slow
  // SwiftShader the ship would otherwise be killed by its own refusal to move).
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { players: Array<{ ship: { invulnerableUntil: number }; lives: number }>; elapsed: number } }).__pallasiteState!;
    s.players[0].ship.invulnerableUntil = s.elapsed + 120_000;
    s.players[0].lives = 9;
  });

  console.log('before  ', await veinStats(page));
  await page.screenshot({ path: `${OUT}/01-vein.png`, clip: CLIP });   // clean mesh vault — no arcs

  // CAMP TEST: hold position, fire straight up. The lode now defends itself —
  // tracking shard fans should appear (enemyShards climbing) and milestone
  // power-ups should fling well clear (puFurthest ~300). Log over ~8s and grab
  // a frame with shards in flight.
  await page.keyboard.down('Space');
  let gotShards = false, puSeen = 0;
  for (let f = 0; f < 80; f++) {
    await page.waitForTimeout(200);
    const st = await veinStats(page);
    if (st) puSeen = Math.max(puSeen, st.puFurthest);
    if (st && f % 4 === 0) console.log(`t=${(f * 0.2).toFixed(1)}s hp=${st.hp} retaliates=${st.retaliates} shards=${st.shards} big=${st.bigShards} powerups=${st.powerups} puFurthest=${st.puFurthest}`);
    if (st && st.bigShards >= 1 && !gotShards) { await page.screenshot({ path: `${OUT}/02-shards.png`, clip: CLIP }); gotShards = true; }
  }
  await page.keyboard.up('Space');
  console.log('peak power-up distance from vein (camp):', puSeen);

  // Milestone fling check: park the vein one hit short of a 25-hit milestone and
  // make the ship invulnerable so the camped shots actually land, then fire a
  // burst and confirm the dropped power-up is flung well clear of the rock.
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { players: Array<{ ship: { invulnerableUntil: number } }>; elapsed: number; asteroids: Array<{ isVein: boolean; alive: boolean; hp: number; hpMax: number }> } }).__pallasiteState!;
    const v = s.asteroids.find((a) => a.isVein && a.alive);
    if (v) v.hp = v.hpMax - 24;          // next ~milestone at hitsLanded=25
    s.players[0].ship.invulnerableUntil = s.elapsed + 60_000;
  });
  await page.keyboard.down('Space');
  let milestonePu = 0;
  for (let f = 0; f < 30; f++) {
    await page.waitForTimeout(150);
    const st = await veinStats(page);
    if (st) milestonePu = Math.max(milestonePu, st.puFurthest);
  }
  await page.keyboard.up('Space');
  console.log('milestone power-up distance from vein:', milestonePu, '(expect ~200-350)');

  await page.waitForTimeout(400);
  console.log('after   ', await veinStats(page));
  await page.screenshot({ path: `${OUT}/03-after.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } });

  await browser.close();
  console.log(`\nClips in ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
