'use client';

/* Timing diagram panel — CircuitVerse-style waveform viewer docked
   above the tab bar. The editor records value-change points for every
   probed component (see editor.ts); this panel polls those traces and
   draws the last N milliseconds as step waveforms: square waves for
   1-bit signals, value boxes with hex/binary labels for buses.

   Controls: pause/resume recording, clear, zoom the time window. */

import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { formatBusValue } from '@/lib/engine';
import type { EditorApi, TimingTrace } from '@/components/editor';

const ROW_H = 34;
const GUTTER = 116;
const MIN_WINDOW = 1000, MAX_WINDOW = 60000, DEF_WINDOW = 5000;

/* pick a round grid step ≈ window/6 (1-2-5 sequence) */
function gridStep(windowMs: number): number {
  const target = windowMs / 6;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= target) return m * pow;
  return 10 * pow;
}

const fmtTime = (ms: number) => (ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/* value of a trace at time t (the value of the last point ≤ t) */
function valueAt(tr: TimingTrace, t: number): bigint {
  let v = 0n;
  for (const p of tr.pts) {
    if (p.t > t) break;
    v = p.v;
  }
  return v;
}

export default function TimingPanel({ api, onClose }: {
  api: () => EditorApi;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [windowMs, setWindowMs] = useState(DEF_WINDOW);
  const frozenAt = useRef(0);

  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setTick(v => v + 1), 100);
    return () => window.clearInterval(t);
  }, [paused]);

  useEffect(() => () => { api().setTimingPaused(false); }, [api]);

  const togglePause = () => {
    const next = !paused;
    if (next) frozenAt.current = Date.now();
    api().setTimingPaused(next);
    setPaused(next);
  };

  const { traces } = api().getTiming();
  const now = paused ? frozenAt.current : Date.now();
  const t0 = now - windowMs;

  const width = wrapRef.current?.clientWidth ?? 800;
  const plotW = Math.max(60, width - GUTTER - 12);
  const x = (t: number) => GUTTER + ((t - t0) / windowMs) * plotW;
  const height = Math.max(1, traces.length) * ROW_H + 22;

  const rows = traces.map((tr, i) => {
    const yTop = i * ROW_H + 8, yBot = (i + 1) * ROW_H - 8;
    const yMid = (yTop + yBot) / 2;
    /* change points inside the window, plus the value carried into it */
    const startV = valueAt(tr, t0);
    const inWin = tr.pts.filter(p => p.t > t0 && p.t <= now);

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
      const cuts = [t0, ...inWin.map(p => p.t), now];
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
  const step = gridStep(windowMs);
  const gridLines: React.ReactNode[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= now; t += step) {
    const gx = x(t);
    gridLines.push(
      <g key={t}>
        <line className="tw-grid" x1={gx} x2={gx} y1={0} y2={height - 20} />
        <text className="tw-gridlabel mono" x={gx} y={height - 6} textAnchor="middle">
          −{fmtTime(now - t)}
        </text>
      </g>,
    );
  }

  return (
    <motion.div
      id="timingpanel"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      aria-label="Timing diagram"
    >
      <div className="tp-head">
        <span className="tp-title">Timing diagram</span>
        <span className="tp-sub">
          {traces.length
            ? `${traces.length} signal${traces.length > 1 ? 's' : ''} · last ${fmtTime(windowMs)}`
            : 'select a part and turn on “Plot in timing diagram”'}
        </span>
        <div className="spacer" />
        <button className="tbtn" onClick={togglePause} aria-pressed={paused}
          title={paused ? 'Resume recording' : 'Pause recording'}>{paused ? '▶ Resume' : '❚❚ Pause'}</button>
        <button className="tbtn" onClick={() => { api().clearTiming(); setTick(v => v + 1); }}
          title="Wipe the recorded waveforms">Clear</button>
        <div id="zoomgrp">
          <button title="Zoom in (shorter window)" aria-label="Zoom timing in"
            onClick={() => setWindowMs(w => Math.max(MIN_WINDOW, w / 2))}>+</button>
          <div id="zoomlabel" className="mono">{fmtTime(windowMs)}</div>
          <button title="Zoom out (longer window)" aria-label="Zoom timing out"
            onClick={() => setWindowMs(w => Math.min(MAX_WINDOW, w * 2))}>−</button>
        </div>
        <button className="community-close" aria-label="Close timing diagram" onClick={onClose}>×</button>
      </div>
      <div className="tp-body" ref={wrapRef}>
        {traces.length ? (
          <svg width="100%" height={height} role="img" aria-label="Signal waveforms">
            {gridLines}
            <line className="tw-gutter" x1={GUTTER - 8} x2={GUTTER - 8} y1={0} y2={height - 20} />
            {rows}
          </svg>
        ) : (
          <div className="tp-empty">
            No signals yet. Select any component on the canvas and enable
            <b> Plot in timing diagram</b> in the sidebar — clocks, gate outputs, memory
            Q, LEDs, and buses all record here.
          </div>
        )}
      </div>
    </motion.div>
  );
}
