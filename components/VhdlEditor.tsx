'use client';

/* Fullscreen VHDL editor pane — the content of a VHDL editor tab.
   Replaces the canvas area while its tab is active (Simulator hides
   #main and mounts this instead). A classic code-editor layout: a
   line-number gutter scroll-synced with the source textarea, live
   compilation with clickable line-anchored errors, and a Save/Update
   action that turns the entity into a library chip. */

import { useMemo, useRef, useState } from 'react';
import { ChipDef } from '@/lib/engine';
import { compileVhdl, VhdlModule, VHDL_TEMPLATE } from '@/lib/vhdl';

export default function VhdlEditor({ baseChip, initialSource, onSourceChange, onSave }: {
  baseChip?: ChipDef;                       // the library chip this tab edits, once saved
  initialSource: string;
  onSourceChange: (src: string) => void;    // keeps the tab's draft persisted
  onSave: (name: string, source: string, module: VhdlModule) => void;
}) {
  const [source, setSource] = useState(initialSource);
  const [name, setName] = useState(baseChip?.name ?? '');
  const [curLine, setCurLine] = useState(1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const result = useMemo(() => compileVhdl(source), [source]);
  const errLines = useMemo(
    () => new Set(result.ok ? [] : result.errors.map(e => e.line)),
    [result],
  );
  const lineCount = source.split('\n').length;

  const update = (src: string) => {
    setSource(src);
    onSourceChange(src);
  };

  /* the gutter mirrors the textarea's vertical scroll exactly */
  const syncScroll = () => {
    if (gutterRef.current && taRef.current) gutterRef.current.scrollTop = taRef.current.scrollTop;
  };

  const trackCursor = () => {
    const el = taRef.current;
    if (el) setCurLine(el.value.slice(0, el.selectionStart).split('\n').length);
  };

  /* tab key indents instead of leaving the editor */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = el;
    update(source.slice(0, s) + '  ' + source.slice(end));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 2;
      trackCursor();
    });
  };

  /* clicking an error moves the cursor to that line */
  const jumpTo = (line: number) => {
    const el = taRef.current;
    if (!el || line < 1) return;
    const idx = source.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(idx, idx);
    // center the line vertically like editors do on go-to-line
    const lh = 20;
    el.scrollTop = Math.max(0, (line - 1) * lh - el.clientHeight / 2);
    syncScroll();
    setCurLine(line);
  };

  return (
    <div id="vhdlpane" role="region" aria-label={baseChip ? `VHDL editor — ${baseChip.name}` : 'VHDL editor'}>
      <div className="ve-toolbar">
        <label className="ve-namefield">
          <span>Chip name</span>
          <input
            className="mono"
            value={name}
            maxLength={24}
            placeholder={result.ok ? result.module.name : 'name…'}
            aria-label="Chip name"
            onChange={e => setName(e.target.value)}
          />
        </label>
        <span className={'ve-status' + (result.ok ? ' ok' : ' bad')} aria-live="polite">
          {result.ok
            ? <>✓ entity <b>{result.module.name}</b> · {result.module.ports.length} ports</>
            : <>✗ {result.errors.length} error{result.errors.length > 1 ? 's' : ''}</>}
        </span>
        <div className="spacer" />
        {!baseChip && (
          <button className="tbtn" onClick={() => update(VHDL_TEMPLATE)}
            title="Replace the editor contents with the counter example">Reset to template</button>
        )}
        <button className="tbtn primary" disabled={!result.ok}
          title={result.ok
            ? (baseChip ? `Apply this module to “${baseChip.name}” — every placed copy updates` : 'Save this module as a chip in your palette')
            : 'Fix the compile errors first'}
          onClick={() => { if (result.ok) onSave(name || result.module.name, source, result.module); }}>
          {baseChip ? 'Update chip' : 'Save as chip'}
        </button>
      </div>

      <div className="ve-code">
        <div className="ve-gutter mono" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}
              className={'ve-ln' + (errLines.has(i + 1) ? ' err' : '') + (curLine === i + 1 ? ' on' : '')}>
              {i + 1}
            </div>
          ))}
          {/* keeps the last line's number visible at max scroll */}
          <div className="ve-gutterpad" />
        </div>
        <textarea
          ref={taRef}
          className="ve-ta mono"
          spellCheck={false}
          wrap="off"
          autoCapitalize="off"
          autoCorrect="off"
          value={source}
          aria-label="VHDL source"
          onChange={e => { update(e.target.value); trackCursor(); }}
          onKeyDown={onKeyDown}
          onKeyUp={trackCursor}
          onClick={trackCursor}
          onSelect={trackCursor}
          onScroll={syncScroll}
        />
      </div>

      <div className="ve-foot">
        {result.ok ? (
          <div className="vhdl-ports">
            {result.module.ports.map(p => (
              <span key={p.name} className={'vhdl-port ' + p.dir}>
                {p.dir === 'in' ? '▸' : '◂'} {p.name}
                {p.bits > 1 ? <em> · {p.bits}b</em> : null}
              </span>
            ))}
          </div>
        ) : (
          <div className="vhdl-errors">
            {result.errors.map((er, i) => (
              <button key={i} className="vhdl-error ve-errbtn" onClick={() => jumpTo(er.line)}
                title={er.line > 0 ? `Jump to line ${er.line}` : undefined}>
                {er.line > 0 && <span className="mono">line {er.line}</span>} {er.message}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
