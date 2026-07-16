/* Server-side helpers for the community chip store (Vercel Blob).
   Import only from API routes — this pulls in @vercel/blob. */

import { list, put } from '@vercel/blob';
import { auth0, authConfigured } from '@/auth';

export const CC_PREFIX = 'communitychips/';

/* The signed-in user reduced to a public display name (never the
   Auth0 sub or full email). null → not signed in. */
export async function communityUser(): Promise<{ name: string } | null> {
  if (!authConfigured || !auth0) return null;
  try {
    const session = await auth0.getSession();
    const u = session?.user;
    if (!u?.sub) return null;
    const name =
      (typeof u.name === 'string' && u.name) ||
      (typeof u.nickname === 'string' && u.nickname) ||
      (typeof u.email === 'string' && u.email.split('@')[0]) ||
      'Member';
    return { name };
  } catch {
    return null;
  }
}

const token = () => process.env.LATCH_BLOB_READ_WRITE_TOKEN;
export const communityConfigured = () => !!token();

export const chipPath = (id: string) => `${CC_PREFIX}${id}.json`;
export const commentsPath = (id: string) => `${CC_PREFIX}${id}.comments.json`;
export const indexPath = () => `${CC_PREFIX}index.json`;

/* Community chip ids are minted server-side and stay path-safe. */
export const isValidId = (id: unknown): id is string =>
  typeof id === 'string' && /^cc_[a-z0-9_]{1,40}$/.test(id);

export async function readJson<T>(pathname: string): Promise<T | null> {
  const { blobs } = await list({ prefix: pathname, token: token() });
  const hit = blobs.find(b => b.pathname === pathname);
  if (!hit) return null;
  const res = await fetch(hit.url, { cache: 'no-store' });
  if (!res.ok) return null;
  try { return (await res.json()) as T; } catch { return null; }
}

export async function writeJson(pathname: string, data: unknown): Promise<void> {
  await put(pathname, JSON.stringify(data), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    token: token(),
  });
}
