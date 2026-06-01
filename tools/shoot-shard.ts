// Close-up QA of the boss-vein retaliation shard across all three visual tiers.
// Jumps to W16, makes the ship invulnerable so it survives to draw fire, then
// captures a tight crop centred on a live shard. Run: pnpm exec tsx tools/shoot-shard.ts
import { chromium, type Page, type BrowserContext } from 'playwright';
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

async function captureTier(ctx: BrowserContext, tier: string): Promise<void> {
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', 'campaign');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({ asteroid: t, ship: t, bullet: t, particle: t }));
  }, tier);
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { __pallasiteState?: unknown }).__pallasiteState, { timeout: 15000 });
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (s) s.session = { pubkey: '0'.repeat(64), displayName: 'SHARD QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } };
  });
  await clickButton(page, 'PLAY');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'), { timeout: 15000 });
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')), { timeout: 15000 });
  await clickButton(page, 'IGNITE');
  await waitPhase(page, 'playing');
  await page.keyboard.press('Equal'); await page.waitForTimeout(120);
  for (const ch of '16') await page.keyboard.press(ch);
  await page.waitForTimeout(80); await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as unknown as { __pallasiteState?: { wave?: number } }).__pallasiteState?.wave === 16, { timeout: 15000 });
  await page.waitForTimeout(tier === 'mesh' ? 2200 : 1400);  // overlay warm on mesh
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { players: Array<{ ship: { invulnerableUntil: number }; lives: number }>; elapsed: number } }).__pallasiteState!;
    s.players[0].ship.invulnerableUntil = s.elapsed + 120_000;
    s.players[0].lives = 9;
  });
  // Fire until a shard exists, then PIN one to screen centre (and slow it so
  // it barely drifts between frames) for a clean, well-centred close-up that
  // still shows the motion trail. Pinning each tick keeps it parked.
  await page.keyboard.down('Space');
  let pinned = false;
  for (let i = 0; i < 60 && !pinned; i++) {
    await page.waitForTimeout(110);
    pinned = await page.evaluate(() => {
      const s = (window as unknown as { __pallasiteState?: { enemyBullets: Array<{ alive: boolean; shard?: boolean; pos: { x: number; y: number }; vel: { x: number; y: number }; ttl: number }> } }).__pallasiteState!;
      const sh = s.enemyBullets.find((b) => b.alive && b.shard);
      if (!sh) return false;
      sh.pos.x = 640; sh.pos.y = 580;
      sh.vel.x = 0; sh.vel.y = 70;   // gentle drift keeps a short trail + tumble
      sh.ttl = 9000;
      return true;
    });
  }
  if (pinned) {
    // Re-pin right before the shot so it hasn't drifted, then crop tight.
    await page.evaluate(() => {
      const s = (window as unknown as { __pallasiteState?: { enemyBullets: Array<{ alive: boolean; shard?: boolean; pos: { x: number; y: number } }> } }).__pallasiteState!;
      const sh = s.enemyBullets.find((b) => b.alive && b.shard);
      if (sh) { sh.pos.x = 640; sh.pos.y = 580; }
    });
    const half = 30;
    await page.screenshot({ path: `${OUT}/shard-${tier}.png`, clip: { x: 640 - half, y: 580 - half, width: half * 2, height: half * 2 } });
    console.log(`${tier}: shard captured`);
  } else {
    console.log(`${tier}: no shard seen`);
  }
  await page.keyboard.up('Space');
  await page.close();
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const tier of ['mesh', 'shaded', 'vector']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    await captureTier(ctx, tier);
    await ctx.close();
  }
  await browser.close();
  console.log(`\nShard crops in ${OUT}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
