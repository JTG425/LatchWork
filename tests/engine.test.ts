import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeNets,
  ChipDef,
  ChipLib,
  clampFreq,
  cloneBoard,
  Comp,
  evalChip,
  evaluateNet,
  getGeom,
  newSimState,
  normalizeWires,
  PinEnd,
  SimState,
  tunnelPinGroups,
  Wire,
  WireEnd,
} from '../lib/engine';

const input = (comp: string, pin = 0): PinEnd => ({ comp, side: 'in', pin });
const output = (comp: string, pin = 0): PinEnd => ({ comp, side: 'out', pin });
const wire = (id: string, a: WireEnd, b: WireEnd): Wire => ({ id, a, b });
const hasOwn = (record: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(record, key);
const signal = (state: SimState, key: string) => state.vals[key] ?? 0n;

function run(comps: Comp[], wires: Wire[], state = newSimState(), lib: ChipLib = {}, now = 0): SimState {
  evaluateNet(comps, wires, state, lib, undefined, 0, now);
  return state;
}

test('settles combinational chains longer than the former 48-pass ceiling', () => {
  const stages = 96;
  const comps: Comp[] = [{ id: 'one', type: 'ONE', x: 0, y: 0 }];
  const wires: Wire[] = [];

  for (let i = 0; i < stages; i++) {
    const id = `buf${i}`;
    const upstream = i === 0 ? 'one' : `buf${i - 1}`;
    comps.push({ id, type: 'BUF', x: (i + 1) * 100, y: 0 });
    wires.push(wire(`w${i}`, output(upstream), input(id)));
  }

  const state = run(comps, wires);
  assert.equal(signal(state, `buf${stages - 1}:0`), 1n);
});

test('normalizes legacy wires and discards corrupt persisted entries safely', () => {
  const raw = [
    null,
    { id: 'missing-end', a: null, b: { x: 20, y: 20 } },
    {
      id: 'legacy',
      from: { comp: 'source', pin: 0 },
      to: { comp: 'sink', pin: 2 },
      via: [{ x: 20, y: 20 }, null, { x: Number.NaN, y: 40 }],
      bits: 1000,
    },
    {
      id: 'bad-side',
      a: { comp: 'source', side: 'sideways', pin: 0 },
      b: { comp: 'sink', side: 'in', pin: 0 },
    },
    {
      id: 'branch',
      a: { wire: 'legacy', x: 20, y: 20 },
      b: { x: 80, y: 20 },
      bits: -4,
    },
    {
      id: 'legacy',
      a: { x: 0, y: 0 },
      b: { x: 20, y: 0 },
    },
    {
      id: 'hybrid',
      from: { comp: 'source', pin: 0 },
      b: { comp: 'sink', side: 'in', pin: 0 },
    },
  ];

  const normalized = normalizeWires(raw);
  assert.deepEqual(normalized, [
    {
      id: 'legacy',
      a: { comp: 'source', side: 'out', pin: 0 },
      b: { comp: 'sink', side: 'in', pin: 2 },
      via: [{ x: 20, y: 20 }],
      bits: 64,
    },
    {
      id: 'branch',
      a: { wire: 'legacy', x: 20, y: 20 },
      b: { x: 80, y: 20 },
    },
  ]);
  assert.deepEqual(cloneBoard({ comps: [], wires: raw as Wire[] }).wires, normalized);
});

test('clock frequency sanitization rejects non-finite values and names JK devices accurately', () => {
  assert.equal(clampFreq(Number.NaN), 1);
  assert.equal(clampFreq(Number.POSITIVE_INFINITY), 1);
  assert.equal(clampFreq(Number.NEGATIVE_INFINITY), 1);
  assert.equal(clampFreq(0), 0.1);
  assert.equal(clampFreq(1e12), 100e6);
  assert.equal(getGeom({ type: 'JKFF' }, {}).name, 'JK Flip-Flop');
});

test('a one-bit receiver samples bit zero rather than truthiness of a bus', () => {
  const comps: Comp[] = [
    { id: 'value', type: 'VAL', bits: 4, val: 0b0010, x: 0, y: 0 },
    { id: 'oneBit', type: 'BUF', x: 100, y: 0 },
    { id: 'wide', type: 'BUF', bits: 4, x: 100, y: 100 },
    { id: 'led', type: 'OUT', x: 200, y: 0 },
  ];
  const wires = [
    wire('narrow', output('value'), input('oneBit')),
    wire('wide', output('value'), input('wide')),
    wire('led', output('value'), input('led')),
  ];

  const state = run(comps, wires);
  assert.equal(signal(state, 'oneBit:0'), 0n);
  assert.equal(signal(state, 'wide:0'), 0b0010n);
  assert.deepEqual(comps.find(c => c.id === 'led')?._ins, [0n]);
});

test('removes values for output pins that disappear after a pin-count change', () => {
  const value: Comp = { id: 'value', type: 'VAL', bits: 4, val: 1, x: 0, y: 0 };
  const split: Comp = { id: 'split', type: 'SPLIT', nIns: 4, x: 100, y: 0 };
  const led: Comp = { id: 'led', type: 'OUT', x: 200, y: 0 };
  const comps = [value, split, led];
  const wires = [
    wire('bus', output('value'), input('split')),
    wire('old-pin', output('split', 3), input('led')),
  ];
  const state = run(comps, wires);
  assert.equal(signal(state, 'split:3'), 1n);
  assert.deepEqual(led._ins, [1n]);

  split.nIns = 2;
  run(comps, wires, state);

  assert.equal(hasOwn(state.vals, 'split:3'), false);
  assert.equal(hasOwn(state.vals, 'split:2'), false);
  assert.deepEqual(led._ins, [0n]);
});

test('prunes state belonging to components removed from a board', () => {
  const state = newSimState();
  state.vals['gone:0'] = 1n;
  state.prevIns.gone = [1];
  state.sub.gone = newSimState();

  run([{ id: 'one', type: 'ONE', x: 0, y: 0 }], [], state);

  assert.equal(hasOwn(state.vals, 'gone:0'), false);
  assert.equal(hasOwn(state.prevIns, 'gone'), false);
  assert.equal(hasOwn(state.sub, 'gone'), false);
});

test('changing an edge-triggered component pin count resets its clock snapshot', () => {
  const reassignedClock: Comp = { id: 'new-clock', type: 'IN', on: false, x: 0, y: 0 };
  const oldClock: Comp = { id: 'old-clock', type: 'IN', on: false, x: 0, y: 100 };
  const sampled: Comp = {
    id: 'sampled', type: 'AND', nIns: 3, edge: 'rise', clockPin: 2, x: 100, y: 0,
  };
  const comps: Comp[] = [
    { id: 'one', type: 'ONE', x: 0, y: 200 },
    reassignedClock,
    oldClock,
    sampled,
  ];
  const wires = [
    wire('data', output('one'), input('sampled', 0)),
    wire('new-clock', output('new-clock'), input('sampled', 1)),
    wire('old-clock', output('old-clock'), input('sampled', 2)),
  ];
  const state = run(comps, wires);

  sampled.nIns = 2;
  reassignedClock.on = true;
  run(comps, wires, state);

  assert.equal(signal(state, 'sampled:0'), 0n);
  assert.deepEqual(state.prevIns.sampled, [1, 1]);
});

test('wire attachments and same-name tunnels form one electrical net', () => {
  const directComps: Comp[] = [
    { id: 'one', type: 'ONE', x: 0, y: 0 },
    { id: 'led', type: 'OUT', x: 200, y: 0 },
  ];
  const directWires: Wire[] = [
    wire('trunk', output('one'), { x: 80, y: 20 }),
    wire('branch', { wire: 'trunk', x: 60, y: 20 }, input('led')),
  ];
  run(directComps, directWires);
  assert.deepEqual(directComps[1]._ins, [1n]);

  const tunnelComps: Comp[] = [
    { id: 'one', type: 'ONE', x: 0, y: 0 },
    { id: 'send', type: 'TUN', label: 'DATA', x: 100, y: 0 },
    { id: 'receive', type: 'TUN', label: ' DATA ', x: 300, y: 0 },
    { id: 'led', type: 'OUT', x: 400, y: 0 },
  ];
  const tunnelWires = [
    wire('send-wire', output('one'), input('send')),
    wire('receive-wire', input('receive'), input('led')),
  ];
  const nets = analyzeNets(tunnelWires, tunnelPinGroups(tunnelComps));
  assert.deepEqual(nets.inputDrivers.get('led:0'), ['one:0']);
  run(tunnelComps, tunnelWires);
  assert.deepEqual(tunnelComps[3]._ins, [1n]);
});

test('flip-flops sharing a clock all sample their pre-edge inputs', () => {
  const clock: Comp = { id: 'clock', type: 'IN', on: false, x: 0, y: 0 };
  const comps: Comp[] = [
    clock,
    { id: 'one', type: 'ONE', x: 0, y: 100 },
    { id: 'ff0', type: 'DFF', x: 100, y: 0 },
    { id: 'ff1', type: 'DFF', x: 220, y: 0 },
    { id: 'ff2', type: 'DFF', x: 340, y: 0 },
  ];
  const wires = [
    wire('data0', output('one'), input('ff0', 0)),
    wire('data1', output('ff0'), input('ff1', 0)),
    wire('data2', output('ff1'), input('ff2', 0)),
    wire('clk0', output('clock'), input('ff0', 1)),
    wire('clk1', output('clock'), input('ff1', 1)),
    wire('clk2', output('clock'), input('ff2', 1)),
  ];
  const state = run(comps, wires);

  clock.on = true;
  run(comps, wires, state);
  assert.deepEqual(['ff0', 'ff1', 'ff2'].map(id => signal(state, `${id}:0`)), [1n, 0n, 0n]);

  clock.on = false;
  run(comps, wires, state);
  clock.on = true;
  run(comps, wires, state);
  assert.deepEqual(['ff0', 'ff1', 'ff2'].map(id => signal(state, `${id}:0`)), [1n, 1n, 0n]);
});

test('JK and T flip-flops keep their documented falling-edge defaults', () => {
  const clock: Comp = { id: 'clock', type: 'IN', on: false, x: 0, y: 0 };
  const comps: Comp[] = [
    clock,
    { id: 'one', type: 'ONE', x: 0, y: 100 },
    { id: 't', type: 'TFF', x: 100, y: 0 },
  ];
  const wires = [
    wire('t', output('one'), input('t', 0)),
    wire('clock', output('clock'), input('t', 1)),
  ];
  const state = run(comps, wires);

  clock.on = true;
  run(comps, wires, state);
  assert.equal(signal(state, 't:0'), 0n);

  clock.on = false;
  run(comps, wires, state);
  assert.equal(signal(state, 't:0'), 1n);
});

test('edge-triggered custom chips sample a named CLK pin and hold their output', () => {
  const def: ChipDef = {
    id: 'sample',
    name: 'Sample',
    inputs: ['D', 'CLK'],
    outputs: ['Q'],
    inputComps: ['d', 'clk'],
    outputComps: ['q'],
    inputBits: [1, 1],
    outputBits: [1],
    comps: [
      { id: 'd', type: 'IPIN', x: 0, y: 0 },
      { id: 'clk', type: 'IPIN', x: 0, y: 100 },
      { id: 'buf', type: 'BUF', x: 100, y: 0 },
      { id: 'q', type: 'OPIN', x: 200, y: 0 },
    ],
    wires: [
      wire('d-buf', output('d'), input('buf')),
      wire('buf-q', output('buf'), input('q')),
    ],
    createdAt: 0,
  };
  const lib = { sample: def };
  const d: Comp = { id: 'd', type: 'IN', on: false, x: 0, y: 0 };
  const clk: Comp = { id: 'clk', type: 'IN', on: false, x: 0, y: 100 };
  const sampled: Comp = { id: 'sampled', type: 'CHIP', chipId: 'sample', edge: 'rise', x: 100, y: 0 };
  const comps = [d, clk, sampled];
  const wires = [
    wire('d', output('d'), input('sampled', 0)),
    wire('clk', output('clk'), input('sampled', 1)),
  ];
  const state = run(comps, wires, newSimState(), lib);

  d.on = true;
  run(comps, wires, state, lib);
  assert.equal(signal(state, 'sampled:0'), 0n);

  clk.on = true;
  run(comps, wires, state, lib);
  assert.equal(signal(state, 'sampled:0'), 1n);

  d.on = false;
  run(comps, wires, state, lib);
  assert.equal(signal(state, 'sampled:0'), 1n);
});

test('custom chip boundaries preserve declared bus widths', () => {
  const def: ChipDef = {
    id: 'wide-buffer',
    name: 'Wide buffer',
    inputs: ['A'],
    outputs: ['Y'],
    inputComps: ['a'],
    outputComps: ['y'],
    inputBits: [4],
    outputBits: [4],
    comps: [
      { id: 'a', type: 'IPIN', bits: 4, x: 0, y: 0 },
      { id: 'buf', type: 'BUF', bits: 4, x: 100, y: 0 },
      { id: 'y', type: 'OPIN', bits: 4, x: 200, y: 0 },
    ],
    wires: [
      wire('a-buf', output('a'), input('buf')),
      wire('buf-y', output('buf'), input('y')),
    ],
    createdAt: 0,
  };

  const state = newSimState();
  assert.deepEqual(evalChip(def, state, [0b1010n], { [def.id]: def }, 0, 0), [0b1010n]);
  assert.deepEqual(evalChip(def, state, [0b11010n], { [def.id]: def }, 0, 0), [0b1010n]);
});

test('cross-coupled NAND latch settles deterministically and holds state', () => {
  const setBar: Comp = { id: 'setBar', type: 'IN', on: true, x: 0, y: 0 };
  const resetBar: Comp = { id: 'resetBar', type: 'IN', on: true, x: 0, y: 100 };
  const comps: Comp[] = [
    setBar,
    resetBar,
    { id: 'q', type: 'NAND', x: 100, y: 0 },
    { id: 'qbar', type: 'NAND', x: 100, y: 100 },
  ];
  const wires = [
    wire('set', output('setBar'), input('q', 0)),
    wire('qbar-feedback', output('qbar'), input('q', 1)),
    wire('reset', output('resetBar'), input('qbar', 0)),
    wire('q-feedback', output('q'), input('qbar', 1)),
  ];
  const state = run(comps, wires);
  assert.notEqual(signal(state, 'q:0'), signal(state, 'qbar:0'));

  setBar.on = false;
  run(comps, wires, state);
  assert.deepEqual([signal(state, 'q:0'), signal(state, 'qbar:0')], [1n, 0n]);

  setBar.on = true;
  run(comps, wires, state);
  assert.deepEqual([signal(state, 'q:0'), signal(state, 'qbar:0')], [1n, 0n]);

  resetBar.on = false;
  run(comps, wires, state);
  assert.deepEqual([signal(state, 'q:0'), signal(state, 'qbar:0')], [0n, 1n]);
});
