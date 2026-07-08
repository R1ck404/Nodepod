import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { authClient } from '../lib/auth-client.js';

const DEMO = {
  email: 'demo@nodepod.local',
  password: 'demo-password-123',
};

export function LoginPage() {
  const navigate = useNavigate();
  const { data: session, refetch } = authClient.useSession();
  const [email, setEmail] = useState(DEMO.email);
  const [password, setPassword] = useState(DEMO.password);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) {
    return <Navigate to="/dashboard" replace />;
  }

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const { error: signInError } = await authClient.signIn.email({
        email,
        password,
      });
      if (signInError) {
        throw new Error(signInError.message || 'Sign in failed');
      }
      await refetch();
      setMessage('Signed in — redirecting…');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Log in</h1>
      <p className="page-lead">
        Uses <code>authClient.signIn.email</code>. Demo credentials are prefilled.
      </p>

      <form className="card stack" onSubmit={onSubmit}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
          />
        </label>
        {error ? <div className="alert error">{error}</div> : null}
        {message ? <div className="alert success">{message}</div> : null}
        <div className="btn-row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>

      <p style={{ marginTop: '1rem', color: 'var(--muted)' }}>
        No account? <Link to="/signup">Sign up</Link>
      </p>
    </>
  );
}
