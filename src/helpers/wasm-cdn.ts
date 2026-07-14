// CDN recovery for .wasm files under node_modules that never made it into
// the VFS (e.g. oversized binaries the tarball path skipped). Everything
// here is asynchronous and best-effort — the old synchronous XHR fallback
// that could block a thread for a full 15MB download is gone.

import type { MemoryVolume } from "../memory-volume";
import { precompileWasm, registerCompiledModule, PRECOMPILE_THRESHOLD } from "./wasm-cache";

/**
 * Map a VFS path like `/project/node_modules/@scope/pkg/file.wasm` to its
 * jsdelivr URL, using the installed package.json version when available.
 * Returns null if the path isn't a node_modules .wasm path.
 */
export function buildCdnWasmUrl(volume: MemoryVolume, vfsPath: string): string | null {
  if (!vfsPath.endsWith(".wasm")) return null;
  const nmIdx = vfsPath.lastIndexOf("/node_modules/");
  if (nmIdx === -1) return null;

  const afterNm = vfsPath.substring(nmIdx + "/node_modules/".length);
  const parts = afterNm.split("/");
  let pkgName: string;
  let filePath: string;
  if (parts[0].startsWith("@")) {
    if (parts.length < 3) return null;
    pkgName = parts[0] + "/" + parts[1];
    filePath = parts.slice(2).join("/");
  } else {
    if (parts.length < 2) return null;
    pkgName = parts[0];
    filePath = parts.slice(1).join("/");
  }

  let version = "latest";
  try {
    const pkgJsonPath =
      vfsPath.substring(0, nmIdx + "/node_modules/".length) + pkgName + "/package.json";
    const pkgJson = JSON.parse(volume.readFileSync(pkgJsonPath, "utf8") as string);
    if (pkgJson.version) version = pkgJson.version;
  } catch {
    /* use latest */
  }

  return `https://cdn.jsdelivr.net/npm/${pkgName}@${version}/${filePath}`;
}

const _inflight = new Map<string, Promise<boolean>>();

export function isRecoverableWasmPath(vfsPath: unknown): vfsPath is string {
  return typeof vfsPath === "string"
    && vfsPath.endsWith(".wasm")
    && vfsPath.includes("/node_modules/");
}

/**
 * Fetch a missing node_modules .wasm from the CDN, write it to the VFS, and
 * warm the compile caches. Deduplicated per path; never throws.
 */
export function prefetchWasmFromCdn(volume: MemoryVolume, vfsPath: string): Promise<boolean> {
  const existing = _inflight.get(vfsPath);
  if (existing) return existing;

  const promise = (async (): Promise<boolean> => {
    const cdnUrl = buildCdnWasmUrl(volume, vfsPath);
    if (!cdnUrl || typeof fetch === "undefined") return false;

    try {
      const resp = await fetch(cdnUrl);
      if (!resp.ok) return false;

      // Compile in parallel with the byte read when the browser supports
      // streaming compilation; register the module once we have the bytes.
      let streamingCompile: Promise<WebAssembly.Module> | null = null;
      if (
        typeof WebAssembly !== "undefined" &&
        typeof WebAssembly.compileStreaming === "function"
      ) {
        try {
          streamingCompile = WebAssembly.compileStreaming(resp.clone());
          streamingCompile.catch(() => {});
        } catch {
          streamingCompile = null;
        }
      }

      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (bytes.byteLength === 0) return false;

      try {
        const dir = vfsPath.substring(0, vfsPath.lastIndexOf("/")) || "/";
        volume.mkdirSync(dir, { recursive: true });
        volume.writeFileSync(vfsPath, bytes);
      } catch {
        /* VFS write is best-effort; compile caches still help */
      }

      if (streamingCompile && bytes.byteLength >= PRECOMPILE_THRESHOLD) {
        try {
          registerCompiledModule(bytes, await streamingCompile);
        } catch {
          precompileWasm(bytes);
        }
      } else {
        precompileWasm(bytes);
      }
      return true;
    } catch {
      return false;
    } finally {
      _inflight.delete(vfsPath);
    }
  })();

  _inflight.set(vfsPath, promise);
  return promise;
}
