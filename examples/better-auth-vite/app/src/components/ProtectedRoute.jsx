import { Navigate } from 'react-router-dom';
import { authClient } from '../lib/auth-client.js';

export function ProtectedRoute({ children }) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="card">
        <p>Loading session…</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
