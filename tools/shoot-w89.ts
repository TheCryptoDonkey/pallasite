// Verify the reworked W8 (gauntlet boss) and W9 (closing cage) set-pieces.
// Runs under SwiftShader so the mesh tier actually paints. Captures a layout
// screenshot of each and checks the key invariants.
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
async function jump(page: Page, wave: number): Promise<void> {
  await page.keyboard.press('Equal'); await page.waitForTimeout(120);
  for (const ch of String(wave)) await page.keyboard.press(ch);
  await page.waitForTimeout(80); await page.keyboard.press('Enter');
  await page.waitForFunction((w) => (window as unknown as { __pallasiteState?: { wave?: number } }).__pallasiteState?.wave === w, wave, { timeout: 15000 });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', 'campaign');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({ asteroid: 'mesh', ship: 'mesh', bullet: 'mesh', particle: 'mesh' }));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { __pallasiteState?: unknown }).__pallasiteState, { timeout: 15000 });
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (s) s.session = { pubkey: '0'.repeat(64), displayName: 'W89 QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } };
  });
  await clickButton(page, 'PLAY');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'), { timeout: 15000 });
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')), { timeout: 15000 });
  await clickButton(page, 'IGNITE');
  await waitPhase(page, 'playing');
  await page.waitForTimeout(2200);  // overlay warm

  // ── W8 ──
  await jump(page, 8);
  await waitPhase(page, 'playing').catch(() => undefined);
  await page.evaluate(() => { const s = (window as unknown as { __pallasiteState?: { players: Array<{ ship: { invulnerableUntil: number }; lives: number }>; elapsed: number } }).__pallasiteState!; s.players[0].ship.invulnerableUntil = s.elapsed + 120_000; s.players[0].lives = 9; });
  await page.waitForTimeout(800);
  const w8a = await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { mines: unknown[]; ufos: unknown[]; asteroids: Array<{ alive: boolean; isVein: boolean; veinRetaliates?: boolean }> } }).__pallasiteState!;
    const v = s.asteroids.find((a) => a.alive && a.isVein);
    return { mines: s.mines.length, asteroids: s.asteroids.filter((a) => a.alive).length, ufos: s.ufos.length, veinPresent: !!v, veinRetaliates: v?.veinRetaliates === true };
  });
  // Fire up to draw retaliation, then count shards.
  await page.keyboard.down('Space');
  await page.waitForTimeout(2500);
  const w8shards = await page.evaluate(() => (window as unknown as { __pallasiteState?: { enemyBullets: Array<{ alive: boolean; shard?: boolean }> } }).__pallasiteState!.enemyBullets.filter((b) => b.alive && b.shard).length);
  await page.screenshot({ path: `${OUT}/w8.png` });
  await page.keyboard.up('Space');
  console.log('W8', JSON.stringify(w8a), 'shardsInFlight=', w8shards);

  // ── W9 ──
  await jump(page, 9);
  await waitPhase(page, 'playing').catch(() => undefined);
  await page.evaluate(() => { const s = (window as unknown as { __pallasiteState?: { players: Array<{ ship: { invulnerableUntil: number }; lives: number }>; elapsed: number } }).__pallasiteState!; s.players[0].ship.invulnerableUntil = s.elapsed + 120_000; s.players[0].lives = 9; });
  // Sample the ring radius over the close so we can see it seal.
  for (const t of [0, 1, 2, 3]) {
    await page.waitForTimeout(t === 0 ? 200 : 800);
    const r = await page.evaluate(() => {
      const s = (window as unknown as { __pallasiteState?: { asteroids: Array<{ alive: boolean; size: string; pos: { x: number; y: number } }> } }).__pallasiteState!;
      const ds = s.asteroids.filter((a) => a.alive && a.size === 'large').map((a) => Math.hypot(a.pos.x - 640, a.pos.y - 360));
      if (!ds.length) return null;
      return { n: ds.length, min: Math.round(Math.min(...ds)), max: Math.round(Math.max(...ds)), avg: Math.round(ds.reduce((x, y) => x + y, 0) / ds.length) };
    });
    console.log(`W9 ring t~${(t * 0.8).toFixed(1)}s`, JSON.stringify(r));
  }
  await page.screenshot({ path: `${OUT}/w9.png` });

  await browser.close();
  console.log(`\nLayouts in ${OUT}/`);
}
main().catch((e) => { console.error(e); process.exit(1); });
