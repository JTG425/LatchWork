'use client';

import { useState } from 'react';
import { AuthPublicConfig, AuthUiError, embeddedSignIn, embeddedSignUp } from '@/lib/auth-embedded';

type Tab = 'in' | 'up';

/* Sign in / sign up dialog. Pops over the simulator with a blurred
   backdrop and drives the embedded Auth0 flow (lib/auth-embedded) —
   on success the browser leaves through /auth/login and comes back
   with a session, so there's nothing to clean up here. */
export default function AuthDialog({ auth, onClose }: { auth: AuthPublicConfig; onClose(): void }) {
  const [tab, setTab] = useState<Tab>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailOk = /\S+@\S+\.\S+/.test(email);
  const mismatch = tab === 'up' && confirm.length > 0 && confirm !== password;
  const canSubmit = !busy && emailOk && password.length > 0 && (tab === 'in' || (confirm === password && confirm.length > 0));

  const switchTab = (t: Tab) => {
    if (busy) return;
    setTab(t);
    setError(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === 'in') await embeddedSignIn(auth, email, password);
      else await embeddedSignUp(auth, email, password, name.trim() || undefined);
      // unreachable — success navigates away through /auth/login
    } catch (e) {
      if (e instanceof AuthUiError && e.code === 'user_exists') setTab('in');
      setError(e instanceof AuthUiError ? e.message : 'Something went wrong — please try again.');
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay auth"
      onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
      onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}
    >
      <div className="dialog authdialog" role="dialog" aria-modal="true" aria-label="Sign in or create an account">
        <h2>Welcome to Latchwork</h2>
        <p>Sign in to sync your chips to your account and use them on any device.</p>

        <div className="authtabs" role="tablist" aria-label="Sign in or sign up">
          <button role="tab" aria-selected={tab === 'in'} className={tab === 'in' ? 'on' : ''}
            onClick={() => switchTab('in')}>Sign in</button>
          <button role="tab" aria-selected={tab === 'up'} className={tab === 'up' ? 'on' : ''}
            onClick={() => switchTab('up')}>Create account</button>
        </div>

        <form onSubmit={e => { e.preventDefault(); submit(); }}>
          {tab === 'up' && (
            <label className="authfield">
              <span>Name <em>optional</em></span>
              <input value={name} autoComplete="name" maxLength={64} placeholder="Ada Lovelace"
                onChange={e => setName(e.target.value)} disabled={busy} />
            </label>
          )}
          <label className="authfield">
            <span>Email</span>
            <input type="email" value={email} autoFocus autoComplete="email" placeholder="you@example.com"
              onChange={e => setEmail(e.target.value)} disabled={busy} />
          </label>
          <label className="authfield">
            <span>Password</span>
            <input type="password" value={password}
              autoComplete={tab === 'in' ? 'current-password' : 'new-password'}
              placeholder={tab === 'in' ? 'Your password' : 'At least 8 characters'}
              onChange={e => setPassword(e.target.value)} disabled={busy} />
          </label>
          {tab === 'up' && (
            <label className="authfield">
              <span>Confirm password</span>
              <input type="password" value={confirm} autoComplete="new-password" placeholder="Same password again"
                onChange={e => setConfirm(e.target.value)} disabled={busy}
                aria-invalid={mismatch} />
            </label>
          )}
          {mismatch && <div className="authhint">Passwords don’t match yet.</div>}
          {error && <div className="autherr" role="alert">{error}</div>}
          <button type="submit" className="tbtn primary authsubmit" disabled={!canSubmit}>
            {busy ? (tab === 'in' ? 'Signing in…' : 'Creating account…') : (tab === 'in' ? 'Sign in' : 'Create account')}
          </button>
        </form>

        <div className="authfoot">
          Prefer the classic flow? <a href="/auth/login">Use Auth0’s hosted sign-in</a>
        </div>
      </div>
    </div>
  );
}
