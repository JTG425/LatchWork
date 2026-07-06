/* ────────────────────────────────────────────────────────────────
   Latchwork editor — imperative SVG canvas.
   Owns pointer interaction, wiring, pan/zoom, and rendering.
   Pure logic lives in lib/engine; React (Simulator.tsx) owns the
   chrome around the canvas and talks to this through EditorApi.
   ──────────────────────────────────────────────────────────────── */

   import {
    GRID, Comp, Wire, Board, ChipLib, CompType,
    SimState, newSimState, getGeom, evaluateNet,
  } from '@/lib/engine';
  
  export interface SelInfo {
    kind: 'comp' | 'wire';
    id: string;
    type?: CompType;
    label?: string;
    labelable?: boolean;
  }
  
  export interface EditorCallbacks {
    getLib(): ChipLib;
    onSelect(info: SelInfo | null): void;
    onCounts(c: { parts: number; wires: number }): void;
    onZoom(pct: number): void;
    onBoardChange(): void;
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
    getBoard(): Board;
    setBoard(b: Board): void;
    removeChipInstances(chipId: string): void;
    rerender(): void;
    destroy(): void;
  }
  
  const uid = () =>
    'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  
  /* Gate bodies span y −10…50 so the input pins at y 0 / 40 enter the
     flat or curved back edge at the classic quarter positions. */
  const GATE_BODY: Partial<Record<CompType, string>> = {
    AND:  'M4,-8 H30 C52,-8 60,4 60,20 C60,36 52,48 30,48 H4 Z',
    NAND: 'M4,-8 H28 C48,-8 56,4 56,20 C56,36 48,48 28,48 H4 Z',
    OR:   'M3,-8 H22 C42,-8 55,4 60,20 C55,36 42,48 22,48 H3 C13,32 13,8 3,-8 Z',
    NOR:  'M3,-8 H20 C38,-8 50,4 55,20 C50,36 38,48 20,48 H3 C13,32 13,8 3,-8 Z',
    XOR:  'M9,-8 H26 C45,-8 55,4 60,20 C55,36 45,48 26,48 H9 C19,32 19,8 9,-8 Z',
    NOT:  'M6,4 L6,36 L52,20 Z',
  };
  
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  
  export function createEditor(svg: SVGSVGElement, cb: EditorCallbacks): EditorApi {
    const world = svg.querySelector('#world') as SVGGElement;
  
    /* ── state ── */
    let comps: Comp[] = [];
    let wires: Wire[] = [];
    let sim: SimState = newSimState();
    let view = { x: 0, y: 0, k: 1 };
  
    let sel: SelInfo | null = null;
    let wiring: { comp: string; side: 'in' | 'out'; pin: number; mx: number; my: number; downX: number; downY: number; fresh: boolean } | null = null;
    let drag: { id: string; ox: number; oy: number; moved: boolean; sx: number; sy: number } | null = null;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let placing: { type: CompType; chipId?: string; mx: number; my: number; over: boolean } | null = null;
  
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
    function wirePath(x1: number, y1: number, x2: number, y2: number) {
      if (x2 >= x1 + 20) {
        const mx = snap((x1 + x2) / 2);
        return `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
      }
      const my = snap((y1 + y2) / 2);
      return `M${x1},${y1} L${x1 + 20},${y1} L${x1 + 20},${my} L${x2 - 20},${my} L${x2 - 20},${y2} L${x2},${y2}`;
    }
    const find = (id: string) => comps.find(c => c.id === id);
  
    function select(next: SelInfo | null) {
      sel = next;
      cb.onSelect(sel);
    }
    function selInfoFor(c: Comp): SelInfo {
      return {
        kind: 'comp', id: c.id, type: c.type, label: c.label || '',
        labelable: c.type === 'IN' || c.type === 'BTN' || c.type === 'OUT' || c.type === 'CHIP',
      };
    }
  
    /* ── simulation ── */
    function recompute() {
      evaluateNet(comps, wires, sim, lib());
    }
  
    /* ── rendering ── */
    function pinSVG(c: Comp, side: 'in' | 'out', idx: number, hi: number) {
      const p = getGeom(c, lib())[side === 'out' ? 'outs' : 'ins'][idx];
      return `<circle class="pinhit" data-pin="${c.id}|${side}|${idx}" cx="${p.x}" cy="${p.y}" r="10"/>
              <circle class="pin ${hi ? 'hi' : ''}" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
    }
  
    function compSVG(c: Comp, ghost: boolean): string {
      const g = getGeom(c, lib());
      const selCls = sel && sel.kind === 'comp' && sel.id === c.id ? ' selected' : '';
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
  
      if (GATE_BODY[c.type]) {
        inner = `<path class="body" d="${GATE_BODY[c.type]}"/>`;
        if (c.type === 'XOR')
          inner += `<path d="M2,-8 C12,8 12,32 2,48" fill="none" stroke="var(--body-stroke)" stroke-width="1.5"/>`;
        if (c.type === 'NAND' || c.type === 'NOR')
          inner += `<circle cx="${c.type === 'NAND' ? 60 : 59}" cy="20" r="4" class="body"/>`;
        if (c.type === 'NOT')
          inner += `<circle cx="56" cy="20" r="4" class="body"/>`;
        inner += caption(g.name, 30, c.type === 'NOT' ? 50 : 61);
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
      }
  
      return `<g class="comp${selCls}${ghost ? ' ghost' : ''}" data-comp="${c.id}"
                transform="translate(${c.x},${c.y})">${stubs}${inner}${pins}</g>`;
    }
  
    function render() {
      let out = `<rect x="-20000" y="-20000" width="40000" height="40000" fill="url(#dots)"/>`;
  
      for (const w of wires) {
        const fc = find(w.from.comp), tc = find(w.to.comp);
        if (!fc || !tc) continue;
        const a = pinPos(fc, 'out', w.from.pin);
        const b = pinPos(tc, 'in', w.to.pin);
        const hi = sim.vals[w.from.comp + ':' + w.from.pin] | 0;
        const selCls = sel && sel.kind === 'wire' && sel.id === w.id ? ' selected' : '';
        const d = wirePath(a.x, a.y, b.x, b.y);
        out += `<g><path class="wirehit" data-wire="${w.id}" d="${d}"/><path class="wire${hi ? ' hi' : ''}${selCls}" d="${d}"/></g>`;
      }
      if (wiring) {
        const c = find(wiring.comp);
        if (c) {
          const p = pinPos(c, wiring.side, wiring.pin);
          const d = wiring.side === 'out'
            ? wirePath(p.x, p.y, wiring.mx, wiring.my)
            : wirePath(wiring.mx, wiring.my, p.x, p.y);
          out += `<path class="wirepreview" d="${d}"/>`;
        }
      }
      for (const c of comps) out += compSVG(c, false);
  
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
    function tryConnect(a: PinHit, b: PinHit): boolean {
      if (a.comp === b.comp || a.side === b.side) return false;
      const from = a.side === 'out' ? a : b;
      const to = a.side === 'out' ? b : a;
      wires = wires.filter(w => !(w.to.comp === to.comp && w.to.pin === to.pin));
      wires.push({ id: uid(), from: { comp: from.comp, pin: from.pin }, to: { comp: to.comp, pin: to.pin } });
      return true;
    }
  
    /* ── pointer handlers ── */
    function onDown(e: PointerEvent) {
      if (e.button === 2) return;
      const pt = toWorld(e.clientX, e.clientY);
      const target = e.target as Element;
      const pinEl = target.closest('[data-pin]');
      const compEl = target.closest('[data-comp]');
      const wireEl = target.closest('[data-wire]');
  
      if (pinEl) {
        const p = parsePin(pinEl);
        if (wiring) {
          if (tryConnect({ comp: wiring.comp, pin: wiring.pin, side: wiring.side }, p)) wiring = null;
          refresh();
        } else {
          wiring = { ...p, mx: pt.x, my: pt.y, downX: e.clientX, downY: e.clientY, fresh: true };
          render();
        }
        return;
      }
      if (compEl) {
        const c = find((compEl as SVGElement).dataset.comp!);
        if (!c) return;
        select(selInfoFor(c));
        if (wiring) wiring = null;
        if (c.type === 'BTN') c.pressed = true;
        drag = { id: c.id, ox: pt.x - c.x, oy: pt.y - c.y, moved: false, sx: e.clientX, sy: e.clientY };
        refresh(false);
        return;
      }
      if (wireEl) {
        select({ kind: 'wire', id: (wireEl as SVGElement).dataset.wire! });
        if (wiring) wiring = null;
        render();
        return;
      }
      if (wiring) { wiring = null; render(); return; }
      select(null);
      pan = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      svg.classList.add('panning');
      render();
    }
  
    function onMove(e: PointerEvent) {
      if (drag) {
        const c = find(drag.id);
        if (!c) { drag = null; return; }
        if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
        if (drag.moved) {
          if (c.type === 'BTN' && c.pressed) c.pressed = false;
          const pt = toWorld(e.clientX, e.clientY);
          c.x = snap(pt.x - drag.ox);
          c.y = snap(pt.y - drag.oy);
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
      if (wiring) {
        const pt = toWorld(e.clientX, e.clientY);
        wiring.mx = pt.x; wiring.my = pt.y;
        if (Math.abs(e.clientX - wiring.downX) + Math.abs(e.clientY - wiring.downY) > 6) wiring.fresh = false;
        render();
        return;
      }
      if (placing) {
        const r = svg.getBoundingClientRect();
        placing.over = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        const pt = toWorld(e.clientX, e.clientY);
        placing.mx = pt.x; placing.my = pt.y;
        render();
      }
    }
  
    function onUp(e: PointerEvent) {
      if (drag) {
        const c = find(drag.id);
        if (c && !drag.moved && c.type === 'IN') c.on = !c.on;
        if (c && c.type === 'BTN') c.pressed = false;
        const moved = drag.moved;
        drag = null;
        refresh(moved || true);
        return;
      }
      if (pan) { pan = null; svg.classList.remove('panning'); return; }
      if (wiring && !wiring.fresh) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const pinEl = el?.closest?.('[data-pin]');
        if (pinEl) {
          const p = parsePin(pinEl);
          if (tryConnect({ comp: wiring.comp, pin: wiring.pin, side: wiring.side }, p)) wiring = null;
          refresh();
        }
        if (wiring) wiring.fresh = true;   // stay in click-click mode
        return;
      }
      if (wiring) { wiring.fresh = false; return; }
      if (placing) {
        if (placing.over) {
          const g = getGeom(placing as any, lib());
          const c: Comp = {
            id: uid(), type: placing.type, chipId: placing.chipId,
            x: snap(placing.mx - g.w / 2), y: snap(placing.my - g.h / 2),
          };
          if (placing.type === 'IN') c.on = false;
          comps.push(c);
          select(selInfoFor(c));
        }
        placing = null;
        refresh();
      }
    }
  
    function onContext(e: MouseEvent) {
      e.preventDefault();
      const target = e.target as Element;
      const compEl = target.closest('[data-comp]');
      const wireEl = target.closest('[data-wire]');
      if (compEl) deleteComp((compEl as SVGElement).dataset.comp!);
      else if (wireEl) { wires = wires.filter(w => w.id !== (wireEl as SVGElement).dataset.wire); refresh(); }
    }
  
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left, cy = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const k = Math.min(2.5, Math.max(0.35, view.k * factor));
      view.x = cx - (cx - view.x) * (k / view.k);
      view.y = cy - (cy - view.y) * (k / view.k);
      view.k = k;
      render();
    }
  
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelection(); }
      if (e.key === 'Escape') { wiring = null; placing = null; select(null); render(); }
    }
  
    /* ── mutations ── */
    function deleteComp(id: string) {
      comps = comps.filter(c => c.id !== id);
      wires = wires.filter(w => w.from.comp !== id && w.to.comp !== id);
      delete sim.sub[id];
      if (sel?.id === id) select(null);
      refresh();
    }
    function deleteSelection() {
      if (!sel) return;
      if (sel.kind === 'comp') deleteComp(sel.id);
      else { wires = wires.filter(w => w.id !== sel!.id); select(null); refresh(); }
    }
  
    /* ── wire up ── */
    svg.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    svg.addEventListener('contextmenu', onContext);
    svg.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
  
    refresh(false);
  
    /* ── public API ── */
    return {
      beginPlace(type, chipId) { placing = { type, chipId, mx: 0, my: 0, over: false }; },
      deleteSelection,
      clear() { comps = []; wires = []; sim = newSimState(); select(null); wiring = null; refresh(); },
      powerCycle() { sim = newSimState(); refresh(false); },
      zoomIn() { view.k = Math.min(2.5, view.k * 1.2); render(); },
      zoomOut() { view.k = Math.max(0.35, view.k / 1.2); render(); },
      resetView() { view = { x: 0, y: 0, k: 1 }; render(); },
      setLabel(id, label) {
        const c = find(id);
        if (c) { c.label = label.slice(0, 12); refresh(); }
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
        select(null);
        refresh(false);
      },
      removeChipInstances(chipId) {
        const doomed = new Set(comps.filter(c => c.chipId === chipId).map(c => c.id));
        if (!doomed.size) { refresh(false); return; }
        comps = comps.filter(c => !doomed.has(c.id));
        wires = wires.filter(w => !doomed.has(w.from.comp) && !doomed.has(w.to.comp));
        doomed.forEach(id => delete sim.sub[id]);
        if (sel && doomed.has(sel.id)) select(null);
        refresh();
      },
      rerender() { refresh(false); },
      destroy() {
        svg.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        svg.removeEventListener('contextmenu', onContext);
        svg.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
      },
    };
  }
  