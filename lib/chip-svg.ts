/* Static SVG renderers for chip previews — the abstracted chip package
   and its internal circuit. Used by the chip inspector and the
   community storefront (cards, detail view, upload preview).

   These produce standalone <svg> markup strings using the same class
   names as the live editor (.comp .body/.stub/.pin/.lbl/…), so the
   global stylesheet makes previews match the canvas exactly. No
   simulation state is rendered — everything draws in its "off" look. */

import {
  Comp, Wire, WireEnd, Vec, ChipDef, ChipLib, GRID,
  getGeom, chipGeom, isPinEnd, isAttachEnd, isMemoryType, defaultEdgeForComp,
} from './engine';
import { GATE_DEFS, isGateType } from './gates';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const snap = (v: number) => Math.round(v / GRID) * GRID;
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

function wirePath(x1: number, y1: number, x2: number, y2: number) {
  if (x2 >= x1 + 20) {
    const mx = snap((x1 + x2) / 2);
    return `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
  }
  const my = snap((y1 + y2) / 2);
  return `M${x1},${y1} L${x1 + 20},${y1} L${x1 + 20},${my} L${x2 - 20},${my} L${x2 - 20},${y2} L${x2},${y2}`;
}

function compMarkup(c: Comp, lib: ChipLib): string {
  const g = getGeom(c, lib);
  const rot = (c.rot ?? 0) & 3;
  const ctr = (x: number, y: number) => rot ? ` transform="rotate(${-rot * 90} ${x} ${y})"` : '';
  const caption = (text: string, x: number, y: number) =>
    `<text class="lbl" x="${x}" y="${y}"${ctr(x, y)}>${esc(text)}</text>`;

  let inner = '', stubs = '', pins = '';
  g.ins.forEach(p => {
    const bx = c.type === 'CHIP' ? 0 : isGateType(c.type) ? GATE_DEFS[c.type].stubX : 8;
    stubs += `<path class="stub" d="M${p.x},${p.y} L${bx},${p.y}"/>`;
    pins += `<circle class="pin" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
  });
  g.outs.forEach(p => {
    stubs += `<path class="stub" d="M${g.w},${p.y} L${p.x},${p.y}"/>`;
    pins += `<circle class="pin" cx="${p.x}" cy="${p.y}" r="3.6"/>`;
  });

  if (isGateType(c.type)) {
    const gd = GATE_DEFS[c.type];
    inner = `<path class="body" d="${gd.body(g.h)}"/>`;
    const curve = gd.backCurve?.(g.h);
    if (curve) inner += `<path d="${curve}" fill="none" stroke="var(--body-stroke)" stroke-width="1.5"/>`;
    const bub = gd.bubble?.(g.h);
    if (bub) inner += `<circle cx="${bub.cx}" cy="${bub.cy}" r="${bub.r}" class="body"/>`;
    inner += caption(`${g.name}${edgeText(c)}`, 30, gd.captionY ?? g.h + 21);
  } else if (c.type === 'IN') {
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <rect x="11" y="11" width="38" height="18" rx="9" fill="#3a3a44"/>
      <circle cx="20" cy="20" r="7" fill="#f5f5f7"/>` + caption(c.label || 'SW', 30, 52);
  } else if (c.type === 'BTN') {
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <circle cx="30" cy="20" r="11" fill="#3a3a44" stroke="var(--body-stroke)" stroke-width="1.5"/>
      <circle cx="30" cy="20" r="6" fill="#55555f"/>` + caption(c.label || 'BTN', 30, 52);
  } else if (c.type === 'ONE') {
    inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="9"/>
      <text class="pindigit hi" x="20" y="26"${ctr(20, 20)}>1</text>` + caption('HIGH', 20, 52);
  } else if (c.type === 'CLK') {
    inner = `<rect class="body" x="0" y="0" width="60" height="40" rx="9"/>
      <path d="M10,27 H19 V13 H29 V27 H39 V13 H49" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      caption(c.label || 'CLK', 30, 52);
  } else if (c.type === 'IPIN') {
    inner = `<rect class="body pinport" x="0" y="0" width="40" height="40" rx="7"/>
      <text class="pindigit" x="20" y="26"${ctr(20, 20)}>0</text>` + caption(`▸ ${c.label || 'IN?'}`, 20, 52);
  } else if (c.type === 'OPIN') {
    inner = `<circle class="body pinport" cx="20" cy="20" r="19"/>
      <text class="pindigit" x="20" y="26"${ctr(20, 20)}>0</text>` + caption(`${c.label || 'OUT?'} ▸`, 20, 52);
  } else if (c.type === 'OUT') {
    inner = `<rect class="body" x="0" y="0" width="40" height="40" rx="10"/>
      <circle cx="20" cy="20" r="11" fill="#33333b" stroke="#4a4a54" stroke-width="1.5"/>` +
      caption(c.label || 'LED', 20, 52);
  } else if (c.type === 'SSEG') {
    const ox = 42, oy = 26, W = 36, H = 104, my = oy + H / 2;
    const seg = (d: string) => `<path d="${d}" class="seg"/>`;
    inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="9"/>
      <rect x="28" y="8" width="${g.w - 36}" height="${g.h - 16}" rx="7" fill="#141417"/>`
      + seg(`M${ox + 4},${oy} H${ox + W - 4}`) + seg(`M${ox + W},${oy + 4} V${my - 4}`)
      + seg(`M${ox + W},${my + 4} V${oy + H - 4}`) + seg(`M${ox + 4},${oy + H} H${ox + W - 4}`)
      + seg(`M${ox},${my + 4} V${oy + H - 4}`) + seg(`M${ox},${oy + 4} V${my - 4}`)
      + seg(`M${ox + 4},${my} H${ox + W - 4}`)
      + `<circle cx="${ox + W + 12}" cy="${oy + H}" r="4.5" class="seg"/>`
      + caption(c.label || '7-SEG', g.w / 2, g.h + 14);
  } else if (c.type === 'TUN') {
    inner = `<path class="body tunnelbody" d="M2,20 L18,4 H70 A8,8 0 0 1 78,12 V28 A8,8 0 0 1 70,36 H18 Z"/>
      <text class="tunnelname" x="46" y="24"${ctr(46, 20)}>${esc(c.label?.trim() || '?')}</text>` +
      caption('TUNNEL', 40, 52);
  } else if (c.type === 'COMB') {
    const n = g.ins.length;
    inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <text class="combval" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${'0'.repeat(n)}</text>` +
      caption(c.label || 'COMBINE', g.w / 2, g.h + 14);
  } else if (c.type === 'SPLIT') {
    const n = g.outs.length;
    inner = `<rect class="body" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <text class="combval" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${'0'.repeat(n)}</text>`;
    g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start"${ctr(8, p.y)}>${esc(p.name || '')}</text>`; });
    g.outs.forEach((p, i) => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end"${ctr(g.w - 8, p.y)}>2${n - 1 - i}</text>`; });
    inner += caption(c.label || 'SPLIT', g.w / 2, g.h + 14);
  } else if (isMemoryType(c.type)) {
    const edge = defaultEdgeForComp(c);
    inner = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(c.label || g.name)}</text>
      <text class="combval" x="${g.w / 2}" y="${g.h / 2 + 24}"${ctr(g.w / 2, g.h / 2 + 24)}>Q=0</text>`;
    g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start"${ctr(8, p.y)}>${esc(p.name || '')}</text>`; });
    g.outs.forEach(p => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end"${ctr(g.w - 8, p.y)}>${esc(p.name || '')}</text>`; });
    if (edge) inner += caption(`${edge} edge`, g.w / 2, g.h + 14);
  } else if (c.type === 'CHIP') {
    inner = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
      <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>
      <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}"${ctr(g.w / 2, g.h / 2)}>${esc(g.name)}</text>`;
    g.ins.forEach(p => { inner += `<text class="pinname" x="8" y="${p.y + 3}" text-anchor="start"${ctr(8, p.y)}>${esc(p.name || '')}</text>`; });
    g.outs.forEach(p => { inner += `<text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end"${ctr(g.w - 8, p.y)}>${esc(p.name || '')}</text>`; });
    if (c.edge) inner += caption(`${c.edge} edge`, g.w / 2, g.h + 14);
  }

  const core = stubs + inner + pins;
  const rotated = rot ? `<g transform="${rotTransform(rot, g.w, g.h)}">${core}</g>` : core;
  return `<g class="comp" transform="translate(${c.x},${c.y})">${rotated}</g>`;
}

/* Render a full circuit (a chip's internals, or any board) statically. */
export function chipInternalsSVG(src: { comps: Comp[]; wires: Wire[] }, lib: ChipLib): string {
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
    let d: string;
    if (w.via?.length) {
      for (const v of w.via) grow(v.x, v.y);
      d = `M${a.x},${a.y} ` + w.via.map(v => `L${v.x},${v.y}`).join(' ') + ` L${b.x},${b.y}`;
    } else {
      d = wirePath(a.x, a.y, b.x, b.y);
    }
    out += `<path class="wire${(w.bits ?? 1) > 1 ? ' bus' : ''}" d="${d}"/>`;
  }
  for (const c of comps) out += compMarkup(c, lib);

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  const pad = 14;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${out}</svg>`;
}

/* Render the abstracted chip package: body, name, and named pins. */
export function chipAbstractSVG(def: ChipDef): string {
  const g = chipGeom(def);
  let out = `<rect class="body chipbody" x="0" y="0" width="${g.w}" height="${g.h}" rx="8"/>
    <circle cx="12" cy="10" r="2.5" fill="var(--muted)"/>
    <text class="chipname" x="${g.w / 2}" y="${g.h / 2 + 4}">${esc(def.name)}</text>`;
  g.ins.forEach(p => {
    out += `<path class="stub" d="M${p.x},${p.y} L0,${p.y}"/><circle class="pin" cx="${p.x}" cy="${p.y}" r="3.6"/>
      <text class="pinname" x="8" y="${p.y + 3}" text-anchor="start">${esc(p.name || '')}</text>`;
  });
  g.outs.forEach(p => {
    out += `<path class="stub" d="M${g.w},${p.y} L${p.x},${p.y}"/><circle class="pin" cx="${p.x}" cy="${p.y}" r="3.6"/>
      <text class="pinname" x="${g.w - 8}" y="${p.y + 3}" text-anchor="end">${esc(p.name || '')}</text>`;
  });
  const vb = `-26 -8 ${g.w + 52} ${g.h + 16}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><g class="comp">${out}</g></svg>`;
}
