# Latchwork Auth0 build

This zip is configured to use Auth0 only. NextAuth and GitHub OAuth have been removed.

## Auth behavior

- The simulator is public. Users can build and simulate circuits without signing in.
- Anonymous users store their board and chips in browser `localStorage`.
- Auth0 users store chips in Vercel Blob under their own Auth0 `sub` path: `users/<auth0-sub>/chips.json`.
- The `/api/chips` route always derives the user from the Auth0 session. The client never chooses which user path to read or write.

## Setup

1. Copy `.env.example` to `.env.local`.
2. Fill in the values that Vercel/Auth0 already created for you.
3. Run:

```bash
npm install
npm run dev
```

## Required environment variables

```bash
AUTH_AUTH0_CLIENT_ID=
AUTH_AUTH0_CLIENT_SECRET=
AUTH_AUTH0_DOMAIN=
AUTH_AUTH0_SECRET=
BLOB_READ_WRITE_TOKEN=
BLOB_STORE_ID=
BLOB_WEBHOOK_PUBLIC_KEY=
VERCEL_OIDC_TOKEN=
```

`BLOB_STORE_ID`, `BLOB_WEBHOOK_PUBLIC_KEY`, and `VERCEL_OIDC_TOKEN` are included because Vercel may create them, but this app only needs `BLOB_READ_WRITE_TOKEN` at runtime for chip sync.

## Auth0 URLs

For local development, configure these in Auth0:

```text
Allowed Callback URLs:
http://localhost:3000/auth/callback

Allowed Logout URLs:
http://localhost:3000

Allowed Web Origins:
http://localhost:3000
```

For production, add your deployed Vercel URL equivalents.
# LatchWork
# LatchWork
# LatchWork
# LatchWork
# LatchWork
# LatchWork
# LatchWork
