# Latchwork Auth0 build

This zip is configured to use Auth0 only. NextAuth and GitHub OAuth have been removed.

## Auth behavior

- The simulator is public. Users can build and simulate circuits without signing in.
- Anonymous users store their board and chips in browser `localStorage`.
- Auth0 users store chips in Vercel Blob under their own Auth0 `sub` path: `users/<auth0-sub>/chips.json`.
- The `/api/chips` route always derives the user from the Auth0 session. The client never chooses which user path to read or write.

## Workbench features

- **7-segment display** — a one-digit display under *Output* with 8 pins (segments `a`–`g` + `dp`), each driven directly by a 1-bit signal.
- **Buses** — select any wire to set how many bits it carries (1/2/4/8) from the titlebar; multi-bit wires draw thicker and show a live binary readout. Wires started from a bus pin pick up its width automatically.
- **Bit combiner** — packs 2–4 individual bits (MSB on top) into one value on a 4-bit output bus; unused high bits pad with zeros (e.g. inputs `1,1` → `0011`).
- **Tunnels** — name a tunnel node and it joins the net of every other tunnel with the same name, like an invisible wire. Tunnels are pure junctions: they can sit on either side of a connection.
- **Palette folders** — the side menu is organized into collapsible groups and can be resized by dragging its right edge; both persist per browser.

- **Editor tabs** — the bottom bar works like a spreadsheet's sheet tabs: `+` opens a blank canvas, double-click renames, `×` closes. All tabs (and which one was active) persist to `localStorage` (`latchwork.tabs.v1`; old single-board saves migrate automatically).
- **Chip inspector** — the `i` button on any saved chip (palette → My chips) opens an auto-generated report: the abstracted chip drawing with a toggle to view its internals, a simulated **truth table**, and for stateful chips a minimized **state machine diagram** (see `lib/analyze.ts`). The same report is shown for community chips.
- **Edit chip internals** — double-click a custom chip (on the canvas or in the palette) and confirm to open its internal circuit in a new editor tab; **Update chip** in the titlebar applies the changes to every placed copy.
- **Community chips** — the *Community* button opens a storefront (80% of the screen) backed by the blob store under `communitychips/`:
  - `communitychips/index.json` — listing summaries
  - `communitychips/<id>.json` — full chip (definition + bundled nested-chip dependencies)
  - `communitychips/<id>.comments.json` — reviews
  - Anyone can browse, search, filter, and **Add to my chips**. Uploading and reviewing require an Auth0 account; the API derives the author from the session and publishes only a display name.

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
VERCEL_OIDC_TOKEN=
LATCH_BLOB_STORE_ID=
LATCH_BLOB_READ_WRITE_TOKEN=
APP_BASE_URL=https://www.latchwork.io
AUTH0_DOMAIN=
AUTH0_CLIENT_ID=
AUTH0_CLIENT_SECRET=
AUTH0_SECRET=
```

`LATCH_BLOB_STORE_ID` and `VERCEL_OIDC_TOKEN` are included because Vercel may create them, but this app only needs `LATCH_BLOB_READ_WRITE_TOKEN` at runtime for chip sync and community chips.

Optional: `AUTH0_CONNECTION` — the Auth0 database connection used by the embedded sign-in dialog. Defaults to `Username-Password-Authentication`.

## Embedded sign-in dialog

Clicking **Sign in** opens an in-app dialog (sign in / create account tabs) instead of redirecting to Auth0's hosted page. It uses Auth0's cross-origin authentication: credentials go to `/co/authenticate` (sign in) or `/dbconnections/signup` (sign up), and the returned one-time `login_ticket` is passed through the normal `/auth/login` → `/authorize` → `/auth/callback` flow, so the session is still created by `@auth0/nextjs-auth0`.

For this to work, configure the Auth0 **application** (Dashboard → Applications → Applications → your app → **Settings**):

- Under **Cross-Origin Authentication**, toggle on **Allow Cross-Origin Authentication**.
- In **Allowed Origins (CORS)**, add your app's origin URL(s) — e.g. `http://localhost:3000` and your production URL.
- The database connection (`Username-Password-Authentication` by default) must be enabled for the application (Application → Connections), with sign-ups allowed.
- If Auth0 responds with *"Grant type 'http://auth0.com/oauth/grant-type/password-realm' not allowed for the client"*, also enable the **Password** grant under Settings → **Advanced Settings** → **Grant Types**.

Troubleshooting the dialog's error messages (they map to `/co/authenticate` error codes):

- *"Embedded sign-in isn't enabled…"* → Auth0 returned `unauthorized_client` ("Cross origin login not allowed"): the **Allow Cross-Origin Authentication** toggle is off.
- *"Couldn't reach the sign-in service…"* → the request never completed; if you're online, the origin is probably missing from **Allowed Origins (CORS)** (a CORS rejection is indistinguishable from a network failure in the browser).
- *"Wrong email or password."* → normal `access_denied` from Auth0; credentials are simply wrong.

Auth0 recommends a [custom domain](https://auth0.com/docs/customize/custom-domains) for embedded login in production so the cross-origin cookie isn't blocked by third-party-cookie protections. If embedded sign-in is unavailable, the dialog links to the hosted sign-in page as a fallback.

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
