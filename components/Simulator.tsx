'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Board, ChipDef, ChipLib, CompType, PALETTE_ORDER, getGeom,
  makeChipDef, validateChipSource, chipUsedBy,
} from '@/lib/engine';
import { createEditor, EditorApi, SelInfo, PlacingInfo } from '@/components/editor';

const LS_BOARD = 'latchwork.board.v1';
const LS_CHIPS = 'latchwork.chips.v1';

export interface SimUser { id?: string | null; name?: string | null; email?: string | null }

/* Starter circuit: SR latch built from NANDs — press SET / RESET
   buttons and watch it remember. Shows off persistent state. */
function seedBoard(): Board {
  const id = (n: string) => 'seed_' + n;
  return {
    comps: [
      { id: id('s'), type: 'BTN', x: 120, y: 120, label: 'SET' },
      { id: id('r'), type: 'BTN', x: 120, y: 280, label: 'RESET' },
      { id: id('n1'), type: 'NAND', x: 360, y: 140 },
      { id: id('n2'), type: 'NAND', x: 360, y: 260 },
      { id: id('inv1'), type: 'NOT', x: 240, y: 140 },
      { id: id('inv2'), type: 'NOT', x: 240, y: 260 },
      { id: id('q'), type: 'OUT', x: 560, y: 140, label: 'Q' },
      { id: id('qn'), type: 'OUT', x: 560, y: 260, label: 'Q̄' },
    ],
    wires: [
      { id: id('w1'), from: { comp: id('s'), pin: 0 }, to: { comp: id('inv1'), pin: 0 } },
      { id: id('w2'), from: { comp: id('r'), pin: 0 }, to: { comp: id('inv2'), pin: 0 } },
      { id: id('w3'), from: { comp: id('inv1'), pin: 0 }, to: { comp: id('n1'), pin: 0 } },
      { id: id('w4'), from: { comp: id('inv2'), pin: 0 }, to: { comp: id('n2'), pin: 1 } },
      { id: id('w5'), from: { comp: id('n2'), pin: 0 }, to: { comp: id('n1'), pin: 1 } },
      { id: id('w6'), from: { comp: id('n1'), pin: 0 }, to: { comp: id('n2'), pin: 0 } },
      { id: id('w7'), from: { comp: id('n1'), pin: 0 }, to: { comp: id('q'), pin: 0 } },
      { id: id('w8'), from: { comp: id('n2'), pin: 0 }, to: { comp: id('qn'), pin: 0 } },
    ],
  };
}

/* Tiny static icons for the palette */
function PalIcon({ type, chip }: { type: CompType; chip?: ChipDef }) {
  const g = getGeom({ type, chipId: chip?.id }, chip ? { [chip.id]: chip } : {});
  const stroke = 'var(--body-stroke)', fill = 'var(--body-fill)';
  const isGate = ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR'].includes(type);
  let body: React.ReactNode;
  switch (type) {
    case 'AND': body = <path d="M4,-8 H30 C52,-8 60,4 60,20 C60,36 52,48 30,48 H4 Z" fill={fill} stroke={stroke} strokeWidth="1.5" />; break;
    case 'NAND': body = <><path d="M4,-8 H28 C48,-8 56,4 56,20 C56,36 48,48 28,48 H4 Z" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="60" cy="20" r="4" fill={fill} stroke={stroke} strokeWidth="1.5" /></>; break;
    case 'OR': body = <path d="M3,-8 H22 C42,-8 55,4 60,20 C55,36 42,48 22,48 H3 C13,32 13,8 3,-8 Z" fill={fill} stroke={stroke} strokeWidth="1.5" />; break;
    case 'NOR': body = <><path d="M3,-8 H20 C38,-8 50,4 55,20 C50,36 38,48 20,48 H3 C13,32 13,8 3,-8 Z" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="59" cy="20" r="4" fill={fill} stroke={stroke} strokeWidth="1.5" /></>; break;
    case 'XOR': body = <><path d="M9,-8 H26 C45,-8 55,4 60,20 C55,36 45,48 26,48 H9 C19,32 19,8 9,-8 Z" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M2,-8 C12,8 12,32 2,48" fill="none" stroke={stroke} strokeWidth="1.5" /></>; break;
    case 'NOT': body = <><path d="M6,4 L6,36 L52,20 Z" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="56" cy="20" r="4" fill={fill} stroke={stroke} strokeWidth="1.5" /></>; break;
    case 'IN': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><rect x="11" y="11" width="38" height="18" rx="9" fill="var(--hi)" /><circle cx="40" cy="20" r="7" fill="#f5f5f7" /></>; break;
    case 'BTN': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="30" cy="20" r="11" fill="#3a3a44" stroke={stroke} strokeWidth="1.5" /><circle cx="30" cy="20" r="6" fill="#55555f" /></>; break;
    case 'ONE': body = <><rect x="0" y="0" width="40" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--hi)" fontSize="17" fontWeight="700" fontFamily="ui-monospace,Menlo,monospace">1</text></>; break;
    case 'CLK': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M10,27 H19 V13 H29 V27 H39 V13 H49" fill="none" stroke="var(--hi)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></>; break;
    case 'OUT': body = <><rect x="0" y="0" width="40" height="40" rx="10" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="20" cy="20" r="11" fill="var(--led-on)" stroke="#ff6b61" strokeWidth="1.5" /></>; break;
    case 'IPIN': body = <><rect x="0" y="0" width="40" height="40" rx="7" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'OPIN': body = <><circle cx="20" cy="20" r="19" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'CHIP': body = <><rect x="0" y="0" width={g.w} height={g.h} rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="12" cy="10" r="2.5" fill="var(--muted)" /></>; break;
  }
  const yMin = isGate ? -10 : -2;
  const w = g.w + 8, h = Math.max(g.h, 40) + (isGate ? 22 : 4);
  const scale = Math.min(38 / w, 30 / h, 0.62);
  return (
    <svg width={w * scale} height={h * scale} viewBox={`-4 ${yMin} ${w} ${h}`} style={{ pointerEvents: 'none', flexShrink: 0 }}>
      {body}
    </svg>
  );
}

export default function Simulator({ user }: { user: SimUser | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const apiRef = useRef<EditorApi | null>(null);
  const chipsRef = useRef<ChipLib>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chips, setChipsState] = useState<ChipDef[]>([]);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [freqDraft, setFreqDraft] = useState('');
  const [armed, setArmed] = useState<PlacingInfo | null>(null);
  const [counts, setCounts] = useState({ parts: 0, wires: 0 });
  const [zoom, setZoom] = useState(100);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chipName, setChipName] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const setChips = useCallback((list: ChipDef[], persist = true) => {
    chipsRef.current = Object.fromEntries(list.map(c => [c.id, c]));
    setChipsState(list);
    if (!persist) return;
    try { localStorage.setItem(LS_CHIPS, JSON.stringify(list)); } catch {}
    if (user) {
      fetch('/api/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(list),
      }).catch(() => {});
    }
  }, [user]);

  /* ── mount: editor, then chips, then board ── */
  useEffect(() => {
    const ed = createEditor(svgRef.current!, {
      getLib: () => chipsRef.current,
      onSelect: info => {
        setSel(info);
        setLabelDraft(info?.label ?? '');
        setFreqDraft(info?.freq != null ? String(info.freq) : '');
      },
      onCounts: setCounts,
      onZoom: setZoom,
      onPlacing: setArmed,
      onBoardChange: () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          try { localStorage.setItem(LS_BOARD, JSON.stringify(ed.getBoard())); } catch {}
        }, 400);
      },
    });
    apiRef.current = ed;

    let local: ChipDef[] = [];
    try { local = JSON.parse(localStorage.getItem(LS_CHIPS) || '[]'); } catch {}
    setChips(local, false);
    chipsRef.current = Object.fromEntries(local.map(c => [c.id, c]));

    const restoreBoard = () => {
      try {
        const saved = localStorage.getItem(LS_BOARD);
        ed.setBoard(saved ? JSON.parse(saved) : seedBoard());
      } catch { ed.setBoard(seedBoard()); }
    };

    if (user) {
      fetch('/api/chips')
        .then(r => (r.ok ? r.json() : []))
        .then((remote: ChipDef[]) => {
          const byId = new Map(local.map(c => [c.id, c]));
          for (const c of remote || []) if (!byId.has(c.id)) byId.set(c.id, c);
          const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
          setChips(merged);
          restoreBoard();
        })
        .catch(restoreBoard);
    } else {
      restoreBoard();
    }

    return () => ed.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── actions ── */
  const openSaveChip = () => {
    const board = apiRef.current!.getBoard();
    const v = validateChipSource(board);
    if (!v.ok) { notify(v.reason!); return; }
    setChipName('');
    setDialogOpen(true);
  };

  const confirmSaveChip = () => {
    const name = chipName.trim();
    if (!name) return;
    const def = makeChipDef(name, apiRef.current!.getBoard());
    setChips([...chips, def]);
    setDialogOpen(false);
    notify(`Saved “${def.name}” — it’s in your palette under My chips.`);
  };

  const deleteChip = (def: ChipDef) => {
    const usedBy = chipUsedBy(def.id, chipsRef.current);
    if (usedBy) { notify(`Can’t delete “${def.name}” — it’s used inside “${usedBy}”.`); return; }
    apiRef.current!.removeChipInstances(def.id);
    setChips(chips.filter(c => c.id !== def.id));
    notify(`Deleted “${def.name}”.`);
  };

  const onLabelChange = (v: string) => {
    setLabelDraft(v);
    if (sel) apiRef.current!.setLabel(sel.id, v);
  };

  const onFreqChange = (v: string) => {
    setFreqDraft(v);
    const hz = parseFloat(v);
    if (sel && isFinite(hz) && hz > 0) apiRef.current!.setFreq(sel.id, hz);
  };

  const clearBoard = () => {
    apiRef.current!.clear();
    try { localStorage.setItem(LS_BOARD, JSON.stringify({ comps: [], wires: [] })); } catch {}
  };

  const api = () => apiRef.current!;

  /* ── render ── */
  return (
    <div id="app">
      <div id="titlebar">
        <div className="lights" aria-hidden="true"><span className="r" /><span className="y" /><span className="g" /></div>
        <div id="appname">Latchwork<em>digital logic workbench</em></div>
        <div className="spacer" />

        {sel?.kind === 'multi' && (
          <div id="selcount" className="mono">{sel.count} parts</div>
        )}

        {sel?.kind === 'comp' && sel.labelable && (
          <input
            className="labelinput mono"
            value={labelDraft}
            placeholder="name…"
            maxLength={12}
            aria-label="Component name"
            onChange={e => onLabelChange(e.target.value)}
          />
        )}

        {sel?.kind === 'comp' && sel.nIns != null && (
          <div id="ningrp" title="Number of inputs">
            <span>inputs</span>
            {[2, 3, 4].map(n => (
              <button
                key={n}
                className={sel.nIns === n ? 'on' : ''}
                aria-pressed={sel.nIns === n}
                onClick={() => api().setNumInputs(sel.id, n)}
              >{n}</button>
            ))}
          </div>
        )}

        {sel?.kind === 'comp' && sel.type === 'CLK' && (
          <div id="freqgrp" title="Clock frequency">
            <input
              className="mono"
              type="number"
              min={0.1}
              max={20}
              step={0.5}
              value={freqDraft}
              aria-label="Clock frequency in hertz"
              onChange={e => onFreqChange(e.target.value)}
            />
            <span>Hz</span>
          </div>
        )}

        <div id="livedot"><i />Live</div>
        <div id="zoomgrp">
          <button onClick={() => api().zoomOut()} title="Zoom out" aria-label="Zoom out">−</button>
          <div id="zoomlabel" className="mono">{zoom}%</div>
          <button onClick={() => api().zoomIn()} title="Zoom in" aria-label="Zoom in">+</button>
        </div>
        <button className="tbtn" onClick={() => api().resetView()}>Reset view</button>
        <button className="tbtn" onClick={() => api().powerCycle()} title="Zero every signal and latch, like flipping the power">Power cycle</button>
        <button className="tbtn" disabled={!sel} onClick={() => api().deleteSelection()}>Delete</button>
        <button className="tbtn danger" onClick={clearBoard}>Clear</button>
        <button className="tbtn primary" onClick={openSaveChip}>Save as chip</button>
        {user ? <a className="tbtn ghostbtn" href="/auth/logout" title={user.email ?? ''}>{user.name?.split(' ')[0] ?? 'Account'} · Sign out</a> : <a className="tbtn ghostbtn" href="/auth/login">Sign in</a>}
      </div>

      <div id="main">
        <nav id="palette" aria-label="Component palette">
          {PALETTE_ORDER.map(([head, types]) => (
            <div key={head}>
              <div className="pal-head">{head}</div>
              {types.map(t => {
                const g = getGeom({ type: t }, {});
                const isArmed = armed?.type === t && !armed?.chipId;
                return (
                  <div key={t} className={'pal-item' + (isArmed ? ' armed' : '')}
                    title="Click, then stamp copies on the grid — esc stops"
                    onPointerDown={e => { e.preventDefault(); api().beginPlace(t); }}>
                    <PalIcon type={t} />
                    <div><div className="nm">{g.name}</div><div className="sub">{g.sub}</div></div>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="pal-head">My chips</div>
          {chips.length === 0 && (
            <div className="pal-empty">
              Build a circuit with <b>Input</b> and <b>Output pins</b>, then <b>Save as chip</b> to package it
              here — like a D flip-flop you can reuse anywhere.
            </div>
          )}
          {chips.map(def => (
            <div key={def.id} className={'pal-item chip' + (armed?.chipId === def.id ? ' armed' : '')}
              title="Click, then stamp copies on the grid — esc stops"
              onPointerDown={e => {
                if ((e.target as HTMLElement).closest('.chipdel')) return;
                e.preventDefault(); api().beginPlace('CHIP', def.id);
              }}>
              <PalIcon type="CHIP" chip={def} />
              <div style={{ minWidth: 0 }}>
                <div className="nm ellip">{def.name}</div>
                <div className="sub">{def.inputs.length} in · {def.outputs.length} out</div>
              </div>
              <button className="chipdel" aria-label={`Delete ${def.name}`} title="Delete chip"
                onClick={() => deleteChip(def)}>×</button>
            </div>
          ))}
        </nav>

        <div id="canvaswrap">
          <svg id="board" ref={svgRef} xmlns="http://www.w3.org/2000/svg">
            <defs>
              {/* x/y offset aligns the dots to the (20k, 20k) lattice that
                  components snap to — every pin sits exactly on a dot */}
              <pattern id="dots" width="20" height="20" x="10" y="10" patternUnits="userSpaceOnUse">
                <circle cx="10" cy="10" r="1.1" fill="var(--dot)" />
              </pattern>
              {/* NOTE: wires glow via a CSS drop-shadow, not an SVG filter —
                  filters with objectBoundingBox units make perfectly straight
                  (zero-area bbox) lines vanish entirely */}
              <filter id="ledglow" x="-120%" y="-120%" width="340%" height="340%">
                <feGaussianBlur stdDeviation="6" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <g id="world" />
          </svg>
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
      </div>

      <div id="statusbar">
        <span className="mono"><b>{counts.parts}</b> parts · <b>{counts.wires}</b> wires · <b>{chips.length}</b> chips</span>
        <span>Click a <b>pin</b>, click grid dots to route, finish on a pin</span>
        <span>Drag empty space to <b>select</b> · <kbd>⌘/⌃</kbd><kbd>C</kbd>/<kbd>V</kbd> copy &amp; paste</span>
        <span><kbd>⌫</kbd> delete · <kbd>esc</kbd> cancel · scroll to pan · <kbd>ctrl</kbd>+scroll to zoom · <kbd>space</kbd>+drag or middle-drag to pan</span>
        <span>{user ? 'Chips sync to your account' : 'Chips save to this browser — sign in to sync'}</span>
      </div>

      {dialogOpen && (
        <div className="overlay" onPointerDown={e => { if (e.target === e.currentTarget) setDialogOpen(false); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Save as chip">
            <h2>Save as chip</h2>
            <p>
              The whole board becomes one reusable part. Its <b>Input pins</b> become the chip&apos;s inputs and
              its <b>Output pins</b> become its outputs, top to bottom. Their labels become the pin names.
            </p>
            <input
              autoFocus
              value={chipName}
              maxLength={24}
              placeholder="Chip name — e.g. D Flip-Flop"
              onChange={e => setChipName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSaveChip(); if (e.key === 'Escape') setDialogOpen(false); }}
            />
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button className="tbtn primary" disabled={!chipName.trim()} onClick={confirmSaveChip}>Save chip</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
