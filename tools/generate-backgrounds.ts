/**
 * Generate per-wave background art via OpenAI's gpt-image-2.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npm run gen-backgrounds            # generates any missing waves
 *   npm run gen-backgrounds -- --force # regenerate all
 *   npm run gen-backgrounds -- --wave 5 # generate just wave 5
 *
 * Idempotent — skips waves whose PNG already exists unless --force is set.
 *
 * Style: ultra-high quality space photography (Hubble / JWST / ESO).
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('Set OPENAI_API_KEY in your environment.');
  process.exit(1);
}

const MODEL = 'gpt-image-2';
const SIZE = '1536x1024';   // panoramic; canvas crops/stretches to 960x720
const ASTEROID_SIZE = '1024x1024';  // square for the per-type asteroid surface textures
const QUALITY = 'high';     // gpt-image-1 accepts low|medium|high|auto; gpt-image-2 expected to mirror
/** Originals directory — full-quality PNG kept out of the deploy bundle. */
const OUT_DIR = join(process.cwd(), 'originals');

const args = process.argv.slice(2);
const force = args.includes('--force');
const waveArgIdx = args.indexOf('--wave');
const onlyWave = waveArgIdx >= 0 ? parseInt(args[waveArgIdx + 1], 10) : null;
/** --sanctum generates the 600bn Sanctum background (Madeira volcanic
 *  cliffs, storm light, ember palette) instead of any wave. Off-axis
 *  from the wave-N flow so the file lands at originals/sanctum.png. */
const onlySanctum = args.includes('--sanctum');
/** --asteroids generates the per-type 1024×1024 photoreal asteroid-
 *  surface textures used as the 600bn Sanctum filler fills AND as 3D
 *  mesh diffuse maps. Idempotent — already-existing originals skip
 *  unless --force is set, so re-running after adding new types only
 *  generates the new ones. */
const onlyAsteroids = args.includes('--asteroids');

interface WavePrompt {
  wave: number;
  prompt: string;
}

/** Named (non-wave) background target — same gpt-image-2 pipeline,
 *  custom output filename. Currently just the 600bn Sanctum. */
interface NamedPrompt {
  name: string;
  prompt: string;
}

/**
 * 12 photorealistic deep-space environments. Each prompt deliberately leaves
 * the lower-centre region darker so vector gameplay (ship, asteroids, bullets)
 * stays legible on top.
 */
const WAVES: WavePrompt[] = [
  {
    wave: 1,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, captured in the style of a Hubble Space Telescope wide-field image. A distant blue ice gas giant on the right side of the frame, partially in shadow, with subtle atmospheric blue rim lighting and visible cloud bands. Faint cyan-blue interstellar dust clouds wisp through the upper-left quadrant. Tens of thousands of pinpoint stars at varying brightness scattered across deep black space. The lower-centre of the frame is a quiet dark void. No text, no graphics, no UI elements, no spaceships, no asteroids, no characters, no logos. Cinematic, awe-inspiring, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 2,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a James Webb Space Telescope NIRCam composite. A glowing warm orange and amber emission nebula dominates the upper portion with delicate filamentary dust structures and dark Bok globules. Two airless moons in the lower-right corner — one heavily cratered grey, one rocky red, both lit from a distant unseen star — partially in shadow. Black space background dotted with thousands of pinpoint stars. The lower-centre region is a darker quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, awe-inspiring. Aspect 1536x1024.`,
  },
  {
    wave: 3,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a Cassini-quality planetary photograph composited with deep-field background. A teal-cyan emission nebula glowing in the upper portion of the frame. A massive ringed gas giant (Saturn-like) in the lower-left, deep amber and pale gold colours with intricate visible ring banding casting a thin shadow on the planet. Realistic phase shading and atmospheric haze. Distant pinpoint stars filling deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 4,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, captured in the style of an ESO long-exposure colour composite. A deep purple and violet reflection nebula filling the upper two-thirds of the frame with glowing magenta filaments and dark dust lanes. A close binary star system at upper right — one brilliant white-blue main sequence star, one dimmer orange giant — with realistic diffraction spike patterns. Pinpoint stars throughout. Lower-centre is a darker void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 5,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a JWST mid-infrared image of a star-forming region. A vivid crimson and deep red emission nebula with darker dust lanes and bright young star clusters embedded in the cloud, dominating the upper centre. A heavily cratered grey-brown airless moon in the lower-right with realistic regolith texture and Earthshine-like rim lighting. Distant pinpoint stars across deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 6,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, captured in the style of a Hubble + ground-based long-exposure mosaic of the Andromeda galaxy (M31). The galaxy seen at three-quarter angle filling most of the frame, dramatic and large. Spiral arms in vivid layered colour: deep magenta and pink in the outer arms, golden-amber bright core, warm orange in the inner spiral, electric blue and ultraviolet in star-forming regions, emerald-green and brown dust lanes. Scattered cyan and white star clusters along the arms. Subtle dark dust banding crossing brighter regions. Surrounding deep black space dotted with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 7,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a Hubble plus ground-based long-exposure of the Pleiades open star cluster (M45, known in Japan as Subaru — fitting for a Japanese 1898 specimen). Several brilliant young blue-white stars dominate the upper portion of the frame, each with subtle diffraction spikes. Surrounding intricate cobalt-blue reflection nebulosity — wispy filaments and streamers of interstellar dust catching the starlight, layered with darker dust lanes. Subtle background of warmer gold and soft amber. Distant pinpoint stars across deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, painterly, distinct from any black-hole imagery. Aspect 1536x1024.`,
  },
  {
    wave: 8,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a JWST close-up of a gas giant. A massive gas giant in the lower-centre with bold horizontal storm bands in turquoise, deep navy blue, ultraviolet, magenta, and violet, plus visible cyclonic vortices and a Great Red Spot analogue. A subtle ring system tilted slightly, with realistic ring shadow on the planet's surface. A pink-violet ionised nebula in the upper portion. Distant pinpoint stars. Lower-centre quiet void around the planet's lower edge. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 9,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of an ESA / Cassini-quality planetary image composited with auroral data. A pale blue ice planet in the centre-right with cracked tectonic surface, polar caps shimmering with bright green and pink auroras, subtle ring of dust around it. Soft teal nebula glow surrounding the planet. Distant pinpoint stars across deep black space. Lower-centre dark void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 10,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, dramatic post-cataclysm scene. A blood-red emission nebula with darker streaks in the upper-left, suggesting recent stellar violence. A shattered moon in the lower-right — fragments of grey rock floating in slow drift formation, the largest piece showing a cratered surface, smaller debris glinting with phase-lit highlights. Distant pinpoint stars across deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, ominous. Aspect 1536x1024.`,
  },
  {
    wave: 11,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, dramatic megastructure scene composed in JWST style. A vast alien Dyson swarm — a partial sphere of pale silver-white panels glinting with reflected starlight, encircling a small distant white dwarf or young star, dominating the centre-right. The structure has visible gaps and incomplete sections suggesting awe at scale. Surrounding deep black space dotted with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, awe-inspiring, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 12,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a Hubble plus JWST composite of a recent supernova remnant. A blazing supernova event dominating the upper-centre — bright golden-white core with expanding shockwave shells of yellow, orange, and crimson, dust filaments in cyan and violet radiating outward, intricate detail and shock fronts. Surrounding deep black space with displaced pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, climactic, awe-inspiring, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 13,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a JWST near-infrared image. A globular star cluster at the centre-right with hundreds of resolved stars in warm yellow, orange, and white, ageing red giants visible. Distant pinkish nebula glow surrounds the cluster. Deep black space scattered with pinpoint background stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 14,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, JWST mid-infrared style. Twin spiral galaxies caught mid-merger in the upper-centre, their arms distorted into tidal tails of pink, white, and gold, with a shared envelope of bluish star-forming hot spots between them. Bright dust lanes connecting the cores. Surrounding deep black space dotted with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 15,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a Hubble image of a planetary nebula. The Helix Nebula seen face-on filling the centre — a bright cyan-blue inner ring with concentric layers of red, magenta, and gold, intricate filamentary structure radiating outward. Surrounding deep black space dotted with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 16,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, JWST style. The Pillars of Creation — vast columns of dense interstellar gas and dust in browns, golds, and deep crimson, lit from above by hot young stars whose blue light penetrates the tops. Star-forming jets at the column tips. Surrounding deep black space scattered with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 17,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, ESO long-exposure style. A glowing magenta-pink emission nebula in the upper portion. Below it, a high-velocity rogue planet (icy, dark grey, partially lit by reflected nebula light, with cracked surface and faint frozen atmosphere halo) crossing the lower-right. Distant pinpoint stars across deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, ominous. Aspect 1536x1024.`,
  },
  {
    wave: 18,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a Cassini high-detail planetary close-up composited with deep field. A close-up of a brown dwarf — dim red-brown sphere with subtle banding and storm patterns — at the right of the frame, glowing faintly from its own residual heat. Surrounding sparse pinpoint stars. Subtle dust glow in the upper portion. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 19,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, JWST style. A neutron star at the upper centre — tiny but blindingly bright with diffraction spikes, surrounded by its rotating pulsar wind nebula in shades of electric blue, white, and violet, intricate filaments and shock fronts. Surrounding deep black space and pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, intense. Aspect 1536x1024.`,
  },
  {
    wave: 20,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, Hubble + JWST composite style. Vast dust lane crossing the frame diagonally — interstellar dust in browns and reds with embedded dark Bok globules. Bright young blue stars peeking through the gaps. Faint magenta-pink emission glow behind the dust. Pinpoint background stars throughout deep black space. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 21,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, in the style of a JWST close-up of a young protoplanetary disc. A central T Tauri young star with a tilted dusty disc visible edge-on, dark in the silhouette plane, glowing pink-orange around the edges where the star illuminates it. Bipolar polar jets shooting upward and downward from the disc poles. Surrounding deep black space with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible. Aspect 1536x1024.`,
  },
  {
    wave: 22,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, JWST style. A dramatic galactic centre region with a bright golden core, dense star cluster around it, shrouded in red dust filaments. Faint outline of a central supermassive black hole's accretion glow. Many resolved stars in the foreground field. Surrounding deep black space with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, dramatic. Aspect 1536x1024.`,
  },
  {
    wave: 23,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, JWST mid-infrared style. A massive Wolf-Rayet star at the upper centre with its dramatic surrounding nebula — concentric shells of expelled gas in vivid pink, gold, and emerald-green, hot core glowing white-blue. Diffraction spikes and intricate shock structure. Surrounding deep black space with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, scientifically plausible, awe-inspiring. Aspect 1536x1024.`,
  },
  {
    wave: 24,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, dramatic Hubble + JWST composite. A binary black hole system in the lower-right with two accretion discs of incandescent gold and crimson orbiting each other, gravitational lensing distorting nearby stars into thin arcs and rings. Tidal streams of plasma between them. Deep blue and violet dust haze in the upper portion. Surrounding deep black space with pinpoint stars. Lower-centre quiet void. No text, no graphics, no UI, no spaceships, no asteroids. Cinematic, foreboding, scientifically plausible, painterly. Aspect 1536x1024.`,
  },
  {
    wave: 25,
    prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, the most dramatic and climactic possible. A supermassive black hole at the centre of the frame, its event horizon a perfect black void, surrounded by a blazing accretion disc of incandescent white-hot core fading through gold, orange, crimson, and finally deep red at the outer rim. Twin polar relativistic plasma jets of brilliant blue-white shooting up and down past the frame. Pronounced Einstein ring of gravitationally lensed light bending around the black hole, with surrounding stars distorted into thin arcs. Streaks of red-orange superheated plasma spiralling inward at relativistic speeds. Distant ionised dust in the background in vivid purple and magenta. Surrounding deep black space with pinpoint stars. Cinematic, climactic, awe-inspiring, foreboding, painterly with extreme detail. No text, no graphics, no UI, no spaceships, no asteroids. Aspect 1536x1024.`,
  },
];

/** 600bn Sanctum bed — Madeira volcanic cliffs at storm-light hour.
 *  Per 600bn world canon: orange/gold/ember palette, storm charge,
 *  mythic register, no buildings/figures, no sacred stones IN the
 *  background (the stone lives in-game). Lower-centre stays dark so
 *  the council asteroids + ship + Stone read on top. */
const SANCTUM_PROMPT: NamedPrompt = {
  name: 'sanctum',
  prompt: `Photorealistic dramatic landscape, ultra-high resolution, cinematic mythic register. Madeira volcanic basalt cliffs viewed from a high vantage at storm-light golden hour. Towering jagged black basalt headlands silhouetted in the lower-left and lower-right thirds, weathered and ancient. Vast tempestuous Atlantic sky fills the upper two-thirds — a cathedral of layered ember orange, burnished gold, deep amber, and storm-charged crimson, with massive crepuscular rays piercing through ragged stratus clouds. Distant ocean horizon catching the molten light. Faint sparks and embers drifting upward from the cliffs as if the rock itself is alive. The lower-centre is a darker quiet void where the ocean lies in deep shadow. No text, no graphics, no UI, no spaceships, no asteroids, no boats, no characters, no buildings, no figures, no logos. Cinematic, mythic, scripture-like, awe-inspiring, painterly. Aspect 1536x1024.`,
};

/** Bespoke deep-space backdrop for the 600bn Sanctum playable wave —
 *  space rather than the Madeira landscape, so it sits behind the
 *  council ring without competing for the eye. Warm ember nebula,
 *  distant golden spiral galaxy, dark lower-centre for gameplay
 *  legibility. */
const SANCTUM_SPACE_PROMPT: NamedPrompt = {
  name: 'sanctum-space',
  prompt: `Photorealistic deep-space astrophotography, ultra-high resolution, captured in the style of a Hubble + JWST composite mosaic. A vast cosmic vista with a warm ember nebula filling the upper-third — drifting orange and gold dust clouds with delicate filamentary structure, like a celestial forge breathing slowly. A distant golden Andromeda-like spiral galaxy hanging at upper-right at three-quarter angle, deep amber core with warm sweeping arms. Thousands of pinpoint stars scattered across deep velvet-black space, with subtle cobalt and violet ionised dust streaks in the upper-left for cool-tone balance. Soft crepuscular rays of warm light bleeding through the nebula. The lower-centre and lower-third is a dark quiet void — deep black sky for gameplay legibility on top. Cinematic, mythic, sacred, awe-inspiring, painterly. No text, no graphics, no UI elements, no spaceships, no asteroids, no characters, no figures, no logos, no planets in the foreground. Aspect 1536x1024.`,
};

/** Photoreal close-up surface textures used as the per-type filler-
 *  asteroid fills on the 600bn Sanctum wave AND as 3D-mesh diffuse
 *  maps in the WebGL overlay. Square 1024×1024 so they tile cleanly
 *  inside the lumpy asteroid polygons / wrap onto the icosphere mesh.
 *  Each prompt instructs the model to FILL the frame with surface
 *  texture so the clip never cuts into empty background. */
const ASTEROID_PROMPTS: NamedPrompt[] = [
  {
    name: 'asteroid-stony',
    prompt: `Ultra-high resolution photorealistic close-up macro of a stony asteroid surface, NASA Hayabusa / Mars-rover quality. Brown-grey rocky regolith covered in dozens of tiny craters and pock-marks, dusty weathered surface, scattered small embedded rocks and pebbles, dramatic side-lighting from upper-left casting long shadows across the craters and revealing deep grey shadows with warm tan highlights on the lit faces. Photoreal scientific imaging — no stylisation. Square 1024×1024 frame. The entire frame is the asteroid surface filling edge to edge — NO edges of the asteroid visible, NO sky, NO black background, NO text, NO graphics, NO UI, NO logos. Pure cratered rocky surface texture filling the entire square.`,
  },
  {
    name: 'asteroid-iron',
    prompt: `Ultra-high resolution photorealistic close-up of a polished iron-nickel meteorite cross-section — a Widmanstätten pattern revealed by acid-etching, with the characteristic interlocking geometric crystal lattice of slowly-cooled iron meteorites clearly visible. Dark metallic grey base with subtle bronze and copper tones, the cross-hatched kamacite-taenite plates running diagonally across the frame, polished mirror-like metal surface with faint reflections, dramatic side-lighting from upper-left bringing out the etched crystal pattern. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the iron meteorite surface — NO edges visible, NO sky, NO background, NO text, NO graphics, NO logos. Pure metallic Widmanstätten texture filling the entire square.`,
  },
  {
    name: 'asteroid-chondrite',
    prompt: `Ultra-high resolution photorealistic close-up macro of a chondrite meteorite cut-and-polished surface. Dozens of round embedded chondrules — small spherical mineral grains 1-3mm across — in mixed warm colours: amber, golden yellow, deep brown, dark red, beige, rust-orange, embedded in a darker fine-grained matrix. Primitive meteoritic texture, classic ordinary chondrite appearance, polished surface with the chondrules slightly raised. Dramatic side-lighting from upper-left bringing out the spherical 3D form of each chondrule with tiny shadows. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the chondrite cross-section — NO edges visible, NO sky, NO background, NO text, NO logos. Pure chondritic texture filling the entire square.`,
  },
  {
    name: 'asteroid-pallasite',
    prompt: `Ultra-high resolution photorealistic close-up macro of a pallasite meteorite cut-and-polished cross-section — the iconic stony-iron type. Brilliant green-gold olivine crystals (gem-grade peridot) embedded in a dark metallic iron-nickel matrix that gleams between the gems. The peridot crystals are 5-15mm across, translucent yellow-green, refractive, catching the light with bright internal reflections and glowing edges where the light passes through. The iron matrix is dark steel grey with faint Widmanstätten etching visible. Polished mirror-like surface. Dramatic side-lighting from upper-left making the gems sparkle and pop. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the pallasite cross-section — NO edges visible, NO sky, NO background, NO text, NO logos. Pure gem-and-metal texture filling the entire square.`,
  },
  {
    name: 'asteroid-carbonaceous',
    prompt: `Ultra-high resolution photorealistic close-up macro of a carbonaceous chondrite meteorite — primitive CI/CM-group material, the darkest meteorite type known. Sooty matte black surface with a barely-visible matrix of microscopic chondrules and refractory inclusions, slightly purplish-grey undertones from carbon-rich phyllosilicates and trace organics. Tiny pale grey CAI (calcium-aluminium inclusion) flecks scattered sparingly, like dim stars. Some patches show faint hairline cracks from desiccation. Surface is dusty, light-absorbing, almost charcoal-like, with a hint of soft sheen on the higher facets. Dramatic side-lighting from upper-left bringing out the subtle texture without flattening the deep blacks. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the carbonaceous surface — NO edges visible, NO sky, NO background, NO text, NO logos. Pure dark primitive texture filling the entire square.`,
  },
  {
    name: 'asteroid-mesosiderite',
    prompt: `Ultra-high resolution photorealistic close-up macro of a mesosiderite meteorite cut-and-polished cross-section — the rare stony-iron mix. Roughly half polished iron-nickel metal (bright steel grey with faint Widmanstätten etching) interlocked with half basaltic silicate inclusions in warm bronze and pale ochre. The two phases interlock like puzzle pieces with sharp boundaries — patches of mirror-bright metal next to angular bronzy stone. Mottled patchwork appearance. Dramatic side-lighting from upper-left making the metal flash and the stone read as warm bronze. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the mesosiderite cross-section — NO edges visible, NO sky, NO background, NO text, NO logos. Pure mottled stony-iron texture filling the entire square.`,
  },
  {
    name: 'asteroid-achondrite',
    prompt: `Ultra-high resolution photorealistic close-up macro of an achondrite meteorite — basaltic HED group (eucrite/howardite/diogenite), from the asteroid Vesta. Crystalline basalt surface with visible pyroxene and plagioclase crystals 1-4mm across in interlocking igneous texture, deep volcanic red and warm rust orange with darker iron-grey crystal grains, occasional brecciated patches showing fragmented angular clasts. Slight glassy fusion-crust patches with subtle sheen where the rock has been heated. Dramatic side-lighting from upper-left bringing out the angular crystal facets and tiny shadow lines between grains. Scientific macro photography quality. Square 1024×1024 frame. The entire frame is the achondrite surface — NO edges visible, NO sky, NO background, NO text, NO logos. Pure volcanic basalt texture filling the entire square.`,
  },
];

mkdirSync(OUT_DIR, { recursive: true });

async function generateOne(wp: WavePrompt): Promise<void> {
  const target = join(OUT_DIR, `wave-${wp.wave}.png`);
  if (!force && existsSync(target)) {
    console.log(`  wave-${wp.wave}.png exists, skipping (use --force to regenerate)`);
    return;
  }

  process.stdout.write(`  generating wave-${wp.wave} … `);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      prompt: wp.prompt,
      n: 1,
      size: SIZE,
      quality: QUALITY,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log(`✗ ${res.status}`);
    console.error(`     ${errText.slice(0, 400)}`);
    return;
  }

  const json = (await res.json()) as {
    model?: string;
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const item = json.data?.[0];
  if (!item) {
    console.log('✗ empty response');
    return;
  }

  let bytes: Uint8Array;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      console.log(`✗ download failed: ${imgRes.status}`);
      return;
    }
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    console.log('✗ no b64_json or url in response');
    return;
  }

  writeFileSync(target, bytes);
  const kb = (bytes.length / 1024).toFixed(1);
  const modelTag = json.model ? ` [model=${json.model}]` : '';
  console.log(`✓ ${kb} KB${modelTag}`);
  if (item.revised_prompt && process.env.VERBOSE) {
    console.log(`     revised: ${item.revised_prompt.slice(0, 200)}…`);
  }
}

async function generateNamed(np: NamedPrompt, size: string = SIZE): Promise<void> {
  const target = join(OUT_DIR, `${np.name}.png`);
  if (!force && existsSync(target)) {
    console.log(`  ${np.name}.png exists, skipping (use --force to regenerate)`);
    return;
  }

  process.stdout.write(`  generating ${np.name} (${size}) … `);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      prompt: np.prompt,
      n: 1,
      size,
      quality: QUALITY,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.log(`✗ ${res.status}`);
    console.error(`     ${errText.slice(0, 400)}`);
    return;
  }

  const json = (await res.json()) as {
    model?: string;
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  };
  const item = json.data?.[0];
  if (!item) {
    console.log('✗ empty response');
    return;
  }

  let bytes: Uint8Array;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) {
      console.log(`✗ download failed: ${imgRes.status}`);
      return;
    }
    bytes = new Uint8Array(await imgRes.arrayBuffer());
  } else {
    console.log('✗ no b64_json or url in response');
    return;
  }

  writeFileSync(target, bytes);
  const kb = (bytes.length / 1024).toFixed(1);
  const modelTag = json.model ? ` [model=${json.model}]` : '';
  console.log(`✓ ${kb} KB${modelTag}`);
  if (item.revised_prompt && process.env.VERBOSE) {
    console.log(`     revised: ${item.revised_prompt.slice(0, 200)}…`);
  }
}

async function main(): Promise<void> {
  // --sanctum is exclusive with --wave / no-flag (which iterate the
  // wave roster). When set, only the named Sanctum target generates.
  if (onlyAsteroids) {
    console.log(`Generating ${ASTEROID_PROMPTS.length} asteroid-surface textures via ${MODEL} (${ASTEROID_SIZE}, quality=${QUALITY})…`);
    console.log(`Output dir: ${OUT_DIR}`);
    console.log('');
    for (const np of ASTEROID_PROMPTS) {
      await generateNamed(np, ASTEROID_SIZE);
    }
    console.log('');
    console.log('Done. Run `npm run optimise-backgrounds` to refresh the runtime WebPs.');
    return;
  }

  if (onlySanctum) {
    console.log(`Generating 2 named backgrounds (sanctum, sanctum-space) via ${MODEL} (${SIZE}, quality=${QUALITY})…`);
    console.log(`Output dir: ${OUT_DIR}`);
    console.log('');
    await generateNamed(SANCTUM_PROMPT);
    await generateNamed(SANCTUM_SPACE_PROMPT);
    console.log('');
    console.log('Done. Run `npm run optimise-backgrounds` to refresh the runtime WebPs.');
    return;
  }

  const targets = onlyWave !== null ? WAVES.filter(w => w.wave === onlyWave) : WAVES;
  if (targets.length === 0) {
    console.error(`No wave matches --wave ${onlyWave}`);
    process.exit(1);
  }

  console.log(`Generating ${targets.length} background${targets.length === 1 ? '' : 's'} via ${MODEL} (${SIZE}, quality=${QUALITY})…`);
  console.log(`Output dir: ${OUT_DIR}`);
  console.log('');

  for (const wp of targets) {
    await generateOne(wp);
  }

  console.log('');
  console.log('Done. Run `npm run optimise-backgrounds` to refresh the runtime WebPs.');
}

void main();
