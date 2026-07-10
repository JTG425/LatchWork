'use client';

/* Chip behavior UI — the auto-generated preview (abstract package ⇄
   internals), truth table, and state diagram for a ChipDef. Shared by
   the chip inspector dialog and the community storefront. */

import { useMemo, useState } from 'react';
import { ChipDef, ChipLib, chipOutputBits, formatBusValue } from '@/lib/engine';
import { analyzeChip, comboLabel, MAX_TT_INPUTS, MAX_FSM_INPUTS, FsmEdge } from '@/lib/analyze';
import { chipAbstractSVG, chipInternalsSVG } from '@/lib/chip-svg';

/* ── preview with abstract / internals toggle ── */
export function ChipPreview({ def, lib, tall }: { def: ChipDef; lib: ChipLib; tall?: boolean }) {
  const [view, setView] = useState<'chip' | 'internals'>('chip');
  const svg = useMemo(
    () => (view === 'chip' ? chipAbstractSVG(def) : chipInternalsSVG(def, lib)),
    [view, def, lib],
  );
  return (
    <div className="chippreview">
      <div className="chippreview-tabs">
        <button className={view === 'chip' ? 'on' : ''} onClick={() => setView('chip')}>Chip</button>
        <button className={view === 'internals' ? 'on' : ''} onClick={() => setView('internals')}>Internals</button>
      </div>
      <div className={'chippreview-art' + (tall ? ' tall' : '')} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

/* Static thumbnail of the abstracted chip (community cards). */
export function ChipThumb({ def }: { def: ChipDef }) {
  const svg = useMemo(() => chipAbstractSVG(def), [def]);
  return <div className="chipthumb" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/* ── state diagram (SVG, circle layout) ── */
function StateDiagram({ states, edges, nIn }: { states: number; edges: FsmEdge[]; nIn: number }) {
  const R = Math.max(85, states * 30);
  const NODE_R = 22;
  const size = 2 * (R + 80);
  const cx = size / 2, cy = size / 2;
  const pos = (i: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / states;
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  };
  const label = (e: FsmEdge) =>
    e.combos.map(c => comboLabel(c, nIn)).join(',') + ' / ' + e.outs.map(String).join('');

  // parallel edges between the same pair bow at increasing offsets
  const pairCount = new Map<string, number>();
  const parts: React.ReactNode[] = [];
  edges.forEach((e, idx) => {
    const p1 = pos(e.from), p2 = pos(e.to);
    if (e.from === e.to) {
      const nth = pairCount.get(`${e.from}self`) ?? 0;
      pairCount.set(`${e.from}self`, nth + 1);
      // loop drawn radially outward from the circle center
      const ux = (p1.x - cx) / (Math.hypot(p1.x - cx, p1.y - cy) || 1);
      const uy = (p1.y - cy) / (Math.hypot(p1.x - cx, p1.y - cy) || 1);
      const r = 15 + nth * 9;
      const lx = p1.x + ux * (NODE_R + r), ly = p1.y + uy * (NODE_R + r);
      parts.push(
        <g key={'e' + idx}>
          <circle cx={lx} cy={ly} r={r} className="fsm-edge" fill="none" />
          <text className="fsm-elabel" x={lx + ux * (r + 6)} y={ly + uy * (r + 6) + 3}
            textAnchor={Math.abs(ux) < 0.4 ? 'middle' : ux > 0 ? 'start' : 'end'}>{label(e)}</text>
        </g>,
      );
      return;
    }
    const key = `${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}`;
    const nth = pairCount.get(key) ?? 0;
    pairCount.set(key, nth + 1);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;               // perpendicular (left of travel)
    const bow = 26 + nth * 34;
    const mx = (p1.x + p2.x) / 2 + px * bow, my = (p1.y + p2.y) / 2 + py * bow;
    const a = { x: p1.x + ux * NODE_R, y: p1.y + uy * NODE_R };
    const b = { x: p2.x - ux * NODE_R, y: p2.y - uy * NODE_R };
    const lx = 0.25 * a.x + 0.5 * mx + 0.25 * b.x;
    const ly = 0.25 * a.y + 0.5 * my + 0.25 * b.y;
    parts.push(
      <g key={'e' + idx}>
        <path className="fsm-edge" d={`M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`} fill="none" markerEnd="url(#fsmarrow)" />
        <text className="fsm-elabel" x={lx + px * 10} y={ly + py * 10 + 3} textAnchor="middle">{label(e)}</text>
      </g>,
    );
  });

  return (
    <svg className="fsm" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="State transition diagram">
      <defs>
        <marker id="fsmarrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fsm-arrow" />
        </marker>
      </defs>
      {parts}
      {Array.from({ length: states }, (_, i) => {
        const p = pos(i);
        return (
          <g key={'s' + i}>
            <circle className={'fsm-node' + (i === 0 ? ' start' : '')} cx={p.x} cy={p.y} r={NODE_R} />
            {i === 0 && <circle className="fsm-node-inner" cx={p.x} cy={p.y} r={NODE_R - 4} fill="none" />}
            <text className="fsm-nlabel" x={p.x} y={p.y + 4} textAnchor="middle">S{i}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── truth table + state machine ── */
export default function ChipAnalysis({ def, lib }: { def: ChipDef; lib: ChipLib }) {
  const a = useMemo(() => {
    try { return analyzeChip(def, lib); } catch { return null; }
  }, [def, lib]);
  const outBits = useMemo(() => chipOutputBits(def), [def]);

  if (!a) return <p className="analysis-note">Couldn&apos;t analyze this chip — its definition may reference chips that aren&apos;t available.</p>;

  return (
    <div className="analysis">
      <div className="analysis-badges">
        <span className={'badge ' + (a.kind === 'sequential' ? 'seq' : a.kind === 'combinational' ? 'comb' : '')}>
          {a.kind === 'sequential' ? 'Sequential logic' : a.kind === 'combinational' ? 'Combinational logic' : 'Behavior not fully explored'}
        </span>
        <span className="badge">{a.inputs.length} in · {a.outputs.length} out</span>
        {a.hasClock && <span className="badge clk">Contains a clock — outputs also change with time</span>}
      </div>

      <h3>Truth table {a.kind === 'sequential' && <em>(from power-on state)</em>}</h3>
      {a.truth ? (
        <div className="ttwrap">
          <table className="truthtable mono">
            <thead>
              <tr>
                {a.inputs.map((n, i) => <th key={'i' + i}>{n}</th>)}
                <th className="ttsep" aria-hidden="true">→</th>
                {a.outputs.map((n, i) => <th key={'o' + i}>{n}</th>)}
              </tr>
            </thead>
            <tbody>
              {a.truth.map((row, r) => (
                <tr key={r}>
                  {row.ins.map((v, i) => <td key={'i' + i}>{v}</td>)}
                  <td className="ttsep" aria-hidden="true" />
                  {row.outs.map((v, i) => <td key={'o' + i} className={v ? 'hi' : ''}>{formatBusValue(v, outBits[i] ?? 1)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="analysis-note">This chip has more than {MAX_TT_INPUTS} inputs — too many combinations to enumerate.</p>
      )}

      <h3>State machine</h3>
      {a.kind === 'combinational' && (
        <p className="analysis-note">This chip is purely combinational — its outputs depend only on its current inputs, so there are no internal states to diagram.</p>
      )}
      {a.kind === 'unknown' && (
        <p className="analysis-note">
          {a.inputs.length > MAX_FSM_INPUTS
            ? `State exploration is limited to chips with at most ${MAX_FSM_INPUTS} inputs.`
            : 'This chip reaches too many internal states to diagram.'}
        </p>
      )}
      {a.kind === 'sequential' && a.fsm && (
        <>
          <p className="analysis-note">
            {a.fsm.states} states reachable from power-on (S0). Edges read
            <b className="mono"> {a.inputs.join(' ')} / {a.outputs.join(' ')}</b> — the input combination that
            takes the transition, and the outputs it produces.
          </p>
          <div className="fsmwrap">
            <StateDiagram states={a.fsm.states} edges={a.fsm.edges} nIn={a.inputs.length} />
          </div>
        </>
      )}
    </div>
  );
}
