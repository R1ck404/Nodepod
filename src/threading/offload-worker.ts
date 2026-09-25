// offload worker entry — runs transform/extract/build tasks on a dedicated thread
// tar parser and base64 helpers are duplicated since workers can't share module state

import { expose, transfer as transferValue } from "comlink";
import type {
  OffloadWorkerEndpoint,
  TransformTask,
  TransformResult,
  TransformBatchTask,
  TransformBatchResult,
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
import { containsJsx } from "./jsx-detection";

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

let headerDecoder: TextDecoder | null = null;

function readNullTerminated(
  buf: Uint8Array,
  start: number,
  len: number,
): string {
  const limit = Math.min(start + len, buf.length);
  let end = start;
  let ascii = true;
  while (end < limit) {
    const b = buf[end];
    if (b === 0) break;
    if (b >= 0x80) ascii = false;
    end++;
  }
  if (end === start) return "";
  if (ascii) return String.fromCharCode.apply(null, buf.subarray(start, end) as unknown as number[]);
  // TextDecoder rejects SAB-backed views: slice() copies into a plain buffer
  return (headerDecoder ??= new TextDecoder()).decode(buf.slice(start, end));
}

// parseInt(field.trim(), 8) || 0, without building the string
function readOctalField(
  buf: Uint8Array,
  start: number,
  len: number,
): number {
  const limit = Math.min(start + len, buf.length);
  let i = start;
  while (i < limit && (buf[i] === 0x20 || (buf[i] >= 0x09 && buf[i] <= 0x0d))) i++;
  let sign = 1;
  if (i < limit && (buf[i] === 0x2b || buf[i] === 0x2d)) {
    if (buf[i] === 0x2d) sign = -1;
    i++;
  }
  let value = 0;
  let digits = 0;
  while (i < limit && buf[i] >= 0x30 && buf[i] <= 0x37) {
    value = value * 8 + (buf[i] - 0x30);
    digits++;
    i++;
  }
  return digits > 0 ? sign * value || 0 : 0;
}

function isZeroBlock(buf: Uint8Array): boolean {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
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

export class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  available = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.available += chunk.byteLength;
  }

  take(length: number): Uint8Array {
    if (length > this.available) throw new Error("tar stream underflow");
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = this.chunks[0];
      const count = Math.min(length - written, first.byteLength - this.offset);
      output.set(first.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      this.available -= count;
      if (this.offset === first.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return output;
  }

  skip(length: number): void {
    this.take(length);
  }
}

function parseTarHeader(header: Uint8Array): Omit<TarEntry, "payload"> | null {
  if (isZeroBlock(header)) return null;
  const nameField = readNullTerminated(header, 0, 100);
  if (!nameField) return null;
  const byteSize = readOctalField(header, 124, 12);
  const typeChar = String.fromCharCode(header[156]);
  const prefixField = readNullTerminated(header, 345, 155);
  return {
    filepath: prefixField ? `${prefixField}/${nameField}` : nameField,
    kind: classifyTypeFlag(typeChar),
    byteSize,
  };
}

async function* parseCompressedTar(
  compressed: Uint8Array,
): AsyncGenerator<TarEntry> {
  if (typeof DecompressionStream === "undefined") {
    if (!pakoModule) {
      const pakoMod = await cdnImport(PAKO_URL);
      pakoModule = pakoMod.default || pakoMod;
    }
    yield* parseTar(pakoModule.inflate(compressed) as Uint8Array);
    return;
  }

  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  yield* parseTarStream(stream);
}

export async function* parseTarStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const reader = stream.getReader();
  const queue = new ByteQueue();
  let current: Omit<TarEntry, "payload"> | null = null;
  while (true) {
    const chunk = await reader.read();
    if (!chunk.done) queue.push(chunk.value);
    while (true) {
      if (!current) {
        if (queue.available < 512) break;
        const header = parseTarHeader(queue.take(512));
        if (!header) return;
        current = header;
      }
      const padded = Math.ceil(current.byteSize / 512) * 512;
      if (queue.available < padded) break;
      const payload = current.byteSize > 0
        ? queue.take(current.byteSize)
        : new Uint8Array(0);
      if (padded > current.byteSize) queue.skip(padded - current.byteSize);
      yield { ...current, payload: current.kind === "file" ? payload : undefined };
      current = null;
    }
    if (chunk.done) break;
  }
  if (current || queue.available > 0) throw new Error("Truncated tar archive");
}

function* parseTar(raw: Uint8Array): Generator<TarEntry> {
  const BLOCK = 512;
  let cursor = 0;

  while (cursor + BLOCK <= raw.length) {
    const header = raw.slice(cursor, cursor + BLOCK);
    cursor += BLOCK;

    if (isZeroBlock(header)) break;

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
    }
    // Always advance past payload blocks so PAX/GNU/link entries don't desync.
    if (byteSize > 0) {
      cursor += Math.ceil(byteSize / BLOCK) * BLOCK;
    }

    yield { filepath, kind, byteSize, payload };
  }
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

    initialized = true;
  },

  async transform(task: TransformTask): Promise<TransformResult> {
    await ensureEsbuild();
    if (!esbuildEngine) throw new Error("Worker not initialized");

    const opts = task.options || {};
    let loader: string = opts.loader || "js";
    const format = opts.format || "cjs";
    const define = opts.define || DEFAULT_DEFINE;

    if (loader === "js" && containsJsx(task.source)) loader = "jsx";

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

  async transformBatch(task: TransformBatchTask): Promise<TransformBatchResult> {
    // One wire task keeps queue/transfer overhead proportional to the batch,
    // while the per-file transform path retains its existing fallbacks.
    const results = await Promise.all(task.files.map(async (file) => {
      const result = await workerEndpoint.transform({
        type: "transform",
        id: task.id,
        source: file.source,
        filePath: file.filePath,
        options: { ...task.options, loader: file.loader },
        priority: task.priority,
      });
      return {
        filePath: file.filePath,
        code: result.code,
        warnings: result.warnings,
      };
    }));
    return { type: "transformBatch", id: task.id, results };
  },

  async extract(task: ExtractTask): Promise<ExtractResult> {
    if (!initialized) throw new Error("Worker not initialized");

    let compressed: Uint8Array;
    if (task.tarballBytes && task.tarballBytes.byteLength > 0) {
      compressed = new Uint8Array(task.tarballBytes);
    } else {
      const response = await fetch(task.tarballUrl);
      if (!response.ok) {
        throw new Error(
          `Archive download failed (HTTP ${response.status}): ${task.tarballUrl}`,
        );
      }
      compressed = new Uint8Array(await response.arrayBuffer());
    }

    // verify sha1 matches what the registry reported
    if (task.expectedShasum) {
      const hashInput = new Uint8Array(compressed.byteLength);
      hashInput.set(compressed);
      const hashBuffer = await crypto.subtle.digest("SHA-1", hashInput);
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

    const files: ExtractedFile[] = [];
    for await (const entry of parseCompressedTar(compressed)) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;

      let relative = entry.filepath;
      if (task.stripComponents > 0) {
        const segments = relative.split("/").filter(Boolean);
        if (segments.length <= task.stripComponents) continue;
        relative = segments.slice(task.stripComponents).join("/");
      }

      if (entry.kind === "file" && entry.payload) {
        try {
          // the destination VFS stores bytes; keeping every entry binary
          // avoids UTF-16 and base64 amplification while the archive and its
          // extracted result coexist.
          const file = {
            path: relative,
            data: new Uint8Array(entry.payload),
            isBinary: true,
          };
          if (task.streamPort) {
            task.streamPort.postMessage({ type: "file", file }, [file.data.buffer]);
          } else {
            files.push(file);
          }
        } catch (fileErr) {
          // don't fail the whole extraction for one bad file
          console.warn(`[offload] Failed to encode ${relative} (${entry.payload.length} bytes):`, fileErr);
        }
      }
    }

    if (task.streamPort) {
      task.streamPort.postMessage({ type: "done" });
      task.streamPort.close();
    }
    const result: ExtractResult = {
      type: "extract" as const,
      id: task.id,
      files,
      streamed: !!task.streamPort,
    };
    if (task.wantTarball) {
      result.tarballBytes = compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      ) as ArrayBuffer;
    }
    const transferables = files
      .filter((file) => file.data instanceof Uint8Array)
      .map((file) => (file.data as Uint8Array).buffer as ArrayBuffer);
    if (result.tarballBytes) transferables.push(result.tarballBytes);
    return transferValue(result, transferables);
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

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  expose(workerEndpoint);
}
