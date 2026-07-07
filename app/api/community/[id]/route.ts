import { NextResponse } from 'next/server';
import { CommunityChip, CommunityComment } from '@/lib/community';
import { chipPath, commentsPath, communityConfigured, isValidId, readJson } from '@/lib/community-store';

export const runtime = 'nodejs';

/* GET /api/community/<id> — full chip record (def + deps) and comments. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) return NextResponse.json({ error: 'Unknown chip.' }, { status: 400 });
  if (!communityConfigured()) return NextResponse.json({ error: 'Community storage is not configured.' }, { status: 503 });

  const chip = await readJson<CommunityChip>(chipPath(id));
  if (!chip) return NextResponse.json({ error: 'Unknown chip.' }, { status: 404 });

  const comments = (await readJson<CommunityComment[]>(commentsPath(id))) ?? [];
  return NextResponse.json({ chip, comments });
}
