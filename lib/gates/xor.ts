import { GateDef, TWO_IN, ONE_OUT } from './types';

/* XOR — output is 1 when an odd number of inputs are 1 (parity). */
export const XOR: GateDef = {
  name: 'XOR',
  sub: 'A ⊕ B',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => ins.reduce((a, v) => a ^ v, 0),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M9,${t} H26 C45,${t} 55,${m - 16} 60,${m} C55,${m + 16} 45,${b} 26,${b} H9 C19,${m + 12} 19,${m - 12} 9,${t} Z`;
  },
  backCurve: h => {
    const m = h / 2;
    return `M2,-8 C12,${m - 12} 12,${m + 12} 2,${h + 8}`;
  },
  stubX: 12,
};
