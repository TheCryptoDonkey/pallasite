/**
 * Stage everything electron-builder needs into desktop/resources/ and
 * desktop/build/, pulling from the repo's existing build output.
 *
 *   resources/dist           ← ../dist            (run `pnpm build` first)
 *   resources/controller-ws  ← ../controller-ws   (server.js + package.json + node_modules)
 *   build/icon.png           ← ../dist/icon-512.png
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVariant } from '../variants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(__dirname, '..');
const repo = path.join(desktop, '..');

// Which build variant: booth (default) or public. Baked into the package so the
// distributed app knows its window/boot/broker policy with no env needed.
const variant = resolveVariant(process.env.PALLASITE_VARIANT || 'booth');

const distSrc = path.join(repo, 'dist');
const brokerSrc = path.join(repo, 'controller-ws');
const resources = path.join(desktop, 'resources');
const build = path.join(desktop, 'build');

if (!existsSync(path.join(distSrc, 'index.html'))) {
  console.error('\n[prepare] ../dist/index.html missing — run `pnpm build` at the repo root first.\n');
  process.exit(1);
}
if (!existsSync(path.join(brokerSrc, 'node_modules', 'ws'))) {
  console.error('\n[prepare] ../controller-ws/node_modules/ws missing — run `npm ci` (or `pnpm i`) in controller-ws first.\n');
  process.exit(1);
}

// Fresh staging dir each run.
rmSync(resources, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(build, { recursive: true });

// Game build.
cpSync(distSrc, path.join(resources, 'dist'), { recursive: true });

// Broker: source + prod deps only (ws is the sole runtime dep, pure JS).
const brokerDst = path.join(resources, 'controller-ws');
mkdirSync(brokerDst, { recursive: true });
cpSync(path.join(brokerSrc, 'server.js'), path.join(brokerDst, 'server.js'));
cpSync(path.join(brokerSrc, 'package.json'), path.join(brokerDst, 'package.json'));

// Copy each runtime dependency as REAL files. pnpm symlinks packages into its
// .pnpm store; cpSync (even with dereference:true) preserves a host-absolute
// symlink that breaks on the target machine — the broker then dies with
// ERR_MODULE_NOT_FOUND 'ws'. realpathSync resolves the link to the actual dir,
// which we copy verbatim. (ws is the broker's only runtime dep and has none of
// its own, so a per-package copy is complete; revisit if that changes.)
const srcModules = path.join(brokerSrc, 'node_modules');
const dstModules = path.join(brokerDst, 'node_modules');
mkdirSync(dstModules, { recursive: true });
for (const entry of readdirSync(srcModules)) {
  if (entry.startsWith('.')) continue; // skip .pnpm, .modules.yaml
  const real = realpathSync(path.join(srcModules, entry));
  cpSync(real, path.join(dstModules, entry), { recursive: true });
  if (lstatSync(path.join(dstModules, entry)).isSymbolicLink()) {
    throw new Error(`[prepare] ${entry} staged as a symlink — would break on the target`);
  }
}

// Linux icon (electron-builder wants a >=512px png in buildResources).
cpSync(path.join(distSrc, 'icon-512.png'), path.join(build, 'icon.png'));

// Bake the variant config so main.js reads it at runtime (env still overrides).
writeFileSync(path.join(resources, 'app-config.json'), JSON.stringify(variant, null, 2) + '\n');

console.log(`[prepare] staged resources/ + build/icon.png (variant=${variant.variant})`);
