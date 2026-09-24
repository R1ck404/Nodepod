// CDN recovery for .wasm files under node_modules that never made it into
// the VFS (e.g. oversized binaries the tarball path skipped). Everything
// here is asynchronous and best-effort — the old synchronous XHR fallback
// that could block a thread for a full 15MB download is gone.

import type { MemoryVolume } from "../memory-volume";
import { precompileWasm, registerCompiledModule, PRECOMPILE_THRESHOLD } from "./wasm-cache";

const WASM_DEBUG_SUFFIX = ".debug.wasm";

/**
 * NAPI-RS loaders may probe an optional `<name>.debug.wasm` next to the
 * release `<name>.wasm`. A missing debug artifact must never turn into a CDN
 * request for that filename: published packages commonly ship only release
 * WASM. Keep the mapping generic for every napi-rs WASI package.
 */
export function resolveWasmAssetPath(volume: MemoryVolume, vfsPath: string): string {
  if (!vfsPath.endsWith(WASM_DEBUG_SUFFIX) || volume.existsSync(vfsPath)) {
    return vfsPath;
  }
  return vfsPath.slice(0, -WASM_DEBUG_SUFFIX.length) + ".wasm";
}

/**
 * Map a VFS path like `/project/node_modules/@scope/pkg/file.wasm` to its
 * jsdelivr URL, using the installed package.json version when available.
 * Returns null if the path isn't a node_modules .wasm path.
 */
export function buildCdnWasmUrl(volume: MemoryVolume, vfsPath: string): string | null {
  if (!vfsPath.endsWith(".wasm")) return null;
  const nmIdx = vfsPath.lastIndexOf("/node_modules/");
  if (nmIdx === -1) return null;

  const assetPath = resolveWasmAssetPath(volume, vfsPath);

  const afterNm = assetPath.substring(nmIdx + "/node_modules/".length);
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

const RESOLVER_PROBE_RE = /\.(?:[cm]?js|jsx|tsx?|json|node)\.wasm$/;

/**
 * True when a missing `.wasm` path can only be a module resolver trying
 * extensions: webpack resolves with `.wasm` among its extensions, so
 * `global-error.js` is also stat'ed as `global-error.js.wasm` and the
 * `react` directory as `react.wasm`. Only positive evidence counts: a
 * sibling module or a missing directory can't rule out a real binary
 * (emscripten ships foo.js next to foo.wasm, and a worker's install may not
 * have reached this volume yet).
 */
export function isWasmResolverProbe(volume: MemoryVolume, vfsPath: string): boolean {
  if (RESOLVER_PROBE_RE.test(vfsPath)) return true;
  try {
    return volume.statSync(vfsPath.slice(0, -".wasm".length)).isDirectory();
  } catch {
    return false;
  }
}

// package@version the CDN refused as a whole (jsdelivr answers 403 when a
// package is too large to serve, e.g. next): every other path in it would be
// refused too, so don't ask again.
const _refusedPackages = new Set<string>();

function cdnPackageKey(cdnUrl: string): string {
  const rest = cdnUrl.slice(cdnUrl.indexOf("/npm/") + "/npm/".length);
  const at = rest.indexOf("@", rest.startsWith("@") ? 1 : 0);
  const slash = rest.indexOf("/", at);
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** Forget packages the CDN refused (tests). */
export function resetCdnRefusals(): void {
  _refusedPackages.clear();
}

/**
 * Fetch a missing node_modules .wasm from the CDN, write it to the VFS, and
 * warm the compile caches. Deduplicated per path; never throws.
 */
export function prefetchWasmFromCdn(volume: MemoryVolume, vfsPath: string): Promise<boolean> {
  const assetPath = resolveWasmAssetPath(volume, vfsPath);
  const existing = _inflight.get(assetPath);
  if (existing) return existing;

  const promise = (async (): Promise<boolean> => {
    const cdnUrl = buildCdnWasmUrl(volume, assetPath);
    if (!cdnUrl || typeof fetch === "undefined") return false;
    const packageKey = cdnPackageKey(cdnUrl);
    if (_refusedPackages.has(packageKey)) return false;

    try {
      const resp = await fetch(cdnUrl);
      if (!resp.ok) {
        if (resp.status === 403) _refusedPackages.add(packageKey);
        return false;
      }

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
        const dir = assetPath.substring(0, assetPath.lastIndexOf("/")) || "/";
        volume.mkdirSync(dir, { recursive: true });
        volume.writeFileSync(assetPath, bytes);
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
      _inflight.delete(assetPath);
    }
  })();

  _inflight.set(assetPath, promise);
  return promise;
}
