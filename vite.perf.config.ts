import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const fixturePrefix = "/examples/scelar-auth-template/app/";
const fixtureRoot = resolve(
  fileURLToPath(new URL("./examples/scelar-auth-template/app/", import.meta.url)),
);

export default defineConfig({
  publicDir: "static",
  plugins: [
    {
      name: "scelar-raw-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          if (request.method !== "GET" || !pathname.startsWith(fixturePrefix)) {
            next();
            return;
          }

          const relativePath = decodeURIComponent(pathname.slice(fixturePrefix.length));
          const filePath = resolve(fixtureRoot, relativePath);
          if (filePath !== fixtureRoot && !filePath.startsWith(fixtureRoot + sep)) {
            response.statusCode = 403;
            response.end();
            return;
          }

          try {
            const contents = await readFile(filePath);
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(contents);
          } catch {
            next();
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 3333,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
