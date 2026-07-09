'use client';

import { useRef, useState } from 'react';
import { GRID, ChipLayout, ChipShape, PinSlot, Vec, chipBodyPath } from '@/lib/engine';

export interface LayoutPin { name: string; bits: number }

interface DragState {
  kind: 'pin' | 'label';
  side: 'in' | 'out';
  idx: number;
  // label drags remember the grab offset so the label doesn't jump
  grabDx?: number;
  grabDy?: number;
}

const snapL = (v: number) => Math.round(v / 10) * 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const SHAPES: { id: ChipShape; label: string; title: string }[] = [
  { id: 'rect', label: '▢', title: 'Basic square package' },
  { id: 'mux', label: 'MUX', title: 'Multiplexer trapezoid' },
  { id: 'alu', label: 'ALU', title: 'ALU silhouette' },
  { id: 'custom', label: '✎ Draw', title: 'Draw a custom outline with the line tool' },
];

/* Interactive chip-package editor shared by the Save-as-chip dialog,
   the chip peek popup, and the chip inspector. Drag pins to
   grid-snapped positions on any of the four edges; drag a pin's name
   label to reposition it; pick a package shape or draw one with the
   line tool. Emits an updated ChipLayout / shape. */
export default function PinLayoutEditor({
  inputs, outputs, name, layout, onChange, shape = 'rect', shapePts, onShapeChange,
}: {
  inputs: LayoutPin[];
  outputs: LayoutPin[];
  name: string;
  layout: ChipLayout;
  onChange: (l: ChipLayout) => void;
  shape?: ChipShape;
  shapePts?: Vec[];
  onShapeChange?: (shape: ChipShape, pts?: Vec[]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drawing, setDrawing] = useState<Vec[] | null>(null);   // raw px points of an in-progress outline

  const W = layout.w * GRID, H = layout.h * GRID;

  const pinPt = (s: PinSlot): Vec => {
    if (s.side === 'T') return { x: clamp(s.slot, 0, layout.w) * GRID, y: -20 };
    if (s.side === 'B') return { x: clamp(s.slot, 0, layout.w) * GRID, y: H + 20 };
    return { x: s.side === 'R' ? W + 20 : -20, y: clamp(s.slot, 0, layout.h) * GRID };
  };
  /* Where a pin's name label anchors by default (near its body edge). */
  const labelAnchor = (s: PinSlot) => {
    const p = pinPt(s);
    if (s.side === 'T') return { x: p.x, y: 13, anchor: 'middle' as const };
    if (s.side === 'B') return { x: p.x, y: H - 7, anchor: 'middle' as const };
    return { x: s.side === 'R' ? W - 8 : 8, y: p.y + 3, anchor: s.side === 'R' ? 'end' as const : 'start' as const };
  };

  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const setSlot = (side: 'in' | 'out', idx: number, patch: Partial<PinSlot>) => {
    const key = side === 'in' ? 'ins' : 'outs';
    const list = layout[key].map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange({ ...layout, [key]: list });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const w = toWorld(e.clientX, e.clientY);
    const list = drag.side === 'in' ? layout.ins : layout.outs;
    const s = list[drag.idx];
    if (drag.kind === 'pin') {
      const side: PinSlot['side'] =
        w.y < -10 ? 'T' : w.y > H + 10 ? 'B' : w.x > W / 2 ? 'R' : 'L';
      const slot = side === 'T' || side === 'B'
        ? clamp(Math.round(w.x / GRID), 0, layout.w)
        : clamp(Math.round(w.y / GRID), 0, layout.h);
      if (side !== s.side || slot !== s.slot) setSlot(drag.side, drag.idx, { side, slot });
    } else {
      const a = labelAnchor(s);
      const lx = clamp(snapL(w.x - a.x - (drag.grabDx ?? 0)), -W, W);
      const ly = clamp(snapL(w.y - a.y - (drag.grabDy ?? 0)), -H, H);
      if (lx !== s.lx || ly !== s.ly) setSlot(drag.side, drag.idx, { lx, ly });
    }
  };

  const endDrag = () => setDrag(null);

  const startPin = (side: 'in' | 'out', idx: number) => (e: React.PointerEvent) => {
    if (drawing) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'pin', side, idx });
  };
  const startLabel = (side: 'in' | 'out', idx: number) => (e: React.PointerEvent) => {
    if (drawing) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const s = (side === 'in' ? layout.ins : layout.outs)[idx];
    const w = toWorld(e.clientX, e.clientY);
    const a = labelAnchor(s);
    setDrag({ kind: 'label', side, idx, grabDx: w.x - a.x - s.lx, grabDy: w.y - a.y - s.ly });
  };

  const resize = (dw: number, dh: number) => {
    onChange({
      ...layout,
      w: clamp(layout.w + dw, 4, 20),
      h: clamp(layout.h + dh, 2, 20),
    });
  };

  /* ── custom-outline line tool ── */
  const finishDraw = (pts: Vec[]) => {
    if (pts.length >= 3) {
      const norm = pts.map(p => ({
        x: Math.round((clamp(p.x, 0, W) / W) * 100) / 100,
        y: Math.round((clamp(p.y, 0, H) / H) * 100) / 100,
      }));
      onShapeChange?.('custom', norm);
    }
    setDrawing(null);
  };
  const onCanvasDown = (e: React.PointerEvent) => {
    if (!drawing) return;
    e.preventDefault();
    const w = toWorld(e.clientX, e.clientY);
    const p = { x: clamp(snapL(w.x), 0, W), y: clamp(snapL(w.y), 0, H) };
    const first = drawing[0];
    // clicking back on the first point closes the outline
    if (first && drawing.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) < 12) {
      finishDraw(drawing);
      return;
    }
    const last = drawing[drawing.length - 1];
    if (last && last.x === p.x && last.y === p.y) return;
    setDrawing([...drawing, p]);
  };
  const pickShape = (s: ChipShape) => {
    if (!onShapeChange) return;
    if (s === 'custom') {
      setDrawing([]);      // arm the line tool; the outline applies when closed
      return;
    }
    setDrawing(null);
    onShapeChange(s);
  };

  const renderPins = (side: 'in' | 'out', pins: LayoutPin[], slots: PinSlot[]) =>
    slots.map((s, i) => {
      const p = pinPt(s);
      const a = labelAnchor(s);
      const edge = s.side === 'T' ? { x: p.x, y: 0 }
        : s.side === 'B' ? { x: p.x, y: H }
        : { x: s.side === 'L' ? 0 : W, y: p.y };
      const active = drag?.side === side && drag?.idx === i;
      return (
        <g key={`${side}${i}`}>
          <path className="ple-stub" d={`M${p.x},${p.y} L${edge.x},${edge.y}`} />
          <text
            className={'ple-pinname' + (drag?.kind === 'label' && active ? ' drag' : '')}
            x={a.x + s.lx} y={a.y + s.ly}
            textAnchor={a.anchor}
            onPointerDown={startLabel(side, i)}
          >{pins[i]?.name}{pins[i] && pins[i].bits > 1 ? `[${pins[i].bits}]` : ''}</text>
          <circle
            className={'ple-pin' + (active && drag?.kind === 'pin' ? ' drag' : '')}
            cx={p.x} cy={p.y} r={7}
            onPointerDown={startPin(side, i)}
          />
          <circle className="ple-pindot" cx={p.x} cy={p.y} r={3.4} />
        </g>
      );
    });

  const padX = 64, padY = 44;
  const vb = `${-padX} ${-padY} ${W + padX * 2} ${H + padY * 2}`;
  const bodyD = chipBodyPath(drawing ? 'rect' : shape, W, H, shapePts);

  return (
    <div className="ple">
      <div className="ple-toolbar">
        <span className="ple-hint">
          {drawing
            ? `Line tool: click dots to outline the package — click the first point to close (${drawing.length} pts)`
            : 'Drag pins to any edge · drag labels to nudge names'}
        </span>
        <div className="ple-size">
          <button type="button" title="Narrower" onClick={() => resize(-1, 0)}>W−</button>
          <button type="button" title="Wider" onClick={() => resize(1, 0)}>W+</button>
          <button type="button" title="Shorter" onClick={() => resize(0, -1)}>H−</button>
          <button type="button" title="Taller" onClick={() => resize(0, 1)}>H+</button>
        </div>
      </div>
      {onShapeChange && (
        <div className="ple-toolbar ple-shapes">
          <span className="ple-hint">Package shape</span>
          {SHAPES.map(s => (
            <button key={s.id} type="button" title={s.title}
              className={(drawing ? s.id === 'custom' : shape === s.id) ? 'on' : ''}
              onClick={() => pickShape(s.id)}>{s.label}</button>
          ))}
          {drawing && (
            <>
              <button type="button" disabled={drawing.length < 3}
                onClick={() => finishDraw(drawing)}>Close shape</button>
              <button type="button" onClick={() => setDrawing(null)}>Cancel</button>
            </>
          )}
        </div>
      )}
      <svg
        ref={svgRef}
        className={'ple-svg' + (drawing ? ' drawing' : '')}
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onPointerDown={onCanvasDown}
      >
        <defs>
          <pattern id="ple-dots" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={1} fill="var(--dot)" />
          </pattern>
        </defs>
        <rect x={-padX} y={-padY} width={W + padX * 2} height={H + padY * 2} fill="url(#ple-dots)" />
        <g className="comp">
          {bodyD
            ? <path className="body chipbody" d={bodyD} />
            : <rect className="body chipbody" x={0} y={0} width={W} height={H} rx={8} />}
          {!bodyD && <circle cx={12} cy={10} r={2.5} fill="var(--muted)" />}
          <text className="chipname" x={W / 2} y={H / 2 + 4} textAnchor="middle">{name.trim() || 'Chip'}</text>
          {renderPins('in', inputs, layout.ins)}
          {renderPins('out', outputs, layout.outs)}
          {drawing && drawing.length > 0 && (
            <>
              <path className="ple-drawline"
                d={'M' + drawing.map(p => `${p.x},${p.y}`).join(' L')} />
              {drawing.map((p, i) => (
                <circle key={i} className={'ple-drawpt' + (i === 0 ? ' first' : '')} cx={p.x} cy={p.y} r={i === 0 ? 5 : 3.5} />
              ))}
            </>
          )}
        </g>
      </svg>
    </div>
  );
}
