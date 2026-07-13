// creates offload workers from an embedded source string via Blob URL so no separate file needs serving
// speaks Comlink's wire protocol directly so the message listener is synchronous on boot — avoids races with the first init() call
// heavy deps (esbuild, pako) load from CDN lazily

import { CDN_ESBUILD_ESM, CDN_ESBUILD_BINARY } from "../constants/cdn-urls";
import { CDN_PAKO } from "../constants/config";

const WORKER_SOURCE = /* js */ `
"use strict";

// CDN URLs injected at build time
const ESBUILD_ESM_URL = "${CDN_ESBUILD_ESM}";
const ESBUILD_WASM_URL = "${CDN_ESBUILD_BINARY}";
const PAKO_URL = "${CDN_PAKO}";

const cdnImport = new Function("url", "return import(url)");

let esbuildEngine = null;
let pakoModule = null;
let _initialized = false;

// minimal Comlink-compatible expose() — implements the wire protocol that comlink.wrap() speaks on the main thread
function miniExpose(obj) {
  self.addEventListener("message", function handler(ev) {
    if (!ev || !ev.data || !ev.data.id) return;
    const { id, type, path } = { path: [], ...ev.data };

    const args = (ev.data.argumentList || []).map(function(a) {
      return (a && a.type === "RAW") ? a.value : a;
    });

    let returnValue;
    try {
      const parent = path.length > 1
        ? path.slice(0, -1).reduce(function(o, p) { return o[p]; }, obj)
        : obj;
      const target = path.reduce(function(o, p) { return o[p]; }, obj);

      switch (type) {
        case "GET":
          returnValue = target;
          break;
        case "SET":
          parent[path[path.length - 1]] = (ev.data.value && ev.data.value.type === "RAW")
            ? ev.data.value.value
            : ev.data.value;
          returnValue = true;
          break;
        case "APPLY":
          returnValue = target.apply(parent, args);
          break;
        case "CONSTRUCT":
          returnValue = new target(...args);
          break;
        case "RELEASE":
          returnValue = undefined;
          break;
        default:
          return;
      }
    } catch (err) {
      self.postMessage({
        id: id,
        type: "HANDLER",
        name: "throw",
        value: {
          isError: true,
          value: { message: (err && err.message) || String(err), name: (err && err.name) || "Error", stack: (err && err.stack) || "" }
        }
      });
      return;
    }

    Promise.resolve(returnValue)
      .then(function(result) {
        const transferables = [];
        if (result && Array.isArray(result.files)) {
          for (const file of result.files) {
            if (file && file.data instanceof Uint8Array && file.data.buffer instanceof ArrayBuffer) {
              transferables.push(file.data.buffer);
            }
          }
        }
        if (result && result.tarballBytes instanceof ArrayBuffer) {
          transferables.push(result.tarballBytes);
        }
        self.postMessage({ id: id, type: "RAW", value: result }, transferables);
      })
      .catch(function(err) {
        self.postMessage({
          id: id,
          type: "HANDLER",
          name: "throw",
          value: {
            isError: true,
            value: { message: (err && err.message) || String(err), name: (err && err.name) || "Error", stack: (err && err.stack) || "" }
          }
        });
      });
  });
}

const SEGMENT_SIZE = 8192;

function uint8ToBase64(data) {
  const segments = [];
  for (let offset = 0; offset < data.length; offset += SEGMENT_SIZE) {
    segments.push(
      String.fromCharCode.apply(
        null,
        Array.from(data.subarray(offset, offset + SEGMENT_SIZE))
      )
    );
  }
  return btoa(segments.join(""));
}

function readNullTerminated(buf, start, len) {
  // TextDecoder rejects SharedArrayBuffer-backed views, copy first
  const section = buf.subarray(start, start + len);
  const zeroPos = section.indexOf(0);
  const effLen = zeroPos >= 0 ? zeroPos : section.byteLength;
  const copy = new Uint8Array(effLen);
  copy.set(section.subarray(0, effLen));
  return new TextDecoder().decode(copy);
}

function readOctalField(buf, start, len) {
  const raw = readNullTerminated(buf, start, len).trim();
  return parseInt(raw, 8) || 0;
}

function classifyTypeFlag(flag) {
  switch (flag) {
    case "0": case "\\0": case "": return "file";
    case "5": return "directory";
    case "1": case "2": return "link";
    default: return "other";
  }
}

function* parseTar(raw) {
  const BLOCK = 512;
  let cursor = 0;
  while (cursor + BLOCK <= raw.length) {
    const header = raw.slice(cursor, cursor + BLOCK);
    cursor += BLOCK;
    if (header.every(function(b) { return b === 0; })) break;
    const nameField = readNullTerminated(header, 0, 100);
    if (!nameField) continue;
    const byteSize = readOctalField(header, 124, 12);
    const typeChar = String.fromCharCode(header[156]);
    const prefixField = readNullTerminated(header, 345, 155);
    const filepath = prefixField ? prefixField + "/" + nameField : nameField;
    const kind = classifyTypeFlag(typeChar);
    let payload;
    if (kind === "file") {
      payload = byteSize > 0 ? raw.slice(cursor, cursor + byteSize) : new Uint8Array(0);
      if (byteSize > 0) cursor += Math.ceil(byteSize / BLOCK) * BLOCK;
    }
    yield { filepath: filepath, kind: kind, byteSize: byteSize, payload: payload };
  }
}

class ByteQueue {
  constructor() { this.chunks = []; this.offset = 0; this.available = 0; }
  push(chunk) {
    if (!chunk.byteLength) return;
    this.chunks.push(chunk);
    this.available += chunk.byteLength;
  }
  take(length) {
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
  skip(length) { this.take(length); }
}

function parseTarHeader(header) {
  if (header.every(function(b) { return b === 0; })) return null;
  const nameField = readNullTerminated(header, 0, 100);
  if (!nameField) return null;
  const byteSize = readOctalField(header, 124, 12);
  const typeChar = String.fromCharCode(header[156]);
  const prefixField = readNullTerminated(header, 345, 155);
  return {
    filepath: prefixField ? prefixField + "/" + nameField : nameField,
    kind: classifyTypeFlag(typeChar),
    byteSize: byteSize,
  };
}

async function* parseCompressedTar(compressed) {
  if (typeof DecompressionStream === "undefined") {
    if (!pakoModule) {
      const pakoMod = await cdnImport(PAKO_URL);
      pakoModule = pakoMod.default || pakoMod;
    }
    yield* parseTar(pakoModule.inflate(compressed));
    return;
  }
  const reader = new Blob([compressed]).stream()
    .pipeThrough(new DecompressionStream("gzip")).getReader();
  const queue = new ByteQueue();
  let current = null;
  while (true) {
    const chunk = await reader.read();
    if (!chunk.done) queue.push(chunk.value);
    while (true) {
      if (!current) {
        if (queue.available < 512) break;
        current = parseTarHeader(queue.take(512));
        if (!current) return;
      }
      const padded = Math.ceil(current.byteSize / 512) * 512;
      if (queue.available < padded) break;
      const payload = current.byteSize > 0 ? queue.take(current.byteSize) : new Uint8Array(0);
      if (padded > current.byteSize) queue.skip(padded - current.byteSize);
      yield {
        filepath: current.filepath,
        kind: current.kind,
        byteSize: current.byteSize,
        payload: current.kind === "file" ? payload : undefined,
      };
      current = null;
    }
    if (chunk.done) break;
  }
  if (current || queue.available > 0) throw new Error("Truncated tar archive");
}

function detectJsx(source) {
  if (/<[A-Z][a-zA-Z0-9.]*[\\s/>]/.test(source)) return true;
  if (/<\\/[a-zA-Z]/.test(source)) return true;
  if (/\\/>/.test(source)) return true;
  if (/<>|<\\/>/.test(source)) return true;
  if (/React\\.createElement\\b/.test(source)) return true;
  if (/jsx\\(|jsxs\\(|jsxDEV\\(/.test(source)) return true;
  return false;
}

const DEFAULT_DEFINE = {
  "import.meta.url": "import_meta.url",
  "import.meta.dirname": "import_meta.dirname",
  "import.meta.filename": "import_meta.filename",
  "import.meta": "import_meta",
};

// esbuild (~10MB) loads lazily on the first transform/build task — warm-up
// only pulls pako, which every extract task needs. With lazy install
// transforms most pool workers never fetch esbuild at all.
let _esbuildInitPromise = null;

function ensureEsbuild() {
  if (esbuildEngine) return Promise.resolve();
  if (_esbuildInitPromise) return _esbuildInitPromise;
  _esbuildInitPromise = (async function () {
    const esbuildMod = await cdnImport(ESBUILD_ESM_URL);
    const engine = esbuildMod.default || esbuildMod;
    try {
      await engine.initialize({ wasmURL: ESBUILD_WASM_URL });
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('Cannot call "initialize" more than once'))) {
        throw err;
      }
    }
    esbuildEngine = engine;
  })();
  _esbuildInitPromise.catch(function () { _esbuildInitPromise = null; });
  return _esbuildInitPromise;
}

const endpoint = {
  async init() {
    if (_initialized) return;

    _initialized = true;
  },

  async transform(task) {
    await ensureEsbuild();
    if (!esbuildEngine) throw new Error("Worker not initialized");

    const opts = task.options || {};
    let loader = opts.loader || "js";
    const format = opts.format || "cjs";
    const define = opts.define || DEFAULT_DEFINE;

    if (loader === "js" && detectJsx(task.source)) loader = "jsx";

    const transformOpts = {
      loader: loader,
      format: format,
      target: opts.target || "esnext",
      platform: opts.platform || "neutral",
      define: define,
    };

    try {
      const output = await esbuildEngine.transform(task.source, transformOpts);
      return {
        type: "transform",
        id: task.id,
        code: output.code,
        warnings: (output.warnings || []).map(function(w) { return w.text || String(w); }),
      };
    } catch (err) {
      const fallbacks = loader === "js" ? ["jsx", "tsx", "ts"] : loader === "jsx" ? ["tsx"] : [];
      for (let i = 0; i < fallbacks.length; i++) {
        try {
          const output = await esbuildEngine.transform(task.source, Object.assign({}, transformOpts, { loader: fallbacks[i] }));
          return { type: "transform", id: task.id, code: output.code, warnings: [] };
        } catch (e) { /* try next */ }
      }
      if (err && err.message && err.message.includes("Top-level await")) {
        try {
          const output = await esbuildEngine.transform(task.source, Object.assign({}, transformOpts, { format: "esm" }));
          return { type: "transform", id: task.id, code: output.code, warnings: [] };
        } catch (e) { /* fall through */ }
      }
      return { type: "transform", id: task.id, code: task.source, warnings: [(err && err.message) || "transform failed"] };
    }
  },

  async extract(task) {
    if (!_initialized) throw new Error("Worker not initialized");

    // main thread passes cached tarball bytes on warm runs — skip the fetch
    let compressed;
    if (task.tarballBytes && task.tarballBytes.byteLength > 0) {
      compressed = new Uint8Array(task.tarballBytes);
    } else {
      const response = await fetch(task.tarballUrl);
      if (!response.ok) {
        throw new Error("Archive download failed (HTTP " + response.status + "): " + task.tarballUrl);
      }
      compressed = new Uint8Array(await response.arrayBuffer());
    }
    const files = [];
    for await (const entry of parseCompressedTar(compressed)) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;
      let relative = entry.filepath;
      if (task.stripComponents > 0) {
        const segments = relative.split("/").filter(Boolean);
        if (segments.length <= task.stripComponents) continue;
        relative = segments.slice(task.stripComponents).join("/");
      }
      if (entry.kind === "file" && entry.payload) {
        files.push({ path: relative, data: entry.payload, isBinary: true });
      }
    }

    const result = { type: "extract", id: task.id, files: files };
    // hand the compressed bytes back so main can persist them (tarball cache)
    if (task.wantTarball) {
      result.tarballBytes = compressed.buffer.byteLength === compressed.byteLength
        ? compressed.buffer
        : compressed.slice().buffer;
    }
    return result;
  },

  async build(task) {
    await ensureEsbuild();
    if (!esbuildEngine) throw new Error("Worker not initialized");

    const fileMap = new Map();
    const entries = Object.entries(task.files);
    for (let i = 0; i < entries.length; i++) {
      fileMap.set(entries[i][0], entries[i][1]);
    }

    const volumePlugin = {
      name: "offload-volume",
      setup: function(build) {
        build.onLoad({ filter: /.*/ }, function(args) {
          const content = fileMap.get(args.path);
          if (content === undefined) return null;
          const ext = args.path.substring(args.path.lastIndexOf("."));
          const loaderMap = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx", ".json": "json", ".css": "css" };
          return { contents: content, loader: loaderMap[ext] || undefined };
        });
      },
    };

    try {
      const result = await esbuildEngine.build({
        entryPoints: task.entryPoints,
        stdin: task.stdin,
        bundle: task.bundle !== false,
        format: task.format || "esm",
        platform: task.platform || "browser",
        target: task.target || "esnext",
        minify: !!task.minify,
        external: task.external,
        write: false,
        plugins: [volumePlugin],
        absWorkingDir: task.absWorkingDir || "/",
      });

      return {
        type: "build",
        id: task.id,
        outputFiles: (result.outputFiles || []).map(function(f) {
          let text = f.text;
          if (!text && f.contents) {
            const c = f.contents;
            const decodable = (typeof SharedArrayBuffer !== "undefined" && c.buffer instanceof SharedArrayBuffer)
              ? (function () { const copy = new Uint8Array(c.byteLength); copy.set(c); return copy; })()
              : c;
            text = new TextDecoder().decode(decodable);
          }
          return { path: f.path, text: text };
        }),
        errors: (result.errors || []).map(function(e) { return e.text || String(e); }),
        warnings: (result.warnings || []).map(function(w) { return w.text || String(w); }),
      };
    } catch (err) {
      return {
        type: "build",
        id: task.id,
        outputFiles: [],
        errors: [(err && err.message) || "build failed"],
        warnings: [],
      };
    }
  },

  ping: function() {
    return true;
  },
};

miniExpose(endpoint);
`;

let cachedBlobUrl: string | null = null;

// blob URL is cached and reused across workers
export function createInlineWorker(): Worker | null {
  try {
    if (!cachedBlobUrl) {
      const blob = new Blob([WORKER_SOURCE], { type: "application/javascript" });
      cachedBlobUrl = URL.createObjectURL(blob);
    }
    return new Worker(cachedBlobUrl);
  } catch {
    return null;
  }
}

// call when the pool is permanently disposed
export function revokeInlineWorkerUrl(): void {
  if (cachedBlobUrl) {
    URL.revokeObjectURL(cachedBlobUrl);
    cachedBlobUrl = null;
  }
}
