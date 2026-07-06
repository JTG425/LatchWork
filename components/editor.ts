/* ────────────────────────────────────────────────────────────────
   Latchwork editor — imperative SVG canvas.
   Owns pointer interaction, wiring, pan/zoom, and rendering.
   Pure logic lives in lib/engine; React (Simulator.tsx) owns the
   chrome around the canvas and talks to this through EditorApi.
   ──────────────────────────────────────────────────────────────── */

   import {
    GRID, Comp, Wire, Vec, Board, ChipLib, CompType,
    SimState, newSimState, getGeom, evaluateNet,
    MULTI_IN_GATES, clampGateIns, clampFreq, CHIP_MIN_W, chipMinH,
  } from '@/lib/engine';

  export interface SelInfo {
    kind: 'comp' | 'wire' | 'multi';
    id: string;
    count?: number;     // multi: number of selected parts
    type?: CompType;
    label?: string;
    labelable?: boolean;
    nIns?: number;      // gates with an editable input count
    freq?: number;      // clocks
  }

  export interface PlacingInfo { type: CompType; chipId?: string }

  export interface EditorCallbacks {
    getLib(): ChipLib;
    onSelect(info: SelInfo | null): void;
    onCounts(c: { parts: number; wires: number }): void;
    onZoom(pct: number): void;
    onBoardChange(): void;
    onPlacing?(p: PlacingInfo | null): void;
  }

  export interface EditorApi {
    beginPlace(type: CompType, chipId?: string): void;
    deleteSelection(): void;
    clear(): void;
    powerCycle(): void;
    zoomIn(): void;
    zoomOut(): void;
    resetView(): void;
    setLabel(id: string, label: string): void;
    setNumInputs(id: string, n: number): void;
    setFreq(id: string, hz: number): void;
    getBoard(): Board;
    setBoard(b: Board): void;
    removeChipInstances(chipId: string): void;
    rerender(): void;
    destroy(): void;
  }

  const uid = () =>
    'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const snap = (v: number) => Math.round(v / GRID) * GRID;

  /* Gate bodies are generated for the gate's pin span h (default 40,
     taller for 3–4 inputs) and overshoot to −8…h+8 so the input pins
     enter the flat or curved back edge at the classic positions. */
  function gateBody(type: CompType, h: number): string {
    const t = -8, b = h + 8, m = h / 2;
    switch (type) {
      case 'AND': return `M4,${t} H30 C52,${t} 60,${m - 16} 60,${m} C60,${m + 16} 52,${b} 30,${b} H4 Z`;
      case 'NAND': return `M4,${t} H28 C48,${t} 56,${m - 16} 56,${m} C56,${m + 16} 48,${b} 28,${b} H4 Z`;
      case 'OR': return `M3,${t} H22 C42,${t} 55,${m - 16} 60,${m} C55,${m + 16} 42,${b} 22,${b} H3 C13,${m + 12} 13,${m - 12} 3,${t} Z`;
      case 'NOR': return `M3,${t} H20 C38,${t} 50,${m - 16} 55,${m} C50,${m + 16} 38,${b} 20,${b} H3 C13,${m + 12} 13,${m - 12} 3,${t} Z`;
      case 'XOR': return `M9,${t} H26 C45,${t} 55,${m - 16} 60,${m} C55,${m + 16} 45,${b} 26,${b} H9 C19,${m + 12} 19,${m - 12} 9,${t} Z`;
      case 'NOT': return `M6,4 L6,36 L52,20 Z`;
      default: return '';
    }
  }
  const GATES: ReadonlySet<CompType> = new Set(['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR']);

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  export function createEditor(svg: SVGSVGElement, cb: EditorCallbacks): EditorApi {
    const world = svg.querySelector('#world') as SVGGElement;

    /* ── state ── */
    let comps: Comp[] = [];
    let wires: Wire[] = [];
    let sim: SimState = newSimState();
    let view = { x: 0, y: 0, k: 1 };

    let selIds = new Set<string>();      // selected comps (1..n)
    let selWire: string | null = null;   // or a single selected wire
    let wiring: { comp: string; side: 'in' | 'out'; pin: number; via: Vec[]; mx: number; my: number; downX: number; downY: number; fresh: boolean } | null = null;
    let drag: { ids: string[]; primary: string; offs: Record<string, { ox: number; oy: number }>; viaWires: { w: Wire; base: Vec[] }[]; orig: Record<string, Vec>; moved: boolean; sx: number; sy: number } | null = null;
    let resize: { id: string } | null = null;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
    let placing: { type: CompType; chipId?: string; mx: number; my: number; over: boolean; held: boolean } | null = null;
    let clipboard: { comps: Comp[]; wires: Wire[] } | null = null;
    let spaceDown = false;
    let lastPt = { x: 0, y: 0, over: false };

    const lib = () => cb.getLib();

    /* ── helpers ── */
    function toWorld(clientX: number, clientY: number) {
      const r = svg.getBoundingClientRect();
      return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
    }
    function pinPos(c: Comp, side: 'in' | 'out', idx: number) {
      const p = getGeom(c, lib())[side === 'out' ? 'outs' : 'ins'][idx];
      return { x: c.x + p.x, y: c.y + p.y };
    }
    /* auto-route: orthogonal dogleg for wires without user waypoints */
    function wirePath(x1: number, y1: number, x2: number, y2: number) {
      if (x2 >= x1 + 20) {
        const mx = snap((x1 + x2) / 2);
        return `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
      }
      const my = snap((y1 + y2) / 2);
      return `M${x1},${y1} L${x1 + 20},${y1} L${x1 + 20},${my} L${x2 - 20},${my} L${x2 - 20},${y2} L${x2},${y2}`;
    }
    function wirePathFor(w: Wire, a: Vec, b: Vec) {
      if (w.via?.length) return `M${a.x},${a.y} ` + w.via.map(v => `L${v.x},${v.y}`).join(' ') + ` L${b.x},${b.y}`;
      return wirePath(a.x, a.y, b.x, b.y);
    }
    const find = (id: string) => comps.find(c => c.id === id);

    function selInfoFor(c: Comp): SelInfo {
      return {
        kind: 'comp', id: c.id, type: c.type, label: c.label || '',
        labelable: c.type === 'IN' || c.type === 'BTN' || c.type === 'OUT' || c.type === 'CHIP'
          || c.type === 'IPIN' || c.type === 'OPIN' || c.type === 'CLK',
        nIns: MULTI_IN_GATES.has(c.type) ? clampGateIns(c.nIns) : undefined,
        freq: c.type === 'CLK' ? clampFreq(c.freq) : undefined,
      };
    }
    function emitSel() {
      if (selWire) { cb.onSelect({ kind: 'wire', id: selWire }); return; }
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
    function pinSVG(c: Comp, side: 'in' | 'out', idx: number, hi: number) {
      const p = getGeom(c, lib())[side === 'out' ? 'outs' : 'ins'][idx];
      return `<circle class="pinhit" data-pin="${c.id}|${side}|${idx}" cx="${p.x}" cy="${p.y}" r="10"/>
              <circle class="pin ${hi ? 'hi' : ''}" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
    }

    function compSVG(c: Comp, ghost: boolean): string {
      const g = getGeom(c, lib());
      const selected = !ghost && selIds.has(c.id);
      const selCls = selected ? ' selected' : '';
      let inner = '', stubs = '', pins = '';
      const caption = (text: string, x: number, y: number) =>
        `<text class="lbl" x="${x}" y="${y}">${esc(text)}</text>`;

      g.ins.forEach((p, i) => {
        const hi = c._ins?.[i] ?? 0;
        // stub ends slightly inside the body; overshoot hides under the fill
        const bx = c.type === 'OR' || c.type === 'NOR' || c.type === 'XOR' ? 12 : c.type === 'CHIP' ? 0 : 8;
        stubs += `<path class="stub ${hi ? 'hi' : ''}" d="M${p.x},${p.y} L${bx},${p.y}"/>`;
        pins += pinSVG(c, 'in', i, hi);
      });
      g.outs.forEach((p, i) => {
        const hi = sim.vals[c.id + ':' + i] | 0;
        stubs += `<path class="stub ${hi ? 'hi' : ''}" d="M${g.w},${p.y} L${p.x},${p.y}"/>`;
        pins += pinSVG(c, 'out', i, hi);
      });

      if (GATES.has(c.type)) {
        const m = g.h / 2;
        inner = `<path class="body" d="${gateBody(c.type, g.h)}"/>`;
        if (c.type === 'XOR')
          inner += `<path d="M2,-8 C12,${m - 12} 12,${m + 12} 2,${g.h + 8}" fill="none" stroke="var(--body-stroke)" stroke-width="1.5"/>`;
        if (c.type === 'NAND' || c.type === 'NOR')
          inner += `<circle cx="${c.type === 'NAND' ? 60 : 59}" cy="${m}" r="4" class="body"/>`;
        if (c.type === 'NOT')
          inner += `<circle cx="56" cy="20" r="4" class="body"/>`;
        inner += caption(g.name, 30, c.type === 'NOT' ? 50 : g.h + 21);
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
          <text class="pindigit hi" x="20" y="26">1</text>` +
          caption('HIGH', 20, 52);
      } else if (c.type === 'CLK') {
        const on = sim.vals[c.id + ':0'] | 0;
        inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
          <path d="M10,${on ? 13 : 27} H19 V${on ? 27 : 13} H29 V${on ? 13 : 27} H39 V${on ? 27 : 13} H49"
            fill="none" stroke="${on ? 'var(--hi)' : 'var(--muted)'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
          caption(`${c.label || 'CLK'} · ${clampFreq(c.freq)}Hz`, 30, 52);
      } else if (c.type === 'IPIN') {
        const on = !!c.on;
        inner = `<rect class="body pinport ${on ? 'hi' : ''}" x="0" y="0" width="40" height="40" rx="7"/>
          <text class="pindigit ${on ? 'hi' : ''}" x="20" y="26">${on ? 1 : 0}</text>` +
          caption(`▸ ${c.label || 'IN?'}`, 20, 52);
      } else if (c.type === 'OPIN') {
        const lit = c._ins?.[0] ?? 0;
        inner = `<circle class="body pinport ${lit ? 'hi' : ''}" cx="20" cy="20" r="19"/>
          <text class="pindigit ${lit ? 'hi' : ''}" x="20" y="26">${lit ? 1 : 0}</text>` +
          caption(`${c.label || 'OUT?'} ▸`, 20, 52);
      } else if (c.type === 'OUT') {
        const lit = c._ins?.[0] ?? 0;
        inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="10"/>
          <circle cx="20" cy="20" r="11" fill="${lit ? 'var(--led-on)' : '#33333b'}"
            stroke="${lit ? '#ff6b61' : '#4a4a54'}" stroke-width="1.5" ${lit ? 'filter="url(#ledglow)"' : ''}/>
          ${lit ? '<circle cx="16.5" cy="16.5" r="3" fill="#ffd7d4" opacity=".85"/>' : ''}` +
          caption(c.label || 'LED', 20, 52);
      } else if (c.type === 'CHIP') {
        inner = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
          <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>
          <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}">${esc(g.name)}</text>`;
        g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start">${esc(p.name || '')}</text>`; });
        g.outs.forEach(p => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end">${esc(p.name || '')}</text>`; });
        if (c.label && c.label !== g.name) inner += caption(c.label, g.w / 2, g.h + 14);
        if (selected) {
          // corner grip: drag to resize the chip body in grid steps
          inner += `<path class="resizegrip" d="M${g.w - 13},${g.h - 2} L${g.w - 2},${g.h - 13} M${g.w - 8},${g.h - 2} L${g.w - 2},${g.h - 8}"/>
            <rect class="resizehit" data-resize="${c.id}" x="${g.w - 16}" y="${g.h - 16}" width="22" height="22"/>`;
        }
      }

      return `<g class="comp${selCls}${ghost ? ' ghost' : ''}" data-comp="${c.id}"
                transform="translate(${c.x},${c.y})">${stubs}${inner}${pins}</g>`;
    }

    function render() {
      let out = `<rect x="-20000" y="-20000" width="40000" height="40000" fill="url(#dots)"/>`;

      const fanout = new Map<string, number>();
      for (const w of wires) {
        const k = w.from.comp + ':' + w.from.pin;
        fanout.set(k, (fanout.get(k) || 0) + 1);
      }

      for (const w of wires) {
        const fc = find(w.from.comp), tc = find(w.to.comp);
        if (!fc || !tc) continue;
        const a = pinPos(fc, 'out', w.from.pin);
        const b = pinPos(tc, 'in', w.to.pin);
        const hi = sim.vals[w.from.comp + ':' + w.from.pin] | 0;
        const selCls = selWire === w.id ? ' selected' : '';
        const d = wirePathFor(w, a, b);
        out += `<g><path class="wirehit" data-wire="${w.id}" d="${d}"/><path class="wire${hi ? ' hi' : ''}${selCls}" d="${d}"/></g>`;
      }
      if (wiring) {
        const c = find(wiring.comp);
        if (c) {
          const p = pinPos(c, wiring.side, wiring.pin);
          const end = { x: snap(wiring.mx), y: snap(wiring.my) };
          let d: string;
          if (wiring.via.length) {
            d = `M${p.x},${p.y} ` + wiring.via.map(v => `L${v.x},${v.y}`).join(' ') + ` L${end.x},${end.y}`;
          } else {
            d = wiring.side === 'out' ? wirePath(p.x, p.y, end.x, end.y) : wirePath(end.x, end.y, p.x, p.y);
          }
          out += `<path class="wirepreview" d="${d}"/>`;
          for (const v of wiring.via) out += `<circle class="wirestop" cx="${v.x}" cy="${v.y}" r="3"/>`;
        }
      }
      for (const c of comps) out += compSVG(c, false);

      // solder-dot notation where one output fans out into several wires
      for (const [key, count] of fanout) {
        if (count < 2) continue;
        const i = key.lastIndexOf(':');
        const c = find(key.slice(0, i));
        if (!c) continue;
        const p = pinPos(c, 'out', +key.slice(i + 1));
        const hi = sim.vals[key] | 0;
        out += `<circle class="junction${hi ? ' hi' : ''}" cx="${p.x}" cy="${p.y}" r="5"/>`;
      }

      if (marquee) {
        const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
        const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
        out += `<rect class="marquee" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
      }

      if (placing && placing.over) {
        const ghost: Comp = {
          id: '_ghost', type: placing.type, chipId: placing.chipId,
          x: snap(placing.mx - getGeom(placing as any, lib()).w / 2),
          y: snap(placing.my - getGeom(placing as any, lib()).h / 2),
        };
        out += compSVG(ghost, true);
      }

      world.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
      world.innerHTML = out;

      cb.onCounts({ parts: comps.length, wires: wires.length });
      cb.onZoom(Math.round(view.k * 100));
      svg.classList.toggle('wiring', !!wiring);
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
    function tryConnect(a: PinHit, b: PinHit, via: Vec[] = []): boolean {
      if (a.comp === b.comp || a.side === b.side) return false;
      const from = a.side === 'out' ? a : b;
      const to = a.side === 'out' ? b : a;
      const path = a.side === 'out' ? via : [...via].reverse();
      wires = wires.filter(w => !(w.to.comp === to.comp && w.to.pin === to.pin));
      wires.push({
        id: uid(), from: { comp: from.comp, pin: from.pin }, to: { comp: to.comp, pin: to.pin },
        ...(path.length ? { via: path } : {}),
      });
      return true;
    }

    /* ── placement ── */
    function placeAt(wx: number, wy: number) {
      if (!placing) return;
      const g = getGeom(placing as any, lib());
      const c: Comp = {
        id: uid(), type: placing.type, chipId: placing.chipId,
        x: snap(wx - g.w / 2), y: snap(wy - g.h / 2),
      };
      if (placing.type === 'IN' || placing.type === 'IPIN') c.on = false;
      if (placing.type === 'CLK') c.freq = 1;
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
        return c.x < x1 && c.x + g.w > x0 && c.y < y1 && c.y + g.h > y0;
      }).map(c => c.id));
      selWire = null;
    }

    function copySelection() {
      if (!selIds.size) return;
      const cs: Comp[] = comps.filter(c => selIds.has(c.id))
        .map(({ _ins, ...rest }) => JSON.parse(JSON.stringify(rest)));
      const ws: Wire[] = wires.filter(w => selIds.has(w.from.comp) && selIds.has(w.to.comp))
        .map(w => JSON.parse(JSON.stringify(w)));
      clipboard = { comps: cs, wires: ws };
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
        return { ...JSON.parse(JSON.stringify(c)), id, x: c.x + dx, y: c.y + dy };
      });
      const newWires: Wire[] = clipboard.wires.map(w => ({
        id: uid(),
        from: { comp: idMap.get(w.from.comp)!, pin: w.from.pin },
        to: { comp: idMap.get(w.to.comp)!, pin: w.to.pin },
        ...(w.via ? { via: w.via.map(v => ({ x: v.x + dx, y: v.y + dy })) } : {}),
      }));
      comps.push(...newComps);
      wires.push(...newWires);
      setSelection(newComps.map(c => c.id));
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

      if (resizeEl) {
        const c = find((resizeEl as SVGElement).dataset.resize!);
        if (c) { resize = { id: c.id }; if (wiring) wiring = null; render(); }
        return;
      }
      if (pinEl) {
        const p = parsePin(pinEl);
        if (wiring) {
          if (tryConnect({ comp: wiring.comp, pin: wiring.pin, side: wiring.side }, p, wiring.via)) wiring = null;
          refresh();
        } else {
          wiring = { ...p, via: [], mx: pt.x, my: pt.y, downX: e.clientX, downY: e.clientY, fresh: true };
          render();
        }
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
        // wires routed entirely inside the group carry their waypoints along
        const viaWires = wires
          .filter(w => w.via?.length && selIds.has(w.from.comp) && selIds.has(w.to.comp))
          .map(w => ({ w, base: w.via!.map(v => ({ ...v })) }));
        drag = { ids: [...selIds], primary: c.id, offs, orig, viaWires, moved: false, sx: e.clientX, sy: e.clientY };
        refresh(false);
        return;
      }
      if (wireEl && !wiring) {
        setSelection([], (wireEl as SVGElement).dataset.wire!);
        render();
        return;
      }
      if (wiring) {
        // click on empty grid: drop a routing stop at the nearest dot
        wiring.via.push({ x: snap(pt.x), y: snap(pt.y) });
        wiring.fresh = true;
        render();
        return;
      }
      if (spaceDown) { startPan(e); return; }
      // empty space: rubber-band select
      setSelection([]);
      marquee = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
      render();
    }

    function onMove(e: PointerEvent) {
      const pt = toWorld(e.clientX, e.clientY);
      {
        const r = svg.getBoundingClientRect();
        lastPt = { x: pt.x, y: pt.y, over: e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom };
      }
      if (resize) {
        const c = find(resize.id);
        if (!c) { resize = null; return; }
        const def = c.chipId ? lib()[c.chipId] : undefined;
        c.w = Math.max(CHIP_MIN_W, snap(pt.x - c.x));
        c.h = Math.max(def ? chipMinH(def) : GRID * 2, snap(pt.y - c.y));
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
            for (const { w, base } of drag.viaWires) w.via = base.map(v => ({ x: v.x + dx, y: v.y + dy }));
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
      }
    }

    function onUp(e: PointerEvent) {
      if (resize) {
        resize = null;
        refresh();
        return;
      }
      if (drag) {
        const c = find(drag.primary);
        if (c && !drag.moved && (c.type === 'IN' || c.type === 'IPIN')) c.on = !c.on;
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
      if (wiring && !wiring.fresh) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const pinEl = el?.closest?.('[data-pin]');
        if (pinEl) {
          const p = parsePin(pinEl);
          if (tryConnect({ comp: wiring.comp, pin: wiring.pin, side: wiring.side }, p, wiring.via)) wiring = null;
          refresh();
        }
        if (wiring) wiring.fresh = true;   // stay in click-click mode
        return;
      }
      if (wiring) { wiring.fresh = false; return; }
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
      else if (wireEl) { wires = wires.filter(w => w.id !== (wireEl as SVGElement).dataset.wire); refresh(); }
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
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'c') { copySelection(); e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'v') { paste(); e.preventDefault(); return; }
      if (e.key === ' ') { spaceDown = true; svg.classList.add('panready'); e.preventDefault(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
      if (e.key === 'Escape') {
        if (wiring) { wiring = null; render(); return; }
        if (placing) { setPlacing(null); render(); return; }
        if (marquee) { marquee = null; render(); return; }
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
      wires = wires.filter(w => w.from.comp !== id && w.to.comp !== id);
      delete sim.sub[id];
      if (selIds.has(id)) { selIds.delete(id); emitSel(); }
      refresh();
    }
    function deleteSelection() {
      if (selWire) {
        wires = wires.filter(w => w.id !== selWire);
        setSelection([]);
        refresh();
        return;
      }
      if (!selIds.size) return;
      comps = comps.filter(c => !selIds.has(c.id));
      wires = wires.filter(w => !selIds.has(w.from.comp) && !selIds.has(w.to.comp));
      selIds.forEach(id => delete sim.sub[id]);
      setSelection([]);
      refresh();
    }

    /* ── wire up ── */
    svg.addEventListener('pointerdown', onDown);
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
        setPlacing({ type, chipId, mx: 0, my: 0, over: false, held: true });
        render();
      },
      deleteSelection,
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
        if (!c || !MULTI_IN_GATES.has(c.type)) return;
        c.nIns = clampGateIns(n);
        wires = wires.filter(w => !(w.to.comp === id && w.to.pin >= c.nIns!));
        if (selIds.has(id)) emitSel();
        refresh();
      },
      setFreq(id, hz) {
        const c = find(id);
        if (!c || c.type !== 'CLK') return;
        c.freq = clampFreq(hz);
        refresh();
      },
      getBoard(): Board {
        return JSON.parse(JSON.stringify({
          comps: comps.map(({ _ins, ...rest }) => rest),
          wires,
        }));
      },
      setBoard(b: Board) {
        const known = lib();
        comps = (b.comps || []).filter(c => c.type !== 'CHIP' || (c.chipId && known[c.chipId]));
        wires = (b.wires || []).filter(w =>
          comps.some(c => c.id === w.from.comp) && comps.some(c => c.id === w.to.comp));
        sim = newSimState();
        setSelection([]);
        refresh(false);
      },
      removeChipInstances(chipId) {
        const doomed = new Set(comps.filter(c => c.chipId === chipId).map(c => c.id));
        if (!doomed.size) { refresh(false); return; }
        comps = comps.filter(c => !doomed.has(c.id));
        wires = wires.filter(w => !doomed.has(w.from.comp) && !doomed.has(w.to.comp));
        doomed.forEach(id => delete sim.sub[id]);
        if ([...selIds].some(id => doomed.has(id))) setSelection([...selIds].filter(id => !doomed.has(id)));
        refresh();
      },
      rerender() { refresh(false); },
      destroy() {
        clearInterval(clockTimer);
        svg.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        svg.removeEventListener('contextmenu', onContext);
        svg.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKeyUp);
      },
    };
  }
