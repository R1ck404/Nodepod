import { afterEach, describe, it, expect, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { isWasmResolverProbe, prefetchWasmFromCdn, resetCdnRefusals } from "../helpers/wasm-cdn";

describe("isWasmResolverProbe", () => {
  const vol = new MemoryVolume();
  const next = "/app/node_modules/next/dist";
  vol.mkdirSync(`${next}/server`, { recursive: true });
  vol.mkdirSync(`${next}/client`, { recursive: true });
  vol.mkdirSync(`${next}/compiled/react`, { recursive: true });
  vol.writeFileSync(`${next}/server/route-kind.js`, "");
  vol.writeFileSync(`${next}/client/global-error.js`, "");
  vol.mkdirSync("/app/node_modules/sql.js/dist", { recursive: true });
  vol.writeFileSync("/app/node_modules/sql.js/dist/sql-wasm.js", "");

  it("treats an extension appended to a module file name as a probe", () => {
    expect(isWasmResolverProbe(vol, `${next}/client/global-error.js.wasm`)).toBe(true);
    expect(isWasmResolverProbe(vol, `${next}/lib/data.json.wasm`)).toBe(true);
  });

  it("treats an extension appended to a directory as a probe", () => {
    expect(isWasmResolverProbe(vol, `${next}/compiled/react.wasm`)).toBe(true);
  });

  it("keeps binaries that could be real recoverable", () => {
    // emscripten glue sits next to its binary under the same name
    expect(isWasmResolverProbe(vol, "/app/node_modules/sql.js/dist/sql-wasm.wasm")).toBe(false);
    // a worker's install may not have reached this volume yet
    expect(isWasmResolverProbe(vol, "/node_modules/lightningcss-wasm/lightningcss_node.wasm")).toBe(false);
    expect(isWasmResolverProbe(vol, `${next}/server/route-kind.wasm`)).toBe(false);
  });
});

describe("prefetchWasmFromCdn", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCdnRefusals();
  });

  it("stops asking for a package the CDN refused as a whole", async () => {
    const fetchMock = vi.fn(async () => new Response("Package size exceeded", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const vol = new MemoryVolume();
    vol.mkdirSync("/app/node_modules/big/dist", { recursive: true });
    vol.writeFileSync("/app/node_modules/big/package.json", JSON.stringify({ version: "1.2.3" }));

    expect(await prefetchWasmFromCdn(vol, "/app/node_modules/big/dist/a.wasm")).toBe(false);
    expect(await prefetchWasmFromCdn(vol, "/app/node_modules/big/dist/b.wasm")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.jsdelivr.net/npm/big@1.2.3/dist/a.wasm");
  });

  it("keeps asking after a missing file (404): other files may exist", async () => {
    const fetchMock = vi.fn(async () => new Response("Not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const vol = new MemoryVolume();
    vol.mkdirSync("/app/node_modules/pkg", { recursive: true });
    vol.writeFileSync("/app/node_modules/pkg/package.json", JSON.stringify({ version: "2.0.0" }));

    await prefetchWasmFromCdn(vol, "/app/node_modules/pkg/x.wasm");
    await prefetchWasmFromCdn(vol, "/app/node_modules/pkg/y.wasm");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
