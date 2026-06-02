/**
 * Pallasite — entry point.
 *
 * Sets up the canvas, runs the game loop, wires keyboard input, restores any
 * stored Signet session, and routes between title/playing/paused/game-over.
 */

import { makeInitialState, startGame, updateGame, pauseGame, resumeGame, tryHyperspace, tryActivateShield, cheatJumpToWave, cheatJumpToBonus, skipDeathReplay, skipWaveStart, skipWarp, toastNow, FIXED_STEP_S } from './game.js';
import { getFlavour } from './flavour.js';
import { lockInDifficulty, getStoredDifficulty, setStoredDifficulty } from './difficulty.js';
import { setDailySeed, todayUTC, getStoredDailyPref, getActiveSeed } from './seed.js';
import { render, preloadCriticalCampaignAssets, setRenderMode, getRenderModeKind, drawAsciiHud, type CriticalAssetReport } from './render.js';
import { bindActions, renderTitle, renderAttract, renderPause, renderGameOver, renderCompletion, renderToast, clearOverlay, showUpdateBanner, gateBehindOnboarding, renderAdminPanel, renderAdminV2Panel, renderJuryPage, renderWatchPage, renderControllerPage, renderDuelLobby, renderDuelConnecting, renderEventLobby, simulateStart } from './ui.js';
import { postHeartbeat } from './faucet.js';
import { currentMode, getStoredMode, isStoredDefenderMode, type RunMode } from './mode.js';
import { deathmatchActive } from './deathmatch.js';
import {
  startStreamSession,
  publishStreamFrame,
  captureReplayFrame,
  endStreamSession,
  publishStreamEnded,
  drainStreamEvents,
  beginReplayRun,
  STREAM_FRAME_INTERVAL_MS,
  STREAM_FRAME_INTERVAL_PAUSED_MS,
  type ActiveStreamSession,
} from './stream-session.js';
import { getActiveSkinId } from './skins.js';
import { handleAuthCallback, tryRestore, sweepSignetArtefacts } from './auth.js';
import * as audio from './audio.js';
import { getMusicDebugSnapshot, musicForceRefresh, musicSetTrackForState, preloadAllTracks, musicSetPaused, musicSetMuted, musicResetElements, musicWarmUpAll } from './music.js';
import { stemsTickForState } from './music-stems.js';
import { setupTouchControls } from './touch.js';
import { getDisplayMode, applyDisplayMode } from './display.js';
import { warmWebGLIfPreviouslyEnabled, ensureWebGLForCurrentStyle, prewarmWebGLMeshesForCurrentStyle, getTheme, getAsciiCols, getBitDepth, getBitColour, getVisualStyle, isWebGLOverlayReady, getRenderDprCap, getBrightness, mobileRuntimeActive, recordFrameTime } from './visual-style.js';
import { applyPostFx } from './postfx/index.js';
import { checkForUpdate, querySwVersion } from './version.js';
import { InputLog, samplePlayerInput, encodePlayerInput, decodePlayerInput, applyPlayerInput, localEdges, ensureLocalEdges, EMPTY_INPUT, isPeerActive, setPeerActive } from './netcode.js';
import { hashState, PEER_HASH_PERIOD, serializeForCanary } from './peer-canary.js';
import { SnapshotRing, restoreSim } from './rollback.js';
import { WebSocketPeer, SpectatorPeer, type HumanSlotConfig, type Peer, type PeerSlot } from './peer.js';
import type { DeathmatchRules, GameState } from './types.js';
import { DOWN_DOUBLE_TAP_WINDOW_MS, WORLD_W, WORLD_H } from './types.js';

const PAUSE_DUCK = 0.3;

const canvas = document.getElementById('game') as HTMLCanvasElement;
// WebGL mesh overlay — lazily initialised by visual-style.ts when any
// entity needs mesh rendering. Sized + positioned in lockstep with the
// main canvas via fit() below.
const overlay3d = document.getElementById('game3d') as HTMLCanvasElement | null;
const state: GameState = makeInitialState();

function modeUsesWaveStart(): boolean {
  const mode = currentMode();
  return getFlavour() !== '600bn' && mode !== 'sanctum' && mode !== 'arena' && mode !== 'deathmatch';
}

function boundedPlayerCount(raw: string | null, fallback: number, min = 2, max = 64): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function boundedNumber(raw: string | null, fallback: number, min: number, max: number, integer = false): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  return integer ? Math.floor(clamped) : clamped;
}

let multiplayerUrlSessionSuppressed = false;

function urlCoopCampaignModeActive(): boolean {
  return !multiplayerUrlSessionSuppressed && urlCoopCampaignMode;
}

function urlDeathmatchModeActive(): boolean {
  return !multiplayerUrlSessionSuppressed && urlDeathmatchMode;
}

function requestedDeathmatchPlayers(defaultCount: number): number {
  if (!urlDeathmatchModeActive() && getStoredMode() !== 'deathmatch') return defaultCount;
  const params = new URLSearchParams(window.location.search);
  return boundedPlayerCount(params.get('deathmatchPlayers') ?? params.get('players'), defaultCount, 2, 64);
}

function requestedStartPlayers(): number {
  const peerSessionActive = !multiplayerUrlSessionSuppressed && !!(peer || spectator);
  if (urlCoopCampaignModeActive()) {
    return boundedPlayerCount(mpParams.get('players'), 2, 2, 2);
  }
  if (peerSessionActive && (urlDeathmatchModeActive() || getStoredMode() === 'deathmatch')) {
    return boundedPlayerCount(mpParams.get('deathmatchPlayers') ?? mpParams.get('players'), requestedPeerPlayers, 2, 64);
  }
  return requestedDeathmatchPlayers(peerSessionActive ? requestedPeerPlayers : (couchMode ? 2 : 1));
}

function applyDeathmatchHarnessOptions(): void {
  if (!urlDeathmatchModeActive() && getStoredMode() !== 'deathmatch') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('deathmatchAi') === 'all') {
    for (const p of state.players) p.ai = true;
  }
}

function requestedDeathmatchRules(): Partial<DeathmatchRules> | undefined {
  if (!urlDeathmatchModeActive() && getStoredMode() !== 'deathmatch') return undefined;
  const params = new URLSearchParams(window.location.search);
  const out: Partial<DeathmatchRules> = {};
  const timeSec = boundedNumber(params.get('deathmatchTime') ?? params.get('dmTime'), NaN, 0, 30 * 60, true);
  const killLimit = boundedNumber(params.get('deathmatchKills') ?? params.get('dmKills'), NaN, 0, 250, true);
  const respawns = boundedNumber(params.get('deathmatchRespawns') ?? params.get('dmRespawns'), NaN, 0, 99, true);
  const aiSkill = boundedNumber(params.get('deathmatchAiSkill') ?? params.get('dmAiSkill'), NaN, 0.35, 2.0);
  if (Number.isFinite(timeSec)) out.timeLimitMs = timeSec * 1000;
  if (Number.isFinite(killLimit)) out.killLimit = killLimit;
  if (Number.isFinite(respawns)) out.respawns = respawns;
  if (Number.isFinite(aiSkill)) out.aiSkill = aiSkill;
  return Object.keys(out).length > 0 ? out : undefined;
}

// Test hook: the headless E2E runner reads live sim state (frame, phase,
// players) here without scraping the DOM. Production code never references it.
(window as unknown as { __pallasiteState?: GameState }).__pallasiteState = state;
// In peer mode, p.keys is clobbered by every applyPlayerInput from the
// delayed input log, so it doesn't reflect the live keyboard. localKeys is
// the input-source mirror that the lockstep sample reads from; exposing it
// for the E2E runner so the input-capture check looks at the right field.
const __testHooks = {
  // Filled in below once localKeys is declared.
  localKeysRef: null as Record<string, boolean>[] | null,
  // Filled in once the peer is constructed (duel mode only). Returns the
  // wire trace + cumulative counters captured by WebSocketPeer; null in
  // solo / couch / spectate. Used by tools/run-e2e.ts to dump the wire on
  // failure so we can bisect where input messages go missing.
  peerRef: null as { getWireTrace?: () => unknown[]; getWireCounters?: () => unknown } | null,
};
(window as unknown as { __pallasiteTestHooks?: typeof __testHooks }).__pallasiteTestHooks = __testHooks;
// Render-test hooks: expose just enough internals so tools/run-render-e2e.ts
// can confirm what visual tier is active and whether the WebGL overlay is
// up. These are zero-cost when not called and never referenced in prod.
(window as unknown as { __pallasiteRenderProbe?: () => unknown }).__pallasiteRenderProbe = () => ({
  shipTier: getVisualStyle('ship'),
  asteroidTier: getVisualStyle('asteroid'),
  webglOverlayReady: isWebGLOverlayReady(),
});

let criticalCampaignAssetsReady = false;
let criticalCampaignAssetReport: CriticalAssetReport = { loaded: [], failed: [] };
let criticalCampaignAssetsPromise: Promise<CriticalAssetReport> | null = null;

function warmCriticalCampaignAssets(): Promise<CriticalAssetReport> {
  if (!criticalCampaignAssetsPromise) {
    criticalCampaignAssetsPromise = preloadCriticalCampaignAssets()
      .then((report) => {
        criticalCampaignAssetReport = report;
        criticalCampaignAssetsReady = report.failed.length === 0;
        if (report.failed.length > 0) {
          console.warn('[assets] critical campaign assets failed', report.failed);
        }
        return report;
      })
      .catch((err) => {
        criticalCampaignAssetsReady = false;
        criticalCampaignAssetReport = { loaded: [], failed: ['critical campaign preload threw'] };
        console.warn('[assets] critical campaign preload failed', err);
        return criticalCampaignAssetReport;
      });
  }
  return criticalCampaignAssetsPromise;
}

(window as unknown as { __pallasiteAssetsProbe?: () => unknown }).__pallasiteAssetsProbe = () => ({
  campaignCriticalReady: criticalCampaignAssetsReady,
  campaignCriticalLoaded: criticalCampaignAssetReport.loaded.slice(),
  campaignCriticalFailed: criticalCampaignAssetReport.failed.slice(),
  webglReady: isWebGLOverlayReady(),
});
// E2E hook: surface peerActive so tests can verify the spectator /
// duel handshake is actually engaged before asserting on lockstep
// behaviour. Polled, not pushed, to keep the hot path clean.
Object.defineProperty(window, '__pallasitePeerActive', {
  configurable: true, enumerable: false,
  get: () => isPeerActive(),
});
// Desync-hunter hook: dump the input log around a given frame so the
// hunter can see what each peer actually received via the wire for each
// slot. Reads inputLog (declared further below) lazily so the closure
// captures the live binding rather than the initial null.
(window as unknown as { __pallasiteInputLogProbe?: (from: number, to: number) => unknown }).__pallasiteInputLogProbe = (from: number, to: number) => {
  if (!inputLog) return null;
  const out: Array<[number, number, number]> = [];
  for (let f = from; f <= to; f++) {
    for (let slot = 0; slot < inputLog.players; slot++) {
      out.push([f, slot, inputLog.get(f, slot)]);
    }
  }
  return out;
};

// Wire trace is opt-in (heavyweight ring buffer of every send/receive).
// Set by ?wiretrace=1 in the URL; checked by WebSocketPeer.connect().
const wireTraceEnabled = new URLSearchParams(window.location.search).has('wiretrace');
// Desync hunter — opt-in via ?desync-hunt=1. Allocates a ring of recent
// per-frame serialised states keyed by sim frame so the test runner can
// diff state across all peers and find the first frame where any of them
// disagree. Zero cost when off.
const desyncHuntEnabled = new URLSearchParams(window.location.search).has('desync-hunt');
if (desyncHuntEnabled) {
  (window as unknown as { __pallasiteCanaryHistory?: Map<number, string> }).__pallasiteCanaryHistory = new Map();
}
if (wireTraceEnabled) {
  (window as unknown as { __pallasiteWireTrace?: number }).__pallasiteWireTrace = 1;
}
// Apply trace: parallel arrays recording what the lockstep loop ACTUALLY
// consumed at each apply step, alongside the wall-clock time of the apply.
// Three separate arrays so each entry costs 12 bytes instead of a JS object.
// Capacity 4096 covers 2048 frames × 2 slots = ~34s at 60Hz.
const APPLY_TRACE_CAP = 4096;
const applyTraceReadFrame: Int32Array | null = wireTraceEnabled ? new Int32Array(APPLY_TRACE_CAP) : null;
const applyTraceSlot: Int8Array | null = wireTraceEnabled ? new Int8Array(APPLY_TRACE_CAP) : null;
const applyTraceEncoded: Int32Array | null = wireTraceEnabled ? new Int32Array(APPLY_TRACE_CAP) : null;
const applyTraceTime: Float64Array | null = wireTraceEnabled ? new Float64Array(APPLY_TRACE_CAP) : null;
let applyTraceHead = 0;
let applyTraceCount = 0;
(window as unknown as { __pallasiteApplyTrace?: () => unknown }).__pallasiteApplyTrace = () => {
  if (!applyTraceReadFrame || !applyTraceSlot || !applyTraceEncoded || !applyTraceTime) return [];
  const out: { readFrame: number; slot: number; encoded: number; t: number }[] = [];
  const len = Math.min(applyTraceCount, APPLY_TRACE_CAP);
  // Walk from oldest to newest.
  const start = applyTraceCount > APPLY_TRACE_CAP ? applyTraceHead : 0;
  for (let i = 0; i < len; i++) {
    const idx = (start + i) % APPLY_TRACE_CAP;
    out.push({
      readFrame: applyTraceReadFrame[idx],
      slot: applyTraceSlot[idx],
      encoded: applyTraceEncoded[idx],
      t: applyTraceTime[idx],
    });
  }
  return out;
};

/** True when ?couch=1 is present — enables two-player local co-op. */
const couchMode = new URLSearchParams(window.location.search).has('couch');

// Remote-peer duel mode: `?peer=ws://broker.host/path&session=abc&slot=0|1`.
// Both clients open the same session URL with mirrored slot numbers; the
// broker's peer role mirrors frame / hash messages between them. When set,
// the game forces 2-player mode and the lockstep loop drives slot 1 from
// the peer's input log rather than the local keyboard.
const mpParams = new URLSearchParams(window.location.search);
const urlMode = mpParams.get('mode');
const mpUrl = mpParams.get('peer');
const mpSession = mpParams.get('session');
const urlCoopCampaignMode = urlMode === 'coop-campaign' || urlMode === 'coop';
const requestedPeerPlayers = urlCoopCampaignMode ? 2 : boundedPlayerCount(mpParams.get('players') ?? mpParams.get('deathmatchPlayers'), 2, 2, 64);
const mpSlotRaw = mpParams.get('slot');
const parsedMpSlot = mpSlotRaw === null ? NaN : Number(mpSlotRaw);
const mpSlotValid = Number.isInteger(parsedMpSlot) && parsedMpSlot >= 0 && parsedMpSlot < requestedPeerPlayers;
const mpSlot: PeerSlot = mpSlotValid ? parsedMpSlot : 0;
const mpMode = !!(mpUrl && mpSession && mpSlotValid);
// Spectator mode (M5). `?spectate=<session>&peer=<broker-url>` opens a
// peerwatch socket and runs the lockstep loop in read-only mode with no
// local input sampling. Mutually exclusive with duel mode (mpMode) — if
// both sets of params somehow land, duel wins because it has a local
// slot to play with.
const spectateSession = mpParams.get('spectate');
const spectateMode = !mpMode && !!(spectateSession && mpUrl);
const urlDeathmatchMode = !urlCoopCampaignMode && (urlMode === 'deathmatch' || ((mpMode || spectateMode) && requestedPeerPlayers > 2));
const peerBatchFrames = mpParams.get('peerBatch') !== '0' && mpParams.get('batchFrames') !== '0';
const aiFillDeathmatch = urlDeathmatchMode && mpParams.get('aiFill') === '1';
const autoStartMode = mpParams.get('autoStart') === '1' || mpParams.get('autostart') === '1';
function parseSlotList(raw: string | null, max: number): number[] {
  if (!raw) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const slot = Math.floor(Number(part.trim()));
    if (!Number.isFinite(slot) || slot < 0 || slot >= max || seen.has(slot)) continue;
    seen.add(slot);
    out.push(slot);
  }
  return out.sort((a, b) => a - b);
}
const requestedHumanSlots = parseSlotList(mpParams.get('humanSlots'), requestedPeerPlayers);
/** Defender preview mode (`?defender=1`). Enables the landscape follow
 *  camera + parallax starfield bg + forced radar; first-cut demo of the
 *  600bn Defender bonus wave. No Council protectees or win condition
 *  yet — that's the next phase. */
const defenderMode = mpParams.get('defender') === '1';
/** Duel debug overlay (`?duel-debug=1`). Pins a small monospace panel
 *  with frame counters + drain liveness so on-device diagnosis doesn't
 *  need a dev-tools console. */
const duelDebugMode = mpParams.get('duel-debug') === '1';
/** Derived shared seed for duel + spectate. fnv1a32 of the session string so
 *  every client (peers and watchers) builds the SAME arena from the SAME RNG
 *  without an explicit seed-exchange handshake. */
const sessionSeed = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const mpSeed = mpMode && mpSession ? sessionSeed(mpSession) : undefined;
const spectateSeed = spectateMode && spectateSession ? sessionSeed(spectateSession) : undefined;
/** The remote peer for duel mode. Null in solo, couch, and spectate. */
let peer: Peer | null = null;
/** The spectator transport for watch-mode. Null in solo / couch / duel. */
let spectator: SpectatorPeer | null = null;
/** Input-delay in sim frames when a peer is wired. Co-op must stay close to
 *  solo campaign feel, so it uses only a modest production jitter buffer. The
 *  product all-human deathmatch envelope is 4P; keep that path tight. AI-filled
 *  sessions keep a larger replay/handoff buffer because late human takeovers
 *  must catch up from broker history before existing peers require that slot.
 *  The value must be immutable for a session: late-join replay re-simulates
 *  from frame 0, so changing delay when human slots join would desync. */
function peerInputDelayFrames(players: number, aiFilledSession = false): number {
  const configured = boundedPlayerCount(mpParams.get('inputDelay'), NaN, 0, 60);
  if (Number.isFinite(configured)) return configured;
  if (urlCoopCampaignModeActive()) return 24;
  if (aiFilledSession) return 56;
  if (urlDeathmatchModeActive() && players <= 2) return 30;
  if (urlDeathmatchModeActive() && players <= 4) return 36;
  if (urlDeathmatchModeActive()) return Math.min(56, 44 + Math.ceil(Math.log2(Math.max(2, players))) * 2);
  return Math.min(32, 22 + Math.ceil(Math.log2(Math.max(2, players))) * 2);
}

/** Hard floor for the broker-negotiated delay. The broker sizes the session
 *  delay to the measured link; this stops even a LAN-fast session from dropping
 *  below a one-frame jitter cushion. The static tier (peerInputDelayFrames) is
 *  the ceiling, applied at the read site, so an adaptive session is never worse
 *  than the pre-adaptive default — only the same or snappier. */
const ADAPT_MIN_DELAY_FRAMES = 2;
/** How long to wait after connect for the broker to assign the session's
 *  adaptive input delay before falling back to the static tier. The broker
 *  measures RTT for ~160ms after the roster completes, then broadcasts; every
 *  peer resolves connect at the same all-bound moment and waits together, so an
 *  old/quiet broker is fallen back to consistently by all peers (no split). */
const NEGOTIATED_DELAY_WAIT_MS = 1000;

/** Broker-negotiated lockstep input delay for the live session, frozen before
 *  the sim starts consuming real input. null until negotiated (or when a
 *  ?inputDelay= override / loopback transport bypasses negotiation), in which
 *  case the read site uses the static tier. */
let negotiatedInputDelay: number | null = null;

/** After connect, poll the transport for the broker's assigned session delay
 *  and freeze it. A ?inputDelay= URL override skips negotiation entirely (the
 *  tier already reflects the override). Resolves on the first non-null value or
 *  after NEGOTIATED_DELAY_WAIT_MS (→ static-tier fallback). Must complete
 *  BEFORE setPeerActive(true) so the value is fixed for frame 0. */
async function captureNegotiatedInputDelay(get: () => number | null): Promise<void> {
  if (mpParams.get('inputDelay') !== null) { negotiatedInputDelay = null; return; }
  // AI-filled sessions are not adapted by the broker (their late-takeover
  // handoff is tuned to the static tier), so don't wait — fall straight back.
  if (aiFillDeathmatch) { negotiatedInputDelay = null; return; }
  const deadline = performance.now() + NEGOTIATED_DELAY_WAIT_MS;
  for (;;) {
    const v = get();
    if (v !== null) { negotiatedInputDelay = v; return; }
    if (performance.now() >= deadline) { negotiatedInputDelay = null; return; }
    await new Promise<void>(r => setTimeout(r, 20));
  }
}

function shouldBatchPeerFrames(): boolean {
  if (!peerBatchFrames) return false;
  // 2P remains raw 60Hz for the lowest possible co-op/duel latency. The
  // product deathmatch envelope is 4P, where a two-frame micro-batch cuts
  // fan-out payloads materially while staying inside the existing input
  // jitter buffer.
  return requestedPeerPlayers > 2;
}

/** Consecutive stalled sim frames before the "waiting for OPPONENT" overlay
 *  surfaces. Brief broker jitter should recover invisibly; the overlay is
 *  for sustained missing-input stalls, not sub-second hiccups. */
const PEER_STALL_OVERLAY_FRAMES = 60;
/** Consecutive stalled sim frames before we declare the partner gone and
 *  end the run. ~10s at 60Hz. Generous because chromium's WS dispatch can
 *  briefly stall on an idle worker and the retry-every-rAF backstop needs
 *  a few real-time seconds to refill the gap; tearing down at 2s killed
 *  recoverable duels in production. */
const PEER_STALL_DISCONNECT_FRAMES = 600;
/** When lockstep stalls, resend a bounded window around the exact read frame
 *  the sim is blocked on. Startup joins can miss an early frame while the
 *  other peer is already far ahead, so this must cover more than a tiny tail. */
const PEER_RESEND_BEHIND_FRAMES = 96;
const PEER_RESEND_AHEAD_FRAMES = 8;
/** Cap the bulk resend cadence. Live play sends each frame once; the history
 *  replay only needs to run often enough to backfill a real hole. */
const PEER_RESEND_INTERVAL_MS = 120;
/** Do not replay history for ordinary jitter. WebSockets are ordered and
 *  reliable, so a missing read frame is usually delayed, not lost. */
const PEER_RESEND_AFTER_STALL_FRAMES = 4;
function peerStallOverlayFrames(): number {
  return urlCoopCampaignModeActive() ? 180 : PEER_STALL_OVERLAY_FRAMES;
}

function peerResendAfterStallFrames(): number {
  return urlCoopCampaignModeActive() ? 2 : PEER_RESEND_AFTER_STALL_FRAMES;
}

const PEER_PERF_RING_SIZE = 2048;
interface PeerPerfRing { values: Float64Array; head: number; count: number }
interface PeerPerfSummary {
  samples: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  over16: number;
  over33: number;
  over50: number;
}
const peerPerfRaf: PeerPerfRing = { values: new Float64Array(PEER_PERF_RING_SIZE), head: 0, count: 0 };
const peerPerfSim: PeerPerfRing = { values: new Float64Array(PEER_PERF_RING_SIZE), head: 0, count: 0 };
const peerPerfRender: PeerPerfRing = { values: new Float64Array(PEER_PERF_RING_SIZE), head: 0, count: 0 };
const peerPerfStartedAt = performance.now();
let peerPerfLockstepBlockedTicks = 0;
let peerPerfCatchupTicks = 0;
let peerPerfMaxCatchupBehind = 0;
let peerPerfLongTaskCount = 0;
let peerPerfLongTaskMs = 0;
let peerPerfLongTaskMaxMs = 0;

function shouldRecordPeerPerf(): boolean {
  return mpMode || spectateMode || isPeerActive();
}

function recordPeerPerfSample(ring: PeerPerfRing, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  ring.values[ring.head] = ms;
  ring.head = (ring.head + 1) % PEER_PERF_RING_SIZE;
  ring.count = Math.min(PEER_PERF_RING_SIZE, ring.count + 1);
}

function peerPerfSummary(ring: PeerPerfRing): PeerPerfSummary {
  const values: number[] = [];
  for (let i = 0; i < ring.count; i++) values.push(ring.values[i]);
  values.sort((a, b) => a - b);
  const samples = values.length;
  let total = 0;
  let over16 = 0;
  let over33 = 0;
  let over50 = 0;
  for (const v of values) {
    total += v;
    if (v > 16.7) over16++;
    if (v > 33.4) over33++;
    if (v > 50) over50++;
  }
  const pct = (p: number): number => {
    if (samples === 0) return 0;
    return values[Math.min(samples - 1, Math.max(0, Math.floor((samples - 1) * p)))];
  };
  return {
    samples,
    avg: samples > 0 ? Number((total / samples).toFixed(3)) : 0,
    p50: Number(pct(0.50).toFixed(3)),
    p95: Number(pct(0.95).toFixed(3)),
    p99: Number(pct(0.99).toFixed(3)),
    max: samples > 0 ? Number(values[samples - 1].toFixed(3)) : 0,
    over16,
    over33,
    over50,
  };
}

function browserPerfSnapshot(): unknown {
  const counters = (__testHooks.peerRef && typeof __testHooks.peerRef.getWireCounters === 'function')
    ? __testHooks.peerRef.getWireCounters()
    : null;
  const wsRecv = typeof (counters as { wsRecvFrameCount?: unknown } | null)?.wsRecvFrameCount === 'number'
    ? Number((counters as { wsRecvFrameCount: number }).wsRecvFrameCount)
    : 0;
  const mainRecv = typeof (counters as { recvFrameCount?: unknown } | null)?.recvFrameCount === 'number'
    ? Number((counters as { recvFrameCount: number }).recvFrameCount)
    : 0;
  return {
    frame: state.frame,
    elapsedMs: Number((performance.now() - peerPerfStartedAt).toFixed(1)),
    raf: peerPerfSummary(peerPerfRaf),
    sim: peerPerfSummary(peerPerfSim),
    render: peerPerfSummary(peerPerfRender),
    lockstep: {
      blockedTicks: peerPerfLockstepBlockedTicks,
      catchupTicks: peerPerfCatchupTicks,
      maxCatchupBehind: Math.round(peerPerfMaxCatchupBehind),
      stallFrames: Math.round(peerStallFrames),
      maxStallFrames: Math.round(peerMaxStallFrames),
      stallCount: peerStallCount,
      inputDelay: lastActivePeerInputDelay,
      negotiatedInputDelay,
    },
    rollback: {
      active: rollbackActive,
      windowFrames: ROLLBACK_WINDOW,
      localDelay: ROLLBACK_LOCAL_DELAY,
      rollbacks: rollbackCount,
      avgDepth: rollbackCount > 0 ? Number((rollbackDepthTotal / rollbackCount).toFixed(2)) : 0,
      maxDepth: rollbackMaxDepth,
      resimSteps: rollbackResimSteps,
      predictedCells: predictedCellCount,
      mispredicts: mispredictCount,
      mispredictRate: predictedCellCount > 0 ? Number((mispredictCount / predictedCellCount).toFixed(4)) : 0,
      confirmedFrame: rollbackActive ? currentConfirmedFrame() : -1,
      confirmedLagFrames: rollbackActive ? Math.max(0, state.frame - currentConfirmedFrame()) : 0,
    },
    longTask: {
      count: peerPerfLongTaskCount,
      totalMs: Number(peerPerfLongTaskMs.toFixed(3)),
      maxMs: Number(peerPerfLongTaskMaxMs.toFixed(3)),
    },
    workerMainLagFrames: Math.max(0, wsRecv - mainRecv),
  };
}

(window as unknown as { __pallasiteBrowserPerf?: () => unknown }).__pallasiteBrowserPerf = browserPerfSnapshot;

try {
  const supported = PerformanceObserver.supportedEntryTypes || [];
  if (supported.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      if (!shouldRecordPeerPerf()) return;
      for (const entry of list.getEntries()) {
        peerPerfLongTaskCount++;
        peerPerfLongTaskMs += entry.duration;
        peerPerfLongTaskMaxMs = Math.max(peerPerfLongTaskMaxMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  }
} catch { /* longtask is unavailable in some browsers */ }
/** Extra deterministic handoff room after the broker's late AI-slot takeover
 *  frame. A late human has to replay buffered history from frame 0 before the
 *  existing peers can require their live inputs without stalling. */
const PEER_LATE_TAKEOVER_CLIENT_GRACE_FRAMES = 300;
/** Count of consecutive frames the lockstep loop has been unable to
 *  advance (remote input missing). Reset every time a frame ticks. Only
 *  meaningful while a peer is active. */
let peerStallFrames = 0;
let lastPeerResendAt = -Infinity;
let peerStallCount = 0;
let peerStallActive = false;
let peerMaxStallFrames = 0;
let peerResendCount = 0;
let peerResendFrameCount = 0;
let lastActivePeerInputDelay = 0;
/** Sticky flag: once the partner is declared lost we tear the peer down
 *  and stop trying. Prevents the disconnect path firing every rAF after
 *  game-over. */
let peerDisconnectDeclared = false;
/** Recent locally-computed canary hashes keyed by sim frame. The partner's
 *  hash for the same frame may arrive a few frames later (across the
 *  delay buffer), so we hold a small ring. */
const localCanaryHashes = new Map<number, number>();
/** Sticky frame at which a desync was first observed. Surfaces via
 *  body[data-peer-desync] for any in-HUD indicator the renderer wants
 *  to show; v1 does NOT resync. -1 = never. */
let peerDesyncFrame = -1;

// ── Rollback netcode (Phase 2 Stage B) ───────────────────────────────────────
// Default OFF. When `?rollback=1` and the session qualifies (a real two-human
// peer link, not spectator, not aiFill, no static ?inputDelay=), the local
// player's own input runs at delay 0 (instant ship response) while remote
// inputs are PREDICTED (repeat-last); a misprediction restores a snapshot and
// re-simulates forward. The canary is computed on CONFIRMED frames only so a
// predicted/tentative frame is never compared between peers. When rollback is
// off, every branch below is bypassed and the loop is byte-identical to Phase 1.
const ROLLBACK_REQUESTED = mpParams.get('rollback') === '1';
const ROLLBACK_FORCE_OFF = mpParams.get('rollback') === '0';
/** Local own-ship input delay under rollback (0 = instant; 1 buffers a frame). */
const ROLLBACK_LOCAL_DELAY = mpParams.get('localDelay') === '1' ? 1 : 0;
/** Max frames we predict ahead of the confirmed frontier (and the deepest a
 *  rollback re-sim can reach). Must be < the snapshot ring capacity so the
 *  rollback target is always still resident. */
const ROLLBACK_WINDOW = 14;
const ROLLBACK_RING_CAP = 16;
/** Edge bits (hyperspaceEdge=5, shieldEdge=6) are one-frame rising-edge pulses;
 *  a held prediction must clear them or it would re-fire warp/shield every
 *  predicted frame. */
const ROLLBACK_EDGE_MASK = (1 << 5) | (1 << 6);
/** Resolved once after connect (never per-frame), so the excluded path stays
 *  byte-stable. */
let rollbackActive = false;
let rollbackRing: SnapshotRing | null = null;
/** (frame*players + slot) → the edge-masked encoded value we PREDICTED and
 *  applied for that remote cell, kept until the real input arrives so we can
 *  detect a misprediction. The InputLog itself only ever holds real inputs. */
const predictedInput = new Map<number, number>();
/** Per-slot high-water mark: the highest frame for which this slot has a
 *  contiguous run of REAL inputs in the log. confirmedFrame = min over human
 *  slots. AI slots are excluded (their inputs are synthesised deterministically). */
let confirmedThrough: number[] = [];
/** Canary hashes computed during (re-)simulation at PEER_HASH_PERIOD frames,
 *  held tentatively until the frame is confirmed, then promoted + sent. */
const pendingHashes = new Map<number, number>();
/** Partner hashes that arrived for a frame we have not yet confirmed locally;
 *  re-checked as our confirmed frontier advances (rollback can confirm a frame
 *  slightly after the partner does). */
const pendingPartnerHashes = new Map<number, number>();
let lastPromotedHashFrame = -1;
// Soak/debug stats.
let rollbackCount = 0;
let rollbackDepthTotal = 0;
let rollbackMaxDepth = 0;
let rollbackResimSteps = 0;
let mispredictCount = 0;
let predictedCellCount = 0;
/** Per-slot keyboard mirror that is NOT touched by the lockstep apply pass.
 *  In peer mode the apply pass overwrites `players[i].keys` with the log
 *  entry from N frames ago, which would clobber the live keyboard state and
 *  drop held keys between rare auto-repeat events. The keyboard handler
 *  writes to both `players[mpSlot].keys` (existing contract) and to
 *  `localKeys[mpSlot]`; the lockstep sample reads from `localKeys` so the
 *  user's current input survives every sim tick. Solo and couch pass
 *  `undefined` to samplePlayerInput and read directly off `p.keys`. */
const localKeys: Record<string, boolean>[] = [{}, {}];
__testHooks.localKeysRef = localKeys;
/** Per-slot joystick-state mirror. Same rationale as localKeys: peer
 *  mode's apply step writes p.targetHeading / p.thrustOverride from the
 *  delayed input log every sim tick, clobbering the joystick's live
 *  writes to p. Touch.ts now writes here AND to p; the lockstep sample
 *  reads from here so the joystick's heading + thrust survive the
 *  per-tick apply. Solo / couch leave these at null/false and the
 *  sample falls back to p directly. */
const localHeading: (number | null)[] = [null, null];
const localThrust: boolean[] = [false, false];

function ensureLocalInputSlots(count: number): void {
  ensureLocalEdges(count);
  while (localKeys.length < count) localKeys.push({});
  while (localHeading.length < count) localHeading.push(null);
  while (localThrust.length < count) localThrust.push(false);
}

ensureLocalInputSlots(Math.max(2, requestedPeerPlayers));

// Lockstep input log. Re-created whenever the player count changes so each
// run starts with a clean ring. Sample writes to the current frame; decode
// reads from `frame - inputDelay`, which is the wedge that lets a future
// commit run delay-based lockstep against a remote peer feeding inputs into
// the same log.
let inputLog: InputLog | null = null;
let localPeerPrefilledThrough = -1;
// Input-delay in sim frames. 0 in solo (decode reads the exact frame just
// sampled, byte-identical). Set positive in multiplayer to absorb the relay
// round-trip; both clients use the same value so the lockstep stays fair.
let inputDelay = 0;
void inputDelay;  // exporters / wiring in M2 step 7
// Per-player rising-edge flags live in netcode.localEdges so every input
// source (keyboard here, touch via callback, controller PWA via direct
// import) can raise without a dependency back to main.ts.
const edgeFlags = localEdges;

function exitMultiplayerUrlSession(): void {
  multiplayerUrlSessionSuppressed = true;
  setPeerActive(false);
  try { peer?.disconnect(); } catch { /* socket may already be closed */ }
  peer = null;
  try { spectator?.disconnect(); } catch { /* socket may already be closed */ }
  spectator = null;
  __testHooks.peerRef = null;
  inputLog = null;
  localPeerPrefilledThrough = -1;
  peerStallFrames = 0;
  lastPeerResendAt = -Infinity;
  peerStallCount = 0;
  peerStallActive = false;
  peerMaxStallFrames = 0;
  peerResendCount = 0;
  peerResendFrameCount = 0;
  lastActivePeerInputDelay = 0;
  negotiatedInputDelay = null;
  peerDisconnectDeclared = false;
  peerDesyncFrame = -1;
  localCanaryHashes.clear();
  rollbackActive = false;
  rollbackRing = null;
  confirmedThrough = [];
  predictedInput.clear();
  pendingHashes.clear();
  pendingPartnerHashes.clear();
  lastPromotedHashFrame = -1;
  rollbackCount = 0;
  rollbackDepthTotal = 0;
  rollbackMaxDepth = 0;
  rollbackResimSteps = 0;
  mispredictCount = 0;
  predictedCellCount = 0;
  for (let i = 0; i < localKeys.length; i++) {
    localKeys[i] = {};
    localHeading[i] = null;
    localThrust[i] = false;
    if (edgeFlags[i]) {
      edgeFlags[i].hyperspace = false;
      edgeFlags[i].shield = false;
    }
  }
  if (state.players.length > 1) {
    state.players.splice(1);
  }
  state.deathmatchRules = null;
  state.deathmatchFeed = [];
  delete document.body.dataset.peerStall;
  delete document.body.dataset.peerDesync;
  (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit?.();
}

(window as unknown as { __pallasiteExitMultiplayerSession?: () => void }).__pallasiteExitMultiplayerSession = exitMultiplayerUrlSession;

function currentDeathmatchAiSlots(players: number): number[] | undefined {
  if (!aiFillDeathmatch || !urlDeathmatchModeActive()) return undefined;
  const liveConfig = peer?.getHumanSlotConfig?.() ?? spectator?.getHumanSlotConfig?.();
  const liveHumanSlots = liveConfig?.humanSlots ?? peer?.getHumanSlots?.() ?? spectator?.getHumanSlots?.() ?? [];
  const configuredHumanSlots = liveHumanSlots.length > 0 ? liveHumanSlots : requestedHumanSlots;
  if (configuredHumanSlots.length === 0) return undefined;
  const human = new Set(configuredHumanSlots);
  const takeover = new Map<number, number>();
  for (const t of liveConfig?.takeovers ?? []) takeover.set(t.slot, t.frame);
  const aiSlots: number[] = [];
  for (let i = 0; i < players; i++) {
    const takeoverFrame = takeover.get(i);
    if (!human.has(i) || (takeoverFrame !== undefined && takeoverFrame > 0)) aiSlots.push(i);
  }
  return aiSlots;
}

function currentHumanSlotConfig(): HumanSlotConfig | null {
  if (!aiFillDeathmatch || !urlDeathmatchModeActive()) return null;
  const live = peer?.getHumanSlotConfig?.() ?? spectator?.getHumanSlotConfig?.();
  const humanSlots = live?.humanSlots?.length ? live.humanSlots : requestedHumanSlots;
  if (!humanSlots || humanSlots.length === 0) return null;
  return {
    humanSlots: humanSlots.slice(),
    takeovers: (live?.takeovers ?? []).map(t => ({ slot: t.slot, frame: t.frame })),
  };
}

function localPeerStartupPrefillThrough(activeDelay: number): number {
  if (!urlDeathmatchModeActive()) return -1;
  if (!aiFillDeathmatch) return activeDelay;
  const cfg = currentHumanSlotConfig();
  if (cfg && !cfg.humanSlots.includes(mpSlot)) return -1;
  const takeover = cfg?.takeovers.find(t => t.slot === mpSlot);
  if (!takeover) return activeDelay;
  return takeover.frame + PEER_LATE_TAKEOVER_CLIENT_GRACE_FRAMES + activeDelay;
}

function ensureLocalPeerStartupPrefill(activeDelay: number): void {
  if (!peer || spectator || !inputLog) return;
  const through = localPeerStartupPrefillThrough(activeDelay);
  if (through < 0 || through <= localPeerPrefilledThrough) return;
  const emptyEncoded = encodePlayerInput(EMPTY_INPUT);
  for (let f = Math.max(0, localPeerPrefilledThrough + 1); f <= through; f++) {
    if (inputLog.get(f, mpSlot) >= 0) continue;
    inputLog.record(f, mpSlot, emptyEncoded);
    peer.sendFrame(f, emptyEncoded);
  }
  localPeerPrefilledThrough = through;
}

function syncDeathmatchAiSlotsForFrame(readFrame: number): void {
  if (!deathmatchActive() || state.players.length === 0) return;
  const cfg = currentHumanSlotConfig();
  if (!cfg) return;
  const humans = new Set(cfg.humanSlots);
  const takeovers = new Map<number, number>();
  for (const t of cfg.takeovers) takeovers.set(t.slot, t.frame);
  for (let i = 0; i < state.players.length; i++) {
    const takeoverFrame = takeovers.get(i);
    const effectiveTakeoverFrame = takeoverFrame === undefined ? undefined : takeoverFrame + PEER_LATE_TAKEOVER_CLIENT_GRACE_FRAMES;
    const humanNow = humans.has(i) && (effectiveTakeoverFrame === undefined || readFrame >= effectiveTakeoverFrame);
    state.players[i].ai = !humanNow;
  }
}

function currentStartOptions(): { players: number; defender: boolean; aiOpponents: boolean; runMode?: RunMode; deathmatchRules?: Partial<DeathmatchRules>; aiSlots?: number[] } {
  const players = requestedStartPlayers();
  const peerSessionActive = !multiplayerUrlSessionSuppressed && !!(peer || spectator);
  return {
    players,
    defender: defenderMode,
    aiOpponents: !peerSessionActive,
    runMode: urlDeathmatchModeActive() ? 'deathmatch' : urlCoopCampaignModeActive() ? 'coop-campaign' : peerSessionActive ? 'campaign' : undefined,
    deathmatchRules: requestedDeathmatchRules(),
    aiSlots: currentDeathmatchAiSlots(players),
  };
}

function peerDebugSnapshot(): {
  active: boolean;
  frame: number;
  inputDelay: number;
  stallFrames: number;
  stallCount: number;
  maxStallFrames: number;
  resendCount: number;
  resendFrameCount: number;
  localLatest: number;
  remoteLatest: number;
  localRemoteFrameGap: number | null;
  slotFrameSpread: number | null;
  lastReceivedFrame: number;
} {
  let localLatest = inputLog && peer ? inputLog.latest(mpSlot) : -1;
  let remoteLatest = -1;
  let minLatest = Infinity;
  let maxLatest = -1;
  if (inputLog) {
    for (let i = 0; i < inputLog.players; i++) {
      const latest = inputLog.latest(i);
      if (latest >= 0) {
        minLatest = Math.min(minLatest, latest);
        maxLatest = Math.max(maxLatest, latest);
      }
      if (peer && i !== mpSlot) remoteLatest = Math.max(remoteLatest, latest);
    }
    if (spectator) {
      localLatest = -1;
      remoteLatest = maxLatest;
    }
  }
  const localRemoteFrameGap = localLatest >= 0 && remoteLatest >= 0 ? localLatest - remoteLatest : null;
  const slotFrameSpread = minLatest !== Infinity && maxLatest >= 0 ? maxLatest - minLatest : null;
  return {
    active: isPeerActive(),
    frame: state.frame,
    inputDelay: lastActivePeerInputDelay,
    stallFrames: Math.round(peerStallFrames),
    stallCount: peerStallCount,
    maxStallFrames: Math.round(peerMaxStallFrames),
    resendCount: peerResendCount,
    resendFrameCount: peerResendFrameCount,
    localLatest,
    remoteLatest,
    localRemoteFrameGap,
    slotFrameSpread,
    lastReceivedFrame: peer ? peer.lastReceivedFrame() : spectator ? remoteLatest : -1,
  };
}

(window as unknown as { __pallasitePeerDebug?: () => unknown }).__pallasitePeerDebug = peerDebugSnapshot;

function resendPeerInputRange(fromFrame: number, throughFrame: number, now: number): void {
  if (!peer || !inputLog || throughFrame < 0) return;
  if (now - lastPeerResendAt < PEER_RESEND_INTERVAL_MS) return;
  lastPeerResendAt = now;
  const from = Math.max(0, fromFrame);
  let sent = 0;
  for (let f = from; f <= throughFrame; f++) {
    const encoded = inputLog.get(f, mpSlot);
    if (encoded >= 0) {
      peer.sendFrame(f, encoded);
      sent++;
    }
  }
  if (sent > 0) {
    peerResendCount++;
    peerResendFrameCount += sent;
  }
}

// ── Rollback helpers ─────────────────────────────────────────────────────────

/** Resolve whether rollback runs this session. Called once, right after
 *  setPeerActive(true). Excludes spectator, aiFill (its fragile late-takeover
 *  startup is tuned to the static tier), and any static ?inputDelay= override.
 *  Resolved once and never recomputed so the excluded path stays byte-stable. */
function resolveRollbackActive(): void {
  rollbackActive =
    ROLLBACK_REQUESTED && !ROLLBACK_FORCE_OFF &&
    !!peer && !spectator &&
    !aiFillDeathmatch &&
    mpParams.get('inputDelay') === null;
  rollbackRing = rollbackActive ? new SnapshotRing(ROLLBACK_RING_CAP) : null;
  confirmedThrough = [];
  predictedInput.clear();
  pendingHashes.clear();
  pendingPartnerHashes.clear();
  lastPromotedHashFrame = -1;
}

/** Per-slot read frame under rollback: the local slot reads (nearly) the live
 *  frame for instant response; remote slots read the current sim frame and are
 *  predicted when their real input has not yet arrived. */
function rollbackReadFrame(slot: number): number {
  if (slot === mpSlot) return state.frame - ROLLBACK_LOCAL_DELAY;
  return state.frame;
}

/** Predict a remote slot's absent input: repeat its last known input with the
 *  edge bits cleared (a held prediction must not re-fire warp/shield). */
function predictRemoteInput(slot: number, frame: number): number {
  const empty = (encodePlayerInput(EMPTY_INPUT) & ~ROLLBACK_EDGE_MASK) >>> 0;
  if (!inputLog) return empty;
  const floor = Math.max(0, frame - ROLLBACK_WINDOW - 2);
  for (let f = frame - 1; f >= floor; f--) {
    const enc = inputLog.get(f, slot);
    if (enc >= 0) return (enc & ~ROLLBACK_EDGE_MASK) >>> 0;
  }
  return empty;
}

function predictKey(frame: number, slot: number): number {
  return frame * (inputLog ? inputLog.players : 1) + slot;
}

function markPredicted(frame: number, slot: number, enc: number): void {
  const key = predictKey(frame, slot);
  if (!predictedInput.has(key)) predictedCellCount++;
  predictedInput.set(key, enc);
}

/** Walk a slot's confirmed high-water mark forward over any now-contiguous real
 *  inputs in the log. */
function advanceConfirmed(slot: number): void {
  if (!inputLog || slot >= confirmedThrough.length) return;
  let hw = confirmedThrough[slot];
  while (inputLog.get(hw + 1, slot) >= 0) hw++;
  confirmedThrough[slot] = hw;
}

/** Highest frame for which every human slot has a real input (min over human
 *  slots of confirmedThrough). -1 when any human slot has nothing yet. */
function currentConfirmedFrame(): number {
  let c = Infinity;
  for (let i = 0; i < state.players.length; i++) {
    if (state.players[i].ai) continue;
    if (i >= confirmedThrough.length) return -1;
    c = Math.min(c, confirmedThrough[i]);
  }
  return Number.isFinite(c) ? c : -1;
}

/** Advance the sim one frame under rollback: apply each slot's input (predicting
 *  absent remote inputs), step, snapshot, and tentatively hash on canary
 *  periods. Shared by the live frame and the rollback re-sim so they can never
 *  diverge. Local input is read from the log (already sampled this frame); this
 *  does NOT re-sample. */
function rollbackSimulateStep(appliedSink: number[] | null): void {
  if (!inputLog || !rollbackRing) return;
  for (let i = 0; i < state.players.length; i++) {
    const rf = rollbackReadFrame(i);
    let enc = rf >= 0 ? inputLog.get(rf, i) : -1;
    const remoteHuman = i !== mpSlot && !state.players[i].ai;
    if (enc < 0 && rf >= 0 && remoteHuman) {
      enc = predictRemoteInput(i, rf);
      markPredicted(rf, i, enc);
    } else if (enc >= 0 && remoteHuman) {
      const key = predictKey(rf, i);
      if (predictedInput.has(key)) predictedInput.delete(key);
    }
    if (appliedSink) appliedSink.push(enc);
    if (state.players[i].ai) continue;
    const input = enc >= 0 ? decodePlayerInput(enc) : EMPTY_INPUT;
    applyPlayerInput(state.players[i], input);
    if (state.phase === 'playing') {
      if (input.hyperspaceEdge) tryHyperspace(state, state.elapsed, state.players[i]);
      if (input.shieldEdge) tryActivateShield(state, state.elapsed, state.players[i]);
    }
  }
  updateGame(state);
  rollbackRing.capture(state);
  if (state.frame > 0 && (state.frame % PEER_HASH_PERIOD) === 0) {
    pendingHashes.set(state.frame, hashState(state));
  }
}

/** Restore to the earliest mispredicted frame and re-simulate forward to the
 *  live frontier, re-applying real inputs where present and re-predicting where
 *  still absent. Bounded by the rollback window. */
function rollbackTo(targetFrame: number): void {
  if (!rollbackRing) return;
  const snap = rollbackRing.get(targetFrame);
  if (!snap) {
    // Should not happen: the window bound keeps the target resident. Accept the
    // current state rather than corrupt it; the canary flags any divergence.
    // eslint-disable-next-line no-console
    console.warn(`[rollback] snapshot for frame ${targetFrame} evicted; skipping`);
    return;
  }
  const frontier = state.frame;
  restoreSim(state, snap);   // state.frame === targetFrame
  let depth = 0;
  while (state.frame < frontier && depth <= ROLLBACK_WINDOW + 2) {
    rollbackSimulateStep(null);
    depth++;
  }
  rollbackCount++;
  rollbackResimSteps += depth;
  const reached = frontier - targetFrame;
  rollbackDepthTotal += reached;
  if (reached > rollbackMaxDepth) rollbackMaxDepth = reached;
}

/** Promote tentative canary hashes for newly-confirmed periods: send them to the
 *  partner and store locally for the compare. Once a frame is confirmed its hash
 *  is final (no later rollback can reach it). */
function promoteConfirmedHashes(): void {
  if (!peer) return;
  const cf = currentConfirmedFrame();
  for (let f = lastPromotedHashFrame + 1; f <= cf; f++) {
    if (f > 0 && (f % PEER_HASH_PERIOD) === 0) {
      const h = pendingHashes.get(f);
      if (h !== undefined) {
        localCanaryHashes.set(f, h);
        peer.sendHash(f, h);
        pendingHashes.delete(f);
      }
    }
  }
  if (cf > lastPromotedHashFrame) lastPromotedHashFrame = cf;
}

/** Timestamp of the most recent ArrowDown keydown — used for double-tap detection. */
let lastDownArrowAt = 0;

// ── Wave-jump cheat input mode ───────────────────────────────────────────────

let cheatInputOpen = false;
let cheatInputBuffer = '';
let cheatInputEl: HTMLDivElement | null = null;
let cheatInputIdleTimer: number | null = null;

function openCheatInput(): void {
  if (cheatInputOpen) return;
  cheatInputOpen = true;
  cheatInputBuffer = '';
  cheatInputEl = document.createElement('div');
  cheatInputEl.style.cssText = [
    'position:fixed', 'top:80px', 'left:50%', 'transform:translateX(-50%)',
    'z-index:100', 'background:rgba(0,0,0,0.92)',
    'border:2px solid #ffd84a', 'border-radius:10px',
    'padding:14px 18px',
    "font-family:'VT323',ui-monospace,monospace", 'font-size:1.4rem',
    'color:#ffd84a', 'letter-spacing:0.2em',
    'text-shadow:0 0 8px rgba(255,216,74,0.6)',
    'pointer-events:auto',
    'user-select:none', '-webkit-user-select:none',
    'min-width:220px', 'text-align:center',
  ].join(';');
  cheatInputEl.innerHTML = `
    <div>JUMP TO WAVE: <span id="pal-cheat-buf" style="color:#fff;">__</span></div>
    <div id="pal-cheat-pad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:10px 0 6px;">
      <button data-d="1">1</button><button data-d="2">2</button><button data-d="3">3</button>
      <button data-d="4">4</button><button data-d="5">5</button><button data-d="6">6</button>
      <button data-d="7">7</button><button data-d="8">8</button><button data-d="9">9</button>
      <button data-act="del">DEL</button><button data-d="0">0</button><button data-act="ok">▶</button>
    </div>
    <div style="font-size:0.7rem;color:rgba(180,140,255,0.7);letter-spacing:0.08em;">Enter / + warps · Esc cancels</div>
  `;
  const pad = cheatInputEl.querySelector('#pal-cheat-pad') as HTMLDivElement;
  for (const btn of Array.from(pad.querySelectorAll('button'))) {
    const b = btn as HTMLButtonElement;
    b.style.cssText = [
      "font-family:'VT323',ui-monospace,monospace",
      'font-size:1.2rem', 'padding:12px 0',
      'background:rgba(255,216,74,0.08)',
      'border:1px solid rgba(255,216,74,0.5)',
      'color:#ffd84a', 'border-radius:6px',
      'cursor:pointer', 'touch-action:manipulation',
      '-webkit-tap-highlight-color:transparent',
    ].join(';');
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      const d = b.dataset.d;
      const a = b.dataset.act;
      if (d) {
        if (cheatInputBuffer.length < 2) {
          cheatInputBuffer += d;
          refreshCheatBuffer();
          resetCheatIdleTimer();
        }
      } else if (a === 'del') {
        cheatInputBuffer = cheatInputBuffer.slice(0, -1);
        refreshCheatBuffer();
        resetCheatIdleTimer();
      } else if (a === 'ok') {
        closeCheatInput(true);
      }
    });
  }
  document.body.appendChild(cheatInputEl);
  resetCheatIdleTimer();
}

/** WAVE-HUD touch shortcuts.
 *  Long-press (~1.5s) — opens the cheat input box where the player types a
 *  target wave number, same as the `+` key on desktop.
 *  Double-tap (~300ms) — warps straight to the next wave, useful for fast
 *  testing of set pieces / vein rolls without typing. Both flag the run as
 *  cheated and void sat earnings.
 *  Hot zone is the top strip of the canvas (where the WAVE label sits). */
function setupWaveLongPress(): void {
  const HOLD_MS = 1500;
  const DOUBLE_TAP_MS = 320;
  const MOVE_TOL_PX = 14;
  let timer: number | null = null;
  let sx = 0, sy = 0;
  let lastTapAt = 0;
  let didMove = false;

  function inWaveZone(clientX: number, clientY: number): boolean {
    // Hot zone is the top strip of the canvas (where the WAVE label is drawn,
    // anywhere across because cover-scale in portrait shifts the world right
    // off-centre). Long-press requirement guards against accidental taps.
    //
    // Use an absolute pixel band rather than a fraction of canvas height —
    // landscape mobile has a short canvas (~375px on iPhone landscape), and
    // 10% of that is only ~37px, which barely covers the WAVE label. A fixed
    // 110px hot zone is the same physical size in any orientation and always
    // covers the label + a tap-tolerance margin.
    const rect = canvas.getBoundingClientRect();
    const yFromTop = clientY - rect.top;
    return clientX >= rect.left && clientX <= rect.right
        && yFromTop >= 0 && yFromTop <= 110;
  }
  function clear(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  canvas.addEventListener('pointerdown', e => {
    if (state.phase !== 'playing' && state.phase !== 'wavestart') return;
    if (cheatInputOpen) return;
    if (!inWaveZone(e.clientX, e.clientY)) return;
    sx = e.clientX; sy = e.clientY;
    didMove = false;
    clear();
    timer = window.setTimeout(() => {
      timer = null;
      if (getActiveSeed() !== null) {
        state.toast = 'CHEATS LOCKED · DAILY RUN';
        state.toastUntil = state.elapsed + 1800;
        return;
      }
      openCheatInput();
    }, HOLD_MS);
  });
  canvas.addEventListener('pointermove', e => {
    if (timer === null) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_TOL_PX) {
      didMove = true;
      clear();
    }
  });
  canvas.addEventListener('pointerup', e => {
    clear();
    // Double-tap on the wave HUD warps to the next wave (flags the run as
    // cheated, same as the typed cheat). Skip if the tap drifted (treated
    // as a scroll) or the long-press already fired.
    if (didMove) return;
    if (state.phase !== 'playing' && state.phase !== 'wavestart') return;
    if (cheatInputOpen) return;
    if (!inWaveZone(e.clientX, e.clientY)) return;
    const now = performance.now();
    if (now - lastTapAt < DOUBLE_TAP_MS) {
      lastTapAt = 0;
      if (getActiveSeed() !== null) {
        state.toast = 'CHEATS LOCKED · DAILY RUN';
        state.toastUntil = state.elapsed + 1800;
        return;
      }
      cheatJumpToWave(state, state.wave + 1);
    } else {
      lastTapAt = now;
    }
  });
  canvas.addEventListener('pointercancel', clear);
  canvas.addEventListener('pointerleave',  clear);
}

function refreshCheatBuffer(): void {
  if (!cheatInputEl) return;
  const span = cheatInputEl.querySelector('#pal-cheat-buf');
  if (span) span.textContent = cheatInputBuffer.padEnd(2, '_');
}

function resetCheatIdleTimer(): void {
  if (cheatInputIdleTimer !== null) clearTimeout(cheatInputIdleTimer);
  cheatInputIdleTimer = window.setTimeout(() => closeCheatInput(false), 3500);
}

function closeCheatInput(commit: boolean): void {
  if (!cheatInputOpen) return;
  cheatInputOpen = false;
  if (cheatInputIdleTimer !== null) { clearTimeout(cheatInputIdleTimer); cheatInputIdleTimer = null; }
  if (cheatInputEl) { cheatInputEl.remove(); cheatInputEl = null; }
  const buf = cheatInputBuffer;
  cheatInputBuffer = '';
  if (commit) {
    if (buf.startsWith('B')) {
      // 'B' or 'B1' jumps straight to the bonus phase. The trailing
      // digit is reserved for future multi-bonus content; today only
      // one bonus level exists so any digit (or none) maps to it.
      cheatJumpToBonus(state);
    } else if (buf.length > 0) {
      const target = parseInt(buf, 10);
      if (!isNaN(target)) cheatJumpToWave(state, target);
    } else {
      cheatJumpToWave(state, state.wave + 1);  // empty buffer + Enter = next wave
    }
  }
}

function digitFromCode(code: string): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(code);
  return m ? m[1] : null;
}

let startActionInFlight = false;

function shouldWaitForSoloCampaignAssets(): boolean {
  return state.phase === 'title'
    && !peer
    && !spectator
    && !defenderMode
    && !urlDeathmatchModeActive()
    && !urlCoopCampaignModeActive()
    && getFlavour() !== '600bn'
    && getStoredMode() === 'campaign';
}

function startRunNow(): void {
  // Apply current daily-mode preference. Without this, the activeSeed from
  // a prior daily run would persist through a subsequent free-mode start
  // (the IGNITE button bypasses the keyboard Enter path that did the reset).
  // Duel + spectate force a deterministic run config so both clients
  // share the same modifiers: NORMAL difficulty, CAMPAIGN mode, no
  // daily seed. Without this, two clients with different stored
  // settings (one on HARD, the other NORMAL) produced different spawn
  // mods → different UFO positions → P1's bullet missed what P2 still
  // saw alive on screen. The seed alone is not enough; difficulty +
  // mode also feed into the deterministic spawn pipeline.
  if (peer || spectator) {
    setStoredDifficulty('normal');
    setDailySeed(null);
  } else {
    setDailySeed(getStoredDailyPref() ? todayUTC() : null);
  }
  startGame(state, spectator ? spectateSeed : peer ? mpSeed : undefined, currentStartOptions());
  applyDeathmatchHarnessOptions();
  restoreHeldInputsAfterStart();
  // Only force wavestart for the standard campaign — startGame on the
  // 600bn flavour sets phase='sanctum' and doesn't want the warp/wave
  // pipeline kicking in over the top.
  if (modeUsesWaveStart()) state.phase = 'wavestart';
  // Couch and deathmatch can change the effective camera/layout once the run
  // has real players/world size, so re-fit after startGame mutates state.
  if (couchMode || currentMode() === 'deathmatch') (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit?.();
  clearOverlay();
  audio.setMusicDuck(1);
  musicSetTrackForState(state);
}

function restoreHeldInputsAfterStart(): void {
  ensureLocalInputSlots(state.players.length);
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const held = localKeys[i] ?? {};
    for (const [code, pressed] of Object.entries(held)) {
      if (pressed) p.keys[code] = true;
    }
    p.targetHeading = localHeading[i] ?? null;
    p.thrustOverride = localThrust[i] === true;
  }
}

async function startRunFromAction(): Promise<void> {
  if (startActionInFlight) return;
  startActionInFlight = true;
  try {
    const readiness: Promise<unknown>[] = [];
    if (!mobileRuntimeActive()) readiness.push(ensureWebGLForCurrentStyle());
    if (shouldWaitForSoloCampaignAssets()) {
      readiness.push(warmCriticalCampaignAssets());
    }
    if (readiness.length === 0) {
      startRunNow();
      scheduleMeshWarmupAfterStart();
      return;
    }
    await Promise.all(readiness);
    startRunNow();
    scheduleMeshWarmupAfterStart();
  } finally {
    startActionInFlight = false;
  }
}

function scheduleMeshWarmupAfterStart(): void {
  const run = () => { void prewarmWebGLMeshesForCurrentStyle(); };
  const requestIdle = window.requestIdleCallback;
  if (typeof requestIdle === 'function') {
    requestIdle(run, { timeout: 1800 });
  } else {
    globalThis.setTimeout(run, 250);
  }
}

bindActions({
  onStart: () => {
    void startRunFromAction();
  },
  onResume: () => {
    resumeGame(state);
    clearOverlay();
    audio.setMusicDuck(1);
    musicSetTrackForState(state);
  },
});

// ── Input ─────────────────────────────────────────────────────────────────────

window.addEventListener('keydown', e => {
  // Any deliberate key during the death replay short-circuits to gameover.
  // Two filters protect against accidental skips: OS auto-repeats from a
  // movement key the player was still holding when they died (these fire
  // while phase=='deathreplay' even though the player hasn't pressed
  // anything new), and a 250ms grace window so a key pressed in the same
  // tick as the lethal collision doesn't skip the replay before anyone
  // sees it.
  if (state.phase === 'deathreplay') {
    if (e.repeat) return;
    if (state.elapsed - state.phaseStart < 250) return;
    skipDeathReplay(state);
    e.preventDefault();
    return;
  }
  // Any key during the wave-start cinematic skips to playing (after the
  // skip-allowed window — guard inside skipWaveStart). Lets repeat players
  // skim past the lore without sitting through the dwell every time.
  if (state.phase === 'wavestart') {
    skipWaveStart(state);
    // Don't swallow — let the keypress also register for movement
  }
  // Same for the warp cinematic — long enough to fit the music, but a key
  // press past the skip window jumps straight into the next wave.
  if (state.phase === 'warp') {
    skipWarp(state);
  }
  // Wave-jump cheat input mode swallows keys while open
  if (cheatInputOpen) {
    if (e.code === 'Enter') { closeCheatInput(true); e.preventDefault(); return; }
    if (e.code === 'Escape') { closeCheatInput(false); e.preventDefault(); return; }
    if (e.code === 'Equal' || e.code === 'NumpadAdd') { closeCheatInput(true); e.preventDefault(); return; }
    // 'B' as first char = jump to bonus phase. Followed optionally by
    // a digit (B1 = bonus 1; only one exists today but the slot is open).
    if (e.code === 'KeyB' && cheatInputBuffer.length === 0) {
      cheatInputBuffer = 'B';
      refreshCheatBuffer();
      resetCheatIdleTimer();
      e.preventDefault();
      return;
    }
    const digit = digitFromCode(e.code);
    if (digit !== null) {
      if (cheatInputBuffer.length < 2) {
        cheatInputBuffer += digit;
        refreshCheatBuffer();
        resetCheatIdleTimer();
      }
      e.preventDefault();
      return;
    }
    if (e.code === 'Backspace') {
      cheatInputBuffer = cheatInputBuffer.slice(0, -1);
      refreshCheatBuffer();
      resetCheatIdleTimer();
      e.preventDefault();
      return;
    }
    // any other key cancels
    closeCheatInput(false);
    e.preventDefault();
    return;
  }

  // In couch mode, route P2's physical keys to players[1].keys under logical key names.
  // P2 mapping: KeyA→ArrowLeft, KeyD→ArrowRight, KeyW→ArrowUp, KeyS→ArrowDown, ShiftLeft→Space.
  // Those same keys in solo mode continue to write to players[0] via e.code (game.ts aliases them).
  if (couchMode && state.players.length >= 2) {
    const p2LogicalKey: Record<string, string> = {
      KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown', ShiftLeft: 'Space',
    };
    const logical = p2LogicalKey[e.code];
    if (logical !== undefined) {
      state.players[1].keys[logical] = true;
      // P2 hyperspace: KeyU
    } else if (e.code === 'KeyU' && state.phase === 'playing') {
      edgeFlags[1].hyperspace = true;
      if (!isPeerActive()) tryHyperspace(state, state.elapsed, state.players[1]);
    } else if (e.code === 'KeyI' && state.phase === 'playing' && !e.repeat) {
      // P2 shield: KeyI
      edgeFlags[1].shield = true;
      if (!isPeerActive()) tryActivateShield(state, state.elapsed, state.players[1]);
    }
  }
  // P1 input — in couch mode only arrow/space go to players[0]; in solo mode all keys do (game.ts
  // aliases KeyA/D/W/S to ArrowLeft/Right/Up/Down for P1 via the keys record directly).
  const localPlayer = state.players[mpSlot];
  if (localPlayer && (!couchMode || !['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft', 'KeyU', 'KeyI'].includes(e.code))) {
    localPlayer.keys[e.code] = true;
    localKeys[mpSlot][e.code] = true;
  }
  // Prevent arrows from scrolling
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
  // Hyperspace via Shift / H — solo dispatches synchronously (pre-M2 feel);
  // peer mode raises the edge flag and the per-step decode dispatches from
  // the input log.
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyH') && state.phase === 'playing') {
    if (localPlayer && (!couchMode || e.code !== 'ShiftLeft')) {
      edgeFlags[mpSlot].hyperspace = true;
      if (!isPeerActive()) tryHyperspace(state, state.elapsed, localPlayer);
    }
  }
  // Down-arrow: shield on first press, hyperspace on double-tap (P1)
  if (e.code === 'ArrowDown' && state.phase === 'playing' && !e.repeat) {
    const now = performance.now();
    const sinceLast = now - lastDownArrowAt;
    if (lastDownArrowAt > 0 && sinceLast < DOWN_DOUBLE_TAP_WINDOW_MS) {
      edgeFlags[mpSlot].hyperspace = true;
      if (localPlayer && !isPeerActive()) tryHyperspace(state, state.elapsed, localPlayer);
      lastDownArrowAt = 0;  // consume — prevent triple-tap chain
    } else {
      edgeFlags[mpSlot].shield = true;
      if (localPlayer && !isPeerActive()) tryActivateShield(state, state.elapsed, localPlayer);
      lastDownArrowAt = now;
    }
  }
  // Wave cheat: + opens type-to-jump input, - single-steps back. Disabled during daily runs.
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && (state.phase === 'playing' || state.phase === 'wavestart' || state.phase === 'warp')) {
    if (getActiveSeed() !== null) {
      state.toast = 'CHEATS LOCKED · DAILY RUN';
      state.toastUntil = state.elapsed + 1800;
    } else {
      openCheatInput();
    }
    e.preventDefault();
  }
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && (state.phase === 'playing' || state.phase === 'wavestart')) {
    if (getActiveSeed() !== null) {
      state.toast = 'CHEATS LOCKED · DAILY RUN';
      state.toastUntil = state.elapsed + 1800;
    } else {
      cheatJumpToWave(state, Math.max(1, state.wave - 1));
    }
  }
  // Pause toggle
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state.phase === 'playing') {
      pauseGame(state);
      renderPause(state);
      audio.setMusicDuck(PAUSE_DUCK);
    } else if (state.phase === 'paused') {
      resumeGame(state);
      clearOverlay();
      audio.setMusicDuck(1);
    }
  }
  // Mute toggle
  if (e.code === 'KeyM') {
    audio.setMuted(!audio.isMuted());
    if (audio.isMuted()) audio.thrustOff();
  }
  // Enter on a focused <button> belongs to that button's click — never
  // the global "Enter restarts" shortcut. The controller PWA's A face
  // button maps to Enter; when the player has d-pad'd to CLAIM on the
  // gameover screen, the focused button must win or pressing SELECT
  // restarts the game instead of claiming sats (reported in the wild).
  // Same gate stops Enter on a focused HOW TO PLAY / SETTINGS button
  // on the title from firing IGNITE.
  const focusedIsButton = document.activeElement instanceof HTMLButtonElement;

  // Enter to start from title. Three gates: the data-onboarding marker
  // stops Enter from advancing past the cinematic itself; the focused-
  // button check defers to a target action when one is selected; and
  // gateBehindOnboarding diverts first-time players into the cinematic
  // instead of the game so they can't skip the intro by Entering before
  // clicking IGNITE.
  if (e.code === 'Enter' && state.phase === 'title' && !focusedIsButton && !document.querySelector('[data-onboarding="open"]')) {
    void audio.unlockAudio();
    // DUEL is a title-only meta-mode that routes to the dedicated lobby
    // instead of starting a solo run. Mirror the click handler in
    // renderTitle's IGNITE button so Enter and the on-screen button stay
    // consistent. Done BEFORE the difficulty lock + gateBehindOnboarding
    // because none of that applies to the lobby flow.
    const storedMode = getStoredMode();
    if ((storedMode === 'duel' || storedMode === 'coop-campaign' || storedMode === 'deathmatch') && !peer && !spectator) {
      window.location.assign(storedMode === 'coop-campaign' ? '/duel?coop=1' : storedMode === 'deathmatch' ? '/duel?deathmatch=1' : '/duel');
      return;
    }
    lockInDifficulty(getStoredDifficulty());
    gateBehindOnboarding(() => {
      void startRunFromAction();
    });
  }
  // Enter to play again from gameover. Gated on the arcade-initials
  // widget not being open AND no button having focus — when the player
  // has d-pad-navigated to CLAIM (or any other game-over button),
  // Enter must trigger that button's click rather than restarting.
  if (e.code === 'Enter' && state.phase === 'gameover' && !focusedIsButton && !document.querySelector('[data-arcade-initials="open"]')) {
    void audio.unlockAudio();
    lockInDifficulty(getStoredDifficulty());
    void startRunFromAction();
  }
});

window.addEventListener('keyup', e => {
  // Mirror the couch-mode routing from keydown: P2 physical keys release P2 logical keys.
  if (couchMode && state.players.length >= 2) {
    const p2LogicalKey: Record<string, string> = {
      KeyA: 'ArrowLeft', KeyD: 'ArrowRight', KeyW: 'ArrowUp', KeyS: 'ArrowDown', ShiftLeft: 'Space',
    };
    const logical = p2LogicalKey[e.code];
    if (logical !== undefined) {
      state.players[1].keys[logical] = false;
      if (logical === 'Space') state.players[1].keys.Space = false;
    }
  }
  const localPlayer = state.players[mpSlot];
  if (localPlayer && (!couchMode || !['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ShiftLeft'].includes(e.code))) {
    localPlayer.keys[e.code] = false;
    localKeys[mpSlot][e.code] = false;
  }
  if (e.code === 'Space') {
    // Allow rapid re-fire on tap by clearing the held state
    if (localPlayer) localPlayer.keys.Space = false;
    localKeys[mpSlot]['Space'] = false;
  }
});

// Tap anywhere during wave-start or warp to skip the long cinematic on touch
// devices. Buttons bubble up too — skip helpers guard on phase + min elapsed.
window.addEventListener('pointerdown', () => {
  if (state.phase === 'wavestart') skipWaveStart(state);
  else if (state.phase === 'warp') skipWarp(state);
}, { capture: true });

// One-shot global audio unlock on any first user interaction. Without it, a
// fresh title screen sits in autoplay-blocked silence until the player taps
// IGNITE — title music never gets going, and the secret music player can't
// unlock from its own row taps reliably on iOS. A pointerdown anywhere on
// the page (logo long-press, IGNITE, settings tap, even a stray tap) covers
// every entry path.
//
// Two independent locks on iOS Safari: the AudioContext (cleared by ctx.resume
// inside a gesture) AND each HTMLAudioElement (cleared by an in-gesture play).
// The title music's element had its first .play() attempted by the game loop
// before any user gesture, so iOS marks it blocked — even after we resume the
// context, that specific element stays silent. We force-refresh the music
// memo and trigger a fresh musicSetTrackForState pass *inside* this gesture
// so the title track's .play() is re-issued under the gesture.
// The controller PWA (mobile.pallasite.app + /controller path) is a
// remote — it doesn't play game music or SFX, it just produces input
// events for the host. Skipping all the music-init work on the
// controller PWA path keeps the joystick screen silent (per user
// brief) and avoids loading every track's HTMLAudioElement on a
// device that will never play them.
const isControllerSurface = (): boolean =>
  window.location.hostname.startsWith('mobile.')
  || window.location.pathname.replace(/\/+$/, '') === '/controller';

let firstMusicGesturePrimed = false;
let lastMusicGestureRecoveryMs = 0;
const MUSIC_GESTURE_RECOVERY_THROTTLE_MS = 650;

function phaseAllowsMusicRecovery(): boolean {
  return state.phase !== 'paused'
    && state.phase !== 'deathreplay'
    && document.visibilityState === 'visible'
    && !audio.isMuted();
}

function musicLooksStalled(): boolean {
  if (!phaseAllowsMusicRecovery()) return false;
  const snap = getMusicDebugSnapshot();
  if (!snap.currentId) return false;
  const ctxState = audio.getAudioContextState();
  if (ctxState !== 'running' && ctxState !== 'none') return true;
  if (snap.failedFlag) return true;
  if (snap.muted) return true;
  if (snap.paused) return true;
  if ((snap.readyState ?? 0) === 0) return true;
  if ((snap.networkState ?? 0) === 3 && (snap.readyState ?? 0) < 2) return true;
  return false;
}

function recoverMusicFromGesture(force = false, deferStateTrack = false): void {
  if (isControllerSurface()) return;
  const now = performance.now();
  const snap = getMusicDebugSnapshot();
  const mutedStall = !!snap.currentId && snap.muted === true;
  if (!force && now - lastMusicGestureRecoveryMs < MUSIC_GESTURE_RECOVERY_THROTTLE_MS && !mutedStall) return;
  if (!force && !musicLooksStalled()) return;
  lastMusicGestureRecoveryMs = now;
  firstMusicGesturePrimed = true;

  // This must run inside the active user gesture. If a previous element
  // was created or replayed while the browser considered audio locked,
  // rebuilding the MediaElementSource graph is more reliable than
  // repeatedly calling play() on the same poisoned element.
  void audio.unlockAudio();
  musicResetElements();
  musicWarmUpAll(force && state.phase === 'title' ? 'pallasite-idle' : undefined);
  musicForceRefresh();
  if (!deferStateTrack) musicSetTrackForState(state);
}

function shouldDeferFirstUnlockTrack(event: Event): boolean {
  if (getFlavour() !== '600bn') return false;
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('button');
  return button?.textContent?.includes('ENTER') === true;
}

const firstUnlock = (event: Event): void => {
  if (!event.isTrusted) return;
  recoverMusicFromGesture(true, shouldDeferFirstUnlockTrack(event));
  window.removeEventListener('pointerup', firstUnlock, true);
  window.removeEventListener('click', firstUnlock, true);
  window.removeEventListener('keyup', firstUnlock, true);
};
// IMPORTANT: bind on RELEASE events (pointerup / click / keyup), not press.
// iOS Safari only treats a gesture as "activated" for audio purposes on the
// release. Calls to ctx.resume() / element.play() inside a pointerdown
// handler are silently rejected and the elements stay locked.
//
// Capture phase: target-level handlers (e.g. the watch-page hero tile
// click → renderLiveTheatre → crossfadeTo → el.play()) must see an
// already-unlocked AudioContext, so firstUnlock has to run BEFORE the
// target handler. Default (bubble) order would fire firstUnlock last,
// after the failed play() attempt — leaving the element permanently
// silent on iOS for that page session.
window.addEventListener('pointerup', firstUnlock, true);
window.addEventListener('click', firstUnlock, true);
window.addEventListener('keyup', firstUnlock, true);

const recoverUnlock = (event: Event): void => {
  if (!event.isTrusted) return;
  // The first unlock listener does the full forced prime and then removes
  // itself. Keep this listener for the rest of the session: after a real
  // backgrounding, route change, Bluetooth/audio-session interruption, or
  // browser autoplay race, the next tap can rebuild music without making the
  // player dig into the hidden music reset panel.
  recoverMusicFromGesture(!firstMusicGesturePrimed, shouldDeferFirstUnlockTrack(event));
};
window.addEventListener('pointerup', recoverUnlock, true);
window.addEventListener('click', recoverUnlock, true);
window.addEventListener('keyup', recoverUnlock, true);

// Lose focus → release keys & pause
window.addEventListener('blur', () => {
  for (const pl of state.players) pl.keys = {};
  for (let i = 0; i < localKeys.length; i++) {
    localKeys[i] = {};
    localHeading[i] = null;
    localThrust[i] = false;
  }
  audio.thrustOff();
  if (state.phase === 'playing') {
    pauseGame(state);
    renderPause(state);
    audio.setMusicDuck(PAUSE_DUCK);
  }
});

// Two-tier silence:
//   - visibilitychange is FLAKY on mobile (fires on toolbar collapse,
//     fullscreen transition, transient overlays). Hard-pausing music on
//     these events broke gameplay (music dies after ~5s as soon as the
//     OS pulls the address bar). We soft-mute instead — toggle muted=
//     true without pause — so the playback's user-gesture chain stays
//     intact and visible again is a one-flag flip with no fresh play().
//     Also debounce so quick hide-show cycles don't even mute.
//   - pagehide / freeze are RELIABLE backgrounding signals. Full pause
//     + AudioContext suspend so the OS lock-screen Control Centre
//     doesn't get a phantom now-playing entry.
function softMute(): void {
  musicSetMuted(true);
}
function softUnmute(): void {
  musicSetMuted(false);
}
function hardSilence(): void {
  audio.thrustOff();
  audio.ufoSirenStop();
  audio.stopHeartbeat();
  audio.stopAmbient();
  musicSetPaused(true);
  audio.suspendPlayback();
}
function hardResume(): void {
  audio.resumePlayback();
  musicSetPaused(false);
  musicForceRefresh();
}
let visibilityTimer: number | null = null;
const VISIBILITY_SILENCE_DEBOUNCE_MS = 800;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (visibilityTimer !== null) { clearTimeout(visibilityTimer); visibilityTimer = null; }
    // Returning to the tab: wake the AudioContext too. An interruption
    // (or our own debounced hide) can have left it suspended; softUnmute
    // alone only clears el.muted and would unmute into a dead context.
    audio.resumePlayback();
    softUnmute();
  } else {
    if (visibilityTimer !== null) clearTimeout(visibilityTimer);
    visibilityTimer = window.setTimeout(() => {
      visibilityTimer = null;
      softMute();
    }, VISIBILITY_SILENCE_DEBOUNCE_MS);
  }
});
window.addEventListener('pagehide', hardSilence);
window.addEventListener('pageshow', hardResume);
// Page Lifecycle API — Chromium discards a backgrounded tab. Last chance
// to silence before the page is frozen and listeners stop firing.
document.addEventListener('freeze', hardSilence);
document.addEventListener('resume', hardResume);

// ── Game loop ─────────────────────────────────────────────────────────────────

// Fixed-timestep loop. The sim advances in exact FIXED_STEP_S quanta
// decoupled from the display refresh rate; the accumulator banks real
// time and spends it one whole step at a time. MAX_CATCHUP_STEPS caps a
// single frame's catch-up so a backgrounded tab can't trigger a step storm.
const MAX_CATCHUP_STEPS = 5;
// Catch-up only needs the full 5 steps under peer lockstep, where each client
// MUST reach the agreed sim frame to stay byte-identical with its partner. In
// solo there is no peer to converge with, so deep multi-step catch-up mostly
// burns CPU running updateGame N× on a frame that's already over budget. We
// cap it at 2 off-peer: that still holds full real-time speed down to 30fps
// (a 33ms frame banks exactly 2 steps), and below that the sim degrades a
// little slow rather than running 3–5 steps to stay wall-clock-accurate at a
// frame rate the player can't see anyway. NOTE the floor of 2, not 1 — a cap
// of 1 would slam the sim to half-speed the instant the device dropped under
// 60fps, which is worse than judder for a twitch shooter. This only diverges
// from MAX_CATCHUP_STEPS once frames exceed ~33ms, and it only helps if the
// SIM (updateGame) is the bottleneck — if RENDER (mesh tier on mobile) is the
// cost, the real fix is cutting render load, not this cap.
function maxCatchupSteps(): number {
  return isPeerActive() ? MAX_CATCHUP_STEPS : 2;
}
const FAST_CRT_PLAYER_THRESHOLD = 32;
let lastFrame = performance.now();
let stepAccumulator = 0;
let lastPhase = state.phase;

function setFastCrtOverlay(active: boolean): void {
  if (active) document.body.dataset.crtFast = '1';
  else delete document.body.dataset.crtFast;
}

let lastAppliedBrightness = '';
function syncCanvasBrightness(): void {
  const next = getBrightness().toFixed(2);
  if (next === lastAppliedBrightness) return;
  lastAppliedBrightness = next;
  document.documentElement.style.setProperty('--pallasite-brightness', next);
}

function shouldUseFastCrt(): boolean {
  if (deathmatchActive()) return true;
  return Array.isArray(state.players) && state.players.length >= FAST_CRT_PLAYER_THRESHOLD;
}

/** Apply the active presentation theme to the finished frame. Most themes
 *  composite the 3D mesh overlay down into the 2D canvas first so the
 *  post-process covers it too. Large CRT deathmatch uses a CSS overlay
 *  instead, keeping the mesh canvas compositor-backed. */
function applyThemeFrame(target: HTMLCanvasElement, now: number): void {
  const theme = getTheme();
  const fastCrt = theme === 'crt' && shouldUseFastCrt();
  if (theme === 'none' || fastCrt) {
    setFastCrtOverlay(fastCrt);
    if (overlay3d && overlay3d.style.visibility === 'hidden') overlay3d.style.visibility = '';
    return;
  }
  setFastCrtOverlay(false);
  if (overlay3d && overlay3d.width > 0) {
    const c = target.getContext('2d');
    if (c) {
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.drawImage(overlay3d, 0, 0, overlay3d.width, overlay3d.height, 0, 0, target.width, target.height);
      c.restore();
    }
    overlay3d.style.visibility = 'hidden';
  }
  applyPostFx(target, theme, now, { asciiCols: getAsciiCols(), bitDepth: getBitDepth(), bitColour: getBitColour() });
}

function loop(now: number): void {
  // The watch-page live theatre, while open, drives #game / #game3d and
  // render.ts's module-level render mode itself. Yield the loop to it so
  // the two never contend; it resumes the moment the theatre closes.
  if (document.body.dataset.theatre === 'open') {
    // Drop the elapsed gap so the sim doesn't fast-forward when handed back.
    lastFrame = now;
    stepAccumulator = 0;
    requestAnimationFrame(loop);
    return;
  }
  // Bank real time, clamped, then spend it one fixed sim step at a time.
  const rawFrameDeltaMs = Math.max(0, now - lastFrame);
  // Feed the adaptive performance governor (capability-based reduced-FX). It
  // filters outliers and only acts on a sustained signal, so recording every
  // live frame here is safe and cheap (O(1) per call).
  recordFrameTime(rawFrameDeltaMs);
  if (shouldRecordPeerPerf()) recordPeerPerfSample(peerPerfRaf, rawFrameDeltaMs);
  const frameDeltaS = Math.min(maxCatchupSteps() * FIXED_STEP_S, rawFrameDeltaMs / 1000);
  stepAccumulator += frameDeltaS;
  lastFrame = now;
  // Peer catch-up: a late-joining peerwatch, AI-slot takeover, or slow-starting
  // 4P tab can receive remote input faster than its local sim is advancing.
  // The real-time accumulator can only afford one or two sim steps per rAF, so
  // the slow client may remain permanently behind and hold strict lockstep. If
  // remote human slots are far ahead of this client, top up the accumulator with
  // extra fixed steps so it can produce its own missing frames and catch live.
  if ((spectator || peer) && inputLog) {
    let latest = spectator ? Infinity : (peer?.lastReceivedFrame() ?? -1);
    for (let i = 0; i < inputLog.players; i++) {
      if (state.players[i]?.ai) continue;
      if (peer && !spectator) {
        if (i !== mpSlot) latest = Math.max(latest, inputLog.latest(i));
      } else {
        latest = Math.min(latest, inputLog.latest(i));
      }
    }
    if (!Number.isFinite(latest)) latest = -1;
    const behind = latest - state.frame;
    if (behind > 30) {
      // Up to 4 extra sim steps per rAF — 5× live rate. 540 frames of
      // lag burns down in ~2.5s at 60Hz, well inside any realistic
      // PEER_STALL_DISCONNECT window.
      stepAccumulator += 4 * FIXED_STEP_S;
      peerPerfCatchupTicks++;
      peerPerfMaxCatchupBehind = Math.max(peerPerfMaxCatchupBehind, behind);
    }
  }
  // Peer stall accounting: capture the sim frame before the inner loop so
  // we can tell, after it runs, whether ANY frame actually advanced. Track
  // the explicit lockstep stall separately; a rAF that simply had no fixed
  // sim step due is not a network stall.
  const frameBeforeStep = state.frame;
  let lockstepBlockedThisTick = false;
  while (stepAccumulator >= FIXED_STEP_S) {
    const simStepStartedAt = shouldRecordPeerPerf() ? performance.now() : 0;
    // Lockstep input pipeline. On every advancing frame:
    //   1) snapshot the LOCAL slots' input into the log (and send via peer
    //      in duel mode); in couch mode both slots are local, in duel mode
    //      only mpSlot is local;
    //   2) drain peer.drainFrames() into the log under the REMOTE slot;
    //   3) read frame (s.frame - delay) for every slot; if any slot is
    //      missing in duel mode, STALL (break) -- the sim cannot advance
    //      until both halves of the input are available;
    //   4) decode + apply + edge dispatch + updateGame.
    // Hit-stop skipping lives inside updateGame (B3 sim contract), so the
    // loop unconditionally calls updateGame -- both clients agree on the
    // skip off the same `s.hitStopSteps`. Sample / apply is gated on the
    // same value so a frozen frame does not re-sample over the same log
    // slot and stomp the canonical input for that frame.
    const peerActive = isPeerActive();
    // Static tier = the pre-adaptive safe default (also honours ?inputDelay=).
    // When the broker negotiated a delay from the measured link, use it but
    // clamp to [floor, tier] so the session is adaptive yet never worse than
    // the static default. Determinism holds: staticTier is a pure function of
    // player-count/mode and negotiatedInputDelay is the one broker-broadcast
    // value every peer froze, so activeDelay is identical across the session.
    let activeDelay: number;
    if (peerActive) {
      const staticTier = peerInputDelayFrames(state.players.length || requestedPeerPlayers, aiFillDeathmatch && urlDeathmatchModeActive());
      activeDelay = negotiatedInputDelay !== null
        ? Math.max(ADAPT_MIN_DELAY_FRAMES, Math.min(staticTier, negotiatedInputDelay))
        : staticTier;
      lastActivePeerInputDelay = activeDelay;
    } else {
      activeDelay = inputDelay;
    }
    // Encoded inputs the apply step fed into this sim tick. Captured here
    // so the desync hunter's canary serialiser (further down) can include
    // them — answers "did the peers apply different inputs at this frame,
    // or compute differently from identical inputs?". Empty array on a
    // hit-stop frame or non-peer mode (no apply step ran).
    let appliedThisStep: number[] = [];
    // Set true when the rollback path already advanced the sim this iteration
    // (it owns updateGame + snapshot + canary), so the shared tail below skips
    // its own updateGame/canary. Stays false for every non-rollback path.
    let rollbackAdvanced = false;
    // Solo and couch take the pre-M2 direct path: keydown handlers already
    // dispatched the edge actions synchronously and players[i].keys still
    // holds the live input -- updateGame reads it as it always did. The
    // sample / log / apply pipeline only runs in peer mode where lockstep
    // requires a canonical input source.
    if (state.hitStopSteps === 0 && peerActive) {
      if (!inputLog || inputLog.players !== state.players.length) {
        // Spectators may receive a long history replay from the broker
        // on attach (up to PEER_FRAME_BUFFER frames, see controller-ws),
        // which can far exceed the default 256-slot ring. Sizing the
        // ring to 4096 covers the broker's 3000-frame buffer with
        // headroom; duel/couch peers still effectively use only ~50
        // slots (PEER_INPUT_DELAY=5 × a couple of jitter frames) so
        // the extra capacity is essentially free.
        inputLog = new InputLog(state.players.length, 4096);
        localPeerPrefilledThrough = -1;
      }
      ensureLocalPeerStartupPrefill(activeDelay);
      // 1) Sample LOCAL slot(s) and send once per sim frame. The receiver's
      //    lockstep needs our frame N in its inputLog before it can pass the
      //    delayed read for that frame, but retrying the same frame every
      //    stalled rAF floods the production relay and makes jitter worse.
      //    Missing frames are handled by the throttled compact resend below.
      //
      //    Idempotent sampling still matters: on a retry at the same
      //    state.frame, keep the original encoded value so the frame's
      //    canonical input cannot drift with wall-clock keyboard state.
      //
      //    Spectator mode has NO local slots — every input comes from
      //    the broker tap. Duel mode samples just the local slot; couch
      //    (which never sets peerActive today) samples both.
      const localSampleSlots = spectator
        ? []
        : peer
          ? [mpSlot]
          : (state.players.length >= 2 ? [0, 1] : [0]);
      for (const i of localSampleSlots) {
        let encoded = inputLog.get(state.frame, i);
        let sampledThisFrame = false;
        if (encoded < 0) {
          // Peer mode reads from the localKeys + localHeading + localThrust
          // mirrors so apply's delayed overwrite of `players[i]` cannot
          // clobber the live joystick / keyboard input.
          const keysOverride = peer ? localKeys[i] : undefined;
          const thrustOverrideOverride = peer ? localThrust[i] : undefined;
          const headingOverride = peer ? localHeading[i] : undefined;
          const input = samplePlayerInput(state.players[i], edgeFlags[i], keysOverride, thrustOverrideOverride, headingOverride);
          encoded = encodePlayerInput(input);
          inputLog.record(state.frame, i, encoded);
          sampledThisFrame = true;
        }
        if (peer && sampledThisFrame) peer.sendFrame(state.frame, encoded);
      }
      // 2) Drain remote frames into the log. Duel: the OTHER slot only.
      //    Spectator: whichever slot each delivery is tagged with (both).
      //    Under rollback, reconcile each arriving real input against any
      //    prediction we applied for that (frame,slot) and note the earliest
      //    miss so we can restore + re-simulate from there.
      let rollbackTarget = -1;
      if (spectator) {
        const drained = spectator.drainFrames();
        for (const d of drained) inputLog.record(d.frame, d.slot, d.input);
        if (duelDebugMode && drained.length > 0) try { window.dispatchEvent(new CustomEvent('pallasite:peer-frame-drain', { detail: { count: drained.length } })); } catch { /* ignore */ }
      } else if (peer) {
        const drained = peer.drainFrames();
        for (const d of drained) {
          if (rollbackActive) {
            const key = predictKey(d.frame, d.slot);
            const pred = predictedInput.get(key);
            if (pred !== undefined) {
              predictedInput.delete(key);
              // Compare with edge bits masked (we never predict edges). A real
              // edge press on a predicted frame always counts as a miss.
              const realMasked = (d.input & ~ROLLBACK_EDGE_MASK) >>> 0;
              const predMasked = (pred & ~ROLLBACK_EDGE_MASK) >>> 0;
              const mis = realMasked !== predMasked || (d.input & ROLLBACK_EDGE_MASK) !== 0;
              if (mis) {
                mispredictCount++;
                if (rollbackTarget < 0 || d.frame < rollbackTarget) rollbackTarget = d.frame;
              }
            }
          }
          inputLog.record(d.frame, d.slot, d.input);
        }
        if (duelDebugMode && drained.length > 0) try { window.dispatchEvent(new CustomEvent('pallasite:peer-frame-drain', { detail: { count: drained.length } })); } catch { /* ignore */ }
      }

      if (rollbackActive && rollbackRing) {
        // ── Rollback advance ────────────────────────────────────────────────
        // Local input runs at delay 0 (instant); remote inputs are predicted
        // when absent and corrected by re-simulation when the real value lands.
        if (confirmedThrough.length !== state.players.length) {
          confirmedThrough = new Array(state.players.length).fill(-1);
        }
        for (let i = 0; i < state.players.length; i++) {
          if (!state.players[i].ai) advanceConfirmed(i);
        }
        const confirmed = currentConfirmedFrame();
        // Seed the ring with the pre-frame-0 state so a frame-0 misprediction
        // has a restore point (the per-step capture only records AFTER updateGame).
        if (rollbackRing.newestFrame() < 0) rollbackRing.capture(state);
        // Re-simulate from the earliest mispredicted frame to the live frontier.
        if (rollbackTarget >= 0) rollbackTo(rollbackTarget);
        // Window bound: never predict more than ROLLBACK_WINDOW frames past the
        // confirmed frontier — keeps every rollback target resident in the ring.
        // On overrun, fall back to the Phase-1 stall (wait for the slow peer).
        if (state.frame - confirmed >= ROLLBACK_WINDOW) {
          lockstepBlockedThisTick = true;
          peerPerfLockstepBlockedTicks++;
          if (peerStallFrames >= peerResendAfterStallFrames()) {
            const base = confirmed + 1;
            resendPeerInputRange(base - PEER_RESEND_BEHIND_FRAMES, Math.min(state.frame - 1, base + PEER_RESEND_AHEAD_FRAMES), now);
          }
          stepAccumulator = Math.min(stepAccumulator, FIXED_STEP_S);
          break;
        }
        // Advance the live frame (predicting absent remote inputs), then promote
        // any now-confirmed canary hashes to the partner.
        rollbackSimulateStep(null);
        if (simStepStartedAt > 0) recordPeerPerfSample(peerPerfSim, performance.now() - simStepStartedAt);
        promoteConfirmedHashes();
        rollbackAdvanced = true;
      } else {
        // 3) Stall check in any peer-driven mode: every slot's input for
        //    the read frame must be present. The read frame can be negative
        //    in the first `activeDelay` frames (pre-roll); EMPTY_INPUT is
        //    used and the sim coasts.
        const readFrame = state.frame - activeDelay;
        syncDeathmatchAiSlotsForFrame(readFrame);
        let stalled = false;
        if (peerActive && readFrame >= 0) {
          for (let i = 0; i < state.players.length; i++) {
            if (state.players[i].ai) continue;
            if (inputLog.get(readFrame, i) < 0) { stalled = true; break; }
          }
        }
        if (stalled) {
          // The local frame was sent when it was first sampled. If the stall is
          // sustained, replay a compact committed prefix; the partner may be
          // blocked on state.frame - delay rather than on the newest frame.
          lockstepBlockedThisTick = true;
          peerPerfLockstepBlockedTicks++;
          if (peerStallFrames >= peerResendAfterStallFrames()) {
            const resendFrom = readFrame - PEER_RESEND_BEHIND_FRAMES;
            const resendThrough = Math.min(state.frame - 1, readFrame + PEER_RESEND_AHEAD_FRAMES);
            resendPeerInputRange(resendFrom, resendThrough, now);
          }
          // Drop accumulated wall-clock backlog while lockstep waits. Replaying
          // all banked time after recovery creates burst sends, visible judder,
          // and usually another relay stall; resume at live pace instead.
          stepAccumulator = Math.min(stepAccumulator, FIXED_STEP_S);
          break;  // hold the accumulator; next rAF retries
        }
        // 4) Apply + edge dispatch. Record each slot's applied encoded
        // input for this step so the desync hunter can compare what each
        // peer actually fed into the sim.
        for (let i = 0; i < state.players.length; i++) {
          const encoded = readFrame >= 0 ? inputLog.get(readFrame, i) : -1;
          appliedThisStep.push(encoded);
          if (state.players[i].ai) continue;
          const input = encoded >= 0 ? decodePlayerInput(encoded) : EMPTY_INPUT;
          applyPlayerInput(state.players[i], input);
          if (state.phase === 'playing') {
            if (input.hyperspaceEdge) tryHyperspace(state, state.elapsed, state.players[i]);
            if (input.shieldEdge) tryActivateShield(state, state.elapsed, state.players[i]);
          }
          // E2E diagnostic: when wire-trace is on, record what the apply step
          // actually consumed for each slot at each frame. Lets the runner see
          // whether the remote slot's input was 0 at apply time (suggesting
          // the wire frame arrived too late) or non-zero (suggesting the bug
          // is elsewhere). Keep this off the hot path when not in wire-trace
          // mode -- the ring write is a few words, not free.
          if (applyTraceReadFrame && applyTraceSlot && applyTraceEncoded && applyTraceTime) {
            applyTraceReadFrame[applyTraceHead] = readFrame;
            applyTraceSlot[applyTraceHead] = i;
            applyTraceEncoded[applyTraceHead] = encoded;
            applyTraceTime[applyTraceHead] = performance.now();
            applyTraceHead = (applyTraceHead + 1) % APPLY_TRACE_CAP;
            applyTraceCount++;
          }
        }
      }
    }
    // The rollback path (when it advanced this iteration) already ran
    // updateGame, captured a snapshot, recorded sim perf, and promoted its
    // confirmed-frame canary — so the shared tail below is skipped for it.
    if (!rollbackAdvanced) updateGame(state);
    if (!rollbackAdvanced && simStepStartedAt > 0) recordPeerPerfSample(peerPerfSim, performance.now() - simStepStartedAt);
    // ── Desync canary ────────────────────────────────────────────────
    // Every PEER_HASH_PERIOD sim steps, hash the gameplay-relevant slice
    // of GameState and send to the partner. We retain our own hash so a
    // later-arriving partner hash can be compared. Solo / couch skip
    // this entirely (no peer, no exchange).
    // Desync hunter: when ?desync-hunt=1, capture the FULL serialised
    // state EVERY frame so the test runner can find the exact frame
    // (not just the nearest canary period) where peers first diverge.
    // Memory bound to a ring so even long runs don't blow up.
    if (!rollbackAdvanced && desyncHuntEnabled && peerActive && (peer || spectator) && state.frame > 0) {
      const history = (window as unknown as { __pallasiteCanaryHistory?: Map<number, string> }).__pallasiteCanaryHistory;
      if (history) {
        history.set(state.frame, serializeForCanary(state, appliedThisStep));
        // Keep ~2000 frames (~33 seconds at 60Hz). The first divergence
        // is what matters; we don't need a longer window than that.
        if (history.size > 2000) {
          const oldest = Math.min(...history.keys());
          history.delete(oldest);
        }
      }
    }
    if (!rollbackAdvanced && peerActive && peer && !spectator && state.frame > 0 && (state.frame % PEER_HASH_PERIOD) === 0) {
      const h = hashState(state);
      localCanaryHashes.set(state.frame, h);
      peer.sendHash(state.frame, h);
      // Prune old entries so the map can't grow unbounded across long
      // runs. Five canary periods (~5s) is generous for any plausible
      // delay between the partner sending and us receiving.
      const cutoff = state.frame - PEER_HASH_PERIOD * 5;
      if (cutoff > 0) {
        for (const f of localCanaryHashes.keys()) {
          if (f < cutoff) localCanaryHashes.delete(f);
        }
      }
    }
    stepAccumulator -= FIXED_STEP_S;
  }

  // ── Peer stall + disconnect ─────────────────────────────────────────────
  // Entirely gated on isPeerActive(): solo and couch never enter this block.
  // The lockstep stall break above holds the sim frame; we measure that
  // here against the frame seen entering the rAF tick.
  if (isPeerActive()) {
    const advanced = state.frame > frameBeforeStep;
    const peerGone = !!peer && !peer.isConnected();
    const spectateGone = !!spectator && !spectator.bothPeersBound();
    const partnerLeft = peerGone || spectateGone;
    if (partnerLeft) {
      // Count the disconnect path below from the moment the peer link is
      // observed gone, even if the sim would otherwise be idle this rAF.
      peerStallFrames += frameDeltaS / FIXED_STEP_S;
    } else if (advanced || !lockstepBlockedThisTick) {
      peerStallFrames = 0;
      peerStallActive = false;
    } else {
      if (!peerStallActive) {
        peerStallCount++;
        peerStallActive = true;
      }
      // Count wall-clock time once per rAF. Do not include stepAccumulator:
      // it intentionally remains banked while stalled, and adding it every
      // tick makes the timeout grow 1+2+3... instead of at real-time pace.
      peerStallFrames += frameDeltaS / FIXED_STEP_S;
      peerMaxStallFrames = Math.max(peerMaxStallFrames, peerStallFrames);
    }
    if (!peerDisconnectDeclared) {
      const overFrames = peerStallFrames >= PEER_STALL_DISCONNECT_FRAMES;
      if (partnerLeft || overFrames) {
        // Tear the peer / spectator down so the sim drops back into the solo
        // path (the game-over overlay is then dismissable as usual).
        peerDisconnectDeclared = true;
        setPeerActive(false);
        try { peer?.disconnect(); } catch { /* socket may already be closed */ }
        peer = null;
        try { spectator?.disconnect(); } catch { /* idem */ }
        spectator = null;
        // Clear any in-flight "waiting" overlay; we're past that now.
        delete document.body.dataset.peerStall;
        toastNow(state, spectateMode ? 'Duel ended' : 'Opponent left');
        // End the current run. The existing phase-transition block below
        // picks this up and renders the gameover overlay.
        if (state.phase === 'playing') state.phase = 'gameover';
      } else if (peerStallFrames >= peerStallOverlayFrames()) {
        if (document.body.dataset.peerStall !== 'waiting') {
          document.body.dataset.peerStall = 'waiting';
        }
      } else if (document.body.dataset.peerStall === 'waiting') {
        delete document.body.dataset.peerStall;
      }
    }
  } else if (document.body.dataset.peerStall) {
    // Peer is gone (or was never wired); make sure the overlay isn't
    // stuck on the screen.
    delete document.body.dataset.peerStall;
  }

  // ── Desync canary: drain + compare ───────────────────────────────────────
  // Solo / couch never have a peer so this is cheap. Once a desync is
  // observed we set a sticky flag — v1 doesn't try to resync, it just
  // surfaces an indicator the renderer / debug HUD can pick up.
  if (isPeerActive() && peer && peerDesyncFrame < 0) {
    const markDesync = (frame: number, local: number, hash: number): void => {
      peerDesyncFrame = frame;
      // eslint-disable-next-line no-console
      console.warn(`[peer] desync at frame ${frame}: local=${local.toString(16)} remote=${hash.toString(16)}`);
      document.body.dataset.peerDesync = String(frame);
    };
    for (const { frame, hash } of peer.drainHashes()) {
      const local = localCanaryHashes.get(frame);
      if (local !== undefined) {
        if (local !== hash) { markDesync(frame, local, hash); break; }
      } else if (rollbackActive) {
        // Under rollback we emit a frame's hash only once it is CONFIRMED, which
        // can lag the partner's. Buffer the partner's hash and re-check below as
        // our confirmed frontier advances, rather than dropping it.
        pendingPartnerHashes.set(frame, hash);
      }
    }
    if (rollbackActive && peerDesyncFrame < 0) {
      for (const [frame, hash] of pendingPartnerHashes) {
        const local = localCanaryHashes.get(frame);
        if (local !== undefined) {
          pendingPartnerHashes.delete(frame);
          if (local !== hash) { markDesync(frame, local, hash); break; }
        } else if (frame < lastPromotedHashFrame - PEER_HASH_PERIOD * 5) {
          // We have confirmed well past this frame without ever computing its
          // hash (e.g. pruned) — it can never match; drop it.
          pendingPartnerHashes.delete(frame);
        }
      }
    }
  } else if (!isPeerActive() && document.body.dataset.peerDesync) {
    // Peer gone — clear the indicator so the next session starts clean.
    delete document.body.dataset.peerDesync;
  }

  // Render every rAF. The peer-mode throttle that used to gate this was a
  // workaround for main-thread WS-event starvation; the WebSocket now lives
  // in peer-worker.ts, so the recv path runs off-thread and doesn't need
  // the main thread to yield render time. Throttling render here actually
  // backfires under chromium-headless — when no frames are drawn the
  // browser slows rAF, which then can't push enough sends/sec to keep
  // lockstep moving.
  const renderStartedAt = shouldRecordPeerPerf() ? performance.now() : 0;
  syncCanvasBrightness();
  render(canvas, state, now);
  applyThemeFrame(canvas, now);
  if (getTheme() === 'ascii') drawAsciiHud(canvas, state);
  if (renderStartedAt > 0) recordPeerPerfSample(peerPerfRender, performance.now() - renderStartedAt);

  // Phase transitions render UI overlays
  if (state.phase !== lastPhase) {
    if (state.phase === 'gameover') {
      renderGameOver(state);
    } else if (state.phase === 'title') {
      // 600bn flavour returns to the bespoke attract screen on title-
      // transition, NOT the campaign mission-select. Without this
      // the BACK TO TITLE button from the game-over funnel dropped
      // the player on the main-game title.
      if (getFlavour() === '600bn') renderAttract(state);
      else renderTitle(state);
    } else if (state.phase === 'completed') {
      renderCompletion(state);
    }
    // Mirror the phase to the body so CSS can gate touch controls visibility —
    // controls appear during gameplay phases only, hidden on title/menu screens.
    document.body.dataset.phase = state.phase;
    lastPhase = state.phase;
  }

  // Music keeps in step with phase + wave (idempotent — diffs internally).
  // Skipped on the controller PWA surface — it's a remote, not a game
  // canvas, and the user brief is "no music on the joystick app".
  if (!isControllerSurface()) {
    musicSetTrackForState(state);
    // Adaptive stems on top of the recorded track: combo bass while a chain
    // is live, boss-lead motif on wave 25 until the boss is downed.
    stemsTickForState(state, performance.now());
  }

  // Toast updates
  if (state.toast) {
    renderToast(state);
    state.toast = null;  // consume
  }

  requestAnimationFrame(loop);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Lock in stored difficulty as the default for any auto-launched run
  lockInDifficulty(getStoredDifficulty());
  // Mirror the active display mode to a body data-attr so CSS can react.
  // applyDisplayMode (not setDisplayMode) — fullscreen + 600bn flavour
  // force modern dynamically, and we don't want those transient
  // computed values to overwrite the user's saved retro preference.
  applyDisplayMode(getDisplayMode());
  // Fullscreen entry/exit re-applies the mode + re-runs fit() so the
  // canvas resizes to match. Without this, fullscreen leaves the retro
  // 1280×720 canvas centred with the wave-N body background bleeding
  // through the letterbox area — visible as a "red square" during
  // screen shake / hits when the canvas translates against the bg.
  // Listen on BOTH the standard and webkit-prefixed events because
  // Safari only fires the prefixed one.
  const onFullscreenToggle = (): void => {
    applyDisplayMode(getDisplayMode());
    // Multi-pass refit, not a single fit(): exiting fullscreen (Esc) fires
    // fullscreenchange while the browser still reports the OLD (fullscreen)
    // innerWidth/innerHeight for a beat, so a lone fit() sizes the canvas to a
    // stale viewport and never corrects — leaving a tiny centred window. The
    // staggered passes land on the settled windowed dimensions (same fix as
    // the orientationchange race).
    scheduleRefit();
  };
  document.addEventListener('fullscreenchange', onFullscreenToggle);
  document.addEventListener('webkitfullscreenchange', onFullscreenToggle);
  // Rotate hint: the 16:9 world is a thin strip on a portrait phone, so
  // #rotate-hint (CSS, portrait + touch only) nudges a turn. Wire the
  // opt-out so a player who wants portrait keeps it, and remember it.
  const rotateDismiss = document.getElementById('rotate-hint-dismiss');
  if (rotateDismiss) {
    try {
      if (localStorage.getItem('pallasite:rotateHintDismissed') === '1') {
        document.body.classList.add('rotate-hint-dismissed');
      }
    } catch { /* ignore */ }
    rotateDismiss.addEventListener('click', () => {
      document.body.classList.add('rotate-hint-dismissed');
      try { localStorage.setItem('pallasite:rotateHintDismissed', '1'); } catch { /* ignore */ }
    });
  }
  // Kick off WebGL overlay load if the player had a mesh-tier category
  // selected last session. Fire-and-forget on desktop; mobile defers this
  // until IGNITE so phones don't download/parse three.js on the title screen.
  if (!mobileRuntimeActive()) warmWebGLIfPreviouslyEnabled();

  // Resize canvas to fit viewport in BOTH dimensions while preserving the
  // 16:9 world aspect — internal pixel resolution stays WORLD_W×WORLD_H
  // (× dpr) so the game logic and HUD coords don't need to know about
  // display size; the browser scales the bitmap. Centring via CSS.
  // Read env(safe-area-inset-*) into pixel numbers via a sentinel div. iPhone
  // notch / Dynamic Island / rounded corners surface here when the canvas runs
  // edge-to-edge under viewport-fit=cover. Non-zero values get applied by the
  // HUD so SCORE/WAVE/LIVES sit clear of cutouts.
  function readSafeInsets(): { top: number; right: number; bottom: number; left: number } {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding:'
      + 'env(safe-area-inset-top) env(safe-area-inset-right) '
      + 'env(safe-area-inset-bottom) env(safe-area-inset-left);'
      + 'visibility:hidden;pointer-events:none;';
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    const insets = {
      top: parseFloat(cs.paddingTop) || 0,
      right: parseFloat(cs.paddingRight) || 0,
      bottom: parseFloat(cs.paddingBottom) || 0,
      left: parseFloat(cs.paddingLeft) || 0,
    };
    document.body.removeChild(el);
    return insets;
  }

  function fit(): void {
    const mode = getDisplayMode();
    const dpr = Math.min(window.devicePixelRatio || 1, getRenderDprCap());
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const insets = readSafeInsets();

    if (mode === 'modern') {
      // Modern fill: the canvas spans the entire viewport. The world is a
      // fixed 16:9 shape; contain-scale fits the whole of it into the
      // viewport. On a 16:9 screen that's an exact edge-to-edge fill; off-16:9
      // landscape it letterboxes. Portrait is the exception: there `follow`
      // tells render() to switch to the follow camera. The contain transform
      // below is still what the non-follow phases (warp, title, game-over)
      // use in portrait, so it is always computed.
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
      canvas.style.width = vw + 'px';
      canvas.style.height = vh + 'px';
      canvas.style.imageRendering = 'auto';
      const ctx = canvas.getContext('2d')!;
      // Portrait phones get the follow camera (see render.ts); landscape and
      // square viewports keep the contain transform — except when Defender
      // is active (via URL flag OR Mode picker), where the wide Defender
      // feel needs follow on regardless of orientation. Reads stored mode
      // (not currentMode) so the camera engages from the FIRST frame after
      // the player picks DEFENDER, not only after IGNITE runs lockInMode.
      const defenderActive = defenderMode || isStoredDefenderMode();
      const deathmatchFollow = deathmatchActive() || urlDeathmatchModeActive();
      const follow = (vh > vw) || defenderActive || deathmatchFollow;
      const scale = Math.min(vw / WORLD_W, vh / WORLD_H);
      const tx = (vw - WORLD_W * scale) / 2;
      const ty = (vh - WORLD_H * scale) / 2;
      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
      if (overlay3d) {
        overlay3d.width = canvas.width;
        overlay3d.height = canvas.height;
        overlay3d.style.width = vw + 'px';
        overlay3d.style.height = vh + 'px';
      }
      // Local couch mode shares one screen, so keep the full world visible.
      // Remote peer clients each have their own local slot/camera; forcing
      // them into the shared-screen 16:9 strip in portrait makes the game feel
      // flattened and can make the two views look incorrectly out of sync.
      if (couchMode && state.players.length >= 2 && !deathmatchFollow) {
        // Fall through to retro branch below.
      } else {
        applyDisplayMode('modern');
        setRenderMode({ kind: 'modern', vw, vh, dpr, scale, tx, ty, insets, follow, defender: defenderActive, localSlot: mpSlot });
        return;
      }
    }

    // Retro: the 16:9 world inscribed in the viewport, capped at WORLD_W
    // native source and pixel-upscaled for the arcade-cabinet look.
    const aspect = WORLD_W / WORLD_H;
    let w = Math.min(vw, vh * aspect);
    if (w > WORLD_W) w = WORLD_W;
    const h = w / aspect;
    canvas.width = Math.round(WORLD_W * dpr);
    canvas.height = Math.round(WORLD_H * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.style.imageRendering = 'pixelated';
    applyDisplayMode('retro');
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (overlay3d) {
      overlay3d.width = canvas.width;
      overlay3d.height = canvas.height;
      overlay3d.style.width = w + 'px';
      overlay3d.style.height = h + 'px';
    }
    setRenderMode({ kind: 'retro', vw: w, vh: h, dpr, scale: 1, tx: 0, ty: 0, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  }
  // Expose to the settings panel — flipping the mode needs to re-fit.
  (window as unknown as { __pallasiteFit?: () => void }).__pallasiteFit = fit;
  // iOS Safari reports stale window.innerWidth/innerHeight for a beat
  // or two after `orientationchange`, and streams intermediate sizes
  // during the rotation animation. A single fit() bound straight to the
  // event lands on one of those wrong sizes — the canvas backing store +
  // ctx transform end up sized for the *previous* orientation while CSS
  // has already snapped the element to the new one. Visible result: a
  // distorted / doubled playfield that settles wrong (ship off the
  // visible band). Re-run fit() across the next ~650ms so a later pass
  // always lands on the settled dimensions.
  let refitTimers: number[] = [];
  function scheduleRefit(): void {
    for (const id of refitTimers) clearTimeout(id);
    refitTimers = [120, 280, 480, 650].map(ms => window.setTimeout(fit, ms));
    fit();
    requestAnimationFrame(fit);
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', scheduleRefit);
  // visualViewport's resize fires only once the viewport has actually
  // settled after a rotation, with correct dimensions — the most
  // trustworthy single signal iOS gives us, free of the event-timing
  // race above.
  window.visualViewport?.addEventListener('resize', fit);
  // Backgrounding the tab/app can leave the canvas sized for a stale viewport,
  // or on iOS bfcache restore not laid out at all, so a resumed portrait
  // session drops back to the contain band. On resume, re-fit with the same
  // multi-pass settle used for rotation so a later pass lands on the real
  // dimensions and `follow` is recomputed for the actual orientation.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefit();
  });
  window.addEventListener('pageshow', scheduleRefit);

  // First, consume an in-flight signet redirect callback if one's on the URL —
  // returning from signet with auth params persists a session and strips them
  // from the URL. Then fall back to restoring a stored session for normal loads.
  // auth.ts wraps every returned session's signer through the global
  // serialised signEvent queue, so heartbeat + replay chunks + ghost
  // publishes + claim signs are gated one-at-a-time through bark/bunker
  // instead of racing. No extra wrapping needed here.
  state.session = (await handleAuthCallback()) ?? (await tryRestore());
  // Kick off profile fetch in the background — UI updates when it lands
  if (state.session) {
    void import('./profile.js').then(({ fetchProfile, getCachedProfile }) => {
      const cached = getCachedProfile(state.session!.pubkey);
      if (cached) state.profile = cached;
      void fetchProfile(state.session!.pubkey).then(p => { if (p) state.profile = p; });
    });
  }
  // NIP-07 extensions sometimes inject `window.nostr` after page load —
  // tryRestore at boot can land before the extension is ready, leaving us
  // with an auth-only stub session. Watch for the signer to come online and
  // upgrade transparently.
  watchForSignerUpgrade();

  // Duel mode: open a peer connection if the URL has the `?peer=` triplet.
  // Initial failure logs to the console and falls back to solo; the peer
  // class auto-reconnects on a subsequent unexpected drop and replays the
  // recent local input ring on reconnect so the partner's input log can
  // refill the gap.
  if (mpMode && mpUrl && mpSession) {
    peer = new WebSocketPeer();
    // Expose the peer to the E2E test hooks so the runner can pull the
    // wire trace + counters on failure. Type-only cast because the Peer
    // interface intentionally omits the diagnostic methods.
    __testHooks.peerRef = peer as unknown as { getWireTrace?: () => unknown[]; getWireCounters?: () => unknown };
    // Surface a "Connecting" placeholder so the player isn't staring at a
    // blank canvas while peer.connect() blocks on the partner's arrival.
    // simulateStart's clearOverlay() removes this once peer-joined fires.
    const connectKind = urlCoopCampaignModeActive() ? 'coop-campaign' : urlDeathmatchModeActive() ? 'deathmatch' : 'duel';
    renderDuelConnecting(mpSlot, requestedPeerPlayers, false, connectKind);
    try {
      await peer.connect({
        url: mpUrl,
        session: mpSession,
        localSlot: mpSlot,
        players: requestedPeerPlayers,
        batchFrames: shouldBatchPeerFrames(),
        aiFill: aiFillDeathmatch,
        humanSlots: requestedHumanSlots,
      });
      // Freeze the broker-negotiated adaptive input delay BEFORE going active,
      // so frame 0 already runs at the session-agreed value. AI-filled sessions
      // are not adapted (their late-takeover handoff is tuned to the static
      // tier), so skip the await entirely — this keeps that fragile path's
      // startup timing byte-for-byte identical to the pre-adaptive code.
      if (!aiFillDeathmatch) {
        await captureNegotiatedInputDelay(() => peer?.getNegotiatedInputDelay?.() ?? null);
      }
      setPeerActive(true);
      // Resolve rollback eligibility once, now the transport + slot are bound.
      // Synchronous (no async boundary), so the aiFill startup timing the
      // negotiation await is carefully kept clear of is unaffected here too.
      resolveRollbackActive();
      // Replay hook: after a successful reconnect (NOT the initial connect),
      // re-send our local slot's most recent input frames so the partner
      // can backfill the input log over the drop. The remote does the same
      // for us. Sized to the disconnect threshold so even a near-fatal
      // drop is recoverable if the socket comes back.
      peer.setOnReconnected?.(() => {
        if (!peer || !inputLog) return;
        const last = inputLog.latest(mpSlot);
        if (last < 0) return;
        const from = Math.max(0, last - PEER_STALL_DISCONNECT_FRAMES);
        for (let f = from; f <= last; f++) {
          const encoded = inputLog.get(f, mpSlot);
          if (encoded >= 0) peer.sendFrame(f, encoded);
        }
        // eslint-disable-next-line no-console
        console.log(`[duel] reconnected; replayed local frames ${from}..${last}`);
      });
      // eslint-disable-next-line no-console
      console.log('[duel] connected to', mpUrl, 'session', mpSession, 'as slot', mpSlot);
      // Auto-IGNITE on both clients the moment peer-joined fires. Both
      // sims kick off from the SAME session-derived seed (mpSeed) so the
      // shared arena matches frame-for-frame. The microtask defers past
      // the title render so the overlay can be cleared cleanly.
      queueMicrotask(() => { simulateStart(); });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[duel] peer connect failed; falling back to solo:', e);
      peer = null;
      setPeerActive(false);
    }
  }

  // Spectate mode (M5): open a peerwatch socket and run the lockstep loop
  // in read-only mode. No local input sampling; both slots' inputs are
  // drained from the broker tap. The session-derived seed (spectateSeed)
  // matches what the peers are using so the spectator's arena lines up
  // with theirs from frame 0.
  if (spectateMode && mpUrl && spectateSession) {
    spectator = new SpectatorPeer();
    const connectKind = urlCoopCampaignModeActive() ? 'coop-campaign' : urlDeathmatchModeActive() ? 'deathmatch' : 'duel';
    renderDuelConnecting(0, requestedPeerPlayers, true, connectKind);
    try {
      await spectator.connect({ url: mpUrl, session: spectateSession, players: requestedPeerPlayers, aiFill: aiFillDeathmatch });
      // Spectators run the same lockstep loop and must use the identical
      // session delay, or their sim diverges from the players'. AI-filled
      // sessions are not adapted, so skip the await there (byte-identical path).
      if (!aiFillDeathmatch) {
        await captureNegotiatedInputDelay(() => spectator?.getNegotiatedInputDelay?.() ?? null);
      }
      setPeerActive(true);
      // Spectators never run rollback (resolveRollbackActive requires a peer and
      // !spectator); call it anyway to keep the rollback state cleared.
      resolveRollbackActive();
      // eslint-disable-next-line no-console
      console.log('[spectate] watching', spectateSession, 'via', mpUrl);
      // Auto-IGNITE so the read-only sim starts at the same wall time the
      // peers are starting. Same microtask trick the duel path uses to
      // clear the connecting overlay cleanly.
      queueMicrotask(() => { simulateStart(); });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[spectate] connect failed:', e);
      spectator = null;
      setPeerActive(false);
    }
  }

  // Preload and decode the first campaign backgrounds plus asteroid surface
  // textures so a desktop/walk-up player does not see art pop in after IGNITE.
  // Mobile waits in startRunFromAction instead, keeping the boot network quiet.
  if (!mobileRuntimeActive()) void warmCriticalCampaignAssets();

  // Fetch server-driven gameplay config (bonus_wave_chance etc.) in
  // the background. Fire-and-forget — the cached default (1.0) keeps
  // pre-config behaviour intact if the request fails or arrives after
  // the player's first run. Skip on the controller surface; the pad
  // never consults game-config.
  if (!isControllerSurface()) {
    void import('./faucet.js').then(({ fetchGameConfig, fetchGameInfo }) => {
      void fetchGameConfig();
      // Also prime GameInfo so the ADMIN button on the title's
      // session panel knows whether to render. isAdminSession reads
      // cachedGameInfo.admin_pubkey, which lands here.
      void fetchGameInfo();
    });
  }

  // Optional diagnostic only. Real music priming happens inside the first
  // trusted gesture via musicWarmUpAll(); boot-time media preloads compete
  // with campaign art and browsers will not play them before activation.
  if (!isControllerSurface() && new URLSearchParams(window.location.search).get('preloadMusic') === '1') preloadAllTracks();

  // ?dbg=audio overlay — pinned diagnostic panel showing AudioContext
  // state + current music element state + last load failure. Enables
  // self-serve debugging of Safari-specific music issues without
  // needing devtools open.
  if (!isControllerSurface() && new URLSearchParams(window.location.search).get('dbg') === 'audio') {
    setupAudioDebugOverlay();
  }
  if (!isControllerSurface()) {
    const musicProbe = (): {
      audioContext: ReturnType<typeof audio.getAudioContextState>;
      phase: GameState['phase'];
      wave: number;
      music: ReturnType<typeof getMusicDebugSnapshot>;
    } => ({
      audioContext: audio.getAudioContextState(),
      phase: state.phase,
      wave: state.wave,
      music: getMusicDebugSnapshot(),
    });
    (window as unknown as {
      __pallasiteMusicProbe?: () => {
        audioContext: ReturnType<typeof audio.getAudioContextState>;
        phase: GameState['phase'];
        wave: number;
        music: ReturnType<typeof getMusicDebugSnapshot>;
      };
    }).__pallasiteMusicProbe = musicProbe;
    if (new URLSearchParams(window.location.search).get('musicSmoke') === '1') {
      (window as unknown as { __pallasiteMusicPoison?: () => ReturnType<typeof musicProbe> }).__pallasiteMusicPoison = () => {
        musicSetPaused(true);
        audio.suspendPlayback();
        return musicProbe();
      };
    }
  }
  if (duelDebugMode || wireTraceEnabled) setupDuelDebugOverlay();

  // 600bn flavour — prime the council manifest + member avatars so
  // wave 1 (council-textured asteroids) has its portraits ready by
  // the time IGNITE fires. maybePreloadCouncil no-ops on other
  // flavours.
  if (!isControllerSurface()) {
    void import('./sanctum-avatars.js').then(({ maybePreloadCouncil }) => {
      maybePreloadCouncil();
    });
  }

  // Touch controls — buttons reveal themselves on first real touch. The
  // callbacks raise edges; the per-step decode actually dispatches
  // tryHyperspace / tryActivateShield from the input log.
  setupTouchControls(
    state,
    (s, now) => { const p = s.players[mpSlot]; if (!p) return; edgeFlags[mpSlot].hyperspace = true; if (!isPeerActive()) tryHyperspace(s, now, p); },
    (s, now) => { const p = s.players[mpSlot]; if (!p) return; edgeFlags[mpSlot].shield = true;     if (!isPeerActive()) tryActivateShield(s, now, p); },
    () => mpSlot,
    {
      setHeading: (slot, h) => { localHeading[slot] = h; },
      setThrust:  (slot, t) => { localThrust[slot] = t; },
      setKey:     (slot, code, pressed) => { localKeys[slot][code] = pressed; },
    },
  );

  // Long-press the WAVE label on the HUD = open cheat input (mobile equivalent
  // of the `+` keyboard shortcut). Daily-run guard inside the handler.
  setupWaveLongPress();

  // Seed the body data-phase so the CSS gates evaluate correctly on first paint
  // (the loop only writes this on phase change after the first frame).
  document.body.dataset.phase = state.phase;

  // Three-screen flow on the main game host:
  //   • Fresh boot → renderAttract (logo + PLAY + footer)
  //   • PLAY → renderAuth (if no session) or renderTitle (mission select)
  //   • Game-over / post-claim → renderTitle (mission select, faster
  //     iteration for returning players)
  // Other route dispatches below (admin, watch, controller, mobile) bypass
  // this — they have their own entry surfaces.
  //
  // Duel mode also bypasses: peer.connect() has already resolved by here,
  // so the queued simulateStart() microtask is about to fire and clear
  // the overlay anyway. Skipping renderAttract avoids a one-frame flash
  // of the attract screen between peer-joined and game start.
  const autoStartLocalDeathmatch = autoStartMode && !peer && !spectator && urlDeathmatchModeActive();
  if (!peer && !spectator && !defenderMode && !autoStartLocalDeathmatch) renderAttract(state);
  if (autoStartLocalDeathmatch) {
    queueMicrotask(() => { simulateStart(); });
  }
  // Defender preview auto-starts straight into wave 1 so the player drops
  // into the scrolling arena without going through the attract / mission-
  // select funnel. simulateStart() runs the bound IGNITE callback which
  // calls clearOverlay() before the first frame.
  if (defenderMode && !peer && !spectator) {
    queueMicrotask(() => { simulateStart(); });
    // Old "PROTECT THE 600 BILLION" toast removed — DEFENDER mode is
    // being rebuilt as classic Defender (humanoids / landers /
    // smartbomb) and has no 600bn theme anymore.
  }

  // ── Live-watch / broadcast surface gate ─────────────────────────────────
  // Everything that exists purely so OTHER people can watch this run live —
  // the per-frame stream tick (entity-mapping + WebSocket publish + replay
  // capture) and the 4s presence heartbeat — is bundled behind one flag.
  //
  // On mobile this is a per-frame main-thread tax (a 60Hz setInterval plus
  // ~10Hz entity serialisation) for little product value: almost nobody
  // watches a random phone run live. So it defaults OFF on mobile and ON on
  // desktop. Overrides let us A/B the perf hit on the SAME device:
  //   ?stream=1 — force the watch surface ON anywhere (capture / debug)
  //   ?stream=0 — force it OFF anywhere
  // Trade-off when off: no live spectating AND no end-of-run kind 30764 ghost
  // replay for that device (the replay buffer fills inside the stream tick).
  const streamFlag = new URLSearchParams(window.location.search).get('stream');
  const streamingEnabled = streamFlag === '1'
    ? true
    : streamFlag === '0'
      ? false
      : !mobileRuntimeActive();
  console.log(`[stream] live-watch surface ${streamingEnabled ? 'ENABLED' : 'DISABLED'} (mobile=${mobileRuntimeActive()}, ?stream=${streamFlag ?? 'unset'})`);

  // Live-presence heartbeat — fires while a run is in progress so the
  // watch.pallasite.app surface renders LIVE cards. Ticks every 4s and
  // skips no-op repeats (same score+wave AND a previous tick less than
  // 4s ago). The first heartbeat of a new run fires immediately even
  // mid-throttle so the player appears on watch within a few seconds
  // of IGNITE. NIP-98-authed POST; failures are swallowed.
  const HEARTBEAT_PHASES: ReadonlySet<string> = new Set([
    'playing', 'wavestart', 'warp', 'paused', 'deathreplay',
  ]);
  const HEARTBEAT_MIN_GAP_MS = 4_000;
  let lastHeartbeatRunId: string | null = null;
  let lastHeartbeatAt = 0;
  const fireHeartbeat = (): void => {
    if (!state.session) return;
    if (!HEARTBEAT_PHASES.has(state.phase)) return;
    if (state.runStartedAt <= 0) return;
    // Skip until the run has actually produced something to show — saves
    // a 0/0 publish in the first instant of wavestart before wave bumps
    // to 1. As soon as the player has any score or has entered wave 1+,
    // we start broadcasting.
    if (state.wave < 1 && state.players[0].score <= 0) return;
    const runId = String(state.runStartedAt);
    const now = Date.now();
    const sameRun = runId === lastHeartbeatRunId;
    if (sameRun && now - lastHeartbeatAt < HEARTBEAT_MIN_GAP_MS) return;
    lastHeartbeatRunId = runId;
    lastHeartbeatAt = now;
    void postHeartbeat(state.session, {
      score: state.players[0].score,
      wave: state.wave,
      started_at: Math.floor(state.runStartedAt / 1000),
      run_id: runId,
      mode: currentMode(),
    });
  };
  if (streamingEnabled) window.setInterval(fireHeartbeat, 4_000);

  // Live-stream session (NIP-53 + kind 22769 frames) — the "Twitch
  // stream key" pattern. Master signs a kind 30311 Live Activities
  // event ONCE at run start authorising a fresh ephemeral session
  // pubkey. The session key signs every frame locally (no signer
  // round-trip during play). 2 Hz pose telemetry; watch.pallasite.app
  // viewers render the ship in lockstep.
  let activeStream: ActiveStreamSession | null = null;
  let streamingRunId: string | null = null;
  let streamStartInFlight = false;
  /** Runs whose startStreamSession returned null (signer rejected the
   *  NIP-53 kind 30311, all relays bounced it, etc). Tracked so the
   *  tickStream loop doesn't retry every 16ms forever — each retry
   *  hits clearReplayBuffer at the top of startStreamSession and wipes
   *  the frames captured between the prior retry's resolve and the
   *  current tick, leaving the kind 30764 publish with only a handful
   *  of frames at game-over. */
  const streamFailedRunIds = new Set<string>();
  /** Wall-ms of the most recent frame captured via captureReplayFrame
   *  on the no-activeStream fallback path. Used to throttle the
   *  fallback at the same cadence as activeStream.lastFramePublishedAt
   *  does for the WS publish path. */
  let lastFrameCapturedAt = 0;
  let lastObservedRunId: string | null = null;
  const STREAM_PHASES: ReadonlySet<string> = new Set([
    'playing', 'wavestart', 'warp', 'bonus', 'paused', 'deathreplay',
  ]);
  const MOBILE_STREAM_FRAME_INTERVAL_MS = 100;
  const MOBILE_REPLAY_SAMPLE_MS = 100;
  const DESKTOP_REPLAY_SAMPLE_MS = 33;

  const activeStreamCadenceMs = (slowPhase: boolean): number => {
    if (slowPhase) return STREAM_FRAME_INTERVAL_PAUSED_MS;
    return mobileRuntimeActive() ? MOBILE_STREAM_FRAME_INTERVAL_MS : STREAM_FRAME_INTERVAL_MS;
  };

  const activeReplaySampleMs = (): number =>
    mobileRuntimeActive() ? MOBILE_REPLAY_SAMPLE_MS : DESKTOP_REPLAY_SAMPLE_MS;

  const tickStream = (): void => {
    if (!state.session) return;
    if (state.runStartedAt <= 0) return;
    const inRun = STREAM_PHASES.has(state.phase);
    const runId = String(state.runStartedAt);

    // New run — clear the replay buffer so a previous run's frames
    // don't bleed into this one's blob upload.
    if (runId !== lastObservedRunId) {
      lastObservedRunId = runId;
      beginReplayRun(runId);
    }

    // Game over for the prior run — tear down the stream key + flag
    // the NIP-53 event as ended. The session privkey is wiped from
    // memory before the master signs the status=ended update.
    if (!inRun && activeStream && streamingRunId === runId) {
      const ended = activeStream;
      const master = state.session;
      activeStream = null;
      streamingRunId = null;
      endStreamSession(ended);
      if (master) void publishStreamEnded(master, ended);
      return;
    }

    // New run — generate the session key, get the master to sign the
    // NIP-53 event. Guarded by streamStartInFlight so a slow signer
    // doesn't fire-multiple times across consecutive ticks. Skipped
    // entirely once a run has been marked failed — the capture
    // fallback path below still runs so kind 30764 fills.
    if (
      inRun && !activeStream && streamingRunId !== runId && !streamStartInFlight
      && !streamFailedRunIds.has(runId)
    ) {
      streamStartInFlight = true;
      void (async () => {
        if (!state.session) { streamStartInFlight = false; return; }
        const started = await startStreamSession(state.session, runId, {
          startedAtMs: state.runStartedAt,
        });
        if (started) {
          activeStream = started;
          streamingRunId = runId;
        } else {
          // Permanent fail for this run — capture-only mode from here.
          streamFailedRunIds.add(runId);
          console.warn(`[stream] startStreamSession permanently failed for run ${runId} — replay buffer will still fill via captureReplayFrame, but no live WS spectators`);
        }
        streamStartInFlight = false;
      })();
      // Don't return early here — fall through to the capture path so
      // frames from the in-flight window AND the subsequent failure
      // case still land in the replay buffer. The capture path is
      // idempotent (subsample throttled) so a same-tick double-fire
      // is harmless.
    }

    // Mid-run frame — sign locally with the session key, push to the
    // experimental relay. Skip until we have a wave to broadcast (no
    // 0/0 pre-wave frames). The frame snapshots ship pose AND all
    // non-decorative entities (asteroids / UFOs / mines / bullets)
    // so the watch viewer can render the full game world, not just
    // the ship.
    // Capture path runs whenever the player is in-run + signed in,
    // regardless of activeStream — that way the kind 30764 replay
    // buffer fills even if NIP-53 signEvent failed (some signers
    // reject kind 30311). WS publish only fires when activeStream is
    // actually set up.
    if (inRun && state.session && (state.wave >= 1 || state.players[0].score > 0)) {
      const now = Date.now();
      // Lighter cadence during pause AND wave transitions — nothing
      // gameplay-relevant changes between frames during paused / warp /
      // wavestart (the warp animation is local to the player's canvas,
      // entities are despawning or spawning off-screen). Drops the wire
      // from 60Hz to 1Hz for ~1.3s of warp + 200ms of wavestart per
      // wave change — saves ~75 frames per inter-wave gap. The watcher
      // freezes on the last gameplay frame and pops its wave banner
      // when the new wave's first frame lands.
      const slowPhase = state.phase === 'paused'
        || state.phase === 'warp'
        || state.phase === 'wavestart';
      const cadence = activeStreamCadenceMs(slowPhase);
      const lastAt = activeStream ? activeStream.lastFramePublishedAt : lastFrameCapturedAt;
      const cadenceSlack = Math.min(50, Math.max(4, cadence * 0.1));
      if (now - lastAt < cadence - cadenceSlack) return;
      const replaySampleMs = activeReplaySampleMs();

      // Asteroid type → single-letter code matching what the stream
      // wire expects. Original four: s/i/c/p. Newer types use chars
      // outside that set so the decoder stays unambiguous:
      //   b = carbonaceous (black-ish primitive)
      //   m = mesosiderite (stony-iron mix)
      //   a = achondrite   (basaltic/HED)
      const ASTEROID_TYPE_CODE: Record<string, 's' | 'i' | 'c' | 'p' | 'b' | 'm' | 'a' | 'k' | 'v' | 'l' | 't' | 'o'> = {
        stony: 's', iron: 'i', chondrite: 'c', pallasite: 'p',
        carbonaceous: 'b', mesosiderite: 'm', achondrite: 'a',
        kinetic: 'k', volatile: 'v', ballast: 'l', tektite: 't', lodestone: 'o',
      };
      const ASTEROID_SIZE_CODE: Record<string, 'l' | 'm' | 's'> = {
        large: 'l', medium: 'm', small: 's',
      };
      const UFO_TYPE_CODE: Record<string, 's' | 'p' | 't' | 'e' | 'c' | 'b'> = {
        saucer: 's', sniper: 'p', tank: 't', elite: 'e', cruiser: 'c', boss: 'b',
      };
      const POWERUP_TYPE_CODE: Record<string, 'r' | 'b' | 'n' | 't' | 'm'> = {
        rapid: 'r', satboost: 'b', nova: 'n', trident: 't', magnet: 'm',
      };
      const COIN_KIND_CODE: Record<string, 's' | 'd'> = { sat: 's', dust: 'd' };

      const asteroids = (state.asteroids ?? [])
        .filter((a) => a.alive)
        .slice(0, 32)
        .map((a) => [
          a.id ?? 0,
          a.pos.x, a.pos.y,
          ASTEROID_SIZE_CODE[a.size] ?? 's',
          ASTEROID_TYPE_CODE[a.type] ?? 's',
          a.rot,
        ] as [number, number, number, 'l' | 'm' | 's', 's' | 'i' | 'c' | 'p' | 'b' | 'm' | 'a' | 'k' | 'v' | 'l' | 't' | 'o', number]);

      const ufos = (state.ufos ?? [])
        .filter((u) => u.alive)
        .slice(0, 8)
        .map((u) => [u.id ?? 0, u.pos.x, u.pos.y, UFO_TYPE_CODE[u.type] ?? 's', Math.max(0, Math.min(255, u.hp ?? 1))] as [number, number, number, 's' | 'p' | 't' | 'e' | 'c' | 'b', number]);

      const mines = (state.mines ?? [])
        .filter((m) => m.alive)
        .slice(0, 8)
        .map((m) => [m.id ?? 0, m.pos.x, m.pos.y] as [number, number, number]);

      // Bullets — separate player vs enemy via the existing arrays
      // so the viewer can colour them differently. Velocity included so
      // the viewer can extrapolate between frames — bullets move ~500
      // px/sec and snap visibly between 4Hz frame samples without it.
      const playerBullets = (state.bullets ?? []).filter((b) => b.alive).slice(0, 24);
      const enemyBullets = (state.enemyBullets ?? []).filter((b) => b.alive).slice(0, 24);
      const bullets: Array<[number, number, number, number, number, 0 | 1]> = [];
      for (const b of playerBullets) bullets.push([b.id ?? 0, b.pos.x, b.pos.y, b.vel.x, b.vel.y, 0]);
      for (const b of enemyBullets) bullets.push([b.id ?? 0, b.pos.x, b.pos.y, b.vel.x, b.vel.y, 1]);

      // Coins — both sat (₿) and dust shards. sourceType '' for non-asteroid
      // origins (mine/UFO drops). Capped at 32 — vein engagements can spawn
      // a lot, but anything beyond 32 visible is decorative noise.
      const coins = (state.coins ?? [])
        .filter((c) => c.alive && !c.collected)
        .slice(0, 32)
        .map((c) => [
          c.id ?? 0, c.pos.x, c.pos.y,
          COIN_KIND_CODE[c.kind] ?? 's',
          c.sourceType ? ({
            stony: 's', iron: 'i', chondrite: 'c', pallasite: 'p',
            carbonaceous: 'b', mesosiderite: 'm', achondrite: 'a',
            kinetic: 'k', volatile: 'v', ballast: 'l', tektite: 't', lodestone: 'o',
          } as const)[c.sourceType] : '',
        ] as [number, number, number, 's' | 'd', 's' | 'i' | 'c' | 'p' | 'b' | 'm' | 'a' | 'k' | 'v' | 'l' | 't' | 'o' | '']);

      // Powerups — rare, usually 0-2 on screen. Cap at 4 anyway.
      const powerups = (state.powerups ?? [])
        .filter((p) => p.alive && !p.collected)
        .slice(0, 4)
        .map((p) => [p.id ?? 0, p.pos.x, p.pos.y, POWERUP_TYPE_CODE[p.type] ?? 'r'] as [number, number, number, 'r' | 'b' | 'n' | 't' | 'm']);

      const p0 = state.players[0];
      const frame = {
        t: now,
        x: p0.ship?.pos?.x ?? 0,
        y: p0.ship?.pos?.y ?? 0,
        r: p0.ship?.rot ?? 0,
        score: p0.score,
        wave: state.wave,
        // Lives + sats so the watch HUD reflects the same numbers the
        // player sees. lives drops with each ship-destroyed; sats
        // climbs with each ₿ pickup.
        lives: p0.lives ?? 0,
        sats: p0.sats ?? 0,
        thrust: p0.ship?.thrusting === true,
        alive: p0.ship?.alive !== false,
        shielded: p0.ship?.shieldUp === true,
        paused: state.phase === 'paused',
        phase: state.phase,
        nextWave: state.phase === 'warp' ? (state.warpTargetWave ?? undefined) : undefined,
        // Skin code — single-letter mapping mirrors the wire schema's
        // 'd' | 'i' | 'h' union so the watcher renders the same cosmetic.
        skin: ((): 'd' | 'i' | 'h' => {
          const id = getActiveSkinId();
          return id === 'ironclad' ? 'i' : id === 'halo' ? 'h' : 'd';
        })(),
        mode: (getRenderModeKind() === 'modern' ? 'm' : 'r') as 'r' | 'm',
        asteroids,
        ufos,
        mines,
        bullets,
        coins,
        powerups,
        // SFX events accumulated since the last frame — drained here
        // so the live viewer can replay them in sync.
        events: drainStreamEvents(),
      };
      if (activeStream) {
        void publishStreamFrame(activeStream, frame, { replaySampleMs });
      } else {
        // No live-stream session (NIP-53 sign failed or in-flight) —
        // still capture into the replay buffer so the kind 30764
        // publish at game-over has frames to ship.
        captureReplayFrame(frame, { sampleMs: replaySampleMs });
        lastFrameCapturedAt = now;
      }
    }
  };
  // Gated: on mobile this 60Hz timer + its 10Hz entity serialisation is the
  // suspected frame-time tax. When the watch surface is off we never even
  // register the interval, so there's zero per-frame cost — not just an early
  // return. ?stream=1 re-arms it for capture/debug.
  if (streamingEnabled) window.setInterval(tickStream, STREAM_FRAME_INTERVAL_MS);

  // Route dispatch — query-param, path-based, and hostname-based surfaces.
  // Title renders first so the shared boot wiring (music, scoreboard subs,
  // bfcache hooks) still runs; the overlay then clears and the route's
  // own panel owns the screen until the user backs out.
  const isAdmin = new URLSearchParams(window.location.search).has('admin');
  if (isAdmin) {
    document.body.dataset.surface = 'admin';
    renderAdminPanel();
  } else if (window.location.hostname.startsWith('watch.')) {
    // Auto-open used to fire here when exactly one player was live;
    // dropped because the path bypassed every user gesture and iOS
    // Safari then locked out audio for the rest of the page. With the
    // hero-tile layout the spectator now lands on a page that shows
    // who's live + a one-tap path into the full theatre, so auto-open
    // costs sound for no real ergonomic win.
    document.body.dataset.surface = 'watch';
    renderWatchPage(state);
  } else if (window.location.hostname.startsWith('mobile.')) {
    // mobile.pallasite.app — bookmarkable controller. Same render as
    // /controller but lives on its own subdomain so it can install as
    // an "Add to Home Screen" PWA without dragging the whole game
    // bundle's chrome along with it visually. Swap to the
    // controller-specific manifest so the installed app gets the
    // Kempston joystick icon + "Pallasite Controller" name + locked
    // landscape orientation.
    const mfst = document.querySelector('link[rel=manifest]');
    if (mfst) mfst.setAttribute('href', '/controller-manifest.webmanifest');
    const themeMeta = document.querySelector('meta[name=apple-mobile-web-app-title]');
    if (themeMeta) themeMeta.setAttribute('content', 'Controller');
    // iOS Safari uses apple-touch-icon for "Add to Home Screen", NOT
    // the manifest icon list. Swap it to the Kempston rasterised PNG
    // so the installed PWA gets the joystick icon on iPhone home
    // screens (Chromium PWA installs honour the manifest icons).
    const atIcon = document.querySelector('link[rel="apple-touch-icon"]');
    if (atIcon) atIcon.setAttribute('href', '/kempston-apple-touch.png');
    document.body.dataset.surface = 'controller';
    renderControllerPage(state);
  } else {
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path === '/jury') {
      document.body.dataset.surface = 'jury';
      renderJuryPage(state);
    } else if (path === '/controller') {
      document.body.dataset.surface = 'controller';
      renderControllerPage(state);
    } else if (path === '/admin') {
      // NIP-98 + pubkey-allowlist admin panel. Server enforces the
      // allowlist on every action; the client just renders whatever
      // the GET /api/admin/v2/state response is. Non-admin lands on
      // a "not authorised" message and a back link.
      document.body.dataset.surface = 'admin';
      renderAdminV2Panel(state);
    } else if (path === '/duel') {
      // Duel lobby: HOST flow (generate session + invite URL + QR) and
      // JOIN flow (paste an invite URL). Once a partner navigates to the
      // resulting `?peer=…&session=…&slot=…` URL on the apex domain, the
      // game's peer-joined handler auto-IGNITEs both sides. The lobby
      // never opens a peer itself, so this route is isolated from the
      // game's solo path.
      document.body.dataset.surface = 'duel';
      renderDuelLobby();
    } else if (path === '/event') {
      document.body.dataset.surface = 'event';
      renderEventLobby(state);
    } else if (path === '/sanctum-preview' || path === '/sanctum') {
      // Legacy standalone Sanctum surfaces — the parallel game-loop
      // approach didn't feel like Pallasite, so the 600bn experience
      // is now layered into wave 1 of the standard campaign instead.
      // Redirect old URLs to root where the 600bn attract picks up.
      window.location.replace('/');
    } else {
      // Default surface = the game itself (root path on the apex domain).
      document.body.dataset.surface = 'game';
    }
  }

  // bfcache restore: a player who taps SIGN IN, opens the Signet redirect,
  // then hits browser-back without completing returns to a frozen page that
  // still has the SDK dialog in the DOM. The dialog is opaque to clicks even
  // when not visually obvious, so the title screen below is unresponsive.
  // Two-sided defence:
  //   - pagehide (persisted=true): the page is about to enter bfcache.
  //     Strip the dialog now so the cached page state is clean.
  //   - pageshow (persisted=true): the page is being restored. Strip again
  //     in case pagehide didn't fire (some browsers skip it on redirect)
  //     and re-render the title to reset the sign-in panel's `signing`
  //     flag to a fresh closure that can be tapped again.
  window.addEventListener('pagehide', e => {
    if (!e.persisted) return;
    sweepSignetArtefacts();
  });
  window.addEventListener('pageshow', e => {
    if (!e.persisted) return;
    sweepSignetArtefacts();
    if (state.phase === 'title') renderTitle(state);
  });

  // Once the user makes any audio-unlocking gesture (start, sign-in, settings,
  // even pressing M), the title music will start playing on its own via the
  // game-loop call to musicSetTrackForState. No need to play it before unlock —
  // browsers block it anyway.

  setupServiceWorker();

  // Independent of the SW path so non-SW browsers also get an authoritative
  // chip on the title screen.
  void checkForUpdate();

  // Ask the running SW (if one is controlling this page) what
  // SW_VERSION it shipped under. Lands on the title chip next to the
  // git short SHA so a stale-SW suspicion ("did the new worker take?")
  // is answered at a glance. Skipped silently on first cold-load when
  // no controller exists yet; the controllerchange handler below will
  // ask again once the new worker takes over.
  void querySwVersion();

  requestAnimationFrame(loop);
}

/**
 * Watch for a signer to become available after boot and silently upgrade
 * an auth-only session into a fully-signing one. Two scenarios:
 *
 *   - NIP-07: extensions (Alby, nos2x) sometimes inject `window.nostr`
 *     after the page has loaded — the initial tryRestore() lands us with
 *     an auth-only stub; we wait for the extension to wake up.
 *   - Bunker: NIP-46 reconnection over the relay can be slow; the SDK's
 *     restoreSession may return an auth-only session if the bunker hasn't
 *     responded yet, and we re-call to give it more chances.
 *
 * The watcher polls indefinitely (cheap — one setTimeout every 500ms).
 * Bounded retry windows previously caused players whose extension was
 * slow to load to be stuck auth-only after a page refresh.
 */
function watchForSignerUpgrade(): void {
  const POLL_FAST_MS = 250;        // tight cadence for the first ~10s
  const POLL_FAST_UNTIL_MS = 10_000;
  const POLL_SLOW_MS = 2_000;      // back off after the burst — cheap forever
  const startedAt = Date.now();
  let upgrading = false;

  const reschedule = (): void => {
    const elapsed = Date.now() - startedAt;
    const next = elapsed < POLL_FAST_UNTIL_MS ? POLL_FAST_MS : POLL_SLOW_MS;
    window.setTimeout(() => void tick(), next);
  };

  const tick = async (): Promise<void> => {
    const sess = state.session;
    if (!sess) {
      // No session yet — the user may sign in manually. Keep polling so
      // a delayed restore (rare) doesn't strand us.
      reschedule();
      return;
    }
    if (sess.signer.capabilities.canSignEvents) return;  // already upgraded — stop polling
    if (upgrading) { reschedule(); return; }

    // 'redirect' here can be either a genuine same-tab-redirect-only login
    // (can't be upgraded without a fresh user-initiated sign-in) OR a
    // signet-login soft-downgrade of a 'nip07' session whose underlying
    // window.nostr wasn't injected yet at boot. The SDK keeps the original
    // method in localStorage across the runtime downgrade, so a retry
    // tryRestore() once window.nostr appears will recreate a real Nip07Signer.
    // Bunker sessions get re-upgraded the same way — SDK reconnects to the
    // bunker URI. Try restore for all three; the genuine-redirect case is
    // a cheap no-op.
    if (sess.method !== 'nip07' && sess.method !== 'bunker' && sess.method !== 'redirect') {
      reschedule();
      return;
    }

    // nip07 + downgraded-redirect both need window.nostr to be present
    // before tryRestore() can produce a signing signer. Skip until the
    // extension wakes up.
    const needsNostr = sess.method === 'nip07' || sess.method === 'redirect';
    if (needsNostr && !(window as { nostr?: unknown }).nostr) {
      reschedule();
      return;
    }

    upgrading = true;
    try {
      const upgraded = await tryRestore();
      if (upgraded?.signer.capabilities.canSignEvents
          && upgraded.pubkey === sess.pubkey) {
        // tryRestore already wraps the signer through the global sign queue.
        state.session = upgraded;
        // Profile was tied to the stub session; refetch under the new
        // signer just in case kind 0 caching differs (cheap, returns
        // immediately if already cached).
        void import('./profile.js').then(({ fetchProfile, getCachedProfile }) => {
          if (!state.session) return;
          const cached = getCachedProfile(state.session.pubkey);
          if (cached) state.profile = cached;
          void fetchProfile(state.session.pubkey).then(p => {
            if (p && state.session?.pubkey === p.pubkey) state.profile = p;
          });
        });
        if (state.phase === 'title') renderTitle(state);
        return;
      }
    } catch { /* ignore — try again on the next tick */ }
    finally { upgrading = false; }
    reschedule();
  };
  window.setTimeout(() => void tick(), POLL_FAST_MS);
}

/**
 * Register the service worker and wire up the new-version detection. When a
 * fresh worker reaches 'installed' state alongside an existing controller,
 * surface the update banner; on confirmation, post SKIP_WAITING + listen for
 * controllerchange to trigger a single clean reload.
 */
/** Pinned duel diagnostic overlay activated via ?duel-debug=1. Surfaces
 *  the lockstep liveness so on-device "the sims are drifting" complaints
 *  can be triaged without dev-tools: state.frame, peer/spectator
 *  receive-frame high-water mark, slot log latest, last canary hash. */
function setupDuelDebugOverlay(): void {
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px',
    'z-index:99999', 'pointer-events:none',
    'background:rgba(0,0,0,0.8)', 'color:#ffd84a',
    'padding:6px 9px', 'border-radius:4px',
    'font:11px/1.4 ui-monospace,monospace',
    'letter-spacing:0.04em', 'max-width:60vw',
    'border:1px solid rgba(255,216,74,0.45)',
    'white-space:pre',
  ].join(';');
  document.body.appendChild(panel);
  let lastDrainCount = 0;
  let totalRecv = 0;
  window.addEventListener('pallasite:peer-frame-drain', (ev) => {
    const d = (ev as CustomEvent<{ count: number }>).detail;
    lastDrainCount = d.count;
    totalRecv += d.count;
  });
  const render = (): void => {
    const debug = peerDebugSnapshot();
    const localLatest = inputLog ? inputLog.latest(mpSlot) : -1;
    let remoteLatest = -1;
    if (inputLog) {
      remoteLatest = Infinity;
      for (let i = 0; i < inputLog.players; i++) {
        if (i !== mpSlot) remoteLatest = Math.min(remoteLatest, inputLog.latest(i));
      }
      if (remoteLatest === Infinity) remoteLatest = -1;
    }
    const peerLast = peer ? peer.lastReceivedFrame() : (spectator ? -2 : -3);
    const peerConn = peer ? peer.isConnected() : (spectator ? spectator.isConnected() : false);
    panel.textContent = [
      `frame:${state.frame}  slot:${mpSlot}/${requestedPeerPlayers}  conn:${peerConn ? 'Y' : 'N'}`,
      `delay:${debug.inputDelay}f  gap:${debug.localRemoteFrameGap ?? '-'}  spread:${debug.slotFrameSpread ?? '-'}`,
      `local#:${localLatest} peersMin#:${remoteLatest}`,
      `peer.lastRx:${peerLast}  drain/s:${lastDrainCount}  total:${totalRecv}`,
      `stall:${debug.stallFrames}f count:${debug.stallCount} max:${debug.maxStallFrames}f`,
      `resend:${debug.resendCount}/${debug.resendFrameCount}  desync:${peerDesyncFrame < 0 ? '-' : peerDesyncFrame}`,
      `phase:${state.phase}  wave:${state.wave}  seed:${state.seed?.toString(16) ?? '-'}`,
    ].join('\n');
    lastDrainCount = 0;
  };
  render();
  window.setInterval(render, 500);
}

/** Pinned audio diagnostic overlay activated via ?dbg=audio. Polls every
 *  500ms to surface AudioContext state, the current track's element
 *  state (paused, readyState, networkState, error code/message) and
 *  the last load-failure event. The point is "tell me why Safari is
 *  silent" without having to open Web Inspector. Lives until reload. */
function setupAudioDebugOverlay(): void {
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px',
    'z-index:99999', 'pointer-events:auto', 'cursor:pointer',
    'background:rgba(0,0,0,0.75)', 'color:#7fffea',
    'padding:6px 8px', 'border-radius:4px',
    'font:11px/1.35 ui-monospace,monospace',
    'letter-spacing:0.04em', 'max-width:60vw',
    'border:1px solid rgba(127,255,234,0.4)',
    'white-space:pre',
  ].join(';');
  panel.title = 'tap to copy';
  document.body.appendChild(panel);
  // Tap to copy the whole panel to the clipboard — the diagnostic is otherwise
  // un-selectable over the game canvas, so there was no easy way to paste it.
  panel.addEventListener('click', () => {
    const text = panel.textContent ?? '';
    const done = (): void => {
      const prev = panel.style.borderColor;
      panel.style.borderColor = '#7fffaa';
      const note = '\n\n[copied ✓]';
      const base = text;
      panel.textContent = base + note;
      window.setTimeout(() => { panel.style.borderColor = prev; }, 900);
    };
    try {
      void navigator.clipboard?.writeText(text).then(done, () => {
        // Fallback for non-secure contexts / clipboard denial.
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch { /* ignore */ }
        ta.remove();
      });
    } catch { /* ignore */ }
  });

  let lastFailMsg = '';
  let lastDiagMsg = '';
  window.addEventListener('pallasite:music-load-failed', (ev) => {
    const d = (ev as CustomEvent<{ id: string; src: string; code?: number; msg?: string }>).detail;
    lastFailMsg = `LOAD-FAIL ${d.id} src=${d.src} code=${d.code ?? '-'} ${d.msg ?? ''}`;
  });
  window.addEventListener('pallasite:music-blob-diag', (ev) => {
    const d = (ev as CustomEvent<{
      id: string; bytes: number; magic: string; isOgg: boolean;
      contentType: string; canPlayOpus: string;
    }>).detail;
    lastDiagMsg = `BLOB ${d.id} ${d.bytes}b magic=${d.magic}/${d.isOgg ? 'ogg' : '!ogg'} ctype=${d.contentType} canPlayOpus=${d.canPlayOpus}`;
  });

  const render = (): void => {
    const ctxState = audio.getAudioContextState();
    const snap = (window as unknown as { __mDbg?: () => unknown }).__mDbg
      ? (window as unknown as { __mDbg: () => unknown }).__mDbg()
      : null;
    void snap;
    // Import the snapshot lazily — dynamic import keeps the static
    // graph clean and lets Vite tree-shake if dbg is ever ripped out.
    import('./music.js').then(({ getMusicDebugSnapshot }) => {
      const s = getMusicDebugSnapshot();
      panel.textContent = [
        `audio.ctx: ${ctxState}`,
        `canPlayOpus: ${new Audio().canPlayType('audio/ogg; codecs=opus') || '(empty)'}`,
        `canPlayAAC:  ${new Audio().canPlayType('audio/mp4; codecs=mp4a.40.2') || '(empty)'}`,
        `track: ${s.currentId ?? '-'}`,
        `paused: ${s.paused ?? '-'}   failed: ${s.failedFlag ?? '-'}`,
        `readyState: ${s.readyState ?? '-'}   networkState: ${s.networkState ?? '-'}`,
        `errCode: ${s.errorCode ?? '-'}   ${s.errorMsg ?? ''}`.trimEnd(),
        `loaded#: ${s.loadedCount}`,
        `src: ${s.src ?? '-'}`,
        lastFailMsg ? `last: ${lastFailMsg}` : '',
        lastDiagMsg ? `diag: ${lastDiagMsg}` : '',
      ].filter(Boolean).join('\n');
    }).catch(() => undefined);
  };
  render();
  window.setInterval(render, 500);
}

function setupServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
    if (!reg) return;

    // Reload exactly once when a new worker takes control.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });

    const promptIfWaiting = (): void => {
      const waiting = reg.waiting;
      if (!waiting) return;
      if (!navigator.serviceWorker.controller) return;
      // Auto-update on safe surfaces (watch page, controller PWA, jury,
      // title screen, gameover) — the user shouldn't have to chase a
      // banner. Mid-run shows the banner so we don't yank a play in
      // progress. The visibility check lets the player resume after a
      // suspend without the banner appearing immediately on focus.
      const host = window.location.hostname;
      const path = window.location.pathname.replace(/\/+$/, '');
      const isPassivePage =
        host.startsWith('watch.') || host.startsWith('mobile.') ||
        path === '/jury' || path === '/controller';
      const phase = state?.phase;
      const inActivePlay = phase === 'playing' || phase === 'wavestart'
        || phase === 'warp' || phase === 'paused' || phase === 'deathreplay';
      if (isPassivePage || !inActivePlay) {
        waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
      showUpdateBanner(() => waiting.postMessage({ type: 'SKIP_WAITING' }));
    };

    promptIfWaiting();

    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed') promptIfWaiting();
      });
    });

    // Long-lived sessions get a periodic update check so a deploy from
    // yesterday isn't silently sat on for hours.
    setInterval(() => {
      reg.update().catch(() => { /* ignore */ });
      void checkForUpdate();
      void querySwVersion();
    }, 60 * 1000);

    // Re-check on PWA foreground — iOS suspends background tabs for hours,
    // so the visibility transition is the right moment to refresh the
    // "do I have the latest?" answer the user can see in the chip.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      reg.update().catch(() => { /* ignore */ });
      void checkForUpdate();
      void querySwVersion();
    });
  }).catch(() => { /* registration failures are non-fatal */ });
}

void boot();
