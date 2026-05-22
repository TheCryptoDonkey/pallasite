/**
 * Radar (minimap) settings.
 *
 * Visibility:
 *   The radar is shown by the portrait follow camera by default (vertical
 *   world slice → whole-field awareness via the panel). The "force on in
 *   landscape" toggle (new) is groundwork for a future landscape bonus
 *   wave where the playfield extends beyond the visible viewport and the
 *   radar regains its purpose. Default off for landscape; opting in is
 *   per-device.
 *
 * Tilt:
 *   The panel can be drawn flat ('off'), with a subtle trapezoid warp
 *   ('subtle') or with a stronger arcade-cabinet sloped-console look
 *   ('cabinet'). Defaults to 'cabinet' — matches the current render-side
 *   default. Settings overlay surfaces the three options.
 */

const VISIBLE_KEY = 'pallasite:radar';
const LANDSCAPE_KEY = 'pallasite:radar-landscape';
const TILT_KEY = 'pallasite:radar-tilt';

export type RadarTilt = 'off' | 'subtle' | 'cabinet';

let visibleCached: boolean | null = null;
let landscapeCached: boolean | null = null;
let tiltCached: RadarTilt | null = null;

export function getRadarVisible(): boolean {
  if (visibleCached !== null) return visibleCached;
  try {
    const raw = localStorage.getItem(VISIBLE_KEY);
    visibleCached = raw === null ? true : raw === '1';
  } catch {
    visibleCached = true;
  }
  return visibleCached;
}

export function setRadarVisible(on: boolean): void {
  visibleCached = on;
  try { localStorage.setItem(VISIBLE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/** Whether the radar should also render in landscape mode. Foundation for
 *  a future landscape bonus wave. Off by default — today the radar adds
 *  no info to the standard landscape playfield. */
export function getRadarLandscape(): boolean {
  if (landscapeCached !== null) return landscapeCached;
  try {
    const raw = localStorage.getItem(LANDSCAPE_KEY);
    landscapeCached = raw === '1';
  } catch {
    landscapeCached = false;
  }
  return landscapeCached;
}

export function setRadarLandscape(on: boolean): void {
  landscapeCached = on;
  try { localStorage.setItem(LANDSCAPE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/** Tilt intensity of the radar's trapezoid composite. 'off' draws flat;
 *  'subtle' uses 96% top-edge width; 'cabinet' uses 92% (the original
 *  render-side default). */
export function getRadarTilt(): RadarTilt {
  if (tiltCached !== null) return tiltCached;
  try {
    const raw = localStorage.getItem(TILT_KEY);
    tiltCached = (raw === 'off' || raw === 'subtle' || raw === 'cabinet') ? raw : 'cabinet';
  } catch {
    tiltCached = 'cabinet';
  }
  return tiltCached;
}

export function setRadarTilt(t: RadarTilt): void {
  tiltCached = t;
  try { localStorage.setItem(TILT_KEY, t); } catch { /* ignore */ }
}
