/* Shared shapes for logic-gate definitions (lib/gates/*).
   This file deliberately imports nothing from the engine so gate files
   and the engine can both depend on it without an import cycle. */

export interface GatePin { x: number; y: number }

/* Inversion bubble drawn on the output side (NOT / NAND / NOR). */
export interface GateBubble { cx: number; cy: number; r: number }

/* One primitive logic gate. Everything specific to a gate — its truth
   function, pin layout, and SVG artwork — lives in its own file so a
   logic or geometry bug can be chased in isolation. */
export interface GateDef {
  /* Display name in the palette and under the gate on the canvas. */
  name: string;
  /* Palette subtitle, usually the boolean expression (e.g. 'A · B'). */
  sub: string;
  /* true → the user can raise the input count to 2–4; the engine then
     recomputes pin positions from the taller pin span. NOT is the one
     gate that stays fixed at a single input. */
  multiIn: boolean;
  /* Default footprint and pin layout (before rotation / input-count
     changes). Coordinates are relative to the body's top-left corner;
     pins sit one grid step (20px) outside the body. */
  w: number;
  h: number;
  ins: GatePin[];
  outs: GatePin[];

  /* The truth function. `ins` holds one 0/1 value per input pin, in
     pin order; return the single 0/1 output. This is the place to look
     when a gate computes the wrong value. */
  eval(ins: number[]): number;

  /* SVG path for the gate body. `h` is the pin span height (40 by
     default, taller for 3–4 inputs); the shape overshoots to −8…h+8 so
     input stubs enter the back edge at the classic positions. */
  body(h: number): string;

  /* Optional inversion bubble on the output side. */
  bubble?(h: number): GateBubble;

  /* Optional extra stroke-only path behind the body (XOR's second
     back curve). */
  backCurve?(h: number): string;

  /* Where input stubs terminate under the body fill (x offset).
     Straight-backed gates use 8; curve-backed gates need 12 so the
     stub tucks under the concave edge. */
  stubX: number;

  /* Caption baseline y for the default 40px body. Omit to use the
     standard h + 21 (below the body). */
  captionY?: number;
}

/* Standard layouts shared by the classic 2-in / 1-out gates. */
export const TWO_IN: GatePin[] = [{ x: -20, y: 0 }, { x: -20, y: 40 }];
export const ONE_OUT: GatePin[] = [{ x: 80, y: 20 }];
