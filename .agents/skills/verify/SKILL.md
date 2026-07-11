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
  origin + world coords. Comps snap to a 20px grid. Wires are `{ id, a, b, via? }` where an
  end is a pin `{comp, side, pin}`, a split `{wire, x, y}`, or a free point `{x, y}`; signal
  values resolve per net (OR of all output pins on connected wires). Gotcha: Playwright's
  CDP mouse never fires native `dblclick` — use the same-dot-twice path instead.
- **Interactions**: click a comp body to select (switches/IPINs toggle on click-without-drag);
  selecting anything slides in the right-hand `#inspector` sidebar with its options (name,
  bits, inputs, edge, freq, rotate/delete, chip peek/edit) — allow ~400ms for the slide-in
  animation before querying inside it. Click pin → click empty grid dots (waypoints) → click
  pin to route a wire; drag empty space for marquee multi-select; ⌘/Ctrl+C/V copy-paste
  (paste lands at cursor); palette items arm a stamp mode on click (every canvas click places
  one; esc or re-click disarms); scroll pans, ctrl+scroll/pinch zooms, space- or middle-drag
  pans; selected chips expose a `[data-resize]` corner grip. R (or the sidebar Rotate button)
  rotates the selection in quarter turns; W (or the Wire button) toggles the wire tool — with
  it on, any grid dot or existing wire (split) can start/end a wire, and clicking the same
  dot twice ends a wire in the air. Double-clicking a placed chip opens the live "peek"
  popup (`.peekdialog`, tabs: live internals / package editor); deleting a palette chip asks
  for confirmation in a dialog first.
- **Assertions**: query the rendered SVG — `.wire.hi`, `.junction`, `.marquee`, `.wirestop`,
  `.comp.selected`, `[data-pin^="<id>|in"]`, `.chipbody` width/height, `.lbl` captions.
  Board saves to localStorage ~400ms (debounced) after changes — wait comfortably past it
  before reading persisted state, or assert on the DOM. Dialogs/sidebar/toast animate via
  motion/react — give them a few hundred ms before counting elements.

## Flows worth driving

1. Wire a switch to an LED at the same y (perfectly straight, one `M… L…` segment) and toggle it high — the wire must stay visible.
2. Fan one output into 2+ wires — expect a `.junction` dot at the pin.
3. Select a gate → sidebar `#ningrp` sets 2–4 inputs; select a Clock → the Frequency field + Hz/kHz/MHz unit select sets its speed.
4. IPIN/OPIN → "Save as chip" (pick a package shape / drag pins to any edge) → place from palette → pin labels appear on the chip; drag the corner grip to resize.
5. Fresh visitor (no localStorage) gets the SR-latch seed board; pressing SET latches Q.
6. Double-click a placed custom chip → `.peekdialog` live view lights internal wires per the instance's inputs; "Package & pins" tab edits layout/shape.
7. Palette chip row hover buttons: `▣` moves it into a folder (`.folderpop`), `i` opens the inspector report (now with a package editor), `×` asks before deleting.
