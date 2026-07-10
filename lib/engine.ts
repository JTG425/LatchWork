import { GATE_DEFS, GATE_TYPES, GateType, isGateType } from './gates';

export const GRID = 20;
const snapG = (v: number) => Math.round(v / GRID) * GRID;
/* Center of a pin span, snapped onto the grid so single output/input
   pins of even-pin-count parts never land between two dots. */
const midRow = (h: number) => snapG(h / 2);

/* Gate types come from the lib/gates registry — one file per gate.
   SSEG = one-digit 7-segment display (8 segment inputs, a–g + dp),
   COMB = bit combiner (N individual bits → one N-bit bus, MSB first),
   SPLIT = bus splitter (one N-bit bus → N individual bits, MSB first),
   TUN  = tunnel (named wireless net link). */
export type CompType =
  | 'IN' | 'BTN' | 'ONE' | 'CLK' | 'VAL'
  | 'SRLATCH' | 'DLATCH' | 'JKFF' | 'DFF' | 'SRFF' | 'TFF'
  | GateType
  | 'OUT' | 'SSEG' | 'COMB' | 'SPLIT' | 'TUN' | 'IPIN' | 'OPIN' | 'CHIP';
export type EdgeMode = 'rise' | 'fall';

export interface Vec { x: number; y: number }

/* A wire end is a component pin, a solder split on another wire, or a
   free (dangling) point on the grid. */
export interface PinEnd { comp: string; side: 'in' | 'out'; pin: number }
export interface AttachEnd { wire: string; x: number; y: number }
export type WireEnd = PinEnd | AttachEnd | Vec;
export const isPinEnd = (e: WireEnd): e is PinEnd => (e as PinEnd).comp !== undefined;
export const isAttachEnd = (e: WireEnd): e is AttachEnd => (e as AttachEnd).wire !== undefined;

export const cloneWireEnd = (e: WireEnd): WireEnd =>
  isPinEnd(e) ? { comp: e.comp, side: e.side, pin: e.pin }
    : isAttachEnd(e) ? { wire: e.wire, x: e.x, y: e.y }
      : { x: (e as Vec).x, y: (e as Vec).y };

/* via: optional user-routed waypoints (grid-snapped), ordered a → b;
   bits: bus width (1 = plain wire). Signal values are bigints, so a
   net carries a whole bus value; `bits` sets how it's masked and
   displayed. */
export interface Wire { id: string; a: WireEnd; b: WireEnd; via?: Vec[]; bits?: number }
export const MAX_WIRE_BITS = 64;
export const BINARY_VALUE_MAX_BITS = 8;
export const clampBits = (n?: number) => {
  const v = Number.isFinite(n) ? n! : 1;
  return Math.min(MAX_WIRE_BITS, Math.max(1, Math.round(v)));
};

export interface Comp {
  id: string; type: CompType; x: number; y: number;
  on?: boolean; pressed?: boolean; label?: string; chipId?: string;
  rot?: number;           // 0 right (default), 1 down, 2 left, 3 up
  nIns?: number;          // gates: input count (2-4); bus tools: bit count (1-64)
  bits?: number;          // IPIN/OPIN/VAL: pin bus width; gates: bitwise operand width (1-64)
  val?: number | string;  // VAL / multi-bit IPIN: the driven bus value (string beyond 2⁵³)
  w?: number; h?: number; // chips & bus tools: user-resized body, grid multiples
  layout?: ChipLayout;    // COMB/SPLIT: per-instance pin placement (default auto)
  freq?: number;          // CLK: full cycles per second
  edge?: EdgeMode;         // gates/chips: update only on this clock edge
  clockPin?: number;       // optional explicit clock input index
  _ins?: bigint[];
}

/* ── bus values ─────────────────────────────────────────────────────
   Signals are bigints so 64-bit buses stay exact (JS numbers lose
   precision at 2⁵³ and native bitwise ops truncate to 32 bits).
   Comp.val persists as a plain number when it fits, else a decimal
   string — JSON can't hold bigints. */
export type BusVal = number | bigint;

export const toBigVal = (v: BusVal | string | undefined | null): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') { try { return BigInt(v); } catch { return 0n; } }
  return 0n;
};

export const storeVal = (v: bigint): number | string =>
  v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();

/* Mask a value down to n bits (the value a bus of width n carries).
   Bigint & on negatives follows two's complement, so negative inputs
   wrap the same way the old modulo arithmetic did. */
export const maskVal = (v: BusVal | string | undefined, n: number): bigint =>
  toBigVal(v) & ((1n << BigInt(clampBits(n))) - 1n);

/* Live readout text: full binary up to BINARY_VALUE_MAX_BITS, hex above that. */
export const formatBusValue = (v: BusVal | undefined, bits: number): string => {
  const width = clampBits(bits);
  const b = maskVal(v, width);
  return width > BINARY_VALUE_MAX_BITS
    ? '0x' + b.toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')
    : b.toString(2).padStart(width, '0');
};
/* Character count of formatBusValue's output for an n-bit bus. */
export const busTextChars = (n: number) => (n > BINARY_VALUE_MAX_BITS ? 2 + Math.ceil(n / 4) : n);

/* Older saves used directed { from: output pin, to: input pin } wires. */
export function normalizeWires(list: unknown): Wire[] {
  if (!Array.isArray(list)) return [];
  return list.map((w: any) => {
    if (w && w.from && w.to) {
      return {
        id: w.id,
        a: { comp: w.from.comp, side: 'out' as const, pin: w.from.pin },
        b: { comp: w.to.comp, side: 'in' as const, pin: w.to.pin },
        ...(w.via ? { via: w.via } : {}),
      };
    }
    return w as Wire;
  });
}

/* ── wire auto-routing ──────────────────────────────────────────────
   Corner points for a wire with no user waypoints. Shared by the live
   editor and the static previews so every renderer draws the same path.

   The route is computed in "signal flow" orientation (out → in); a wire
   stored in → out is reversed, routed, and flipped back. Rules:
     · endpoints aligned on x → one straight vertical segment
     · aligned on y, flowing forward (or between two free ends) → one
       straight horizontal segment — never a zig-zag
     · forward runs → classic Z dogleg at a grid-snapped middle column
     · backward between free ends → a single L corner
     · backward into/out of a pin → hook around with a clear horizontal
       run so the wire never cuts through the component bodies          */
export type EndFacing = 'in' | 'out' | 'free';
export const wireEndFacing = (e: WireEnd): EndFacing => (isPinEnd(e) ? e.side : 'free');

export function wireRouteCorners(aIn: Vec, bIn: Vec, aFace: EndFacing, bFace: EndFacing): Vec[] {
  const reversed = aFace === 'in' || (bFace === 'out' && aFace !== 'out');
  const [a, b] = reversed ? [bIn, aIn] : [aIn, bIn];
  const [fa, fb] = reversed ? [bFace, aFace] : [aFace, bFace];
  const { x: x1, y: y1 } = a, { x: x2, y: y2 } = b;
  const bothFree = fa === 'free' && fb === 'free';
  const done = (pts: Vec[]) => (reversed ? pts.reverse() : pts);

  if (x1 === x2) return done([a, b]);
  if (y1 === y2 && (x2 > x1 || bothFree)) return done([a, b]);
  if (x2 >= x1 + GRID) {
    const mx = snapG((x1 + x2) / 2);
    return done([a, { x: mx, y: y1 }, { x: mx, y: y2 }, b]);
  }
  if (bothFree) return done([a, { x: x2, y: y1 }, b]);
  const my = y1 === y2 ? y1 + GRID * 2 : snapG((y1 + y2) / 2);
  return done([
    a,
    { x: x1 + GRID, y: y1 }, { x: x1 + GRID, y: my },
    { x: x2 - GRID, y: my }, { x: x2 - GRID, y: y2 },
    b,
  ]);
}
export const wireCornerPath = (pts: Vec[]) =>
  'M' + pts.map(p => `${p.x},${p.y}`).join(' L');

/* Nets: wires joined end-to-end (including splits onto other wires)
   form one electrical node. Every input pin on a net reads the OR of
   every output pin on it. */
export interface NetInfo {
  inputDrivers: Map<string, string[]>;  // 'comp:pinIdx' → out-pin value keys 'comp:pinIdx'
  wireOuts: Map<string, string[]>;      // wire id → out-pin value keys on its net
  pinWireCounts: Map<string, number>;   // 'comp:side:pin' → wire ends attached
}

/* Tunnels: every TUN comp with the same (non-empty) name joins one
   net, as if an invisible wire connected them. Returns groups of pin
   keys for analyzeNets to union. */
export function tunnelPinGroups(comps: Comp[]): string[][] {
  const byLabel = new Map<string, string[]>();
  for (const c of comps) {
    if (c.type !== 'TUN') continue;
    const label = (c.label || '').trim();
    if (!label) continue;
    let list = byLabel.get(label);
    if (!list) { list = []; byLabel.set(label, list); }
    list.push(`p:${c.id}:in:0`);
  }
  return [...byLabel.values()].filter(g => g.length > 1);
}

export function analyzeNets(wires: Wire[], unionPins?: string[][]): NetInfo {
  const parent = new Map<string, string>();
  const add = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const root = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  const union = (x: string, y: string) => {
    add(x); add(y);
    const rx = root(x), ry = root(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  const pinWireCounts = new Map<string, number>();

  for (const w of wires) {
    add('w:' + w.id);
    for (const e of [w.a, w.b]) {
      if (isPinEnd(e)) {
        union('w:' + w.id, `p:${e.comp}:${e.side}:${e.pin}`);
        const ck = `${e.comp}:${e.side}:${e.pin}`;
        pinWireCounts.set(ck, (pinWireCounts.get(ck) || 0) + 1);
      } else if (isAttachEnd(e)) {
        union('w:' + w.id, 'w:' + e.wire);
      }
    }
  }

  if (unionPins) {
    for (const group of unionPins) {
      for (let i = 1; i < group.length; i++) union(group[0], group[i]);
    }
  }

  const outsByRoot = new Map<string, string[]>();

  for (const k of [...parent.keys()]) {
    if (!k.startsWith('p:')) continue;
    const [, comp, side, pin] = k.split(':');
    if (side !== 'out') continue;
    const r = root(k);
    let list = outsByRoot.get(r);
    if (!list) { list = []; outsByRoot.set(r, list); }
    list.push(`${comp}:${pin}`);
  }

  const inputDrivers = new Map<string, string[]>();
  const wireOuts = new Map<string, string[]>();

  for (const k of [...parent.keys()]) {
    if (k.startsWith('p:')) {
      const [, comp, side, pin] = k.split(':');
      if (side === 'in') inputDrivers.set(`${comp}:${pin}`, outsByRoot.get(root(k)) ?? []);
    } else {
      wireOuts.set(k.slice(2), outsByRoot.get(root(k)) ?? []);
    }
  }

  return { inputDrivers, wireOuts, pinWireCounts };
}

export interface Board { comps: Comp[]; wires: Wire[] }

const cloneCompForSave = (c: Comp): Comp => {
  const { _ins, ...rest } = c;
  const out: Comp = { ...rest };
  if (c.layout) out.layout = cloneChipLayout(c.layout);
  const rawVal = (c as Comp & { val?: number | string | bigint }).val;
  if (typeof rawVal === 'bigint') out.val = storeVal(maskVal(rawVal, clampBits(out.bits ?? 1)));
  return out;
};

export const cloneWire = (w: Wire): Wire => ({
  id: w.id,
  a: cloneWireEnd(w.a),
  b: cloneWireEnd(w.b),
  ...(w.via ? { via: w.via.map(v => ({ x: v.x, y: v.y })) } : {}),
  ...(w.bits ? { bits: w.bits } : {}),
});

/* Persistence-safe board clone: strips live simulator input snapshots and
   converts any stray bigint component values back to JSON-safe storage. */
export function cloneBoard(board: Board): Board {
  return {
    comps: (board.comps ?? []).map(cloneCompForSave),
    wires: normalizeWires(board.wires).map(cloneWire),
  };
}

/* Optional user-authored placement for one chip pin.
   side: which edge it sits on (Left/Right/Top/Bottom); slot: grid index
   along that edge (rows for L/R, columns for T/B); lx/ly: pixel nudge
   for the pin's name label. Older saves only ever contain L/R. */
export type PinSide = 'L' | 'R' | 'T' | 'B';
export interface PinSlot { side: PinSide; slot: number; lx: number; ly: number }
export interface ChipLayout { w: number; h: number; ins: PinSlot[]; outs: PinSlot[] }

export const cloneChipLayout = (l: ChipLayout): ChipLayout => ({
  w: l.w,
  h: l.h,
  ins: l.ins.map(p => ({ ...p })),
  outs: l.outs.map(p => ({ ...p })),
});

/* Package silhouette drawn for a placed chip. 'custom' uses shapePts —
   a user-drawn polygon stored as fractions of the body (0..1 × 0..1)
   so it scales with resizing. */
export type ChipShape = 'rect' | 'mux' | 'alu' | 'custom';
const fmt = (v: number) => Math.round(v * 10) / 10;
export function chipBodyPath(shape: ChipShape | undefined, w: number, h: number, pts?: Vec[]): string | null {
  if (shape === 'mux') {
    return `M0,0 L${w},${fmt(h * 0.18)} L${w},${fmt(h * 0.82)} L0,${h} Z`;
  }
  if (shape === 'alu') {
    return `M0,0 L${w},${fmt(h * 0.26)} L${w},${fmt(h * 0.74)} L0,${h} `
      + `L0,${fmt(h * 0.64)} L${fmt(w * 0.2)},${fmt(h * 0.5)} L0,${fmt(h * 0.36)} Z`;
  }
  if (shape === 'custom' && pts && pts.length >= 3) {
    return 'M' + pts.map(p => `${fmt(p.x * w)},${fmt(p.y * h)}`).join(' L') + ' Z';
  }
  return null;
}

export interface ChipDef {
  id: string;
  name: string;
  inputs: string[];
  outputs: string[];
  inputComps: string[];
  outputComps: string[];
  inputBits?: number[];   // per-input bus width (default 1)
  outputBits?: number[];  // per-output bus width (default 1)
  layout?: ChipLayout;    // custom pin/label placement (default auto)
  shape?: ChipShape;      // package silhouette (default 'rect')
  shapePts?: Vec[];       // 'custom' shape polygon, normalized 0..1
  folder?: string;        // palette folder ("My chips" grouping)
  comps: Comp[];
  wires: Wire[];
  createdAt: number;
}
export function sanitizeChipDef(def: ChipDef): ChipDef {
  const board = cloneBoard({ comps: def.comps ?? [], wires: def.wires ?? [] });
  return {
    ...def,
    inputs: [...(def.inputs ?? [])],
    outputs: [...(def.outputs ?? [])],
    inputComps: [...(def.inputComps ?? [])],
    outputComps: [...(def.outputComps ?? [])],
    ...(def.inputBits ? { inputBits: [...def.inputBits] } : {}),
    ...(def.outputBits ? { outputBits: [...def.outputBits] } : {}),
    ...(def.layout ? {
      layout: {
        w: def.layout.w,
        h: def.layout.h,
        ins: def.layout.ins.map(p => ({ ...p })),
        outs: def.layout.outs.map(p => ({ ...p })),
      },
    } : {}),
    ...(def.shape ? { shape: def.shape } : {}),
    ...(def.shapePts ? { shapePts: def.shapePts.map(p => ({ x: p.x, y: p.y })) } : {}),
    comps: board.comps,
    wires: board.wires,
  };
}
export const migrateChipDef = (def: ChipDef): ChipDef => sanitizeChipDef(def);
export const chipInputBits = (def: ChipDef): number[] =>
  def.inputs.map((_, i) => clampBits(def.inputBits?.[i] ?? 1));
export const chipOutputBits = (def: ChipDef): number[] =>
  def.outputs.map((_, i) => clampBits(def.outputBits?.[i] ?? 1));
export type ChipLib = Record<string, ChipDef>;
export interface SimState {
  vals: Record<string, bigint>;          // 'comp:outIdx' → driven bus value
  sub: Record<string, SimState>;
  prevIns: Record<string, number[]>;     // 0/1 snapshots for edge detection
}
export const newSimState = (): SimState => ({ vals: {}, sub: {}, prevIns: {} });

export interface Pin { x: number; y: number; name?: string; bits?: number }
export interface CompGeom { w: number; h: number; ins: Pin[]; outs: Pin[]; name: string; sub: string }

/* Segment pin order for the 7-segment display: the classic a–g ring
   plus the decimal point. */
export const SEG_NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

/* Gate geometry lives with each gate in lib/gates; PRIM only holds the
   remaining non-gate primitives. */
const PRIM: Record<Exclude<CompType, 'CHIP' | GateType>, CompGeom> = {
  IN: { name: 'Switch', sub: 'toggle 0 / 1', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  BTN: { name: 'Button', sub: 'momentary 1', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  ONE: { name: 'Constant 1', sub: 'always high', w: 40, h: 40, ins: [], outs: [{ x: 60, y: 20 }] },
  VAL: { name: 'Value', sub: 'binary constant', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20, bits: 4 }] },
  CLK: { name: 'Clock', sub: 'square wave', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  SRLATCH: {
    name: 'SR Latch', sub: 'set/reset memory', w: 80, h: 60,
    ins: [{ x: -20, y: 20, name: 'S' }, { x: -20, y: 40, name: 'R' }],
    outs: [{ x: 100, y: 20, name: 'Q' }, { x: 100, y: 40, name: 'Q̄' }],
  },
  DLATCH: {
    name: 'D Latch', sub: 'level D memory', w: 80, h: 60,
    ins: [{ x: -20, y: 20, name: 'D' }, { x: -20, y: 40, name: 'EN' }],
    outs: [{ x: 100, y: 20, name: 'Q' }, { x: 100, y: 40, name: 'Q̄' }],
  },
  JKFF: {
    name: 'JK Latch', sub: 'fall-edge J/K', w: 90, h: 80,
    ins: [{ x: -20, y: 20, name: 'J' }, { x: -20, y: 40, name: 'CLK' }, { x: -20, y: 60, name: 'K' }],
    outs: [{ x: 110, y: 20, name: 'Q' }, { x: 110, y: 60, name: 'Q̄' }],
  },
  DFF: {
    name: 'D Flip-Flop', sub: 'edge D memory', w: 90, h: 60,
    ins: [{ x: -20, y: 20, name: 'D' }, { x: -20, y: 40, name: 'CLK' }],
    outs: [{ x: 110, y: 20, name: 'Q' }, { x: 110, y: 40, name: 'Q̄' }],
  },
  SRFF: {
    name: 'SR Flip-Flop', sub: 'edge set/reset', w: 90, h: 80,
    ins: [{ x: -20, y: 20, name: 'S' }, { x: -20, y: 40, name: 'CLK' }, { x: -20, y: 60, name: 'R' }],
    outs: [{ x: 110, y: 20, name: 'Q' }, { x: 110, y: 60, name: 'Q̄' }],
  },
  TFF: {
    name: 'T Flip-Flop', sub: 'edge toggle', w: 90, h: 60,
    ins: [{ x: -20, y: 20, name: 'T' }, { x: -20, y: 40, name: 'CLK' }],
    outs: [{ x: 110, y: 20, name: 'Q' }, { x: 110, y: 40, name: 'Q̄' }],
  },
  OUT: { name: 'LED', sub: 'output', w: 40, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
  SSEG: {
    name: '7-Segment', sub: 'digit display', w: 100, h: 160,
    // one pin per segment, top to bottom: a b c d e f g dp
    ins: Array.from({ length: 8 }, (_, i) => ({ x: -20, y: i * GRID, name: SEG_NAMES[i] })),
    outs: [],
  },
  COMB: {
    name: 'Bit combiner', sub: 'N bits → bus', w: 60, h: 60,
    ins: Array.from({ length: 4 }, (_, i) => ({ x: -20, y: i * GRID })),
    outs: [{ x: 80, y: 30, bits: 4 }],
  },
  SPLIT: {
    name: 'Splitter', sub: 'bus → N bits', w: 80, h: 60,
    ins: [{ x: -20, y: 30, bits: 4, name: 'BUS' }],
    outs: Array.from({ length: 4 }, (_, i) => ({ x: 100, y: i * GRID })),
  },
  TUN: { name: 'Tunnel', sub: 'named link', w: 80, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
  IPIN: { name: 'Input pin', sub: 'chip input', w: 40, h: 40, ins: [], outs: [{ x: 60, y: 20 }] },
  OPIN: { name: 'Output pin', sub: 'chip output', w: 40, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
};

export const PALETTE_ORDER: [string, CompType[]][] = [
  ['Input', ['IN', 'BTN', 'ONE', 'VAL', 'CLK']],
  ['Gates', [...GATE_TYPES]],
  ['Memory', ['JKFF', 'SRLATCH', 'DLATCH', 'DFF', 'SRFF', 'TFF']],
  ['Output', ['OUT', 'SSEG']],
  ['Bus & routing', ['COMB', 'SPLIT', 'TUN']],
  ['Chip pins', ['IPIN', 'OPIN']],
];

/* Gates whose input count can be edited (NOT is always 1-in) */
export const MULTI_IN_GATES: ReadonlySet<CompType> = new Set(GATE_TYPES.filter(t => GATE_DEFS[t].multiIn));
export const MAX_GATE_INS = 32;
export const clampGateIns = (n?: number) => {
  const v = Number.isFinite(n) ? n! : 2;
  return Math.min(MAX_GATE_INS, Math.max(2, Math.round(v)));
};
export const isBusToolType = (type: CompType) => type === 'COMB' || type === 'SPLIT';
export const busToolMinW = (type: CompType) => (type === 'SPLIT' ? 80 : 60);
export const busToolMinH = (c: Pick<Comp, 'nIns' | 'layout'>) =>
  c.layout ? GRID * 2 : Math.max(40, (clampBits(c.nIns ?? 4) - 1) * GRID);

/* Bit-weight pin name for COMB/SPLIT bit lines — MSB first ('2³'…'2⁰'). */
const SUPS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];
export const bitWeightName = (n: number, i: number) =>
  '2' + String(n - 1 - i).split('').map(d => SUPS[+d] ?? d).join('');

export const CHIP_MIN_W = 80;
export const chipMinH = (def: ChipDef) =>
  def.layout ? GRID * 2 : (Math.max(def.inputs.length, def.outputs.length, 1) + 1) * GRID;

export const CLK_MIN_HZ = 0.1, CLK_MAX_HZ = 20;
export const clampFreq = (hz?: number) => Math.min(CLK_MAX_HZ, Math.max(CLK_MIN_HZ, hz ?? 1));

/* Pin positions from user-authored slots: pins on any of the four
   edges at explicit grid slots. Shared by chips and the bus tools. */
export function pinsFromSlots(slots: PinSlot[], names: (string | undefined)[], bits: number[], w: number, h: number): Pin[] {
  const hu = Math.round(h / GRID), wu = Math.round(w / GRID);
  return names.map((name, i) => {
    const s = slots[i] ?? { side: 'L' as const, slot: i + 1, lx: 0, ly: 0 };
    const p: Pin = s.side === 'T' || s.side === 'B'
      ? { x: GRID * Math.max(0, Math.min(wu, s.slot)), y: s.side === 'T' ? -20 : h + 20 }
      : { x: s.side === 'R' ? w + 20 : -20, y: GRID * Math.max(0, Math.min(hu, s.slot)) };
    if (name) p.name = name;
    if (bits[i] > 1) p.bits = bits[i];
    return p;
  });
}

export function chipGeom(def: ChipDef, ow?: number, oh?: number): CompGeom {
  const inBits = chipInputBits(def), outBits = chipOutputBits(def);
  const sub = `${def.inputs.length} in · ${def.outputs.length} out`;
  const withBits = (p: Pin, bits: number): Pin => (bits > 1 ? { ...p, bits } : p);

  // User-authored layout: pins on any of the four edges at explicit
  // grid slots, with label nudges. The edge also anchors the label.
  if (def.layout) {
    const L = def.layout;
    const w = Math.max(CHIP_MIN_W, Math.round((ow ?? L.w * GRID) / GRID) * GRID);
    const h = Math.max(GRID * 2, Math.round((oh ?? L.h * GRID) / GRID) * GRID);
    return {
      name: def.name, sub, w, h,
      ins: pinsFromSlots(L.ins, def.inputs, inBits, w, h),
      outs: pinsFromSlots(L.outs, def.outputs, outBits, w, h),
    };
  }

  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  const autoW = Math.ceil(Math.max(100, 24 + def.name.length * 7 + 24) / GRID) * GRID;
  const w = Math.max(CHIP_MIN_W, Math.round((ow ?? autoW) / GRID) * GRID);
  const h = Math.max(chipMinH(def), Math.round((oh ?? chipMinH(def)) / GRID) * GRID);
  // pins spread evenly over the (possibly resized) body, snapped to the grid
  const hu = h / GRID;
  const mk = (names: string[], bits: number[], x: number): Pin[] =>
    names.map((name, i) => withBits({ x, y: GRID * Math.round(((i + 1) * hu) / (rows + 1)), name }, bits[i]));
  return { name: def.name, sub, w, h, ins: mk(def.inputs, inBits, -20), outs: mk(def.outputs, outBits, w + 20) };
}

/* Where a pin's name label sits given its side (label anchoring uses
   pin.x sign in the renderers). Returned offsets come from the layout. */
export function chipLabelOffset(def: ChipDef, side: 'in' | 'out', idx: number): { lx: number; ly: number } {
  const slot = def.layout?.[side === 'in' ? 'ins' : 'outs']?.[idx];
  return { lx: slot?.lx ?? 0, ly: slot?.ly ?? 0 };
}

/* The auto layout the Save-as-chip editor starts from: inputs down the
   left edge, outputs down the right, evenly spread. w/h in grid units. */
export function defaultChipLayout(nIn: number, nOut: number, nameLen = 8): ChipLayout {
  const rows = Math.max(nIn, nOut, 1);
  const h = rows + 1;
  const w = Math.max(Math.ceil(CHIP_MIN_W / GRID), Math.ceil((48 + nameLen * 7) / GRID));
  const mk = (n: number, side: 'L' | 'R'): PinSlot[] =>
    Array.from({ length: n }, (_, i) => ({ side, slot: Math.round(((i + 1) * h) / (n + 1)), lx: 0, ly: 0 }));
  return { w, h, ins: mk(nIn, 'L'), outs: mk(nOut, 'R') };
}

/* The default pin layout a COMB/SPLIT starts from in the layout editor:
   bit lines down one edge, the bus pin on the other. */
export function busToolLayout(type: CompType, n: number): ChipLayout {
  return type === 'COMB' ? defaultChipLayout(n, 1, 4) : defaultChipLayout(1, n, 4);
}

/* Keep a bus tool's custom layout in step when its bit count changes:
   extra bit-line slots are appended on the tool's default edge, surplus
   ones are dropped. */
export function resizeBusLayout(layout: ChipLayout, type: CompType, n: number): ChipLayout {
  const key = type === 'COMB' ? 'ins' : 'outs';
  const side: PinSide = type === 'COMB' ? 'L' : 'R';
  if (layout[key].length === n) return layout;
  const next = cloneChipLayout(layout);
  const list = next[key].slice(0, n);
  while (list.length < n) list.push({ side, slot: Math.min(list.length + 1, layout.h), lx: 0, ly: 0 });
  next[key] = list;
  return next;
}

const bitRows = (n: number, h: number, x: number): Pin[] =>
  Array.from({ length: n }, (_, i) => ({ x, y: n === 1 ? midRow(h) : snapG(i * (h / (n - 1))) }));

/* Body width for a port (IPIN/OPIN/VAL) that must show its value —
   binary up to BINARY_VALUE_MAX_BITS, hex beyond. Grows with the text, always a grid
   multiple. */
export const pinPortW = (n: number) =>
  Math.max(40, Math.ceil((busTextChars(clampBits(n)) * 9 + 20) / GRID) * GRID);

export function getGeom(c: Pick<Comp, 'type' | 'chipId' | 'nIns' | 'bits' | 'w' | 'h' | 'layout'>, lib: ChipLib): CompGeom {
  if (c.type === 'CHIP') {
    const def = c.chipId ? lib[c.chipId] : undefined;
    if (def) return chipGeom(def, c.w, c.h);
    return { name: '?', sub: 'missing chip', w: 100, h: 40, ins: [], outs: [] };
  }

  if (isGateType(c.type)) {
    const gd = GATE_DEFS[c.type];
    // gates can operate bitwise on whole buses — the width rides on the pins
    const gb = clampBits(c.bits ?? 1);
    const withGB = (p: Pin): Pin => (gb > 1 ? { ...p, bits: gb } : p);
    const sub = gb > 1 ? `${gd.sub} · ${gb}-bit` : gd.sub;
    const base: CompGeom = { name: gd.name, sub, w: gd.w, h: gd.h, ins: gd.ins.map(withGB), outs: gd.outs.map(withGB) };
    if (gd.multiIn) {
      const n = clampGateIns(c.nIns);
      const h = Math.max(40, (n - 1) * GRID);
      const step = h / (n - 1);
      return {
        ...base, h,
        ins: Array.from({ length: n }, (_, i) => withGB({ x: -20, y: snapG(i * step) })),
        // even input counts put the body's center between two grid rows —
        // snap the output onto a dot so wires from it can run straight
        outs: [withGB({ x: 80, y: midRow(h) })],
      };
    }
    return base;
  }

  if (isBusToolType(c.type)) {
    // COMB: N one-bit inputs (MSB on top) → one N-bit bus output.
    // SPLIT: one N-bit bus input → N one-bit outputs (MSB on top).
    // Both can be user-resized (c.w/c.h) and carry an optional custom
    // pin layout placing every pin on any of the four edges.
    const isComb = c.type === 'COMB';
    const n = clampBits(c.nIns ?? 4);
    const base = PRIM[c.type as 'COMB' | 'SPLIT'];
    const sub = isComb ? `${n} bits → bus` : `bus → ${n} bits`;
    const bitNames = Array.from({ length: n }, (_, i) => bitWeightName(n, i));
    const ones = bitNames.map(() => 1);

    if (c.layout) {
      const L = c.layout;
      const w = Math.max(busToolMinW(c.type), Math.round((c.w ?? L.w * GRID) / GRID) * GRID);
      const h = Math.max(GRID * 2, Math.round((c.h ?? L.h * GRID) / GRID) * GRID);
      return {
        ...base, sub, w, h,
        ins: isComb ? pinsFromSlots(L.ins, bitNames, ones, w, h) : pinsFromSlots(L.ins, ['BUS'], [n], w, h),
        outs: isComb ? pinsFromSlots(L.outs, [undefined], [n], w, h) : pinsFromSlots(L.outs, bitNames, ones, w, h),
      };
    }

    const w = Math.max(busToolMinW(c.type), snapG(c.w ?? 0));
    const h = Math.max(busToolMinH(c), snapG(c.h ?? 0));
    const bits = bitRows(n, h, isComb ? -20 : w + 20).map((p, i) => ({ ...p, name: bitNames[i] }));
    const bus: Pin = { x: isComb ? w + 20 : -20, y: midRow(h), bits: n, ...(isComb ? {} : { name: 'BUS' }) };
    return {
      ...base, sub, w, h,
      ins: isComb ? bits : [bus],
      outs: isComb ? [bus] : bits,
    };
  }

  // Ports whose body widens to show an n-bit binary value.
  if (c.type === 'IPIN' || c.type === 'VAL') {
    const n = clampBits(c.bits ?? 1);
    const w = pinPortW(n);
    return { ...PRIM[c.type], w, outs: [{ x: w + 20, y: 20, ...(n > 1 ? { bits: n } : {}) }] };
  }
  if (c.type === 'OPIN') {
    const n = clampBits(c.bits ?? 1);
    const w = pinPortW(n);
    return { ...PRIM.OPIN, w, ins: [{ x: -20, y: 20, ...(n > 1 ? { bits: n } : {}) }] };
  }

  return PRIM[c.type];
}

const bit = (v: BusVal | undefined) => (v ? 1 : 0);
const MEMORY_TYPES: ReadonlySet<CompType> = new Set(['SRLATCH', 'DLATCH', 'JKFF', 'DFF', 'SRFF', 'TFF']);
const EDGE_MEMORY_TYPES: ReadonlySet<CompType> = new Set(['JKFF', 'DFF', 'SRFF', 'TFF']);
export const isMemoryType = (type: CompType) => MEMORY_TYPES.has(type);
export const defaultEdgeForComp = (c: Pick<Comp, 'type' | 'edge'>): EdgeMode | undefined => {
  if (c.edge === 'rise' || c.edge === 'fall') return c.edge;
  if (c.type === 'JKFF' || c.type === 'TFF') return 'fall';
  if (c.type === 'DFF' || c.type === 'SRFF') return 'rise';
  return undefined;
};

const defaultMemoryEdge = (c: Comp): EdgeMode => defaultEdgeForComp(c) ?? 'rise';

function memoryTriggered(c: Comp, g: CompGeom, ins: bigint[], state: SimState, fired: Set<string>): boolean {
  const pin = clockPinIndex(c, g);
  if (pin < 0) return false;
  const prev = (state.prevIns ??= {})[c.id]?.[pin];
  if (prev === undefined || fired.has(c.id)) return false;
  const before = bit(prev);
  const now = bit(ins[pin]);
  const mode = defaultMemoryEdge(c);
  const ok = mode === 'rise' ? before === 0 && now === 1 : before === 1 && now === 0;
  if (ok) fired.add(c.id);
  return ok;
}

function memoryOut(q: number, invalid = false): number[] {
  const v = bit(q);
  return invalid ? [0, 0] : [v, v ? 0 : 1];
}

function evalMemory(c: Comp, g: CompGeom, ins: bigint[], state: SimState, edgeFired: Set<string>): number[] {
  let q = bit(state.vals[c.id + ':0']);

  switch (c.type) {
    case 'SRLATCH': {
      const s = bit(ins[0]), r = bit(ins[1]);
      if (s && r) return memoryOut(q, true);
      if (s) q = 1;
      else if (r) q = 0;
      return memoryOut(q);
    }

    case 'DLATCH':
      if (bit(ins[1])) q = bit(ins[0]);
      return memoryOut(q);

    case 'JKFF':
      if (memoryTriggered(c, g, ins, state, edgeFired)) {
        const j = bit(ins[0]), k = bit(ins[2]);
        if (j && k) q = q ? 0 : 1;
        else if (j) q = 1;
        else if (k) q = 0;
      }
      return memoryOut(q);

    case 'DFF':
      if (memoryTriggered(c, g, ins, state, edgeFired)) q = bit(ins[0]);
      return memoryOut(q);

    case 'SRFF':
      if (memoryTriggered(c, g, ins, state, edgeFired)) {
        const s = bit(ins[0]), r = bit(ins[2]);
        if (s && r) return memoryOut(q, true);
        if (s) q = 1;
        else if (r) q = 0;
      }
      return memoryOut(q);

    case 'TFF':
      if (memoryTriggered(c, g, ins, state, edgeFired) && bit(ins[0])) q = q ? 0 : 1;
      return memoryOut(q);

    default:
      return [];
  }
}

/* A gate applied bit-position-wise across n-bit input buses — each
   output bit is the gate's own 1-bit truth function over that bit
   position of every input, so every registered gate (and any future
   one) gets bitwise bus behavior for free. */
function evalGateBus(type: GateType, ins: bigint[], width: number): bigint {
  const gd = GATE_DEFS[type];
  let out = 0n;
  for (let j = 0; j < width; j++) {
    const sh = BigInt(j);
    if (gd.eval(ins.map(v => Number((v >> sh) & 1n)))) out |= 1n << sh;
  }
  return out;
}

function evalPrim(c: Comp, g: CompGeom, ins: bigint[], state: SimState, edgeFired: Set<string>, now: number): BusVal[] {
  if (isGateType(c.type)) {
    // Gates are bitwise devices: width 1 (the default) is classic 1-bit
    // logic; wider gates apply the same truth function per bit position.
    const n = clampBits(c.bits ?? 1);
    if (n === 1) return [bit(GATE_DEFS[c.type].eval(ins.map(bit)))];
    return [evalGateBus(c.type, ins, n)];
  }

  if (isMemoryType(c.type)) return evalMemory(c, g, ins, state, edgeFired);

  switch (c.type) {
    case 'IN':
      return [c.on ? 1 : 0];

    case 'IPIN': {
      // 1-bit pins toggle (c.on); wider pins drive a typed bus value.
      const n = clampBits(c.bits ?? 1);
      return [n > 1 ? maskVal(c.val, n) : (c.on ? 1 : 0)];
    }

    case 'VAL':
      return [maskVal(c.val, clampBits(c.bits ?? 1))];

    case 'BTN':
      return [c.pressed ? 1 : 0];

    case 'ONE':
      return [1];

    case 'CLK': {
      const half = 500 / clampFreq(c.freq);
      return [Math.floor(now / half) % 2];
    }

    case 'COMB': {
      // first pin is the MSB
      let v = 0n;
      for (const b of ins) v = (v << 1n) | BigInt(bit(b));
      return [v];
    }

    case 'SPLIT': {
      const n = g.outs.length;
      const v = toBigVal(ins[0]);
      return Array.from({ length: n }, (_, i) => Number((v >> BigInt(n - 1 - i)) & 1n));
    }

    default:
      return [];
  }
}

const orOverKeys = (state: SimState, keys?: string[]) => {
  let v = 0n;
  if (keys) for (const k of keys) v |= state.vals[k] ?? 0n;
  return v;
};

const hasEdge = (c: Comp) => c.edge === 'rise' || c.edge === 'fall';
export const edgeableComp = (c: Pick<Comp, 'type'>) =>
  c.type === 'CHIP' || isGateType(c.type) || EDGE_MEMORY_TYPES.has(c.type);

function clockPinIndex(c: Comp, g: CompGeom): number {
  if (!g.ins.length) return -1;
  if (typeof c.clockPin === 'number' && c.clockPin >= 0 && c.clockPin < g.ins.length) {
    return Math.round(c.clockPin);
  }
  const named = g.ins.findIndex(p => /^(clk|clock)$/i.test((p.name || '').trim()));
  return named >= 0 ? named : g.ins.length - 1;
}

function heldOutputs(c: Comp, g: CompGeom, state: SimState): bigint[] {
  return g.outs.map((_, i) => state.vals[c.id + ':' + i] ?? 0n);
}

function edgeAllowsUpdate(c: Comp, g: CompGeom, ins: bigint[], state: SimState, fired: Set<string>): boolean | null {
  if (!hasEdge(c)) return null;
  const pin = clockPinIndex(c, g);
  if (pin < 0) return null;
  const prev = (state.prevIns ??= {})[c.id]?.[pin];
  if (prev === undefined || fired.has(c.id)) return false;
  const before = bit(prev);
  const now = bit(ins[pin]);
  const ok = c.edge === 'rise' ? before === 0 && now === 1 : before === 1 && now === 0;
  if (ok) fired.add(c.id);
  return ok;
}

function refreshInputSnapshots(comps: Comp[], state: SimState, lib: ChipLib, nets: NetInfo, captureInputs: boolean) {
  state.prevIns ??= {};
  for (const c of comps) {
    const g = getGeom(c, lib);
    const ins = g.ins.map((_, i) => orOverKeys(state, nets.inputDrivers.get(c.id + ':' + i)));
    if (captureInputs) c._ins = ins; else delete c._ins;
    state.prevIns[c.id] = ins.map(bit);
  }
}

/*
   Cross-coupled NAND/NOR pairs are the primitive memory cell behind SR
   latches and JK flip-flops. Pure simultaneous delta passes can bounce an
   all-zero power-on latch between two invalid states forever; old immediate
   ripple evaluation "fixed" that only by depending on component order.

   This stabilizer recognizes the explicit two-gate latch topology and
   applies the latch's stable equations after each delta pass. Set/reset
   inputs win; hold keeps an existing complementary state, and an invalid
   power-on hold gets one deterministic complementary state.
*/
function stabilizeCrossCoupledLatches(comps: Comp[], state: SimState, lib: ChipLib, nets: NetInfo): boolean {
  const byId = new Map(comps.map(c => [c.id, c]));
  let changed = false;

  const outKey = (id: string) => `${id}:0`;
  const inputKeys = (id: string, pin: number) => nets.inputDrivers.get(`${id}:${pin}`) ?? [];
  const readsFrom = (id: string, pin: number, driver: string) => inputKeys(id, pin).includes(driver);
  const inputValExcept = (id: string, pin: number, excludedDriver?: string) => {
    const keys = inputKeys(id, pin).filter(k => k !== excludedDriver);
    return bit(orOverKeys(state, keys));
  };
  const setVal = (id: string, v: number) => {
    const k = outKey(id);
    const n = BigInt(bit(v));
    if ((state.vals[k] ?? 0n) !== n) {
      state.vals[k] = n;
      changed = true;
    }
  };

  for (const a of comps) {
    if (a.type !== 'NAND' && a.type !== 'NOR') continue;
    if (hasEdge(a)) continue;
    const ga = getGeom(a, lib);

    for (let ai = 0; ai < ga.ins.length; ai++) {
      const driver = inputKeys(a.id, ai).find(k => k.endsWith(':0') && byId.get(k.slice(0, -2))?.type === a.type);
      if (!driver) continue;

      const bId = driver.slice(0, -2);
      if (a.id >= bId) continue;
      const b = byId.get(bId);
      if (!b || b.type !== a.type) continue;
      if (hasEdge(b)) continue;

      const gb = getGeom(b, lib);
      const bi = gb.ins.findIndex((_, i) => readsFrom(b.id, i, outKey(a.id)));
      if (bi < 0) continue;

      const aExternal = ga.ins.map((_, i) => inputValExcept(a.id, i, i === ai ? outKey(b.id) : undefined));
      const bExternal = gb.ins.map((_, i) => inputValExcept(b.id, i, i === bi ? outKey(a.id) : undefined));

      let nextA: number;
      let nextB: number;

      if (a.type === 'NAND') {
        const aForcedHigh = aExternal.some((v, i) => i !== ai && !v);
        const bForcedHigh = bExternal.some((v, i) => i !== bi && !v);
        if (aForcedHigh && bForcedHigh) {
          nextA = 1; nextB = 1;
        } else if (aForcedHigh) {
          nextA = 1; nextB = 0;
        } else if (bForcedHigh) {
          nextA = 0; nextB = 1;
        } else {
          const av = bit(state.vals[outKey(a.id)]);
          const bv = bit(state.vals[outKey(b.id)]);
          [nextA, nextB] = av !== bv ? [av, bv] : [0, 1];
        }
      } else {
        const aForcedLow = aExternal.some((v, i) => i !== ai && !!v);
        const bForcedLow = bExternal.some((v, i) => i !== bi && !!v);
        if (aForcedLow && bForcedLow) {
          nextA = 0; nextB = 0;
        } else if (aForcedLow) {
          nextA = 0; nextB = 1;
        } else if (bForcedLow) {
          nextA = 1; nextB = 0;
        } else {
          const av = bit(state.vals[outKey(a.id)]);
          const bv = bit(state.vals[outKey(b.id)]);
          [nextA, nextB] = av !== bv ? [av, bv] : [0, 1];
        }
      }

      setVal(a.id, nextA);
      setVal(b.id, nextB);
      break;
    }
  }

  return changed;
}

export function evaluateNet(
  comps: Comp[],
  wires: Wire[],
  state: SimState,
  lib: ChipLib,
  boundIns?: Map<string, bigint>,
  depth = 0,
  now = Date.now(),
  captureInputs = true,
): void {
  if (depth > 12) return;

  const nets = analyzeNets(wires, tunnelPinGroups(comps));
  state.prevIns ??= {};

  /*
     Important simulator fix:

     The old engine wrote each component's output directly into state.vals
     while iterating through the component list. That made feedback circuits
     depend on array order, which is especially bad for SR latches, JK
     flip-flops, and counters.

     This version computes a whole pass into nextVals, then commits all
     outputs together. That gives each pass delta-cycle behavior instead of
     immediate ripple-through behavior.
  */
  const passes = Math.min(48, Math.max(8, comps.length * 2 + 4));
  const edgeFired = new Set<string>();

  for (let k = 0; k < passes; k++) {
    const nextVals: Record<string, bigint> = {};

    for (const c of comps) {
      const g = getGeom(c, lib);
      const ins = g.ins.map((_, i) => orOverKeys(state, nets.inputDrivers.get(c.id + ':' + i)));
      if (captureInputs) c._ins = ins; else delete c._ins;

      let outs: BusVal[];
      const edgeUpdate = isMemoryType(c.type) ? null : edgeAllowsUpdate(c, g, ins, state, edgeFired);

      if (edgeUpdate === false) {
        outs = heldOutputs(c, g, state);
      } else if (c.type === 'CHIP') {
        const def = c.chipId ? lib[c.chipId] : undefined;
        outs = def
          ? evalChip(def, (state.sub[c.id] ??= newSimState()), ins, lib, depth + 1, now)
          : [];
      } else if ((c.type === 'IN' || c.type === 'BTN' || c.type === 'IPIN') && boundIns?.has(c.id)) {
        // bound values already masked to the pin's width by evalChip
        outs = [boundIns.get(c.id)!];
      } else {
        outs = evalPrim(c, g, ins, state, edgeFired, now);
      }

      for (let i = 0; i < g.outs.length; i++) {
        nextVals[c.id + ':' + i] = toBigVal(outs[i]);
      }
    }

    let changed = false;

    for (const [key, val] of Object.entries(nextVals)) {
      if ((state.vals[key] ?? 0n) !== val) {
        state.vals[key] = val;
        changed = true;
      }
    }

    if (stabilizeCrossCoupledLatches(comps, state, lib, nets)) changed = true;

    // Once a pass produces no output changes, the circuit has settled.
    if (!changed) break;
  }

  refreshInputSnapshots(comps, state, lib, nets, captureInputs);
}

export function evalChip(
  def: ChipDef,
  state: SimState,
  ins: BusVal[],
  lib: ChipLib,
  depth = 0,
  now = Date.now(),
): bigint[] {
  // Legacy chips (no per-pin bits) keep exact 1-bit-in / raw-out behavior;
  // chips saved with the pin-width feature mask to each pin's declared bus.
  const inB = def.inputBits, outB = def.outputBits;
  const bound = new Map<string, bigint>();
  def.inputComps.forEach((id, i) => bound.set(id, inB ? maskVal(ins[i], inB[i]) : BigInt(bit(ins[i]))));

  evaluateNet(def.comps, def.wires, state, lib, bound, depth, now, false);

  const nets = analyzeNets(def.wires, tunnelPinGroups(def.comps));
  return def.outputComps.map((id, i) => {
    const v = orOverKeys(state, nets.inputDrivers.get(id + ':0'));
    return outB ? maskVal(v, clampBits(outB[i])) : v;
  });
}

export interface ChipValidation { ok: boolean; reason?: string }

export function validateChipSource(board: Board): ChipValidation {
  const ins = board.comps.filter(c => c.type === 'IPIN');
  const outs = board.comps.filter(c => c.type === 'OPIN');

  if (ins.length === 0) {
    return { ok: false, reason: 'Add at least one Input pin (under “Chip pins”) — those become the chip’s input pins.' };
  }

  if (outs.length === 0) {
    return { ok: false, reason: 'Add at least one Output pin (under “Chip pins”) — those become the chip’s output pins.' };
  }

  return { ok: true };
}

const byPosition = (a: Comp, b: Comp) => (a.y - b.y) || (a.x - b.x);

/* The chip's input/output pins, in the top-to-bottom order they become
   pins. Shared so the Save-as-chip dialog and makeChipDef agree. */
export function chipPinSources(board: Board): { inComps: Comp[]; outComps: Comp[] } {
  return {
    inComps: board.comps.filter(c => c.type === 'IPIN').sort(byPosition),
    outComps: board.comps.filter(c => c.type === 'OPIN').sort(byPosition),
  };
}
export const chipPinName = (c: Comp, i: number, kind: 'in' | 'out') =>
  (c.label || `${kind === 'in' ? 'IN' : 'OUT'}${i + 1}`).slice(0, 8);

export interface ChipPackage {
  layout?: ChipLayout;
  shape?: ChipShape;
  shapePts?: Vec[];
}

export function makeChipDef(name: string, board: Board, pkg?: ChipPackage): ChipDef {
  const { comps, wires } = cloneBoard(board);

  const { inComps, outComps } = chipPinSources({ comps, wires });

  return {
    id: 'chip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    name: name.trim().slice(0, 24) || 'Chip',
    inputs: inComps.map((c, i) => chipPinName(c, i, 'in')),
    outputs: outComps.map((c, i) => chipPinName(c, i, 'out')),
    inputComps: inComps.map(c => c.id),
    outputComps: outComps.map(c => c.id),
    inputBits: inComps.map(c => clampBits(c.bits ?? 1)),
    outputBits: outComps.map(c => clampBits(c.bits ?? 1)),
    ...(pkg?.layout ? { layout: pkg.layout } : {}),
    ...(pkg?.shape && pkg.shape !== 'rect' ? { shape: pkg.shape } : {}),
    ...(pkg?.shape === 'custom' && pkg.shapePts?.length ? { shapePts: pkg.shapePts } : {}),
    comps,
    wires,
    createdAt: Date.now(),
  };
}

/* ── chip-wide bit scaling ──────────────────────────────────────────
   The width every bit-carrying part of a chip shares (gates, IPIN/OPIN
   ports, VAL constants) — null when the chip mixes widths or has no
   such parts. Drives the "Bits" control shown when a placed chip is
   selected. */
export function chipUniformBits(def: ChipDef): number | null {
  let n: number | null = null;
  for (const c of def.comps) {
    if (!isGateType(c.type) && c.type !== 'IPIN' && c.type !== 'OPIN' && c.type !== 'VAL') continue;
    const b = clampBits(c.bits ?? 1);
    if (n === null) n = b;
    else if (n !== b) return null;
  }
  return n;
}

/* Rescale a whole chip to an n-bit bus width: every gate, input/output
   pin, and value constant inside takes width n, and wire widths are
   re-seeded from the pins they touch (free-floating bus wires scale
   too). Structural parts — memory cells, combiner/splitter bit counts,
   and nested chips — are left alone. Returns a new sanitized def. */
export function scaleChipDefBits(def: ChipDef, bits: number, lib: ChipLib): ChipDef {
  const n = clampBits(bits);
  const comps = def.comps.map((c): Comp => {
    if (isGateType(c.type)) {
      const { bits: _b, ...rest } = c;
      return n > 1 ? { ...rest, bits: n } : rest;
    }
    if (c.type === 'IPIN' || c.type === 'OPIN' || c.type === 'VAL') {
      const out: Comp = { ...c, bits: n };
      if (out.val != null) out.val = storeVal(maskVal(out.val, n));
      return out;
    }
    return c;
  });
  const byId = new Map(comps.map(c => [c.id, c]));
  const endBits = (e: WireEnd): number => {
    if (!isPinEnd(e)) return 1;
    const c = byId.get(e.comp);
    if (!c) return 1;
    const g = getGeom(c, lib);
    return g[e.side === 'out' ? 'outs' : 'ins'][e.pin]?.bits ?? 1;
  };
  const wires = normalizeWires(def.wires).map(w => {
    const out = cloneWire(w);
    if ([w.a, w.b].some(e => isPinEnd(e))) {
      const b = Math.max(endBits(w.a), endBits(w.b));
      if (b > 1) out.bits = b; else delete out.bits;
    } else if (out.bits) {
      out.bits = n;
    }
    return out;
  });
  return sanitizeChipDef({
    ...def,
    comps,
    wires,
    inputBits: def.inputComps.map(id => clampBits(byId.get(id)?.bits ?? 1)),
    outputBits: def.outputComps.map(id => clampBits(byId.get(id)?.bits ?? 1)),
  });
}

export function chipUsedBy(chipId: string, lib: ChipLib): string | null {
  for (const def of Object.values(lib)) {
    if (def.id === chipId) continue;
    if (def.comps.some(c => c.type === 'CHIP' && c.chipId === chipId)) return def.name;
  }
  return null;
}

/* Transitive custom-chip dependencies of a def (itself excluded) —
   used to bundle everything a shared chip needs to simulate. */
export function collectChipDeps(def: ChipDef, lib: ChipLib): ChipDef[] {
  const seen = new Set<string>([def.id]);
  const out: ChipDef[] = [];

  const visit = (d: ChipDef, depth: number) => {
    if (depth > 12) return;

    for (const c of d.comps) {
      if (c.type !== 'CHIP' || !c.chipId || seen.has(c.chipId)) continue;

      seen.add(c.chipId);

      const dep = lib[c.chipId];
      if (dep) {
        out.push(dep);
        visit(dep, depth + 1);
      }
    }
  };

  visit(def, 0);
  return out;
}

/* Does def (or any chip nested inside it) contain targetId? Guards
   against a chip ending up inside its own internals. */
export function chipDefContains(def: ChipDef, targetId: string, lib: ChipLib, depth = 0): boolean {
  if (depth > 12) return false;

  return def.comps.some(c => c.type === 'CHIP' && !!c.chipId &&
    (c.chipId === targetId || (!!lib[c.chipId] && chipDefContains(lib[c.chipId], targetId, lib, depth + 1))));
}
