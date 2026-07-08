import { GateDef, TWO_IN, ONE_OUT } from './types';

/* AND — output is 1 only when every input is 1. */
export const AND: GateDef = {
  name: 'AND',
  sub: 'A · B',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => (ins.every(v => v ? 1 : 0) ? 1 : 0),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M4,${t} H30 C52,${t} 60,${m - 16} 60,${m} C60,${m + 16} 52,${b} 30,${b} H4 Z`;
  },
  stubX: 8,
};