import { GateDef, TWO_IN, ONE_OUT } from './types';

/* NAND — inverted AND: output is 0 only when every input is 1. */
export const NAND: GateDef = {
  name: 'NAND',
  sub: 'inverted AND',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => (ins.every(v => v) ? 0 : 1),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M4,${t} H28 C48,${t} 56,${m - 16} 56,${m} C56,${m + 16} 48,${b} 28,${b} H4 Z`;
  },
  bubble: h => ({ cx: 60, cy: h / 2, r: 4 }),
  stubX: 8,
};
