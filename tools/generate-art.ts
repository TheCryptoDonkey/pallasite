/**
 * Generate hero artwork (app icon, controller icon, OG card) via OpenAI
 * gpt-image-2. Companion to tools/generate-logo.ts — same pipeline, but
 * for the square-icon and social-card formats instead of the wordmark.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   pnpm exec tsx tools/generate-art.ts --variant app-icon
 *   pnpm exec tsx tools/generate-art.ts --variant controller-icon
 *   pnpm exec tsx tools/generate-art.ts --variant og-card
 *   ... append --force to overwrite an existing original.
 *
 * Output goes to originals/<variant>.png. After review, run
 *   pnpm exec tsx tools/render-icons.ts
 * which picks up the photoreal source if present and falls back to SVG.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Set OPENAI_API_KEY in your environment.');
  process.exit(1);
}

type Variant = 'app-icon' | 'controller-icon' | 'og-card';

interface VariantSpec {
  prompt: string;
  size: '1024x1024' | '1024x1536' | '1536x1024';
  // gpt-image-1 supports background: 'transparent'; gpt-image-2 has nicer composition.
  // App icons need an opaque deep-space backdrop, so we use the v2 model.
  model: 'gpt-image-2' | 'gpt-image-1';
  transparent?: boolean;
}

const SPECS: Record<Variant, VariantSpec> = {
  // The headline icon: a museum-quality pallasite specimen, hero-lit.
  // No text — readability at any size depends entirely on the silhouette.
  'app-icon': {
    model: 'gpt-image-2',
    size: '1024x1024',
    prompt: `Hero product render of a single polished pallasite meteorite cross-section, perfectly circular slice viewed head-on, centred in frame. Deep cosmic black backdrop with a faint indigo-violet nebula glow and a sparse scatter of tiny distant stars. The slice itself is the absolute focal point: a polished iron-nickel matrix with visible Widmanstätten cross-hatch pattern (etched octahedral crystallography forming a delicate criss-cross of bright and dark bands), embedded with roughly twenty irregular sub-rounded olivine (peridot) crystals in saturated green-gold colours ranging from honey-yellow through spring-green to deep forest, each crystal translucent and catching the studio light with sharp specular highlights. Crystals fill the slice densely but with visible matrix flowing between them like stained-glass leading. Subtle warm rim-light on the edge of the disk, soft contact shadow underneath. Photorealistic macro-photography style — Brenham, Esquel or Fukang specimen reference. Studio lighting from upper-left. The slice fills about 80% of the frame width, perfectly centred both axes, leaving a small dark margin all around (this is critical: the icon will be cropped for maskable variants). No text, no watermark, no border, no UI elements, no humans, no spacecraft — just the specimen on space backdrop. Square 1:1 aspect.`,
  },

  // Controller PWA icon: pallasite-stage hosting a Kempston-style joystick.
  // Recognisably "controller" but anchored in the Pallasite visual language.
  'controller-icon': {
    model: 'gpt-image-2',
    size: '1024x1024',
    prompt: `Hero product render for a phone-as-controller app icon. A polished pallasite meteorite cross-section disk fills the lower half of the square frame, viewed at a slight perspective (a few degrees of tilt), with its iron-nickel matrix and green-gold olivine crystals clearly visible. Standing upright on top of the disk, perfectly centred, is a classic 1980s Kempston-style ZX Spectrum arcade joystick: black plastic base with brushed-metal trim, single tall vertical shaft, large glossy bright red ball-top grip, single red fire button on the base. The joystick is the hero — sharply rendered, photoreal, with strong specular highlights on the metal and ball. Deep cosmic black backdrop with a faint indigo-violet nebula and a sparse scatter of distant stars. Studio lighting from upper-left. Subtle warm rim-light. Soft contact shadow under the disk. No text, no watermark, no UI, no humans — just the joystick on the pallasite disk in space. Square 1:1 aspect, content fully centred with comfortable margin on all sides (icon will be cropped for maskable variants).`,
  },

  // Social share card BACKDROP — slice only, no text. The PALLASITE wordmark
  // (public/logo.webp) and tagline are composited on the right half during
  // rendering, locking in brand-consistent typography across surfaces.
  'og-card': {
    model: 'gpt-image-2',
    size: '1536x1024',
    prompt: `A high-end landscape game key-art background. On the LEFT THIRD of the frame: a hero render of a single polished pallasite meteorite cross-section, perfectly circular, photoreal, iron-nickel matrix with Widmanstätten cross-hatch pattern, embedded densely with translucent green-gold olivine peridot crystals catching studio light with sharp specular highlights. Soft warm rim-light, subtle contact shadow. The CENTRE AND RIGHT TWO-THIRDS of the frame must be a clean uncluttered backdrop: deep cosmic black with a faint indigo-violet nebula wash and a sparse scatter of tiny distant stars — completely empty of any text, logos, letterforms, words, glyphs, symbols, UI, humans, spacecraft, asteroids, or other foreground content. The right side must read as flat dark negative space ready for a typographic overlay to be composited on top. ABSOLUTELY NO TEXT ANYWHERE in the image — no titles, no taglines, no captions, no watermarks, no signatures. Studio lighting from upper-left. Cinematic, balanced, high-contrast. Landscape 3:2 aspect.`,
  },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const variantIdx = args.indexOf('--variant');
const variant = (variantIdx >= 0 ? args[variantIdx + 1] : '') as Variant;

if (!SPECS[variant]) {
  console.error(`Usage: --variant <${Object.keys(SPECS).join('|')}> [--force]`);
  process.exit(1);
}

const OUT_DIR = join(process.cwd(), 'originals');

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const spec = SPECS[variant];
  const target = join(OUT_DIR, `${variant}.png`);
  if (!force && existsSync(target)) {
    console.log(`  ${target} exists, use --force to regenerate.`);
    return;
  }

  console.log(`Generating ${variant} via ${spec.model} (${spec.size}, quality=high)…`);
  process.stdout.write(`  → ${target} … `);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: spec.model,
      prompt: spec.prompt,
      n: 1,
      size: spec.size,
      quality: 'high',
      ...(spec.transparent ? { background: 'transparent' } : {}),
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
    console.log(`     revised: ${item.revised_prompt.slice(0, 240)}…`);
  }
  console.log('');
  console.log(`Next: review ${target}; then `);
  console.log(`  pnpm exec tsx tools/render-icons.ts`);
  console.log(`(picks up the photoreal source if present, falls back to SVG.)`);
}

void main();
