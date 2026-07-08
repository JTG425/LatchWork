'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Board, ChipDef, ChipLib, ChipLayout, CompType, PALETTE_ORDER, getGeom,
  makeChipDef, validateChipSource, chipUsedBy, migrateChipDef, chipDefContains,
  isMemoryType, isBusToolType, MAX_WIRE_BITS, clampBits,
  chipPinSources, chipPinName, defaultChipLayout,
} from '@/lib/engine';
import { GATE_DEFS, isGateType } from '@/lib/gates';
import { createEditor, EditorApi, SelInfo, PlacingInfo } from '@/components/editor';
import PinLayoutEditor, { LayoutPin } from '@/components/PinLayoutEditor';
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
    case 'COMB': body = <><rect x="0" y="0" width="60" height="60" rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M-8,0 H0 M-8,20 H0 M-8,40 H0 M-8,60 H0 M60,30 H70" stroke="var(--lo)" strokeWidth="2" /><text x="30" y="35" textAnchor="middle" fill="var(--hi)" fontSize="13" fontFamily="ui-monospace,Menlo,monospace">0110</text></>; break;
    case 'SPLIT': body = <><rect x="0" y="0" width="80" height="60" rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><path d="M-8,30 H0 M80,0 H90 M80,20 H90 M80,40 H90 M80,60 H90" stroke="var(--lo)" strokeWidth="2" /><text x="40" y="35" textAnchor="middle" fill="var(--hi)" fontSize="13" fontFamily="ui-monospace,Menlo,monospace">0110</text></>; break;
    case 'IPIN': body = <><rect x="0" y="0" width="40" height="40" rx="7" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'OPIN': body = <><circle cx="20" cy="20" r="19" fill={fill} stroke="var(--accent)" strokeWidth="1.5" /><text x="20" y="27" textAnchor="middle" fill="var(--muted)" fontSize="16" fontWeight="600" fontFamily="ui-monospace,Menlo,monospace">0</text></>; break;
    case 'CHIP': body = <><rect x="0" y="0" width={g.w} height={g.h} rx="8" fill={fill} stroke={stroke} strokeWidth="1.5" /><circle cx="12" cy="10" r="2.5" fill="var(--muted)" /></>; break;
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
  const [toast, setToast] = useState<string | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [inspect, setInspect] = useState<ChipDef | null>(null);
  const [editAsk, setEditAsk] = useState<ChipDef | null>(null);
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
    const existing = tabsRef.current.find(t => t.chipId === def.id);
    if (existing) { switchTab(existing.id); return; }
    addTab(def.name, JSON.parse(JSON.stringify({ comps: def.comps, wires: def.wires })), def.id);
  }, [switchTab, addTab]);

  const askEditChip = useCallback((chipId: string) => {
    const def = chipsRef.current[chipId];
    if (def) setEditAsk(def);
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
      onChipDblClick: askEditChip,
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
    setChipName('');
    setDialogOpen(true);
  };

  const confirmSaveChip = () => {
    const name = chipName.trim();
    if (!name || !pendingBoard) return;
    const def = makeChipDef(name, pendingBoard, chipLayout ?? undefined);
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
    const rebuilt = makeChipDef(editingChip.name, board);
    const updated: ChipDef = { ...rebuilt, id: editingChip.id, createdAt: editingChip.createdAt };
    setChips(chips.map(c => (c.id === editingChip.id ? updated : c)));
    notify(`Updated “${editingChip.name}” — every placed copy now uses the new internals.`);
  };

  const deleteChip = (def: ChipDef) => {
    const usedBy = chipUsedBy(def.id, chipsRef.current);
    if (usedBy) { notify(`Can’t delete “${def.name}” — it’s used inside “${usedBy}”.`); return; }
    apiRef.current!.removeChipInstances(def.id);
    setChips(chips.filter(c => c.id !== def.id));
    notify(`Deleted “${def.name}”.`);
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

  /* ── render ── */
  return (
    <div id="app">
      <div id="titlebar">
        <div id="appname"><LogoMark size={22} />Latchwork<em>digital logic workbench</em></div>
        <div id="titletools">

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

        {sel?.kind === 'wire' && (
          <div id="bitsgrp" title="Bus width — how many bits this wire carries">
            <span>bits</span>
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
          </div>
        )}

        {sel?.kind === 'comp' && sel.nIns != null && sel.type && isBusToolType(sel.type) && (
          <div id="ningrp" title="Bus bit width">
            <span>bits</span>
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
          </div>
        )}

        {sel?.kind === 'comp' && sel.val != null && (
          <div id="valgrp" title="Binary value driven onto the bus (MSB first)">
            <span>value</span>
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
          </div>
        )}

        {sel?.kind === 'comp' && sel.pinBits != null && (
          <div id="pinbitsgrp" title="Pin bus width — how many bits this pin carries">
            <span>bits</span>
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
          </div>
        )}

        {sel?.kind === 'comp' && sel.nIns != null && (!sel.type || !isBusToolType(sel.type)) && (
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

        {sel?.kind === 'comp' && sel.edgeable && (
          <div id="edgegrp" title="Edge trigger — chips use a CLK/CLOCK pin when present, otherwise the last input">
            <span>edge</span>
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
        <button className={'tbtn' + (wireTool ? ' on' : '')} aria-pressed={wireTool}
          title="Wire tool (W) — click any grid dot to start a wire; click an existing wire to split it"
          onClick={() => api().setWireTool(!wireTool)}>Wire</button>
        <button className="tbtn" disabled={!sel || sel.kind === 'wire'}
          title="Rotate selection 90° (R)"
          onClick={() => api().rotateSelection()}>Rotate</button>
        <button className="tbtn" onClick={() => api().resetView()}>Reset view</button>
        <button className="tbtn" onClick={() => api().powerCycle()} title="Zero every signal and latch, like flipping the power">Power cycle</button>
        <button className="tbtn" disabled={!sel} onClick={() => api().deleteSelection()}>Delete</button>
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
              {!collapsed[head] && types.map(t => {
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

          <div className="pal-group">
            <button className={'pal-head' + (collapsed['My chips'] ? ' closed' : '')}
              aria-expanded={!collapsed['My chips']} onClick={() => toggleGroup('My chips')}>
              <span className="chev" aria-hidden="true">▾</span>My chips
            </button>
            {!collapsed['My chips'] && (
              <>
                {chips.length === 0 && (
                  <div className="pal-empty">
                    Build a circuit with <b>Input</b> and <b>Output pins</b>, then <b>Save as chip</b> to package it
                    here — like a D flip-flop you can reuse anywhere.
                  </div>
                )}
                {chips.map(def => (
                  <div key={def.id} className={'pal-item chip' + (armed?.chipId === def.id ? ' armed' : '')}
                    title="Click to stamp copies on the grid — double-click to edit the internals"
                    onPointerDown={e => {
                      if ((e.target as HTMLElement).closest('.chipdel,.chipinfo')) return;
                      e.preventDefault(); placeChip(def);
                    }}
                    onDoubleClick={e => {
                      if ((e.target as HTMLElement).closest('.chipdel,.chipinfo')) return;
                      askEditChip(def.id);
                    }}>
                    <PalIcon type="CHIP" chip={def} />
                    <div style={{ minWidth: 0 }}>
                      <div className="nm ellip">{def.name}</div>
                      <div className="sub">{def.inputs.length} in · {def.outputs.length} out</div>
                    </div>
                    <button className="chipinfo" aria-label={`Inspect ${def.name} — truth table and state machine`}
                      title="Truth table & state machine" onClick={() => setInspect(def)}>i</button>
                    <button className="chipdel" aria-label={`Delete ${def.name}`} title="Delete chip"
                      onClick={() => deleteChip(def)}>×</button>
                  </div>
                ))}
              </>
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
          {toast && <div className="toast" role="status">{toast}</div>}
        </div>
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

      {inspect && (
        <div className="overlay" onPointerDown={e => { if (e.target === e.currentTarget) setInspect(null); }}>
          <div className="dialog inspectdialog" role="dialog" aria-modal="true" aria-label={`${inspect.name} — behavior`}>
            <div className="inspect-head">
              <h2>{inspect.name}</h2>
              <span className="community-card-meta">{inspect.inputs.length} in · {inspect.outputs.length} out</span>
              <div className="spacer" />
              <button className="community-close" aria-label="Close" onClick={() => setInspect(null)}>×</button>
            </div>
            <div className="inspect-body">
              <ChipPreview def={inspect} lib={lib} tall />
              <ChipAnalysis def={inspect} lib={lib} />
            </div>
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => askEditChip(inspect.id)}>Edit internals…</button>
              <button className="tbtn primary" onClick={() => setInspect(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {editAsk && (
        <div className="overlay" onPointerDown={e => { if (e.target === e.currentTarget) setEditAsk(null); }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Edit chip internals">
            <h2>Edit the internals of “{editAsk.name}”?</h2>
            <p>
              Its circuit opens in a <b>new editor tab</b> (bottom bar). Rework the logic, then press{' '}
              <b>Update chip</b> to apply the changes to every placed copy.
            </p>
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => setEditAsk(null)}>No, leave it</button>
              <button className="tbtn primary" autoFocus onClick={() => openChipTab(editAsk)}>Yes, open editor tab</button>
            </div>
          </div>
        </div>
      )}

      {dialogOpen && (
        <div className="overlay" onPointerDown={e => { if (e.target === e.currentTarget) setDialogOpen(false); }}>
          <div className="dialog savechipdialog" role="dialog" aria-modal="true" aria-label="Save as chip">
            <h2>Save as chip</h2>
            <p>
              The whole board becomes one reusable part. Its <b>Input pins</b> become the chip&apos;s inputs and
              its <b>Output pins</b> become its outputs. Arrange the pins and their labels below, then name it.
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
              />
            )}
            <div className="dialog-actions">
              <button className="tbtn" onClick={() => setChipLayout(defaultChipLayout(layoutIns.length, layoutOuts.length))}
                title="Reset pin positions to the default layout">Reset layout</button>
              <div className="spacer" />
              <button className="tbtn" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button className="tbtn primary" disabled={!chipName.trim()} onClick={confirmSaveChip}>Save chip</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
