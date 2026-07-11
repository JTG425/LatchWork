/* Shared SVG markup for canvas notations (NOTE / RECT / TABLE).
   Used by the live editor (components/editor.ts) and the static chip
   previews (lib/chip-svg.ts) so a note looks identical everywhere.
   Geometry comes from lib/engine (noteMetrics / tableColWidths) —
   markup and hit boxes always agree. */

import {
  Comp, CompGeom, DEFAULT_NOTE_COLOR, TABLE_ROW_H,
  noteMetrics, normalizeTable, defaultTruthTable, tableColWidths,
} from './engine';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type NoteComp = Pick<Comp, 'type' | 'text' | 'fontSize' | 'color' | 'noteShape' | 'table' | 'label'>;

function textNote(c: NoteComp): string {
  const m = noteMetrics(c);
  const fill = c.text?.trim() ? (c.color ?? 'var(--text)') : 'var(--muted)';
  let out = `<rect class="notehit" x="0" y="0" width="${m.w}" height="${m.h}" rx="4"/>`;
  m.lines.forEach((line, i) => {
    out += `<text class="notetext" x="${m.pad}" y="${m.pad + i * m.lineH + m.fs * 0.82}"
      style="font-size:${m.fs}px;fill:${fill}">${esc(line)}</text>`;
  });
  return out;
}

function shapeNote(c: NoteComp, g: CompGeom): string {
  const color = c.color ?? DEFAULT_NOTE_COLOR;
  // the user-requested half-opacity backdrop: shapes tint whatever
  // circuit sits on top of them without hiding it
  const paint = `fill="${color}" fill-opacity="0.5" stroke="${color}" stroke-opacity="0.75" stroke-width="1.5"`;
  let out = c.noteShape === 'ellipse'
    ? `<ellipse class="noteshape" cx="${g.w / 2}" cy="${g.h / 2}" rx="${g.w / 2}" ry="${g.h / 2}" ${paint}/>`
    : `<rect class="noteshape" x="0" y="0" width="${g.w}" height="${g.h}" rx="10" ${paint}/>`;
  if (c.label?.trim()) {
    const x = c.noteShape === 'ellipse' ? g.w / 2 : 10;
    const anchor = c.noteShape === 'ellipse' ? 'middle' : 'start';
    out += `<text class="notelabel" x="${x}" y="17" text-anchor="${anchor}" style="fill:${color}">${esc(c.label)}</text>`;
  }
  return out;
}

function tableNote(c: NoteComp): string {
  const t = normalizeTable(c.table ?? defaultTruthTable());
  const accent = c.color ?? DEFAULT_NOTE_COLOR;
  const colW = tableColWidths(t);
  const w = colW.reduce((s, v) => s + v, 0);
  const h = t.cells.length * TABLE_ROW_H;
  const r = 6;

  let out = `<rect class="tblbg" x="0" y="0" width="${w}" height="${h}" rx="${r}"/>`;
  // header band — square bottom corners, rounded top ones
  out += `<path d="M0,${TABLE_ROW_H} V${r} Q0,0 ${r},0 H${w - r} Q${w},0 ${w},${r} V${TABLE_ROW_H} Z"
    fill="${accent}" fill-opacity="0.22"/>`;

  for (let i = 1; i < t.cells.length; i++) {
    out += `<path class="tblline" d="M0,${i * TABLE_ROW_H} H${w}"/>`;
  }
  let x = 0;
  for (let j = 0; j + 1 < colW.length; j++) {
    x += colW[j];
    out += t.sep === j + 1
      ? `<path d="M${x},0 V${h}" stroke="${accent}" stroke-opacity="0.9" stroke-width="2"/>`
      : `<path class="tblline" d="M${x},0 V${h}"/>`;
  }

  t.cells.forEach((row, i) => {
    let cx = 0;
    row.forEach((cell, j) => {
      if (cell) {
        out += `<text class="${i === 0 ? 'tblhead' : 'tblcell'}" x="${cx + colW[j] / 2}" y="${i * TABLE_ROW_H + 16}"
          ${i === 0 ? `style="fill:${accent}"` : ''}>${esc(cell)}</text>`;
      }
      cx += colW[j];
    });
  });
  return out;
}

/* Body markup for one notation comp, in its own local coordinates
   (the caller wraps it in the translated/rotated <g class="comp">). */
export function noteMarkup(c: NoteComp, g: CompGeom): string {
  if (c.type === 'NOTE') return textNote(c);
  if (c.type === 'RECT') return shapeNote(c, g);
  if (c.type === 'TABLE') return tableNote(c);
  return '';
}
