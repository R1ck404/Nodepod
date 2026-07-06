import { describe, it, expect } from "vitest";
import nodepod from "../../integrations/vite";
import { createServer, build } from "vite";
import type { RollupOutput } from "rollup";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The worker bundle asset only exists after `pnpm run build:lib`; the plugin
// (and these assertions) treat it as optional so test order doesn't matter.
const workerAssetBuilt = existsSync(join(process.cwd(), "dist", "__worker__.js"));

describe("integrations/vite", () => {
  it("factory returns a Vite plugin object with expected hooks", () => {
    const plugin = nodepod();
    expect(plugin.name).toBe("nodepod");
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.generateBundle).toBe("function");
  });

  it("respects a custom path option", () => {
    const plugin = nodepod({ path: "/custom-sw.js" });
    expect(plugin.name).toBe("nodepod");
  });

  it("emits __sw__.js as an asset during generateBundle", async () => {
    const plugin = nodepod();
    const emitted: Array<{ fileName: string; source: string }> = [];
    const ctx = {
      emitFile: (asset: { type: string; fileName: string; source: string }) => {
        if (asset.type === "asset") {
          emitted.push({ fileName: asset.fileName, source: asset.source });
        }
      },
    };
    // We only care about emitFile on `this`; the (opts, bundle) args aren't
    // read by the hook, so pass empty objects.
    await (plugin.generateBundle as unknown as (
      this: typeof ctx,
      opts: unknown,
      bundle: unknown,
    ) => Promise<void>).call(ctx, {}, {});

    const sw = emitted.find((a) => a.fileName === "__sw__.js");
    expect(sw).toBeDefined();
    expect(sw!.source.length).toBeGreaterThan(1000);

    const worker = emitted.find((a) => a.fileName === "__worker__.js");
    if (workerAssetBuilt) {
      expect(worker).toBeDefined();
      expect(worker!.source.length).toBeGreaterThan(1000);
    } else {
      expect(worker).toBeUndefined();
    }
  });

  it("configureServer mounts a middleware that serves the SW at /__sw__.js", async () => {
    const plugin = nodepod();
    const middlewares: Array<(
      req: { url?: string },
      res: MockRes,
      next: () => void,
    ) => void | Promise<void>> = [];
    const mockServer = {
      middlewares: {
        use: (mw: (typeof middlewares)[number]) => {
          middlewares.push(mw);
        },
      },
    };
    await (plugin.configureServer as unknown as (
      s: typeof mockServer,
    ) => void | Promise<void>)(mockServer);
    expect(middlewares).toHaveLength(1);

    const mw = middlewares[0];

    // Non-matching URL: next() fires, nothing written.
    {
      const res = new MockRes();
      let nextCalled = false;
      await mw({ url: "/other" }, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBeUndefined();
    }

    // /__sw__.js: SW source written with JS Content-Type + scope headers.
    {
      const res = new MockRes();
      await mw({ url: "/__sw__.js" }, res, () => {
        throw new Error("next() should not be called for SW path");
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toMatch(/javascript/i);
      expect(res.headers["Service-Worker-Allowed"]).toBe("/");
      expect(res.body.length).toBeGreaterThan(1000);
    }

    // Cache-buster query (?v=...) still matches.
    {
      const res = new MockRes();
      await mw({ url: "/__sw__.js?v=12345" }, res, () => {
        throw new Error("next() should not be called for SW path w/ query");
      });
      expect(res.statusCode).toBe(200);
    }
  });
});

class MockRes {
  statusCode: number | undefined;
  headers: Record<string, string> = {};
  body = "";
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  end(body: string) {
    this.body = body;
  }
}

// End-to-end: spin up a real Vite dev server, hit /__sw__.js over HTTP.
describe("integrations/vite end-to-end", () => {
  it("dev server serves /__sw__.js with real HTTP fetch", async () => {
    const server = await createServer({
      configFile: false,
      root: process.cwd(),
      server: { port: 0, strictPort: false, host: "127.0.0.1" },
      plugins: [nodepod()],
      logLevel: "silent",
    });
    try {
      await server.listen();
      const addr = server.httpServer?.address();
      if (!addr || typeof addr === "string") throw new Error("no address");
      const url = `http://127.0.0.1:${addr.port}/__sw__.js`;

      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/javascript/i);
      expect(res.headers.get("service-worker-allowed")).toBe("/");
      expect(res.headers.get("cache-control")).toBe("no-cache");

      const body = await res.text();
      expect(body.length).toBeGreaterThan(1000);
      expect(body).toMatch(/self\.addEventListener/);

      // Cache-buster query the SDK appends on register().
      const res2 = await fetch(`${url}?v=${Date.now()}`);
      expect(res2.status).toBe(200);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("production build emits __sw__.js as a rollup asset", async () => {
    // Vite lib mode resolves the entry before plugins run, so a virtual
    // module won't work. Point it at a real file in a temp dir.
    const dir = await mkdtemp(join(tmpdir(), "nodepod-vite-test-"));
    const entryPath = join(dir, "entry.js");
    await writeFile(entryPath, "export const x = 1;", "utf8");
    try {
      const result = await build({
        configFile: false,
        root: dir,
        logLevel: "silent",
        plugins: [nodepod()],
        build: {
          write: false,
          lib: {
            entry: { main: entryPath },
            formats: ["es"],
          },
        },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const assets = outputs.flatMap((o) =>
        "output" in o ? (o as RollupOutput).output : [],
      );
      const sw = assets.find(
        (a) => a.type === "asset" && a.fileName === "__sw__.js",
      );
      expect(sw).toBeDefined();
      if (sw && sw.type === "asset") {
        const src = typeof sw.source === "string"
          ? sw.source
          : Buffer.from(sw.source).toString("utf8");
        expect(src.length).toBeGreaterThan(1000);
        expect(src).toMatch(/self\.addEventListener/);
      }

      if (workerAssetBuilt) {
        const worker = assets.find(
          (a) => a.type === "asset" && a.fileName === "__worker__.js",
        );
        expect(worker).toBeDefined();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
