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

/** True on a booth/kiosk surface (?p1/?p2). A kiosk pins its experience to the
 *  URL — an explicit ?flavour= or the hostname — and IGNORES the sticky
 *  localStorage override, so a booth that once loaded the 600bn teaser can't
 *  stay stuck on it (dramatic parallax, non-shootable decorative rocks) on
 *  pallasite.app forever. URL is the source of truth for a kiosk. */
export function boothKioskActive(): boolean {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.has('p1') || q.has('p2');
  } catch { return false; }
}

let cached: Flavour | null = null;

export function getFlavour(): Flavour {
  if (cached !== null) return cached;
  cached = boothKioskActive()
    ? (readQuery() ?? fromHostname())               // booth: skip the sticky localStorage override
    : (readQuery() ?? readOverride() ?? fromHostname());
  return cached;
}

export function isFlavour(f: Flavour): boolean {
  return getFlavour() === f;
}
