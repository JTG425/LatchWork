/* ────────────────────────────────────────────────────────────────────
   Basys 3 board model — the specification side of the 3D FPGA sheet.

   Describes the Digilent Basys 3 (AMD Artix-7 XC7A35T-1CPG236C trainer
   board) resources and maps a compiled VHDL module's ports onto them,
   the way Digilent's Basys3_Master.xdc constraints file does: ports are
   matched by name (case-insensitive), so a `led : out std_logic_vector`
   port drives the 16 user LEDs, `sw` reads the slide switches, and so
   on. Pure data + logic — no three.js, no React — so it can be unit
   checked and imported by both the editor pane and the 3D renderer.
   ──────────────────────────────────────────────────────────────────── */

import { VhdlModule, VhdlPortInfo } from '@/lib/vhdl';

/* ── physical resources (names follow Basys3_Master.xdc) ────────── */

export type FpgaResource =
  | 'clk'    // 100 MHz system clock (pin W5) — emulated at a selectable rate
  | 'sw'     // 16 slide switches   SW15…SW0
  | 'btnC' | 'btnU' | 'btnL' | 'btnR' | 'btnD'   // 5 push buttons
  | 'led'    // 16 user LEDs        LD15…LD0
  | 'seg'    // 7-seg cathodes CA…CG, active low, shared across digits
  | 'dp'     // decimal point cathode, active low
  | 'an';    // 4 digit anodes AN3…AN0, active low

/* FPGA package pin sites, for the mapping readout (authentic XDC data) */
export const PIN_SITES: Record<FpgaResource, string[]> = {
  clk: ['W5'],
  sw: ['V17', 'V16', 'W16', 'W17', 'W15', 'V15', 'W14', 'W13', 'V2', 'T3', 'T2', 'R3', 'W2', 'U1', 'T1', 'R2'],
  btnC: ['U18'], btnU: ['T18'], btnL: ['W19'], btnR: ['T17'], btnD: ['U17'],
  led: ['U16', 'E19', 'U19', 'V19', 'W18', 'U15', 'U14', 'V14', 'V13', 'V3', 'W3', 'U3', 'P3', 'N3', 'P1', 'L1'],
  seg: ['W7', 'W6', 'U8', 'V8', 'U5', 'V5', 'U7'],
  dp: ['V7'],
  an: ['U2', 'U4', 'V4', 'W4'],
};

interface ResourceSpec {
  res: FpgaResource;
  dir: 'in' | 'out';
  maxBits: number;
  /* human description used in the mapping footer and error hints */
  what: string;
  /* extra accepted port names beyond the canonical one */
  aliases?: string[];
}

const RESOURCES: ResourceSpec[] = [
  { res: 'clk', dir: 'in', maxBits: 1, what: '100 MHz system clock', aliases: ['clock', 'clk100mhz', 'clk100'] },
  { res: 'sw', dir: 'in', maxBits: 16, what: 'slide switches', aliases: ['switches', 'switch'] },
  { res: 'btnC', dir: 'in', maxBits: 1, what: 'center push button' },
  { res: 'btnU', dir: 'in', maxBits: 1, what: 'up push button' },
  { res: 'btnL', dir: 'in', maxBits: 1, what: 'left push button' },
  { res: 'btnR', dir: 'in', maxBits: 1, what: 'right push button' },
  { res: 'btnD', dir: 'in', maxBits: 1, what: 'down push button' },
  { res: 'led', dir: 'out', maxBits: 16, what: 'user LEDs', aliases: ['leds'] },
  { res: 'seg', dir: 'out', maxBits: 8, what: '7-seg cathodes CA–CG · active low', aliases: ['sseg', 'cat', 'segments'] },
  { res: 'dp', dir: 'out', maxBits: 1, what: 'decimal point · active low' },
  { res: 'an', dir: 'out', maxBits: 4, what: 'digit anodes AN3–AN0 · active low', aliases: ['anode', 'anodes'] },
];

const RESOURCE_BY_NAME = new Map<string, ResourceSpec>();
for (const r of RESOURCES) {
  RESOURCE_BY_NAME.set(r.res.toLowerCase(), r);
  for (const a of r.aliases ?? []) RESOURCE_BY_NAME.set(a, r);
}

/* ── port → resource mapping (the "constraints file" step) ──────── */

export interface MappedPort {
  port: VhdlPortInfo;
  res: FpgaResource;
  what: string;
  /* pin sites this port actually occupies, MSB first, for the readout */
  sites: string;
}

export type FpgaMapResult =
  | { ok: true; map: MappedPort[] }
  | { ok: false; errors: string[] };

const siteLabel = (spec: ResourceSpec, bits: number): string => {
  const sites = PIN_SITES[spec.res];
  if (spec.res === 'seg' && bits === 8) return `${sites.join(' ')} + V7 (dp)`;
  const used = sites.slice(0, bits);
  return used.length > 4 ? `${used[used.length - 1]}…${used[0]}` : used.slice().reverse().join(' ');
};

/* Match every port of the module onto a board resource, Vivado-style:
   an unmatched port is an error (like an unconstrained pin), and so is
   a port wider than the physical resource. */
export function mapPortsToBoard(m: VhdlModule): FpgaMapResult {
  const errors: string[] = [];
  const map: MappedPort[] = [];
  const taken = new Set<FpgaResource>();
  for (const port of m.ports) {
    const spec = RESOURCE_BY_NAME.get(port.name.toLowerCase());
    if (!spec) {
      errors.push(`Port '${port.name}' matches no board resource — use the Basys 3 names: `
        + `clk, sw, btnC/btnU/btnL/btnR/btnD (in) · led, seg, dp, an (out).`);
      continue;
    }
    if (spec.dir !== port.dir) {
      errors.push(`Port '${port.name}' is '${port.dir}' but the board's ${spec.res} (${spec.what}) is an ${spec.dir === 'in' ? 'input' : 'output'}.`);
      continue;
    }
    if (port.bits > spec.maxBits) {
      errors.push(`Port '${port.name}' is ${port.bits} bits wide — the board's ${spec.res} has only ${spec.maxBits === 1 ? '1 pin' : `${spec.maxBits} pins`}.`);
      continue;
    }
    if (taken.has(spec.res)) {
      errors.push(`Two ports map onto the board's ${spec.res} — rename one of them.`);
      continue;
    }
    taken.add(spec.res);
    map.push({ port, res: spec.res, what: spec.what, sites: siteLabel(spec, port.bits) });
  }
  if (!errors.length && !map.some(p => p.port.dir === 'out')) {
    errors.push('Nothing to observe — add at least one output port (led, seg, dp or an).');
  }
  return errors.length ? { ok: false, errors } : { ok: true, map };
}

/* ── emulated clock rates ───────────────────────────────────────────
   A real Basys 3 clocks at 100 MHz; a browser can't. The emulator
   ticks the design at a selectable rate instead (label shown in the
   toolbar) and the achieved rate is reported live. */
export const FPGA_CLOCK_RATES = [
  { hz: 1, label: '1 Hz' },
  { hz: 8, label: '8 Hz' },
  { hz: 64, label: '64 Hz' },
  { hz: 512, label: '512 Hz' },
  { hz: 4096, label: '4 kHz' },
  { hz: 16384, label: '16 kHz' },
  { hz: 65536, label: '64 kHz' },
];
export const FPGA_DEFAULT_HZ = 16384;

/* ── starter design ─────────────────────────────────────────────────
   Written for the emulated clock: switches mirror onto the LEDs and a
   free-running counter shows hex on the multiplexed 7-seg display —
   the classic first Basys 3 lab. */
export const FPGA_TEMPLATE = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- Basys 3 starter: switches light the LEDs above them, and a hex
-- counter runs on the four-digit 7-segment display. Press the center
-- button (BTNC) to reset the count.
--
-- Port names are the board's constraint names (Basys3_Master.xdc):
--   clk = system clock (the toolbar sets the emulated rate)
--   sw/led = 16 switches & LEDs · btnC/U/L/R/D = push buttons
--   seg/dp/an = 7-seg cathodes & digit anodes, ACTIVE LOW
entity top is
  port (
    clk  : in  std_logic;
    btnC : in  std_logic;
    sw   : in  std_logic_vector(15 downto 0);
    led  : out std_logic_vector(15 downto 0);
    seg  : out std_logic_vector(6 downto 0);
    dp   : out std_logic;
    an   : out std_logic_vector(3 downto 0)
  );
end entity;

architecture rtl of top is
  signal prescale : unsigned(11 downto 0) := (others => '0');
  signal count    : unsigned(15 downto 0) := (others => '0');
  signal mux      : unsigned(7 downto 0)  := (others => '0');
  signal digit    : std_logic_vector(3 downto 0);
begin
  led <= sw;                      -- each switch drives its LED
  dp  <= '1';                     -- decimal points off (active low)

  process (clk)                   -- count up ~4x per second at 16 kHz
  begin
    if rising_edge(clk) then
      mux      <= mux + 1;
      prescale <= prescale + 1;
      if btnC = '1' then
        count <= (others => '0');
      elsif prescale = 0 then
        count <= count + 1;
      end if;
    end if;
  end process;

  -- scan the four digits fast enough to look steady
  an <= "1110" when mux(7 downto 6) = "00" else
        "1101" when mux(7 downto 6) = "01" else
        "1011" when mux(7 downto 6) = "10" else
        "0111";

  digit <= std_logic_vector(count(3 downto 0))   when mux(7 downto 6) = "00" else
           std_logic_vector(count(7 downto 4))   when mux(7 downto 6) = "01" else
           std_logic_vector(count(11 downto 8))  when mux(7 downto 6) = "10" else
           std_logic_vector(count(15 downto 12));

  -- hex digit to cathodes CA..CG (seg(0)=CA), active low
  with digit select seg <=
    "1000000" when "0000", "1111001" when "0001",
    "0100100" when "0010", "0110000" when "0011",
    "0011001" when "0100", "0010010" when "0101",
    "0000010" when "0110", "1111000" when "0111",
    "0000000" when "1000", "0010000" when "1001",
    "0001000" when "1010", "0000011" when "1011",
    "1000110" when "1100", "0100001" when "1101",
    "0000110" when "1110", "0001110" when others;
end architecture;
`;
