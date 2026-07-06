/* Embedded Auth0 credentials flow — used by the sign-in dialog.
   Instead of sending the user to Auth0's hosted login page, the dialog
   collects credentials and exchanges them directly with Auth0:

     sign in — POST /co/authenticate (cross-origin auth) returns a
       one-time login_ticket; we then redirect through the normal
       /auth/login → /authorize → /auth/callback flow with that ticket,
       so Auth0 authenticates silently and @auth0/nextjs-auth0 creates
       the session exactly as it would after a hosted login.
     sign up — POST /dbconnections/signup creates the account, then
       runs the same sign-in flow.

   Tenant requirements (see README): Cross-Origin Authentication
   enabled on the application, the app origin listed under Allowed
   Origins (CORS), and a database connection (default
   'Username-Password-Authentication'). */

export interface AuthPublicConfig {
  domain: string;   // Auth0 tenant domain, with or without https://
  clientId: string;
  realm: string;    // database connection name
}

/* Error with a message safe to show in the dialog. `code` lets the UI
   special-case a few situations (e.g. user_exists → switch tabs). */
export class AuthUiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

const baseUrl = (cfg: AuthPublicConfig) =>
  'https://' + cfg.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

async function post(url: string, body: unknown, withCookies = false): Promise<{ status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(withCookies ? { credentials: 'include' as const } : {}),
      body: JSON.stringify(body),
    });
  } catch {
    /* fetch() rejects identically for a dead connection and for a CORS
       rejection — the latter is what an origin missing from the Auth0
       app's “Allowed Origins (CORS)” list looks like from here. */
    throw new AuthUiError('Couldn’t reach the sign-in service — check your connection; if this keeps happening, this site’s URL may be missing from the Auth0 app’s Allowed Origins (CORS).', 'network');
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/* Exchange credentials for a login_ticket and hand off to the regular
   Auth0 redirect flow. On success this navigates away and never
   resolves; on failure it throws an AuthUiError. */
export async function embeddedSignIn(cfg: AuthPublicConfig, email: string, password: string): Promise<void> {
  const { status, data } = await post(`${baseUrl(cfg)}/co/authenticate`, {
    client_id: cfg.clientId,
    credential_type: 'http://auth0.com/oauth/grant-type/password-realm',
    realm: cfg.realm,
    username: email,
    password,
  }, true); // include cookies: Auth0 sets a co session used at /authorize

  if (status !== 200 || !data.login_ticket) {
    /* Map by Auth0's error code, not HTTP status — per the API docs,
       /co/authenticate uses 403 access_denied for wrong credentials
       and 401 unauthorized_client for "Cross origin login not
       allowed" (the toggle in the application's settings). */
    const code = str(data.error);
    const desc = str(data.error_description);
    if (code === 'access_denied') throw new AuthUiError(desc || 'Wrong email or password.', 'wrong_credentials');
    if (code === 'too_many_attempts') throw new AuthUiError(desc || 'Too many attempts — wait a moment and try again.', 'rate_limited');
    if (code === 'blocked_user') throw new AuthUiError('This account is blocked — reset your password or contact support.', 'blocked');
    if (code === 'password_leaked') throw new AuthUiError(desc || 'This sign-in was blocked because the password appeared in a data breach — check your email for instructions.', 'password_leaked');
    if (code === 'unauthorized_client')
      throw new AuthUiError('Embedded sign-in isn’t enabled for this Auth0 application — turn on “Allow Cross-Origin Authentication” in its settings, or use the hosted sign-in link below.', 'not_enabled');
    if (code === 'invalid_request' && desc?.toLowerCase().includes('realm'))
      throw new AuthUiError('The sign-in service is misconfigured (unknown connection) — check AUTH_AUTH0_CONNECTION.', 'bad_realm');
    throw new AuthUiError(desc || 'Sign-in failed — please try again.');
  }

  /* @auth0/nextjs-auth0 forwards extra /auth/login query params to the
     /authorize call, so the ticket rides the standard flow and the
     session cookie is minted by the SDK's own callback handler. */
  window.location.assign('/auth/login?' + new URLSearchParams({
    login_ticket: data.login_ticket,
    realm: cfg.realm,
    login_hint: email,
  }));
  await new Promise(() => {}); // keep the dialog in its busy state while navigating
}

/* Create the account, then sign straight in. */
export async function embeddedSignUp(cfg: AuthPublicConfig, email: string, password: string, name?: string): Promise<void> {
  const { status, data } = await post(`${baseUrl(cfg)}/dbconnections/signup`, {
    client_id: cfg.clientId,
    connection: cfg.realm,
    email,
    password,
    ...(name ? { name } : {}),
  });
  if (status !== 200) throw signupError(data);
  await embeddedSignIn(cfg, email, password);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function signupError(data: any): AuthUiError {
  const code = str(data?.code) || str(data?.name);
  if (code === 'user_exists' || code === 'username_exists')
    return new AuthUiError('An account with this email already exists — sign in instead.', 'user_exists');
  if (code === 'invalid_password' || code === 'PasswordStrengthError')
    return new AuthUiError('That password is too weak — try a longer one mixing letters, numbers, and symbols.', 'weak_password');
  if (code === 'invalid_signup')
    return new AuthUiError('Sign-up was rejected — the email may already be registered.', 'invalid_signup');
  if (code === 'password_dictionary_error' || code === 'PasswordDictionaryError')
    return new AuthUiError('That password is too common — pick something less guessable.', 'weak_password');
  if (code === 'password_no_user_info_error' || code === 'PasswordNoUserInfoError')
    return new AuthUiError('The password can’t contain parts of your email.', 'weak_password');
  return new AuthUiError(str(data?.description) || str(data?.message) || str(data?.error_description) || 'Sign-up failed — please try again.');
}
