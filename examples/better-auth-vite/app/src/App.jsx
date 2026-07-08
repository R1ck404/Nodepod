import { NavLink, Route, Routes } from 'react-router-dom';
import { authClient } from './lib/auth-client.js';
import { HomePage } from './pages/HomePage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { SignupPage } from './pages/SignupPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';

export default function App() {
  const { data: session, isPending } = authClient.useSession();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">Nodepod · Better Auth</div>
        <nav className="nav">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
          {!session ? (
            <>
              <NavLink to="/login">Log in</NavLink>
              <NavLink to="/signup">Sign up</NavLink>
            </>
          ) : null}
        </nav>
        <span className={`session-pill${session ? ' live' : ''}`}>
          {isPending ? 'Checking session…' : session ? 'Signed in' : 'Guest'}
        </span>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <DashboardPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
