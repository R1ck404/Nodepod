import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function authServerPlugin(): Plugin {
  return {
    name: "scelar-better-auth",
    async configureServer(server) {
      // Defer better-auth imports until dev server starts (Nodepod cannot bundle them at config load).
      const { ensureAuthReady } = await import("./server/auth");
      const auth = ensureAuthReady();
      const { getMigrations } = await import("better-auth/db/migration");
      const { runMigrations } = await getMigrations(auth.options);
      await runMigrations();
      const { toNodeHandler } = await import("better-auth/node");
      const handler = toNodeHandler(auth);
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        if (url === "/api/auth" || url.startsWith("/api/auth/")) {
          return handler(req, res);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), authServerPlugin()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "src"),
    },
  },
});
