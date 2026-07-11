'use client';

/* Timing diagram panel — CircuitVerse-style waveform viewer docked
   above the tab bar. Two simulation modes:

   · Live — the editor records value-change points for every probed
     component (see editor.ts); this panel polls those traces and draws
     the last N milliseconds as step waveforms.
   · Fixed length — re-simulates the board from power-on over a set
     virtual time span (seconds / ms / ns, matching the clock speeds)
     and plots the result exactly, so kHz/MHz clocks resolve cleanly.

   Extras: drag the top grip to resize (up to half the screen), a
   vertical cursor line tracks the pointer, clicking drops a labelable
   marker line to annotate the plot, and the diagram exports as a PNG. */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { formatBusValue } from '@/lib/engine';
import type { EditorApi, TimingTrace } from '@/components/editor';

const ROW_H = 34;
const GUTTER = 116;
const MIN_WINDOW = 1000, MAX_WINDOW = 60000, DEF_WINDOW = 5000;
const LS_TIMING = 'latchwork.timing.v1';

const BODY_MIN = 72, BODY_DEF = 200;
/* panel body cap: half the screen, minus the header + grip chrome */
const bodyMax = () => Math.max(BODY_MIN, Math.round(window.innerHeight / 2) - 46);
const clampBodyH = (h: number) => Math.min(bodyMax(), Math.max(BODY_MIN, Math.round(h)));

/* Fixed-run length units — the natural unit tracks the clock speed:
   Hz clocks read in seconds, kHz in milliseconds, MHz in nanoseconds. */
type LenUnit = 's' | 'ms' | 'ns';
const UNIT_MS: Record<LenUnit, number> = { s: 1000, ms: 1, ns: 1e-6 };
const unitForHz = (hz: number): LenUnit => (hz >= 1e6 ? 'ns' : hz >= 1e3 ? 'ms' : 's');

interface FixedRun { traces: TimingTrace[]; duration: number; truncated: boolean; unit: LenUnit }
interface Marker { id: string; t: number; label: string }

/* pick a round grid step ≈ window/6 (1-2-5 sequence) */
function gridStep(windowMs: number): number {
  const target = windowMs / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= target) return m * pow;
  return 10 * pow;
}

const fmtTime = (ms: number) => (ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
/* fixed-run axis text in the run's own unit */
const fmtLen = (ms: number, unit: LenUnit) => {
  const v = ms / UNIT_MS[unit];
  return `${v >= 100 ? Math.round(v) : +v.toFixed(2)}${unit}`;
};

/* value of a trace at time t (the value of the last point ≤ t) */
function valueAt(tr: TimingTrace, t: number): bigint {
  let v = 0n;
  for (const p of tr.pts) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

const mid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export default function TimingPanel({ api, onClose }: {
  api: () => EditorApi;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [, setTick] = useState(0);
  const [mode, setMode] = useState<'live' | 'fixed'>('live');
  const [paused, setPaused] = useState(false);
  const [windowMs, setWindowMs] = useState(DEF_WINDOW);
  const [bodyH, setBodyH] = useState(BODY_DEF);
  const [lenDraft, setLenDraft] = useState('');
  const [lenUnit, setLenUnit] = useState<LenUnit>('s');
  const [run, setRun] = useState<FixedRun | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [editing, setEditing] = useState<{ id: string; left: number } | null>(null);
  const [markerDraft, setMarkerDraft] = useState('');
  const [cursorX, setCursorX] = useState<number | null>(null);
  const frozenAt = useRef(0);

  useEffect(() => {
    if (paused || mode !== 'live') return;
    const t = window.setInterval(() => setTick(v => v + 1), 100);
    return () => window.clearInterval(t);
  }, [paused, mode]);

  useEffect(() => () => { api().setTimingPaused(false); }, [api]);

  /* restore the saved panel height; keep the plot width fresh on resizes */
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(LS_TIMING) || 'null');
      if (s && typeof s.h === 'number') setBodyH(clampBodyH(s.h));
    } catch {}
    const onR = () => setTick(v => v + 1);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  useEffect(() => { setTick(v => v + 1); }, [mode]);

  /* first switch into fixed mode: seed length ≈ 10 periods of the
     fastest clock, in that clock's natural unit */
  const switchMode = (m: 'live' | 'fixed') => {
    if (m === mode) return;
    setMode(m);
    setMarkers([]);
    setEditing(null);
    if (m === 'fixed' && !lenDraft) {
      const hz = api().maxClockHz();
      if (hz) {
        const unit = unitForHz(hz);
        const ms = (10 * 1000) / hz;
        setLenUnit(unit);
        setLenDraft(String(+((ms / UNIT_MS[unit])).toFixed(2)));
      } else {
        setLenUnit('s');
        setLenDraft('1');
      }
    }
  };

  const togglePause = () => {
    const next = !paused;
    if (next) frozenAt.current = Date.now();
    api().setTimingPaused(next);
    setPaused(next);
  };

  const runFixed = () => {
    const v = parseFloat(lenDraft);
    if (!isFinite(v) || v <= 0) return;
    const res = api().runFixedSim(v * UNIT_MS[lenUnit]);
    setRun({ ...res, unit: lenUnit });
    setMarkers([]);
    setEditing(null);
  };

  /* drag the grip to resize the panel — capped at half the screen */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = bodyH;
    let h = startH;
    const move = (ev: PointerEvent) => {
      h = clampBodyH(startH + (startY - ev.clientY));
      setBodyH(h);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(LS_TIMING, JSON.stringify({ h })); } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ── the plotted window ── */
  const live = mode === 'live';
  const traces = live ? api().getTiming().traces : (run?.traces ?? []);
  const now = paused ? frozenAt.current : Date.now();
  const t1 = live ? now : (run?.duration ?? 1);
  const t0 = live ? now - windowMs : 0;
  const span = Math.max(1e-9, t1 - t0);

  const width = wrapRef.current?.clientWidth ?? 800;
  const plotW = Math.max(60, width - GUTTER - 12);
  const x = (t: number) => GUTTER + ((t - t0) / span) * plotW;
  const tAt = (px: number) => t0 + ((px - GUTTER) / plotW) * span;
  const height = Math.max(1, traces.length) * ROW_H + 22;
  const axisLabel = (t: number) => (live ? `−${fmtTime(now - t)}` : fmtLen(t, run?.unit ?? lenUnit));

  const rows = traces.map((tr, i) => {
    const yTop = i * ROW_H + 8, yBot = (i + 1) * ROW_H - 8;
    const yMid = (yTop + yBot) / 2;
    /* change points inside the window, plus the value carried into it */
    const startV = valueAt(tr, t0);
    const inWin = tr.pts.filter(p => p.t > t0 && p.t <= t1);

    let wave: React.ReactNode;
    if (tr.bits <= 1) {
      const y = (v: bigint) => (v ? yTop : yBot);
      let d = `M${GUTTER},${y(startV)}`;
      let cur = startV;
      for (const p of inWin) {
        d += ` H${x(p.t).toFixed(1)} V${y(p.v)}`;
        cur = p.v;
      }
      d += ` H${GUTTER + plotW}`;
      wave = <path className={'tw-line' + (cur ? ' hi' : '')} d={d} />;
    } else {
      /* bus: segments between change points, labeled when they fit */
      const cuts = [t0, ...inWin.map(p => p.t), t1];
      const segs: React.ReactNode[] = [];
      let v = startV;
      for (let s = 0; s + 1 < cuts.length; s++) {
        if (s > 0) v = inWin[s - 1].v;
        const xa = x(cuts[s]), xb = x(cuts[s + 1]);
        const label = formatBusValue(v, tr.bits);
        segs.push(
          <g key={s}>
            <path className="tw-bus" d={`M${xa.toFixed(1)},${yTop} H${xb.toFixed(1)} M${xa.toFixed(1)},${yBot} H${xb.toFixed(1)}`} />
            {s > 0 && <path className="tw-bus" d={`M${(xa - 3).toFixed(1)},${yMid} L${xa.toFixed(1)},${yTop} M${(xa - 3).toFixed(1)},${yMid} L${xa.toFixed(1)},${yBot} M${(xa + 3).toFixed(1)},${yMid} L${xa.toFixed(1)},${yTop} M${(xa + 3).toFixed(1)},${yMid} L${xa.toFixed(1)},${yBot}`} />}
            {xb - xa > label.length * 7 + 10 && (
              <text className="tw-busval mono" x={(xa + xb) / 2} y={yMid + 3.5} textAnchor="middle">{label}</text>
            )}
          </g>,
        );
      }
      wave = <>{segs}</>;
    }

    return (
      <g key={tr.id}>
        {i > 0 && <line className="tw-rowsep" x1={0} x2={GUTTER + plotW} y1={i * ROW_H} y2={i * ROW_H} />}
        <text className="tw-name ellip" x={10} y={yMid + 4}>{tr.name.slice(0, 14)}</text>
        {tr.bits > 1 && <text className="tw-bits mono" x={10} y={yMid + 15}>{tr.bits}b</text>}
        {wave}
      </g>
    );
  });

  /* time grid */
  const step = gridStep(span);
  const gridLines: React.ReactNode[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1 + step * 1e-6; t += step) {
    const gx = x(t);
    gridLines.push(
      <g key={t}>
        <line className="tw-grid" x1={gx} x2={gx} y1={0} y2={height - 20} />
        <text className="tw-gridlabel mono" x={gx} y={height - 6} textAnchor="middle">
          {axisLabel(t)}
        </text>
      </g>,
    );
  }

  /* ── cursor line + annotation markers ── */
  const onPlotMove = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    setCursorX(px >= GUTTER && px <= GUTTER + plotW ? px : null);
  };

  const openMarkerEditor = (m: Marker) => {
    setEditing({ id: m.id, left: Math.max(0, Math.min(x(m.t) + 6, width - 200)) });
    setMarkerDraft(m.label);
  };

  const onPlotClick = (e: React.MouseEvent) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !traces.length) return;
    const hit = (e.target as Element).closest?.('[data-marker]');
    if (hit) {
      const m = markers.find(m => m.id === (hit as SVGElement).dataset.marker);
      if (m) openMarkerEditor(m);
      return;
    }
    const px = e.clientX - r.left;
    if (px < GUTTER || px > GUTTER + plotW) return;
    const m: Marker = { id: mid(), t: tAt(px), label: '' };
    setMarkers(ms => [...ms, m]);
    openMarkerEditor(m);
  };

  const commitMarker = () => {
    if (!editing) return;
    setMarkers(ms => ms.map(m => (m.id === editing.id ? { ...m, label: markerDraft.trim().slice(0, 40) } : m)));
    setEditing(null);
  };
  const deleteMarker = () => {
    if (!editing) return;
    setMarkers(ms => ms.filter(m => m.id !== editing.id));
    setEditing(null);
  };

  const markerNodes = markers.filter(m => m.t >= t0 && m.t <= t1).map(m => {
    const mx = x(m.t);
    return (
      <g key={m.id}>
        <line className="tw-marker" x1={mx} x2={mx} y1={0} y2={height - 20} />
        <line className="tw-markerhit" data-marker={m.id} x1={mx} x2={mx} y1={0} y2={height - 20} />
        <text className={'tw-markerlabel mono' + (m.label ? '' : ' unset')} data-marker={m.id}
          x={mx + 4} y={10}>{m.label || axisLabel(m.t)}</text>
      </g>
    );
  });

  const cursorNode = cursorX != null && traces.length > 0 && (
    <g pointerEvents="none">
      <line className="tw-cursor" x1={cursorX} x2={cursorX} y1={0} y2={height - 20} />
      <text className="tw-cursorlabel mono" x={cursorX + 4} y={height - 26}
        textAnchor={cursorX > GUTTER + plotW - 70 ? 'end' : 'start'}>
        {axisLabel(tAt(cursorX))}
      </text>
    </g>
  );

  /* ── PNG export: clone the SVG, inline its styles, rasterize 2× ── */
  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(height));
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fb: string) => (css.getPropertyValue(name).trim() || fb);
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
      .mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
      .tw-line{fill:none;stroke:${v('--hi', '#30d158')};stroke-width:1.8;stroke-linejoin:round}
      .tw-bus{fill:none;stroke:${v('--accent', '#0a84ff')};stroke-width:1.5;stroke-linejoin:round}
      .tw-busval{fill:${v('--text', '#ececf1')};font-size:10.5px}
      .tw-name{fill:${v('--text', '#ececf1')};font-size:11.5px}
      .tw-bits{fill:${v('--muted', '#8e8e99')};font-size:9.5px}
      .tw-grid{stroke:#2c2c33;stroke-width:1}
      .tw-gridlabel{fill:#6a6a75;font-size:9px}
      .tw-rowsep{stroke:#26262c;stroke-width:1}
      .tw-gutter{stroke:${v('--panel-border', '#34343c')};stroke-width:1}
      .tw-marker{stroke:#ffd60a;stroke-width:1;stroke-dasharray:4 3}
      .tw-markerhit{stroke:transparent;stroke-width:12}
      .tw-markerlabel{fill:#ffd60a;font-size:10px}
      .tw-markerlabel.unset{opacity:.65}
      .tw-cursor,.tw-cursorlabel{display:none}
    `;
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', v('--canvas', '#1a1a1e'));
    clone.insertBefore(bg, clone.firstChild);
    clone.insertBefore(style, clone.firstChild);
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(b => {
        if (!b) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(b);
        a.download = 'latchwork-timing.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }, 'image/png');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  };

  const subText = live
    ? (traces.length
      ? `${traces.length} signal${traces.length > 1 ? 's' : ''} · last ${fmtTime(windowMs)}`
      : 'select a part and turn on “Plot in timing diagram”')
    : (run
      ? `0 – ${fmtLen(run.duration, run.unit)} · ${traces.length} signal${traces.length === 1 ? '' : 's'}${run.truncated ? ' · shortened to keep the run fast' : ''}`
      : 'set a length and press Run — probed signals re-simulate from power-on');

  return (
    <motion.div
      id="timingpanel"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      aria-label="Timing diagram"
    >
      <div className="tp-grip" role="separator" aria-orientation="horizontal"
        aria-label="Resize timing panel" title="Drag to resize — up to half the screen"
        onPointerDown={startResize}><i /></div>
      <div className="tp-head">
        <span className="tp-title">Timing diagram</span>
        <span className="tp-sub">{subText}</span>
        <div className="spacer" />
        <div className="tp-seg" role="tablist" aria-label="Timing simulation mode">
          <button role="tab" aria-selected={live} className={live ? 'on' : ''}
            title="Record signals as the canvas simulates in real time"
            onClick={() => switchMode('live')}>Live</button>
          <button role="tab" aria-selected={!live} className={!live ? 'on' : ''}
            title="Simulate a set time span virtually — exact even for kHz/MHz clocks"
            onClick={() => switchMode('fixed')}>Fixed length</button>
        </div>
        {live ? (
          <>
            <button className="tbtn" onClick={togglePause} aria-pressed={paused}
              title={paused ? 'Resume recording' : 'Pause recording'}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
            <button className="tbtn" onClick={() => { api().clearTiming(); setMarkers([]); setTick(v => v + 1); }}
              title="Wipe the recorded waveforms">Clear</button>
            <div id="zoomgrp">
              <button title="Zoom in (shorter window)" aria-label="Zoom timing in"
                onClick={() => setWindowMs(w => Math.max(MIN_WINDOW, w / 2))}>+</button>
              <div id="zoomlabel" className="mono">{fmtTime(windowMs)}</div>
              <button title="Zoom out (longer window)" aria-label="Zoom timing out"
                onClick={() => setWindowMs(w => Math.min(MAX_WINDOW, w * 2))}>−</button>
            </div>
          </>
        ) : (
          <>
            <div className="tp-len" title="Simulation length — the unit follows the clock speed: Hz → s, kHz → ms, MHz → ns">
              <input
                className="mono"
                inputMode="decimal"
                value={lenDraft}
                aria-label="Simulation length"
                onChange={e => setLenDraft(e.target.value.replace(/[^0-9.]/g, ''))}
                onKeyDown={e => { if (e.key === 'Enter') runFixed(); }}
              />
              <select value={lenUnit} aria-label="Simulation length unit"
                onChange={e => setLenUnit(e.target.value as LenUnit)}>
                <option value="s">s</option>
                <option value="ms">ms</option>
                <option value="ns">ns</option>
              </select>
            </div>
            <button className="tbtn primary" onClick={runFixed}
              title="Re-simulate the board from power-on over this span">Run</button>
            {run && (
              <button className="tbtn" onClick={() => { setRun(null); setMarkers([]); setEditing(null); }}
                title="Discard this run">Clear</button>
            )}
          </>
        )}
        <button className="tbtn" onClick={exportPng} disabled={!traces.length}
          title="Export the diagram as a PNG image">Export PNG</button>
        <button className="community-close" aria-label="Close timing diagram" onClick={onClose}>×</button>
      </div>
      <div className="tp-body" ref={wrapRef} style={{ height: bodyH }}>
        {traces.length ? (
          <svg ref={svgRef} width="100%" height={height} role="img" aria-label="Signal waveforms"
            onPointerMove={onPlotMove} onPointerLeave={() => setCursorX(null)} onClick={onPlotClick}>
            {gridLines}
            <line className="tw-gutter" x1={GUTTER - 8} x2={GUTTER - 8} y1={0} y2={height - 20} />
            {rows}
            {markerNodes}
            {cursorNode}
          </svg>
        ) : (
          <div className="tp-empty">
            {live ? (
              <>
                No signals yet. Select any component on the canvas and enable
                <b> Plot in timing diagram</b> in the sidebar — clocks, gate outputs, memory
                Q, LEDs, and buses all record here.
              </>
            ) : (
              <>
                No run yet. Enable <b>Plot in timing diagram</b> on the parts you care about,
                choose a length (e.g. 10 clock periods), and press <b>Run</b> —
                the whole span simulates instantly, even with kHz/MHz clocks.
              </>
            )}
          </div>
        )}
        {editing && (
          <div className="tw-markeredit" style={{ left: editing.left }}
            onPointerDown={e => e.stopPropagation()}>
            <input
              autoFocus
              value={markerDraft}
              maxLength={40}
              placeholder="label this marker…"
              aria-label="Marker label"
              onChange={e => setMarkerDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitMarker();
                if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={commitMarker}
            />
            <button title="Delete this marker" aria-label="Delete marker"
              onPointerDown={e => { e.preventDefault(); deleteMarker(); }}>✕</button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
