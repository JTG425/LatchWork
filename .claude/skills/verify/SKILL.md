---
name: verify
description: Build, launch, and drive the Latchwork logic simulator to verify editor/engine changes end-to-end.
---

# Verifying Latchwork

Next.js app; the whole product is the `/` page (SVG circuit editor). No test suite — verify by driving the canvas.

## Build & launch

```bash
npm install          # first time only
npm run build        # Auth0 env-var warnings are expected noise
npm start            # serves http://localhost:3000
```

Auth is optional; the simulator works anonymously (chips/board in localStorage).

## Driving it (Playwright)

Install `playwright` in a scratch dir and launch with the pre-installed browser:
`chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })`.

- **Seed exact circuits** instead of simulating drag-drop: `page.addInitScript` setting
  `localStorage['latchwork.board.v1']` (Board JSON: `{comps, wires}`, see `lib/engine.ts`)
  and `latchwork.chips.v1` (ChipDef[]). Gotcha: init scripts re-run on `page.reload()`
  and clobber localStorage again — use a fresh context per scenario.
- **Coordinates**: view starts at identity, so client = board `getBoundingClientRect()`
  origin + world coords. Comps snap to a 20px grid.
- **Interactions**: click a comp body to select (switches/IPINs toggle on click-without-drag);
  click pin → pin to wire; palette items place via pointerdown + move onto canvas + up;
  selected chips expose a `[data-resize]` corner grip.
- **Assertions**: query the rendered SVG — `.wire.hi`, `.junction`, `[data-pin^="<id>|in"]`,
  `.chipbody` width/height, `.lbl` captions. Board saves to localStorage ~400ms after changes.

## Flows worth driving

1. Wire a switch to an LED at the same y (perfectly straight) and toggle it high — the wire must stay visible.
2. Fan one output into 2+ wires — expect a `.junction` dot at the pin.
3. Select a gate → titlebar `#ningrp` sets 2–4 inputs; select a Clock → `#freqgrp` sets Hz.
4. IPIN/OPIN → "Save as chip" → place from palette → pin labels appear on the chip; drag the corner grip to resize.
5. Fresh visitor (no localStorage) gets the SR-latch seed board; pressing SET latches Q.
