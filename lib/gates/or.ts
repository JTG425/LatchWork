import { GateDef, TWO_IN, ONE_OUT } from './types';

/* OR — output is 1 when any input is 1. */
export const OR: GateDef = {
  name: 'OR',
  sub: 'A + B',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => (ins.some(v => v) ? 1 : 0),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M3,${t} H22 C42,${t} 55,${m - 16} 60,${m} C55,${m + 16} 42,${b} 22,${b} H3 C13,${m + 12} 13,${m - 12} 3,${t} Z`;
  },
  stubX: 12,
};
