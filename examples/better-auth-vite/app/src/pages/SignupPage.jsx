import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { authClient } from '../lib/auth-client.js';

export function SignupPage() {
  const navigate = useNavigate();
  const { data: session, refetch } = authClient.useSession();
  const [name, setName] = useState('Demo User');
  const [email, setEmail] = useState('demo@nodepod.local');
  const [password, setPassword] = useState('demo-password-123');
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
      const { error: signUpError } = await authClient.signUp.email({
        name,
        email,
        password,
      });
      if (signUpError) {
        throw new Error(signUpError.message || 'Sign up failed');
      }
      await refetch();
      setMessage('Account created — redirecting…');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Sign up</h1>
      <p className="page-lead">
        Creates a user in the SQLite database via Better Auth email/password.
      </p>

      <form className="card stack" onSubmit={onSubmit}>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            required
          />
        </label>
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
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            minLength={8}
            required
          />
        </label>
        {error ? <div className="alert error">{error}</div> : null}
        {message ? <div className="alert success">{message}</div> : null}
        <div className="btn-row">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </div>
      </form>

      <p style={{ marginTop: '1rem', color: 'var(--muted)' }}>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </>
  );
}
