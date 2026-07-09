'use client';

/* Peek inside a placed chip — a popup (in the style of the Save-as-chip
   dialog) showing the chip's internal circuit simulating live with the
   inputs the placed instance is currently receiving, plus a package
   editor to rearrange pins, resize the body, and pick/draw its shape. */

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  ChipDef, ChipLib, ChipLayout, ChipShape, ChipPackage, Vec, SimState,
  defaultChipLayout,
} from '@/lib/engine';
import { chipInternalsSVG } from '@/lib/chip-svg';
import PinLayoutEditor, { LayoutPin } from '@/components/PinLayoutEditor';

const layoutPins = (names: string[], bits?: number[]): LayoutPin[] =>
  names.map((name, i) => ({ name, bits: bits?.[i] ?? 1 }));

/* Package (pins + size + shape) draft editor with an Apply button.
   Shared by the peek popup and the chip inspector dialog. */
export function ChipPackageEditor({ def, onSave }: {
  def: ChipDef;
  onSave: (pkg: ChipPackage) => void;
}) {
  const [layout, setLayout] = useState<ChipLayout>(
    () => def.layout ?? defaultChipLayout(def.inputs.length, def.outputs.length, def.name.length));
  const [shape, setShape] = useState<ChipShape>(def.shape ?? 'rect');
  const [shapePts, setShapePts] = useState<Vec[] | undefined>(def.shapePts);
  const [dirty, setDirty] = useState(false);

  return (
    <div className="pkgedit">
      <PinLayoutEditor
        inputs={layoutPins(def.inputs, def.inputBits)}
        outputs={layoutPins(def.outputs, def.outputBits)}
        name={def.name}
        layout={layout}
        onChange={l => { setLayout(l); setDirty(true); }}
        shape={shape}
        shapePts={shapePts}
        onShapeChange={(s, pts) => { setShape(s); if (pts) setShapePts(pts); setDirty(true); }}
      />
      <div className="pkgedit-actions">
        <button className="tbtn" onClick={() => {
          setLayout(defaultChipLayout(def.inputs.length, def.outputs.length, def.name.length));
          setShape('rect');
          setShapePts(undefined);
          setDirty(true);
        }}>Reset layout</button>
        <div className="spacer" />
        <button className="tbtn primary" disabled={!dirty}
          title="Apply this package to the chip — every placed copy updates"
          onClick={() => { onSave({ layout, shape, shapePts }); setDirty(false); }}>
          Apply to chip
        </button>
      </div>
    </div>
  );
}

export default function PeekDialog({ compId, def, lib, getState, onSavePackage, onEditInternals, onClose }: {
  compId: string;
  def: ChipDef;
  lib: ChipLib;
  getState: (compId: string) => SimState | null;
  onSavePackage: (pkg: ChipPackage) => void;
  onEditInternals: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'live' | 'package'>('live');
  const [tick, setTick] = useState(0);

  // the editor mutates the instance's SimState in place — poll it so the
  // peek keeps up with switches, clocks, and everything upstream
  useEffect(() => {
    if (tab !== 'live') return;
    const t = window.setInterval(() => setTick(v => v + 1), 120);
    return () => window.clearInterval(t);
  }, [tab]);

  const state = getState(compId);
  const svg = useMemo(
    () => chipInternalsSVG({ comps: def.comps, wires: def.wires }, lib, state ?? undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [def, lib, state, tick],
  );

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="dialog peekdialog" role="dialog" aria-modal="true"
        aria-label={`Peek inside ${def.name}`}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ type: 'spring', duration: 0.34, bounce: 0.18 }}
      >
        <div className="inspect-head">
          <h2>{def.name}</h2>
          <span className="community-card-meta">
            {def.inputs.length} in · {def.outputs.length} out · live
          </span>
          <div className="spacer" />
          <button className="community-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className="peektabs" role="tablist">
          <button role="tab" aria-selected={tab === 'live'}
            className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Live internals</button>
          <button role="tab" aria-selected={tab === 'package'}
            className={tab === 'package' ? 'on' : ''} onClick={() => setTab('package')}>Package &amp; pins</button>
        </div>

        <div className="peekbody">
          {tab === 'live' ? (
            <>
              <p className="peeknote">
                Watching this placed copy respond to the inputs wired to it on the canvas —
                lit wires and pins carry a 1. Toggle its inputs to see the logic react.
              </p>
              {!state && (
                <p className="peeknote warn">No live state yet — the instance may have been removed.</p>
              )}
              <div className="peek-live" dangerouslySetInnerHTML={{ __html: svg }} />
            </>
          ) : (
            <ChipPackageEditor def={def} onSave={onSavePackage} />
          )}
        </div>

        <div className="dialog-actions">
          <button className="tbtn" onClick={onEditInternals}
            title="Open this chip's circuit in an editor tab to rework its logic">Edit internals…</button>
          <div className="spacer" />
          <button className="tbtn primary" onClick={onClose}>Done</button>
        </div>
      </motion.div>
    </motion.div>
  );
}
