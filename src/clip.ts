/**
 * Canvas → video clip + share.
 *
 * Uses canvas.captureStream() + MediaRecorder to grab a short clip while
 * the death replay plays back, then hands the resulting Blob to the
 * system share sheet. Falls back to a download when the share API isn't
 * available or doesn't support files.
 *
 * Browser support: MediaRecorder is on iOS Safari from 14.5; mp4 vs
 * webm output depends on what the engine supports — pickMimeType
 * picks the first working option.
 */

const FPS = 30;

/** Returns the first MIME type from `candidates` that the browser
 *  reports as recordable, or null when none of them work. */
function pickMimeType(candidates: readonly string[]): string | null {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
  for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
  return null;
}

const VIDEO_CANDIDATES = [
  // Safari (iOS 14.5+) prefers mp4
  'video/mp4;codecs=avc1',
  'video/mp4',
  // Chromium / Firefox
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export interface CapturedClip {
  blob: Blob;
  mime: string;
  ext: 'mp4' | 'webm';
}

/** Returns true on platforms where the death-clip share will work — used
 *  by the UI to gate the SHARE CLIP button so we don't show it on
 *  browsers that can't record at all. */
export function canCaptureClip(): boolean {
  return pickMimeType(VIDEO_CANDIDATES) !== null
      && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

/**
 * Capture `durationMs` of frames from the given canvas. Resolves with the
 * encoded video Blob once recording stops. The caller is responsible for
 * making the canvas display interesting frames during the window — for
 * the death-clip path we trigger startDeathReplay() at the same time.
 */
export function captureClip(canvas: HTMLCanvasElement, durationMs: number): Promise<CapturedClip | null> {
  return new Promise((resolve) => {
    const mime = pickMimeType(VIDEO_CANDIDATES);
    if (!mime) { resolve(null); return; }
    let stream: MediaStream;
    try {
      stream = canvas.captureStream(FPS);
    } catch {
      resolve(null); return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch {
      resolve(null); return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
      const blob = new Blob(chunks, { type: mime });
      const ext: 'mp4' | 'webm' = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      resolve({ blob, mime, ext });
    };
    try {
      recorder.start();
    } catch {
      resolve(null); return;
    }
    window.setTimeout(() => {
      try { recorder.stop(); } catch { /* ignore */ }
    }, durationMs);
  });
}

export interface ShareClipOptions {
  filenameStem: string;
  text?: string;
  title?: string;
}

/**
 * Share a captured clip via the Web Share API. Falls back to a direct
 * download when the API isn't available or doesn't support files.
 * Returns 'shared' / 'downloaded' / 'failed' so the UI can react.
 */
export async function shareClip(clip: CapturedClip, opts: ShareClipOptions): Promise<'shared' | 'downloaded' | 'failed'> {
  const file = new File([clip.blob], `${opts.filenameStem}.${clip.ext}`, { type: clip.mime });
  // navigator.canShare with files is the right preflight on iOS — without
  // this, Safari throws on share() for unsupported file types instead of
  // gracefully reporting.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function'
      && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: opts.text, title: opts.title });
      return 'shared';
    } catch {
      // User cancelled or share rejected. Fall through to download.
    }
  }
  // Download fallback.
  try {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch { /* ignore */ }
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }, 500);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}
