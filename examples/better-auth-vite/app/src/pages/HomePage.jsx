import { Link } from 'react-router-dom';
import { authClient } from '../lib/auth-client.js';

export function HomePage() {
  const { data: session } = authClient.useSession();

  return (
    <>
      <h1 className="page-title">Better Auth inside Nodepod</h1>
      <p className="page-lead">
        A real Vite + React + React Router app. The auth API runs on port{' '}
        <code>3000</code> with <code>node:sqlite</code> (wa-sqlite). Vite on{' '}
        <code>5173</code> proxies <code>/api/auth</code> to the auth server.
      </p>

      <div className="card">
        {session ? (
          <>
            <p>
              You are signed in as <strong>{session.user.email}</strong>.
            </p>
            <div className="btn-row">
              <Link className="btn primary" to="/dashboard">
                Open dashboard
              </Link>
            </div>
          </>
        ) : (
          <>
            <p>Try the demo account or create your own.</p>
            <div className="btn-row">
              <Link className="btn primary" to="/signup">
                Create account
              </Link>
              <Link className="btn" to="/login">
                Log in
              </Link>
            </div>
          </>
        )}
      </div>

      <div className="feature-grid">
        <div className="card">
          <h3>Vite dev server</h3>
          <p>Hot reload, React 19, and a standard project layout under /project.</p>
        </div>
        <div className="card">
          <h3>Better Auth</h3>
          <p>Email/password sign-up, session cookies, and get-session via the proxy.</p>
        </div>
        <div className="card">
          <h3>React Router</h3>
          <p>Client routes with a protected dashboard that requires a session.</p>
        </div>
      </div>
    </>
  );
}
