/**
 * Deploy flavour — which themed Pallasite this is.
 *
 *   - main:  full Pallasite at pallasite.app (and any other host)
 *   - 600bn: single-level Sanctum teaser at 600b.pallasite.app, cross-promo
 *            with the 600bn collective's Prague party on June 11
 *
 * Detection is runtime, not build-time: one dist/ bundle ships everywhere,
 * nginx routes the two hostnames at the same files, and getFlavour() picks
 * the right experience from the hostname. The Sanctum module is lazy-imported
 * so the main game never downloads 600bn assets.
 *
 * Order of precedence (highest wins):
 *   1. ?flavour=<f> query param (dev override; also sticks to localStorage)
 *   2. localStorage override (set by a previous query param)
 *   3. hostname match (600b. / 600bn. / 600. subdomain → 600bn)
 *   4. fallback: 'main'
 */

export type Flavour = 'main' | '600bn';

const STORAGE_KEY = 'pallasite:flavour-override';

function readOverride(): Flavour | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'main' || v === '600bn') return v;
  } catch { /* ignore */ }
  return null;
}

function readQuery(): Flavour | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('flavour');
    if (v === 'main' || v === '600bn') {
      try { localStorage.setItem(STORAGE_KEY, v); } catch { /* ignore */ }
      return v;
    }
    if (v === 'clear') {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

function fromHostname(): Flavour {
  try {
    const h = window.location.hostname.toLowerCase();
    if (h.startsWith('600b.') || h.startsWith('600bn.') || h.startsWith('600.')) return '600bn';
  } catch { /* ignore */ }
  return 'main';
}

let cached: Flavour | null = null;

export function getFlavour(): Flavour {
  if (cached !== null) return cached;
  cached = readQuery() ?? readOverride() ?? fromHostname();
  return cached;
}

export function isFlavour(f: Flavour): boolean {
  return getFlavour() === f;
}
