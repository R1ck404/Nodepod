import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "static",
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
