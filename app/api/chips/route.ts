import { list, put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { auth0, authConfigured } from '@/auth';
import type { ChipDef } from '@/lib/engine';

export const runtime = 'nodejs';

type StoredChipLibrary = {
  userId: string;
  chips: ChipDef[];
  updatedAt: string;
};

function chipsPathForUser(userId: string) {
  return `users/${encodeURIComponent(userId)}/chips.json`;
}

async function getAuth0UserId() {
  if (!authConfigured) return null;
  const session = await auth0.getSession();
  return session?.user?.sub ?? null;
}

function isValidChipList(value: unknown): value is ChipDef[] {
  return Array.isArray(value);
}

export async function GET() {
  const userId = await getAuth0UserId();

  if (!userId) {
    return NextResponse.json([], { status: 401 });
  }

  if (!process.env.LATCH_BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json([]);
  }

  const pathname = chipsPathForUser(userId);
  const { blobs } = await list({ prefix: pathname, token: process.env.LATCH_BLOB_READ_WRITE_TOKEN });
  const existing = blobs.find(blob => blob.pathname === pathname);

  if (!existing) {
    return NextResponse.json([]);
  }

  const response = await fetch(existing.url, { cache: 'no-store' });
  if (!response.ok) {
    return NextResponse.json([]);
  }

  const body = await response.json();
  const chips = isValidChipList(body) ? body : isValidChipList(body?.chips) ? body.chips : [];

  return NextResponse.json(chips);
}

export async function POST(request: Request) {
  const userId = await getAuth0UserId();

  if (!userId) {
    return NextResponse.json({ error: 'Sign in to sync chips.' }, { status: 401 });
  }

  if (!process.env.LATCH_BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Blob storage is not configured.' }, { status: 503 });
  }

  const chips = await request.json();

  if (!isValidChipList(chips)) {
    return NextResponse.json({ error: 'Invalid chip library.' }, { status: 400 });
  }

  const payload: StoredChipLibrary = {
    userId,
    chips,
    updatedAt: new Date().toISOString(),
  };

  await put(chipsPathForUser(userId), JSON.stringify(payload), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    token: process.env.LATCH_BLOB_READ_WRITE_TOKEN,
  });

  return NextResponse.json({ ok: true });
}
