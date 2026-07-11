'use client';

/* VHDL module editor — write a VHDL entity + architecture, see compile
   errors live, and save it as a chip. The saved chip has no internal
   circuit; the engine runs the compiled module (lib/vhdl.ts) directly.
   Opened from the titlebar (new module) and from any VHDL chip's edit
   actions (rework an existing module). */

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ChipDef, makeVhdlChipDef } from '@/lib/engine';
import { compileVhdl, VHDL_TEMPLATE } from '@/lib/vhdl';

export default function VhdlDialog({ base, onSave, onClose }: {
  base?: ChipDef;                 // present when editing an existing VHDL chip
  onSave: (def: ChipDef) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(base?.vhdl ?? VHDL_TEMPLATE);
  const [name, setName] = useState(base?.name ?? '');

  const result = useMemo(() => compileVhdl(source), [source]);

  const save = () => {
    if (!result.ok) return;
    onSave(makeVhdlChipDef(name || result.module.name, source, result.module, base));
  };

  /* tab key indents instead of leaving the editor */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    setSource(source.slice(0, s) + '  ' + source.slice(end));
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
  };

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        className="dialog vhdldialog" role="dialog" aria-modal="true"
        aria-label={base ? `Edit VHDL module ${base.name}` : 'New VHDL module'}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ type: 'spring', duration: 0.34, bounce: 0.18 }}
      >
        <div className="inspect-head">
          <h2>{base ? `Edit “${base.name}”` : 'New VHDL module'}</h2>
          <span className="community-card-meta">entity + architecture → chip</span>
          <div className="spacer" />
          <button className="community-close" aria-label="Close" onClick={onClose}>×</button>
        </div>

        <p className="vhdl-intro">
          Describe hardware in VHDL — the entity&apos;s <b>in</b>/<b>out</b> ports become the
          chip&apos;s pins (buses keep their widths). Supports processes with{' '}
          <code>rising_edge</code>/<code>falling_edge</code>, <code>when/else</code>,{' '}
          <code>with/select</code>, <code>case</code>, enum state types, generics with
          defaults, and unsigned arithmetic.
        </p>

        <div className="vhdl-body">
          <textarea
            className="vhdl-editor mono"
            spellCheck={false}
            value={source}
            aria-label="VHDL source"
            onChange={e => setSource(e.target.value)}
            onKeyDown={onKeyDown}
          />

          <div className="vhdl-status" aria-live="polite">
            {result.ok ? (
              <>
                <div className="vhdl-ok">✓ Compiles — entity <b>{result.module.name}</b></div>
                <div className="vhdl-ports">
                  {result.module.ports.map(p => (
                    <span key={p.name} className={'vhdl-port ' + p.dir}>
                      {p.dir === 'in' ? '▸' : '◂'} {p.name}
                      {p.bits > 1 ? <em> · {p.bits}b</em> : null}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="vhdl-errors">
                {result.errors.map((e, i) => (
                  <div key={i} className="vhdl-error">
                    {e.line > 0 && <span className="mono">line {e.line}</span>} {e.message}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <label className="side-field vhdl-name">
          <span>Chip name</span>
          <input
            value={name}
            maxLength={24}
            placeholder={result.ok ? result.module.name : 'name…'}
            aria-label="Chip name"
            onChange={e => setName(e.target.value)}
          />
        </label>

        <div className="dialog-actions">
          {!base && (
            <button className="tbtn" onClick={() => setSource(VHDL_TEMPLATE)}
              title="Replace the editor contents with the counter example">Reset to template</button>
          )}
          <div className="spacer" />
          <button className="tbtn" onClick={onClose}>Cancel</button>
          <button className="tbtn primary" disabled={!result.ok} onClick={save}
            title={result.ok ? undefined : 'Fix the compile errors first'}>
            {base ? 'Update module' : 'Save as chip'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
