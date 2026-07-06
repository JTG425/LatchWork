export const GRID = 20;

export type CompType =
  | 'IN' | 'BTN' | 'ONE' | 'CLK'
  | 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR'
  | 'OUT' | 'IPIN' | 'OPIN' | 'CHIP';
export interface PinRef { comp: string; pin: number }
export interface Vec { x: number; y: number }
/* via: optional user-routed waypoints (grid-snapped), ordered from → to */
export interface Wire { id: string; from: PinRef; to: PinRef; via?: Vec[] }
export interface Comp {
  id: string; type: CompType; x: number; y: number;
  on?: boolean; pressed?: boolean; label?: string; chipId?: string;
  nIns?: number;          // gates: input count (2–4)
  w?: number; h?: number; // chips: user-resized body, grid multiples
  freq?: number;          // CLK: full cycles per second
  _ins?: number[];
}
export interface Board { comps: Comp[]; wires: Wire[] }
export interface ChipDef { id: string; name: string; inputs: string[]; outputs: string[]; inputComps: string[]; outputComps: string[]; comps: Comp[]; wires: Wire[]; createdAt: number }
export type ChipLib = Record<string, ChipDef>;
export interface SimState { vals: Record<string, number>; sub: Record<string, SimState> }
export const newSimState = (): SimState => ({ vals: {}, sub: {} });

export interface Pin { x: number; y: number; name?: string }
export interface CompGeom { w: number; h: number; ins: Pin[]; outs: Pin[]; name: string; sub: string }

const twoIn: Pin[] = [{ x: -20, y: 0 }, { x: -20, y: 40 }];
const oneOut: Pin[] = [{ x: 80, y: 20 }];

const PRIM: Record<Exclude<CompType, 'CHIP'>, CompGeom> = {
  IN: { name: 'Switch', sub: 'toggle 0 / 1', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  BTN: { name: 'Button', sub: 'momentary 1', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  ONE: { name: 'Constant 1', sub: 'always high', w: 40, h: 40, ins: [], outs: [{ x: 60, y: 20 }] },
  CLK: { name: 'Clock', sub: 'square wave', w: 60, h: 40, ins: [], outs: [{ x: 80, y: 20 }] },
  AND: { name: 'AND', sub: 'A · B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  OR: { name: 'OR', sub: 'A + B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  NOT: { name: 'NOT', sub: 'inverter', w: 60, h: 40, ins: [{ x: -20, y: 20 }], outs: oneOut },
  NAND: { name: 'NAND', sub: 'inverted AND', w: 60, h: 40, ins: twoIn, outs: oneOut },
  NOR: { name: 'NOR', sub: 'inverted OR', w: 60, h: 40, ins: twoIn, outs: oneOut },
  XOR: { name: 'XOR', sub: 'A ⊕ B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  OUT: { name: 'LED', sub: 'output', w: 40, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
  IPIN: { name: 'Input pin', sub: 'chip input', w: 40, h: 40, ins: [], outs: [{ x: 60, y: 20 }] },
  OPIN: { name: 'Output pin', sub: 'chip output', w: 40, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
};

export const PALETTE_ORDER: [string, CompType[]][] = [
  ['Inputs', ['IN', 'BTN', 'ONE', 'CLK']],
  ['Gates', ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR']],
  ['Outputs', ['OUT']],
  ['Chip pins', ['IPIN', 'OPIN']],
];

/* Gates whose input count can be edited (NOT is always 1-in) */
export const MULTI_IN_GATES: ReadonlySet<CompType> = new Set(['AND', 'OR', 'NAND', 'NOR', 'XOR']);
export const MAX_GATE_INS = 4;
export const clampGateIns = (n?: number) => Math.min(MAX_GATE_INS, Math.max(2, Math.round(n ?? 2)));

export const CHIP_MIN_W = 80;
export const chipMinH = (def: ChipDef) => (Math.max(def.inputs.length, def.outputs.length, 1) + 1) * GRID;

export const CLK_MIN_HZ = 0.1, CLK_MAX_HZ = 20;
export const clampFreq = (hz?: number) => Math.min(CLK_MAX_HZ, Math.max(CLK_MIN_HZ, hz ?? 1));

export function chipGeom(def: ChipDef, ow?: number, oh?: number): CompGeom {
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  const autoW = Math.ceil(Math.max(100, 24 + def.name.length * 7 + 24) / GRID) * GRID;
  const w = Math.max(CHIP_MIN_W, Math.round((ow ?? autoW) / GRID) * GRID);
  const h = Math.max(chipMinH(def), Math.round((oh ?? chipMinH(def)) / GRID) * GRID);
  // pins spread evenly over the (possibly resized) body, snapped to the grid
  const hu = h / GRID;
  const mk = (names: string[], x: number): Pin[] =>
    names.map((name, i) => ({ x, y: GRID * Math.round(((i + 1) * hu) / (rows + 1)), name }));
  return { name: def.name, sub: `${def.inputs.length} in · ${def.outputs.length} out`, w, h, ins: mk(def.inputs, -20), outs: mk(def.outputs, w + 20) };
}

export function getGeom(c: Pick<Comp, 'type' | 'chipId' | 'nIns' | 'w' | 'h'>, lib: ChipLib): CompGeom {
  if (c.type === 'CHIP') {
    const def = c.chipId ? lib[c.chipId] : undefined;
    if (def) return chipGeom(def, c.w, c.h);
    return { name: '?', sub: 'missing chip', w: 100, h: 40, ins: [], outs: [] };
  }
  const base = PRIM[c.type];
  if (MULTI_IN_GATES.has(c.type)) {
    const n = clampGateIns(c.nIns);
    const h = Math.max(40, (n - 1) * GRID);
    const step = h / (n - 1);
    return {
      ...base, h,
      ins: Array.from({ length: n }, (_, i) => ({ x: -20, y: Math.round(i * step) })),
      outs: [{ x: 80, y: h / 2 }],
    };
  }
  return base;
}

function evalPrim(c: Comp, ins: number[], now: number): number[] {
  switch (c.type) {
    case 'IN':
    case 'IPIN': return [c.on ? 1 : 0];
    case 'BTN': return [c.pressed ? 1 : 0];
    case 'ONE': return [1];
    case 'CLK': { const half = 500 / clampFreq(c.freq); return [Math.floor(now / half) % 2]; }
    case 'AND': return [ins.every(v => v) ? 1 : 0];
    case 'OR': return [ins.some(v => v) ? 1 : 0];
    case 'NOT': return [ins[0] ? 0 : 1];
    case 'NAND': return [ins.every(v => v) ? 0 : 1];
    case 'NOR': return [ins.some(v => v) ? 0 : 1];
    case 'XOR': return [ins.reduce((a, v) => a ^ v, 0)];
    default: return [];
  }
}

export function evaluateNet(comps: Comp[], wires: Wire[], state: SimState, lib: ChipLib, boundIns?: Map<string, number>, depth = 0, now = Date.now()): void {
  if (depth > 12) return;
  const byDest = new Map<string, Wire>();
  for (const w of wires) byDest.set(w.to.comp + ':' + w.to.pin, w);
  const passes = Math.min(24, Math.max(6, comps.length + 2));
  for (let k = 0; k < passes; k++) {
    for (const c of comps) {
      const g = getGeom(c, lib);
      const ins = g.ins.map((_, i) => {
        const w = byDest.get(c.id + ':' + i);
        return w ? (state.vals[w.from.comp + ':' + w.from.pin] | 0) : 0;
      });
      c._ins = ins;
      let outs: number[];
      if (c.type === 'CHIP') {
        const def = c.chipId ? lib[c.chipId] : undefined;
        outs = def ? evalChip(def, (state.sub[c.id] ??= newSimState()), ins, lib, depth + 1, now) : [];
      } else if ((c.type === 'IN' || c.type === 'BTN' || c.type === 'IPIN') && boundIns?.has(c.id)) {
        outs = [boundIns.get(c.id)! | 0];
      } else {
        outs = evalPrim(c, ins, now);
      }
      outs.forEach((v, i) => { state.vals[c.id + ':' + i] = v; });
    }
  }
}

export function evalChip(def: ChipDef, state: SimState, ins: number[], lib: ChipLib, depth = 0, now = Date.now()): number[] {
  const bound = new Map(def.inputComps.map((id, i) => [id, ins[i] | 0]));
  evaluateNet(def.comps, def.wires, state, lib, bound, depth, now);
  return def.outputComps.map(id => {
    const w = def.wires.find(w => w.to.comp === id && w.to.pin === 0);
    return w ? (state.vals[w.from.comp + ':' + w.from.pin] | 0) : 0;
  });
}

export interface ChipValidation { ok: boolean; reason?: string }
export function validateChipSource(board: Board): ChipValidation {
  const ins = board.comps.filter(c => c.type === 'IPIN');
  const outs = board.comps.filter(c => c.type === 'OPIN');
  if (ins.length === 0) return { ok: false, reason: 'Add at least one Input pin (under “Chip pins”) — those become the chip’s input pins.' };
  if (outs.length === 0) return { ok: false, reason: 'Add at least one Output pin (under “Chip pins”) — those become the chip’s output pins.' };
  return { ok: true };
}
const byPosition = (a: Comp, b: Comp) => (a.y - b.y) || (a.x - b.x);
export function makeChipDef(name: string, board: Board): ChipDef {
  const comps: Comp[] = JSON.parse(JSON.stringify(board.comps.map(({ _ins, ...rest }) => rest)));
  const wires: Wire[] = JSON.parse(JSON.stringify(board.wires));
  const inComps = comps.filter(c => c.type === 'IPIN').sort(byPosition);
  const outComps = comps.filter(c => c.type === 'OPIN').sort(byPosition);
  return { id: 'chip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), name: name.trim().slice(0, 24) || 'Chip', inputs: inComps.map((c, i) => (c.label || `IN${i + 1}`).slice(0, 8)), outputs: outComps.map((c, i) => (c.label || `OUT${i + 1}`).slice(0, 8)), inputComps: inComps.map(c => c.id), outputComps: outComps.map(c => c.id), comps, wires, createdAt: Date.now() };
}
export function chipUsedBy(chipId: string, lib: ChipLib): string | null {
  for (const def of Object.values(lib)) {
    if (def.id === chipId) continue;
    if (def.comps.some(c => c.type === 'CHIP' && c.chipId === chipId)) return def.name;
  }
  return null;
}
