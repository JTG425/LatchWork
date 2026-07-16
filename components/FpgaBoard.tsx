'use client';

/* Fullscreen FPGA development-board pane — the content of an FPGA tab.
   Left half: a VHDL editor (same layout as the VHDL tab: numbered
   gutter, live compile, clickable errors). Right half: a 3D Basys 3
   trainer board (three.js) that actually runs the code — "Program
   board" compiles the entity, maps its ports onto the board's I/O by
   their constraint names (sw, led, btnC…, seg/dp/an, clk), and from
   then on the design executes live: click the slide switches and push
   buttons on the board, watch the LEDs and the multiplexed 7-segment
   display respond. The 100 MHz system clock is emulated at a
   selectable rate. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { compileVhdl, evalVhdlModule, VhdlModule, VhdlStore } from '@/lib/vhdl';
import {
  FPGA_TEMPLATE, FPGA_CLOCK_RATES, FPGA_DEFAULT_HZ,
  mapPortsToBoard, MappedPort, FpgaResource,
} from '@/lib/basys3';
import { createBasys3Scene, FpgaVisualState, BtnId } from '@/components/fpga3d';

/* budget guards: never let a fast emulated clock stall the frame */
const MAX_EVALS_PER_FRAME = 24000;
const FRAME_BUDGET_MS = 8;
const DIGIT_HOLD_MS = 250;   // persistence for multiplexed 7-seg digits

/* the design loaded onto the board (the "bitstream") */
interface Runner {
  module: VhdlModule;
  store: VhdlStore;
  ins: bigint[];                        // scratch, in-port order
  inRes: (FpgaResource | null)[];       // resource behind each in port
  outRes: FpgaResource[];               // resource behind each out port
  segBits: number;                      // 7, or 8 when dp rides in seg(7)
  hasAn: boolean;
  hasClk: boolean;
  clk: bigint;
  frac: number;                         // fractional clock ticks carried over
}

function makeRunner(module: VhdlModule, map: MappedPort[]): Runner {
  const resOf = new Map(map.map(p => [p.port.name, p.res]));
  const inPorts = module.ports.filter(p => p.dir === 'in');
  const outPorts = module.ports.filter(p => p.dir === 'out');
  const segPort = map.find(p => p.res === 'seg');
  return {
    module,
    store: { vals: {}, prevIns: {} },
    ins: inPorts.map(() => 0n),
    inRes: inPorts.map(p => resOf.get(p.name) ?? null),
    outRes: outPorts.map(p => resOf.get(p.name)!),
    segBits: segPort?.port.bits ?? 7,
    hasAn: map.some(p => p.res === 'an'),
    hasClk: map.some(p => p.res === 'clk'),
    clk: 0n,
    frac: 0,
  };
}

export default function FpgaBoard({ initialSource, onSourceChange }: {
  initialSource: string;
  onSourceChange: (src: string) => void;   // keeps the tab's draft persisted
}) {
  const [source, setSource] = useState(initialSource);
  const [curLine, setCurLine] = useState(1);
  const [showCode, setShowCode] = useState(true);
  const [clkHz, setClkHz] = useState(FPGA_DEFAULT_HZ);
  const [running, setRunning] = useState(false);
  const [programmedSrc, setProgrammedSrc] = useState<string | null>(null);
  const [achievedHz, setAchievedHz] = useState(0);
  const [powerOn, setPowerOn] = useState(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  const result = useMemo(() => compileVhdl(source), [source]);
  const mapping = useMemo(() => (result.ok ? mapPortsToBoard(result.module) : null), [result]);
  const errLines = useMemo(
    () => new Set(result.ok ? [] : result.errors.map(e => e.line)),
    [result],
  );
  const lineCount = source.split('\n').length;
  const canProgram = result.ok && !!mapping?.ok;
  const stale = running && programmedSrc !== null && programmedSrc !== source;

  /* ── shared state between React and the render/tick loop ── */
  const visualRef = useRef<FpgaVisualState>({
    power: true,
    done: false,
    sw: 0,
    btn: { btnC: false, btnU: false, btnL: false, btnR: false, btnD: false },
    ledDuty: new Float32Array(16),
    digitSegs: new Uint8Array(4),
  });
  const runnerRef = useRef<Runner | null>(null);
  const clkHzRef = useRef(clkHz);
  clkHzRef.current = clkHz;
  const segLatch = useRef(new Uint8Array(4));
  const segAge = useRef(new Float64Array(4));
  const hzMeter = useRef({ cycles: 0, ms: 0 });

  const update = (src: string) => {
    setSource(src);
    onSourceChange(src);
  };

  const resetDesignState = () => {
    const r = runnerRef.current;
    if (r) { r.store = { vals: {}, prevIns: {} }; r.clk = 0n; r.frac = 0; }
    segLatch.current.fill(0);
    segAge.current.fill(-1e9);
    visualRef.current.ledDuty.fill(0);
    visualRef.current.digitSegs.fill(0);
  };

  const program = () => {
    if (!result.ok || !mapping?.ok) return;
    runnerRef.current = makeRunner(result.module, mapping.map);
    resetDesignState();
    visualRef.current.done = true;
    setRunning(true);
    setProgrammedSrc(source);
  };

  /* one evaluation pass: drive the board's inputs, run, apply outputs */
  const evalOnce = (r: Runner, vis: FpgaVisualState, now: number, ledCounts: Int32Array | null) => {
    for (let i = 0; i < r.ins.length; i++) {
      switch (r.inRes[i]) {
        case 'clk': r.ins[i] = r.clk; break;
        case 'sw': r.ins[i] = BigInt(vis.sw); break;
        case 'btnC': r.ins[i] = vis.btn.btnC ? 1n : 0n; break;
        case 'btnU': r.ins[i] = vis.btn.btnU ? 1n : 0n; break;
        case 'btnL': r.ins[i] = vis.btn.btnL ? 1n : 0n; break;
        case 'btnR': r.ins[i] = vis.btn.btnR ? 1n : 0n; break;
        case 'btnD': r.ins[i] = vis.btn.btnD ? 1n : 0n; break;
        default: r.ins[i] = 0n;
      }
    }
    const outs = evalVhdlModule(r.module, r.store, r.ins);
    let led = 0, seg = 0x7f, dp = 1, an = r.hasAn ? 0xf : 0;   // no an port → all digits on
    for (let j = 0; j < outs.length; j++) {
      const v = Number(outs[j]);
      switch (r.outRes[j]) {
        case 'led': led = v; break;
        case 'seg': seg = v; break;
        case 'dp': dp = v & 1; break;
        case 'an': an = v; break;
      }
    }
    if (r.segBits === 8) { dp = (seg >> 7) & 1; }
    if (ledCounts) {
      for (let i = 0; i < 16; i++) if ((led >> i) & 1) ledCounts[i]++;
    } else {
      for (let i = 0; i < 16; i++) vis.ledDuty[i] = (led >> i) & 1;
    }
    /* common-anode 7-seg: an active-low digit latches the (active-low)
       cathode pattern — persistence of vision for multiplexed scans */
    const pat = (~seg & 0x7f) | (dp === 0 ? 0x80 : 0);
    for (let d = 0; d < 4; d++) {
      if (!((an >> d) & 1)) { segLatch.current[d] = pat; segAge.current[d] = now; }
    }
  };

  const ledCounts = useRef(new Int32Array(16));

  /* per-frame emulation, called by the 3D scene's animation loop */
  const onFrame = (dtMs: number) => {
    const vis = visualRef.current;
    const now = performance.now();
    const r = runnerRef.current;
    if (!r || !vis.power) {
      vis.ledDuty.fill(0);
      vis.digitSegs.fill(0);
      return;
    }
    if (!r.hasClk) {
      evalOnce(r, vis, now, null);                 // combinational: once a frame
    } else {
      const want = clkHzRef.current * (dtMs / 1000) + r.frac;
      let ticks = Math.floor(want);
      r.frac = Math.min(1, want - ticks);
      ticks = Math.min(ticks, MAX_EVALS_PER_FRAME >> 1);
      const counts = ledCounts.current;
      counts.fill(0);
      const t0 = performance.now();
      let done = 0;
      for (; done < ticks; done++) {
        r.clk = 1n;
        evalOnce(r, vis, now, counts);             // outputs settle on the rising edge
        r.clk = 0n;
        evalOnce(r, vis, now, null);
        if ((done & 127) === 127 && performance.now() - t0 > FRAME_BUDGET_MS) { done++; break; }
      }
      if (done > 0) {
        for (let i = 0; i < 16; i++) vis.ledDuty[i] = counts[i] / done;
      }
      const m = hzMeter.current;
      m.cycles += done;
      m.ms += dtMs;
      if (m.ms >= 500) {
        setAchievedHz(Math.round((m.cycles * 1000) / m.ms));
        m.cycles = 0; m.ms = 0;
      }
    }
    for (let d = 0; d < 4; d++) {
      vis.digitSegs[d] = now - segAge.current[d] < DIGIT_HOLD_MS ? segLatch.current[d] : 0;
    }
  };
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  /* ── mount the 3D board once ── */
  useEffect(() => {
    if (!mountRef.current) return;
    const scene = createBasys3Scene(mountRef.current, {
      visual: visualRef.current,
      onFrame: dt => onFrameRef.current(dt),
      onToggleSwitch: i => { visualRef.current.sw ^= 1 << i; },
      onButton: (id: BtnId, down: boolean) => { visualRef.current.btn[id] = down; },
      onTogglePower: () => {
        const vis = visualRef.current;
        vis.power = !vis.power;
        setPowerOn(vis.power);
        // powering up re-loads the design from "flash": state starts clean
        if (vis.power) resetDesignState();
      },
      onProg: () => resetDesignState(),   // PROG button = reconfigure the FPGA
    });
    return () => scene.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── editor plumbing (same behavior as the VHDL tab) ── */
  const syncScroll = () => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };
  const trackCursor = () => {
    const el = taRef.current;
    if (el) setCurLine(el.value.slice(0, el.selectionStart).split('\n').length);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    update(source.slice(0, s) + '  ' + source.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2;
      trackCursor();
    });
  };
  const jumpTo = (line: number) => {
    const el = taRef.current;
    if (!el || line < 1) return;
    const idx = source.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(idx, idx);
    const lh = 20;
    el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 2);
    syncScroll();
    setCurLine(line);
  };

  const fmtHz = (hz: number) =>
    hz >= 1000 ? `${+(hz / 1000).toFixed(1)} kHz` : `${hz} Hz`;

  const status = !result.ok
    ? <>✗ {result.errors.length} error{result.errors.length > 1 ? 's' : ''}</>
    : !mapping!.ok
      ? <>✗ ports don&apos;t fit the board</>
      : <>✓ <b>{result.module.name}</b> fits the Basys 3 · {mapping!.map.length} ports</>;

  return (
    <div id="fpgapane" role="region" aria-label="FPGA board — Basys 3">
      <div className="ve-toolbar">
        <span className={'ve-status' + (canProgram ? ' ok' : ' bad')} aria-live="polite">{status}</span>
        <div className="spacer" />
        <label className="fpga-clkfield" title="Emulated system-clock rate — a real Basys 3 runs clk at 100 MHz; the browser ticks the design at this rate instead">
          <span>Clock</span>
          <select value={clkHz} aria-label="Emulated clock rate" onChange={e => setClkHz(+e.target.value)}>
            {FPGA_CLOCK_RATES.map(r => <option key={r.hz} value={r.hz}>{r.label}</option>)}
          </select>
        </label>
        {running && powerOn && (
          <span className="fpga-hz mono" title="Clock rate actually achieved this half-second">
            {fmtHz(achievedHz)}
          </span>
        )}
        <button className="tbtn" onClick={() => update(FPGA_TEMPLATE)}
          title="Replace the editor contents with the switches + hex-counter starter design">Reset to template</button>
        <button className="tbtn" aria-pressed={showCode} onClick={() => setShowCode(s => !s)}
          title={showCode ? 'Give the board the full width' : 'Show the VHDL editor'}>
          {showCode ? 'Hide code' : 'Show code'}
        </button>
        <button className="tbtn primary" disabled={!canProgram}
          title={canProgram
            ? 'Load this design onto the board — like programming a bitstream over USB'
            : 'Fix the compile / port-mapping errors first'}
          onClick={program}>
          {running ? 'Reprogram board' : 'Program board'}
        </button>
      </div>

      <div className="fpga-body">
        {showCode && (
          <div className="fpga-code">
            <div className="ve-code">
              <div className="ve-gutter mono" ref={gutterRef} aria-hidden="true">
                {Array.from({ length: lineCount }, (_, i) => (
                  <div key={i}
                    className={'ve-ln' + (errLines.has(i + 1) ? ' err' : '') + (curLine === i + 1 ? ' on' : '')}>
                    {i + 1}
                  </div>
                ))}
                <div className="ve-gutterpad" />
              </div>
              <textarea
                ref={taRef}
                className="ve-ta mono"
                spellCheck={false}
                wrap="off"
                autoCapitalize="off"
                autoCorrect="off"
                value={source}
                aria-label="VHDL source for the FPGA board"
                onChange={e => { update(e.target.value); trackCursor(); }}
                onKeyDown={onKeyDown}
                onKeyUp={trackCursor}
                onClick={trackCursor}
                onSelect={trackCursor}
                onScroll={syncScroll}
              />
            </div>
            <div className="ve-foot">
              {!result.ok ? (
                <div className="vhdl-errors">
                  {result.errors.map((er, i) => (
                    <button key={i} className="vhdl-error ve-errbtn" onClick={() => jumpTo(er.line)}
                      title={er.line > 0 ? `Jump to line ${er.line}` : undefined}>
                      {er.line > 0 && <span className="mono">line {er.line}</span>} {er.message}
                    </button>
                  ))}
                </div>
              ) : !mapping!.ok ? (
                <div className="vhdl-errors">
                  {mapping!.errors.map((msg, i) => (
                    <div key={i} className="vhdl-error">{msg}</div>
                  ))}
                </div>
              ) : (
                <div className="vhdl-ports">
                  {mapping!.map.map(p => (
                    <span key={p.port.name} className={'vhdl-port ' + p.port.dir}
                      title={`${p.what} — FPGA pin${p.port.bits > 1 ? 's' : ''} ${p.sites}`}>
                      {p.port.dir === 'in' ? '▸' : '◂'} {p.port.name}
                      <em> → {p.res}{p.port.bits > 1 ? ` · ${p.port.bits}b` : ''}</em>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="fpga-stage">
          <div className="fpga-canvas" ref={mountRef} />
          <div className={'fpga-badge' + (running && powerOn ? ' on' : '')}>
            {!powerOn ? '⏻ board is off — click the red power switch'
              : !running ? 'not programmed — press “Program board”'
              : stale ? '● running an older bitstream — reprogram to apply edits'
              : '● running'}
          </div>
          <div className="fpga-hint">
            drag to orbit · scroll to zoom · shift-drag to pan · click the switches &amp; buttons — PROG resets the design
          </div>
        </div>
      </div>
    </div>
  );
}
