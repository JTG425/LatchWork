import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeChip, comboPinIns } from '../lib/analyze';
import {
  ChipDef,
  Comp,
  CompType,
  Wire,
  evalChip,
  newSimState,
} from '../lib/engine';
import { GATE_DEFS, GATE_TYPES, GateType, isGateType } from '../lib/gates';
import { VhdlModule, VhdlStore, compileVhdl, evalVhdlModule } from '../lib/vhdl';

const expectedGate: Record<GateType, (ins: number[]) => number> = {
  AND: ins => Number(ins.every(Boolean)),
  OR: ins => Number(ins.some(Boolean)),
  NAND: ins => Number(!ins.every(Boolean)),
  NOR: ins => Number(!ins.some(Boolean)),
  XOR: ins => ins.reduce((parity, bit) => parity ^ bit, 0),
  XNOR: ins => Number(!ins.reduce((parity, bit) => parity ^ bit, 0)),
  NOT: ins => Number(!ins[0]),
  BUF: ins => Number(Boolean(ins[0])),
};

const gateChip = (type: GateType, arity: number, width: number): ChipDef => {
  const inputs: Comp[] = Array.from({ length: arity }, (_, i) => ({
    id: `i${i}`, type: 'IPIN', x: 0, y: i * 40, bits: width,
  }));
  const gate: Comp = {
    id: 'g', type: type as CompType, x: 100, y: 0, bits: width,
    ...(GATE_DEFS[type].multiIn ? { nIns: arity } : {}),
  };
  const output: Comp = { id: 'o', type: 'OPIN', x: 220, y: 0, bits: width };
  const wires: Wire[] = inputs.map((input, i) => ({
    id: `wi${i}`,
    a: { comp: input.id, side: 'out', pin: 0 },
    b: { comp: gate.id, side: 'in', pin: i },
    bits: width,
  }));
  wires.push({
    id: 'wo',
    a: { comp: gate.id, side: 'out', pin: 0 },
    b: { comp: output.id, side: 'in', pin: 0 },
    bits: width,
  });
  return {
    id: `gate-${type}-${arity}-${width}`,
    name: type,
    inputs: inputs.map(c => c.id),
    outputs: ['o'],
    inputComps: inputs.map(c => c.id),
    outputComps: ['o'],
    inputBits: inputs.map(() => width),
    outputBits: [width],
    comps: [...inputs, gate, output],
    wires,
    createdAt: 0,
  };
};

test('every primitive gate has the exact truth table at every supported arity', () => {
  assert.deepEqual(new Set(GATE_TYPES), new Set(Object.keys(expectedGate)));
  for (const type of GATE_TYPES) {
    const arities = GATE_DEFS[type].multiIn ? [2, 3, 4] : [1];
    for (const arity of arities) {
      for (let combo = 0; combo < 2 ** arity; combo++) {
        const ins = Array.from({ length: arity }, (_, i) => Math.floor(combo / (2 ** i)) % 2);
        assert.equal(GATE_DEFS[type].eval(ins), expectedGate[type](ins), `${type}/${arity}/${ins}`);
      }
    }
  }
});

test('every primitive gate applies its truth function independently to each bus bit', () => {
  const width = 8;
  for (const type of GATE_TYPES) {
    const arities = GATE_DEFS[type].multiIn ? [2, 3, 4] : [1];
    for (const arity of arities) {
      const ins = Array.from({ length: arity }, (_, i) => BigInt([0xa5, 0x3c, 0xf0, 0x69][i]));
      let expected = 0n;
      for (let bit = 0; bit < width; bit++) {
        const bitIns = ins.map(value => Number((value >> BigInt(bit)) & 1n));
        if (expectedGate[type](bitIns)) expected |= 1n << BigInt(bit);
      }
      assert.deepEqual(evalChip(gateChip(type, arity, width), newSimState(), ins, {}), [expected], `${type}/${arity}`);
    }
  }
});

test('gate type guard rejects inherited object keys from untrusted component JSON', () => {
  assert.equal(isGateType('AND'), true);
  assert.equal(isGateType('toString'), false);
  assert.equal(isGateType('__proto__'), false);
  assert.equal(isGateType('constructor'), false);
});

const moduleOf = (source: string): VhdlModule => {
  const result = compileVhdl(source);
  assert.equal(result.ok, true, result.ok ? undefined : result.errors.map(e => `${e.line}: ${e.message}`).join('\n'));
  return result.module;
};

const vhdlStore = (): VhdlStore => ({ vals: {}, prevIns: {} });

test('VHDL process sensitivity, static variables, and variable initializers follow delta-cycle semantics', () => {
  const mod = moduleOf(`
entity vars is port (a : in std_logic; q : out std_logic_vector(7 downto 0)); end vars;
architecture rtl of vars is begin
  process(a)
    variable count : unsigned(7 downto 0) := 5;
  begin
    count := count + 1;
    q <= count;
  end process;
end rtl;`);
  const store = vhdlStore();
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [6n]);
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [6n], 'an unchanged input must not re-run the process');
  assert.deepEqual(evalVhdlModule(mod, store, [1n]), [7n]);
  assert.deepEqual(evalVhdlModule(mod, store, [1n]), [7n]);
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [8n]);
});

test('VHDL derived clocks produce an edge in the following delta cycle', () => {
  const mod = moduleOf(`
entity derived is port (clk : in std_logic; q : out std_logic); end derived;
architecture rtl of derived is
  signal clk_i : std_logic := '0';
  signal state : std_logic := '0';
begin
  clk_i <= clk;
  process(clk_i) begin
    if rising_edge(clk_i) then state <= not state; end if;
  end process;
  q <= state;
end rtl;`);
  const store = vhdlStore();
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [0n]);
  assert.deepEqual(evalVhdlModule(mod, store, [1n]), [1n]);
  assert.deepEqual(evalVhdlModule(mod, store, [1n]), [1n]);
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [1n]);
  assert.deepEqual(evalVhdlModule(mod, store, [1n]), [0n]);
});

test("VHDL vector 'event observes changes outside the least-significant bit", () => {
  const mod = moduleOf(`
entity vector_event is port (v : in std_logic_vector(1 downto 0); q : out std_logic); end vector_event;
architecture rtl of vector_event is signal state : std_logic := '0'; begin
  process(v) begin
    if v'event then state <= not state; end if;
  end process;
  q <= state;
end rtl;`);
  const store = vhdlStore();
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [0n]);
  assert.deepEqual(evalVhdlModule(mod, store, [2n]), [1n]);
  assert.deepEqual(evalVhdlModule(mod, store, [2n]), [1n]);
  assert.deepEqual(evalVhdlModule(mod, store, [0n]), [0n]);
});

test('to_integer arithmetic does not wrap at the source vector width', () => {
  const mod = moduleOf(`
entity arithmetic is port (a : in std_logic_vector(3 downto 0); q : out std_logic_vector(7 downto 0)); end;
architecture rtl of arithmetic is begin
  q <= to_unsigned(to_integer(unsigned(a)) + 1, 8);
end;`);
  const store = vhdlStore();
  assert.deepEqual(evalVhdlModule(mod, store, [15n]), [16n]);
});

test('oversized dynamic VHDL shifts settle safely to zero', () => {
  const mod = moduleOf(`
entity shifting is port (
  a : in std_logic_vector(3 downto 0);
  amount : in std_logic_vector(63 downto 0);
  q : out std_logic_vector(3 downto 0)); end;
architecture rtl of shifting is begin q <= a sll to_integer(unsigned(amount)); end;`);
  assert.deepEqual(evalVhdlModule(mod, vhdlStore(), [15n, 1n << 63n]), [0n]);
});

test('invalid VHDL constructs fail at compile time instead of corrupting runtime state', () => {
  const invalid = [
    `entity e is port(a: in std_logic; q: out std_logic); end; architecture rtl of e is begin a <= '1'; q <= a; end;`,
    `entity e is port(a: in std_logic_vector(1 downto 0); q: out std_logic); end; architecture rtl of e is begin q <= a(3); end;`,
    `entity e is port(q: out std_logic); end; architecture rtl of e is begin process begin q <= '1'; end process; end;`,
    `entity e is port(q: out std_logic); end; architecture rtl of wrong is begin q <= '1'; end;`,
    `entity e is port(q: out std_logic); end; architecture rtl of e is begin q <= 1#0#; end;`,
  ];
  for (const source of invalid) assert.equal(compileVhdl(source).ok, false, source);
});

const vhdlDef = (
  id: string,
  source: string,
  inputs: string[],
  outputs: string[],
  inputBits: number[],
  outputBits: number[],
): ChipDef => ({
  id, name: id, vhdl: source, inputs, outputs, inputBits, outputBits,
  inputComps: [], outputComps: [], comps: [], wires: [], createdAt: 0,
});

test('chip analysis enumerates bus values by total input bits, not pin count', () => {
  const def = vhdlDef('bus-analysis', `
entity bus_analysis is port (a : in std_logic_vector(1 downto 0); q : out std_logic_vector(1 downto 0)); end;
architecture rtl of bus_analysis is begin q <= a; end;`, ['a'], ['q'], [2], [2]);
  const analysis = analyzeChip(def, { [def.id]: def });
  assert.equal(analysis.inputBitCount, 2);
  assert.deepEqual(analysis.inputBits, [2]);
  assert.deepEqual(comboPinIns(11, [2, 1, 1]), [2, 1, 1]);
  assert.deepEqual(analysis.truth?.map(row => row.ins), [[0], [1], [2], [3]]);
  assert.deepEqual(analysis.truth?.map(row => row.outs), [[0n], [1n], [2n], [3n]]);
});

test('FSM minimization keeps distinct multi-output vectors with ambiguous old string forms', () => {
  const def = vhdlDef('collision-fsm', `
entity collision_fsm is port (
  clk : in std_logic;
  a, b : out std_logic_vector(7 downto 0)); end;
architecture rtl of collision_fsm is signal state : std_logic := '0'; begin
  process(clk) begin
    if rising_edge(clk) then state <= not state; end if;
  end process;
  a <= x"01" when state = '0' else x"0C";
  b <= x"17" when state = '0' else x"03";
end;`, ['clk'], ['a', 'b'], [1], [8, 8]);
  const analysis = analyzeChip(def, { [def.id]: def });
  assert.equal(analysis.kind, 'sequential');
  /* State plus the remembered clock level: edge-triggered exploration over
     level-valued inputs correctly needs four Mealy states here. */
  assert.equal(analysis.fsm?.states, 4);
});
