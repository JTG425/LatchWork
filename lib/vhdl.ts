/* ────────────────────────────────────────────────────────────────────
   VHDL module compiler + evaluator.

   Compiles a practical synthesizable subset of VHDL into an executable
   model that plugs into the simulation engine as a chip (see
   evalChip in lib/engine.ts). Deliberately imports nothing from the
   engine so the two files can't form an import cycle.

   Supported subset
   ────────────────
   · entity … is port ( … ); end;   — in/out ports
   · types: std_logic, std_ulogic, bit, boolean (1 bit);
     std_logic_vector / bit_vector / unsigned / signed (N downto M | M to N);
     integer [range a to b], natural, positive; user enum types
     (type state_t is (idle, run);) for FSM states
   · generic ( N : integer := 8 ) — defaults only (no per-instance override)
   · architecture with signal/constant/type declarations (with := init)
   · concurrent statements: simple, conditional (when/else) and selected
     (with … select) signal assignment
   · process (sens) with if/elsif/else, case/when (incl. others and
     choice lists c1 | c2), signal (<=) and variable (:=) assignment, null
   · clock edges: rising_edge(s), falling_edge(s), s'event
   · operators: and or nand nor xor xnor not, = /= < <= > >=,
     sll srl, + - & (concat), * / mod rem, unary -; unsigned semantics
   · calls treated as conversions/no-ops: to_integer, to_unsigned,
     to_signed, unsigned, signed, std_logic_vector, resize,
     shift_left, shift_right
   · literals: '0'/'1', "0101", x"AF" / o"17" / b"1010", 16#FF#,
     integers, (others => '0'/'1')

   Not supported (compile errors): inout ports, wait statements,
   for/while loops, generate, tri-state ('Z'), signed arithmetic
   semantics (operands are evaluated as unsigned), records, arrays
   other than the bit-vector kinds above.
   ──────────────────────────────────────────────────────────────────── */

export interface VhdlPortInfo { name: string; dir: 'in' | 'out'; bits: number }
export interface VhdlCompileError { line: number; message: string }

export const VHDL_MAX_BITS = 64;

/* ── runtime model ──────────────────────────────────────────────── */

interface Ctx {
  sig: Map<string, bigint>;
  vars: Map<string, bigint> | null;
  rise: Set<string>;      // signals with an active rising edge this pass
  fall: Set<string>;
  changed: Set<string>;   // signals with any 'event this pass
}

interface CExpr { w: number; f(ctx: Ctx): bigint }

type Target =
  | { kind: 'whole'; name: string }
  | { kind: 'index'; name: string; idx: CExpr }
  | { kind: 'slice'; name: string; hi: number; lo: number };

/* One staged signal write (VHDL: signal assignments inside a process
   take effect when the process suspends, so reads see old values). */
class Pending {
  staged = new Map<string, bigint>();
  constructor(private m: VhdlModule, private ctx: Ctx) {}
  private cur(name: string): bigint {
    return this.staged.get(name) ?? this.ctx.sig.get(name) ?? 0n;
  }
  write(t: Target, val: bigint) {
    const w = this.m.widths[t.name];
    if (t.kind === 'whole') {
      this.staged.set(t.name, maskW(val, w));
    } else if (t.kind === 'index') {
      const i = Number(t.idx.f(this.ctx));
      if (i < 0 || i >= w) return;
      const b = 1n << BigInt(i);
      this.staged.set(t.name, (this.cur(t.name) & ~b) | ((val & 1n) ? b : 0n));
    } else {
      const span = t.hi - t.lo + 1;
      const m = ((1n << BigInt(span)) - 1n) << BigInt(t.lo);
      this.staged.set(t.name, (this.cur(t.name) & ~m) | ((maskW(val, span)) << BigInt(t.lo)));
    }
  }
  commit(): boolean {
    let changed = false;
    for (const [k, v] of this.staged) {
      if ((this.ctx.sig.get(k) ?? 0n) !== v) { this.ctx.sig.set(k, v); changed = true; }
    }
    this.staged.clear();
    return changed;
  }
}

type SeqStmt = (ctx: Ctx, out: Pending) => void;

interface Proc {
  /* variables declared in the process (lowercased name → width) */
  vars: Record<string, number>;
  body: SeqStmt[];
}

export interface VhdlModule {
  name: string;
  ports: VhdlPortInfo[];
  /* every signal (ports first), lowercased, in canonical order — the
     order prev-samples are stored in for edge detection */
  sigs: string[];
  widths: Record<string, number>;
  init: Record<string, bigint>;
  concurrent: { target: Target; expr: CExpr }[];
  processes: Proc[];
  /* true when any expression samples edges — enables prev tracking */
  usesEdges: boolean;
}

const maskW = (v: bigint, w: number): bigint => v & ((1n << BigInt(Math.max(1, Math.min(VHDL_MAX_BITS, w)))) - 1n);

/* ── lexer ──────────────────────────────────────────────────────── */

interface Tok { k: 'id' | 'num' | 'char' | 'bits' | 'sym' | 'eof'; v: string; raw: string; line: number; n: bigint; w: number }

class VErr extends Error {
  constructor(public line: number, message: string) { super(message); }
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (k: Tok['k'], v: string, raw = v, num = 0n, w = 0) =>
    toks.push({ k, v, raw, line, n: num, w });

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '-' && src[i + 1] === '-') {           // comment to end of line
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      // bit-string literal: x"AF", b"0101", o"17" (no space before quote)
      if (j < n && src[j] === '"' && /^[xob]$/i.test(raw)) {
        const q = src.indexOf('"', j + 1);
        if (q < 0) throw new VErr(line, 'Unterminated bit-string literal.');
        const digits = src.slice(j + 1, q).replace(/_/g, '');
        const base = raw.toLowerCase() === 'x' ? 16 : raw.toLowerCase() === 'o' ? 8 : 2;
        const perDigit = base === 16 ? 4 : base === 8 ? 3 : 1;
        let v = 0n;
        for (const d of digits) {
          const dv = parseInt(d, base);
          if (Number.isNaN(dv)) throw new VErr(line, `Bad digit '${d}' in ${raw}"${digits}".`);
          v = v * BigInt(base) + BigInt(dv);
        }
        push('bits', digits, raw + '"' + digits + '"', v, digits.length * perDigit);
        i = q + 1;
        continue;
      }
      push('id', raw.toLowerCase(), raw);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9_]/.test(src[j])) j++;
      const digits = src.slice(i, j).replace(/_/g, '');
      // based literal 16#FF#
      if (src[j] === '#') {
        const close = src.indexOf('#', j + 1);
        if (close < 0) throw new VErr(line, 'Unterminated based literal.');
        const base = parseInt(digits, 10);
        const body = src.slice(j + 1, close).replace(/_/g, '');
        let v = 0n;
        for (const d of body) {
          const dv = parseInt(d, base);
          if (Number.isNaN(dv)) throw new VErr(line, `Bad digit '${d}' for base ${base}.`);
          v = v * BigInt(base) + BigInt(dv);
        }
        push('num', body, digits + '#' + body + '#', v, 0);
        i = close + 1;
        continue;
      }
      if (src[j] === '.') throw new VErr(line, 'Real (floating point) literals are not supported.');
      push('num', digits, digits, BigInt(digits), 0);
      i = j;
      continue;
    }
    if (c === '"') {                                 // "0101" bit vector
      const q = src.indexOf('"', i + 1);
      if (q < 0) throw new VErr(line, 'Unterminated string literal.');
      const bits = src.slice(i + 1, q).replace(/_/g, '');
      let v = 0n;
      for (const b of bits) {
        if (b !== '0' && b !== '1') {
          if (/[zxuwlh-]/i.test(b)) throw new VErr(line, `'${b.toUpperCase()}' values are not supported — only '0' and '1'.`);
          throw new VErr(line, `Bad bit '${b}' in "${bits}".`);
        }
        v = (v << 1n) | (b === '1' ? 1n : 0n);
      }
      push('bits', bits, '"' + bits + '"', v, bits.length);
      i = q + 1;
      continue;
    }
    if (c === "'") {
      // char literal only when '<c>' closes and the previous token isn't
      // a name (otherwise it's an attribute tick: clk'event). Keywords
      // (else, when, and, …) don't count as names — '1' after them is a
      // character literal.
      const prev = toks[toks.length - 1];
      const attrPos = prev && ((prev.k === 'id' && !RESERVED.has(prev.v)) || (prev.k === 'sym' && prev.v === ')'));
      if (!attrPos && src[i + 2] === "'") {
        const ch = src[i + 1];
        if (ch !== '0' && ch !== '1') {
          throw new VErr(line, `'${ch.toUpperCase()}' values are not supported — only '0' and '1'.`);
        }
        push('char', ch, `'${ch}'`, ch === '1' ? 1n : 0n, 1);
        i += 3;
        continue;
      }
      push('sym', "'");
      i++;
      continue;
    }
    const three = src.slice(i, i + 2);
    if (three === '<=' || three === '>=' || three === '/=' || three === '=>' || three === ':=' || three === '**') {
      push('sym', three);
      i += 2;
      continue;
    }
    if ('();:,&+-*/=<>|.'.includes(c)) { push('sym', c); i++; continue; }
    throw new VErr(line, `Unexpected character '${c}'.`);
  }
  push('eof', '<eof>');
  return toks;
}

/* ── parser / compiler ──────────────────────────────────────────── */

const RESERVED = new Set([
  'abs', 'access', 'after', 'alias', 'all', 'and', 'architecture', 'array', 'assert', 'attribute',
  'begin', 'block', 'body', 'buffer', 'bus', 'case', 'component', 'configuration', 'constant',
  'disconnect', 'downto', 'else', 'elsif', 'end', 'entity', 'exit', 'file', 'for', 'function',
  'generate', 'generic', 'group', 'guarded', 'if', 'impure', 'in', 'inertial', 'inout', 'is',
  'label', 'library', 'linkage', 'literal', 'loop', 'map', 'mod', 'nand', 'new', 'next', 'nor',
  'not', 'null', 'of', 'on', 'open', 'or', 'others', 'out', 'package', 'port', 'postponed',
  'procedure', 'process', 'pure', 'range', 'record', 'register', 'reject', 'rem', 'report',
  'return', 'rol', 'ror', 'select', 'severity', 'shared', 'signal', 'sla', 'sll', 'sra', 'srl',
  'subtype', 'then', 'to', 'transport', 'type', 'unaffected', 'units', 'until', 'use', 'variable',
  'wait', 'when', 'while', 'with', 'xnor', 'xor',
]);

const CONVERSION_FNS = new Set([
  'to_integer', 'to_unsigned', 'to_signed', 'unsigned', 'signed',
  'std_logic_vector', 'std_ulogic_vector', 'to_stdlogicvector', 'to_bitvector', 'resize',
]);

class Compiler {
  toks: Tok[];
  p = 0;
  types = new Map<string, { width: number }>();
  enums = new Map<string, { v: bigint; w: number }>();    // enum literal → value/width
  consts = new Map<string, { v: bigint; w: number }>();
  widths: Record<string, number> = {};
  init: Record<string, bigint> = {};
  sigs: string[] = [];
  ports: VhdlPortInfo[] = [];
  concurrent: { target: Target; expr: CExpr }[] = [];
  processes: Proc[] = [];
  usesEdges = false;
  entityName = '';
  /* variables of the process currently being compiled */
  curVars: Record<string, number> | null = null;

  constructor(src: string) { this.toks = lex(src); }

  /* — token helpers — */
  peek(o = 0): Tok { return this.toks[Math.min(this.p + o, this.toks.length - 1)]; }
  next(): Tok { return this.toks[this.p < this.toks.length - 1 ? this.p++ : this.p]; }
  at(v: string): boolean { const t = this.peek(); return (t.k === 'sym' || t.k === 'id') && t.v === v; }
  eat(v: string): boolean { if (this.at(v)) { this.p++; return true; } return false; }
  expect(v: string, what?: string): Tok {
    const t = this.peek();
    if ((t.k === 'sym' || t.k === 'id') && t.v === v) return this.next();
    throw new VErr(t.line, `Expected '${v}'${what ? ` ${what}` : ''} but found '${t.raw}'.`);
  }
  ident(what: string): Tok {
    const t = this.peek();
    if (t.k !== 'id' || RESERVED.has(t.v)) throw new VErr(t.line, `Expected ${what} but found '${t.raw}'.`);
    return this.next();
  }
  /* skip to just past the next ';' (used for ignorable clauses) */
  skipStatement() { while (!this.at(';') && this.peek().k !== 'eof') this.p++; this.eat(';'); }

  /* — top level — */
  compile(): VhdlModule {
    while (this.peek().k !== 'eof') {
      const t = this.peek();
      if (t.k !== 'id') throw new VErr(t.line, `Expected a design unit but found '${t.raw}'.`);
      if (t.v === 'library' || t.v === 'use') { this.skipStatement(); continue; }
      if (t.v === 'entity') { this.parseEntity(); continue; }
      if (t.v === 'architecture') { this.parseArchitecture(); continue; }
      if (t.v === 'package') throw new VErr(t.line, 'Packages are not supported — put everything in one entity + architecture.');
      if (t.v === 'component' || t.v === 'configuration') throw new VErr(t.line, `'${t.raw}' declarations are not supported.`);
      throw new VErr(t.line, `Unexpected '${t.raw}' at the top level — expected entity or architecture.`);
    }
    if (!this.entityName) throw new VErr(1, 'No entity found — declare one with: entity NAME is port (…); end;');
    if (!this.ports.length) throw new VErr(1, 'The entity has no ports — add at least one in and one out port.');
    if (!this.ports.some(p => p.dir === 'out')) throw new VErr(1, 'The entity needs at least one out port.');
    return {
      name: this.entityName,
      ports: this.ports,
      sigs: this.sigs,
      widths: this.widths,
      init: this.init,
      concurrent: this.concurrent,
      processes: this.processes,
      usesEdges: this.usesEdges,
    };
  }

  declareSignal(name: string, width: number, line: number) {
    if (this.widths[name] !== undefined) throw new VErr(line, `'${name}' is declared twice.`);
    if (width < 1 || width > VHDL_MAX_BITS) throw new VErr(line, `'${name}' is ${width} bits wide — widths must be 1–${VHDL_MAX_BITS}.`);
    this.widths[name] = width;
    this.sigs.push(name);
  }

  parseEntity() {
    this.expect('entity');
    const nameTok = this.ident('an entity name');
    if (this.entityName) throw new VErr(nameTok.line, 'Only one entity per module is supported.');
    this.entityName = nameTok.raw;
    this.expect('is');
    if (this.at('generic')) this.parseGenerics();
    if (this.at('port')) this.parsePorts();
    this.expect('end');
    this.eat('entity');
    if (this.peek().k === 'id' && !RESERVED.has(this.peek().v)) this.next();
    this.expect(';');
  }

  parseGenerics() {
    this.expect('generic');
    this.expect('(');
    for (;;) {
      const names: Tok[] = [this.ident('a generic name')];
      while (this.eat(',')) names.push(this.ident('a generic name'));
      this.expect(':');
      this.parseTypeRef();     // generic types only matter through their default value
      const t = this.peek();
      if (!this.eat(':=')) throw new VErr(t.line, `Generic '${names[0].raw}' needs a default value (generics can't be overridden per instance yet).`);
      const val = this.constExpr();
      for (const nm of names) this.consts.set(nm.v, val);
      if (this.eat(';')) continue;
      this.expect(')');
      this.expect(';');
      return;
    }
  }

  parsePorts() {
    this.expect('port');
    this.expect('(');
    for (;;) {
      const names: Tok[] = [this.ident('a port name')];
      while (this.eat(',')) names.push(this.ident('a port name'));
      this.expect(':');
      const dirTok = this.peek();
      const dir = this.eat('in') ? 'in' : this.eat('out') ? 'out' : null;
      if (!dir) {
        if (this.eat('inout') || this.eat('buffer')) throw new VErr(dirTok.line, `'${dirTok.raw}' ports are not supported — use in or out.`);
        throw new VErr(dirTok.line, `Expected port direction (in / out) but found '${dirTok.raw}'.`);
      }
      const width = this.parseTypeRef();
      for (const nm of names) {
        this.declareSignal(nm.v, width, nm.line);
        this.ports.push({ name: nm.raw, dir, bits: width });
      }
      if (this.eat(';')) continue;
      this.expect(')');
      this.expect(';');
      return;
    }
  }

  /* type mark [+ constraint] → width in bits */
  parseTypeRef(): number {
    const t = this.ident('a type name');
    const base = t.v;
    if (base === 'std_logic' || base === 'std_ulogic' || base === 'bit' || base === 'boolean') return 1;
    if (base === 'std_logic_vector' || base === 'std_ulogic_vector' || base === 'bit_vector'
      || base === 'unsigned' || base === 'signed') {
      this.expect('(', `after ${t.raw}`);
      const a = this.constExpr();
      const desc = this.eat('downto') ? true : (this.expect('to'), false);
      const b = this.constExpr();
      this.expect(')');
      const hi = desc ? a.v : b.v, lo = desc ? b.v : a.v;
      if (lo !== 0n) throw new VErr(t.line, `Vector ranges must end at 0 (got ${desc ? `${a.v} downto ${b.v}` : `${a.v} to ${b.v}`}).`);
      return Number(hi - lo + 1n);
    }
    if (base === 'integer' || base === 'natural' || base === 'positive') {
      if (this.eat('range')) {
        this.constExpr();
        if (!this.eat('to') && !this.eat('downto')) throw new VErr(t.line, "Expected 'to' in integer range.");
        const hiV = this.constExpr().v;
        let w = 1;
        while ((1n << BigInt(w)) - 1n < hiV && w < VHDL_MAX_BITS) w++;
        return w;
      }
      return 32;
    }
    const custom = this.types.get(base);
    if (custom) return custom.width;
    throw new VErr(t.line, `Unknown type '${t.raw}'.`);
  }

  parseArchitecture() {
    this.expect('architecture');
    this.ident('an architecture name');
    this.expect('of');
    this.ident('the entity name');
    this.expect('is');

    /* declarations */
    for (;;) {
      const t = this.peek();
      if (t.v === 'begin') break;
      if (t.v === 'signal') { this.parseSignalDecl(); continue; }
      if (t.v === 'constant') { this.parseConstantDecl(); continue; }
      if (t.v === 'type') { this.parseTypeDecl(); continue; }
      if (t.v === 'component') throw new VErr(t.line, 'Component instantiation is not supported — describe the behavior directly.');
      if (t.v === 'function' || t.v === 'procedure') throw new VErr(t.line, 'Subprograms are not supported.');
      if (t.v === 'attribute' || t.v === 'use') { this.skipStatement(); continue; }
      throw new VErr(t.line, `Unexpected '${t.raw}' in the architecture declarations.`);
    }
    this.expect('begin');

    /* concurrent statements */
    for (;;) {
      const t = this.peek();
      if (t.v === 'end') break;
      if (t.k === 'eof') throw new VErr(t.line, "Missing 'end architecture;'.");
      this.parseConcurrent();
    }
    this.expect('end');
    this.eat('architecture');
    if (this.peek().k === 'id' && !RESERVED.has(this.peek().v)) this.next();
    this.expect(';');
  }

  parseSignalDecl() {
    this.expect('signal');
    const names: Tok[] = [this.ident('a signal name')];
    while (this.eat(',')) names.push(this.ident('a signal name'));
    this.expect(':');
    const width = this.parseTypeRef();
    let initV: bigint | null = null;
    if (this.eat(':=')) initV = maskW(this.constExpr().v, width);
    this.expect(';');
    for (const nm of names) {
      this.declareSignal(nm.v, width, nm.line);
      if (initV !== null) this.init[nm.v] = initV;
    }
  }

  parseConstantDecl() {
    this.expect('constant');
    const names: Tok[] = [this.ident('a constant name')];
    while (this.eat(',')) names.push(this.ident('a constant name'));
    this.expect(':');
    const width = this.parseTypeRef();
    this.expect(':=');
    const val = this.constExpr();
    this.expect(';');
    for (const nm of names) this.consts.set(nm.v, { v: maskW(val.v, width), w: width });
  }

  parseTypeDecl() {
    const kw = this.expect('type');
    const name = this.ident('a type name');
    this.expect('is');
    if (!this.eat('(')) throw new VErr(kw.line, 'Only enumeration types are supported (type t is (a, b, …);).');
    const lits: Tok[] = [this.ident('an enum literal')];
    while (this.eat(',')) lits.push(this.ident('an enum literal'));
    this.expect(')');
    this.expect(';');
    const width = Math.max(1, Math.ceil(Math.log2(Math.max(2, lits.length))));
    this.types.set(name.v, { width });
    lits.forEach((l, i) => {
      if (this.enums.has(l.v) || this.consts.has(l.v)) throw new VErr(l.line, `'${l.raw}' is declared twice.`);
      this.enums.set(l.v, { v: BigInt(i), w: width });
    });
  }

  /* — constant expressions (widths, generics, choices) — */
  constExpr(): { v: bigint; w: number } {
    const line = this.peek().line;
    const e = this.expr();
    try {
      return { v: e.f(probeCtx()), w: e.w };
    } catch {
      throw new VErr(line, 'Expected a constant expression here.');
    }
  }

  /* — concurrent statements — */
  parseConcurrent() {
    const t = this.peek();

    // optional statement label (lbl: …) — ':=' lexes as one token, so a
    // bare ':' after a name can only be a label here
    if (t.k === 'id' && !RESERVED.has(t.v) && this.peek(1).k === 'sym' && this.peek(1).v === ':') {
      this.next(); this.next();
    }

    if (this.at('process')) { this.parseProcess(); return; }

    if (this.at('with')) {                       // with sel select target <= …
      this.next();
      const sel = this.expr();
      this.expect('select');
      const target = this.parseTarget();
      this.expect('<=');
      const arms: { choices: bigint[] | null; e: CExpr }[] = [];
      for (;;) {
        const e = this.expr();
        this.expect('when');
        const choices = this.parseChoices(sel.w);
        arms.push({ choices, e });
        if (this.eat(',')) continue;
        this.expect(';');
        break;
      }
      const w = Math.max(1, ...arms.map(a => a.e.w));
      this.concurrent.push({
        target,
        expr: {
          w,
          f: ctx => {
            const s = sel.f(ctx);
            for (const a of arms) {
              if (!a.choices || a.choices.some(c => c === s)) return a.e.f(ctx);
            }
            return 0n;
          },
        },
      });
      return;
    }

    if (t.v === 'assert' || t.v === 'report') { this.skipStatement(); return; }
    if (t.v === 'for' || t.v === 'generate') throw new VErr(t.line, 'generate statements are not supported.');

    // simple / conditional assignment: target <= e [when cond else e …];
    const target = this.parseTarget();
    this.expect('<=');
    const expr = this.parseWaveform();
    this.expect(';');
    this.concurrent.push({ target, expr });
  }

  /* expr [when cond else expr [when cond else …]] */
  parseWaveform(): CExpr {
    const first = this.expr();
    if (!this.at('when')) return first;
    const arms: { cond: CExpr | null; e: CExpr }[] = [{ cond: null, e: first }];
    while (this.eat('when')) {
      const cond = this.expr();
      this.expect('else');
      arms[arms.length - 1].cond = cond;
      arms.push({ cond: null, e: this.expr() });
    }
    const w = Math.max(1, ...arms.map(a => a.e.w));
    return {
      w,
      f: ctx => {
        for (const a of arms) if (!a.cond || a.cond.f(ctx)) return a.e.f(ctx);
        return 0n;
      },
    };
  }

  parseTarget(): Target {
    const nm = this.ident('a signal name');
    const name = nm.v;
    if (this.curVars?.[name] === undefined && this.widths[name] === undefined) {
      throw new VErr(nm.line, `'${nm.raw}' is not a declared signal.`);
    }
    if (this.eat('(')) {
      const a = this.expr();
      if (this.at('downto') || this.at('to')) {
        const desc = this.eat('downto') || (this.expect('to'), false);
        const b = this.expr();
        this.expect(')');
        let av: bigint, bv: bigint;
        try { av = a.f(probeCtx()); bv = b.f(probeCtx()); } catch { throw new VErr(nm.line, 'Slice bounds must be constant.'); }
        const hi = Number(desc ? av : bv), lo = Number(desc ? bv : av);
        return { kind: 'slice', name, hi, lo };
      }
      this.expect(')');
      return { kind: 'index', name, idx: a };
    }
    return { kind: 'whole', name };
  }

  /* when choices: literal | literal | others */
  parseChoices(selW: number): bigint[] | null {
    if (this.eat('others')) return null;
    const list: bigint[] = [];
    for (;;) {
      const c = this.constExpr();
      list.push(maskW(c.v, Math.max(selW, c.w || 1)));
      if (!this.eat('|')) return list;
    }
  }

  /* — processes — */
  parseProcess() {
    this.expect('process');
    if (this.eat('(')) {         // sensitivity list — parsed, not needed
      if (!this.eat(')')) {
        for (;;) {
          if (this.eat('all')) { /* process(all) */ } else this.ident('a signal name');
          if (this.eat(',')) continue;
          this.expect(')');
          break;
        }
      }
    }
    this.eat('is');

    const vars: Record<string, number> = {};
    this.curVars = vars;
    while (!this.at('begin')) {
      const t = this.peek();
      if (t.v === 'variable') {
        this.next();
        const names: Tok[] = [this.ident('a variable name')];
        while (this.eat(',')) names.push(this.ident('a variable name'));
        this.expect(':');
        const width = this.parseTypeRef();
        if (this.eat(':=')) this.constExpr();   // initial value re-applied as 0 default
        this.expect(';');
        for (const nm of names) {
          if (vars[nm.v] !== undefined || this.widths[nm.v] !== undefined) throw new VErr(nm.line, `'${nm.raw}' is declared twice.`);
          vars[nm.v] = width;
        }
        continue;
      }
      if (t.v === 'constant') { this.parseConstantDecl(); continue; }
      if (t.v === 'type') { this.parseTypeDecl(); continue; }
      throw new VErr(t.line, `Unexpected '${t.raw}' in process declarations.`);
    }
    this.expect('begin');
    const body = this.parseSeqBody(['end']);
    this.expect('end');
    this.expect('process');
    if (this.peek().k === 'id' && !RESERVED.has(this.peek().v)) this.next();
    this.expect(';');
    this.curVars = null;
    this.processes.push({ vars, body });
  }

  parseSeqBody(stops: string[]): SeqStmt[] {
    const out: SeqStmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === 'eof') throw new VErr(t.line, "Unexpected end of file inside a process.");
      if (stops.includes(t.v)) return out;
      out.push(this.parseSeqStmt());
    }
  }

  parseSeqStmt(): SeqStmt {
    const t = this.peek();

    if (t.v === 'null') { this.next(); this.expect(';'); return () => {}; }
    if (t.v === 'wait') throw new VErr(t.line, 'wait statements are not supported — use a sensitivity list and rising_edge().');
    if (t.v === 'for' || t.v === 'while' || t.v === 'loop') throw new VErr(t.line, 'Loops are not supported yet.');
    if (t.v === 'report' || t.v === 'assert') { this.skipStatement(); return () => {}; }

    if (t.v === 'if') {
      this.next();
      const arms: { cond: CExpr | null; body: SeqStmt[] }[] = [];
      let cond = this.expr();
      this.expect('then');
      arms.push({ cond, body: this.parseSeqBody(['elsif', 'else', 'end']) });
      while (this.eat('elsif')) {
        cond = this.expr();
        this.expect('then');
        arms.push({ cond, body: this.parseSeqBody(['elsif', 'else', 'end']) });
      }
      if (this.eat('else')) arms.push({ cond: null, body: this.parseSeqBody(['end']) });
      this.expect('end');
      this.expect('if');
      this.expect(';');
      return (ctx, out) => {
        for (const a of arms) {
          if (!a.cond || a.cond.f(ctx)) {
            for (const s of a.body) s(ctx, out);
            return;
          }
        }
      };
    }

    if (t.v === 'case') {
      this.next();
      const sel = this.expr();
      this.expect('is');
      const arms: { choices: bigint[] | null; body: SeqStmt[] }[] = [];
      while (this.eat('when')) {
        const choices = this.parseChoices(sel.w);
        this.expect('=>');
        arms.push({ choices, body: this.parseSeqBody(['when', 'end']) });
      }
      this.expect('end');
      this.expect('case');
      this.expect(';');
      return (ctx, out) => {
        const s = sel.f(ctx);
        for (const a of arms) {
          if (!a.choices || a.choices.some(c => c === s)) {
            for (const st of a.body) st(ctx, out);
            return;
          }
        }
      };
    }

    // assignment: target <= expr; (signal) or target := expr; (variable)
    const target = this.parseTarget();
    if (this.eat(':=')) {
      const w = this.curVars?.[target.name];
      if (w === undefined) throw new VErr(t.line, `':=' assigns variables — '${target.name}' is a signal (use '<=').`);
      const e = this.expr();
      this.expect(';');
      return (ctx) => {
        if (!ctx.vars) return;
        const cur = ctx.vars.get(target.name) ?? 0n;
        let nv: bigint;
        if (target.kind === 'whole') nv = maskW(e.f(ctx), w);
        else if (target.kind === 'index') {
          const i = Number(target.idx.f(ctx));
          const b = 1n << BigInt(i);
          nv = (cur & ~b) | ((e.f(ctx) & 1n) ? b : 0n);
        } else {
          const span = target.hi - target.lo + 1;
          const m = ((1n << BigInt(span)) - 1n) << BigInt(target.lo);
          nv = (cur & ~m) | (maskW(e.f(ctx), span) << BigInt(target.lo));
        }
        ctx.vars.set(target.name, nv);
      };
    }
    this.expect('<=', `after '${target.name}'`);
    if (this.widths[target.name] === undefined) throw new VErr(t.line, `'<=' assigns signals — '${target.name}' is a variable (use ':=').`);
    const e = this.expr();
    this.expect(';');
    return (ctx, out) => out.write(target, e.f(ctx));
  }

  /* — expressions (VHDL precedence) — */
  expr(): CExpr { return this.logicalExpr(); }

  logicalExpr(): CExpr {
    let a = this.relExpr();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'id' || !['and', 'or', 'nand', 'nor', 'xor', 'xnor'].includes(t.v)) return a;
      this.next();
      const b = this.relExpr();
      const w = Math.max(a.w, b.w, 1);
      const mask = (1n << BigInt(w)) - 1n;
      const af = a.f, bf = b.f;
      const f: Record<string, (x: bigint, y: bigint) => bigint> = {
        and: (x, y) => x & y,
        or: (x, y) => x | y,
        nand: (x, y) => ~(x & y) & mask,
        nor: (x, y) => ~(x | y) & mask,
        xor: (x, y) => x ^ y,
        xnor: (x, y) => ~(x ^ y) & mask,
      };
      const op = f[t.v];
      a = { w, f: ctx => op(af(ctx), bf(ctx)) };
    }
  }

  relExpr(): CExpr {
    const a = this.shiftExpr();
    const t = this.peek();
    if (t.k !== 'sym' || !['=', '/=', '<', '<=', '>', '>='].includes(t.v)) return a;
    this.next();
    const b = this.shiftExpr();
    const af = a.f, bf = b.f;
    const cmp: Record<string, (x: bigint, y: bigint) => boolean> = {
      '=': (x, y) => x === y, '/=': (x, y) => x !== y,
      '<': (x, y) => x < y, '<=': (x, y) => x <= y,
      '>': (x, y) => x > y, '>=': (x, y) => x >= y,
    };
    const op = cmp[t.v];
    return { w: 1, f: ctx => (op(af(ctx), bf(ctx)) ? 1n : 0n) };
  }

  shiftExpr(): CExpr {
    let a = this.addExpr();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'id' || !['sll', 'srl', 'sla', 'sra', 'rol', 'ror'].includes(t.v)) return a;
      if (t.v !== 'sll' && t.v !== 'srl') throw new VErr(t.line, `'${t.raw}' is not supported — use sll / srl.`);
      this.next();
      const b = this.addExpr();
      const mw = a.w || VHDL_MAX_BITS;
      const af = a.f, bf = b.f;
      a = t.v === 'sll'
        ? { w: a.w, f: ctx => maskW(af(ctx) << bf(ctx), mw) }
        : { w: a.w, f: ctx => af(ctx) >> bf(ctx) };
    }
  }

  addExpr(): CExpr {
    let a = this.mulExpr();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'sym' || !['+', '-', '&'].includes(t.v)) return a;
      this.next();
      const b = this.mulExpr();
      const af = a.f, bf = b.f;
      if (t.v === '&') {
        const bw = b.w || 1;
        a = { w: Math.min(VHDL_MAX_BITS, (a.w || 1) + bw), f: ctx => (af(ctx) << BigInt(bw)) | maskW(bf(ctx), bw) };
      } else {
        // width 0 = universal integer: stays universal so it doesn't
        // truncate sized operands (result masks at the 64-bit ceiling)
        const w = Math.min(VHDL_MAX_BITS, Math.max(a.w, b.w));
        const mw = w || VHDL_MAX_BITS;
        a = t.v === '+'
          ? { w, f: ctx => maskW(af(ctx) + bf(ctx), mw) }
          : { w, f: ctx => maskW(af(ctx) - bf(ctx), mw) };
      }
    }
  }

  mulExpr(): CExpr {
    let a = this.unaryExpr();
    for (;;) {
      const t = this.peek();
      const isSym = t.k === 'sym' && (t.v === '*' || t.v === '/');
      const isKw = t.k === 'id' && (t.v === 'mod' || t.v === 'rem');
      if (!isSym && !isKw) return a;
      this.next();
      const b = this.unaryExpr();
      const w = Math.min(VHDL_MAX_BITS, Math.max(a.w, b.w));
      const mw = w || VHDL_MAX_BITS;
      const af = a.f, bf = b.f;
      if (t.v === '*') a = { w, f: ctx => maskW(af(ctx) * bf(ctx), mw) };
      else if (t.v === '/') a = { w, f: ctx => { const d = bf(ctx); return d ? af(ctx) / d : 0n; } };
      else a = { w, f: ctx => { const d = bf(ctx); return d ? af(ctx) % d : 0n; } };
    }
  }

  unaryExpr(): CExpr {
    const t = this.peek();
    if (t.k === 'id' && t.v === 'not') {
      this.next();
      const a = this.unaryExpr();
      const w = a.w || 1;
      const mask = (1n << BigInt(w)) - 1n;
      const af = a.f;
      return { w, f: ctx => ~af(ctx) & mask };
    }
    if (t.k === 'sym' && t.v === '-') {
      this.next();
      const a = this.unaryExpr();
      const mw = a.w || VHDL_MAX_BITS;   // stays universal when the operand is
      const af = a.f;
      return { w: a.w, f: ctx => maskW(-af(ctx), mw) };
    }
    if (t.k === 'sym' && t.v === '+') { this.next(); return this.unaryExpr(); }
    if (t.k === 'id' && t.v === 'abs') { this.next(); return this.unaryExpr(); }   // unsigned: identity
    return this.primary();
  }

  primary(): CExpr {
    const t = this.peek();

    if (t.k === 'num') { this.next(); return { w: 0, f: () => t.n }; }
    if (t.k === 'char') { this.next(); return { w: 1, f: () => t.n }; }
    if (t.k === 'bits') { this.next(); return { w: t.w, f: () => t.n }; }

    if (t.k === 'sym' && t.v === '(') {
      // aggregate (others => '0'|'1') or parenthesized expression
      if (this.peek(1).v === 'others') {
        this.next(); this.next();
        this.expect('=>');
        const v = this.expr();
        this.expect(')');
        const vf = v.f;
        // width adapts to the assignment context at write time: emit the
        // widest possible fill; Pending.write masks to the target width
        return { w: VHDL_MAX_BITS, f: ctx => (vf(ctx) & 1n) ? (1n << BigInt(VHDL_MAX_BITS)) - 1n : 0n };
      }
      this.next();
      const e = this.expr();
      this.expect(')');
      return e;
    }

    if (t.k === 'id') {
      if (t.v === 'true') { this.next(); return { w: 1, f: () => 1n }; }
      if (t.v === 'false') { this.next(); return { w: 1, f: () => 0n }; }
      if (RESERVED.has(t.v)) throw new VErr(t.line, `Unexpected '${t.raw}' in an expression.`);

      /* rising_edge / falling_edge */
      if ((t.v === 'rising_edge' || t.v === 'falling_edge') && this.peek(1).v === '(') {
        this.next(); this.next();
        const sig = this.ident('a signal name');
        if (this.widths[sig.v] === undefined) throw new VErr(sig.line, `'${sig.raw}' is not a declared signal.`);
        this.expect(')');
        this.usesEdges = true;
        const name = sig.v;
        return t.v === 'rising_edge'
          ? { w: 1, f: ctx => (ctx.rise.has(name) ? 1n : 0n) }
          : { w: 1, f: ctx => (ctx.fall.has(name) ? 1n : 0n) };
      }

      /* conversion calls — evaluate the first argument, resize if given */
      if (CONVERSION_FNS.has(t.v) && this.peek(1).v === '(') {
        this.next(); this.next();
        const arg = this.expr();
        let width = arg.w;
        if (this.eat(',')) {
          const n = this.constExpr();
          width = Number(n.v);
          if (width < 1 || width > VHDL_MAX_BITS) throw new VErr(t.line, `Width ${width} out of range 1–${VHDL_MAX_BITS}.`);
        }
        this.expect(')');
        const af = arg.f;
        return width && width !== arg.w
          ? { w: width, f: ctx => maskW(af(ctx), width) }
          : { w: arg.w, f: af };
      }

      if ((t.v === 'shift_left' || t.v === 'shift_right') && this.peek(1).v === '(') {
        this.next(); this.next();
        const a = this.expr();
        this.expect(',');
        const b = this.expr();
        this.expect(')');
        const w = a.w || VHDL_MAX_BITS;
        const af = a.f, bf = b.f;
        return t.v === 'shift_left'
          ? { w, f: ctx => maskW(af(ctx) << bf(ctx), w) }
          : { w, f: ctx => af(ctx) >> bf(ctx) };
      }

      /* name: enum literal, constant, signal/variable [index | slice | 'attr] */
      this.next();
      const name = t.v;

      if (this.at("'")) {          // attribute
        this.next();
        const attr = this.ident('an attribute name');
        if (attr.v === 'event') {
          if (this.widths[name] === undefined) throw new VErr(t.line, `'${t.raw}' is not a declared signal.`);
          this.usesEdges = true;
          return { w: 1, f: ctx => (ctx.changed.has(name) ? 1n : 0n) };
        }
        if (attr.v === 'length') {
          const w = this.widths[name] ?? this.curVars?.[name];
          if (w === undefined) throw new VErr(t.line, `'${t.raw}' is not declared.`);
          return { w: 0, f: () => BigInt(w) };
        }
        throw new VErr(attr.line, `Attribute '${attr.raw}' is not supported (only 'event and 'length).`);
      }

      const en = this.enums.get(name);
      if (en) return { w: en.w, f: () => en.v };
      const cn = this.consts.get(name);
      if (cn) return { w: cn.w, f: () => cn.v };

      const varW = this.curVars?.[name];
      const sigW = this.widths[name];
      if (varW === undefined && sigW === undefined) {
        throw new VErr(t.line, `'${t.raw}' is not declared.`);
      }
      const w = varW ?? sigW!;
      const read: (ctx: Ctx) => bigint = varW !== undefined
        ? ctx => ctx.vars?.get(name) ?? 0n
        : ctx => ctx.sig.get(name) ?? 0n;

      if (this.eat('(')) {
        const a = this.expr();
        if (this.at('downto') || this.at('to')) {
          const desc = this.eat('downto') || (this.expect('to'), false);
          const b = this.expr();
          this.expect(')');
          let av: bigint, bv: bigint;
          try { av = a.f(probeCtx()); bv = b.f(probeCtx()); } catch { throw new VErr(t.line, 'Slice bounds must be constant.'); }
          const hi = Number(desc ? av : bv), lo = Number(desc ? bv : av);
          if (lo < 0 || hi >= w || hi < lo) throw new VErr(t.line, `Slice (${hi} downto ${lo}) is outside ${t.raw}'s ${w}-bit range.`);
          const span = hi - lo + 1;
          return { w: span, f: ctx => maskW(read(ctx) >> BigInt(lo), span) };
        }
        this.expect(')');
        const af = a.f;
        return { w: 1, f: ctx => (read(ctx) >> af(ctx)) & 1n };
      }

      return { w, f: read };
    }

    throw new VErr(t.line, `Unexpected '${t.raw}' in an expression.`);
  }
}

/* Probe context for constant folding: any signal read throws, so a
   non-constant expression is detected instead of silently reading 0. */
class ProbeMap extends Map<string, bigint> {
  get(_k: string): bigint { throw new Error('non-const'); }
}
const EMPTY_SIG: Map<string, bigint> = new ProbeMap();
const EMPTY_SET = new Set<string>();
const probeCtx = (): Ctx => ({ sig: EMPTY_SIG, vars: EMPTY_SIG as Map<string, bigint>, rise: EMPTY_SET, fall: EMPTY_SET, changed: EMPTY_SET });

/* ── public compile API ─────────────────────────────────────────── */

export type VhdlCompileResult =
  | { ok: true; module: VhdlModule }
  | { ok: false; errors: VhdlCompileError[] };

export function compileVhdl(src: string): VhdlCompileResult {
  try {
    const module = new Compiler(src).compile();
    return { ok: true, module };
  } catch (e) {
    if (e instanceof VErr) return { ok: false, errors: [{ line: e.line, message: e.message }] };
    return { ok: false, errors: [{ line: 0, message: e instanceof Error ? e.message : String(e) }] };
  }
}

/* ── evaluation ─────────────────────────────────────────────────────
   Called once per engine pass (like any chip). Signal values persist
   in `store.vals` under 's:<name>' keys; previous samples for edge
   detection persist in `store.prevIns['__vhdl']` in module.sigs order.
   Edges fire during the first internal settle iteration only, and the
   prev sample updates at the end of the call — so one input transition
   clocks the registers exactly once no matter how many passes the
   parent runs. */

export interface VhdlStore {
  vals: Record<string, bigint>;
  prevIns: Record<string, number[]>;
}

const SETTLE_PASSES = 64;

export function evalVhdlModule(m: VhdlModule, store: VhdlStore, ins: bigint[]): bigint[] {
  const sig = new Map<string, bigint>();
  const initialized = store.vals['s:__init'] === 1n;
  for (const s of m.sigs) {
    const saved = store.vals['s:' + s];
    sig.set(s, saved !== undefined ? saved : (!initialized ? (m.init[s] ?? 0n) : 0n));
  }
  store.vals['s:__init'] = 1n;

  /* drive input ports */
  let inIdx = 0;
  for (const p of m.ports) {
    if (p.dir !== 'in') continue;
    sig.set(p.name.toLowerCase(), maskW(ins[inIdx] ?? 0n, p.bits));
    inIdx++;
  }

  /* edge detection against the previous call's samples */
  const rise = new Set<string>(), fall = new Set<string>(), changed = new Set<string>();
  const prev = store.prevIns['__vhdl'];
  if (m.usesEdges && prev && prev.length === m.sigs.length) {
    m.sigs.forEach((s, i) => {
      const was = prev[i] ? 1 : 0;
      const now = (sig.get(s) ?? 0n) & 1n ? 1 : 0;
      if (was !== now) {
        changed.add(s);
        if (now) rise.add(s); else fall.add(s);
      }
    });
  }

  const ctx: Ctx = { sig, vars: null, rise, fall, changed };

  /* restore persistent process variables */
  const varMaps = m.processes.map((proc, pi) => {
    const map = new Map<string, bigint>();
    for (const v of Object.keys(proc.vars)) map.set(v, store.vals[`x:${pi}:${v}`] ?? 0n);
    return map;
  });

  for (let pass = 0; pass < SETTLE_PASSES; pass++) {
    let dirty = false;

    for (const ca of m.concurrent) {
      const pend = new Pending(m, ctx);
      pend.write(ca.target, ca.expr.f(ctx));
      if (pend.commit()) dirty = true;
    }

    m.processes.forEach((proc, pi) => {
      ctx.vars = varMaps[pi];
      const pend = new Pending(m, ctx);
      for (const st of proc.body) st(ctx, pend);
      if (pend.commit()) dirty = true;
      ctx.vars = null;
    });

    /* inputs are pinned — re-drive them in case something assigned one */
    inIdx = 0;
    for (const p of m.ports) {
      if (p.dir !== 'in') continue;
      sig.set(p.name.toLowerCase(), maskW(ins[inIdx] ?? 0n, p.bits));
      inIdx++;
    }

    /* an edge is an instant — after the first settle pass it's over */
    rise.clear(); fall.clear(); changed.clear();

    if (!dirty) break;
  }

  /* persist signals, variables, and edge samples */
  for (const s of m.sigs) store.vals['s:' + s] = sig.get(s) ?? 0n;
  m.processes.forEach((proc, pi) => {
    for (const [k, v] of varMaps[pi]) store.vals[`x:${pi}:${k}`] = v;
  });
  if (m.usesEdges) {
    store.prevIns['__vhdl'] = m.sigs.map(s => ((sig.get(s) ?? 0n) & 1n ? 1 : 0));
  }

  return m.ports.filter(p => p.dir === 'out').map(p => maskW(sig.get(p.name.toLowerCase()) ?? 0n, p.bits));
}

/* ── starter template shown in the editor ───────────────────────── */

export const VHDL_TEMPLATE = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- 4-bit up counter with enable and synchronous-style async reset.
-- Edit freely: ports become the chip's pins when you save.
entity counter is
  port (
    clk   : in  std_logic;
    reset : in  std_logic;
    en    : in  std_logic;
    q     : out std_logic_vector(3 downto 0)
  );
end entity;

architecture rtl of counter is
  signal count : unsigned(3 downto 0) := (others => '0');
begin
  process (clk, reset)
  begin
    if reset = '1' then
      count <= (others => '0');
    elsif rising_edge(clk) then
      if en = '1' then
        count <= count + 1;
      end if;
    end if;
  end process;

  q <= std_logic_vector(count);
end architecture;
`;
