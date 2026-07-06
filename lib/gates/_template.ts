/* ─────────────────────────────────────────────────────────────────────
   TEMPLATE — starting point for a new logic gate.

   How to add a gate:
     1. Copy this file to lib/gates/<name>.ts (e.g. xnor.ts).
     2. Rename the export, fill in every field below, and delete these
        instructions.
     3. Register it in lib/gates/index.ts: import it and add it to
        GATE_DEFS (its key becomes the gate's CompType string, and its
        position in GATE_DEFS sets its palette order).

   That's it — the type union, palette entry, simulation, canvas
   rendering, and palette icon are all driven by the registry. This
   file itself is never imported, so it has no effect on the app.
   ──────────────────────────────────────────────────────────────────── */
import { GateDef, TWO_IN, ONE_OUT } from './types';

export const TEMPLATE: GateDef = {
  /* Display name in the palette and under the gate on the canvas. */
  name: 'TEMPLATE',

  /* Palette subtitle — usually the boolean expression, e.g. 'A · B'. */
  sub: 'describe me',

  /* true → the user can raise the input count to 2–4 and the engine
     recomputes pin positions. Use false for fixed-input gates (NOT). */
  multiIn: true,

  /* Footprint in px (grid is 20). The standard gate body is 60×40. */
  w: 60,
  h: 40,

  /* Pin positions relative to the body's top-left corner; pins sit one
     grid step outside the body. TWO_IN / ONE_OUT are the standard
     2-in / 1-out layout — replace with explicit points if you need
     something else, e.g. ins: [{ x: -20, y: 20 }]. */
  ins: TWO_IN,
  outs: ONE_OUT,

  /* The truth function — THE MATH LIVES HERE. `ins` holds one 0/1
     value per input pin, in pin order; return the single 0/1 output.
     Examples:
       AND:  ins => (ins.every(v => v) ? 1 : 0)
       XOR:  ins => ins.reduce((a, v) => a ^ v, 0)                    */
  eval: ins => (ins.every(v => v) ? 1 : 0),

  /* SVG path for the body. `h` is the pin span height (40 by default,
     taller when the user picks 3–4 inputs). Draw from −8 to h+8
     vertically so input stubs enter the back edge cleanly; keep the
     output tip at x ≈ 56–60 so the output stub meets it. */
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M4,${t} H30 C52,${t} 60,${m - 16} 60,${m} C60,${m + 16} 52,${b} 30,${b} H4 Z`;
  },

  /* Optional: inversion bubble on the output side (NAND/NOR/NOT).
     Uncomment and position just past the body tip. */
  // bubble: h => ({ cx: 60, cy: h / 2, r: 4 }),

  /* Optional: extra stroke-only path behind the body (XOR's second
     back curve). */
  // backCurve: h => `M2,-8 C12,${h / 2 - 12} 12,${h / 2 + 12} 2,${h + 8}`,

  /* Where input stubs terminate under the body fill: 8 for a straight
     back edge (AND/NAND/NOT), 12 for a curved one (OR/NOR/XOR). */
  stubX: 8,

  /* Optional: caption baseline y for the 40px body; defaults to h + 21.
     Only needed when the body is unusually short (NOT uses 50). */
  // captionY: 50,
};
