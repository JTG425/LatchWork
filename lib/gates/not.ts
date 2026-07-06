import { GateDef, ONE_OUT } from './types';

/* NOT — inverter: output is the opposite of its single input. */
export const NOT: GateDef = {
  name: 'NOT',
  sub: 'inverter',
  multiIn: false,
  w: 60,
  h: 40,
  ins: [{ x: -20, y: 20 }],
  outs: ONE_OUT,
  eval: ins => (ins[0] ? 0 : 1),
  body: () => 'M6,4 L6,36 L52,20 Z',
  bubble: () => ({ cx: 56, cy: 20, r: 4 }),
  stubX: 8,
  captionY: 50, // triangle body is short, so the caption sits closer
};
