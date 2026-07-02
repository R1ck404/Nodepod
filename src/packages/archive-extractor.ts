// Archive Extractor — downloads .tgz from npm, decompresses, parses tar, writes to VFS.
// Heavy work is offloaded to web workers when available.

import pako from "pako";
import { MemoryVolume } from "../memory-volume";
import * as path from "../polyfills/path";
import { offload, taskId, TaskPriority } from "../threading/offload";
import type { ExtractResult } from "../threading/offload-types";
import { base64ToBytes } from "../helpers/byte-encoding";
import { precompileWasm } from "../helpers/wasm-cache";

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

function readNullTerminated(
  buf: Uint8Array,
  start: number,
  len: number,
): string {
  const slice = buf.slice(start, start + len);
  const zeroPos = slice.indexOf(0);
  const trimmed = zeroPos >= 0 ? slice.slice(0, zeroPos) : slice;
  return new TextDecoder().decode(trimmed);
}

function readOctalField(buf: Uint8Array, start: number, len: number): number {
  const raw = readNullTerminated(buf, start, len).trim();
  return parseInt(raw, 8) || 0;
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
    const headerBlock = raw.slice(cursor, cursor + BLOCK);
    cursor += BLOCK;

    // two zero blocks = end of archive
    const allZero = headerBlock.every((b) => b === 0);
    if (allZero) break;

    const nameField = readNullTerminated(headerBlock, 0, 100);
    if (!nameField) continue;

    const fileMode = readOctalField(headerBlock, 100, 8);
    const byteSize = readOctalField(headerBlock, 124, 12);
    const typeChar = String.fromCharCode(headerBlock[156]);
    const linkField = readNullTerminated(headerBlock, 157, 100);
    const prefixField = readNullTerminated(headerBlock, 345, 155);

    const filepath = prefixField ? `${prefixField}/${nameField}` : nameField;
    const kind = classifyTypeFlag(typeChar);

    let payload: Uint8Array | undefined;
    if (kind === "file") {
      payload =
        byteSize > 0 ? raw.slice(cursor, cursor + byteSize) : new Uint8Array(0);
      if (byteSize > 0) {
        cursor += Math.ceil(byteSize / BLOCK) * BLOCK;
      }
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
  opts.onProgress?.(`Fetching ${url}...`);

  const result: ExtractResult = await offload({
    type: "extract",
    id: taskId(),
    tarballUrl: url,
    stripComponents: opts.stripComponents ?? 1,
    priority: TaskPriority.NORMAL,
    expectedShasum: opts.expectedShasum,
  });

  const writtenPaths: string[] = [];
  for (const file of result.files) {
    if (opts.filter && !opts.filter(file.path)) continue;

    const absolute = safeJoin(destDir, file.path);
    if (!absolute) continue;
    const parentDir = path.dirname(absolute);
    vol.mkdirSync(parentDir, { recursive: true });

    if (file.isBinary) {
      // binary data arrives as raw Uint8Array (large files via structured clone)
      // or base64 string (small files)
      const bytes = file.data instanceof Uint8Array
        ? file.data
        : base64ToBytes(file.data as string);
      vol.writeFileSync(absolute, bytes);
      // pre-compile WASM so it's ready by the time code needs it
      if (absolute.endsWith(".wasm")) {
        precompileWasm(bytes);
      }
    } else {
      vol.writeFileSync(absolute, file.data as string);
    }
    writtenPaths.push(absolute);
  }

  opts.onProgress?.(`Extracted ${writtenPaths.length} files`);
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

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Archive download failed (HTTP ${response.status}): ${url}`,
    );
  }

  const rawBytes = await response.arrayBuffer();
  return extractArchive(rawBytes, vol, destDir, opts);
}

export default {
  downloadAndExtract,
  downloadAndExtractDirect,
  parseTarArchive,
  extractArchive,
  inflateGzip,
};
