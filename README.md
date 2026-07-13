# Latchwork Auth0 build

This zip is configured to use Auth0 only. NextAuth and GitHub OAuth have been removed.

## Auth behavior

- The simulator is public. Users can build and simulate circuits without signing in.
- Anonymous users store their board and chips in browser `localStorage`.
- Auth0 users store chips in Vercel Blob under their own Auth0 `sub` path: `users/<auth0-sub>/chips.json`.
- The `/api/chips` route always derives the user from the Auth0 session. The client never chooses which user path to read or write.

## Workbench features

- **VHDL modules** — the *VHDL* titlebar button opens a **fullscreen code-editor tab** (it lives in the bottom tab bar like a sheet, one tab per module) with a line-number gutter, current-line highlight, and live compilation for a synthesizable VHDL subset (entity/ports incl. `std_logic_vector` buses, concurrent + conditional + selected assignments, processes with `rising_edge`/`falling_edge`, if/case, enum state types, generics with defaults, unsigned arithmetic). Compile errors highlight their line in the gutter and clicking one jumps the cursor there; unsaved drafts persist with the tab. Saving turns the entity into a chip whose pins are the ports. VHDL chips simulate through the compiled module (`lib/vhdl.ts`), get truth-table/FSM analysis like any chip, and double-clicking them (canvas or palette) reopens their editor tab.
- **Timing diagram** — the *Timing* titlebar button docks a waveform panel above the tab bar. Select any part and tick *Plot in timing diagram* to record it (first output pin, or first input for LEDs/output pins): 1-bit signals draw as square waves, buses as value lanes with binary/hex labels. Pause/resume, clear, and zoom the time window (1s–60s); probed parts show a small flag on the canvas.
- **Test vectors** — the timing panel's third mode drives chosen inputs (switches, buttons, input pins, values) with a per-step pattern and re-simulates the board from power-on: give each input an exact **value list** (`0, 3, 0xF, 0b1010` — repeats if the run is longer), fresh **random** n-bit values each step, or **all combinations** — every input set to it joins one binary counter that enumerates their joint truth table (e.g. an ALU's A and B, with the select bits on an explicit list). The step count auto-fills to cover the patterns, each step lasts one full cycle of the slowest clock (so edge-triggered logic latches once per step), driven inputs plot automatically alongside the probed signals, and the axis reads in step numbers.
- **Gates** — AND, OR, NOT, Buffer, NAND, NOR, XOR, XNOR; multi-input gates take 2–32 inputs and all gates operate bitwise across buses up to 64 bits.
- **7-segment display** — a one-digit display under *Output* with 8 pins (segments `a`–`g` + `dp`), each driven directly by a 1-bit signal.
- **Buses** — select any wire to set how many bits it carries from the titlebar number input; multi-bit wires draw thicker and show a live binary readout. Wires started from a bus pin pick up its width automatically.
- **Bit combiner and splitter** — the combiner packs N individual bits (MSB on top) into an N-bit bus, and the splitter expands an N-bit bus back into individual weighted bits.
- **Memory circuits** — the *Memory* palette folder includes JK Latch, SR Latch, D Latch, D Flip-Flop, SR Flip-Flop, T Flip-Flop, and Shift Register primitives. The JK/T parts default to falling-edge operation so `Q → CLK` ripple counters count cleanly.
- **Shift register (SIPO)** — serial-in, parallel-out: each clock edge shifts `D` in toward the MSB, `Q` exposes every stage as one parallel bus (live readout on the body), and `SO` (the oldest bit) cascades into the next register's `D` for longer chains. The stage count (default 8, up to 64) is set from the inspector. Hand-built chains of discrete D flip-flops (`Q → D`, shared clock) also shift one stage per edge — all flip-flops latch their pre-edge inputs simultaneously.
- **Tunnels** — name a tunnel node and it joins the net of every other tunnel with the same name, like an invisible wire. Tunnels are pure junctions: they can sit on either side of a connection.
- **Palette folders** — the side menu is organized into collapsible groups and can be resized by dragging its right edge; both persist per browser.
- **Chip folders** — the `▣` button on any saved chip files it into a named folder under *My chips* (collapsible, with counts); folders travel with the chip's saved definition.
- **Inspector sidebar** — selecting anything on the canvas slides in a panel from the right with its options (name, bus bits, input count, edge trigger, clock frequency, rotate/delete) instead of crowding the titlebar.
- **Chip peek** — double-click a placed custom chip to watch its internals simulate live with the inputs that copy is receiving; the same popup's *Package & pins* tab moves pins to any of the four edges, resizes the body, and picks a package shape (square, MUX trapezoid, ALU, or a custom outline drawn with the line tool). The package editor also appears in the chip inspector (`i`) and the Save-as-chip dialog.
- **Safe deletes** — deleting a saved chip asks for confirmation first (it also removes every placed copy).
- **Edge triggering** — select a primitive gate, clocked memory circuit, or placed custom chip to choose level-sensitive, rising-edge, or falling-edge updates. Custom chips use a pin named `CLK`/`CLOCK` as the trigger when present, otherwise their last input pin.

- **Editor tabs** — the bottom bar works like a spreadsheet's sheet tabs: `+` opens a blank canvas, double-click renames, `×` closes. All tabs (and which one was active) persist to `localStorage` (`latchwork.tabs.v1`; old single-board saves migrate automatically).
- **Chip inspector** — the `i` button on any saved chip (palette → My chips) opens an auto-generated report: the abstracted chip drawing with a toggle to view its internals, a simulated **truth table**, and for stateful chips a minimized **state machine diagram** (see `lib/analyze.ts`). The same report is shown for community chips.
- **Edit chip internals** — double-click a chip in the palette (or use *Edit internals…* from the peek popup, inspector report, or sidebar) and confirm to open its internal circuit in a new editor tab; **Update chip** in the titlebar applies the changes to every placed copy.
- **Community chips** — the *Community* button opens a storefront (80% of the screen) backed by the blob store under `communitychips/`:
  - `communitychips/index.json` — listing summaries
  - `communitychips/<id>.json` — full chip (definition + bundled nested-chip dependencies)
  - `communitychips/<id>.comments.json` — reviews
  - Anyone can browse, search, filter, and **Add to my chips**. Uploading and reviewing require an Auth0 account; the API derives the author from the session and publishes only a display name.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in the values that Vercel/Auth0 already created for you.
3. Run:

```bash
npm install
npm run dev
```

## Required environment variables

```bash
VERCEL_OIDC_TOKEN=
LATCH_BLOB_STORE_ID=
LATCH_BLOB_READ_WRITE_TOKEN=
APP_BASE_URL=https://www.latchwork.io
AUTH0_DOMAIN=
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
AUTH0_SECRET=
```

`LATCH_BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` are included because Vercel may create them, but this app only needs `LATCH_BLOB_READ_WRITE_TOKEN` at runtime for chip sync and community chips.

## Sign-in

Clicking **Sign in** redirects to Auth0's hosted login page via `/auth/login`; the session is created by `@auth0/nextjs-auth0` on the `/auth/callback` return.

## Auth0 URLs

For local development, configure these in Auth0:

```text
Allowed Callback URLs:
http://localhost:3000/auth/callback

Allowed Logout URLs:
http://localhost:3000

Allowed Web Origins:
http://localhost:3000
```

For production, add your deployed Vercel URL equivalents.
