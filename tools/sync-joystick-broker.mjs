#!/usr/bin/env node
/**
 * controller-ws/ is a vendored snapshot of forgesworn/joystick packages/broker,
 * the broker that runs controller.pallasite.app. Local e2e/soak scripts and the
 * desktop booth build run it, so it must stay byte-identical to a joystick commit.
 *
 *   node tools/sync-joystick-broker.mjs sync  [--joystick ../joystick] [--ref origin/main]
 *   node tools/sync-joystick-broker.mjs check [--joystick ../joystick]
 *
 * sync   copies the broker files at --ref and rewrites controller-ws/provenance.json.
 * check  fails if a vendored file no longer matches its recorded hash (hand edit).
 *        With --joystick it also reports whether joystick origin/main has moved on.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = join(repo, 'controller-ws');
const FILES = [
  'server.js', 'controller-policy.js', 'foregather.js', 'probe-peer.js', 'package.json', 'package-lock.json',
  'README.md', 'Caddyfile.snippet', 'pallasite-controller-ws.service',
];
const REMOVED = ['pnpm-lock.yaml']; // pre-vendoring lockfile; joystick uses npm
const [command = 'check', ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const provenancePath = join(dir, 'provenance.json');

if (command === 'sync') {
  const joystick = resolve(flag('joystick', join(repo, '../joystick')));
  const ref = flag('ref', 'origin/main');
  const commit = git(joystick, 'rev-parse', `${ref}^{commit}`).toString().trim();
  const files = {};
  for (const name of FILES) {
    const bytes = git(joystick, 'show', `${commit}:packages/broker/${name}`);
    writeFileSync(join(dir, name), bytes); files[name] = sha(bytes);
  }
  for (const name of REMOVED) rmSync(join(dir, name), { force: true });
  writeFileSync(provenancePath, JSON.stringify({ sourceRepository: 'forgesworn/joystick', sourcePath: 'packages/broker', sourceCommit: commit, files }, null, 2) + '\n');
  console.log(`controller-ws synced from joystick ${commit.slice(0, 7)}`);
} else if (command === 'check') {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const bad = Object.entries(provenance.files).filter(([name, hash]) => !existsSync(join(dir, name)) || sha(readFileSync(join(dir, name))) !== hash).map(([name]) => name);
  if (bad.length) { console.error(`controller-ws has drifted from joystick ${provenance.sourceCommit.slice(0, 7)}: ${bad.join(', ')}\nRe-run: node tools/sync-joystick-broker.mjs sync`); process.exit(1); }
  console.log(`controller-ws matches joystick ${provenance.sourceCommit.slice(0, 7)}`);
  const joystick = flag('joystick');
  if (joystick) {
    const latest = git(resolve(joystick), 'rev-parse', 'origin/main').toString().trim();
    const changed = git(resolve(joystick), 'diff', '--name-only', provenance.sourceCommit, latest, '--', 'packages/broker').toString().trim();
    if (changed) { console.error(`joystick origin/main (${latest.slice(0, 7)}) has newer broker changes:\n${changed}`); process.exit(2); }
    console.log('joystick has no newer broker changes');
  }
} else { console.error('usage: sync-joystick-broker.mjs sync|check [--joystick path] [--ref ref]'); process.exit(64); }
