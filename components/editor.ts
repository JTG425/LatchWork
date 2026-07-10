/* ────────────────────────────────────────────────────────────────
   Latchwork editor — imperative SVG canvas.
   Owns pointer interaction, wiring, pan/zoom, and rendering.
   Pure logic lives in lib/engine; React (Simulator.tsx) owns the
   chrome around the canvas and talks to this through EditorApi.
   ──────────────────────────────────────────────────────────────── */

   import {
    GRID, Comp, Wire, WireEnd, PinEnd, Vec, Board, ChipLib, CompType, EdgeMode,
    ChipLayout, cloneChipLayout, resizeBusLayout, busToolMinW, busToolMinH,
    SimState, newSimState, getGeom, evaluateNet, analyzeNets,
    normalizeWires, isPinEnd, isAttachEnd, tunnelPinGroups,
    MULTI_IN_GATES, clampGateIns, clampFreq, clampBits, CHIP_MIN_W, chipMinH,
    maskVal, storeVal, formatBusValue,
    SEG_NAMES, edgeableComp, defaultEdgeForComp, isMemoryType, isBusToolType, chipLabelOffset,
    wireRouteCorners, wireCornerPath, wireEndFacing, chipBodyPath,
    cloneBoard, cloneWireEnd,
  } from '@/lib/engine';
  import { GATE_DEFS, isGateType } from '@/lib/gates';

  export interface SelInfo {
    kind: 'comp' | 'wire' | 'multi';
    id: string;
    count?: number;     // multi: number of selected parts
    type?: CompType;
    chipId?: string;    // CHIP: which library chip this instance places
    label?: string;
    labelable?: boolean;
    nIns?: number;      // gates: input count; bus tools: bit count
    freq?: number;      // clocks
    bits?: number;      // wires: bus width
    pinBits?: number;   // IPIN/OPIN/VAL: port bus width; gates: bitwise operand width
    val?: bigint;       // VAL / multi-bit IPIN: driven value (bus integer)
    edgeable?: boolean; // gates/chips can be sampled on a clock edge
    edge?: EdgeMode;
  }

  export interface PlacingInfo { type: CompType; chipId?: string }

  export interface EditorCallbacks {
    getLib(): ChipLib;
    onSelect(info: SelInfo | null): void;
    onCounts(c: { parts: number; wires: number }): void;
    onZoom(pct: number): void;
    onBoardChange(): void;
    onPlacing?(p: PlacingInfo | null): void;
    onWireTool?(on: boolean): void;
    /* double-click on a placed chip — Simulator opens the live peek popup */
    onChipDblClick?(compId: string, chipId: string): void;
    /* double-click on a combiner/splitter — Simulator opens its pin-layout editor */
    onBusToolDblClick?(compId: string): void;
  }

  export interface EditorApi {
    beginPlace(type: CompType, chipId?: string): void;
    deleteSelection(): void;
    rotateSelection(): void;
    clearSelection(): void;
    setWireTool(on: boolean): void;
    clear(): void;
    powerCycle(): void;
    zoomIn(): void;
    zoomOut(): void;
    resetView(): void;
    setLabel(id: string, label: string): void;
    setNumInputs(id: string, n: number): void;
    setPinBits(id: string, bits: number): void;
    setValue(id: string, val: bigint): void;
    setFreq(id: string, hz: number): void;
    setEdge(id: string, edge: EdgeMode | null): void;
    setWireBits(id: string, bits: number): void;
    /* COMB/SPLIT: apply a custom pin layout (pins on any edge + body size) */
    setBusLayout(id: string, layout: ChipLayout): void;
    /* re-seed every wire's bus width from the pins it touches — call after
       a chip definition's pin widths change */
    refreshWireBits(): void;
    getBoard(): Board;
    setBoard(b: Board): void;
    removeChipInstances(chipId: string): void;
    /* live simulation state of one placed chip instance (its internals) —
       the returned object is the editor's own; treat it as read-only */
    getChipSubState(compId: string): SimState | null;
    rerender(): void;
    destroy(): void;
  }

  const uid = () =>
    'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const snap = (v: number) => Math.round(v / GRID) * GRID;

  /* Rotation in quarter turns about the body's own footprint. The
     mapping keeps every grid-aligned pin on the grid because body
     w/h are grid multiples:
       1 (down):  (x,y) → (h−y, x)
       2 (left):  (x,y) → (w−x, h−y)
       3 (up):    (x,y) → (y, w−x)                                   */
  function rotPt(px: number, py: number, rot: number, w: number, h: number): Vec {
    switch (rot & 3) {
      case 1: return { x: h - py, y: px };
      case 2: return { x: w - px, y: h - py };
      case 3: return { x: py, y: w - px };
      default: return { x: px, y: py };
    }
  }
  function rotTransform(rot: number, w: number, h: number): string {
    switch (rot & 3) {
      case 1: return `rotate(90) translate(0,${-h})`;
      case 2: return `rotate(180) translate(${-w},${-h})`;
      case 3: return `rotate(-90) translate(${-w},0)`;
      default: return '';
    }
  }
  const footprint = (rot: number, w: number, h: number) =>
    (rot & 1) ? { w: h, h: w } : { w, h };

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const edgeText = (c: Pick<Comp, 'edge'>) => c.edge === 'rise' ? ' / rise' : c.edge === 'fall' ? ' / fall' : '';

  export function createEditor(svg: SVGSVGElement, cb: EditorCallbacks): EditorApi {
    const world = svg.querySelector('#world') as SVGGElement;

    /* ── state ── */
    let comps: Comp[] = [];
    let wires: Wire[] = [];
    let sim: SimState = newSimState();
    let view = { x: 0, y: 0, k: 1 };

    let selIds = new Set<string>();      // selected comps (1..n)
    let selWire: string | null = null;   // or a single selected wire
    let wireTool = false;
    let wiring: { start: WireEnd; via: Vec[]; mx: number; my: number; downX: number; downY: number; fresh: boolean } | null = null;
    let drag: {
      ids: string[]; primary: string;
      offs: Record<string, { ox: number; oy: number }>; orig: Record<string, Vec>;
      dragWires: { w: Wire; via: Vec[]; a: WireEnd; b: WireEnd }[];
      moved: boolean; sx: number; sy: number;
    } | null = null;
    let resize: { id: string } | null = null;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let placing: { type: CompType; chipId?: string; rot: number; mx: number; my: number; over: boolean; held: boolean } | null = null;
    let clipboard: { comps: Comp[]; wires: Wire[] } | null = null;
    let spaceDown = false;
    let lastPt = { x: 0, y: 0, over: false };
    let hoverWire: string | null = null;   // wire under cursor while the wire tool is armed

    const lib = () => cb.getLib();

    /* ── helpers ── */
    function toWorld(clientX: number, clientY: number) {
      const r = svg.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
    }
    function pinPos(c: Comp, side: 'in' | 'out', idx: number): Vec {
      const g = getGeom(c, lib());
      const p = g[side === 'out' ? 'outs' : 'ins'][idx];
      if (!p) return { x: c.x, y: c.y };
      const r = rotPt(p.x, p.y, c.rot ?? 0, g.w, g.h);
      return { x: c.x + r.x, y: c.y + r.y };
    }
    function endPos(e: WireEnd): Vec {
      if (isPinEnd(e)) {
        const c = find(e.comp);
        return c ? pinPos(c, e.side, e.pin) : { x: 0, y: 0 };
      }
      return { x: (e as Vec).x, y: (e as Vec).y };
    }
    /* The corner points of a wire's drawn path — auto-routing lives in
       lib/engine (wireRouteCorners) so previews render the same shape. */
    function wirePolyline(w: Wire): Vec[] {
      const a = endPos(w.a), b = endPos(w.b);
      if (w.via?.length) return [a, ...w.via, b];
      return wireRouteCorners(a, b, wireEndFacing(w.a), wireEndFacing(w.b));
    }
    const wirePathFor = (w: Wire) => wireCornerPath(wirePolyline(w));
    /* Nearest point ON a wire's path to `p`, snapped to a grid dot that
       lies on the wire — so a split's junction sits exactly where the
       branch meets the host wire. */
    function attachPointOnWire(w: Wire, p: Vec): Vec {
      const pts = wirePolyline(w);
      let best: Vec = { x: snap(p.x), y: snap(p.y) };
      let bestD = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const s = pts[i], e = pts[i + 1];
        const dx = e.x - s.x, dy = e.y - s.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / len2)) : 0;
        const proj = { x: s.x + dx * t, y: s.y + dy * t };
        let hit: Vec;
        if (s.y === e.y) {             // horizontal: snap x along the run
          const lo = Math.min(s.x, e.x), hi = Math.max(s.x, e.x);
          hit = { x: Math.max(lo, Math.min(hi, snap(proj.x))), y: s.y };
        } else if (s.x === e.x) {      // vertical: snap y along the run
          const lo = Math.min(s.y, e.y), hi = Math.max(s.y, e.y);
          hit = { x: s.x, y: Math.max(lo, Math.min(hi, snap(proj.y))) };
        } else {                       // (via can be diagonal) snap both
          hit = { x: snap(proj.x), y: snap(proj.y) };
        }
        const d = (hit.x - p.x) ** 2 + (hit.y - p.y) ** 2;
        if (d < bestD) { bestD = d; best = hit; }
      }
      return best;
    }
    const find = (id: string) => comps.find(c => c.id === id);

    function selInfoFor(c: Comp): SelInfo {
      // ports carry a pin width; gates carry a bitwise operand width
      const isPort = c.type === 'IPIN' || c.type === 'OPIN' || c.type === 'VAL';
      const portBits = isPort || isGateType(c.type) ? clampBits(c.bits ?? 1) : undefined;
      // VAL always takes a typed value; an IPIN only once it's a bus
      const valued = c.type === 'VAL' || (c.type === 'IPIN' && (portBits ?? 1) > 1);
      return {
        kind: 'comp', id: c.id, type: c.type, chipId: c.chipId, label: c.label || '',
        labelable: c.type === 'IN' || c.type === 'BTN' || c.type === 'OUT' || c.type === 'CHIP'
          || c.type === 'IPIN' || c.type === 'OPIN' || c.type === 'CLK'
          || c.type === 'TUN' || c.type === 'SSEG' || c.type === 'VAL',
        nIns: MULTI_IN_GATES.has(c.type)
          ? clampGateIns(c.nIns)
          : isBusToolType(c.type) ? clampBits(c.nIns ?? 4) : undefined,
        pinBits: portBits,
        val: valued ? maskVal(c.val, portBits ?? 1) : undefined,
        freq: c.type === 'CLK' ? clampFreq(c.freq) : undefined,
        edgeable: edgeableComp(c),
        edge: defaultEdgeForComp(c),
      };
    }
    function emitSel() {
      if (selWire) {
        const w = wires.find(x => x.id === selWire);
        cb.onSelect({ kind: 'wire', id: selWire, bits: clampBits(w?.bits) });
        return;
      }
      if (selIds.size === 1) {
        const c = find([...selIds][0]);
        cb.onSelect(c ? selInfoFor(c) : null);
        return;
      }
      if (selIds.size > 1) { cb.onSelect({ kind: 'multi', id: [...selIds][0], count: selIds.size }); return; }
      cb.onSelect(null);
    }
    function setSelection(ids: Iterable<string>, wire: string | null = null) {
      selIds = new Set(ids);
      selWire = wire;
      emitSel();
    }
    function setPlacing(p: typeof placing) {
      placing = p;
      cb.onPlacing?.(placing ? { type: placing.type, chipId: placing.chipId } : null);
    }
    function setWireTool(on: boolean) {
      wireTool = on;
      if (!on) { hoverWire = null; if (wiring) wiring = null; }
      cb.onWireTool?.(on);
      render();
    }

    /* wires whose deleted host no longer exists would dangle from
       nothing — cascade them away after any wire removal */
    function pruneAttached() {
      for (;;) {
        const ids = new Set(wires.map(w => w.id));
        const keep = wires.filter(w => [w.a, w.b].every(e => !isAttachEnd(e) || ids.has(e.wire)));
        if (keep.length === wires.length) return;
        wires = keep;
      }
    }

    /* ── simulation ── */
    function recompute() {
      evaluateNet(comps, wires, sim, lib(), undefined, 0, Date.now());
    }

    /* Clocks re-simulate on their own: whenever any clock on the board
       (or inside a placed chip) crosses a half-period boundary, refresh. */
    function clockSig(now: number): string {
      let sig = '';
      const visit = (cs: Comp[], depth: number) => {
        if (depth > 6) return;
        for (const c of cs) {
          if (c.type === 'CLK') sig += Math.floor(now / (500 / clampFreq(c.freq))) % 2;
          else if (c.type === 'CHIP' && c.chipId) { const d = lib()[c.chipId]; if (d) visit(d.comps, depth + 1); }
        }
      };
      visit(comps, 0);
      return sig;
    }
    let lastClockSig = '';
    const clockTimer = window.setInterval(() => {
      const sig = clockSig(Date.now());
      if (sig !== lastClockSig) { lastClockSig = sig; refresh(false); }
    }, 25);

    /* ── rendering ── */
    function compSVG(c: Comp, ghost: boolean): string {
      const g = getGeom(c, lib());
      const rot = (c.rot ?? 0) & 3;
      const selected = !ghost && selIds.has(c.id);
      const selCls = selected ? ' selected' : '';
      let inner = '', stubs = '', pins = '';
      // counter-rotate text so labels stay readable at any orientation
      const ctr = (x: number, y: number) => rot ? ` transform="rotate(${-rot * 90} ${x} ${y})"` : '';
      const caption = (text: string, x: number, y: number) =>
        `<text class="lbl" x="${x}" y="${y}"${ctr(x, y)}>${esc(text)}</text>`;
      const pinSVG = (side: 'in' | 'out', idx: number, p: Vec, hi: number) =>
        `<circle class="pinhit" data-pin="${c.id}|${side}|${idx}" cx="${p.x}" cy="${p.y}" r="10"/>
         <circle class="pin ${hi ? 'hi' : ''}" cx="${p.x}" cy="${p.y}" r="3.6"/>`;

      // where a pin's stub meets the body — chips may carry pins on any
      // of the four edges, everything else keeps left-in / right-out.
      // Stubs may end slightly inside the body; overshoot hides under
      // the fill (stubs render before the body).
      const stubEnd = (p: Vec, out: boolean): Vec => {
        if (c.type === 'CHIP' || isBusToolType(c.type)) {
          if (p.y < 0) return { x: p.x, y: 8 };
          if (p.y > g.h) return { x: p.x, y: g.h - 8 };
          return { x: p.x < 0 ? 8 : g.w - 8, y: p.y };
        }
        if (out) return { x: g.w - (isGateType(c.type) ? 12 : 0), y: p.y };
        return { x: isGateType(c.type) ? GATE_DEFS[c.type].stubX : 8, y: p.y };
      };
      g.ins.forEach((p, i) => {
        const hi = c._ins?.[i] ? 1 : 0;
        const e = stubEnd(p, false);
        stubs += `<path class="stub ${hi ? 'hi' : ''}" d="M${p.x},${p.y} L${e.x},${e.y}"/>`;
        pins += pinSVG('in', i, p, hi);
      });
      g.outs.forEach((p, i) => {
        const hi = sim.vals[c.id + ':' + i] ? 1 : 0;
        const e = stubEnd(p, true);
        stubs += `<path class="stub ${hi ? 'hi' : ''}" d="M${e.x},${e.y} L${p.x},${p.y}"/>`;
        pins += pinSVG('out', i, p, hi);
      });

      if (isGateType(c.type)) {
        /* Body path, back curve, and inversion bubble all come from the
           gate's own file in lib/gates — look there for shape bugs. */
        const gd = GATE_DEFS[c.type];
        const gb = clampBits(c.bits ?? 1);
        inner = `<path class="body" d="${gd.body(g.h)}"/>`;
        const curve = gd.backCurve?.(g.h);
        if (curve)
          inner += `<path d="${curve}" fill="none" stroke="var(--body-stroke)" stroke-width="1.5"/>`;
        const bub = gd.bubble?.(g.h);
        if (bub)
          inner += `<circle cx="${bub.cx}" cy="${bub.cy}" r="${bub.r}" class="body"/>`;
        inner += caption(`${g.name}${gb > 1 ? ` · ${gb}b` : ''}${edgeText(c)}`, 30, gd.captionY ?? g.h + 21);
      } else if (c.type === 'IN') {
        const on = !!c.on;
        inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
          <rect x="11" y="11" width="38" height="18" rx="9" fill="${on ? 'var(--hi)' : '#3a3a44'}" style="transition:fill .15s"/>
          <circle cx="${on ? 40 : 20}" cy="20" r="7" fill="#f5f5f7" style="transition:cx .15s"/>` +
          caption(`${c.label || 'SW'} · ${on ? 1 : 0}`, 30, 52);
      } else if (c.type === 'BTN') {
        const on = !!c.pressed;
        inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
          <circle cx="30" cy="20" r="11" fill="${on ? 'var(--hi)' : '#3a3a44'}" stroke="var(--body-stroke)" stroke-width="1.5"/>
          <circle cx="30" cy="20" r="${on ? 4.5 : 6}" fill="${on ? '#0d331a' : '#55555f'}"/>` +
          caption(`${c.label || 'BTN'} · ${on ? 1 : 0}`, 30, 52);
      } else if (c.type === 'ONE') {
        inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="9"/>
          <text class="pindigit hi" x="20" y="26"${ctr(20, 20)}>1</text>` +
          caption('HIGH', 20, 52);
      } else if (c.type === 'CLK') {
        const on = sim.vals[c.id + ':0'] ? 1 : 0;
        inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
          <path d="M10,${on ? 13 : 27} H19 V${on ? 27 : 13} H29 V${on ? 13 : 27} H39 V${on ? 27 : 13} H49"
            fill="none" stroke="${on ? 'var(--hi)' : 'var(--muted)'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
          caption(`${c.label || 'CLK'} · ${clampFreq(c.freq)}Hz`, 30, 52);
      } else if (c.type === 'IPIN') {
        const n = clampBits(c.bits ?? 1);
        const v = n > 1 ? maskVal(c.val, n) : (c.on ? 1n : 0n);
        const lit = v !== 0n;
        const txt = n > 1 ? formatBusValue(v, n) : v.toString();
        const fs = n > 1 ? 12 : 15;
        inner = `<rect class="body pinport ${lit ? 'hi' : ''}" x="0" y="0" width="${g.w}" height="40" rx="7"/>
          <text class="pindigit ${lit ? 'hi' : ''}" x="${g.w / 2}" y="25" style="font-size:${fs}px"${ctr(g.w / 2, 20)}>${txt}</text>` +
          caption(`▸ ${c.label || 'IN?'}${n > 1 ? ` · ${n}b` : ''}`, g.w / 2, 52);
      } else if (c.type === 'OPIN') {
        const n = clampBits(c.bits ?? 1);
        const v = maskVal(c._ins?.[0] ?? 0, n);
        const lit = v !== 0n;
        const txt = n > 1 ? formatBusValue(v, n) : v.toString();
        const fs = n > 1 ? 12 : 15;
        const shape = n > 1
          ? `<rect class="body pinport ${lit ? 'hi' : ''}" x="0" y="0" width="${g.w}" height="40" rx="19"/>`
          : `<circle class="body pinport ${lit ? 'hi' : ''}" cx="20" cy="20" r="19"/>`;
        inner = `${shape}
          <text class="pindigit ${lit ? 'hi' : ''}" x="${g.w / 2}" y="25" style="font-size:${fs}px"${ctr(g.w / 2, 20)}>${txt}</text>` +
          caption(`${c.label || 'OUT?'}${n > 1 ? ` · ${n}b` : ''} ▸`, g.w / 2, 52);
      } else if (c.type === 'VAL') {
        const n = clampBits(c.bits ?? 1);
        const v = maskVal(c.val, n);
        const lit = v !== 0n;
        const txt = formatBusValue(v, n);
        inner = `<rect class="body" x="0" y="0" width="${g.w}" height="40" rx="9"/>
          <text class="pindigit ${lit ? 'hi' : ''}" x="${g.w / 2}" y="25" style="font-size:12px"${ctr(g.w / 2, 20)}>${txt}</text>` +
          caption(`${c.label || 'VAL'} · ${n}b`, g.w / 2, 52);
      } else if (c.type === 'OUT') {
        const lit = c._ins?.[0] ?? 0;
        inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="10"/>
          <circle cx="20" cy="20" r="11" fill="${lit ? 'var(--led-on)' : '#33333b'}"
            stroke="${lit ? '#ff6b61' : '#4a4a54'}" stroke-width="1.5" ${lit ? 'filter="url(#ledglow)"' : ''}/>
          ${lit ? '<circle cx="16.5" cy="16.5" r="3" fill="#ffd7d4" opacity=".85"/>' : ''}` +
          caption(c.label || 'LED', 20, 52);
      } else if (c.type === 'SSEG') {
        /* One digit, driven pin-per-segment (a b c d e f g dp, top to
           bottom). Classic segment ring in a 36×104 box. */
        const on = (i: number) => (c._ins?.[i] ?? 0) ? 1 : 0;
        const ox = 42, oy = 26, W = 36, H = 104, my = oy + H / 2;
        const seg = (i: number, d: string) =>
          `<path d="${d}" class="seg${on(i) ? ' hi' : ''}" ${on(i) ? 'filter="url(#ledglow)"' : ''}/>`;
        inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="9"/>
          <rect x="28" y="8" width="${g.w - 36}" height="${g.h - 16}" rx="7" fill="#141417"/>`
          + seg(0, `M${ox + 4},${oy} H${ox + W - 4}`)                    // a
          + seg(1, `M${ox + W},${oy + 4} V${my - 4}`)                    // b
          + seg(2, `M${ox + W},${my + 4} V${oy + H - 4}`)                // c
          + seg(3, `M${ox + 4},${oy + H} H${ox + W - 4}`)                // d
          + seg(4, `M${ox},${my + 4} V${oy + H - 4}`)                    // e
          + seg(5, `M${ox},${oy + 4} V${my - 4}`)                        // f
          + seg(6, `M${ox + 4},${my} H${ox + W - 4}`)                    // g
          + `<circle cx="${ox + W + 12}" cy="${oy + H}" r="4.5" class="seg${on(7) ? ' hi' : ''}" ${on(7) ? 'filter="url(#ledglow)"' : ''}/>`;
        g.ins.forEach((p, i) => {
          inner += `<text class="pinname" x="10" y="${p.y + 3}" text-anchor="start"${ctr(10, p.y)}>${SEG_NAMES[i]}</text>`;
        });
        inner += caption(c.label || '7-SEG', g.w / 2, g.h + 14);
      } else if (c.type === 'TUN') {
        const lit = c._ins?.[0] ?? 0;
        inner = `<path class="body tunnelbody${lit ? ' hi' : ''}" d="M2,20 L18,4 H70 A8,8 0 0 1 78,12 V28 A8,8 0 0 1 70,36 H18 Z"/>
          <text class="tunnelname${c.label?.trim() ? '' : ' unset'}" x="46" y="24"${ctr(46, 20)}>${esc(c.label?.trim() || 'name?')}</text>` +
          caption('TUNNEL', 40, 52);
      } else if (isBusToolType(c.type)) {
        const isComb = c.type === 'COMB';
        const n = clampBits(c.nIns ?? 4);
        const v = maskVal(isComb ? sim.vals[c.id + ':0'] : (c._ins?.[0] ?? 0), n);
        inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
          <text class="combval" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${formatBusValue(v, n)}</text>`;
        // edge-aware pin labels (pins may sit on any edge with a custom layout)
        const pinLabel = (p: Vec & { name?: string }, i: number, side: 'in' | 'out') => {
          if (!p.name) return '';
          const s = c.layout?.[side === 'in' ? 'ins' : 'outs']?.[i];
          const lx = s?.lx ?? 0, ly = s?.ly ?? 0;
          if (p.y < 0 || p.y > g.h) {
            const by = p.y < 0 ? 13 : g.h - 7;
            return `<text class="pinname" x="${p.x + lx}" y="${by + ly}" text-anchor="middle"${ctr(p.x, by)}>${esc(p.name)}</text>`;
          }
          const left = p.x < 0;
          const bx = left ? 8 : g.w - 8;
          return `<text class="pinname" x="${bx + lx}" y="${p.y + 3 + ly}" text-anchor="${left ? 'start' : 'end'}"${ctr(bx, p.y)}>${esc(p.name)}</text>`;
        };
        g.ins.forEach((p, i) => { inner += pinLabel(p, i, 'in'); });
        g.outs.forEach((p, i) => { inner += pinLabel(p, i, 'out'); });
        inner += caption(c.label || (isComb ? 'COMBINE' : 'SPLIT'), g.w / 2, g.h + 14);
      } else if (isMemoryType(c.type)) {
        const edge = defaultEdgeForComp(c);
        const q = sim.vals[c.id + ':0'] ? 1 : 0;
        const edgeLabel = edge ? `${edge} edge` : '';
        inner = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
          <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(c.label || g.name)}</text>
          <text class="combval ${q ? 'hi' : ''}" x="${g.w / 2}" y="${g.h / 2 + 24}"${ctr(g.w / 2, g.h / 2 + 24)}>Q=${q}</text>`;
        g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start"${ctr(8, p.y)}>${esc(p.name || '')}</text>`; });
        g.outs.forEach(p => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end"${ctr(g.w - 8, p.y)}>${esc(p.name || '')}</text>`; });
        if (edgeLabel) inner += caption(edgeLabel, g.w / 2, g.h + 14);
      } else if (c.type === 'CHIP') {
        const chipDef = c.chipId ? lib()[c.chipId] : undefined;
        // edge-aware label placement so layout pins on any edge read right
        const pinLabel = (p: Vec & { name?: string }, i: number, side: 'in' | 'out') => {
          const off = chipDef ? chipLabelOffset(chipDef, side, i) : { lx: 0, ly: 0 };
          if (p.y < 0 || p.y > g.h) {
            const by = p.y < 0 ? 13 : g.h - 7;
            return `<text class="pinname" x="${p.x + off.lx}" y="${by + off.ly}" text-anchor="middle"${ctr(p.x, by)}>${esc(p.name || '')}</text>`;
          }
          const left = p.x < 0;
          const bx = left ? 8 : g.w - 8;
          const lx = bx + off.lx, ly = p.y + 3 + off.ly;
          return `<text class="pinname" x="${lx}" y="${ly}" text-anchor="${left ? 'start' : 'end'}"${ctr(bx, p.y)}>${esc(p.name || '')}</text>`;
        };
        const bodyD = chipBodyPath(chipDef?.shape, g.w, g.h, chipDef?.shapePts);
        inner = (bodyD
          ? `<path class="body chipbody" d="${bodyD}"/>`
          : `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
          <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>`)
          + `<text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(g.name)}</text>`;
        g.ins.forEach((p, i) => { inner += pinLabel(p, i, 'in'); });
        g.outs.forEach((p, i) => { inner += pinLabel(p, i, 'out'); });
        if (c.label && c.label !== g.name) inner += caption(`${c.label}${edgeText(c)}`, g.w / 2, g.h + 14);
        else if (c.edge) inner += caption(`${c.edge} edge`, g.w / 2, g.h + 14);
      }

      const core = stubs + inner + pins;
      const rotated = rot ? `<g transform="${rotTransform(rot, g.w, g.h)}">${core}</g>` : core;
      let extra = '';
      if ((c.type === 'CHIP' || isBusToolType(c.type)) && selected) {
        // corner grip lives in footprint space so it's always bottom-right
        const f = footprint(rot, g.w, g.h);
        extra = `<path class="resizegrip" d="M${f.w - 13},${f.h - 2} L${f.w - 2},${f.h - 13} M${f.w - 8},${f.h - 2} L${f.w - 2},${f.h - 8}"/>
          <rect class="resizehit" data-resize="${c.id}" x="${f.w - 16}" y="${f.h - 16}" width="22" height="22"/>`;
      }

      return `<g class="comp${selCls}${ghost ? ' ghost' : ''}" data-comp="${c.id}"
                transform="translate(${c.x},${c.y})">${rotated}${extra}</g>`;
    }

    function render() {
      let out = `<rect x="-20000" y="-20000" width="40000" height="40000" fill="url(#dots)"/>`;

      const nets = analyzeNets(wires, tunnelPinGroups(comps));
      const netVal = (keys?: string[]) => {
        let v = 0n;
        if (keys) for (const k of keys) v |= sim.vals[k] ?? 0n;
        return v;
      };

      for (const w of wires) {
        if ([w.a, w.b].some(e => isPinEnd(e) && !find(e.comp))) continue;
        const a = endPos(w.a), b = endPos(w.b);
        const hi = netVal(nets.wireOuts.get(w.id));
        const selCls = selWire === w.id ? ' selected' : '';
        const d = wirePathFor(w);
        const bits = clampBits(w.bits);
        out += `<g><path class="wirehit" data-wire="${w.id}" d="${d}"/><path class="wire${bits > 1 ? ' bus' : ''}${hi ? ' hi' : ''}${selCls}" d="${d}"/></g>`;
        if (bits > 1) {
          // live bus readout: binary up to the engine threshold, hex beyond
          out += `<text class="buslabel${hi ? ' hi' : ''}" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 9}"
            text-anchor="middle">${formatBusValue(hi, bits)}</text>`;
        }
      }
      if (wiring) {
        const p = endPos(wiring.start);
        const end = { x: snap(wiring.mx), y: snap(wiring.my) };
        let d: string;
        if (wiring.via.length) {
          d = `M${p.x},${p.y} ` + wiring.via.map(v => `L${v.x},${v.y}`).join(' ') + ` L${end.x},${end.y}`;
        } else {
          d = wireCornerPath(wireRouteCorners(p, end, wireEndFacing(wiring.start), 'free'));
        }
        out += `<path class="wirepreview" d="${d}"/>`;
        for (const v of wiring.via) out += `<circle class="wirestop" cx="${v.x}" cy="${v.y}" r="3"/>`;
      }
      for (const c of comps) out += compSVG(c, false);

      // solder-dot notation: pins with several wires, and mid-wire splits
      for (const [key, count] of nets.pinWireCounts) {
        if (count < 2) continue;
        const [compId, side, pin] = key.split(':');
        const c = find(compId);
        if (!c) continue;
        const p = pinPos(c, side as 'in' | 'out', +pin);
        const hi = side === 'out'
          ? (sim.vals[compId + ':' + pin] ?? 0n)
          : netVal(nets.inputDrivers.get(compId + ':' + pin));
        out += `<circle class="junction${hi ? ' hi' : ''}" cx="${p.x}" cy="${p.y}" r="5"/>`;
      }
      for (const w of wires) {
        for (const e of [w.a, w.b]) {
          if (!isAttachEnd(e)) continue;
          const hi = netVal(nets.wireOuts.get(w.id));
          out += `<circle class="junction${hi ? ' hi' : ''}" cx="${e.x}" cy="${e.y}" r="5"/>`;
        }
      }

      if (marquee) {
        const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
        out += `<rect class="marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
      }

      // wire-placement cursor: a glowing, enlarged grid dot showing exactly
      // where the next click lands — snapped onto a hovered wire when splitting
      if ((wireTool || wiring) && lastPt.over && !drag && !pan && !marquee) {
        const base = wiring ? { x: wiring.mx, y: wiring.my } : { x: lastPt.x, y: lastPt.y };
        const hw = hoverWire ? wires.find(w => w.id === hoverWire) : null;
        const c = hw ? attachPointOnWire(hw, base) : { x: snap(base.x), y: snap(base.y) };
        out += `<circle class="wirecursor-halo" cx="${c.x}" cy="${c.y}" r="10"/>
                <circle class="wirecursor" cx="${c.x}" cy="${c.y}" r="4.5"/>`;
      }

      if (placing && placing.over) {
        const g = getGeom(placing as any, lib());
        const f = footprint(placing.rot, g.w, g.h);
        const ghost: Comp = {
          id: '_ghost', type: placing.type, chipId: placing.chipId, rot: placing.rot,
          x: snap(placing.mx - f.w / 2), y: snap(placing.my - f.h / 2),
        };
        out += compSVG(ghost, true);
      }

      world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
      world.innerHTML = out;

      cb.onCounts({ parts: comps.length, wires: wires.length });
      cb.onZoom(Math.round(view.k * 100));
      svg.classList.toggle('wiring', !!wiring || wireTool);
      svg.classList.toggle('placing', !!placing);
      svg.classList.toggle('panready', spaceDown);
    }

    function refresh(changed = true) {
      recompute();
      render();
      if (changed) cb.onBoardChange();
    }

    /* ── wiring ── */
    type PinHit = { comp: string; side: 'in' | 'out'; pin: number };
    function parsePin(el: Element): PinHit {
      const [comp, side, pin] = (el as SVGElement).dataset.pin!.split('|');
      return { comp, side: side as 'in' | 'out', pin: +pin };
    }
    /* Bus pins (e.g. the combiner's 4-bit output) seed the wire's width. */
    function pinBits(e: WireEnd): number {
      if (!isPinEnd(e)) return 1;
      const c = find(e.comp);
      if (!c) return 1;
      const g = getGeom(c, lib());
      return g[e.side === 'out' ? 'outs' : 'ins'][e.pin]?.bits ?? 1;
    }
    function buildWire(a: WireEnd, b: WireEnd, via: Vec[]): boolean {
      if (isPinEnd(a) && isPinEnd(b)) {
        if (a.comp === b.comp) return false;
        // tunnels are junctions, not consumers — their pin may join
        // either side of a net (e.g. tunnel → LED input is fine)
        const isTun = (e: PinEnd) => find(e.comp)?.type === 'TUN';
        if (a.side === b.side && !isTun(a) && !isTun(b)) return false;
      }
      if (!isPinEnd(a) && !isPinEnd(b) && !isAttachEnd(a) && !isAttachEnd(b)) {
        const av = a as Vec, bv = b as Vec;
        if (av.x === bv.x && av.y === bv.y && !via.length) return false;
      }
      const bits = Math.max(pinBits(a), pinBits(b));
      wires.push({ id: uid(), a, b, ...(via.length ? { via } : {}), ...(bits > 1 ? { bits } : {}) });
      return true;
    }
    function finishWire(end: WireEnd) {
      if (!wiring) return;
      if (buildWire(wiring.start, end, wiring.via)) wiring = null;
      refresh();
    }
    function pushVia(p: Vec) {
      if (!wiring) return;
      const last = wiring.via[wiring.via.length - 1]
        ?? (isPinEnd(wiring.start) ? null : { x: (wiring.start as Vec).x, y: (wiring.start as Vec).y });
      if (last && last.x === p.x && last.y === p.y) return;
      wiring.via.push(p);
      wiring.fresh = true;
    }

    /* ── placement ── */
    function placeAt(wx: number, wy: number) {
      if (!placing) return;
      const g = getGeom(placing as any, lib());
      const f = footprint(placing.rot, g.w, g.h);
      const c: Comp = {
        id: uid(), type: placing.type, chipId: placing.chipId,
        x: snap(wx - f.w / 2), y: snap(wy - f.h / 2),
        ...(placing.rot ? { rot: placing.rot } : {}),
      };
      if (placing.type === 'IN' || placing.type === 'IPIN') c.on = false;
      if (placing.type === 'VAL') { c.bits = 4; c.val = 0; }
      if (placing.type === 'CLK') c.freq = 1;
      if (isBusToolType(placing.type)) c.nIns = 4;
      const edge = defaultEdgeForComp(c);
      if (edge) c.edge = edge;
      comps.push(c);
      setSelection([c.id]);
      refresh();
    }

    /* ── selection helpers ── */
    function marqueeSelect() {
      if (!marquee) return;
      const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
      selIds = new Set(comps.filter(c => {
        const g = getGeom(c, lib());
        const f = footprint(c.rot ?? 0, g.w, g.h);
        return c.x < x1 && c.x + f.w > x0 && c.y < y1 && c.y + f.h > y0;
      }).map(c => c.id));
      selWire = null;
    }

    /* wires carried along with a comp selection: every pin end inside the
       selection, attach ends hosted by wires already carried, free ends
       anywhere — and anchored to the selection somewhere */
    function wiresInSelection(): Set<string> {
      const included = new Set<string>();
      for (;;) {
        let grew = false;
        for (const w of wires) {
          if (included.has(w.id)) continue;
          const ok = [w.a, w.b].every(e =>
            isPinEnd(e) ? selIds.has(e.comp) : isAttachEnd(e) ? included.has(e.wire) : true);
          const anchored = [w.a, w.b].some(e =>
            isPinEnd(e) ? selIds.has(e.comp) : isAttachEnd(e) ? included.has(e.wire) : false);
          if (ok && anchored) { included.add(w.id); grew = true; }
        }
        if (!grew) return included;
      }
    }

    function copySelection() {
      if (!selIds.size) return;
      const included = wiresInSelection();
      clipboard = cloneBoard({
        comps: comps.filter(c => selIds.has(c.id)),
        wires: wires.filter(w => included.has(w.id)),
      });
    }

    function paste() {
      if (!clipboard?.comps.length) return;
      const xs = clipboard.comps.map(c => c.x), ys = clipboard.comps.map(c => c.y);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      // paste centered on the cursor when it's over the canvas, else nudge
      const dx = lastPt.over ? snap(lastPt.x - cx) : GRID * 2;
      const dy = lastPt.over ? snap(lastPt.y - cy) : GRID * 2;
      const idMap = new Map<string, string>();
      const newComps: Comp[] = clipboard.comps.map(c => {
        const id = uid();
        idMap.set(c.id, id);
        return { ...c, id, x: c.x + dx, y: c.y + dy };
      });
      const wireIdMap = new Map<string, string>(clipboard.wires.map(w => [w.id, uid()]));
      const shiftEnd = (e: WireEnd): WireEnd => {
        if (isPinEnd(e)) return { comp: idMap.get(e.comp)!, side: e.side, pin: e.pin };
        if (isAttachEnd(e)) return { wire: wireIdMap.get(e.wire)!, x: e.x + dx, y: e.y + dy };
        return { x: (e as Vec).x + dx, y: (e as Vec).y + dy };
      };
      const newWires: Wire[] = clipboard.wires.map(w => ({
        id: wireIdMap.get(w.id)!,
        a: shiftEnd(w.a),
        b: shiftEnd(w.b),
        ...(w.via ? { via: w.via.map(v => ({ x: v.x + dx, y: v.y + dy })) } : {}),
        ...(w.bits ? { bits: w.bits } : {}),
      }));
      comps.push(...newComps);
      wires.push(...newWires);
      setSelection(newComps.map(c => c.id));
      refresh();
    }

    function rotateSelection() {
      if (placing) { placing.rot = (placing.rot + 1) & 3; render(); return; }
      if (!selIds.size) return;
      for (const id of selIds) {
        const c = find(id);
        if (c) c.rot = ((c.rot ?? 0) + 1) & 3;
      }
      refresh();
    }

    /* ── pointer handlers ── */
    function startPan(e: PointerEvent) {
      pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      svg.classList.add('panning');
    }

    function onDown(e: PointerEvent) {
      if (e.button === 2) return;
      const pt = toWorld(e.clientX, e.clientY);
      if (e.button === 1) { e.preventDefault(); startPan(e); return; }

      if (placing) { placeAt(pt.x, pt.y); return; }   // stamp mode: every click places one

      const target = e.target as Element;
      const resizeEl = target.closest('[data-resize]');
      const pinEl = target.closest('[data-pin]');
      const compEl = target.closest('[data-comp]');
      const wireEl = target.closest('[data-wire]');
      const dot: Vec = { x: snap(pt.x), y: snap(pt.y) };

      if (resizeEl) {
        const c = find((resizeEl as SVGElement).dataset.resize!);
        if (c) { resize = { id: c.id }; if (wiring) wiring = null; render(); }
        return;
      }
      if (pinEl) {
        const p = parsePin(pinEl);
        if (wiring) { finishWire(p); return; }
        wiring = { start: p, via: [], mx: pt.x, my: pt.y, downX: e.clientX, downY: e.clientY, fresh: true };
        render();
        return;
      }
      if (wireEl && wireTool) {
        // split: attach to the clicked wire at the nearest grid dot that
        // actually lies on the host wire, so the junction sits on the wire
        const host = (wireEl as SVGElement).dataset.wire!;
        const hw = wires.find(w => w.id === host);
        const at = hw ? attachPointOnWire(hw, pt) : dot;
        if (wiring) { finishWire({ wire: host, x: at.x, y: at.y }); return; }
        wiring = { start: { wire: host, x: at.x, y: at.y }, via: [], mx: pt.x, my: pt.y, downX: e.clientX, downY: e.clientY, fresh: false };
        render();
        return;
      }
      if (compEl) {
        const c = find((compEl as SVGElement).dataset.comp!);
        if (!c) return;
        if (wiring) wiring = null;   // clicking a component ends wire routing
        if (e.shiftKey) {
          // shift-click: add to / remove from the group
          if (selIds.has(c.id)) selIds.delete(c.id); else selIds.add(c.id);
          selWire = null;
          emitSel();
          render();
          return;
        }
        if (!selIds.has(c.id) || selWire) setSelection([c.id]);
        if (c.type === 'BTN') c.pressed = true;
        const offs: Record<string, { ox: number; oy: number }> = {};
        const orig: Record<string, Vec> = {};
        for (const id of selIds) {
          const s = find(id);
          if (s) { offs[id] = { ox: pt.x - s.x, oy: pt.y - s.y }; orig[id] = { x: s.x, y: s.y }; }
        }
        const carried = wiresInSelection();
        const dragWires = wires.filter(w => carried.has(w.id)).map(w => ({
          w, via: (w.via ?? []).map(v => ({ ...v })),
          a: cloneWireEnd(w.a),
          b: cloneWireEnd(w.b),
        }));
        drag = { ids: [...selIds], primary: c.id, offs, orig, dragWires, moved: false, sx: e.clientX, sy: e.clientY };
        refresh(false);
        return;
      }
      if (wireEl && !wiring) {
        setSelection([], (wireEl as SVGElement).dataset.wire!);
        render();
        return;
      }
      if (wiring) {
        // click on empty grid: drop a routing stop at the nearest dot;
        // clicking the same dot again ends the wire in the air there
        const last = wiring.via[wiring.via.length - 1];
        if (last && last.x === dot.x && last.y === dot.y) {
          wiring.via.pop();
          finishWire(dot);
          return;
        }
        pushVia(dot);
        render();
        return;
      }
      if (wireTool) {
        // wire tool: any grid dot starts a wire
        wiring = { start: dot, via: [], mx: pt.x, my: pt.y, downX: e.clientX, downY: e.clientY, fresh: false };
        render();
        return;
      }
      if (spaceDown) { startPan(e); return; }
      // empty space: rubber-band select
      setSelection([]);
      marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      render();
    }

    function onDblClick(e: MouseEvent) {
      if (!wiring) {
        const compEl = (e.target as Element).closest?.('[data-comp]');
        if (compEl) {
          const c = find((compEl as SVGElement).dataset.comp!);
          if (c && c.type === 'CHIP' && c.chipId) cb.onChipDblClick?.(c.id, c.chipId);
          else if (c && isBusToolType(c.type)) cb.onBusToolDblClick?.(c.id);
        }
        return;
      }
      const pt = toWorld(e.clientX, e.clientY);
      const dot: Vec = { x: snap(pt.x), y: snap(pt.y) };
      // the double-click's first press already dropped a via here — undo it
      const last = wiring.via[wiring.via.length - 1];
      if (last && last.x === dot.x && last.y === dot.y) wiring.via.pop();
      finishWire(dot);   // end in the air at this dot
      if (wiring) { wiring = null; render(); }
    }

    function onMove(e: PointerEvent) {
      const pt = toWorld(e.clientX, e.clientY);
      {
        const r = svg.getBoundingClientRect();
        lastPt = { x: pt.x, y: pt.y, over: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
      }
      if (wireTool) {
        const we = (e.target as Element)?.closest?.('[data-wire]');
        hoverWire = we ? (we as SVGElement).dataset.wire! : null;
      }
      if (resize) {
        const c = find(resize.id);
        if (!c) { resize = null; return; }
        let minW = CHIP_MIN_W, minH = GRID * 2;
        if (c.type === 'CHIP') {
          const def = c.chipId ? lib()[c.chipId] : undefined;
          if (def) minH = chipMinH(def);
        } else if (isBusToolType(c.type)) {
          minW = busToolMinW(c.type);
          minH = busToolMinH(c);
        }
        const fw = snap(pt.x - c.x), fh = snap(pt.y - c.y);
        if ((c.rot ?? 0) & 1) {
          c.h = Math.max(minH, fw);
          c.w = Math.max(minW, fh);
        } else {
          c.w = Math.max(minW, fw);
          c.h = Math.max(minH, fh);
        }
        refresh(false);
        return;
      }
      if (drag) {
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
        if (drag.moved) {
          for (const id of drag.ids) {
            const c = find(id);
            const o = drag.offs[id];
            if (!c || !o) continue;
            if (c.type === 'BTN' && c.pressed) c.pressed = false;
            c.x = snap(pt.x - o.ox);
            c.y = snap(pt.y - o.oy);
          }
          const p = find(drag.primary);
          if (p && drag.orig[drag.primary]) {
            const dx = p.x - drag.orig[drag.primary].x, dy = p.y - drag.orig[drag.primary].y;
            const shiftEnd = (base: WireEnd): WireEnd =>
              isPinEnd(base) ? base
                : isAttachEnd(base) ? { wire: base.wire, x: base.x + dx, y: base.y + dy }
                : { x: (base as Vec).x + dx, y: (base as Vec).y + dy };
            for (const dw of drag.dragWires) {
              dw.w.via = dw.via.length ? dw.via.map(v => ({ x: v.x + dx, y: v.y + dy })) : undefined;
              if (!dw.w.via) delete dw.w.via;
              dw.w.a = shiftEnd(dw.a);
              dw.w.b = shiftEnd(dw.b);
            }
          }
          refresh(false);
        }
        return;
      }
      if (pan) {
        view.x = pan.vx + (e.clientX - pan.sx);
        view.y = pan.vy + (e.clientY - pan.sy);
        render();
        return;
      }
      if (marquee) {
        marquee.x1 = pt.x; marquee.y1 = pt.y;
        marqueeSelect();
        render();
        return;
      }
      if (wiring) {
        wiring.mx = pt.x; wiring.my = pt.y;
        if (Math.abs(e.clientX - wiring.downX) + Math.abs(e.clientY - wiring.downY) > 6) wiring.fresh = false;
        render();
        return;
      }
      if (placing) {
        placing.over = lastPt.over;
        placing.mx = pt.x; placing.my = pt.y;
        render();
        return;
      }
      // keep the wire-placement cursor tracking the pointer on plain hover
      if (wireTool) render();
    }

    function onUp(e: PointerEvent) {
      if (resize) {
        resize = null;
        refresh();
        return;
      }
      if (drag) {
        const c = find(drag.primary);
        // click toggles a switch or a 1-bit input pin (bus pins take a typed value)
        if (c && !drag.moved && (c.type === 'IN' || (c.type === 'IPIN' && clampBits(c.bits ?? 1) === 1))) c.on = !c.on;
        if (c && c.type === 'BTN') c.pressed = false;
        // a plain click inside a group collapses the selection to that part
        if (!drag.moved && !e.shiftKey && selIds.size > 1) setSelection([drag.primary]);
        drag = null;
        refresh();
        return;
      }
      if (pan) { pan = null; svg.classList.remove('panning'); return; }
      if (marquee) {
        marquee = null;
        emitSel();
        render();
        return;
      }
      if (wiring && !wiring.fresh && isPinEnd(wiring.start)) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const pinEl = el?.closest?.('[data-pin]');
        if (pinEl) { finishWire(parsePin(pinEl)); return; }
        wiring.fresh = true;   // stay in click-click mode
        return;
      }
      if (wiring && wiring.fresh && isPinEnd(wiring.start)) { wiring.fresh = false; return; }
      if (placing && placing.held) {
        // finish of the arming gesture: a drag out of the palette places here
        if (placing.over) placeAt(placing.mx, placing.my);
        placing.held = false;
      }
    }

    function onContext(e: MouseEvent) {
      e.preventDefault();
      if (wiring) { wiring = null; render(); return; }
      if (placing) { setPlacing(null); render(); return; }
      const target = e.target as Element;
      const compEl = target.closest('[data-comp]');
      const wireEl = target.closest('[data-wire]');
      if (compEl) deleteComp((compEl as SVGElement).dataset.comp!);
      else if (wireEl) {
        wires = wires.filter(w => w.id !== (wireEl as SVGElement).dataset.wire);
        pruneAttached();
        refresh();
      }
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // pinch / ctrl+scroll zooms about the cursor
        const r = svg.getBoundingClientRect();
        const cx = e.clientX - r.left, cy = e.clientY - r.top;
        const factor = Math.exp(-e.deltaY * 0.0025);
        const k = Math.min(2.5, Math.max(0.35, view.k * factor));
        view.x = cx - (cx - view.x) * (k / view.k);
        view.y = cy - (cy - view.y) * (k / view.k);
        view.k = k;
      } else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
      }
      render();
    }

    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (t && t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return; // space/enter press the button
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'c') { copySelection(); e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'v') { paste(); e.preventDefault(); return; }
      if (!mod && e.key.toLowerCase() === 'r') { rotateSelection(); return; }
      if (!mod && e.key.toLowerCase() === 'w') { setWireTool(!wireTool); return; }
      if (e.key === ' ') { spaceDown = true; svg.classList.add('panready'); e.preventDefault(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
      if (e.key === 'Escape') {
        if (wiring) { wiring = null; render(); return; }
        if (placing) { setPlacing(null); render(); return; }
        if (marquee) { marquee = null; render(); return; }
        if (wireTool) { setWireTool(false); return; }
        setSelection([]);
        render();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === ' ') { spaceDown = false; svg.classList.remove('panready'); }
    }

    /* ── mutations ── */
    function deleteComp(id: string) {
      comps = comps.filter(c => c.id !== id);
      wires = wires.filter(w => ![w.a, w.b].some(e => isPinEnd(e) && e.comp === id));
      pruneAttached();
      delete sim.sub[id];
      if (selIds.has(id)) { selIds.delete(id); emitSel(); }
      refresh();
    }
    function deleteSelection() {
      if (selWire) {
        wires = wires.filter(w => w.id !== selWire);
        pruneAttached();
        setSelection([]);
        refresh();
        return;
      }
      if (!selIds.size) return;
      comps = comps.filter(c => !selIds.has(c.id));
      wires = wires.filter(w => ![w.a, w.b].some(e => isPinEnd(e) && selIds.has(e.comp)));
      pruneAttached();
      selIds.forEach(id => delete sim.sub[id]);
      setSelection([]);
      refresh();
    }

    /* ── wire up ── */
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('dblclick', onDblClick);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    svg.addEventListener('contextmenu', onContext);
    svg.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);

    refresh(false);

    /* ── public API ── */
    return {
      beginPlace(type, chipId) {
        if (placing && placing.type === type && placing.chipId === chipId) {
          setPlacing(null);     // clicking the armed palette item again disarms
          render();
          return;
        }
        wiring = null;
        setPlacing({ type, chipId, rot: 0, mx: 0, my: 0, over: false, held: true });
        render();
      },
      deleteSelection,
      rotateSelection,
      clearSelection() { setSelection([]); render(); },
      setWireTool,
      clear() { comps = []; wires = []; sim = newSimState(); setSelection([]); wiring = null; refresh(); },
      powerCycle() { sim = newSimState(); refresh(false); },
      zoomIn() { view.k = Math.min(2.5, view.k * 1.2); render(); },
      zoomOut() { view.k = Math.max(0.35, view.k / 1.2); render(); },
      resetView() { view = { x: 0, y: 0, k: 1 }; render(); },
      setLabel(id, label) {
        const c = find(id);
        if (c) { c.label = label.slice(0, 12); refresh(); }
      },
      setNumInputs(id, n) {
        const c = find(id);
        if (!c || !(MULTI_IN_GATES.has(c.type) || isBusToolType(c.type))) return;
        c.nIns = MULTI_IN_GATES.has(c.type) ? clampGateIns(n) : clampBits(n);
        // a custom bus-tool layout tracks the new bit count
        if (isBusToolType(c.type) && c.layout) c.layout = resizeBusLayout(c.layout, c.type, c.nIns);
        const g = getGeom(c, lib());
        wires = wires.filter(w => ![w.a, w.b].some(e =>
          isPinEnd(e) && e.comp === id && e.pin >= g[e.side === 'out' ? 'outs' : 'ins'].length));
        for (const w of wires) {
          if (![w.a, w.b].some(e => isPinEnd(e) && e.comp === id)) continue;
          const b = Math.max(pinBits(w.a), pinBits(w.b));
          if (b > 1) w.bits = b; else delete w.bits;
        }
        pruneAttached();
        if (selIds.has(id)) emitSel();
        refresh();
      },
      setPinBits(id, bits) {
        const c = find(id);
        // ports resize their bus; gates resize their bitwise operand width
        if (!c || !(c.type === 'IPIN' || c.type === 'OPIN' || c.type === 'VAL' || isGateType(c.type))) return;
        c.bits = clampBits(bits);
        if (c.bits === 1 && isGateType(c.type)) delete c.bits;
        if (c.val != null) c.val = storeVal(maskVal(c.val, c.bits ?? 1));
        // re-seed connected wires' bus width from the resized pin
        for (const w of wires) {
          if (![w.a, w.b].some(e => isPinEnd(e) && e.comp === id)) continue;
          const b = Math.max(pinBits(w.a), pinBits(w.b));
          if (b > 1) w.bits = b; else delete w.bits;
        }
        if (selIds.has(id)) emitSel();
        refresh();
      },
      setValue(id, val) {
        const c = find(id);
        if (!c || !(c.type === 'VAL' || c.type === 'IPIN')) return;
        // no emitSel: the value field is a controlled draft; re-emitting
        // would clobber the user's keystrokes with the canonical form
        c.val = storeVal(maskVal(val, clampBits(c.bits ?? 1)));
        refresh();
      },
      setFreq(id, hz) {
        const c = find(id);
        if (!c || c.type !== 'CLK') return;
        c.freq = clampFreq(hz);
        refresh();
      },
      setEdge(id, edge) {
        const c = find(id);
        if (!c || !edgeableComp(c)) return;
        if (edge) c.edge = edge; else delete c.edge;
        if (selIds.has(id)) emitSel();
        refresh();
      },
      setWireBits(id, bits) {
        const w = wires.find(w => w.id === id);
        if (!w) return;
        const b = clampBits(bits);
        if (b > 1) w.bits = b; else delete w.bits;
        if (selWire === id) emitSel();
        refresh();
      },
      setBusLayout(id, layout) {
        const c = find(id);
        if (!c || !isBusToolType(c.type)) return;
        c.layout = cloneChipLayout(layout);
        c.w = layout.w * GRID;
        c.h = layout.h * GRID;
        refresh();
      },
      refreshWireBits() {
        for (const w of wires) {
          if (![w.a, w.b].some(e => isPinEnd(e))) continue;
          const b = Math.max(pinBits(w.a), pinBits(w.b));
          if (b > 1) w.bits = b;
          else if (w.bits && [w.a, w.b].every(e => isPinEnd(e))) delete w.bits;
        }
        refresh();
      },
      getBoard(): Board {
        return cloneBoard({ comps, wires });
      },
      setBoard(b: Board) {
        const known = lib();
        const clean = cloneBoard(b);
        comps = clean.comps.filter(c => c.type !== 'CHIP' || (c.chipId && known[c.chipId]));
        wires = normalizeWires(clean.wires).filter(w =>
          [w.a, w.b].every(e => !isPinEnd(e) || comps.some(c => c.id === e.comp)));
        pruneAttached();
        sim = newSimState();
        setSelection([]);
        refresh(false);
      },
      getChipSubState(compId) {
        const c = find(compId);
        if (!c || c.type !== 'CHIP') return null;
        return sim.sub[compId] ?? null;
      },
      removeChipInstances(chipId) {
        const doomed = new Set(comps.filter(c => c.chipId === chipId).map(c => c.id));
        if (!doomed.size) { refresh(false); return; }
        comps = comps.filter(c => !doomed.has(c.id));
        wires = wires.filter(w => ![w.a, w.b].some(e => isPinEnd(e) && doomed.has(e.comp)));
        pruneAttached();
        doomed.forEach(id => delete sim.sub[id]);
        if ([...selIds].some(id => doomed.has(id))) setSelection([...selIds].filter(id => !doomed.has(id)));
        refresh();
      },
      rerender() { refresh(false); },
      destroy() {
        clearInterval(clockTimer);
        svg.removeEventListener('pointerdown', onDown);
        svg.removeEventListener('dblclick', onDblClick);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        svg.removeEventListener('contextmenu', onContext);
        svg.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
      },
    };
  }
