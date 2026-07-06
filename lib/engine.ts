export const GRID = 20;

export type CompType = 'IN' | 'BTN' | 'AND' | 'OR' | 'NOT' | 'NAND' | 'NOR' | 'XOR' | 'OUT' | 'CHIP';
export interface PinRef { comp: string; pin: number }
export interface Wire { id: string; from: PinRef; to: PinRef }
export interface Comp { id: string; type: CompType; x: number; y: number; on?: boolean; pressed?: boolean; label?: string; chipId?: string; _ins?: number[] }
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
  AND: { name: 'AND', sub: 'A · B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  OR: { name: 'OR', sub: 'A + B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  NOT: { name: 'NOT', sub: 'inverter', w: 60, h: 40, ins: [{ x: -20, y: 20 }], outs: oneOut },
  NAND: { name: 'NAND', sub: 'inverted AND', w: 60, h: 40, ins: twoIn, outs: oneOut },
  NOR: { name: 'NOR', sub: 'inverted OR', w: 60, h: 40, ins: twoIn, outs: oneOut },
  XOR: { name: 'XOR', sub: 'A ⊕ B', w: 60, h: 40, ins: twoIn, outs: oneOut },
  OUT: { name: 'LED', sub: 'output', w: 40, h: 40, ins: [{ x: -20, y: 20 }], outs: [] },
};

export const PALETTE_ORDER: [string, CompType[]][] = [
  ['Inputs', ['IN', 'BTN']],
  ['Gates', ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR']],
  ['Outputs', ['OUT']],
];

export function chipGeom(def: ChipDef): CompGeom {
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  const w = Math.max(100, 24 + def.name.length * 7 + 24);
  const h = (rows + 1) * GRID;
  const gw = Math.ceil(w / GRID) * GRID;
  const mk = (names: string[], x: number): Pin[] => names.map((name, i) => ({ x, y: GRID * (i + 1), name }));
  return { name: def.name, sub: `${def.inputs.length} in · ${def.outputs.length} out`, w: gw, h, ins: mk(def.inputs, -20), outs: mk(def.outputs, gw + 20) };
}

export function getGeom(c: Pick<Comp, 'type' | 'chipId'>, lib: ChipLib): CompGeom {
  if (c.type === 'CHIP') {
    const def = c.chipId ? lib[c.chipId] : undefined;
    if (def) return chipGeom(def);
    return { name: '?', sub: 'missing chip', w: 100, h: 40, ins: [], outs: [] };
  }
  return PRIM[c.type];
}

function evalPrim(c: Comp, ins: number[]): number[] {
  const a = ins[0] | 0, b = ins[1] | 0;
  switch (c.type) {
    case 'IN': return [c.on ? 1 : 0];
    case 'BTN': return [c.pressed ? 1 : 0];
    case 'AND': return [a & b];
    case 'OR': return [a | b];
    case 'NOT': return [a ? 0 : 1];
    case 'NAND': return [(a & b) ? 0 : 1];
    case 'NOR': return [(a | b) ? 0 : 1];
    case 'XOR': return [a ^ b];
    default: return [];
  }
}

export function evaluateNet(comps: Comp[], wires: Wire[], state: SimState, lib: ChipLib, boundIns?: Map<string, number>, depth = 0): void {
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
        outs = def ? evalChip(def, (state.sub[c.id] ??= newSimState()), ins, lib, depth + 1) : [];
      } else if ((c.type === 'IN' || c.type === 'BTN') && boundIns?.has(c.id)) {
        outs = [boundIns.get(c.id)! | 0];
      } else {
        outs = evalPrim(c, ins);
      }
      outs.forEach((v, i) => { state.vals[c.id + ':' + i] = v; });
    }
  }
}

export function evalChip(def: ChipDef, state: SimState, ins: number[], lib: ChipLib, depth = 0): number[] {
  const bound = new Map(def.inputComps.map((id, i) => [id, ins[i] | 0]));
  evaluateNet(def.comps, def.wires, state, lib, bound, depth);
  return def.outputComps.map(id => {
    const w = def.wires.find(w => w.to.comp === id && w.to.pin === 0);
    return w ? (state.vals[w.from.comp + ':' + w.from.pin] | 0) : 0;
  });
}

export interface ChipValidation { ok: boolean; reason?: string }
export function validateChipSource(board: Board): ChipValidation {
  const ins = board.comps.filter(c => c.type === 'IN' || c.type === 'BTN');
  const outs = board.comps.filter(c => c.type === 'OUT');
  if (ins.length === 0) return { ok: false, reason: 'Add at least one switch or button — those become the chip’s input pins.' };
  if (outs.length === 0) return { ok: false, reason: 'Add at least one LED — those become the chip’s output pins.' };
  return { ok: true };
}
const byPosition = (a: Comp, b: Comp) => (a.y - b.y) || (a.x - b.x);
export function makeChipDef(name: string, board: Board): ChipDef {
  const comps: Comp[] = JSON.parse(JSON.stringify(board.comps.map(({ _ins, ...rest }) => rest)));
  const wires: Wire[] = JSON.parse(JSON.stringify(board.wires));
  const inComps = comps.filter(c => c.type === 'IN' || c.type === 'BTN').sort(byPosition);
  const outComps = comps.filter(c => c.type === 'OUT').sort(byPosition);
  return { id: 'chip_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), name: name.trim().slice(0, 24) || 'Chip', inputs: inComps.map((c, i) => (c.label || `IN${i + 1}`).slice(0, 8)), outputs: outComps.map((c, i) => (c.label || `OUT${i + 1}`).slice(0, 8)), inputComps: inComps.map(c => c.id), outputComps: outComps.map(c => c.id), comps, wires, createdAt: Date.now() };
}
export function chipUsedBy(chipId: string, lib: ChipLib): string | null {
  for (const def of Object.values(lib)) {
    if (def.id === chipId) continue;
    if (def.comps.some(c => c.type === 'CHIP' && c.chipId === chipId)) return def.name;
  }
  return null;
}
