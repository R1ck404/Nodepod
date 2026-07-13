import { Link, NavLink, Outlet } from "react-router";
import { authClient } from "../lib/auth-client";
import { Button } from "~/components/ui/button";

export default function RootLayout() {
  const { data: session } = authClient.useSession();

  return (
    <div className="isolate relative min-h-svh bg-background text-foreground">
      <header className="border-b border-border px-6 py-4">
        <nav className="mx-auto flex max-w-4xl items-center justify-between gap-6">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-sm font-semibold tracking-tight">
              My App
            </Link>
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                [
                  "text-sm transition-colors",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                ].join(" ")
              }
            >
              Home
            </NavLink>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {session ? (
              <>
                <span className="text-muted-foreground">{session.user.email}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => authClient.signOut()}
                >
                  Sign out
                </Button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-muted-foreground hover:text-foreground"
                >
                  Sign in
                </Link>
                <Button render={<Link to="/signup" />} size="sm">
                  Sign up
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
