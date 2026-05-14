# Mobile testing without a real phone

For pallasite / 600bn / the controller PWA, the floating-origin joystick and the d-pad nav are the surfaces where the deploy-and-pray cycle hurts most. This is how to catch as much as possible on desktop before shipping to real devices.

## What desktop emulation catches

- Visual layout, safe-area-inset rendering, orientation switches.
- Touch math: pointerdown / pointermove / pointerup paths.
- Floating-origin stick: drag the cursor and confirm the knob lands where the cursor lands, not where the pad ring is.
- Snap-back animation timing.
- visibilitychange behaviour (tab switch).
- Module load failures, console errors, build hash mismatches.
- Service worker install / update flow (DevTools → Application).

## What desktop emulation does NOT catch

- Multi-touch (mouse is single-pointer; Chrome's multi-touch emulator helps but isn't real).
- Haptic feel (no haptics on desktop).
- Real-finger ergonomics: where your thumbs actually reach, accidental palm contact, the "ran out of pad" feeling.
- iOS Safari-specific quirks (edge-swipe gestures, pinch-zoom, the audio-context unlock dance).
- Home indicator overlap on a physical iPhone in landscape.
- Battery / wake-lock behaviour under real load.
- Network conditions on cellular.

Don't claim a mobile-specific change is verified until a thumb on a real device has actually pressed it.

## Quick path: Chrome DevTools mobile emulation

```bash
pnpm dev
```

Default URL: `http://localhost:5180`. Then in Chrome:

1. DevTools (Cmd+Option+I).
2. Toggle device toolbar (Cmd+Shift+M).
3. Pick "iPhone 14 Pro" or "Pixel 7" from the device dropdown.
4. Rotate icon at top-right to switch portrait / landscape.
5. The 3-dot menu in device toolbar exposes:
   - **Touch input** (already on by default in device mode)
   - **Show device frame** (helps visualise safe-area)
   - **Show rulers**
   - **Add custom device** (for unusual aspect ratios)

To verify the floating-origin stick:
- Pick iPhone 14 Pro, portrait.
- Joystick mode active.
- Click-drag anywhere in the pad's circular area, knob should appear under the cursor immediately, not snap to the pad centre.
- Release, knob animates back to centre over 120ms.

## Multi-touch emulation

Chrome's mouse-only touch emulator can't fake two simultaneous touches. If you need to verify dual-stick or multi-finger behaviour:

- Firefox has "Responsive Design Mode" with "Simulate touch events" + "Two-finger gesture mode" (Cmd+drag = pinch, Shift+drag = second finger). Limited but better than nothing.
- BrowserStack / Sauce Labs / LambdaTest expose real device farms via VNC if you don't have hardware to hand.

## Real-device debugging over USB

For iPhone:

1. Settings, Safari, Advanced, Web Inspector, ON.
2. Plug into Mac with USB-C.
3. Safari, Develop, your iPhone, page name.
4. Full DevTools (inspector, console, network) on the live page.

For Android:

1. Settings, Developer options, USB debugging.
2. Chrome on desktop, `chrome://inspect/#devices`.
3. Inspect the running tab.

The PWA installed to home screen runs in its own webview; you can inspect it the same way as a tab.

## Pallasite-specific gotchas

- `pallasite.app` is the production deploy. `localhost:5180` is dev. There is no staging.
- The PWA service worker (`public/sw.js`) installs on first visit and persists. If a change isn't taking effect: DevTools, Application, Service Workers, Unregister, then hard reload.
- The phone-as-controller PWA route is `/controller?...` (see `src/ui.ts` `isControllerSurface()` for the detection).
- The 600bn cross-promo lives at `https://600b.pallasite.app`, same `dist/` as pallasite.app but `getFlavour()` switches by hostname.

## What to test before any joystick / touch change ships

| Test | Where | Real-device only? |
|------|-------|-------------------|
| Knob follows cursor on touchdown | DevTools mobile | No |
| Knob snaps back smoothly on release | DevTools mobile | No |
| Heading mode rotates the ship correctly | DevTools mobile | No |
| Thrust engages past threshold | DevTools mobile | No |
| Tap fires once without engaging stick | DevTools mobile | No |
| visibilitychange synthesises release | Switch tabs while pressing | No |
| Edge-of-screen swipe doesn't exit | Real iPhone, swipe from left edge | Yes |
| Haptic on thrust / tap feels right | Real phone | Yes |
| Dual-thumb (left stick + right buttons) | Real phone | Yes |
| Home indicator doesn't overlap controls | Real iPhone in landscape | Yes |
| Wake lock holds during gameplay | Real phone | Yes |
