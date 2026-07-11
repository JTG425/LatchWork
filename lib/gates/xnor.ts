import { GateDef, TWO_IN, ONE_OUT } from './types';

/* XNOR — inverted XOR: output is 1 when an even number of inputs are 1
   (equality detector for two inputs). */
export const XNOR: GateDef = {
  name: 'XNOR',
  sub: 'A ⊙ B',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => (ins.reduce((a, v) => a ^ (v ? 1 : 0), 0) ? 0 : 1),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M9,${t} H24 C42,${t} 51,${m - 16} 56,${m} C51,${m + 16} 42,${b} 24,${b} H9 C19,${m + 12} 19,${m - 12} 9,${t} Z`;
  },
  backCurve: h => {
    const m = h / 2;
    return `M2,-8 C12,${m - 12} 12,${m + 12} 2,${h + 8}`;
  },
  bubble: h => ({ cx: 60, cy: h / 2, r: 4 }),
  stubX: 12,
};
