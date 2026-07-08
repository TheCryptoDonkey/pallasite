import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const siblingBundle = resolve(root, '../signet-login/dist/signet-login.iife.js');
const targetBundle = resolve(root, 'public/signet-login.iife.js');
const allowLocalSync = /^(1|true|yes)$/i.test(process.env.SIGNET_LOGIN_SYNC_LOCAL ?? '');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

if (!existsSync(siblingBundle)) {
  console.log('sync-sdk: signet-login sibling not present, using committed copy');
  process.exit(0);
}

if (!allowLocalSync) {
  const relation = existsSync(targetBundle) && sha256(siblingBundle) === sha256(targetBundle)
    ? 'matches'
    : 'differs from';
  console.log(`sync-sdk: local signet-login sibling ${relation} committed copy; not auto-copying without SIGNET_LOGIN_SYNC_LOCAL=1`);
  process.exit(0);
}

copyFileSync(siblingBundle, targetBundle);
console.log('sync-sdk: copied ../signet-login/dist/signet-login.iife.js to public/signet-login.iife.js');
