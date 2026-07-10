import { Auth0Client } from '@auth0/nextjs-auth0/server';

const appBaseUrl = process.env.APP_BASE_URL;

export const authEnv = {
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  secret: process.env.AUTH0_SECRET,
};

export const authConfigured = Boolean(
  authEnv.domain &&
  authEnv.clientId &&
  authEnv.clientSecret &&
  authEnv.secret
);

export const auth0 = new Auth0Client({
  domain: authEnv.domain,
  clientId: authEnv.clientId,
  clientSecret: authEnv.clientSecret,
  secret: authEnv.secret,
  appBaseUrl,
  authorizationParameters: {
    scope: 'openid profile email',
  },
});
