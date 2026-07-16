/* Registry of primitive logic gates — one file per gate.
   To add a gate: copy _template.ts to <name>.ts, fill it in, then
   import it here and add it to GATE_DEFS. Everything else (the type
   union, palette entry, simulation, and rendering) follows from the
   registry automatically. */
import { GateDef } from './types';
import { AND } from './and';
import { OR } from './or';
import { NOT } from './not';
import { BUF } from './buf';
import { NAND } from './nand';
import { NOR } from './nor';
import { XOR } from './xor';
import { XNOR } from './xnor';

export type { GateDef, GatePin, GateBubble } from './types';

/* Key = the gate's CompType string; order here is palette order. */
export const GATE_DEFS = { AND, OR, NOT, BUF, NAND, NOR, XOR, XNOR } satisfies Record<string, GateDef>;

export type GateType = keyof typeof GATE_DEFS;

export const GATE_TYPES = Object.keys(GATE_DEFS) as GateType[];

/* `in` also walks Object.prototype (so strings such as "toString" were
   incorrectly accepted as gate types and could crash callers that then
   treated the inherited function as a GateDef).  Component types can come
   from persisted/user-authored JSON, so keep this guard genuinely exact. */
export const isGateType = (t: string): t is GateType =>
  Object.prototype.hasOwnProperty.call(GATE_DEFS, t);
