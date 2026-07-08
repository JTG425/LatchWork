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

import { ChipDef, ChipLib, Comp, SimState, newSimState, evalChip } from './engine';

export const MAX_TT_INPUTS = 8;   // 256 rows — beyond this the table is skipped
export const MAX_FSM_INPUTS = 4;  // 16 combos per state keeps exploration + diagram sane
const RAW_STATE_CAP = 48;         // raw snapshot cap before we call it "too large"

export interface TruthRow { ins: number[]; outs: number[] }

export interface FsmEdge {
  from: number;
  to: number;
  combos: number[];   // input combinations (bit i of combo = input i), grouped
  outs: number[];     // outputs produced on this transition (Mealy)
}

export interface FsmResult {
  states: number;     // minimal state count; state 0 is the power-on state
  edges: FsmEdge[];
}

export interface ChipAnalysisResult {
  inputs: string[];
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

/* bit i of a combo drives input pin i */
export const comboIns = (combo: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => (combo >> i) & 1);

export const comboLabel = (combo: number, n: number): string =>
  comboIns(combo, n).join('');

const cloneState = (s: SimState): SimState => JSON.parse(JSON.stringify(s));

/* Canonical snapshot key — order-independent over vals and sub trees. */
function keyOf(s: SimState): string {
  const vals = Object.keys(s.vals).sort().map(k => `${k}=${s.vals[k] | 0}`).join(',');
  const subs = Object.keys(s.sub).sort().map(k => `${k}{${keyOf(s.sub[k])}}`).join('');
  const prev = Object.keys(s.prevIns ?? {}).sort().map(k => `${k}=[${s.prevIns[k].map(v => v | 0).join('')}]`).join(',');
  return vals + '|' + prev + '|' + subs;
}

/* Evaluate with fixed inputs until the outputs and snapshot stop
   changing (each evalChip call already runs many internal passes;
   repeating lets feedback across nested chips settle). now=0 keeps
   any internal clocks parked low so results are deterministic. */
function settle(def: ChipDef, state: SimState, ins: number[], lib: ChipLib): number[] {
  let outs: number[] = [];
  let prev = '';
  for (let i = 0; i < 4; i++) {
    outs = evalChip(def, state, ins, lib, 0, 0);
    const k = keyOf(state) + '/' + outs.join('');
    if (k === prev) break;
    prev = k;
  }
  return outs;
}

export function analyzeChip(def: ChipDef, lib: ChipLib): ChipAnalysisResult {
  const nIn = def.inputs.length;
  const nCombos = 1 << nIn;
  const hasClock = containsClock(def, lib);

  /* ── truth table from the power-on state ── */
  let truth: TruthRow[] | null = null;
  if (nIn <= MAX_TT_INPUTS) {
    truth = [];
    for (let combo = 0; combo < nCombos; combo++) {
      const ins = comboIns(combo, nIn);
      truth.push({ ins, outs: settle(def, newSimState(), ins, lib) });
    }
  }

  if (nIn > MAX_FSM_INPUTS) {
    return { inputs: def.inputs, outputs: def.outputs, hasClock, truth, kind: 'unknown', fsm: null };
  }

  /* ── explore raw snapshot space ── */
  interface RawNode { state: SimState; next: number[]; outs: number[][] } // per combo
  const nodes: RawNode[] = [];
  const idByKey = new Map<string, number>();

  const s0 = newSimState();
  settle(def, s0, comboIns(0, nIn), lib);
  idByKey.set(keyOf(s0), 0);
  nodes.push({ state: s0, next: [], outs: [] });

  let overflow = false;
  for (let i = 0; i < nodes.length && !overflow; i++) {
    const node = nodes[i];
    for (let combo = 0; combo < nCombos; combo++) {
      const nextState = cloneState(node.state);
      const outs = settle(def, nextState, comboIns(combo, nIn), lib);
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
    return { inputs: def.inputs, outputs: def.outputs, hasClock, truth, kind: 'unknown', fsm: null };
  }

  /* ── Mealy minimization: partition refinement ── */
  // initial partition: nodes with identical output vectors across all combos
  let part = new Map<string, number>();
  let cls = nodes.map(n => {
    const sig = n.outs.map(o => o.join('')).join('|');
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
      const gk = `${from}>${to}/${node.outs[combo].join('')}`;
      const e = edgeMap.get(gk);
      if (e) e.combos.push(combo);
      else edgeMap.set(gk, { from, to, combos: [combo], outs: node.outs[combo] });
    }
  }

  const nStates = renum.size;
  if (nStates <= 1) {
    return { inputs: def.inputs, outputs: def.outputs, hasClock, truth, kind: 'combinational', fsm: null };
  }
  return {
    inputs: def.inputs, outputs: def.outputs, hasClock, truth,
    kind: 'sequential',
    fsm: { states: nStates, edges: [...edgeMap.values()] },
  };
}
