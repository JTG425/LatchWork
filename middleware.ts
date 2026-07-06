import type { NextRequest } from 'next/server';
import { auth0, authConfigured } from './auth';

export async function middleware(request: NextRequest) {
  if (!authConfigured) return;
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
