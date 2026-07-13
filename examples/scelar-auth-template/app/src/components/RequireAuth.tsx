import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { authClient } from "../lib/auth-client";

export default function RequireAuth({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const location = useLocation();
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
