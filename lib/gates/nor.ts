import { GateDef, TWO_IN, ONE_OUT } from './types';

/* NOR — inverted OR: output is 1 only when every input is 0. */
export const NOR: GateDef = {
  name: 'NOR',
  sub: 'inverted OR',
  multiIn: true,
  w: 60,
  h: 40,
  ins: TWO_IN,
  outs: ONE_OUT,
  eval: ins => (ins.some(v => v) ? 0 : 1),
  body: h => {
    const t = -8, b = h + 8, m = h / 2;
    return `M3,${t} H20 C38,${t} 50,${m - 16} 55,${m} C50,${m + 16} 38,${b} 20,${b} H3 C13,${m + 12} 13,${m - 12} 3,${t} Z`;
  },
  bubble: h => ({ cx: 59, cy: h / 2, r: 4 }),
  stubX: 12,
};
