# Graphics and playability review — 8 September 2026

The existing game already has textured space backgrounds, a 3D ship/asteroid pipeline, varied campaign set pieces and a four-stage Forge encounter. The most useful improvements were clearer targets and warnings, better impact effects, responsive framing and a real performance fallback.

## Changes in this worktree

- The release gate required refreshing the vendored Signet Login bundle from 0.14.2 to published 0.14.3. The npm tarball SHA-256 matched its GitHub release, and the bundle drift check passed. This patch fixes the pubkey supplied to bunker sign-event requests.
- Fresh desktop installs use the modern viewport presentation. Saved retro preferences remain available.
- Lit explosions use a bounded sprite cache instead of rebuilding radial gradients for individual particles. High quality adds velocity-aligned spark trails; lower budgets sample cosmetic particles without removing enemies or bullets.
- Eagle Station and Forge pods have slimmer tungsten-coloured armour and smaller emissive lenses. Individual targets and breaches are visible in both the mesh and shaded renderers.
- Reactor conduits, rotating containment rings and a contracting charge indicator give the Forge a more readable silhouette and attack wind-up. Reduced motion keeps the warning while stopping its contraction/rotation, spark trails and the full-screen victory flash.
- Boss readouts show core health, remaining Forge pods, phase and the next action. HUD/radar render above the independent WebGL surface, so a mesh cannot paint over the instructions.
- The Forge spawn moves up the diagonal approach so the pilot begins clear of the steering thumb on a short portrait phone.
- Boss encounters use a compact score/lives row and top status panel. Portrait and landscape cameras frame the pilot and actual shell bounds inside space reserved clear of the HUD and touch controls. The portrait radar sits above the controls instead of across the Forge.
- Automatic native fullscreen is disabled on iOS Safari: on the physical phone it reported an 812px layout while clipping the controls at roughly 678px. Browser play retains the visible viewport; installed PWAs retain their existing fullscreen surface.
- Wide boss views centre the complete arena without drawing unnecessary neighbouring WebGL scenes. The final co-op check passed with 812 matching frames after removing that extra rendering work.
- Reused asteroid IDs invalidate the mesh cache when the entity kind changes, preventing a previous rock mesh from appearing as a reactor core during a restart or test jump.
- The Forge commits its next pulse deadline after taking damage. Moving into another health band cannot suddenly advance a scheduled attack. The warning lasts 900ms. The deadline is part of rollback state and the wave-25 desync canary.
- Touch controls release on cancellation, focus loss, backgrounding, rotation and input-mode changes. Cancelled joystick taps do not fire. Separate touch sources share key ownership, so releasing a tap cannot cancel held FIRE. Controls fit a 320px phone without overlapping one another.
- Menus respect notch/home-indicator margins and retain their natural height when scrolling. Title utilities sit above the logo, PLAY precedes rotating extras, and a compact two-column landscape mission selector keeps IGNITE visible. Guest-name keys and graphics settings fit narrow phones; wrapped hints no longer overlap subsequent rows.
- Settings rows fit narrow screens and expose AUTO, HIGH, BALANCED and LOW performance choices.
- Loss of a WebGL context activates shaded rendering until restoration. Browsers without WebGL remain playable.

## Performance policy

| Budget | Maximum DPR | Maximum backing pixels per canvas | Drawn cosmetic particles | Rendering |
| --- | ---: | ---: | ---: | --- |
| High | 2 | 3.2 million | 600 | Saved art style, light sprites, spark trails, optional filters |
| Balanced | 1.5 | 1.8 million | 240 | Saved art style, reduced optional effects |
| Low | 1 | 0.9 million | 100 | Shaded fallback for mesh selections; inactive WebGL surface stops drawing |

Pixel limits allow a small rounding difference at the canvas edge. The HUD, world and WebGL canvases share dimensions. Cosmetic budgets never change collision geometry, bullet density, attack timing or simulation inputs.

AUTO samples playing frames. Sustained slow frames lower quality; sustained healthy frames can restore it on ordinary 60Hz screens. Recovery probes back off after failure. Background/paused time does not train the governor. Stored art selections survive the low-quality fallback and return at higher quality.

The former recovery threshold required frames faster than 13ms, so a healthy 60Hz device could never restore effects. The former low-cost path also left all mesh driver work active. Both problems are addressed.

A local Chromium profile identified SwiftShader software rendering. In a warmed Forge run, manually forcing High produced a 33.4ms median / 82.4ms p95; Low produced 17.4ms / 34.8ms. Auto subsequently produced 17.3ms / 33.9ms and recovered mesh rendering. These are short measurements on a busy development Mac, with moving campaign entities, not device certification or a promise of 60fps. Raw evidence: `tools/record-out/presentation/warm-profile.json`.

## Verification

- `pnpm test`: existing determinism, lockstep, peer, regression, rollback and wave-start harnesses, plus the new Forge harness.
- Forge checks exercise easy/normal/hard: dormant core, first warning, health-band transition, pulse release, rollback/resimulation, render independence, meltdown, chase, a real bullet killing the core, and cleanup/finale effects.
- `pnpm test:quality`: sustained load, recovery at 60Hz, probe backoff, resume handling and isolated timing spikes.
- `pnpm test:presentation`: desktop, 320px/390px phones, iPad, portrait and short 812 × 303 landscape WebKit contexts, and Chromium with WebGL disabled. Checks real menu entry, quality changes, pixel budgets, touch lifecycle, real Chromium multi-touch, rotation, boss phases, context loss/restoration and settings fit. Screenshots and results are in `tools/record-out/presentation/`.
- `pnpm test:menus`: title, identity chooser, guest keyboard, long names, mission selection and settings at 320px, portrait/landscape iPhone, iPad and desktop sizes. Checks nested overlay width, individual controls, initially visible PLAY/landscape IGNITE, and scrolling to the last settings action. Landscape includes the physical phone's safe margins; remote services and fonts are blocked to exercise the fallback font.
- `pnpm test:e2e`: real two-page WebSocket play, mirrored movement, advancing simulation and no desync/stall. Local faucet services are absent, so this is not a payout or backend acceptance test.
- `pnpm test:coop-campaign --forge`: two real connected clients start from an identical damaged-core fixture, with HIGH graphics on desktop and LOW in portrait. Hundreds of shared simulation frames agree through repeated core pulses, with no desync. The fixture changes only the test-served development module; production has no new boss-skip hook.
- `pnpm test:render`: both multiplayer ships contribute visible pixels. The old assertion counted only nearly white pixels and rejected the existing green/blue player colours; the check now compares the scene with and without ships, with an empty-region control.
- `pnpm build` includes TypeScript validation. The existing large-chunk/mixed-import warnings remain.
- `pnpm run check:signet-login` verifies the committed login bundle.

## Physical iPhone testing

After USB connection and enabling Remote Automation, Safari WebDriver connected to the physical iPhone 13 Pro Max running iOS/Safari 26.6.1 (`safari:useSimulator=false`). The LAN development build loaded, WebGL initialised and the real PLAY → CAMPAIGN → IGNITE journey reached gameplay. The boss check then jumps to wave 25 with an invulnerable, unranked guest fixture; it is not a full campaign completion or payment test.

User feedback and device screenshots exposed two issues missed by viewport emulation: the Forge HUD/radar crowded the encounter, and native fullscreen clipped the bottom controls. Both were changed. A fresh physical run after the fixes stayed out of native fullscreen at 375 × 678 CSS pixels. The joystick and FIRE button both ended at y=664, inside the visible viewport. Captures are in `tools/record-out/iphone/forge-portrait-fixed.png`; the earlier fullscreen captures retain the clipping evidence.

After reconnecting USB, a fresh physical session completed four trusted FIRE presses and releases. It recorded 121 simulation display frames with FIRE held, then confirmed release, no browser errors, no fullscreen entry and an unchanged 375 × 678 viewport at scale 1. Both controls ended at y=664 inside the visible viewport. Evidence: `tools/record-out/iphone/fire-retry.json` and `portrait-fire-pass.png`.

The physical Forge fixture also completed its pulse warning, meltdown and chase checks. Chase cancelled the pulse deadline and removed containment wells, with no browser errors (`boss-phases.json` and `physical-*.png`). These are controlled phase checks, not a complete campaign or hands-on difficulty assessment.

A corrected physical quality sample exercised the actual running module: HIGH and AUTO used mesh rendering with 882,837 backing pixels; LOW used shaded rendering with 248,570 pixels. Each mode recorded about ten seconds of frame timings after a short warm-up. All three had a 17ms median and 17ms p95, with 0/2/0 frames over 33.4ms respectively and no browser errors (recorded in the session tool output; the original `profile.json` was subsequently overwritten by the landscape sample). This is a short iPhone 13 Pro Max sample, not thermal/endurance testing or evidence for older phones. An earlier discarded sample imported an unversioned duplicate of Vite's hot-reloaded settings module; the helper now resolves the active timestamped module URL and verifies the effective renderer/pixel count.

Safari's multi-pointer action attempt still did not provide a usable simultaneous two-finger sequence. Real-device steering plus FIRE remains unverified; Chromium's multi-touch check passes separately. A subsequent physical landscape run at 812 × 303 completed four trusted FIRE presses/releases, 120 held frames, no errors and no viewport zoom (scale stayed 1). Both thumb clusters ended at y=275, above the viewport bottom (`landscape-fire.json`, `landscape-fire-pass.png`). A short landscape quality sample again measured 17ms median/p95 for HIGH, LOW and AUTO (`profile-landscape-before-compact.json`). These physical captures predate the final shorter landscape boss HUD and menu refinements. Safari subsequently reported that Web Inspector was disabled, but the user confirmed it was enabled. Restarting the Mac-side Safari driver and opening Safari restored the physical session without a phone settings change. The error was stale. A fresh final portrait pass checked the title, identity chooser, guest keyboard, mission selector and both ends of Settings: no controls or nested overlays overflowed at 375 × 678. Four trusted FIRE presses recorded 141 held frames, released correctly, retained viewport scale 1 and produced no browser errors; both thumb clusters ended at y=664. Evidence: `final-portrait-menus.json`, `final-portrait-fire.json` and `final-portrait-*.png`. The final landscape pass also checked all six menu views without horizontal overflow at 812 × 303. Four trusted FIRE presses recorded 140 held frames, released correctly and retained scale 1 without errors or fullscreen entry; both thumb clusters remained at y=275. Evidence: the successful six-menu measurements are in the session tool output, and FIRE is retained in `final-landscape-fire.json` and `final-landscape-forge.png`. A later menu screenshot rerun was interrupted while the phone was in use and overwrote the menu JSON with a partial run; that partial file is not the six-menu acceptance record. The capture helper now waits for rendered frames before saving each menu. The iPad remains unavailable.

The temporary LAN preview is `http://192.168.0.104:5195/?menu=1`. Phone captures and browser-emulation results are kept separate.

## Still required before claiming device readiness

1. Confirm the oldest supported phone and iPad models. Browser viewport emulation does not reproduce their GPU, memory pressure, touch hardware or thermal behaviour.
2. Test sustained campaign play and repeated boss attempts on those devices, including app switching, browser toolbar changes, rotation, audio, gamepad input and a warm-device session. Check readability with real thumbs on the controls.
3. Review the new look and difficulty by playing, particularly the pulse wind-up and the moving-core chase. Automated phase/kill tests prove transitions, not whether a fight is fun.
4. Keep live co-op clients on matching builds. The Forge attack schedule changes simulation behaviour; an old and new client must not be treated as interchangeable. Local matching-client boss acceptance passes, but a release still needs its normal deployed smoke check.

This report records development-build and device evidence. Deployment is verified separately against the GitHub workflow and production `version.json`; the older-device and sustained-play limits above still apply. The pre-existing untracked `originals/defender-tile.png` is unrelated and excluded from this change.
