import { describe, it, expect } from "vitest";
import nodepod from "../../integrations/vite";
import { createServer, build } from "vite";
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

  it("emits the SW and hostname-preview bridge assets during generateBundle", async () => {
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

    const bridgeHtml = emitted.find(
      (a) => a.fileName === "__nodepod_bridge__.html",
    );
    const bridgeScript = emitted.find(
      (a) => a.fileName === "__nodepod_bridge__.js",
    );
    expect(bridgeHtml?.source).toMatch(/__nodepod_bridge__\.js/);
    expect(bridgeScript?.source).toMatch(/serviceWorker\.register/);

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

    for (const [path, contentType] of [
      ["/__nodepod_bridge__.html", /text\/html/i],
      ["/__nodepod_bridge__.js", /javascript/i],
    ] as const) {
      const res = new MockRes();
      await mw({ url: path }, res, () => {
        throw new Error(`next() should not be called for ${path}`);
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toMatch(contentType);
      expect(res.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");
      expect(res.body.length).toBeGreaterThan(100);
    }

    // A first top-level visit has no unpartitioned preview SW yet. On the
    // reserved local hostname, Vite serves the connection bootstrap for any
    // document navigation, including client-router deep links.
    {
      const res = new MockRes();
      await mw(
        {
          url: "/",
          headers: { host: "podabc-5173.localhost:4173" },
        } as any,
        res,
        () => {
          throw new Error("next() should not run for a preview-host root");
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Type"]).toMatch(/text\/html/i);
      expect(res.headers["Cross-Origin-Opener-Policy"]).toBe(
        "same-origin-allow-popups",
      );
      expect(res.body).toMatch(/__nodepod_bridge__\.js/);
    }

    {
      const res = new MockRes();
      await mw(
        {
          url: "/docs/getting-started?tab=api",
          headers: {
            host: "podabc-5173.localhost:4173",
            accept: "text/html,application/xhtml+xml",
            "sec-fetch-mode": "navigate",
          },
        } as any,
        res,
        () => {
          throw new Error("next() should not run for a preview deep link");
        },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/__nodepod_bridge__\.js/);
    }

    {
      const res = new MockRes();
      let nextCalled = false;
      await mw(
        {
          url: "/assets/app.css",
          headers: {
            host: "podabc-5173.localhost:4173",
            accept: "text/css,*/*;q=0.1",
            "sec-fetch-mode": "no-cors",
          },
        } as any,
        res,
        () => { nextCalled = true; },
      );
      expect(nextCalled).toBe(true);
    }

    {
      const res = new MockRes();
      await mw(
        { url: "/__nodepod_bridge__.html?mode=parent" },
        res,
        () => {
          throw new Error("next() should not run for parent bridge");
        },
      );
      expect(res.headers["Cross-Origin-Opener-Policy"]).toBe("unsafe-none");
    }
  });

  it("configurePreviewServer serves the bridge with the site's preview headers", async () => {
    const plugin = nodepod();
    const middlewares: Array<(req: { url?: string }, res: MockRes, next: () => void) => void | Promise<void>> = [];
    const mockServer = {
      config: {
        server: { headers: {} },
        preview: {
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
          },
        },
      },
      middlewares: { use: (mw: (typeof middlewares)[number]) => void middlewares.push(mw) },
    };
    await (plugin.configurePreviewServer as unknown as (s: typeof mockServer) => void | Promise<void>)(mockServer);
    expect(middlewares).toHaveLength(1);

    const res = new MockRes();
    await middlewares[0]({ url: "/__nodepod_bridge__.html" }, res, () => {
      throw new Error("next() should not be called for the bridge");
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect(res.headers["Cross-Origin-Resource-Policy"]).toBe("cross-origin");

    // A parent-mode bridge still overrides the site's opener policy.
    const parent = new MockRes();
    await middlewares[0]({ url: "/__nodepod_bridge__.html?mode=parent" }, parent, () => undefined);
    expect(parent.headers["Cross-Origin-Opener-Policy"]).toBe("unsafe-none");
  });
});

interface BuildAsset {
  type: string;
  fileName?: string;
  source?: string | Uint8Array;
}

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
  it("dev server serves the SW and preview bridge with real HTTP fetch", async () => {
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

      const origin = `http://127.0.0.1:${addr.port}`;
      const bridgeHtml = await fetch(`${origin}/__nodepod_bridge__.html`);
      expect(bridgeHtml.status).toBe(200);
      expect(bridgeHtml.headers.get("content-type")).toMatch(/text\/html/i);
      expect(bridgeHtml.headers.get("cross-origin-resource-policy")).toBe(
        "cross-origin",
      );
      expect(await bridgeHtml.text()).toMatch(/__nodepod_bridge__\.js/);

      const bridgeScript = await fetch(`${origin}/__nodepod_bridge__.js`);
      expect(bridgeScript.status).toBe(200);
      expect(bridgeScript.headers.get("content-type")).toMatch(/javascript/i);
      const bridgeScriptText = await bridgeScript.text();
      expect(bridgeScriptText).toMatch(/serviceWorker\.register/);
      expect(bridgeScriptText).toMatch(/nodepod-bridge-stage/);
      expect(bridgeScriptText).toMatch(/nodepod-bridge-reconnect/);
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
        o && typeof o === "object" && "output" in o
          ? (o as { output: BuildAsset[] }).output
          : [],
      );
      const sw = assets.find(
        (a) => a.type === "asset" && a.fileName === "__sw__.js",
      );
      expect(sw).toBeDefined();
      if (sw && sw.type === "asset") {
        const src = typeof sw.source === "string"
          ? sw.source
          : Buffer.from(sw.source ?? []).toString("utf8");
        expect(src.length).toBeGreaterThan(1000);
        expect(src).toMatch(/self\.addEventListener/);
      }

      if (workerAssetBuilt) {
        const worker = assets.find(
          (a) => a.type === "asset" && a.fileName === "__worker__.js",
        );
        expect(worker).toBeDefined();
      }

      expect(
        assets.find(
          (a) =>
            a.type === "asset" && a.fileName === "__nodepod_bridge__.html",
        ),
      ).toBeDefined();
      expect(
        assets.find(
          (a) =>
            a.type === "asset" && a.fileName === "__nodepod_bridge__.js",
        ),
      ).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
