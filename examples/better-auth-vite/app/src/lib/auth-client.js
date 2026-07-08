import { createAuthClient } from 'better-auth/react';

/** Same-origin in Nodepod preview; Vite proxies /api/auth → auth server :3000 */
export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : undefined,
});
