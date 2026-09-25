// Archive Extractor — downloads .tgz from npm, decompresses, parses tar, writes to VFS.
// Heavy work is offloaded to web workers when available.

import pako from "pako";
import { MemoryVolume } from "../memory-volume";
import { downloadTarball } from "./registry-client";
import { takePrefetchedTarball } from "./tarball-prefetch";
import * as path from "../polyfills/path";
import { offload, profiledOffload, taskId, TaskPriority } from "../threading/offload";
import type { ExtractResult } from "../threading/offload-types";
import { base64ToBytes } from "../helpers/byte-encoding";
import { precompileWasm } from "../helpers/wasm-cache";
import { getTarballCache } from "../persistence/tarball-cache";
import { digestSync } from "../polyfills/sync-digest";
import type { NodepodProfilerImpl } from "../profiling/profiler";

// skip round-tripping very large tarballs back from the worker just to cache
const TARBALL_CACHE_MAX_BYTES = 20 * 1024 * 1024;
let extractionTail: Promise<void> = Promise.resolve();

async function withExtractionSlot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = extractionTail;
  let release!: () => void;
  extractionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function removeTree(vol: MemoryVolume, root: string): void {
  if (!vol.existsSync(root)) return;
  if (!vol.statSync(root).isDirectory()) {
    vol.unlinkSync(root);
    return;
  }
  for (const name of vol.readdirSync(root) as string[]) {
    removeTree(vol, path.join(root, name));
  }
  vol.rmdirSync(root);
}

/** Returns safe absolute path if relative stays inside destDir, else null (zip-slip guard). */
export function safeJoin(destDir: string, relative: string): string | null {
  const base = path.normalize(destDir).replace(/\/+$/, "");
  const abs = path.normalize(path.join(base, relative));
  if (abs === base) return abs;
  if (abs.startsWith(base + "/")) return abs;
  return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractionOptions {
  // default 1 — strips npm's "package/" prefix
  stripComponents?: number;
  filter?: (entryPath: string) => boolean;
  onProgress?: (msg: string) => void;
  /** expected sha1 hex from the npm registry, checked after download */
  expectedShasum?: string;
  /** npm lockfile SRI, e.g. `sha512-<base64>` — verified on main after download */
  expectedIntegrity?: string;
  /** Internal opt-in profiler hook. Omitted on the default path. */
  profiler?: NodepodProfilerImpl | null;
  /** Sees every extracted file (path relative to the package) as it is written. */
  onFile?: (relativePath: string, data: Uint8Array | string) => void;
}

function verifySri(bytes: ArrayBuffer, integrity: string, url: string): void {
  const m = /^sha(256|384|512)-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!m) {
    throw new Error(`Unsupported integrity algorithm for ${url}: ${integrity}`);
  }
  const alg = `SHA-${m[1]}` as "SHA-256" | "SHA-384" | "SHA-512";
  const expectedB64 = m[2];
  const digest = digestSync(alg, new Uint8Array(bytes));
  let binary = "";
  for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]!);
  const actualB64 = btoa(binary);
  if (actualB64 !== expectedB64) {
    throw new Error(
      `Integrity check failed for ${url}: expected ${integrity}, got ${alg.toLowerCase().replace("-", "")}-${actualB64}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal tar structures
// ---------------------------------------------------------------------------

type EntryKind = "file" | "directory" | "link" | "other";

interface ArchiveEntry {
  filepath: string;
  kind: EntryKind;
  byteSize: number;
  fileMode: number;
  payload?: Uint8Array;
  linkDestination?: string;
}

// ---------------------------------------------------------------------------
// Tar header helpers
// ---------------------------------------------------------------------------

let headerDecoder: TextDecoder | null = null;

// A header field up to its first NUL. Fields are read for every entry of
// every package, so plain ASCII (nearly all of them) skips the decoder.
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
  return (headerDecoder ??= new TextDecoder()).decode(buf.slice(start, end));
}

// parseInt(field.trim(), 8) || 0, without building the string
function readOctalField(buf: Uint8Array, start: number, len: number): number {
  const limit = Math.min(start + len, buf.length);
  let i = start;
  // leading whitespace (what trim() and parseInt skip)
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

function isZeroBlock(buf: Uint8Array, start: number, len: number): boolean {
  for (let i = start; i < start + len; i++) if (buf[i] !== 0) return false;
  return true;
}

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

// ---------------------------------------------------------------------------
// Tar parser (generator)
// ---------------------------------------------------------------------------

export function* parseTarArchive(raw: Uint8Array): Generator<ArchiveEntry> {
  const BLOCK = 512;
  let cursor = 0;

  while (cursor + BLOCK <= raw.length) {
    const header = cursor;
    cursor += BLOCK;

    // two zero blocks = end of archive
    if (isZeroBlock(raw, header, BLOCK)) break;

    const nameField = readNullTerminated(raw, header, 100);
    if (!nameField) continue;

    const fileMode = readOctalField(raw, header + 100, 8);
    const byteSize = readOctalField(raw, header + 124, 12);
    const typeChar = String.fromCharCode(raw[header + 156]);
    const linkField = readNullTerminated(raw, header + 157, 100);
    const prefixField = readNullTerminated(raw, header + 345, 155);

    const filepath = prefixField ? `${prefixField}/${nameField}` : nameField;
    const kind = classifyTypeFlag(typeChar);

    let payload: Uint8Array | undefined;
    if (kind === "file") {
      payload =
        byteSize > 0 ? raw.slice(cursor, cursor + byteSize) : new Uint8Array(0);
    }
    // Always advance past payload blocks (PAX/GNU/link may carry size) to
    // keep the stream aligned even when we skip materializing the entry.
    if (byteSize > 0) {
      cursor += Math.ceil(byteSize / BLOCK) * BLOCK;
    }

    yield {
      filepath,
      kind,
      byteSize,
      fileMode,
      payload,
      linkDestination: kind === "link" ? linkField : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

export function inflateGzip(compressed: ArrayBuffer | Uint8Array): Uint8Array {
  const input =
    compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
  return pako.inflate(input);
}

// ---------------------------------------------------------------------------
// Extraction into MemoryVolume
// ---------------------------------------------------------------------------

export function extractArchive(
  archiveBytes: ArrayBuffer | Uint8Array,
  vol: MemoryVolume,
  destDir: string,
  opts: ExtractionOptions = {},
): string[] {
  const { stripComponents = 1, filter, onProgress } = opts;

  onProgress?.("Inflating archive...");
  const tarBytes = inflateGzip(archiveBytes);

  const writtenPaths: string[] = [];

  for (const entry of parseTarArchive(tarBytes)) {
    if (entry.kind !== "file" && entry.kind !== "directory") continue;

    let relative = entry.filepath;
    if (stripComponents > 0) {
      const segments = relative.split("/").filter(Boolean);
      if (segments.length <= stripComponents) continue;
      relative = segments.slice(stripComponents).join("/");
    }

    if (filter && !filter(relative)) continue;

    const absolute = safeJoin(destDir, relative);
    if (!absolute) continue;

    if (entry.kind === "directory") {
      vol.mkdirSync(absolute, { recursive: true });
    } else if (entry.kind === "file" && entry.payload) {
      const parentDir = path.dirname(absolute);
      vol.mkdirSync(parentDir, { recursive: true });
      vol.writeFileSync(absolute, entry.payload);
      // pre-compile so it's ready by the time code needs it
      if (absolute.endsWith(".wasm")) {
        precompileWasm(entry.payload);
      }
      writtenPaths.push(absolute);
    }
  }

  onProgress?.(`Extracted ${writtenPaths.length} files`);
  return writtenPaths;
}

// ---------------------------------------------------------------------------
// High-level: download + extract in one step
// ---------------------------------------------------------------------------

// Offloads fetch + decompress + parse to a worker, then writes results to VFS on main thread
export async function downloadAndExtract(
  url: string,
  vol: MemoryVolume,
  destDir: string,
  opts: ExtractionOptions = {},
): Promise<string[]> {
  if (!opts.profiler) {
    return downloadAndExtractInternal(url, vol, destDir, opts);
  }
  const profileSpan = opts.profiler?.begin("packages.extract", {
    category: "packages",
    metadata: { url: url },
  }) ?? null;
  try {
    return await downloadAndExtractInternal(url, vol, destDir, opts);
  } finally {
    opts.profiler?.end(profileSpan);
  }
}

async function downloadAndExtractInternal(
  url: string,
  vol: MemoryVolume,
  destDir: string,
  opts: ExtractionOptions,
): Promise<string[]> {
  opts.onProgress?.(`Fetching ${url}...`);

  // fetch outside the extraction slot so downloads can overlap while archive
  // inflation stays serialized under the memory budget
  let cachedBytes: ArrayBuffer | null = null;
  let cache: Awaited<ReturnType<typeof getTarballCache>> = null;
  // started while the tree was still being resolved
  const prefetched = takePrefetchedTarball(url);
  if (prefetched) cachedBytes = await prefetched;
  try {
    cache = await getTarballCache();
    if (cache && !cachedBytes) cachedBytes = await cache.get(url);
  } catch {
    cache = null;
  }

  if (!cachedBytes) {
    cachedBytes = await downloadTarball(url);
  }

  if (opts.expectedIntegrity) {
    verifySri(cachedBytes, opts.expectedIntegrity, url);
  }

  const extractionId = taskId();
  const stageRoot = `/.nodepod/install/${extractionId}`;
  const writtenPaths: string[] = [];
  vol.mkdirSync(stageRoot, { recursive: true });
  const channel = new MessageChannel();
  let finishStream!: () => void;
  const streamDone = new Promise<void>((resolve) => { finishStream = resolve; });
  channel.port1.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (message?.type === "done") {
      finishStream();
      return;
    }
    if (message?.type !== "file" || !message.file) return;
    writeExtractedFile(message.file);
  };
  channel.port1.start();

  const writeExtractedFile = (file: ExtractResult["files"][number]): void => {
    if (opts.filter && !opts.filter(file.path)) return;
    const staged = safeJoin(stageRoot, file.path);
    const absolute = safeJoin(destDir, file.path);
    if (!staged || !absolute) return;
    vol.mkdirSync(path.dirname(staged), { recursive: true });
    const bytes = file.data instanceof Uint8Array
      ? file.data
      : file.isBinary
        ? base64ToBytes(file.data as string)
        : file.data as string;
    vol.writeFileSync(staged, bytes);
    if (absolute.endsWith(".wasm") && bytes instanceof Uint8Array) precompileWasm(bytes);
    writtenPaths.push(absolute);
    opts.onFile?.(file.path, bytes);
  };

  let result: ExtractResult;
  const workerSpan = opts.profiler?.begin("workers.extract", {
    category: "workers",
  }) ?? null;
  try {
    const extractionTask = {
      type: "extract",
      id: extractionId,
      tarballUrl: url,
      stripComponents: opts.stripComponents ?? 1,
      priority: TaskPriority.NORMAL,
      expectedShasum: opts.expectedShasum,
      tarballBytes: cachedBytes,
      wantTarball: false,
      streamPort: channel.port2,
    } as const;
    result = await withExtractionSlot(() => opts.profiler
      ? profiledOffload(extractionTask, opts.profiler)
      : offload(extractionTask));
    if (result.streamed) await streamDone;
    else for (const file of result.files) writeExtractedFile(file);
  } catch (error) {
    removeTree(vol, stageRoot);
    throw error;
  } finally {
    channel.port1.close();
    opts.profiler?.end(workerSpan);
  }

  if (
    cache &&
    cachedBytes.byteLength > 0 &&
    cachedBytes.byteLength <= TARBALL_CACHE_MAX_BYTES
  ) {
    cache.put(url, cachedBytes, opts.expectedShasum).catch(() => {});
  }

  vol.mkdirSync(path.dirname(destDir), { recursive: true });
  vol.renameSync(stageRoot, destDir);

  opts.onProgress?.(`Extracted ${writtenPaths.length} files`);
  opts.profiler?.count("packages.extractedFiles", writtenPaths.length);
  return writtenPaths;
}

// Main-thread fallback when workers aren't available
export async function downloadAndExtractDirect(
  url: string,
  vol: MemoryVolume,
  destDir: string,
  opts: ExtractionOptions = {},
): Promise<string[]> {
  opts.onProgress?.(`Fetching ${url}...`);

  let cache: Awaited<ReturnType<typeof getTarballCache>> = null;
  try {
    cache = await getTarballCache();
    const cached = cache ? await cache.get(url) : null;
    if (cached) return extractArchive(cached, vol, destDir, opts);
  } catch {
    cache = null;
  }

  const rawBytes = await downloadTarball(url);
  if (cache && rawBytes.byteLength > 0 && rawBytes.byteLength <= TARBALL_CACHE_MAX_BYTES) {
    cache.put(url, rawBytes, opts.expectedShasum).catch(() => {});
  }
  return extractArchive(rawBytes, vol, destDir, opts);
}

export default {
  downloadAndExtract,
  downloadAndExtractDirect,
  parseTarArchive,
  extractArchive,
  inflateGzip,
};
