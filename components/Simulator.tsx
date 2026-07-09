'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Board, ChipDef, ChipLib, ChipLayout, ChipPackage, ChipShape, CompType, Vec,
  PALETTE_ORDER, getGeom, chipBodyPath,
  makeChipDef, validateChipSource, chipUsedBy, migrateChipDef, chipDefContains,
  isMemoryType, isBusToolType, MAX_WIRE_BITS, clampBits,
  chipPinSources, chipPinName, defaultChipLayout,
} from '@/lib/engine';
import { GATE_DEFS, isGateType } from '@/lib/gates';
import { createEditor, EditorApi, SelInfo, PlacingInfo } from '@/components/editor';
import PinLayoutEditor, { LayoutPin } from '@/components/PinLayoutEditor';
import PeekDialog, { ChipPackageEditor } from '@/components/PeekDialog';
import AuthDialog from '@/components/AuthDialog';
import CommunityDialog from '@/components/CommunityDialog';
import ChipAnalysis, { ChipPreview } from '@/components/ChipAnalysis';
import LogoMark from '@/components/Logo';
import { AuthPublicConfig } from '@/lib/auth-embedded';

const LS_BOARD = 'latchwork.board.v1';   // legacy single-board key, migrated into tabs
const LS_CHIPS = 'latchwork.chips.v1';
const LS_TABS = 'latchwork.tabs.v1';
const LS_PAL = 'latchwork.palette.v1';   // { collapsed: {head: bool}, width: px }

const PAL_MIN_W = 120, PAL_MAX_W = 420, PAL_DEF_W = 186;
const clampPalW = (w: number) => Math.min(PAL_MAX_W, Math.max(PAL_MIN_W, Math.round(w)));

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

export default function Simulator({ user, auth }: { user: SimUser | null; auth: AuthPublicConfig | null }) {
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
  const [authOpen, setAuthOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [inspect, setInspect] = useState<ChipDef | null>(null);
  const [editAsk, setEditAsk] = useState<ChipDef | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<ChipDef | null>(null);
  const [peek, setPeek] = useState<{ compId: string; chipId: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState('');
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

  /* ── tabs ── */
  const syncActiveBoard = useCallback(() => {
    const t = tabsRef.current.find(t => t.id === activeTabRef.current);
    if (t && apiRef.current) t.board = apiRef.current.getBoard();
  }, []);

  const persistTabs = useCallback(() => {
    try {
      localStorage.setItem(LS_TABS, JSON.stringify({ tabs: tabsRef.current, active: activeTabRef.current }));
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
    addTab(def.name, JSON.parse(JSON.stringify({ comps: def.comps, wires: def.wires })), def.id);
  }, [switchTab, addTab]);

  const askEditChip = useCallback((chipId: string) => {
    const def = chipsRef.current[chipId];
    if (def) setEditAsk(def);
  }, []);

  /* Double-click on a placed chip → peek inside it, live. */
  const openPeek = useCallback((compId: string, chipId: string) => {
    if (!chipsRef.current[chipId]) return;
    setPeek({ compId, chipId });
  }, []);

  /* ── mount: editor, then chips, then tabs/boards ── */
  useEffect(() => {
    const ed = createEditor(svgRef.current!, {
      getLib: () => chipsRef.current,
      onSelect: info => {
        setSel(info);
        setLabelDraft(info?.label ?? '');
        setFreqDraft(info?.freq != null ? String(info.freq) : '');
        setValDraft(info?.val != null ? info.val.toString(2).padStart(info.pinBits ?? 1, '0') : '');
      },
      onCounts: setCounts,
      onZoom: setZoom,
      onPlacing: setArmed,
      onWireTool: setWireTool,
      onChipDblClick: openPeek,
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

  /* ── folders ── */
  const folders = useMemo(() => {
    const s = new Set<string>();
    for (const c of chips) if (c.folder) s.add(c.folder);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [chips]);

  const setChipFolder = (id: string, folder?: string) => {
    const name = folder?.trim().slice(0, 20);
    setChips(chips.map(c => {
      if (c.id !== id) return c;
      const { folder: _f, ...rest } = c;
      return name ? { ...rest, folder: name } : rest;
    }));
    setFolderMenu(null);
    setNewFolder('');
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
    const clean = v.replace(/[^01]/g, '').slice(0, sel?.pinBits ?? 1);
    setValDraft(clean);
    if (sel) apiRef.current!.setValue(sel.id, clean ? parseInt(clean, 2) : 0);
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
      : getGeom({ type: sel.type }, lib).sub)
    : sel?.kind === 'wire' ? 'select a width to make it a bus'
    : sel?.kind === 'multi' ? 'drag to move together' : '';

  /* One chip row in the palette (used by folders and the loose list). */
  const chipRow = (def: ChipDef) => (
    <div key={def.id} className={'pal-item chip' + (armed?.chipId === def.id ? ' armed' : '')}
      title="Click to stamp copies on the grid — double-click to edit the internals"
      onPointerDown={e => {
        if ((e.target as HTMLElement).closest('.chipdel,.chipinfo,.chipfolder,.folderpop')) return;
        e.preventDefault(); placeChip(def);
      }}
      onDoubleClick={e => {
        if ((e.target as HTMLElement).closest('.chipdel,.chipinfo,.chipfolder,.folderpop')) return;
        askEditChip(def.id);
      }}>
      <PalIcon type="CHIP" chip={def} />
      <div style={{ minWidth: 0 }}>
        <div className="nm ellip">{def.name}</div>
        <div className="sub">{def.inputs.length} in · {def.outputs.length} out</div>
      </div>
      <button className="chipfolder" aria-label={`Move ${def.name} to a folder`} title="Move to folder"
        onClick={() => { setFolderMenu(folderMenu === def.id ? null : def.id); setNewFolder(''); }}>▣</button>
      <button className="chipinfo" aria-label={`Inspect ${def.name} — truth table and state machine`}
        title="Truth table, state machine & package" onClick={() => setInspect(def)}>i</button>
      <button className="chipdel" aria-label={`Delete ${def.name}`} title="Delete chip"
        onClick={() => requestDeleteChip(def)}>×</button>
      <AnimatePresence>
        {folderMenu === def.id && (
          <motion.div className="folderpop" onPointerDown={e => e.stopPropagation()}
            initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.14 }}>
            <div className="folderpop-head">Move to folder</div>
            {folders.map(f => (
              <button key={f} className={'folderpop-item' + (def.folder === f ? ' on' : '')}
                onClick={() => setChipFolder(def.id, def.folder === f ? undefined : f)}>
                <span aria-hidden="true">▣</span>{f}{def.folder === f ? ' ✓' : ''}
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
                maxLength={20}
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

  const looseChips = chips.filter(c => !c.folder);

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
    <div id="app">
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
        <button className="tbtn" onClick={() => setCommunityOpen(true)}
          title="Browse chips shared by other builders — or share your own">Community</button>
        {editingChip
          ? <button className="tbtn primary" onClick={updateChip}
              title={`Apply this circuit as the new internals of “${editingChip.name}”`}>Update chip</button>
          : <button className="tbtn primary" onClick={openSaveChip}>Save as chip</button>}
        {user
          ? <a className="tbtn ghostbtn" href="/auth/logout" title={user.email ?? ''}>{user.name?.split(' ')[0] ?? 'Account'} · Sign out</a>
          : auth
            ? <button className="tbtn ghostbtn" onClick={() => setAuthOpen(true)}>Sign in</button>
            : null}
        </div>
      </div>

      <div id="main">
        <nav id="palette" aria-label="Component palette" style={{ width: palWidth }}>
          {PALETTE_ORDER.map(([head, types]) => (
            <div key={head} className="pal-group">
              <button className={'pal-head' + (collapsed[head] ? ' closed' : '')}
                aria-expanded={!collapsed[head]} onClick={() => toggleGroup(head)}>
                <span className="chev" aria-hidden="true">▾</span>{head}
              </button>
              {groupBody(!collapsed[head], types.map(t => {
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
              }))}
            </div>
          ))}

          <div className="pal-group">
            <button className={'pal-head' + (collapsed['My chips'] ? ' closed' : '')}
              aria-expanded={!collapsed['My chips']} onClick={() => toggleGroup('My chips')}>
              <span className="chev" aria-hidden="true">▾</span>My chips
            </button>
            {groupBody(!collapsed['My chips'], (
              <>
                {chips.length === 0 && (
                  <div className="pal-empty">
                    Build a circuit with <b>Input</b> and <b>Output pins</b>, then <b>Save as chip</b> to package it
                    here — like a D flip-flop you can reuse anywhere.
                  </div>
                )}
                {folders.map(f => {
                  const inFolder = chips.filter(c => c.folder === f);
                  const key = 'folder:' + f;
                  return (
                    <div key={key} className="pal-folder">
                      <button className={'pal-subhead' + (collapsed[key] ? ' closed' : '')}
                        aria-expanded={!collapsed[key]} onClick={() => toggleGroup(key)}>
                        <span className="chev" aria-hidden="true">▾</span>
                        <span className="fico" aria-hidden="true">▣</span>
                        <span className="ellip">{f}</span>
                        <span className="fcount mono">{inFolder.length}</span>
                      </button>
                      {groupBody(!collapsed[key], inFolder.map(chipRow))}
                    </div>
                  );
                })}
                {looseChips.map(chipRow)}
              </>
            ))}
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
                  <label className="side-field" title="Pin bus width — how many bits this pin carries">
                    <span>Bits</span>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={MAX_WIRE_BITS}
                      step={1}
                      value={sel.pinBits}
                      aria-label="Pin bus width"
                      onChange={e => onPinBitsChange(e.target.valueAsNumber)}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.val != null && (
                  <label className="side-field" title="Binary value driven onto the bus (MSB first)">
                    <span>Value</span>
                    <input
                      className="mono"
                      type="text"
                      inputMode="numeric"
                      value={valDraft}
                      placeholder="0"
                      maxLength={sel.pinBits ?? 1}
                      aria-label="Binary value"
                      onChange={e => onValueChange(e.target.value)}
                    />
                  </label>
                )}

                {sel.kind === 'comp' && sel.nIns != null && (!sel.type || !isBusToolType(sel.type)) && (
                  <div className="side-field" title="Number of inputs">
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

                {sel.kind === 'comp' && sel.type === 'CHIP' && sel.chipId && lib[sel.chipId] && (
                  <div className="side-actions">
                    <button className="tbtn" onClick={() => openPeek(sel.id, sel.chipId!)}
                      title="Watch this chip's internals react to its live inputs — and adjust its package">
                      Peek inside
                    </button>
                    <button className="tbtn" onClick={() => askEditChip(sel.chipId!)}
                      title="Open the chip's circuit in an editor tab">Edit internals…</button>
                  </div>
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
        <span>{user ? 'Chips sync to your account' : auth ? 'Chips save to this browser — sign in to sync' : 'Chips save to this browser'}</span>
      </div>

      {authOpen && auth && <AuthDialog auth={auth} onClose={() => setAuthOpen(false)} />}

      {communityOpen && (
        <CommunityDialog
          user={user}
          chips={chips}
          onAdd={addCommunityChips}
          onSignIn={() => auth ? setAuthOpen(true) : notify('Sign-in is not configured for this deployment.')}
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
              <ChipPreview def={inspect} lib={lib} tall />
              <ChipAnalysis def={inspect} lib={lib} />
              <div className="analysis">
                <h3>Package &amp; pins <em>— drag pins to any edge, resize, or reshape</em></h3>
              </div>
              <ChipPackageEditor key={inspect.id} def={inspect}
                onSave={pkg => { const nd = applyChipPackage(inspect.id, pkg); if (nd) setInspect(nd); }} />
            </div>
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => askEditChip(inspect.id)}>Edit internals…</button>
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
