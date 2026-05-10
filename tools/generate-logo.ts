/**
 * Generate the PALLASITE wordmark logo via OpenAI's gpt-image-2.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npm run gen-logo                 # generates if missing
 *   npm run gen-logo -- --force      # regenerate, overwriting
 *   npm run gen-logo -- --variant flat  # use the flat-graphic prompt instead
 *
 * Output goes to originals/logo-<variant>.png. Run a separate webp/optimise
 * step (or hand-convert) before dropping into public/.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Set OPENAI_API_KEY in your environment.');
  process.exit(1);
}

const MODEL = 'gpt-image-2';
const SIZE = '1024x1024';
const QUALITY = 'high';
const OUT_DIR = join(process.cwd(), 'originals');

const args = process.argv.slice(2);
const force = args.includes('--force');
const variantIdx = args.indexOf('--variant');
const variant: 'crystal' | 'flat' = variantIdx >= 0 && args[variantIdx + 1] === 'flat' ? 'flat' : 'crystal';

const PROMPTS: Record<typeof variant, string> = {
  // Default: photorealistic crystal-and-metal cross-section letterforms.
  crystal: `A futuristic vector-arcade game logo for the word "PALLASITE". The lettering itself appears as if cut from a pallasite meteorite cross-section: translucent olive-green olivine crystals (gem-quality peridot) embedded in a polished silver nickel-iron matrix, with bright reflective highlights along the metal. Letterforms are clean wide-tracked retro-futuristic monospace, centered horizontally, soft inner glow. Background: deep space black with a faint blue-purple nebula wash and a sparse scatter of distant stars. No tagline, no UI, no border, no extra text — just the single word "PALLASITE". Composition: 1024x1024 square, the lettering occupies roughly the middle 40% horizontally with negative space above and below. Photorealistic material rendering on the letters; clean graphic-design aesthetic overall. Centered, balanced, awe-inspiring. No misspellings — the word must read exactly P-A-L-L-A-S-I-T-E.`,
  // Fallback: flatter graphic-design style, in case crystal version comes out muddy.
  flat: `A clean retro-futuristic vector logo for the word "PALLASITE". Bold wide-tracked monospace letterforms in a vivid heraldic green (#58ff58) with a subtle yellow-gold inner highlight echoing pallasite meteorite olivine crystals. Soft outer cyan-blue glow suggesting space. Background: deep solid black with a faint scattered starfield. No tagline, no UI, no border, no extra text — just the single word "PALLASITE". Composition: 1024x1024 square, lettering occupies roughly the middle 50% horizontally and is precisely centered both axes. Crisp, vector, graphic-design quality. Aspect 1024x1024. No misspellings — the word must read exactly P-A-L-L-A-S-I-T-E.`,
};

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, `logo-${variant}.png`);
  if (!force && existsSync(target)) {
    console.log(`  ${target} exists, use --force to regenerate.`);
    return;
  }

  console.log(`Generating PALLASITE logo (${variant} variant) via ${MODEL} (${SIZE}, quality=${QUALITY})…`);
  process.stdout.write(`  → ${target} … `);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      prompt: PROMPTS[variant],
      n: 1,
      size: SIZE,
      quality: QUALITY,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log(`✗ ${res.status}`);
    console.error(`     ${errText.slice(0, 400)}`);
    process.exit(1);
  }

  const json = (await res.json()) as {
    model?: string;
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const item = json.data?.[0];
  if (!item) {
    console.log('✗ empty response');
    process.exit(1);
  }

  let bytes: Uint8Array;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      console.log(`✗ download failed: ${imgRes.status}`);
      process.exit(1);
    }
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    console.log('✗ no b64_json or url in response');
    process.exit(1);
  }

  writeFileSync(target, bytes);
  const kb = (bytes.length / 1024).toFixed(1);
  const modelTag = json.model ? ` [model=${json.model}]` : '';
  console.log(`✓ ${kb} KB${modelTag}`);
  if (item.revised_prompt) {
    console.log(`     revised: ${item.revised_prompt.slice(0, 200)}…`);
  }
  console.log('');
  console.log(`Next: review ${target}, then convert to webp + drop in public/logo.webp`);
  console.log(`  cwebp ${target} -o public/logo.webp -q 90`);
}

void main();
