import { NextResponse } from 'next/server';
import { CommunityChip, CommunityChipSummary, isChipDefLike } from '@/lib/community';
import { chipPath, communityConfigured, communityUser, indexPath, readJson, writeJson } from '@/lib/community-store';
import type { ChipDef } from '@/lib/engine';

export const runtime = 'nodejs';

/* GET /api/community — the storefront index (summaries only). */
export async function GET() {
  if (!communityConfigured()) return NextResponse.json([]);
  const index = await readJson<CommunityChipSummary[]>(indexPath());
  return NextResponse.json(Array.isArray(index) ? index : []);
}

/* POST /api/community — share a chip. Signed-in users only. */
export async function POST(request: Request) {
  const user = await communityUser();
  if (!user) {
    return NextResponse.json({ error: 'Sign in to share chips with the community.' }, { status: 401 });
  }
  if (!communityConfigured()) {
    return NextResponse.json({ error: 'Community storage is not configured.' }, { status: 503 });
  }

  let body: { name?: unknown; description?: unknown; def?: unknown; deps?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid upload.' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 600) : '';
  const def = body.def;
  const deps = Array.isArray(body.deps) ? body.deps : [];

  if (!name) return NextResponse.json({ error: 'Give the chip a name.' }, { status: 400 });
  if (!description) return NextResponse.json({ error: 'Add a short description so others know what the chip does.' }, { status: 400 });
  if (!isChipDefLike(def)) return NextResponse.json({ error: 'Invalid chip definition.' }, { status: 400 });
  if (deps.length > 24 || !deps.every(isChipDefLike)) {
    return NextResponse.json({ error: 'Invalid chip dependencies.' }, { status: 400 });
  }
  if (JSON.stringify({ def, deps }).length > 500_000) {
    return NextResponse.json({ error: 'This chip is too large to share.' }, { status: 413 });
  }

  const chipDef = def as ChipDef;
  const id = 'cc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const summary: CommunityChipSummary = {
    id, name, description,
    author: user.name,
    createdAt: Date.now(),
    ins: chipDef.inputs.length,
    outs: chipDef.outputs.length,
    parts: chipDef.comps.length,
  };
  const record: CommunityChip = { ...summary, def: chipDef, deps: deps as ChipDef[] };

  await writeJson(chipPath(id), record);

  /* Read-modify-write on the index — fine at this scale; a lost racing
     upload only drops out of the listing, never out of storage. */
  const index = (await readJson<CommunityChipSummary[]>(indexPath())) ?? [];
  const next = [summary, ...index.filter(e => e && e.id !== id)].slice(0, 500);
  await writeJson(indexPath(), next);

  return NextResponse.json({ ok: true, id });
}
