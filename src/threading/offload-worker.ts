// offload worker entry — runs transform/extract/build tasks on a dedicated thread
// tar parser and base64 helpers are duplicated since workers can't share module state

import { expose } from "comlink";
import type {
  OffloadWorkerEndpoint,
  TransformTask,
  TransformResult,
  ExtractTask,
  ExtractResult,
  ExtractedFile,
  BuildTask,
  BuildResult,
  BuildOutputFile,
} from "./offload-types";

let esbuildEngine: any = null;
let pakoModule: any = null;
let initialized = false;

import { CDN_ESBUILD_ESM, CDN_ESBUILD_BINARY, cdnImport } from "../constants/cdn-urls";
import { CDN_PAKO } from "../constants/config";

const ESBUILD_ESM_URL = CDN_ESBUILD_ESM;
const ESBUILD_WASM_URL = CDN_ESBUILD_BINARY;
const PAKO_URL = CDN_PAKO;

// base64 helpers duplicated from helpers/byte-encoding.ts

const SEGMENT_SIZE = 8192;

function uint8ToBase64(data: Uint8Array): string {
  // chunked btoa for >4MB to stay under browser limits
  if (data.length > 4 * 1024 * 1024) {
    const CHUNK = 3 * 1024 * 1024; // must be a multiple of 3 so base64 boundaries align
    const parts: string[] = [];
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.subarray(i, Math.min(i + CHUNK, data.length));
      let binary = "";
      for (let j = 0; j < slice.length; j += SEGMENT_SIZE) {
        binary += String.fromCharCode.apply(
          null,
          Array.from(slice.subarray(j, Math.min(j + SEGMENT_SIZE, slice.length))),
        );
      }
      parts.push(btoa(binary));
    }
    // strip intermediate padding when joining — only the last chunk keeps it
    return parts.map((p, i) => i < parts.length - 1 ? p.replace(/=+$/, "") : p).join("");
  }
  const segments: string[] = [];
  for (let offset = 0; offset < data.length; offset += SEGMENT_SIZE) {
    segments.push(
      String.fromCharCode.apply(
        null,
        Array.from(data.subarray(offset, offset + SEGMENT_SIZE)),
      ),
    );
  }
  return btoa(segments.join(""));
}

// tar parser duplicated from packages/archive-extractor.ts

function readNullTerminated(
  buf: Uint8Array,
  start: number,
  len: number,
): string {
  // TextDecoder rejects SAB-backed views, copy into a non-shared buffer first
  const section = buf.subarray(start, start + len);
  const zeroPos = section.indexOf(0);
  const effLen = zeroPos >= 0 ? zeroPos : section.byteLength;
  const copy = new Uint8Array(effLen);
  copy.set(section.subarray(0, effLen));
  return new TextDecoder().decode(copy);
}

function readOctalField(
  buf: Uint8Array,
  start: number,
  len: number,
): number {
  const raw = readNullTerminated(buf, start, len).trim();
  return parseInt(raw, 8) || 0;
}

type EntryKind = "file" | "directory" | "link" | "other";

function classifyTypeFlag(flag: string): EntryKind {
  switch (flag) {
    case "0":
    case "\0":
    case "":
      return "file";
    case "5":
      return "directory";
    case "1":
    case "2":
      return "link";
    default:
      return "other";
  }
}

interface TarEntry {
  filepath: string;
  kind: EntryKind;
  byteSize: number;
  payload?: Uint8Array;
}

function* parseTar(raw: Uint8Array): Generator<TarEntry> {
  const BLOCK = 512;
  let cursor = 0;

  while (cursor + BLOCK <= raw.length) {
    const header = raw.slice(cursor, cursor + BLOCK);
    cursor += BLOCK;

    if (header.every((b) => b === 0)) break;

    const nameField = readNullTerminated(header, 0, 100);
    if (!nameField) continue;

    const byteSize = readOctalField(header, 124, 12);
    const typeChar = String.fromCharCode(header[156]);
    const prefixField = readNullTerminated(header, 345, 155);
    const filepath = prefixField
      ? `${prefixField}/${nameField}`
      : nameField;
    const kind = classifyTypeFlag(typeChar);

    let payload: Uint8Array | undefined;
    if (kind === "file") {
      payload =
        byteSize > 0
          ? raw.slice(cursor, cursor + byteSize)
          : new Uint8Array(0);
      if (byteSize > 0) {
        cursor += Math.ceil(byteSize / BLOCK) * BLOCK;
      }
    }

    yield { filepath, kind, byteSize, payload };
  }
}

// JSX detection duplicated from module-transformer.ts
function detectJsx(source: string): boolean {
  if (/<[A-Z][a-zA-Z0-9.]*[\s/>]/.test(source)) return true;
  if (/<\/[a-zA-Z]/.test(source)) return true;
  if (/\/>/.test(source)) return true;
  if (/<>|<\/>/.test(source)) return true;
  if (/React\.createElement\b/.test(source)) return true;
  if (/jsx\(|jsxs\(|jsxDEV\(/.test(source)) return true;
  return false;
}

const DEFAULT_DEFINE: Record<string, string> = {
  "import.meta.url": "import_meta.url",
  "import.meta.dirname": "import_meta.dirname",
  "import.meta.filename": "import_meta.filename",
  "import.meta": "import_meta",
};

// esbuild (~10MB) loads lazily on the first transform task — warm-up only
// pulls pako, which every extract task needs. With lazy install transforms,
// most workers never pay the esbuild download at all.
let esbuildInitPromise: Promise<void> | null = null;

function ensureEsbuild(): Promise<void> {
  if (esbuildEngine) return Promise.resolve();
  if (esbuildInitPromise) return esbuildInitPromise;
  esbuildInitPromise = (async () => {
    const esbuildMod = await cdnImport(ESBUILD_ESM_URL);
    const engine = esbuildMod.default || esbuildMod;
    try {
      await engine.initialize({ wasmURL: ESBUILD_WASM_URL });
    } catch (err: any) {
      if (
        !(
          err instanceof Error &&
          err.message.includes('Cannot call "initialize" more than once')
        )
      ) {
        throw err;
      }
    }
    esbuildEngine = engine;
  })();
  esbuildInitPromise.catch(() => { esbuildInitPromise = null; });
  return esbuildInitPromise;
}

const workerEndpoint: OffloadWorkerEndpoint = {
  async init(): Promise<void> {
    if (initialized) return;

    const pakoMod = await cdnImport(PAKO_URL);
    pakoModule = pakoMod.default || pakoMod;

    initialized = true;
  },

  async transform(task: TransformTask): Promise<TransformResult> {
    await ensureEsbuild();
    if (!esbuildEngine) throw new Error("Worker not initialized");

    const opts = task.options || {};
    let loader: string = opts.loader || "js";
    const format = opts.format || "cjs";
    const define = opts.define || DEFAULT_DEFINE;

    if (loader === "js" && detectJsx(task.source)) loader = "jsx";

    const transformOpts = {
      loader,
      format,
      target: opts.target || "esnext",
      platform: opts.platform || "neutral",
      define,
    };

    try {
      const output = await esbuildEngine.transform(task.source, transformOpts);
      return {
        type: "transform" as const,
        id: task.id,
        code: output.code,
        warnings: (output.warnings || []).map(
          (w: any) => w.text || String(w),
        ),
      };
    } catch (err: any) {
      // retry with fallback loaders
      const fallbacks: string[] =
        loader === "js"
          ? ["jsx", "tsx", "ts"]
          : loader === "jsx"
            ? ["tsx"]
            : [];

      for (const fb of fallbacks) {
        try {
          const output = await esbuildEngine.transform(task.source, {
            ...transformOpts,
            loader: fb,
          });
          return {
            type: "transform" as const,
            id: task.id,
            code: output.code,
            warnings: [],
          };
        } catch {
          /* try next fallback */
        }
      }

      // top-level await — retry as ESM
      if (err?.message?.includes("Top-level await")) {
        try {
          const output = await esbuildEngine.transform(task.source, {
            ...transformOpts,
            format: "esm",
          });
          return {
            type: "transform" as const,
            id: task.id,
            code: output.code,
            warnings: [],
          };
        } catch {
          /* fall through */
        }
      }

      // retries exhausted — return original source
      return {
        type: "transform" as const,
        id: task.id,
        code: task.source,
        warnings: [err?.message || "transform failed"],
      };
    }
  },

  async extract(task: ExtractTask): Promise<ExtractResult> {
    if (!pakoModule) throw new Error("Worker not initialized");

    const response = await fetch(task.tarballUrl);
    if (!response.ok) {
      throw new Error(
        `Archive download failed (HTTP ${response.status}): ${task.tarballUrl}`,
      );
    }

    const compressed = new Uint8Array(await response.arrayBuffer());

    // verify sha1 matches what the registry reported
    if (task.expectedShasum) {
      const hashBuffer = await crypto.subtle.digest("SHA-1", compressed);
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (hashHex !== task.expectedShasum) {
        throw new Error(
          `Integrity check failed for ${task.tarballUrl}: ` +
            `expected shasum ${task.expectedShasum}, got ${hashHex}`,
        );
      }
    }

    const tarBytes = pakoModule.inflate(compressed) as Uint8Array;

    const files: ExtractedFile[] = [];
    for (const entry of parseTar(tarBytes)) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;

      let relative = entry.filepath;
      if (task.stripComponents > 0) {
        const segments = relative.split("/").filter(Boolean);
        if (segments.length <= task.stripComponents) continue;
        relative = segments.slice(task.stripComponents).join("/");
      }

      if (entry.kind === "file" && entry.payload) {
        try {
          let data: string | Uint8Array;
          let isBinary = false;
          try {
            // copy into a non-shared buffer before decoding, TextDecoder rejects SAB-backed views
            const payload = entry.payload;
            const decodable = (typeof SharedArrayBuffer !== "undefined" && payload.buffer instanceof SharedArrayBuffer)
              ? (() => { const c = new Uint8Array(payload.byteLength); c.set(payload); return c; })()
              : payload;
            data = new TextDecoder("utf-8", { fatal: true }).decode(decodable);
          } catch {
            // >1MB binaries go over as raw Uint8Array via structured clone — base64 bloats memory and sometimes fails
            if (entry.payload.length > 1024 * 1024) {
              data = new Uint8Array(entry.payload);
              isBinary = true;
            } else {
              data = uint8ToBase64(entry.payload);
              isBinary = true;
            }
          }
          files.push({ path: relative, data, isBinary });
        } catch (fileErr) {
          // don't fail the whole extraction for one bad file
          console.warn(`[offload] Failed to encode ${relative} (${entry.payload.length} bytes):`, fileErr);
        }
      }
    }

    return { type: "extract" as const, id: task.id, files };
  },

  async build(task: BuildTask): Promise<BuildResult> {
    await ensureEsbuild();
    if (!esbuildEngine) throw new Error("Worker not initialized");

    const fileMap = new Map<string, string>();
    for (const [p, content] of Object.entries(task.files)) {
      fileMap.set(p, content);
    }

    const volumePlugin = {
      name: "offload-volume",
      setup(build: any) {
        build.onLoad({ filter: /.*/ }, (args: any) => {
          const content = fileMap.get(args.path);
          if (content === undefined) return null;
          const ext = args.path.substring(args.path.lastIndexOf("."));
          const loaderMap: Record<string, string> = {
            ".ts": "ts",
            ".tsx": "tsx",
            ".js": "js",
            ".mjs": "js",
            ".cjs": "js",
            ".jsx": "jsx",
            ".json": "json",
            ".css": "css",
          };
          return {
            contents: content,
            loader: loaderMap[ext] || undefined,
          };
        });
      },
    };

    try {
      const result = await esbuildEngine.build({
        entryPoints: task.entryPoints,
        stdin: task.stdin,
        bundle: task.bundle ?? true,
        format: task.format || "esm",
        platform: task.platform || "browser",
        target: task.target || "esnext",
        minify: task.minify ?? false,
        external: task.external,
        write: false,
        plugins: [volumePlugin],
        absWorkingDir: task.absWorkingDir || "/",
      });

      const outputFiles: BuildOutputFile[] = (result.outputFiles || []).map(
        (f: any) => {
          let text: string = f.text;
          if (!text && f.contents) {
            // handle SAB-backed Uint8Array defensively
            const c: Uint8Array = f.contents;
            const decodable = (typeof SharedArrayBuffer !== "undefined" && c.buffer instanceof SharedArrayBuffer)
              ? (() => { const copy = new Uint8Array(c.byteLength); copy.set(c); return copy; })()
              : c;
            text = new TextDecoder().decode(decodable);
          }
          return { path: f.path, text };
        },
      );

      return {
        type: "build" as const,
        id: task.id,
        outputFiles,
        errors: (result.errors || []).map(
          (e: any) => e.text || String(e),
        ),
        warnings: (result.warnings || []).map(
          (w: any) => w.text || String(w),
        ),
      };
    } catch (err: any) {
      return {
        type: "build" as const,
        id: task.id,
        outputFiles: [],
        errors: [err?.message || "build failed"],
        warnings: [],
      };
    }
  },

  ping(): boolean {
    return true;
  },
};

expose(workerEndpoint);
