/* Chip behavior analysis — drives the real simulator over a chip's
   internals to generate a truth table and, for stateful chips, extract
   a minimal state machine.

   Method: a chip's full simulator snapshot (every internal signal,
   recursively through nested chips) is treated as a raw state. From
   the power-on snapshot we BFS every input combination to enumerate
   reachable snapshots, then run Mealy partition refinement so
   snapshots that behave identically forever collapse into one state.
   A chip whose minimal machine has a single state is combinational;
   anything more is sequential and gets a state diagram. */

import { ChipDef, ChipLib, Comp, SimState, chipInputBits, newSimState, evalChip } from './engine';

/* Limits are measured in input bits, not input pins: one 4-bit pin has the
   same four-bit (16 combination) search space as four scalar pins.  Keep the
   old names as aliases for callers compiled against the original API. */
export const MAX_TT_INPUT_BITS = 8;   // 256 rows — beyond this the table is skipped
export const MAX_FSM_INPUT_BITS = 4;  // 16 combos per state keeps exploration + diagram sane
export const MAX_TT_INPUTS = MAX_TT_INPUT_BITS;
export const MAX_FSM_INPUTS = MAX_FSM_INPUT_BITS;
const RAW_STATE_CAP = 48;         // raw snapshot cap before we call it "too large"

export interface TruthRow { ins: number[]; outs: bigint[] }

export interface FsmEdge {
  from: number;
  to: number;
  combos: number[];   // flattened MSB-first input combinations, grouped
  outs: bigint[];     // outputs produced on this transition (Mealy)
}

export interface FsmResult {
  states: number;     // minimal state count; state 0 is the power-on state
  edges: FsmEdge[];
}

export interface ChipAnalysisResult {
  inputs: string[];
  inputBits: number[];
  inputBitCount: number;
  outputs: string[];
  hasClock: boolean;        // contains a CLK — behavior also depends on wall time
  truth: TruthRow[] | null; // from the power-on state; null when inputs > MAX_TT_INPUTS
  /* 'combinational' | 'sequential' | 'unknown' (too many inputs or states to explore) */
  kind: 'combinational' | 'sequential' | 'unknown';
  fsm: FsmResult | null;    // present only for sequential chips within limits
}

const containsClock = (def: ChipDef, lib: ChipLib, depth = 0): boolean => {
  if (depth > 8) return false;
  return def.comps.some((c: Comp) =>
    c.type === 'CLK' ||
    (c.type === 'CHIP' && !!c.chipId && !!lib[c.chipId] && containsClock(lib[c.chipId], lib, depth + 1)));
};

/* Classic truth-table order: the first displayed bit is the MSB, producing
   00, 01, 10, 11 for two inputs instead of the former 00, 10, 01, 11. */
export const comboIns = (combo: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.floor(combo / (2 ** (n - i - 1))) % 2);

/* Decode the flattened combination space into one numeric value per chip
   input.  Pins occupy consecutive MSB-first fields, matching conventional
   truth tables and the editor's default table notation. Analysis
   never calls this above MAX_TT_INPUT_BITS, so every value is exact. */
export const comboPinIns = (combo: number, widths: number[]): number[] => {
  let offset = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(width => {
    offset -= width;
    const value = Math.floor(combo / (2 ** offset)) % (2 ** width);
    return value;
  });
};

export const comboLabel = (combo: number, n: number): string =>
  comboIns(combo, n).join('');

/* Manual deep clone — sim values are bigints, which JSON can't round-trip. */
const cloneState = (s: SimState): SimState => ({
  vals: { ...s.vals },
  sub: Object.fromEntries(Object.entries(s.sub).map(([k, v]) => [k, cloneState(v)])),
  prevIns: Object.fromEntries(Object.entries(s.prevIns ?? {}).map(([k, v]) => [k, [...v]])),
});

/* Canonical snapshot key — order-independent over vals and sub trees. */
function keyOf(s: SimState): string {
  const vals = Object.keys(s.vals).sort().map(k => `${k}=${s.vals[k] ?? 0n}`).join(',');
  const subs = Object.keys(s.sub).sort().map(k => `${k}{${keyOf(s.sub[k])}}`).join('');
  const prev = Object.keys(s.prevIns ?? {}).sort().map(k => `${k}=[${s.prevIns[k].map(v => v | 0).join('')}]`).join(',');
  return vals + '|' + prev + '|' + subs;
}

/* Evaluate with fixed inputs until the outputs and snapshot stop
   changing (each evalChip call already runs many internal passes;
   repeating lets feedback across nested chips settle). now=0 keeps
   any internal clocks parked low so results are deterministic. */
function settle(def: ChipDef, state: SimState, ins: number[], lib: ChipLib): bigint[] {
  let outs: bigint[] = [];
  let prev = '';
  for (let i = 0; i < 4; i++) {
    outs = evalChip(def, state, ins, lib, 0, 0);
    const k = keyOf(state) + '/' + outputKey(outs);
    if (k === prev) break;
    prev = k;
  }
  return outs;
}

/* Length-prefix each value so vectors such as [1, 23] and [12, 3] cannot
   collapse to the same key (both used to serialize as "123"). */
const outputKey = (outs: bigint[]): string =>
  outs.map(v => { const s = v.toString(); return `${s.length}:${s}`; }).join('|');

export function analyzeChip(def: ChipDef, lib: ChipLib): ChipAnalysisResult {
  const inputBits = chipInputBits(def);
  const inputBitCount = inputBits.reduce((sum, width) => sum + width, 0);
  const hasClock = containsClock(def, lib);
  const resultBase = { inputs: def.inputs, inputBits, inputBitCount, outputs: def.outputs, hasClock };

  /* ── truth table from the power-on state ── */
  let truth: TruthRow[] | null = null;
  if (inputBitCount <= MAX_TT_INPUT_BITS) {
    const nCombos = 2 ** inputBitCount;
    truth = [];
    for (let combo = 0; combo < nCombos; combo++) {
      const ins = comboPinIns(combo, inputBits);
      truth.push({ ins, outs: settle(def, newSimState(), ins, lib) });
    }
  }

  if (inputBitCount > MAX_FSM_INPUT_BITS) {
    return { ...resultBase, truth, kind: 'unknown', fsm: null };
  }

  const nCombos = 2 ** inputBitCount;

  /* ── explore raw snapshot space ── */
  interface RawNode { state: SimState; next: number[]; outs: bigint[][] } // per combo
  const nodes: RawNode[] = [];
  const idByKey = new Map<string, number>();

  const s0 = newSimState();
  settle(def, s0, comboPinIns(0, inputBits), lib);
  idByKey.set(keyOf(s0), 0);
  nodes.push({ state: s0, next: [], outs: [] });

  let overflow = false;
  for (let i = 0; i < nodes.length && !overflow; i++) {
    const node = nodes[i];
    for (let combo = 0; combo < nCombos; combo++) {
      const nextState = cloneState(node.state);
      const outs = settle(def, nextState, comboPinIns(combo, inputBits), lib);
      const key = keyOf(nextState);
      let id = idByKey.get(key);
      if (id === undefined) {
        if (nodes.length >= RAW_STATE_CAP) { overflow = true; break; }
        id = nodes.length;
        idByKey.set(key, id);
        nodes.push({ state: nextState, next: [], outs: [] });
      }
      node.next[combo] = id;
      node.outs[combo] = outs;
    }
  }

  if (overflow) {
    return { ...resultBase, truth, kind: 'unknown', fsm: null };
  }

  /* ── Mealy minimization: partition refinement ── */
  // initial partition: nodes with identical output vectors across all combos
  let part = new Map<string, number>();
  let cls = nodes.map(n => {
    const sig = n.outs.map(outputKey).join('/');
    if (!part.has(sig)) part.set(sig, part.size);
    return part.get(sig)!;
  });
  for (;;) {
    const next = new Map<string, number>();
    const nextCls = nodes.map((n, i) => {
      const sig = cls[i] + ':' + n.next.map(t => cls[t]).join(',');
      if (!next.has(sig)) next.set(sig, next.size);
      return next.get(sig)!;
    });
    if (next.size === part.size) { cls = nextCls; break; }
    part = next;
    cls = nextCls;
  }

  // renumber so the power-on state is state 0, others by first appearance
  const renum = new Map<number, number>();
  const stateOf = (raw: number) => {
    const c = cls[raw];
    if (!renum.has(c)) renum.set(c, renum.size);
    return renum.get(c)!;
  };
  stateOf(0);
  const edgeMap = new Map<string, FsmEdge>();
  const seen = new Set<number>();
  const queue = [0];
  while (queue.length) {
    const raw = queue.shift()!;
    const from = stateOf(raw);
    if (seen.has(from)) continue;
    seen.add(from);
    const node = nodes[raw];
    for (let combo = 0; combo < nCombos; combo++) {
      const rawTo = node.next[combo];
      const to = stateOf(rawTo);
      if (!seen.has(to)) queue.push(rawTo);
      const gk = `${from}>${to}/${outputKey(node.outs[combo])}`;
      const e = edgeMap.get(gk);
      if (e) e.combos.push(combo);
      else edgeMap.set(gk, { from, to, combos: [combo], outs: node.outs[combo] });
    }
  }

  const nStates = renum.size;
  if (nStates <= 1) {
    return { ...resultBase, truth, kind: 'combinational', fsm: null };
  }
  return {
    ...resultBase, truth,
    kind: 'sequential',
    fsm: { states: nStates, edges: [...edgeMap.values()] },
  };
}
