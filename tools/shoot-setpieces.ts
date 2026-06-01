// One-off visual QA: jump to each signature-moment wave and screenshot both
// the gold banner (wavestart) and the spawned layout (playing). Not registered
// in CI — run ad hoc against the dev server: `tsx tools/shoot-setpieces.ts`.
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5181/';
const WAVES = [8, 9, 16, 20, 24];
const OUT = '/tmp/setpieces';

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

async function jumpToWave(page: Page, wave: number): Promise<void> {
  await page.keyboard.press('Equal');           // open cheat input
  await page.waitForTimeout(120);
  for (const ch of String(wave)) await page.keyboard.press(ch);
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');           // confirm jump
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', 'campaign');
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // Seed a guest session so IGNITE is unlocked, then walk the menu.
  await page.waitForFunction(() => !!(window as unknown as { __pallasiteState?: unknown }).__pallasiteState, { timeout: 15000 });
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (s) s.session = { pubkey: '0'.repeat(64), displayName: 'SETPIECE QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } };
  });
  await clickButton(page, 'PLAY');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'), { timeout: 15000 });
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')), { timeout: 15000 });
  await clickButton(page, 'IGNITE');
  await waitPhase(page, 'playing');

  for (const wave of WAVES) {
    await jumpToWave(page, wave);
    // Wait until the sim actually lands on the target wave.
    await page.waitForFunction(
      (w) => (window as unknown as { __pallasiteState?: { wave?: number; phase?: string } }).__pallasiteState?.wave === w,
      wave, { timeout: 15000 },
    );
    // Banner shot — wait into the wavestart hold so the gold title is at full alpha.
    await page.waitForTimeout(1100);
    await page.screenshot({ path: `${OUT}/wave-${wave}-banner.png` });
    // Layout shot — let it settle into play so the entity field is visible.
    await waitPhase(page, 'playing').catch(() => undefined);
    await page.waitForTimeout(900);
    const counts = await page.evaluate(() => {
      const s = (window as unknown as { __pallasiteState?: { wave: number; mines: unknown[]; asteroids: unknown[]; ufos: unknown[] } }).__pallasiteState!;
      return { wave: s.wave, mines: s.mines.length, asteroids: s.asteroids.length, ufos: s.ufos.length };
    });
    console.log(`wave ${counts.wave}: mines=${counts.mines} asteroids=${counts.asteroids} ufos=${counts.ufos}`);
    await page.screenshot({ path: `${OUT}/wave-${wave}-play.png` });
  }

  await browser.close();
  console.log(`\nScreenshots in ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
