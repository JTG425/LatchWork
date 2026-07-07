/* Shared types for the community chip store — used by the API routes
   and the storefront dialog. Chips live in Vercel Blob under the
   `communitychips/` prefix:

     communitychips/index.json          → CommunityChipSummary[]
     communitychips/<id>.json           → CommunityChip
     communitychips/<id>.comments.json  → CommunityComment[]      */

import type { ChipDef } from './engine';

export interface CommunityChipSummary {
  id: string;
  name: string;
  description: string;
  author: string;      // display name only — never the Auth0 sub or email
  createdAt: number;
  ins: number;
  outs: number;
  parts: number;       // component count of the internals
}

export interface CommunityChip extends CommunityChipSummary {
  def: ChipDef;
  /* Transitive custom-chip dependencies bundled at upload time so the
     chip simulates for users who don't own the nested chips. */
  deps: ChipDef[];
}

export interface CommunityComment {
  id: string;
  author: string;
  text: string;
  rating: number;      // 1–5
  createdAt: number;
}

export function isChipDefLike(v: unknown): v is ChipDef {
  const d = v as ChipDef;
  return !!d && typeof d === 'object' &&
    typeof d.id === 'string' && typeof d.name === 'string' &&
    Array.isArray(d.inputs) && Array.isArray(d.outputs) &&
    Array.isArray(d.inputComps) && Array.isArray(d.outputComps) &&
    Array.isArray(d.comps) && Array.isArray(d.wires);
}
