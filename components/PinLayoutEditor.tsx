'use client';

import { useRef, useState } from 'react';
import { GRID, ChipLayout, PinSlot } from '@/lib/engine';

export interface LayoutPin { name: string; bits: number }

interface DragState {
  kind: 'pin' | 'label';
  side: 'in' | 'out';
  idx: number;
  // label drags remember the grab offset so the label doesn't jump
  grabDx?: number;
  grabDy?: number;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
const snapL = (v: number) => Math.round(v / 10) * 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* Interactive chip-package editor for the Save-as-chip dialog.
   Drag pins to grid-snapped positions on either side; drag a pin's name
   label to reposition it. Emits an updated ChipLayout. */
export default function PinLayoutEditor({
  inputs, outputs, name, layout, onChange,
}: {
  inputs: LayoutPin[];
  outputs: LayoutPin[];
  name: string;
  layout: ChipLayout;
  onChange: (l: ChipLayout) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const W = layout.w * GRID, H = layout.h * GRID;

  const pinX = (s: PinSlot) => (s.side === 'R' ? W + 20 : -20);
  const pinY = (s: PinSlot) => clamp(s.slot, 0, layout.h) * GRID;

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
      const side: 'L' | 'R' = w.x > W / 2 ? 'R' : 'L';
      const slot = clamp(Math.round(w.y / GRID), 0, layout.h);
      if (side !== s.side || slot !== s.slot) setSlot(drag.side, drag.idx, { side, slot });
    } else {
      // label offset relative to its default anchor (near the pin's edge)
      const anchorX = s.side === 'R' ? W - 8 : 8;
      const anchorY = pinY(s) + 3;
      const lx = clamp(snapL(w.x - anchorX - (drag.grabDx ?? 0)), -W, W);
      const ly = clamp(snapL(w.y - anchorY - (drag.grabDy ?? 0)), -H, H);
      if (lx !== s.lx || ly !== s.ly) setSlot(drag.side, drag.idx, { lx, ly });
    }
  };

  const endDrag = () => setDrag(null);

  const startPin = (side: 'in' | 'out', idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'pin', side, idx });
  };
  const startLabel = (side: 'in' | 'out', idx: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const s = (side === 'in' ? layout.ins : layout.outs)[idx];
    const w = toWorld(e.clientX, e.clientY);
    const anchorX = s.side === 'R' ? W - 8 : 8;
    const anchorY = pinY(s) + 3;
    setDrag({ kind: 'label', side, idx, grabDx: w.x - anchorX - s.lx, grabDy: w.y - anchorY - s.ly });
  };

  const resize = (dw: number, dh: number) => {
    onChange({
      ...layout,
      w: clamp(layout.w + dw, 4, 16),
      h: clamp(layout.h + dh, 2, 20),
    });
  };

  const renderPins = (side: 'in' | 'out', pins: LayoutPin[], slots: PinSlot[]) =>
    slots.map((s, i) => {
      const px = pinX(s), py = pinY(s);
      const left = s.side === 'L';
      const edge = left ? 0 : W;
      const anchorX = left ? 8 : W - 8;
      const active = drag?.side === side && drag?.idx === i;
      return (
        <g key={`${side}${i}`}>
          <path className="ple-stub" d={`M${px},${py} L${edge},${py}`} />
          <text
            className={'ple-pinname' + (drag?.kind === 'label' && active ? ' drag' : '')}
            x={anchorX + s.lx} y={py + 3 + s.ly}
            textAnchor={left ? 'start' : 'end'}
            onPointerDown={startLabel(side, i)}
          >{pins[i]?.name}{pins[i] && pins[i].bits > 1 ? `[${pins[i].bits}]` : ''}</text>
          <circle
            className={'ple-pin' + (active && drag?.kind === 'pin' ? ' drag' : '')}
            cx={px} cy={py} r={7}
            onPointerDown={startPin(side, i)}
          />
          <circle className="ple-pindot" cx={px} cy={py} r={3.4} />
        </g>
      );
    });

  const pad = 64;
  const vb = `${-pad} ${-24} ${W + pad * 2} ${H + 48}`;

  return (
    <div className="ple">
      <div className="ple-toolbar">
        <span className="ple-hint">Drag pins to reposition · drag labels to nudge names</span>
        <div className="ple-size">
          <button type="button" title="Narrower" onClick={() => resize(-1, 0)}>W−</button>
          <button type="button" title="Wider" onClick={() => resize(1, 0)}>W+</button>
          <button type="button" title="Shorter" onClick={() => resize(0, -1)}>H−</button>
          <button type="button" title="Taller" onClick={() => resize(0, 1)}>H+</button>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="ple-svg"
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <defs>
          <pattern id="ple-dots" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={1} fill="var(--dot)" />
          </pattern>
        </defs>
        <rect x={-pad} y={-24} width={W + pad * 2} height={H + 48} fill="url(#ple-dots)" />
        <g className="comp">
          <rect className="body chipbody" x={0} y={0} width={W} height={H} rx={8} />
          <circle cx={12} cy={10} r={2.5} fill="var(--muted)" />
          <text className="chipname" x={W / 2} y={H / 2 + 4} textAnchor="middle">{name.trim() || 'Chip'}</text>
          {renderPins('in', inputs, layout.ins)}
          {renderPins('out', outputs, layout.outs)}
        </g>
      </svg>
    </div>
  );
}
