import { NextResponse } from 'next/server';
import { CommunityChip, CommunityComment } from '@/lib/community';
import { chipPath, commentsPath, communityConfigured, communityUser, isValidId, readJson, writeJson } from '@/lib/community-store';

export const runtime = 'nodejs';

/* POST /api/community/<id>/comments — leave a review. Signed-in only. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidId(id)) return NextResponse.json({ error: 'Unknown chip.' }, { status: 400 });

  const user = await communityUser();
  if (!user) return NextResponse.json({ error: 'Sign in to leave a review.' }, { status: 401 });
  if (!communityConfigured()) return NextResponse.json({ error: 'Community storage is not configured.' }, { status: 503 });

  let body: { text?: unknown; rating?: unknown };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid review.' }, { status: 400 });
  }
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : '';
  const rating = Math.round(Number(body.rating));
  if (!text) return NextResponse.json({ error: 'Write something first.' }, { status: 400 });
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Pick a rating from 1 to 5.' }, { status: 400 });
  }

  const chip = await readJson<CommunityChip>(chipPath(id));
  if (!chip) return NextResponse.json({ error: 'Unknown chip.' }, { status: 404 });

  const comment: CommunityComment = {
    id: 'cm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    author: user.name,
    text,
    rating,
    createdAt: Date.now(),
  };
  const comments = (await readJson<CommunityComment[]>(commentsPath(id))) ?? [];
  const next = [...comments, comment].slice(-200);
  await writeJson(commentsPath(id), next);

  return NextResponse.json(next);
}
