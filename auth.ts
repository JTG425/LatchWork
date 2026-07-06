import { Auth0Client } from '@auth0/nextjs-auth0/server';

const appBaseUrl =
  process.env.NEXT_PUBLIC_APP_BASE_URL ||
  process.env.APP_BASE_URL ||
  process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` ||
  'http://localhost:3000';

export const authConfigured = Boolean(
  process.env.AUTH_AUTH0_DOMAIN &&
  process.env.AUTH_AUTH0_CLIENT_ID &&
  process.env.AUTH_AUTH0_CLIENT_SECRET &&
  process.env.AUTH_AUTH0_SECRET
);

export const auth0 = new Auth0Client({
  domain: process.env.AUTH_AUTH0_DOMAIN,
  clientId: process.env.AUTH_AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH_AUTH0_CLIENT_SECRET,
  secret: process.env.AUTH_AUTH0_SECRET,
  appBaseUrl,
  authorizationParameters: {
    scope: 'openid profile email',
  },
});
