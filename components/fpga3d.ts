/* ────────────────────────────────────────────────────────────────────
   Basys 3 in three.js — the rendering half of the FPGA sheet.

   Builds a stylized-but-faithful Digilent Basys 3 (AMD Artix-7 trainer
   board) out of procedural geometry: 16 slide switches, 16 user LEDs,
   5 push buttons, a 4-digit common-anode 7-segment display, the
   Artix-7 package, USB/VGA/Pmod connectors and the power switch — all
   laid out from the real board's proportions, with a canvas-drawn
   silkscreen for the labels.

   The module owns the camera, lighting, orbiting and picking; it knows
   nothing about VHDL. Each frame it calls `onFrame(dt)` so the caller
   can run the emulated design, then mirrors the shared `visual` state
   onto the meshes (LED duty → emissive intensity, latched 7-seg
   patterns, switch/button poses) and renders.
   ──────────────────────────────────────────────────────────────────── */

import * as THREE from 'three';

export type BtnId = 'btnC' | 'btnU' | 'btnL' | 'btnR' | 'btnD';

/* Shared mutable state: the React side writes it, the render loop reads
   it every frame. digitSegs[d] bit i = cathode i lit (0=CA … 6=CG,
   7=dp), already decoded from active-low; index 0 is AN0 (rightmost). */
export interface FpgaVisualState {
  power: boolean;
  done: boolean;
  sw: number;                       // 16-bit switch state, bit0 = SW0
  btn: Record<BtnId, boolean>;
  ledDuty: Float32Array;            // 16 entries, 0..1, bit0 = LD0
  digitSegs: Uint8Array;            // 4 entries
}

export interface Basys3SceneOpts {
  visual: FpgaVisualState;
  onFrame: (dtMs: number) => void;  // run the emulation for this frame
  onToggleSwitch: (i: number) => void;
  onButton: (id: BtnId, down: boolean) => void;
  onTogglePower: () => void;
  onProg: () => void;               // PROG = reconfigure (reset the design)
}

/* board size in mm — real Basys 3 PCB is about 160 × 114.5 */
const BW = 160, BH = 114.5, PCB_T = 1.6;
const TOP = PCB_T;                  // pcb spans y = 0 … 1.6

/* part layout (x, z) in board mm, origin at the center, +z toward the
   switch row (the near edge) */
const SW_Z = 44, LED_Z = 33;
const swX = (bit: number) => 63 - bit * 8.7;
const SEG_CX = -31, SEG_CZ = 12, SEG_PITCH = 11.5;
const BTN_CX = 38, BTN_CZ = 12, BTN_OFF = 13;
const CHIP_X = -2, CHIP_Z = -18;
const POWER_X = -70, POWER_Z = -49;

const BTN_POS: Record<BtnId, [number, number]> = {
  btnU: [BTN_CX, BTN_CZ - BTN_OFF],
  btnD: [BTN_CX, BTN_CZ + BTN_OFF],
  btnL: [BTN_CX - BTN_OFF, BTN_CZ],
  btnR: [BTN_CX + BTN_OFF, BTN_CZ],
  btnC: [BTN_CX, BTN_CZ],
};

const SILK = '#cdd2d9';

/* ── silkscreen: one canvas painted over the PCB top ────────────── */

function silkscreenTexture(): THREE.CanvasTexture {
  const S = 10;                                    // 10 px per mm
  const cv = document.createElement('canvas');
  cv.width = BW * S; cv.height = Math.round(BH * S);
  const g = cv.getContext('2d')!;
  const X = (mm: number) => (mm + BW / 2) * S;
  const Y = (mm: number) => (mm + BH / 2) * S;

  g.fillStyle = '#141a21';                         // black soldermask
  g.fillRect(0, 0, cv.width, cv.height);

  /* faint traces + vias for texture (deterministic LCG so SSR-safe) */
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x3fffffff) / 0x3fffffff;
  g.strokeStyle = 'rgba(180,200,220,0.05)';
  g.lineWidth = 2.2;
  g.lineCap = 'round';
  for (let t = 0; t < 90; t++) {
    let x = rnd() * cv.width, y = rnd() * cv.height;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 4; s++) {
      const len = 40 + rnd() * 160;
      const dir = Math.floor(rnd() * 4) * (Math.PI / 4);
      x += Math.cos(dir) * len; y += Math.sin(dir) * len;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.fillStyle = 'rgba(201,168,106,0.14)';
  for (let v = 0; v < 240; v++) {
    g.beginPath(); g.arc(rnd() * cv.width, rnd() * cv.height, 3, 0, 7); g.fill();
  }

  const text = (s: string, xmm: number, zmm: number, mm: number,
    { align = 'center' as CanvasTextAlign, weight = 700, color = SILK } = {}) => {
    g.fillStyle = color;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.font = `${weight} ${mm * S}px -apple-system,'Segoe UI',Arial,sans-serif`;
    g.fillText(s, X(xmm), Y(zmm));
  };

  text('BASYS 3', 22, -44, 6.2, { weight: 800 });
  text('AMD ARTIX™-7 FPGA TRAINER BOARD', 22, -38.5, 2.4, { color: '#98a0aa' });
  text('DIGILENT', -60, -41, 3.4, { weight: 800 });

  for (let i = 0; i < 16; i++) {
    text('SW' + i, swX(i), 50.6, 2.1);
    text('LD' + i, swX(i), 28.2, 2.1);
  }
  text('BTNU', BTN_CX, BTN_CZ - BTN_OFF - 7.5, 2.2);
  text('BTND', BTN_CX + 8.5, BTN_CZ + BTN_OFF + 1, 2.2, { align: 'left' });
  text('BTNL', BTN_CX - BTN_OFF, BTN_CZ + 7.5, 2.2);
  text('BTNR', BTN_CX + BTN_OFF, BTN_CZ + 7.5, 2.2);
  text('BTNC', BTN_CX, BTN_CZ + 7.5, 2.2);

  text('PWR', POWER_X + 9.5, POWER_Z, 2.2, { align: 'left' });
  text('ON', POWER_X, POWER_Z - 8.5, 2);
  text('DONE', 14.5, -31.5, 2.2, { align: 'left' });
  text('PROG', 64, -34.5, 2.2);
  text('PROG / UART', -38, -47.5, 2.2);
  text('USB HOST', -8, -42.6, 2.2);
  text('VGA', 48, -44.5, 2.2);
  text('JA', -70, -33, 2.6); text('JB', -70, -3, 2.6);
  text('JC', 70, -33, 2.6); text('JXADC', 68, -3, 2.6);
  text('XC7A35T-1CPG236C', CHIP_X, CHIP_Z + 15.5, 2.1, { color: '#98a0aa' });

  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function chipTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#0e1013'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#b9bfc9'; g.textAlign = 'center';
  g.font = '700 34px Arial'; g.fillText('AMD', 128, 74);
  g.font = '800 30px Arial'; g.fillText('ARTIX™-7', 128, 118);
  g.font = '600 24px Arial'; g.fillText('XC7A35T', 128, 158);
  g.font = '500 20px Arial'; g.fillText('1CPG236C', 128, 190);
  g.beginPath(); g.arc(38, 218, 10, 0, 7);
  g.strokeStyle = '#b9bfc9'; g.lineWidth = 3; g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ── materials ──────────────────────────────────────────────────── */

const std = (color: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, ...o });

/* ── scene ──────────────────────────────────────────────────────── */

export function createBasys3Scene(mount: HTMLElement, opts: Basys3SceneOpts): { destroy(): void } {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(mount.clientWidth || 1, mount.clientHeight || 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.28;
  mount.appendChild(renderer.domElement);
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#17171c');
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 2000);

  /* four-part rig so the black PCB never goes murky: ambient floor,
     sky/ground hemisphere, a shadow-casting key, a cool fill and a rim
     light that edges the connectors against the dark backdrop */
  scene.add(new THREE.AmbientLight(0xffffff, 0.38));
  scene.add(new THREE.HemisphereLight(0xbccfe4, 0x1e222a, 1.3));
  const key = new THREE.DirectionalLight(0xffffff, 1.75);
  key.position.set(110, 230, 150);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const sc = key.shadow.camera;
  sc.left = -130; sc.right = 130; sc.top = 130; sc.bottom = -130; sc.far = 600;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xa9c2ff, 0.65);
  fill.position.set(-160, 120, -140);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  rim.position.set(20, 60, -230);
  scene.add(rim);

  /* soft shadow catcher under the floating board */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900),
    new THREE.ShadowMaterial({ opacity: 0.32 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -7;
  floor.receiveShadow = true;
  scene.add(floor);

  const pickables: THREE.Mesh[] = [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(r: T): T => { disposables.push(r); return r; };
  const geo = <T extends THREE.BufferGeometry>(g: T): T => track(g);
  const mat = <T extends THREE.Material>(m: T): T => track(m);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0, cast = true) => {
    const me = new THREE.Mesh(g, m);
    me.position.set(x, y, z);
    me.castShadow = cast;
    scene.add(me);
    return me;
  };

  /* — PCB + silkscreen + feet — */
  const pcbMat = mat(std('#181d24', { roughness: 0.7 }));
  const pcb = mesh(geo(new THREE.BoxGeometry(BW, PCB_T, BH)), pcbMat, 0, PCB_T / 2, 0);
  pcb.receiveShadow = true;
  const silk = mesh(
    geo(new THREE.PlaneGeometry(BW, BH)),
    mat(new THREE.MeshStandardMaterial({ map: track(silkscreenTexture()), roughness: 0.72, metalness: 0.04 })),
    0, TOP + 0.02, 0, false,
  );
  silk.rotation.x = -Math.PI / 2;
  silk.receiveShadow = true;

  const holeG = geo(new THREE.CylinderGeometry(2, 2, PCB_T + 0.1, 20));
  const holeM = mat(std('#0c0e11', { roughness: 0.4 }));
  const footG = geo(new THREE.CylinderGeometry(3, 3.4, 5.4, 20));
  const footM = mat(std('#1a1b1f', { roughness: 0.9 }));
  for (const [hx, hz] of [[-75, -52], [75, -52], [-75, 52], [75, 52]] as const) {
    mesh(holeG, holeM, hx, PCB_T / 2, hz, false);
    mesh(footG, footM, hx, -2.7, hz);
  }

  /* — slide switches — */
  const swBodyG = geo(new THREE.BoxGeometry(4.6, 3.4, 9));
  const swBodyM = mat(std('#23262c', { roughness: 0.5 }));
  const swKnobG = geo(new THREE.BoxGeometry(3.1, 2.4, 3.3));
  const swKnobM = mat(std('#e9e5da', { roughness: 0.45 }));
  const swKnobs: THREE.Mesh[] = [];
  for (let i = 0; i < 16; i++) {
    const body = mesh(swBodyG, swBodyM, swX(i), TOP + 1.7, SW_Z);
    const knob = mesh(swKnobG, swKnobM, swX(i), TOP + 3.4 + 0.6, SW_Z + 2.3);
    body.userData = knob.userData = { kind: 'sw', i };
    pickables.push(body, knob);
    swKnobs.push(knob);
  }

  /* — user LEDs — */
  const ledG = geo(new THREE.BoxGeometry(2.3, 1, 1.5));
  const ledMats: THREE.MeshStandardMaterial[] = [];
  for (let i = 0; i < 16; i++) {
    const m = mat(std('#1f2b20', { roughness: 0.35, emissive: '#52ff6a', emissiveIntensity: 0 }));
    ledMats.push(m);
    mesh(ledG, m, swX(i), TOP + 0.5, LED_Z, false);
  }

  /* — 4-digit 7-segment display (AN3 left … AN0 right) — */
  const segHouse = mesh(geo(new THREE.BoxGeometry(48, 6.4, 17.5)), mat(std('#25262b', { roughness: 0.5 })), SEG_CX, TOP + 3.2, SEG_CZ);
  segHouse.castShadow = true;
  const segWin = mesh(geo(new THREE.PlaneGeometry(46, 15.5)), mat(std('#141417', { roughness: 0.3 })), SEG_CX, TOP + 6.4 + 0.03, SEG_CZ, false);
  segWin.rotation.x = -Math.PI / 2;
  const segH = geo(new THREE.BoxGeometry(4.2, 0.3, 1.15));
  const segV = geo(new THREE.BoxGeometry(1.15, 0.3, 4.2));
  const segDot = geo(new THREE.BoxGeometry(1.1, 0.3, 1.1));
  /* local (x, z) + geometry per cathode CA…CG, dp */
  const SEG_LAYOUT: [number, number, THREE.BufferGeometry][] = [
    [0, -4.7, segH],   // CA top
    [2.65, -2.35, segV],  // CB top-right
    [2.65, 2.35, segV],   // CC bottom-right
    [0, 4.7, segH],    // CD bottom
    [-2.65, 2.35, segV],  // CE bottom-left
    [-2.65, -2.35, segV], // CF top-left
    [0, 0, segH],      // CG middle
    [4.5, 5.2, segDot],   // dp
  ];
  const segMats: THREE.MeshStandardMaterial[][] = [];
  for (let a = 0; a < 4; a++) {
    const cx = SEG_CX + (1.5 - a) * SEG_PITCH;
    const mats: THREE.MeshStandardMaterial[] = [];
    SEG_LAYOUT.forEach(([lx, lz, gg]) => {
      const m = mat(std('#2b1613', { roughness: 0.4, emissive: '#ff3b2a', emissiveIntensity: 0 }));
      mats.push(m);
      mesh(gg, m, cx + lx, TOP + 6.4 + 0.2, SEG_CZ + lz, false);
    });
    segMats.push(mats);
  }

  /* — push buttons — */
  const btnBaseG = geo(new THREE.BoxGeometry(9.2, 2.1, 9.2));
  const btnBaseM = mat(std('#191a1e', { roughness: 0.55 }));
  const btnPlateG = geo(new THREE.BoxGeometry(8.6, 0.5, 8.6));
  const btnPlateM = mat(std('#a4a9b2', { roughness: 0.35, metalness: 0.7 }));
  const btnCapG = geo(new THREE.CylinderGeometry(2.7, 2.7, 2.4, 26));
  const btnCapM = mat(std('#2b2c31', { roughness: 0.5 }));
  const btnCaps = new Map<BtnId, THREE.Mesh>();
  (Object.keys(BTN_POS) as BtnId[]).forEach(id => {
    const [bx, bz] = BTN_POS[id];
    const base = mesh(btnBaseG, btnBaseM, bx, TOP + 1.05, bz);
    mesh(btnPlateG, btnPlateM, bx, TOP + 2.2, bz, false);
    const cap = mesh(btnCapG, btnCapM, bx, TOP + 3.3, bz);
    base.userData = cap.userData = { kind: 'btn', id };
    pickables.push(base, cap);
    btnCaps.set(id, cap);
  });

  /* — power switch + status LEDs — */
  const pwrBody = mesh(geo(new THREE.BoxGeometry(6.4, 4.4, 11.5)), mat(std('#1c1d22', { roughness: 0.5 })), POWER_X, TOP + 2.2, POWER_Z);
  const pwrKnob = mesh(geo(new THREE.BoxGeometry(4.4, 2.6, 4.2)), mat(std('#d2493c', { roughness: 0.45 })), POWER_X, TOP + 4.4 + 0.7, POWER_Z + 2.6);
  pwrBody.userData = pwrKnob.userData = { kind: 'power' };
  pickables.push(pwrBody, pwrKnob);

  const statusG = geo(new THREE.BoxGeometry(2.1, 1, 1.4));
  const pwrLedM = mat(std('#2b1a18', { roughness: 0.35, emissive: '#ff5147', emissiveIntensity: 0 }));
  mesh(statusG, pwrLedM, POWER_X + 6, TOP + 0.5, POWER_Z, false);
  const doneLedM = mat(std('#1f2b20', { roughness: 0.35, emissive: '#52ff6a', emissiveIntensity: 0 }));
  mesh(statusG, doneLedM, 11.5, TOP + 0.5, -31.5, false);

  /* — PROG reset button (reconfigures the FPGA) — */
  const progBase = mesh(geo(new THREE.BoxGeometry(6, 1.8, 6)), btnBaseM, 64, TOP + 0.9, -40);
  const progCap = mesh(geo(new THREE.CylinderGeometry(1.8, 1.8, 1.8, 20)), btnCapM, 64, TOP + 2.6, -40);
  progBase.userData = progCap.userData = { kind: 'prog' };
  pickables.push(progBase, progCap);

  /* — Artix-7 package — */
  const chip = mesh(geo(new THREE.BoxGeometry(22, 2.2, 22)), [
    mat(std('#101216', { roughness: 0.45 })), mat(std('#101216', { roughness: 0.45 })),
    mat(new THREE.MeshStandardMaterial({ map: track(chipTexture()), roughness: 0.42 })),
    mat(std('#101216')), mat(std('#101216', { roughness: 0.45 })), mat(std('#101216', { roughness: 0.45 })),
  ], CHIP_X, TOP + 1.1, CHIP_Z);
  chip.castShadow = true;

  /* — connectors: micro-USB (PROG/UART), USB host, VGA — */
  const metal = mat(std('#b3b8c0', { roughness: 0.3, metalness: 0.85 }));
  const darkIn = mat(std('#0c0d10', { roughness: 0.5 }));
  mesh(geo(new THREE.BoxGeometry(8, 3, 6)), metal, -38, TOP + 1.5, -53.5);
  mesh(geo(new THREE.BoxGeometry(13.5, 6.8, 13)), metal, -8, TOP + 3.4, -51);
  mesh(geo(new THREE.BoxGeometry(11, 2.6, 1.2)), darkIn, -8, TOP + 4.4, -57.2, false);
  mesh(geo(new THREE.BoxGeometry(26, 9.5, 9)), metal, 48, TOP + 4.75, -52);
  mesh(geo(new THREE.BoxGeometry(19, 6.4, 1.4)), mat(std('#2f5fbe', { roughness: 0.5 })), 48, TOP + 4.75, -56.4, false);

  /* — Pmod headers on the side edges — */
  const pmodG = geo(new THREE.BoxGeometry(6.4, 7.6, 17));
  const pmodM = mat(std('#141519', { roughness: 0.55 }));
  const pmodFaceG = geo(new THREE.BoxGeometry(1, 5.8, 15.2));
  for (const [px, pz] of [[-77, -22], [-77, 8], [77, -22], [77, 8]] as const) {
    mesh(pmodG, pmodM, px, TOP + 3.8, pz);
    mesh(pmodFaceG, darkIn, px + (px < 0 ? -3 : 3), TOP + 3.8, pz, false);
  }

  /* — a few passives for flavor — */
  const capG = geo(new THREE.CylinderGeometry(1.5, 1.5, 3, 14));
  const capM = mat(std('#3a3f4a', { roughness: 0.4, metalness: 0.5 }));
  const icG = geo(new THREE.BoxGeometry(5, 1.2, 3.4));
  const icM = mat(std('#131418', { roughness: 0.5 }));
  for (const [cx, cz] of [[-24, -30], [16, -14], [-20, -6], [22, -28], [-40, -20]] as const) {
    mesh(capG, capM, cx, TOP + 1.5, cz);
  }
  for (const [cx, cz] of [[-45, -6], [-52, -22], [26, -4], [55, 30], [-8, 2]] as const) {
    mesh(icG, icM, cx, TOP + 0.6, cz);
  }

  /* ── camera orbit (drag rotate · wheel/pinch zoom · shift/right pan) ── */
  const target = new THREE.Vector3(0, 0, 2);
  let radius = 255, theta = -0.12, phi = 0.72;
  const applyCamera = () => {
    const sp = Math.sin(phi), cp = Math.cos(phi);
    camera.position.set(
      target.x + radius * sp * Math.sin(theta),
      target.y + radius * cp,
      target.z + radius * sp * Math.cos(theta),
    );
    camera.lookAt(target);
  };
  applyCamera();

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (ev: PointerEvent): THREE.Mesh | null => {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    return (hit?.object as THREE.Mesh) ?? null;
  };

  type Ptr = { x: number; y: number };
  const ptrs = new Map<number, Ptr>();
  let mode: 'none' | 'rotate' | 'pan' | 'pinch' = 'none';
  let heldBtn: BtnId | null = null;
  let pinchDist = 0;

  const el = renderer.domElement;
  const onDown = (ev: PointerEvent) => {
    el.setPointerCapture(ev.pointerId);
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      mode = 'pinch';
      return;
    }
    const hit = pick(ev);
    if (hit && ev.button === 0) {
      const u = hit.userData as { kind: string; i?: number; id?: BtnId };
      if (u.kind === 'sw') { opts.onToggleSwitch(u.i!); mode = 'none'; return; }
      if (u.kind === 'btn') { heldBtn = u.id!; opts.onButton(heldBtn, true); mode = 'none'; return; }
      if (u.kind === 'power') { opts.onTogglePower(); mode = 'none'; return; }
      if (u.kind === 'prog') { opts.onProg(); mode = 'none'; return; }
    }
    mode = ev.button === 2 || ev.shiftKey ? 'pan' : 'rotate';
  };
  const onMove = (ev: PointerEvent) => {
    const p = ptrs.get(ev.pointerId);
    if (!p) {
      // hover cursor feedback only while idle
      el.style.cursor = pick(ev) ? 'pointer' : 'grab';
      return;
    }
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.x = ev.clientX; p.y = ev.clientY;
    if (mode === 'pinch' && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) radius = Math.min(430, Math.max(70, radius * (pinchDist / d)));
      pinchDist = d;
      applyCamera();
      return;
    }
    if (mode === 'rotate') {
      theta -= dx * 0.0055;
      phi = Math.min(1.42, Math.max(0.12, phi - dy * 0.0055));
      applyCamera();
    } else if (mode === 'pan') {
      const s = radius * 0.0011;
      const fwd = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      target.addScaledVector(right, dx * s).addScaledVector(fwd, dy * s);
      target.x = Math.min(120, Math.max(-120, target.x));
      target.z = Math.min(100, Math.max(-100, target.z));
      applyCamera();
    }
  };
  const endPtr = (ev: PointerEvent) => {
    ptrs.delete(ev.pointerId);
    if (ptrs.size < 2 && mode === 'pinch') mode = 'none';
    if (ptrs.size === 0) mode = 'none';
    if (heldBtn) { opts.onButton(heldBtn, false); heldBtn = null; }
  };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    radius = Math.min(430, Math.max(70, radius * Math.exp(ev.deltaY * 0.0011)));
    applyCamera();
  };
  const onCtx = (ev: Event) => ev.preventDefault();
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', endPtr);
  el.addEventListener('pointercancel', endPtr);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onCtx);

  const resize = () => {
    const w = mount.clientWidth, h = mount.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(mount);

  /* ── per-frame: emulate, then mirror the shared state onto meshes ── */
  const v = opts.visual;
  let last = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;
    opts.onFrame(dt);

    const k = 1 - Math.exp(-dt / 45);        // snappy exponential ease
    for (let i = 0; i < 16; i++) {
      const knob = swKnobs[i];
      const tz = SW_Z + ((v.sw >> i) & 1 ? -2.3 : 2.3);
      knob.position.z += (tz - knob.position.z) * k;
      const duty = v.power ? v.ledDuty[i] : 0;
      ledMats[i].emissiveIntensity = duty > 0.002 ? 0.35 + 1.85 * duty : 0;
    }
    for (const [id, cap] of btnCaps) {
      const ty = TOP + (v.btn[id] ? 2.4 : 3.3);
      cap.position.y += (ty - cap.position.y) * k;
    }
    for (let a = 0; a < 4; a++) {
      const pat = v.power ? v.digitSegs[a] : 0;
      const mats = segMats[a];
      for (let s = 0; s < 8; s++) mats[s].emissiveIntensity = (pat >> s) & 1 ? 2 : 0;
    }
    const pz = POWER_Z + (v.power ? -2.6 : 2.6);
    pwrKnob.position.z += (pz - pwrKnob.position.z) * k;
    pwrLedM.emissiveIntensity = v.power ? 1.7 : 0;
    doneLedM.emissiveIntensity = v.power && v.done ? 1.7 : 0;

    renderer.render(scene, camera);
  });

  return {
    destroy() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', endPtr);
      el.removeEventListener('pointercancel', endPtr);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onCtx);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    },
  };
}
