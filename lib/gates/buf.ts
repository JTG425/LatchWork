import { GateDef, ONE_OUT } from './types';

/* BUF — buffer: output follows its single input unchanged. Useful as a
   named repeater stage and for isolating fan-out. */
export const BUF: GateDef = {
  name: 'Buffer',
  sub: 'follows input',
  multiIn: false,
  w: 60,
  h: 40,
  ins: [{ x: -20, y: 20 }],
  outs: ONE_OUT,
  eval: ins => (ins[0] ? 1 : 0),
  body: () => 'M6,4 L6,36 L56,20 Z',
  stubX: 8,
  captionY: 50, // triangle body is short, so the caption sits closer
};
