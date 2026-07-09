import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { ensureAuthMigrations } from './server/auth.mjs';

function authServerPlugin() {
  return {
    name: 'nodepod-better-auth',
    async configureServer(server) {
      await ensureAuthMigrations();
      const { ensureAuthReady } = await import('./server/auth.mjs');
      const auth = ensureAuthReady();
      const { toNodeHandler } = await import('better-auth/node');
      const handler = toNodeHandler(auth);
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (url === '/api/auth' || url.startsWith('/api/auth/')) {
          return handler(req, res);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), authServerPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
});
