/* Static SVG renderers for chip previews — the abstracted chip package
   and its internal circuit. Used by the chip inspector, the peek
   popup, and the community storefront (cards, detail view, upload
   preview).

   These produce standalone <svg> markup strings using the same class
   names as the live editor (.comp .body/.stub/.pin/.lbl/…), so the
   global stylesheet makes previews match the canvas exactly.

   chipInternalsSVG can optionally take a live SimState (the editor's
   per-instance sub-state) — then wires, pins, and displays light up
   with the values the placed chip is computing right now. Without it,
   everything draws in its "off" look. */

import {
  Comp, Wire, WireEnd, Vec, ChipDef, ChipLib, SimState,
  getGeom, chipGeom, isPinEnd, isAttachEnd, isMemoryType, isBusToolType, defaultEdgeForComp,
  clampBits, maskVal, formatBusValue, chipLabelOffset, chipBodyPath, analyzeNets, tunnelPinGroups,
  wireRouteCorners, wireCornerPath, wireEndFacing, SEG_NAMES,
} from './engine';
import { GATE_DEFS, isGateType } from './gates';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const edgeText = (c: Pick<Comp, 'edge'>) => c.edge === 'rise' ? ' / rise' : c.edge === 'fall' ? ' / fall' : '';

/* Rotation helpers — same mapping as the editor (components/editor.ts). */
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

/* Live values for one component while rendering a running chip. */
interface LiveVals { ins: bigint[]; outs: bigint[] }

function compMarkup(c: Comp, lib: ChipLib, lv?: LiveVals): string {
  const g = getGeom(c, lib);
  const rot = (c.rot ?? 0) & 3;
  const ctr = (x: number, y: number) => rot ? ` transform="rotate(${-rot * 90} ${x} ${y})"` : '';
  const caption = (text: string, x: number, y: number) =>
    `<text class="lbl" x="${x}" y="${y}"${ctr(x, y)}>${esc(text)}</text>`;
  const inV = (i: number) => lv?.ins[i] ?? 0n;
  const outV = (i: number) => lv?.outs[i] ?? 0n;
  const hiCls = (v: bigint | number) => (v ? ' hi' : '');

  let inner = '', stubs = '', pins = '';
  // stub target on the body edge — chips may carry pins on any edge
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
    const e = stubEnd(p, false);
    stubs += `<path class="stub${hiCls(inV(i))}" d="M${p.x},${p.y} L${e.x},${e.y}"/>`;
    pins += `<circle class="pin${hiCls(inV(i))}" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
  });
  g.outs.forEach((p, i) => {
    const e = stubEnd(p, true);
    stubs += `<path class="stub${hiCls(outV(i))}" d="M${e.x},${e.y} L${p.x},${p.y}"/>`;
    pins += `<circle class="pin${hiCls(outV(i))}" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
  });

  if (isGateType(c.type)) {
    const gd = GATE_DEFS[c.type];
    const gb = clampBits(c.bits ?? 1);
    inner = `<path class="body" d="${gd.body(g.h)}"/>`;
    const curve = gd.backCurve?.(g.h);
    if (curve) inner += `<path d="${curve}" fill="none" stroke="var(--body-stroke)" stroke-width="1.5"/>`;
    const bub = gd.bubble?.(g.h);
    if (bub) inner += `<circle cx="${bub.cx}" cy="${bub.cy}" r="${bub.r}" class="body"/>`;
    inner += caption(`${g.name}${gb > 1 ? ` · ${gb}b` : ''}${edgeText(c)}`, 30, gd.captionY ?? g.h + 21);
  } else if (c.type === 'IN') {
    const on = lv ? !!outV(0) : false;
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <rect x="11" y="11" width="38" height="18" rx="9" fill="${on ? 'var(--hi)' : '#3a3a44'}"/>
      <circle cx="${on ? 40 : 20}" cy="20" r="7" fill="#f5f5f7"/>` +
      caption(lv ? `${c.label || 'SW'} · ${on ? 1 : 0}` : (c.label || 'SW'), 30, 52);
  } else if (c.type === 'BTN') {
    const on = lv ? !!outV(0) : false;
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <circle cx="30" cy="20" r="11" fill="${on ? 'var(--hi)' : '#3a3a44'}" stroke="var(--body-stroke)" stroke-width="1.5"/>
      <circle cx="30" cy="20" r="${on ? 4.5 : 6}" fill="${on ? '#0d331a' : '#55555f'}"/>` + caption(c.label || 'BTN', 30, 52);
  } else if (c.type === 'ONE') {
    inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="9"/>
      <text class="pindigit hi" x="20" y="26"${ctr(20, 20)}>1</text>` + caption('HIGH', 20, 52);
  } else if (c.type === 'CLK') {
    const on = lv ? !!outV(0) : false;
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <path d="M10,${on ? 13 : 27} H19 V${on ? 27 : 13} H29 V${on ? 13 : 27} H39 V${on ? 27 : 13} H49" fill="none" stroke="${on ? 'var(--hi)' : 'var(--muted)'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      caption(c.label || 'CLK', 30, 52);
  } else if (c.type === 'IPIN') {
    const n = clampBits(c.bits ?? 1);
    const v = lv ? maskVal(outV(0), n) : 0n;
    const txt = n > 1 ? formatBusValue(v, n) : v.toString();
    inner = `<rect class="body pinport${hiCls(v)}" x="0" y="0" width="${g.w}" height="40" rx="7"/>
      <text class="pindigit${hiCls(v)}" x="${g.w / 2}" y="25" style="font-size:${n > 1 ? 12 : 15}px"${ctr(g.w / 2, 20)}>${txt}</text>` +
      caption(`▸ ${c.label || 'IN?'}${n > 1 ? ` · ${n}b` : ''}`, g.w / 2, 52);
  } else if (c.type === 'OPIN') {
    const n = clampBits(c.bits ?? 1);
    const v = lv ? maskVal(inV(0), n) : 0n;
    const txt = n > 1 ? formatBusValue(v, n) : v.toString();
    const shape = n > 1
      ? `<rect class="body pinport${hiCls(v)}" x="0" y="0" width="${g.w}" height="40" rx="19"/>`
      : `<circle class="body pinport${hiCls(v)}" cx="20" cy="20" r="19"/>`;
    inner = `${shape}
      <text class="pindigit${hiCls(v)}" x="${g.w / 2}" y="25" style="font-size:${n > 1 ? 12 : 15}px"${ctr(g.w / 2, 20)}>${txt}</text>` +
      caption(`${c.label || 'OUT?'}${n > 1 ? ` · ${n}b` : ''} ▸`, g.w / 2, 52);
  } else if (c.type === 'VAL') {
    const n = clampBits(c.bits ?? 1);
    const v = maskVal(c.val, n);
    inner = `<rect class="body" x="0" y="0" width="${g.w}" height="40" rx="9"/>
      <text class="pindigit${hiCls(v)}" x="${g.w / 2}" y="25" style="font-size:12px"${ctr(g.w / 2, 20)}>${formatBusValue(v, n)}</text>` +
      caption(`${c.label || 'VAL'} · ${n}b`, g.w / 2, 52);
  } else if (c.type === 'OUT') {
    const lit = lv ? !!inV(0) : false;
    inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="10"/>
      <circle cx="20" cy="20" r="11" fill="${lit ? 'var(--led-on)' : '#33333b'}" stroke="${lit ? '#ff6b61' : '#4a4a54'}" stroke-width="1.5"/>
      ${lit ? '<circle cx="16.5" cy="16.5" r="3" fill="#ffd7d4" opacity=".85"/>' : ''}` +
      caption(c.label || 'LED', 20, 52);
  } else if (c.type === 'SSEG') {
    const ox = 42, oy = 26, W = 36, H = 104, my = oy + H / 2;
    const on = (i: number) => (lv ? (inV(i) ? 1 : 0) : 0);
    const seg = (i: number, d: string) => `<path d="${d}" class="seg${on(i) ? ' hi' : ''}"/>`;
    inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="9"/>
      <rect x="28" y="8" width="${g.w - 36}" height="${g.h - 16}" rx="7" fill="#141417"/>`
      + seg(0, `M${ox + 4},${oy} H${ox + W - 4}`) + seg(1, `M${ox + W},${oy + 4} V${my - 4}`)
      + seg(2, `M${ox + W},${my + 4} V${oy + H - 4}`) + seg(3, `M${ox + 4},${oy + H} H${ox + W - 4}`)
      + seg(4, `M${ox},${my + 4} V${oy + H - 4}`) + seg(5, `M${ox},${oy + 4} V${my - 4}`)
      + seg(6, `M${ox + 4},${my} H${ox + W - 4}`)
      + `<circle cx="${ox + W + 12}" cy="${oy + H}" r="4.5" class="seg${on(7) ? ' hi' : ''}"/>`;
    if (lv) g.ins.forEach((p, i) => {
      inner += `<text class="pinname" x="10" y="${p.y + 3}" text-anchor="start"${ctr(10, p.y)}>${SEG_NAMES[i]}</text>`;
    });
    inner += caption(c.label || '7-SEG', g.w / 2, g.h + 14);
  } else if (c.type === 'TUN') {
    const lit = lv ? !!inV(0) : false;
    inner = `<path class="body tunnelbody${lit ? ' hi' : ''}" d="M2,20 L18,4 H70 A8,8 0 0 1 78,12 V28 A8,8 0 0 1 70,36 H18 Z"/>
      <text class="tunnelname" x="46" y="24"${ctr(46, 20)}>${esc(c.label?.trim() || '?')}</text>` +
      caption('TUNNEL', 40, 52);
  } else if (isBusToolType(c.type)) {
    const isComb = c.type === 'COMB';
    const n = clampBits(c.nIns ?? 4);
    const v = lv ? maskVal(isComb ? outV(0) : inV(0), n) : 0n;
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
    const q = lv ? (outV(0) ? 1 : 0) : 0;
    inner = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(c.label || g.name)}</text>
      <text class="combval${q ? ' hi' : ''}" x="${g.w / 2}" y="${g.h / 2 + 24}"${ctr(g.w / 2, g.h / 2 + 24)}>Q=${q}</text>`;
    g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start"${ctr(8, p.y)}>${esc(p.name || '')}</text>`; });
    g.outs.forEach(p => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end"${ctr(g.w - 8, p.y)}>${esc(p.name || '')}</text>`; });
    if (edge) inner += caption(`${edge} edge`, g.w / 2, g.h + 14);
  } else if (c.type === 'CHIP') {
    const chipDef = c.chipId ? lib[c.chipId] : undefined;
    // a placed instance's own pin layout (if valid) wins over the package's
    const instL = c.layout && chipDef
      && c.layout.ins.length === chipDef.inputs.length
      && c.layout.outs.length === chipDef.outputs.length ? c.layout : undefined;
    const pinLabel = (p: Vec & { name?: string }, i: number, side: 'in' | 'out') => {
      const off = chipDef ? chipLabelOffset(chipDef, side, i, instL) : { lx: 0, ly: 0 };
      if (p.y < 0 || p.y > g.h) {
        const by = p.y < 0 ? 13 : g.h - 7;
        return `<text class="pinname" x="${p.x + off.lx}" y="${by + off.ly}" text-anchor="middle"${ctr(p.x, by)}>${esc(p.name || '')}</text>`;
      }
      const left = p.x < 0;
      const bx = left ? 8 : g.w - 8;
      return `<text class="pinname" x="${bx + off.lx}" y="${p.y + 3 + off.ly}" text-anchor="${left ? 'start' : 'end'}"${ctr(bx, p.y)}>${esc(p.name || '')}</text>`;
    };
    const bodyD = chipBodyPath(chipDef?.shape, g.w, g.h, chipDef?.shapePts);
    inner = (bodyD
      ? `<path class="body chipbody" d="${bodyD}"/>`
      : `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>`)
      + `<text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(g.name)}</text>`;
    g.ins.forEach((p, i) => { inner += pinLabel(p, i, 'in'); });
    g.outs.forEach((p, i) => { inner += pinLabel(p, i, 'out'); });
    if (c.edge) inner += caption(`${c.edge} edge`, g.w / 2, g.h + 14);
  }

  const core = stubs + inner + pins;
  const rotated = rot ? `<g transform="${rotTransform(rot, g.w, g.h)}">${core}</g>` : core;
  return `<g class="comp" transform="translate(${c.x},${c.y})">${rotated}</g>`;
}

/* Render a full circuit (a chip's internals, or any board) statically —
   or live, when the editor's SimState for that instance is passed. */
export function chipInternalsSVG(src: { comps: Comp[]; wires: Wire[] }, lib: ChipLib, live?: SimState): string {
  const comps = src.comps, wires = src.wires;
  const find = (id: string) => comps.find(c => c.id === id);
  const pinPos = (c: Comp, side: 'in' | 'out', idx: number): Vec => {
    const g = getGeom(c, lib);
    const p = g[side === 'out' ? 'outs' : 'ins'][idx];
    if (!p) return { x: c.x, y: c.y };
    const r = rotPt(p.x, p.y, c.rot ?? 0, g.w, g.h);
    return { x: c.x + r.x, y: c.y + r.y };
  };
  const endPos = (e: WireEnd): Vec | null => {
    if (isPinEnd(e)) {
      const c = find(e.comp);
      return c ? pinPos(c, e.side, e.pin) : null;
    }
    return { x: (e as Vec).x, y: (e as Vec).y };
  };

  const nets = analyzeNets(wires, tunnelPinGroups(comps));
  const netVal = (keys?: string[]) => {
    let v = 0n;
    if (live && keys) for (const k of keys) v |= live.vals[k] ?? 0n;
    return v;
  };
  const liveFor = (c: Comp): LiveVals | undefined => {
    if (!live) return undefined;
    const g = getGeom(c, lib);
    return {
      ins: g.ins.map((_, i) => netVal(nets.inputDrivers.get(c.id + ':' + i))),
      outs: g.outs.map((_, i) => live.vals[c.id + ':' + i] ?? 0n),
    };
  };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const c of comps) {
    const g = getGeom(c, lib);
    const f = footprint(c.rot ?? 0, g.w, g.h);
    grow(c.x - 22, c.y - 22);
    grow(c.x + f.w + 22, c.y + f.h + 26); // room for pins + caption below
  }

  let out = '';
  for (const w of wires) {
    const a = endPos(w.a), b = endPos(w.b);
    if (!a || !b) continue;
    grow(a.x, a.y); grow(b.x, b.y);
    const hi = netVal(nets.wireOuts.get(w.id));
    let pts: Vec[];
    if (w.via?.length) {
      for (const v of w.via) grow(v.x, v.y);
      pts = [a, ...w.via, b];
    } else {
      pts = wireRouteCorners(a, b, wireEndFacing(w.a), wireEndFacing(w.b));
    }
    const bits = clampBits(w.bits);
    out += `<path class="wire${bits > 1 ? ' bus' : ''}${hi ? ' hi' : ''}" d="${wireCornerPath(pts)}"/>`;
    if (live && bits > 1) {
      out += `<text class="buslabel${hi ? ' hi' : ''}" x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 9}" text-anchor="middle">${formatBusValue(hi, bits)}</text>`;
    }
  }
  for (const c of comps) out += compMarkup(c, lib, liveFor(c));

  // solder dots where several wires meet a pin, and at mid-wire splits
  for (const [key, count] of nets.pinWireCounts) {
    if (count < 2) continue;
    const [compId, side, pin] = key.split(':');
    const c = find(compId);
    if (!c) continue;
    const p = pinPos(c, side as 'in' | 'out', +pin);
    const hi = side === 'out'
      ? (live ? live.vals[compId + ':' + pin] ?? 0n : 0n)
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

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  const pad = 14;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${out}</svg>`;
}

/* Render the abstracted chip package: body, name, and named pins. */
export function chipAbstractSVG(def: ChipDef): string {
  const g = chipGeom(def);
  const bodyD = chipBodyPath(def.shape, g.w, g.h, def.shapePts);
  const stubEnd = (p: Vec): Vec => {
    if (p.y < 0) return { x: p.x, y: 8 };
    if (p.y > g.h) return { x: p.x, y: g.h - 8 };
    return { x: p.x < 0 ? 8 : g.w - 8, y: p.y };
  };
  let stubs = '', pins = '', labels = '';
  const pin = (p: typeof g.ins[number], i: number, side: 'in' | 'out') => {
    const off = chipLabelOffset(def, side, i);
    const e = stubEnd(p);
    stubs += `<path class="stub" d="M${p.x},${p.y} L${e.x},${e.y}"/>`;
    pins += `<circle class="pin" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
    if (p.y < 0 || p.y > g.h) {
      const by = p.y < 0 ? 13 : g.h - 7;
      labels += `<text class="pinname" x="${p.x + off.lx}" y="${by + off.ly}" text-anchor="middle">${esc(p.name || '')}</text>`;
    } else {
      const left = p.x < 0;
      const bx = left ? 8 : g.w - 8;
      labels += `<text class="pinname" x="${bx + off.lx}" y="${p.y + 3 + off.ly}" text-anchor="${left ? 'start' : 'end'}">${esc(p.name || '')}</text>`;
    }
  };
  g.ins.forEach((p, i) => pin(p, i, 'in'));
  g.outs.forEach((p, i) => pin(p, i, 'out'));
  const body = bodyD
    ? `<path class="body chipbody" d="${bodyD}"/>`
    : `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
    <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>`;
  const out = stubs + body
    + `<text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}">${esc(def.name)}</text>` + labels + pins;
  const hasT = [...g.ins, ...g.outs].some(p => p.y < 0);
  const hasB = [...g.ins, ...g.outs].some(p => p.y > g.h);
  const y0 = hasT ? -26 : -8;
  const y1 = g.h + (hasB ? 26 : 8);
  const vb = `-26 ${y0} ${g.w + 52} ${y1 - y0}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><g class="comp">${out}</g></svg>`;
}
