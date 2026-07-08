import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authClient } from '../lib/auth-client.js';

export function DashboardPage() {
  const navigate = useNavigate();
  const { data: session, isPending, refetch } = authClient.useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      await authClient.signOut();
      await refetch();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-lead">
        Protected route — only visible when <code>get-session</code> returns a user.
      </p>

      <div className="card stack">
        {isPending ? (
          <p>Loading session…</p>
        ) : session ? (
          <>
            <p>
              Signed in as <strong>{session.user.name || session.user.email}</strong>{' '}
              ({session.user.email})
            </p>
            <pre className="session-json">{JSON.stringify(session, null, 2)}</pre>
          </>
        ) : (
          <p>No session — you should have been redirected.</p>
        )}

        {error ? <div className="alert error">{error}</div> : null}

        <div className="btn-row">
          <button type="button" onClick={() => refetch()} disabled={busy || isPending}>
            Refresh session
          </button>
          <button type="button" className="primary" onClick={signOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
          <Link className="btn" to="/">
            Home
          </Link>
        </div>
      </div>
    </>
  );
}
