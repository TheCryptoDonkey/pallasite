// Verify the W17 EAGLE STATION rig: assembly (1 core + 3 arms + 3 emitters),
// rotation, emitter placing, and core-death clear. Renders under SwiftShader.
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5180/';
const OUT = '/tmp/vein-feel';

async function clickButton(page: Page, label: string, exact = false): Promise<void> {
  await page.evaluate(({ text, exactMatch }) => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const t = (b.textContent ?? '').trim();
      return exactMatch ? t === text : t.includes(text);
    });
    (btn as HTMLButtonElement | undefined)?.click();
  }, { text: label, exactMatch: exact });
}
async function waitPhase(page: Page, phase: string): Promise<void> {
  await page.waitForFunction((p) => (window as unknown as { __pallasiteState?: { phase?: string } }).__pallasiteState?.phase === p, phase, { timeout: 15000 });
}
function station(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { ufos: Array<{ alive: boolean }>; players: Array<{ ship: { alive: boolean }; lives: number }>; asteroids: Array<{ alive: boolean; isVein: boolean; stationPart?: string; pos: { x: number; y: number } }> } }).__pallasiteState!;
    const live = s.asteroids.filter((a) => a.alive);
    const arms = live.filter((a) => a.stationPart === 'arm');
    const ems = live.filter((a) => a.stationPart === 'emitter');
    const core = live.filter((a) => a.stationPart === 'core');
    const looseRocks = live.filter((a) => !a.stationPart && !a.isVein);
    return {
      core: core.length, arms: arms.length, emitters: ems.length, loose: looseRocks.length,
      ufos: s.ufos.filter((u) => u.alive).length,
      shipAlive: s.players[0].ship.alive, lives: s.players[0].lives,
    };
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const portrait = !!process.env.PORTRAIT;
  const vp = portrait ? { width: 390, height: 844 } : { width: 1280, height: 720 };
  const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block', isMobile: portrait, hasTouch: portrait });
  await ctx.addInitScript((t) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', 'campaign');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({ asteroid: t, ship: t, bullet: t, particle: t }));
  }, process.env.TIER ?? 'mesh');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { __pallasiteState?: unknown }).__pallasiteState, { timeout: 15000 });
  await page.evaluate(() => { const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState; if (s) s.session = { pubkey: '0'.repeat(64), displayName: 'STN QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } }; });
  await clickButton(page, 'PLAY');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'), { timeout: 15000 });
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')), { timeout: 15000 });
  await clickButton(page, 'IGNITE');
  await waitPhase(page, 'playing');
  await page.waitForTimeout(2200);
  await page.keyboard.press('Equal'); await page.waitForTimeout(120);
  for (const ch of '17') await page.keyboard.press(ch);
  await page.waitForTimeout(80); await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __pallasiteState?: { wave?: number } }).__pallasiteState?.wave === 17, { timeout: 15000 });
  // NO invuln injection — testing whether the player survives the real spawn now
  // that the station arms are cover, not lethal. The ship sits still (no input).
  await page.waitForTimeout(700);
  for (let t = 0; t <= 8; t++) {
    await page.waitForTimeout(t === 0 ? 200 : 1000);
    console.log(`t~${t}s`, JSON.stringify(await station(page)));
  }
  await page.waitForTimeout(2500);  // clear the Act III intertitle hold
  const tier = process.env.TIER ?? 'mesh';
  if (portrait) {
    await page.screenshot({ path: `${OUT}/station-${tier}-portrait.png` });
    console.log(`portrait ${tier} captured`);
    await browser.close();
    return;
  }
  await page.screenshot({ path: `${OUT}/station-${tier}-rig.png`, clip: { x: 390, y: 110, width: 500, height: 500 } });

  // Kill test: drop the core to 1 HP and pour fire in until a shot threads the
  // arms and pops it — then capture the detonation and confirm loot scattered.
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { cheatedThisRun: boolean; asteroids: Array<{ alive: boolean; stationPart?: string; hp: number }> } }).__pallasiteState!;
    s.cheatedThisRun = false;  // un-cheat so the loot/grace path runs (jumping flags cheated)
    for (const a of s.asteroids) if (a.stationPart === 'core') a.hp = 1;
  });
  await page.keyboard.down('Space');
  let dead = false;
  for (let i = 0; i < 40 && !dead; i++) {
    await page.waitForTimeout(80);
    dead = await page.evaluate(() => {
      const s = (window as unknown as { __pallasiteState?: { asteroids: Array<{ alive: boolean; stationPart?: string }> } }).__pallasiteState!;
      return !s.asteroids.some((a) => a.alive && a.stationPart === 'core');
    });
  }
  await page.keyboard.up('Space');
  const after = await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { coins: Array<{ alive: boolean }>; particles: unknown[]; shockwaveRings: unknown[]; asteroids: Array<{ alive: boolean; stationPart?: string }>; waveClearAt: number | null } }).__pallasiteState!;
    return { coreDead: !s.asteroids.some((a) => a.alive && a.stationPart === 'core'), partsLeft: s.asteroids.filter((a) => a.alive && a.stationPart).length, coins: s.coins.filter((c) => c.alive).length, particles: s.particles.length, shockwaves: s.shockwaveRings.length, graceActive: s.waveClearAt !== null };
  });
  console.log('after kill:', JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/station-${tier}-explosion.png`, clip: { x: 340, y: 60, width: 600, height: 600 } });
  await browser.close();
  console.log(`\nScreenshot in ${OUT}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
