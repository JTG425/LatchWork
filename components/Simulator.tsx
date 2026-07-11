'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Board, ChipDef, ChipLib, ChipLayout, ChipPackage, ChipShape, CompType, Vec,
  PALETTE_ORDER, getGeom, chipBodyPath,
  makeChipDef, validateChipSource, chipUsedBy, migrateChipDef, chipDefContains,
  isMemoryType, isBusToolType, MAX_WIRE_BITS, MAX_GATE_INS, BINARY_VALUE_MAX_BITS, clampBits,
  chipPinSources, chipPinName, defaultChipLayout, cloneBoard, sanitizeChipDef,
  busToolLayout, bitWeightName, chipUniformBits, scaleChipDefBits, isVhdlChip,
} from '@/lib/engine';
import { GATE_DEFS, isGateType } from '@/lib/gates';
import { createEditor, EditorApi, SelInfo, PlacingInfo } from '@/components/editor';
import PinLayoutEditor, { LayoutPin } from '@/components/PinLayoutEditor';
import PeekDialog, { ChipPackageEditor } from '@/components/PeekDialog';
import CommunityDialog from '@/components/CommunityDialog';
import ChipAnalysis, { ChipPreview } from '@/components/ChipAnalysis';
import VhdlDialog from '@/components/VhdlDialog';
import TimingPanel from '@/components/TimingPanel';
import LogoMark from '@/components/Logo';

const LS_BOARD = 'latchwork.board.v1';   // legacy single-board key, migrated into tabs
const LS_CHIPS = 'latchwork.chips.v1';
const LS_TABS = 'latchwork.tabs.v1';
const LS_PAL = 'latchwork.palette.v1';   // { collapsed: {head: bool}, width: px }
const LS_FOLDERS = 'latchwork.folders.v1'; // { [name]: { color?: hex } } — keeps empty folders & colors

const PAL_MIN_W = 120, PAL_MAX_W = 420, PAL_DEF_W = 186;
const clampPalW = (w: number) => Math.min(PAL_MAX_W, Math.max(PAL_MIN_W, Math.round(w)));

/* Inspector value drafts: binary up to BINARY_VALUE_MAX_BITS, hex (no 0x prefix) beyond. */
const hexDigits = (bits: number) => Math.ceil(bits / 4);
const useHexValue = (bits: number) => bits > BINARY_VALUE_MAX_BITS;
const valDraftFor = (v: bigint, bits: number) =>
  useHexValue(bits) ? v.toString(16).toUpperCase().padStart(hexDigits(bits), '0') : v.toString(2).padStart(bits, '0');

interface FolderMeta { color?: string }
const FOLDER_COLORS = ['#0a84ff', '#30d158', '#ffd60a', '#ff9f0a', '#ff453a', '#ff375f', '#bf5af2', '#64d2ff'];
const MAX_FOLDER_NAME = 20;
const cleanFolderName = (s: string) => s.trim().slice(0, MAX_FOLDER_NAME);

export interface SimUser { id?: string | null; name?: string | null; email?: string | null }

/* One editor canvas. `chipId` marks a tab that edits a chip's internals. */
interface TabInfo { id: string; name: string; chipId?: string }
interface TabData extends TabInfo { board: Board }
const tabMeta = ({ board: _b, ...meta }: TabData): TabInfo => meta;
const newTabId = () => 'tab_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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
      ['w1', 's', 0, 'inv1', 0], ['w2', 'r', 0, 'inv2', 0],
      ['w3', 'inv1', 0, 'n1', 0], ['w4', 'inv2', 0, 'n2', 1],
      ['w5', 'n2', 0, 'n1', 1], ['w6', 'n1', 0, 'n2', 0],
      ['w7', 'n1', 0, 'q', 0], ['w8', 'n2', 0, 'qn', 0],
    ].map(([w, f, fp, t, tp]) => ({
      id: id(w as string),
      a: { comp: id(f as string), side: 'out' as const, pin: fp as number },
      b: { comp: id(t as string), side: 'in' as const, pin: tp as number },
    })),
  };
}

/* Tiny static icons for the palette */
function PalIcon({ type, chip }: { type: CompType; chip?: ChipDef }) {
  const g = getGeom({ type, chipId: chip?.id }, chip ? { [chip.id]: chip } : {});
  const stroke = 'var(--body-stroke)', fill = 'var(--body-fill)';
  const isGate = isGateType(type);
  let body: React.ReactNode;
  if (isGateType(type)) {
    // gate icons render each gate file's own artwork at the default 40px span
    const gd = GATE_DEFS[type];
    const curve = gd.backCurve?.(40);
    const bub = gd.bubble?.(40);
    body = (
      <>
        <path d={gd.body(40)} fill={fill} stroke={stroke} strokeWidth="1.5" />
        {curve && <path d={curve} fill="none" stroke={stroke} strokeWidth="1.5" />}
        {bub && <circle cx={bub.cx} cy={bub.cy} r={bub.r} fill={fill} stroke={stroke} strokeWidth="1.5" />}
      </>
    );
  } else switch (type) {
    case 'IN': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><rect x="11" y="11" width="38" height="18" rx="9" fill="var(--hi)" /><circle cx="40" cy="20" r="7" fill="#f5f5f7" /></>; break;
    case 'BTN': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="30" cy="20" r="11" fill="#3a3a44" stroke={stroke} strokeWidth="1.5" /><circle cx="30" cy="20" r="6" fill="#55555f" /></>; break;
    case 'ONE': body = <><rect x="0" y="0" width="40" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--hi)" fontSize="17" fontWeight="700" fontFamily="ui-monospace,Menlo,monospace">1</text></>; break;
    case 'VAL': body = <><rect x="0" y="0" width={g.w} height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><text x={g.w / 2} y="25" textAnchor="middle" fill="var(--hi)" fontSize="11" fontFamily="ui-monospace,Menlo,monospace">1010</text></>; break;
    case 'CLK': body = <><rect x="0" y="0" width="60" height="40" rx="9" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M10,27 H19 V13 H29 V27 H39 V13 H49" fill="none" stroke="var(--hi)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></>; break;
    case 'OUT': body = <><rect x="0" y="0" width="40" height="40" rx="10" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="20" cy="20" r="11" fill="var(--led-on)" stroke="#ff6b61" strokeWidth="1.5" /></>; break;
    case 'SSEG': body = <><rect x="0" y="0" width="100" height="160" rx="9" fill={fill} stroke={stroke} strokeWidth="2.5" /><rect x="28" y="8" width="64" height="144" rx="7" fill="#141417" /><text x="60" y="118" textAnchor="middle" fill="var(--led-on)" fontSize="96" fontFamily="ui-monospace,Menlo,monospace">8</text></>; break;
    case 'TUN': body = <><path d="M2,20 L18,4 H70 A8,8 0 0 1 78,12 V28 A8,8 0 0 1 70,36 H18 Z" fill={fill} stroke={stroke} strokeWidth="1.5" /><text x="46" y="25" textAnchor="middle" fill="var(--muted)" fontSize="13" fontFamily="ui-monospace,Menlo,monospace">T1</text></>; break;
    case 'COMB': body = <><rect x="0" y="0" width="60" height="60" rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M-8,0 H0 M-8,20 H0 M-8,40 H0 M-8,60 H0 M60,40 H70" stroke="var(--lo)" strokeWidth="2" /><text x="30" y="35" textAnchor="middle" fill="var(--hi)" fontSize="13" fontFamily="ui-monospace,Menlo,monospace">0110</text></>; break;
    case 'SPLIT': body = <><rect x="0" y="0" width="80" height="60" rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M-8,40 H0 M80,0 H90 M80,20 H90 M80,40 H90 M80,60 H90" stroke="var(--lo)" strokeWidth="2" /><text x="40" y="35" textAnchor="middle" fill="var(--hi)" fontSize="13" fontFamily="ui-monospace,Menlo,monospace">0110</text></>; break;
    case 'IPIN': body = <><rect x="0" y="0" width="40" height="40" rx="7" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'OPIN': body = <><circle cx="20" cy="20" r="19" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'CHIP': {
      const d = chipBodyPath(chip?.shape, g.w, g.h, chip?.shapePts);
      body = d
        ? <path d={d} fill={fill} stroke={stroke} strokeWidth="1.5" />
        : <><rect x="0" y="0" width={g.w} height={g.h} rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="12" cy="10" r="2.5" fill="var(--muted)" /></>;
      break;
    }
  }
  if (isMemoryType(type)) {
    body = (
      <>
        <rect x="0" y="0" width={g.w} height={g.h} rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" />
        <text x={g.w / 2} y={g.h / 2 + 5} textAnchor="middle" fill="var(--text)" fontSize="18" fontWeight="700" fontFamily="ui-monospace,Menlo,monospace">Q</text>
        {g.ins.map((p, i) => <text key={`i${i}`} x="7" y={p.y + 3} fill="var(--muted)" fontSize="9" fontFamily="ui-monospace,Menlo,monospace">{p.name}</text>)}
        {g.outs.map((p, i) => <text key={`o${i}`} x={g.w - 7} y={p.y + 3} textAnchor="end" fill="var(--muted)" fontSize="9" fontFamily="ui-monospace,Menlo,monospace">{p.name}</text>)}
      </>
    );
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

/* Small folder glyph used across the palette — takes the folder's color. */
function FolderIcon({ color, size = 13 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M1.5 12.6 V4.2 A1.7 1.7 0 0 1 3.2 2.5 H6.1 L7.8 4.3 H12.8 A1.7 1.7 0 0 1 14.5 6 V12.6 A1.7 1.7 0 0 1 12.8 14.3 H3.2 A1.7 1.7 0 0 1 1.5 12.6 Z"
        fill={color ?? 'var(--muted)'}
        opacity={color ? 1 : 0.75}
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="psico" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.5 10.5 L14 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/* Animated modal shell shared by the Simulator's dialogs. */
function Modal({ children, onDismiss, className, label }: {
  children: React.ReactNode; onDismiss: () => void; className?: string; label: string;
}) {
  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onPointerDown={e => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <motion.div
        className={'dialog' + (className ? ' ' + className : '')}
        role="dialog" aria-modal="true" aria-label={label}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ type: 'spring', duration: 0.34, bounce: 0.18 }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export default function Simulator({ user, authEnabled }: { user: SimUser | null; authEnabled: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const apiRef = useRef<EditorApi | null>(null);
  const chipsRef = useRef<ChipLib>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabsRef = useRef<TabData[]>([]);
  const activeTabRef = useRef<string>('');

  const [chips, setChipsState] = useState<ChipDef[]>([]);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [freqDraft, setFreqDraft] = useState('');
  const [valDraft, setValDraft] = useState('');
  const [armed, setArmed] = useState<PlacingInfo | null>(null);
  const [wireTool, setWireTool] = useState(false);
  const [counts, setCounts] = useState({ parts: 0, wires: 0 });
  const [zoom, setZoom] = useState(100);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [chipName, setChipName] = useState('');
  const [pendingBoard, setPendingBoard] = useState<Board | null>(null);
  const [layoutIns, setLayoutIns] = useState<LayoutPin[]>([]);
  const [layoutOuts, setLayoutOuts] = useState<LayoutPin[]>([]);
  const [chipLayout, setChipLayout] = useState<ChipLayout | null>(null);
  const [chipShape, setChipShape] = useState<ChipShape>('rect');
  const [chipShapePts, setChipShapePts] = useState<Vec[] | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [inspect, setInspect] = useState<ChipDef | null>(null);
  const [editAsk, setEditAsk] = useState<ChipDef | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<ChipDef | null>(null);
  const [peek, setPeek] = useState<{ compId: string; chipId: string } | null>(null);
  const [vhdlEdit, setVhdlEdit] = useState<{ base?: ChipDef } | null>(null);
  const [timingOpen, setTimingOpen] = useState(false);
  const [busEdit, setBusEdit] = useState<{ id: string; type: 'COMB' | 'SPLIT'; nIns: number; layout: ChipLayout } | null>(null);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
  const [query, setQuery] = useState('');
  const [folderMeta, setFolderMetaState] = useState<Record<string, FolderMeta>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderRenameDraft, setFolderRenameDraft] = useState('');
  const [colorMenu, setColorMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ chip: ChipDef; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder name, '' = out of folders
  const folderMetaRef = useRef<Record<string, FolderMeta>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTab, setActiveTab] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [palWidth, setPalWidth] = useState(PAL_DEF_W);
  const collapsedRef = useRef<Record<string, boolean>>({});
  const palWidthRef = useRef(PAL_DEF_W);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistPal = () => {
    try {
      localStorage.setItem(LS_PAL, JSON.stringify({ collapsed: collapsedRef.current, width: palWidthRef.current }));
    } catch {}
  };
  const toggleGroup = (head: string) => {
    collapsedRef.current = { ...collapsedRef.current, [head]: !collapsedRef.current[head] };
    setCollapsed(collapsedRef.current);
    persistPal();
  };
  const startPalResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = palWidthRef.current;
    const move = (ev: PointerEvent) => {
      palWidthRef.current = clampPalW(startW + ev.clientX - startX);
      setPalWidth(palWidthRef.current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persistPal();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const lib: ChipLib = useMemo(() => Object.fromEntries(chips.map(c => [c.id, c])), [chips]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const setChips = useCallback((list: ChipDef[], persist = true) => {
    const clean = list.map(sanitizeChipDef);
    chipsRef.current = Object.fromEntries(clean.map(c => [c.id, c]));
    setChipsState(clean);
    if (!persist) return;
    try { localStorage.setItem(LS_CHIPS, JSON.stringify(clean)); } catch {}
    if (user) {
      fetch('/api/chips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      }).catch(() => {});
    }
  }, [user]);

  /* ── tabs ── */
  const syncActiveBoard = useCallback(() => {
    const t = tabsRef.current.find(t => t.id === activeTabRef.current);
    if (t && apiRef.current) t.board = apiRef.current.getBoard();
  }, []);

  const persistTabs = useCallback(() => {
    try {
      const tabs = tabsRef.current.map(t => ({ ...t, board: cloneBoard(t.board) }));
      localStorage.setItem(LS_TABS, JSON.stringify({ tabs, active: activeTabRef.current }));
    } catch {}
  }, []);

  const publishTabs = useCallback(() => {
    setTabs(tabsRef.current.map(tabMeta));
  }, []);

  const switchTab = useCallback((id: string) => {
    if (id === activeTabRef.current) return;
    const t = tabsRef.current.find(t => t.id === id);
    if (!t) return;
    syncActiveBoard();
    activeTabRef.current = id;
    setActiveTab(id);
    apiRef.current!.setBoard(t.board);
    persistTabs();
  }, [syncActiveBoard, persistTabs]);

  const addTab = useCallback((name?: string, board?: Board, chipId?: string) => {
    syncActiveBoard();
    const sheets = tabsRef.current.filter(t => !t.chipId).length;
    const t: TabData = {
      id: newTabId(),
      name: (name ?? `Sheet ${sheets + 1}`).slice(0, 20),
      board: board ?? { comps: [], wires: [] },
      ...(chipId ? { chipId } : {}),
    };
    tabsRef.current.push(t);
    activeTabRef.current = t.id;
    setActiveTab(t.id);
    publishTabs();
    apiRef.current!.setBoard(t.board);
    persistTabs();
  }, [syncActiveBoard, publishTabs, persistTabs]);

  const closeTab = useCallback((id: string) => {
    if (tabsRef.current.length <= 1) { notify('That’s the last tab — clear it instead.'); return; }
    const idx = tabsRef.current.findIndex(t => t.id === id);
    if (idx < 0) return;
    tabsRef.current.splice(idx, 1);
    if (activeTabRef.current === id) {
      const next = tabsRef.current[Math.max(0, idx - 1)];
      activeTabRef.current = next.id;
      setActiveTab(next.id);
      apiRef.current!.setBoard(next.board);
    }
    publishTabs();
    persistTabs();
  }, [notify, publishTabs, persistTabs]);

  const renameTab = useCallback((id: string, name: string) => {
    const t = tabsRef.current.find(t => t.id === id);
    if (t && name.trim()) t.name = name.trim().slice(0, 20);
    setRenaming(null);
    publishTabs();
    persistTabs();
  }, [publishTabs, persistTabs]);

  /* Open a chip's internals for editing in its own tab (one per chip). */
  const openChipTab = useCallback((def: ChipDef) => {
    setEditAsk(null);
    setInspect(null);
    setPeek(null);
    const existing = tabsRef.current.find(t => t.chipId === def.id);
    if (existing) { switchTab(existing.id); return; }
    addTab(def.name, cloneBoard({ comps: def.comps, wires: def.wires }), def.id);
  }, [switchTab, addTab]);

  /* VHDL chips have no circuit — "edit internals" means editing the code. */
  const askEditChip = useCallback((chipId: string) => {
    const def = chipsRef.current[chipId];
    if (!def) return;
    if (isVhdlChip(def)) { setInspect(null); setPeek(null); setVhdlEdit({ base: def }); return; }
    setEditAsk(def);
  }, []);

  /* Double-click on a placed chip → peek inside it, live (VHDL → code editor). */
  const openPeek = useCallback((compId: string, chipId: string) => {
    const def = chipsRef.current[chipId];
    if (!def) return;
    if (isVhdlChip(def)) { setVhdlEdit({ base: def }); return; }
    setPeek({ compId, chipId });
  }, []);

  /* Save (or re-save) a VHDL module as a library chip. */
  const saveVhdl = useCallback((def: ChipDef) => {
    const exists = !!chipsRef.current[def.id];
    const list = exists
      ? Object.values(chipsRef.current).map(c => (c.id === def.id ? def : c)).sort((a, b) => a.createdAt - b.createdAt)
      : [...Object.values(chipsRef.current).sort((a, b) => a.createdAt - b.createdAt), def];
    setChips(list);
    setVhdlEdit(null);
    // placed copies may have new pin widths — re-seed touching wires
    apiRef.current!.refreshWireBits();
    notify(exists
      ? `Updated “${def.name}” — every placed copy runs the new VHDL.`
      : `Saved “${def.name}” — it’s in your palette under My chips.`);
  }, [setChips, notify]);

  /* Double-click on a combiner/splitter → rearrange its pins & size. */
  const openBusEdit = useCallback((compId: string) => {
    const board = apiRef.current!.getBoard();
    const c = board.comps.find(x => x.id === compId);
    if (!c || !isBusToolType(c.type)) return;
    const n = clampBits(c.nIns ?? 4);
    setBusEdit({
      id: compId,
      type: c.type as 'COMB' | 'SPLIT',
      nIns: n,
      layout: c.layout ?? busToolLayout(c.type, n),
    });
  }, []);

  /* ── mount: editor, then chips, then tabs/boards ── */
  useEffect(() => {
    const ed = createEditor(svgRef.current!, {
      getLib: () => chipsRef.current,
      onSelect: info => {
        setSel(info);
        setLabelDraft(info?.label ?? '');
        setFreqDraft(info?.freq != null ? String(info.freq) : '');
        setValDraft(info?.val != null ? valDraftFor(info.val, info.pinBits ?? 1) : '');
      },
      onCounts: setCounts,
      onZoom: setZoom,
      onPlacing: setArmed,
      onWireTool: setWireTool,
      onChipDblClick: openPeek,
      onBusToolDblClick: openBusEdit,
      onBoardChange: () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          syncActiveBoard();
          persistTabs();
        }, 400);
      },
    });
    apiRef.current = ed;

    try {
      const p = JSON.parse(localStorage.getItem(LS_PAL) || 'null');
      if (p && typeof p.width === 'number') { palWidthRef.current = clampPalW(p.width); setPalWidth(palWidthRef.current); }
      if (p && p.collapsed && typeof p.collapsed === 'object') { collapsedRef.current = p.collapsed; setCollapsed(p.collapsed); }
    } catch {}
    try {
      const f = JSON.parse(localStorage.getItem(LS_FOLDERS) || 'null');
      if (f && typeof f === 'object' && !Array.isArray(f)) { folderMetaRef.current = f; setFolderMetaState(f); }
    } catch {}

    let local: ChipDef[] = [];
    try { local = (JSON.parse(localStorage.getItem(LS_CHIPS) || '[]') as ChipDef[]).map(migrateChipDef); } catch {}
    setChips(local, false);
    chipsRef.current = Object.fromEntries(local.map(c => [c.id, c]));

    const restoreTabs = () => {
      let data: { tabs?: TabData[]; active?: string } | null = null;
      try { data = JSON.parse(localStorage.getItem(LS_TABS) || 'null'); } catch {}
      let loaded = Array.isArray(data?.tabs)
        ? data!.tabs!.filter(t => t && typeof t.id === 'string' && t.board)
        : [];
      if (!loaded.length) {
        // migrate the old single-board save into the first tab
        let legacy: Board | null = null;
        try {
          const saved = localStorage.getItem(LS_BOARD);
          legacy = saved ? JSON.parse(saved) : null;
        } catch {}
        loaded = [{ id: newTabId(), name: 'Sheet 1', board: legacy ?? seedBoard() }];
      }
      tabsRef.current = loaded;
      const active = loaded.some(t => t.id === data?.active) ? data!.active! : loaded[0].id;
      activeTabRef.current = active;
      setActiveTab(active);
      setTabs(loaded.map(tabMeta));
      try { ed.setBoard(loaded.find(t => t.id === active)!.board); } catch { ed.setBoard(seedBoard()); }
    };

    if (user) {
      fetch('/api/chips')
        .then(r => (r.ok ? r.json() : []))
        .then((remote: ChipDef[]) => {
          const byId = new Map(local.map(c => [c.id, c]));
          for (const c of remote || []) if (!byId.has(c.id)) byId.set(c.id, migrateChipDef(c));
          const merged = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
          setChips(merged);
          restoreTabs();
        })
        .catch(restoreTabs);
    } else {
      restoreTabs();
    }

    return () => ed.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* "/" jumps to the palette search from anywhere outside a text field. */
  useEffect(() => {
    const onSlash = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onSlash);
    return () => window.removeEventListener('keydown', onSlash);
  }, []);

  /* Palette popovers (move-to-folder, folder color) close on outside click. */
  useEffect(() => {
    if (folderMenu == null && colorMenu == null) return;
    const close = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.folderpop,.colorpop,.chipfolder,.fact-color')) return;
      setFolderMenu(null);
      setColorMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [folderMenu, colorMenu]);

  /* ── actions ── */
  const activeMeta = tabs.find(t => t.id === activeTab);
  const editingChip = activeMeta?.chipId ? chips.find(c => c.id === activeMeta.chipId) : undefined;

  const openSaveChip = () => {
    const board = apiRef.current!.getBoard();
    const v = validateChipSource(board);
    if (!v.ok) { notify(v.reason!); return; }
    const { inComps, outComps } = chipPinSources(board);
    const ins = inComps.map((c, i) => ({ name: chipPinName(c, i, 'in'), bits: clampBits(c.bits ?? 1) }));
    const outs = outComps.map((c, i) => ({ name: chipPinName(c, i, 'out'), bits: clampBits(c.bits ?? 1) }));
    setPendingBoard(board);
    setLayoutIns(ins);
    setLayoutOuts(outs);
    setChipLayout(defaultChipLayout(ins.length, outs.length));
    setChipShape('rect');
    setChipShapePts(undefined);
    setChipName('');
    setDialogOpen(true);
  };

  const confirmSaveChip = () => {
    const name = chipName.trim();
    if (!name || !pendingBoard) return;
    const def = makeChipDef(name, pendingBoard, {
      layout: chipLayout ?? undefined,
      shape: chipShape,
      shapePts: chipShapePts,
    });
    setChips([...chips, def]);
    setDialogOpen(false);
    notify(`Saved “${def.name}” — it’s in your palette under My chips.`);
  };

  /* Apply the current tab's board back onto the chip it edits. */
  const updateChip = () => {
    if (!editingChip) return;
    const board = apiRef.current!.getBoard();
    const v = validateChipSource(board);
    if (!v.ok) { notify(v.reason!); return; }
    const rebuilt = makeChipDef(editingChip.name, board, {
      layout: editingChip.layout,
      shape: editingChip.shape,
      shapePts: editingChip.shapePts,
    });
    const updated: ChipDef = {
      ...rebuilt,
      id: editingChip.id,
      createdAt: editingChip.createdAt,
      ...(editingChip.folder ? { folder: editingChip.folder } : {}),
    };
    setChips(chips.map(c => (c.id === editingChip.id ? updated : c)));
    notify(`Updated “${editingChip.name}” — every placed copy now uses the new internals.`);
  };

  /* Package edits (pin layout / size / shape) from the peek & info dialogs. */
  const applyChipPackage = useCallback((chipId: string, pkg: ChipPackage): ChipDef | null => {
    const cur = chipsRef.current[chipId];
    if (!cur) return null;
    const updated: ChipDef = {
      ...cur,
      layout: pkg.layout,
      shape: pkg.shape && pkg.shape !== 'rect' ? pkg.shape : undefined,
      shapePts: pkg.shape === 'custom' ? pkg.shapePts : undefined,
    };
    setChips(Object.values(chipsRef.current).map(c => (c.id === chipId ? updated : c))
      .sort((a, b) => a.createdAt - b.createdAt));
    apiRef.current!.rerender();
    notify(`Updated the “${updated.name}” package — every placed copy uses it.`);
    return updated;
  }, [setChips, notify]);

  /* Chip-wide bit scaling from the inspector: every gate, pin, value,
     and wire inside the chip definition takes the new bus width. */
  const applyChipBits = useCallback((chipId: string, n: number) => {
    const cur = chipsRef.current[chipId];
    if (!cur) return;
    const scaled = scaleChipDefBits(cur, n, chipsRef.current);
    setChips(Object.values(chipsRef.current).map(c => (c.id === chipId ? scaled : c))
      .sort((a, b) => a.createdAt - b.createdAt));
    // wires on the canvas that touch this chip's pins pick up the new widths
    apiRef.current!.refreshWireBits();
  }, [setChips]);

  const requestDeleteChip = (def: ChipDef) => {
    const usedBy = chipUsedBy(def.id, chipsRef.current);
    if (usedBy) { notify(`Can’t delete “${def.name}” — it’s used inside “${usedBy}”.`); return; }
    setDeleteAsk(def);
  };

  const confirmDeleteChip = () => {
    if (!deleteAsk) return;
    apiRef.current!.removeChipInstances(deleteAsk.id);
    setChips(chips.filter(c => c.id !== deleteAsk.id));
    notify(`Deleted “${deleteAsk.name}”.`);
    setDeleteAsk(null);
  };

  const placeChip = (def: ChipDef) => {
    const curChipId = tabsRef.current.find(t => t.id === activeTabRef.current)?.chipId;
    if (curChipId && (def.id === curChipId || chipDefContains(def, curChipId, chipsRef.current))) {
      notify(`Can’t place “${def.name}” here — a chip can’t contain itself.`);
      return;
    }
    apiRef.current!.beginPlace('CHIP', def.id);
  };

  /* Community chips arrive with their nested deps bundled — keep only
     the ones we don't already have. */
  const addCommunityChips = (defs: ChipDef[]) => {
    const have = new Set(chips.map(c => c.id));
    const fresh = defs.filter(d => d && !have.has(d.id)).map(migrateChipDef);
    if (!fresh.length) { notify(`“${defs[0]?.name}” is already in your library.`); return; }
    setChips([...chips, ...fresh]);
    notify(`Added “${defs[0].name}” to My chips${fresh.length > 1 ? ` (+${fresh.length - 1} nested chip${fresh.length > 2 ? 's' : ''})` : ''}.`);
  };

  /* ── folders ──
     A folder exists if any chip points at it OR it has a metadata entry
     (so empty folders and colors survive). Metadata lives in localStorage. */
  const folders = useMemo(() => {
    const s = new Set<string>(Object.keys(folderMeta));
    for (const c of chips) if (c.folder) s.add(c.folder);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [chips, folderMeta]);

  const setFolderMeta = (meta: Record<string, FolderMeta>) => {
    folderMetaRef.current = meta;
    setFolderMetaState(meta);
    try { localStorage.setItem(LS_FOLDERS, JSON.stringify(meta)); } catch {}
  };

  const setChipFolder = (id: string, folder?: string) => {
    const name = folder && cleanFolderName(folder);
    setChips(chips.map(c => {
      if (c.id !== id) return c;
      const { folder: _f, ...rest } = c;
      return name ? { ...rest, folder: name } : rest;
    }));
    setFolderMenu(null);
    setNewFolder('');
  };

  const createFolder = (raw: string) => {
    const name = cleanFolderName(raw);
    setCreatingFolder(false);
    setFolderDraft('');
    if (!name) return;
    if (folders.includes(name)) { notify(`A folder called “${name}” already exists.`); return; }
    setFolderMeta({ ...folderMetaRef.current, [name]: {} });
    collapsedRef.current = { ...collapsedRef.current, 'My chips': false, ['folder:' + name]: false };
    setCollapsed(collapsedRef.current);
    persistPal();
  };

  const renameFolder = (from: string, to: string) => {
    const name = cleanFolderName(to);
    setRenamingFolder(null);
    if (!name || name === from) return;
    if (folders.includes(name)) { notify(`A folder called “${name}” already exists.`); return; }
    const meta = { ...folderMetaRef.current, [name]: folderMetaRef.current[from] ?? {} };
    delete meta[from];
    setFolderMeta(meta);
    collapsedRef.current = { ...collapsedRef.current, ['folder:' + name]: collapsedRef.current['folder:' + from] ?? false };
    setCollapsed(collapsedRef.current);
    persistPal();
    if (chips.some(c => c.folder === from)) {
      setChips(chips.map(c => (c.folder === from ? { ...c, folder: name } : c)));
    }
  };

  const deleteFolder = (f: string) => {
    const meta = { ...folderMetaRef.current };
    delete meta[f];
    setFolderMeta(meta);
    setColorMenu(null);
    const n = chips.filter(c => c.folder === f).length;
    if (n) {
      setChips(chips.map(c => {
        if (c.folder !== f) return c;
        const { folder: _x, ...rest } = c;
        return rest;
      }));
    }
    notify(n ? `Removed “${f}” — ${n} chip${n > 1 ? 's' : ''} moved back to My chips.` : `Removed folder “${f}”.`);
  };

  const setFolderColor = (f: string, color?: string) => {
    const cur = { ...(folderMetaRef.current[f] ?? {}) };
    if (color) cur.color = color; else delete cur.color;
    setFolderMeta({ ...folderMetaRef.current, [f]: cur });
  };

  /* Drop a dragged chip on a folder (or on '' = back to the loose list). */
  const dropChipToFolder = (def: ChipDef, target: string) => {
    if ((chipsRef.current[def.id]?.folder ?? '') === target) return;
    setChipFolder(def.id, target || undefined);
    notify(target ? `Moved “${def.name}” into “${target}”.` : `Moved “${def.name}” out of its folder.`);
  };

  /* Chip rows: a short press stamps copies (as before); dragging past a
     small threshold picks the chip up so it can be dropped on a folder. */
  const chipDragStart = (def: ChipDef) => (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.chip-actions,.folderpop')) return;
    e.preventDefault();
    setFolderMenu(null);
    const pid = e.pointerId;
    // Capture the pointer so the release always reaches us — without it,
    // Safari/touch can drop the pointerup mid-drag, stranding the ghost
    // on screen and never delivering the chip to the folder.
    try { (e.currentTarget as HTMLElement).setPointerCapture(pid); } catch {}
    const startX = e.clientX, startY = e.clientY;
    let dragging = false;
    let done = false;
    const targetAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest('[data-drop]') as HTMLElement | null;
      return el ? (el.dataset.drop ?? null) : null;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) dragging = true;
      if (dragging) {
        setDrag({ chip: def, x: ev.clientX, y: ev.clientY });
        setDropTarget(targetAt(ev.clientX, ev.clientY));
      }
    };
    const finish = (ev: PointerEvent | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', cancel);
      if (dragging) {
        // Clear the ghost before touching the chip list so nothing that
        // goes wrong in the move can leave the drag graphic frozen.
        setDrag(null);
        setDropTarget(null);
        const t = ev && ev.type === 'pointerup' ? targetAt(ev.clientX, ev.clientY) : null;
        if (t != null) dropChipToFolder(def, t);
      } else if (ev && ev.type === 'pointerup') {
        placeChip(def);
      }
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === pid) finish(ev); };
    const cancel = () => finish(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', cancel);
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

  const onValueChange = (v: string) => {
    const bits = sel?.pinBits ?? 1;
    if (useHexValue(bits)) {
      // wide buses take hex because very long binary strings are unreadable
      const clean = v.replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, hexDigits(bits));
      setValDraft(clean);
      if (sel) apiRef.current!.setValue(sel.id, clean ? BigInt('0x' + clean) : 0n);
    } else {
      const clean = v.replace(/[^01]/g, '').slice(0, bits);
      setValDraft(clean);
      if (sel) apiRef.current!.setValue(sel.id, clean ? BigInt('0b' + clean) : 0n);
    }
  };

  const onPinBitsChange = (n: number) => {
    if (sel && Number.isFinite(n)) apiRef.current!.setPinBits(sel.id, n);
  };

  const clearBoard = () => {
    apiRef.current!.clear();
  };

  const api = () => apiRef.current!;

  const peekDef = peek ? lib[peek.chipId] : undefined;

  /* ── inspector sidebar helpers ── */
  const selTitle = !sel ? ''
    : sel.kind === 'wire' ? ((sel.bits ?? 1) > 1 ? 'Bus wire' : 'Wire')
    : sel.kind === 'multi' ? `${sel.count} parts selected`
    : sel.type === 'CHIP' ? (sel.chipId && lib[sel.chipId]?.name) || 'Chip'
    : sel.type ? getGeom({ type: sel.type }, lib).name
    : '';
  const selSub = sel?.kind === 'comp' && sel.type
    ? (sel.type === 'CHIP'
      ? (sel.chipId && lib[sel.chipId] ? `custom chip · ${lib[sel.chipId].inputs.length} in · ${lib[sel.chipId].outputs.length} out` : 'custom chip')
      : getGeom({ type: sel.type, bits: sel.pinBits }, lib).sub)
    : sel?.kind === 'wire' ? 'select a width to make it a bus'
    : sel?.kind === 'multi' ? 'drag to move together' : '';

  /* ── palette search ── */
  const q = query.trim().toLowerCase();
  const qMatch = (s?: string) => !!s && s.toLowerCase().includes(q);

  /* Highlight the matched part of a name while searching. */
  const hiName = (s: string): React.ReactNode => {
    if (!q) return s;
    const i = s.toLowerCase().indexOf(q);
    if (i < 0) return s;
    return <>{s.slice(0, i)}<mark>{s.slice(i, i + q.length)}</mark>{s.slice(i + q.length)}</>;
  };

  const builtinGroups = PALETTE_ORDER.map(([head, types]) => {
    const shown = !q ? types : types.filter(t => {
      const g = getGeom({ type: t }, {});
      return qMatch(g.name) || qMatch(g.sub) || qMatch(t) || qMatch(head);
    });
    return { head, shown };
  }).filter(g => g.shown.length > 0);

  const chipMatches = (c: ChipDef) => !q || qMatch(c.name);
  const folderView = folders.map(f => {
    const all = chips.filter(c => c.folder === f);
    const shown = !q || qMatch(f) ? all : all.filter(chipMatches);
    return { name: f, all, shown, visible: !q || qMatch(f) || shown.length > 0 };
  });
  const looseShown = chips.filter(c => !c.folder && chipMatches(c));
  const myChipsVisible = !q || looseShown.length > 0 || folderView.some(v => v.visible);
  const noResults = q.length > 0 && builtinGroups.length === 0 && !myChipsVisible;

  /* One chip row in the palette (used by folders and the loose list). */
  const chipRow = (def: ChipDef) => (
    <div key={def.id}
      className={'pal-item chip' + (armed?.chipId === def.id ? ' armed' : '') + (drag?.chip.id === def.id ? ' dragging' : '')}
      role="button" tabIndex={0}
      title="Click to stamp copies on the grid — drag onto a folder to organize, double-click to edit the internals"
      onPointerDown={chipDragStart(def)}
      onKeyDown={e => { if (e.key === 'Enter') placeChip(def); }}
      onDoubleClick={e => {
        if ((e.target as HTMLElement).closest('.chip-actions,.folderpop')) return;
        askEditChip(def.id);
      }}>
      <PalIcon type="CHIP" chip={def} />
      <div className="chipmeta">
        <div className="nm ellip">{hiName(def.name)}</div>
        <div className="sub">{isVhdlChip(def) ? 'VHDL · ' : ''}{def.inputs.length} in · {def.outputs.length} out</div>
      </div>
      <div className="chip-actions">
        <button className="chipfolder" aria-label={`Move ${def.name} to a folder`} title="Move to folder"
          onClick={() => { setFolderMenu(folderMenu === def.id ? null : def.id); setNewFolder(''); }}>
          <FolderIcon size={10} />
        </button>
        <button className="chipinfo" aria-label={`Inspect ${def.name} — truth table and state machine`}
          title="Truth table, state machine & package" onClick={() => setInspect(def)}>i</button>
        <button className="chipdel" aria-label={`Delete ${def.name}`} title="Delete chip"
          onClick={() => requestDeleteChip(def)}>×</button>
      </div>
      <AnimatePresence>
        {folderMenu === def.id && (
          <motion.div className="folderpop" onPointerDown={e => e.stopPropagation()}
            initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.14 }}>
            <div className="folderpop-head">Move to folder</div>
            {folders.map(f => (
              <button key={f} className={'folderpop-item' + (def.folder === f ? ' on' : '')}
                onClick={() => setChipFolder(def.id, def.folder === f ? undefined : f)}>
                <FolderIcon size={11} color={folderMeta[f]?.color} />
                <span className="ellip">{f}</span>{def.folder === f ? ' ✓' : ''}
              </button>
            ))}
            {def.folder && (
              <button className="folderpop-item" onClick={() => setChipFolder(def.id, undefined)}>
                <span aria-hidden="true">–</span>No folder
              </button>
            )}
            <div className="folderpop-new">
              <input
                value={newFolder}
                maxLength={MAX_FOLDER_NAME}
                placeholder="New folder…"
                onChange={e => setNewFolder(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newFolder.trim()) setChipFolder(def.id, newFolder);
                  if (e.key === 'Escape') setFolderMenu(null);
                }}
              />
              <button disabled={!newFolder.trim()} onClick={() => setChipFolder(def.id, newFolder)}>Add</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  /* Collapsible palette-group body with a subtle height animation. */
  const groupBody = (open: boolean, children: React.ReactNode) => (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="body"
          className="pal-groupbody"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  /* ── render ── */
  return (
    <div id="app" className={drag ? 'dragging' : ''}>
      <div id="titlebar">
        <div id="appname"><LogoMark size={22} />Latchwork<em>digital logic workbench</em></div>
        <div id="titletools">

        <div id="livedot"><i />Live</div>
        <div id="zoomgrp">
          <button onClick={() => api().zoomOut()} title="Zoom out" aria-label="Zoom out">−</button>
          <div id="zoomlabel" className="mono">{zoom}%</div>
          <button onClick={() => api().zoomIn()} title="Zoom in" aria-label="Zoom in">+</button>
        </div>
        <button className={'tbtn' + (wireTool ? ' on' : '')} aria-pressed={wireTool}
          title="Wire tool (W) — click any grid dot to start a wire; click an existing wire to split it"
          onClick={() => api().setWireTool(!wireTool)}>Wire</button>
        <button className="tbtn" onClick={() => api().resetView()}>Reset view</button>
        <button className="tbtn" onClick={() => api().powerCycle()} title="Zero every signal and latch, like flipping the power">Power cycle</button>
        <button className="tbtn danger" onClick={clearBoard}>Clear</button>
        <button className={'tbtn' + (timingOpen ? ' on' : '')} aria-pressed={timingOpen}
          title="Timing diagram — record and plot signals over time"
          onClick={() => setTimingOpen(o => !o)}>Timing</button>
        <button className="tbtn" onClick={() => setVhdlEdit({})}
          title="Write a VHDL entity + architecture and use it as a chip">VHDL</button>
        <button className="tbtn" onClick={() => setCommunityOpen(true)}
          title="Browse chips shared by other builders — or share your own">Community</button>
        {editingChip
          ? <button className="tbtn primary" onClick={updateChip}
              title={`Apply this circuit as the new internals of “${editingChip.name}”`}>Update chip</button>
          : <button className="tbtn primary" onClick={openSaveChip}>Save as chip</button>}
        {user
          ? <a className="tbtn ghostbtn" href="/auth/logout" title={user.email ?? ''}>{user.name?.split(' ')[0] ?? 'Account'} · Sign out</a>
          : authEnabled
            ? <a className="tbtn ghostbtn" href="/auth/login">Sign in</a>
            : null}
        </div>
      </div>

      <div id="main">
        <nav id="palette" aria-label="Component palette" style={{ width: palWidth }}
          className={drag ? 'dragging-chip' : ''}>
          <div id="palsearch">
            <SearchIcon />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search components"
              aria-label="Search components and chips"
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setQuery(''); (e.target as HTMLElement).blur(); }
              }}
            />
            {query
              ? <button className="psclear" aria-label="Clear search"
                  onClick={() => { setQuery(''); searchRef.current?.focus(); }}>×</button>
              : <kbd className="pskbd" aria-hidden="true">/</kbd>}
          </div>

          <div id="palscroll">
            {builtinGroups.map(({ head, shown }) => (
              <div key={head} className="pal-group">
                <button className={'pal-head' + (!q && collapsed[head] ? ' closed' : '')}
                  aria-expanded={q ? true : !collapsed[head]} onClick={() => toggleGroup(head)}>
                  <span className="chev" aria-hidden="true">▾</span>{head}
                </button>
                {groupBody(q ? true : !collapsed[head], shown.map(t => {
                  const g = getGeom({ type: t }, {});
                  const isArmed = armed?.type === t && !armed?.chipId;
                  return (
                    <div key={t} className={'pal-item' + (isArmed ? ' armed' : '')}
                      role="button" tabIndex={0}
                      title="Click, then stamp copies on the grid — esc stops"
                      onPointerDown={e => { e.preventDefault(); api().beginPlace(t); }}
                      onKeyDown={e => { if (e.key === 'Enter') api().beginPlace(t); }}>
                      <PalIcon type={t} />
                      <div><div className="nm">{hiName(g.name)}</div><div className="sub">{g.sub}</div></div>
                    </div>
                  );
                }))}
              </div>
            ))}

            {myChipsVisible && (
              <div className={'pal-group' + (drag && dropTarget === '' ? ' dragover-loose' : '')} data-drop="">
                <div className="pal-head-row">
                  <button className={'pal-head' + (!q && collapsed['My chips'] ? ' closed' : '')}
                    aria-expanded={q ? true : !collapsed['My chips']} onClick={() => toggleGroup('My chips')}>
                    <span className="chev" aria-hidden="true">▾</span>My chips
                    {chips.length > 0 && <span className="fcount mono">{chips.length}</span>}
                  </button>
                  <button className="pal-newfolder" title="New folder" aria-label="Create a folder"
                    onClick={() => {
                      setCreatingFolder(true);
                      setFolderDraft('');
                      if (collapsedRef.current['My chips']) toggleGroup('My chips');
                    }}>
                    <FolderIcon size={12} /><span aria-hidden="true">+</span>
                  </button>
                </div>
                {groupBody(q ? true : !collapsed['My chips'], (
                  <>
                    {creatingFolder && (
                      <div className="pal-newfolder-row">
                        <FolderIcon size={12} />
                        <input
                          autoFocus
                          value={folderDraft}
                          maxLength={MAX_FOLDER_NAME}
                          placeholder="Folder name…"
                          onChange={e => setFolderDraft(e.target.value)}
                          onBlur={() => createFolder(folderDraft)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') createFolder(folderDraft);
                            if (e.key === 'Escape') { setCreatingFolder(false); setFolderDraft(''); }
                          }}
                        />
                      </div>
                    )}
                    {chips.length === 0 && folders.length === 0 && !q && (
                      <div className="pal-empty">
                        Build a circuit with <b>Input</b> and <b>Output pins</b>, then <b>Save as chip</b> to package it
                        here — like a D flip-flop you can reuse anywhere.
                      </div>
                    )}
                    {folderView.filter(v => v.visible).map(({ name: f, all, shown }) => {
                      const key = 'folder:' + f;
                      const color = folderMeta[f]?.color;
                      const open = q ? true : !collapsed[key];
                      return (
                        <div key={key}
                          className={'pal-folder' + (drag && dropTarget === f ? ' dragover' : '')}
                          data-drop={f}
                          style={color ? { borderLeftColor: color } : undefined}>
                          <div className="pal-subhead-row">
                            {renamingFolder === f ? (
                              <div className="pal-subhead renamer">
                                <FolderIcon color={color} />
                                <input
                                  autoFocus
                                  value={folderRenameDraft}
                                  maxLength={MAX_FOLDER_NAME}
                                  aria-label={`Rename folder ${f}`}
                                  onChange={e => setFolderRenameDraft(e.target.value)}
                                  onBlur={() => renameFolder(f, folderRenameDraft)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') renameFolder(f, folderRenameDraft);
                                    if (e.key === 'Escape') setRenamingFolder(null);
                                  }}
                                />
                              </div>
                            ) : (
                              <button className={'pal-subhead' + (!q && collapsed[key] ? ' closed' : '')}
                                aria-expanded={open} onClick={() => toggleGroup(key)}
                                onDoubleClick={() => { setRenamingFolder(f); setFolderRenameDraft(f); }}
                                title="Click to collapse — double-click to rename">
                                <span className="chev" aria-hidden="true">▾</span>
                                <FolderIcon color={color} />
                                <span className="ellip">{hiName(f)}</span>
                                <span className="fcount mono"
                                  style={color ? { background: color + '2e', color } : undefined}>
                                  {q && shown.length !== all.length ? `${shown.length}/${all.length}` : all.length}
                                </span>
                              </button>
                            )}
                            <div className="folder-actions">
                              <button className="fact fact-color" title="Folder color"
                                aria-label={`Set color of ${f}`}
                                onClick={() => setColorMenu(colorMenu === f ? null : f)}>
                                <span className="dot" style={{ background: color ?? 'var(--muted)' }} />
                              </button>
                              <button className="fact" title="Rename folder" aria-label={`Rename ${f}`}
                                onClick={() => { setRenamingFolder(f); setFolderRenameDraft(f); }}>✎</button>
                              <button className="fact fact-del" title="Remove folder — its chips stay in My chips"
                                aria-label={`Remove folder ${f}`} onClick={() => deleteFolder(f)}>×</button>
                            </div>
                            <AnimatePresence>
                              {colorMenu === f && (
                                <motion.div className="colorpop" onPointerDown={e => e.stopPropagation()}
                                  initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                                  exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.14 }}>
                                  {FOLDER_COLORS.map(c => (
                                    <button key={c} className={'swatch' + (color === c ? ' on' : '')}
                                      style={{ background: c }} aria-label={`Color ${c}`}
                                      onClick={() => { setFolderColor(f, c); setColorMenu(null); }} />
                                  ))}
                                  <button className="swatch none" title="No color" aria-label="No color"
                                    onClick={() => { setFolderColor(f, undefined); setColorMenu(null); }}>×</button>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                          {groupBody(open, (
                            <>
                              {shown.map(chipRow)}
                              {all.length === 0 && <div className="pal-folderempty">Drag chips here</div>}
                            </>
                          ))}
                        </div>
                      );
                    })}
                    {looseShown.map(chipRow)}
                  </>
                ))}
              </div>
            )}

            {noResults && (
              <div className="pal-noresults">
                Nothing matches “<b>{query.trim()}</b>”.
                <button className="linkbtn" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear search</button>
              </div>
            )}
          </div>
        </nav>
        <div id="palresize" role="separator" aria-orientation="vertical" aria-label="Resize palette"
          title="Drag to resize the palette" onPointerDown={startPalResize} />

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
          <AnimatePresence>
            {toast && (
              <motion.div className="toast" role="status" key="toast"
                initial={{ opacity: 0, y: 14, x: '-50%' }}
                animate={{ opacity: 1, y: 0, x: '-50%' }}
                exit={{ opacity: 0, y: 8, x: '-50%' }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}>
                {toast}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {sel && (
            <motion.aside
              id="inspector"
              key="inspector"
              aria-label="Selection options"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: 'spring', duration: 0.38, bounce: 0.14 }}
            >
              <div className="side-inner">
                <div className="side-head">
                  <div>
                    <div className="side-title ellip">{selTitle}</div>
                    {selSub && <div className="side-sub ellip">{selSub}</div>}
                  </div>
                  <button className="community-close" aria-label="Close options"
                    onClick={() => api().clearSelection()}>×</button>
                </div>

                {sel.kind === 'comp' && sel.labelable && (
                  <label className="side-field">
                    <span>Name</span>
                    <input
                      className="mono"
                      value={labelDraft}
                      placeholder="name…"
                      maxLength={12}
                      aria-label="Component name"
                      onChange={e => onLabelChange(e.target.value)}
                    />
                  </label>
                )}

                {sel.kind === 'wire' && (
                  <label className="side-field" title="Bus width — how many bits this wire carries">
                    <span>Bits</span>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={MAX_WIRE_BITS}
                      step={1}
                      value={sel.bits ?? 1}
                      aria-label="Wire bus width"
                      onChange={e => api().setWireBits(sel.id, e.target.valueAsNumber)}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.nIns != null && sel.type && isBusToolType(sel.type) && (
                  <label className="side-field" title="Bus bit width">
                    <span>Bits</span>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={MAX_WIRE_BITS}
                      step={1}
                      value={sel.nIns}
                      aria-label="Bus bit width"
                      onChange={e => api().setNumInputs(sel.id, e.target.valueAsNumber)}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.pinBits != null && (
                  <label className="side-field"
                    title={sel.type && isGateType(sel.type)
                      ? `Operand width — the gate applies its logic bitwise across buses up to ${MAX_WIRE_BITS} bits`
                      : sel.type === 'SHIFT'
                        ? `Stages — each clock edge shifts D in; Q is the N-bit parallel output (up to ${MAX_WIRE_BITS})`
                        : sel.type && isMemoryType(sel.type)
                          ? `Data width — the cell stores an N-bit bus (up to ${MAX_WIRE_BITS}); clock/enable stay 1-bit`
                          : 'Pin bus width — how many bits this pin carries'}>
                    <span>{sel.type === 'SHIFT' ? 'Stages' : 'Bits'}</span>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={MAX_WIRE_BITS}
                      step={1}
                      value={sel.pinBits}
                      aria-label={sel.type && isGateType(sel.type) ? 'Gate operand width'
                        : sel.type === 'SHIFT' ? 'Shift register stages'
                          : sel.type && isMemoryType(sel.type) ? 'Memory data width' : 'Pin bus width'}
                      onChange={e => onPinBitsChange(e.target.valueAsNumber)}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.val != null && (
                  <label className="side-field"
                    title={useHexValue(sel.pinBits ?? 1)
                      ? 'Hex value driven onto the bus'
                      : 'Binary value driven onto the bus (MSB first)'}>
                    <span>Value{useHexValue(sel.pinBits ?? 1) ? ' · hex' : ' · binary'}</span>
                    <div className={'side-valwrap' + (useHexValue(sel.pinBits ?? 1) ? ' hex' : '')}>
                      {useHexValue(sel.pinBits ?? 1) && <span className="valprefix mono" aria-hidden="true">0x</span>}
                      <input
                        className="mono"
                        type="text"
                        inputMode={useHexValue(sel.pinBits ?? 1) ? 'text' : 'numeric'}
                        value={valDraft}
                        placeholder="0"
                        maxLength={useHexValue(sel.pinBits ?? 1) ? hexDigits(sel.pinBits ?? 1) : (sel.pinBits ?? 1)}
                        aria-label={useHexValue(sel.pinBits ?? 1) ? 'Hex value' : 'Binary value'}
                        onChange={e => onValueChange(e.target.value)}
                      />
                    </div>
                  </label>
                )}

                {sel.kind === 'comp' && sel.nIns != null && (!sel.type || !isBusToolType(sel.type)) && (
                  <div className="side-field" title={`Number of input lines (2–${MAX_GATE_INS})`}>
                    <span>Inputs</span>
                    <div className="side-btnrow" id="ningrp">
                      {[2, 3, 4].map(n => (
                        <button
                          key={n}
                          className={sel.nIns === n ? 'on' : ''}
                          aria-pressed={sel.nIns === n}
                          onClick={() => api().setNumInputs(sel.id, n)}
                        >{n}</button>
                      ))}
                      <input
                        className="mono"
                        type="number"
                        min={2}
                        max={MAX_GATE_INS}
                        step={1}
                        value={sel.nIns}
                        aria-label="Number of input lines"
                        onChange={e => api().setNumInputs(sel.id, e.target.valueAsNumber)}
                      />
                    </div>
                  </div>
                )}

                {sel.kind === 'comp' && sel.edgeable && (
                  <div className="side-field" title="Edge trigger — chips use a CLK/CLOCK pin when present, otherwise the last input">
                    <span>Edge</span>
                    <div className="side-btnrow" id="edgegrp">
                      {[
                        ...(isMemoryType(sel.type!) ? [] : [{ label: 'level', value: null }]),
                        { label: 'rise', value: 'rise' as const },
                        { label: 'fall', value: 'fall' as const },
                      ].map(opt => (
                        <button
                          key={opt.label}
                          className={(sel.edge ?? null) === opt.value ? 'on' : ''}
                          aria-pressed={(sel.edge ?? null) === opt.value}
                          onClick={() => api().setEdge(sel.id, opt.value)}
                        >{opt.label}</button>
                      ))}
                    </div>
                  </div>
                )}

                {sel.kind === 'comp' && sel.type === 'CLK' && (
                  <label className="side-field" title="Clock frequency" id="freqgrp">
                    <span>Frequency (Hz)</span>
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
                  </label>
                )}

                {sel.kind === 'comp' && sel.type === 'CHIP' && sel.chipId && lib[sel.chipId] && !isVhdlChip(lib[sel.chipId]) && (
                  <label className="side-field"
                    title="Scale the whole chip to this bus width — every gate, pin, value, and wire inside the chip changes bit length (applies to all placed copies)">
                    <span>Bits · all internals</span>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={MAX_WIRE_BITS}
                      step={1}
                      value={chipUniformBits(lib[sel.chipId]) ?? ''}
                      placeholder="mixed"
                      aria-label="Bus width for every component inside the chip"
                      onChange={e => {
                        const n = e.target.valueAsNumber;
                        if (Number.isFinite(n) && n >= 1 && n <= MAX_WIRE_BITS) applyChipBits(sel.chipId!, n);
                      }}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.type === 'CHIP' && sel.chipId && lib[sel.chipId] && (
                  <div className="side-actions">
                    {isVhdlChip(lib[sel.chipId]) ? (
                      <button className="tbtn" onClick={() => askEditChip(sel.chipId!)}
                        title="Open this chip's VHDL source in the editor">Edit VHDL…</button>
                    ) : (
                      <>
                        <button className="tbtn" onClick={() => openPeek(sel.id, sel.chipId!)}
                          title="Watch this chip's internals react to its live inputs — and adjust its package">
                          Peek inside
                        </button>
                        <button className="tbtn" onClick={() => askEditChip(sel.chipId!)}
                          title="Open the chip's circuit in an editor tab">Edit internals…</button>
                      </>
                    )}
                  </div>
                )}

                {sel.kind === 'comp' && sel.probeable && (
                  <label className="side-check"
                    title="Record this part's signal (first output, or first input for LEDs and output pins) and plot it in the timing diagram">
                    <input
                      type="checkbox"
                      checked={!!sel.probe}
                      onChange={e => {
                        api().setProbe(sel.id, e.target.checked);
                        if (e.target.checked) setTimingOpen(true);
                      }}
                    />
                    <span>Plot in timing diagram</span>
                  </label>
                )}

                <div className="side-actions">
                  <button className="tbtn" disabled={sel.kind === 'wire'}
                    title="Rotate selection 90° (R)"
                    onClick={() => api().rotateSelection()}>Rotate</button>
                  <button className="tbtn danger" title="Delete selection (⌫)"
                    onClick={() => api().deleteSelection()}>Delete</button>
                </div>

                <div className="side-hint">
                  {sel.kind === 'wire'
                    ? 'Right-click a wire to delete it. Multi-bit wires draw thicker and show a live readout.'
                    : 'Drag on the canvas to move. Press R to rotate, ⌫ to delete, esc to deselect.'}
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {timingOpen && <TimingPanel key="timing" api={api} onClose={() => setTimingOpen(false)} />}
      </AnimatePresence>

      <div id="tabbar" role="tablist" aria-label="Editor tabs">
        <div className="tabscroll">
          {tabs.map(t => (
            <div key={t.id} role="tab" aria-selected={t.id === activeTab}
              className={'edtab' + (t.id === activeTab ? ' on' : '') + (t.chipId ? ' chiptab' : '')}
              title={t.chipId ? `Editing the internals of “${t.name}” — double-click to rename` : 'Double-click to rename'}
              onPointerDown={() => switchTab(t.id)}
              onDoubleClick={() => { setRenaming(t.id); setRenameDraft(t.name); }}>
              {t.chipId && <span className="edtab-dot" aria-hidden="true" />}
              {renaming === t.id ? (
                <input
                  autoFocus
                  className="edtab-rename mono"
                  value={renameDraft}
                  maxLength={20}
                  onChange={e => setRenameDraft(e.target.value)}
                  onBlur={() => renameTab(t.id, renameDraft)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') renameTab(t.id, renameDraft);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onPointerDown={e => e.stopPropagation()}
                />
              ) : (
                <span className="edtab-name ellip">{t.name}</span>
              )}
              {tabs.length > 1 && (
                <button className="edtab-close" aria-label={`Close ${t.name}`}
                  onPointerDown={e => e.stopPropagation()}
                  onClick={() => closeTab(t.id)}>×</button>
              )}
            </div>
          ))}
        </div>
        <button className="edtab-add" title="New editor tab" aria-label="New editor tab" onClick={() => addTab()}>+</button>
      </div>

      <div id="statusbar">
        <span className="mono"><b>{counts.parts}</b> parts · <b>{counts.wires}</b> wires · <b>{chips.length}</b> chips</span>
        <span><kbd>W</kbd> wire tool: start at any dot, split wires · click a dot twice to end in air</span>
        <span><kbd>R</kbd> rotate · drag empty space to <b>select</b> · <kbd>⌘/⌃</kbd><kbd>C</kbd>/<kbd>V</kbd> copy &amp; paste</span>
        <span><kbd>⌫</kbd> delete · <kbd>esc</kbd> cancel · scroll to pan · <kbd>ctrl</kbd>+scroll to zoom · <kbd>space</kbd>+drag or middle-drag to pan</span>
        <span>{user ? 'Chips sync to your account' : authEnabled ? 'Chips save to this browser — sign in to sync' : 'Chips save to this browser'}</span>
      </div>

      {drag && (
        <div className="dragghost" style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 10}px)` }}>
          <PalIcon type="CHIP" chip={drag.chip} />
          <div className="dragghost-meta">
            <span className="ellip">{drag.chip.name}</span>
            <em>{dropTarget == null
              ? 'Drop on a folder'
              : dropTarget === ''
                ? ((drag.chip.folder ?? '') === '' ? 'My chips' : 'Move out of folder')
                : `Move to “${dropTarget}”`}</em>
          </div>
        </div>
      )}

      {communityOpen && (
        <CommunityDialog
          user={user}
          chips={chips}
          onAdd={addCommunityChips}
          onSignIn={() => authEnabled ? window.location.assign('/auth/login') : notify('Sign-in is not configured for this deployment.')}
          onClose={() => setCommunityOpen(false)}
          notify={notify}
        />
      )}

      <AnimatePresence>
        {inspect && (
          <Modal key="inspect" className="inspectdialog" label={`${inspect.name} — behavior`}
            onDismiss={() => setInspect(null)}>
            <div className="inspect-head">
              <h2>{inspect.name}</h2>
              <span className="community-card-meta">{inspect.inputs.length} in · {inspect.outputs.length} out</span>
              <div className="spacer" />
              <button className="community-close" aria-label="Close" onClick={() => setInspect(null)}>×</button>
            </div>
            <div className="inspect-body">
              {isVhdlChip(inspect) ? (
                <div className="analysis">
                  <h3>VHDL source <em>— this chip runs the compiled module below</em></h3>
                  <pre className="vhdl-view mono">{inspect.vhdl}</pre>
                </div>
              ) : (
                <ChipPreview def={inspect} lib={lib} tall />
              )}
              <ChipAnalysis def={inspect} lib={lib} />
              <div className="analysis">
                <h3>Package &amp; pins <em>— drag pins to any edge, resize, or reshape</em></h3>
              </div>
              <ChipPackageEditor key={inspect.id} def={inspect}
                onSave={pkg => { const nd = applyChipPackage(inspect.id, pkg); if (nd) setInspect(nd); }} />
            </div>
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => askEditChip(inspect.id)}>
                {isVhdlChip(inspect) ? 'Edit VHDL…' : 'Edit internals…'}
              </button>
              <button className="tbtn primary" onClick={() => setInspect(null)}>Done</button>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {peek && peekDef && (
          <PeekDialog
            key="peek"
            compId={peek.compId}
            def={peekDef}
            lib={lib}
            getState={id => apiRef.current?.getChipSubState(id) ?? null}
            onSavePackage={pkg => applyChipPackage(peek.chipId, pkg)}
            onEditInternals={() => openChipTab(peekDef)}
            onClose={() => setPeek(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {vhdlEdit && (
          <VhdlDialog
            key="vhdl"
            base={vhdlEdit.base}
            onSave={saveVhdl}
            onClose={() => setVhdlEdit(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {editAsk && (
          <Modal key="editask" label="Edit chip internals" onDismiss={() => setEditAsk(null)}>
            <h2>Edit the internals of “{editAsk.name}”?</h2>
            <p>
              Its circuit opens in a <b>new editor tab</b> (bottom bar). Rework the logic, then press{' '}
              <b>Update chip</b> to apply the changes to every placed copy.
            </p>
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => setEditAsk(null)}>No, leave it</button>
              <button className="tbtn primary" autoFocus onClick={() => openChipTab(editAsk)}>Yes, open editor tab</button>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deleteAsk && (
          <Modal key="deleteask" label="Delete chip" onDismiss={() => setDeleteAsk(null)}>
            <h2>Delete “{deleteAsk.name}”?</h2>
            <p>
              The chip is removed from <b>My chips</b> and <b>every placed copy</b> of it is deleted
              from your sheets. This can&apos;t be undone.
            </p>
            <div className="dialog-actions">
              <button className="tbtn" autoFocus onClick={() => setDeleteAsk(null)}>Cancel</button>
              <button className="tbtn dangerfill" onClick={confirmDeleteChip}>Delete chip</button>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {busEdit && (
          <Modal key="busedit" className="savechipdialog"
            label={`${busEdit.type === 'COMB' ? 'Bit combiner' : 'Splitter'} — pins & size`}
            onDismiss={() => setBusEdit(null)}>
            <h2>{busEdit.type === 'COMB' ? 'Bit combiner' : 'Splitter'} pins</h2>
            <p>
              Drag pins to any edge to reassign their locations, drag labels to nudge names,
              and use the size buttons to resize the body — just like a custom chip.
            </p>
            <PinLayoutEditor
              inputs={busEdit.type === 'COMB'
                ? Array.from({ length: busEdit.nIns }, (_, i) => ({ name: bitWeightName(busEdit.nIns, i), bits: 1 }))
                : [{ name: 'BUS', bits: busEdit.nIns }]}
              outputs={busEdit.type === 'COMB'
                ? [{ name: 'BUS', bits: busEdit.nIns }]
                : Array.from({ length: busEdit.nIns }, (_, i) => ({ name: bitWeightName(busEdit.nIns, i), bits: 1 }))}
              name={busEdit.type === 'COMB' ? 'COMBINE' : 'SPLIT'}
              layout={busEdit.layout}
              onChange={l => setBusEdit({ ...busEdit, layout: l })}
            />
            <div className="dialog-actions">
              <button className="tbtn"
                onClick={() => setBusEdit({ ...busEdit, layout: busToolLayout(busEdit.type, busEdit.nIns) })}
                title="Put the pins back in their default positions">Reset layout</button>
              <div className="spacer" />
              <button className="tbtn" onClick={() => setBusEdit(null)}>Cancel</button>
              <button className="tbtn primary"
                onClick={() => { api().setBusLayout(busEdit.id, busEdit.layout); setBusEdit(null); }}>
                Apply
              </button>
            </div>
          </Modal>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dialogOpen && (
          <Modal key="savechip" className="savechipdialog" label="Save as chip" onDismiss={() => setDialogOpen(false)}>
            <h2>Save as chip</h2>
            <p>
              The whole board becomes one reusable part. Its <b>Input pins</b> become the chip&apos;s inputs and
              its <b>Output pins</b> become its outputs. Arrange the pins, pick a package shape, then name it.
            </p>
            <input
              autoFocus
              value={chipName}
              maxLength={24}
              placeholder="Chip name — e.g. D Flip-Flop"
              onChange={e => setChipName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') confirmSaveChip(); if (e.key === 'Escape') setDialogOpen(false); }}
            />
            {chipLayout && (
              <PinLayoutEditor
                inputs={layoutIns}
                outputs={layoutOuts}
                name={chipName}
                layout={chipLayout}
                onChange={setChipLayout}
                shape={chipShape}
                shapePts={chipShapePts}
                onShapeChange={(s, pts) => { setChipShape(s); if (pts) setChipShapePts(pts); }}
              />
            )}
            <div className="dialog-actions">
              <button className="tbtn"
                onClick={() => {
                  setChipLayout(defaultChipLayout(layoutIns.length, layoutOuts.length));
                  setChipShape('rect');
                  setChipShapePts(undefined);
                }}
                title="Reset pin positions and shape to the default layout">Reset layout</button>
              <div className="spacer" />
              <button className="tbtn" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button className="tbtn primary" disabled={!chipName.trim()} onClick={confirmSaveChip}>Save chip</button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
