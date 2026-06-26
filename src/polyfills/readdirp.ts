// Recursive directory listing polyfill (readdirp-compatible) on IVolume


import type { FileStat } from "../memory-volume";
import type { IVolume } from "../types/volume";
import { setSharedVolume, getSharedVolume } from "./volume-registry";


export function setVolume(vol: IVolume): void {
  setSharedVolume(vol);
}


export interface ScanOptions {
  root?: string;
  fileFilter?: string | string[] | ((entry: ScanEntry) => boolean);
  directoryFilter?: string | string[] | ((entry: ScanEntry) => boolean);
  depth?: number;
  type?: "files" | "directories" | "files_directories" | "all";
  lstat?: boolean;
  alwaysStat?: boolean;
}

export interface ScanEntry {
  path: string;
  fullPath: string;
  basename: string;
  stats?: FileStat;
  dirent?: {
    isFile(): boolean;
    isDirectory(): boolean;
    name: string;
  };
}

// collects entries synchronously, yields asynchronously

interface DirectoryScanner {
  cfg: ScanOptions;
  rootDir: string;
  results: ScanEntry[];
  scanned: boolean;
  handlerMap: Map<string, Array<(...args: unknown[]) => void>>;
  [Symbol.asyncIterator](): AsyncIterableIterator<ScanEntry>;
  toArray(): Promise<ScanEntry[]>;
  on(event: string, handler: (...args: unknown[]) => void): this;
  once(event: string, handler: (...args: unknown[]) => void): this;
  off(event: string, handler: (...args: unknown[]) => void): this;
  fireEvent(event: string, ...args: unknown[]): void;
  runScan(): void;
  crawl(dir: string, level: number, relative: string): void;
  applyFilter(entry: ScanEntry, filter?: string | string[] | ((e: ScanEntry) => boolean)): boolean;
  globMatch(filename: string, pattern: string): boolean;
}

interface DirectoryScannerConstructor {
  new (root: string, cfg?: ScanOptions): DirectoryScanner;
  (this: any, root: string, cfg?: ScanOptions): void;
  prototype: any;
}

const DirectoryScanner = function DirectoryScanner(this: any, root: string, cfg: ScanOptions = {}) {
  if (!this) return;
  this.rootDir = root;
  this.cfg = cfg;
  this.results = [];
  this.scanned = false;
  this.handlerMap = new Map<string, Array<(...args: unknown[]) => void>>();
} as unknown as DirectoryScannerConstructor;

DirectoryScanner.prototype[Symbol.asyncIterator] = async function*(this: any): AsyncIterableIterator<ScanEntry> {
  this.runScan();
  for (const entry of this.results) yield entry;
};

DirectoryScanner.prototype.toArray = async function toArray(this: any): Promise<ScanEntry[]> {
  this.runScan();
  return [...this.results];
};

DirectoryScanner.prototype.on = function on(this: any, event: string, handler: (...args: unknown[]) => void): any {
  if (event === "data") {
    setTimeout(() => {
      this.runScan();
      for (const entry of this.results) handler(entry);
      this.fireEvent("end");
    }, 0);
  } else {
    if (!this.handlerMap.has(event)) this.handlerMap.set(event, []);
    this.handlerMap.get(event)!.push(handler);
  }
  return this;
};

DirectoryScanner.prototype.once = function once(this: any, event: string, handler: (...args: unknown[]) => void): any {
  const self = this;
  const wrapped = (...args: unknown[]) => {
    handler(...args);
    self.off(event, wrapped);
  };
  return this.on(event, wrapped);
};

DirectoryScanner.prototype.off = function off(this: any, event: string, handler: (...args: unknown[]) => void): any {
  const arr = this.handlerMap.get(event);
  if (arr) {
    const idx = arr.indexOf(handler);
    if (idx !== -1) arr.splice(idx, 1);
  }
  return this;
};

DirectoryScanner.prototype.fireEvent = function fireEvent(this: any, event: string, ...args: unknown[]): void {
  const arr = this.handlerMap.get(event);
  if (arr) for (const fn of arr) fn(...args);
};

DirectoryScanner.prototype.runScan = function runScan(this: any): void {
  if (this.scanned) return;
  this.scanned = true;
  this.crawl(this.rootDir, 0, "");
};

DirectoryScanner.prototype.crawl = function crawl(this: any, dir: string, level: number, relative: string): void {
  const vol = getSharedVolume();
  if (!vol) return;
  if (this.cfg.depth !== undefined && level > this.cfg.depth) return;

  let children: string[];
  try {
    children = vol.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of children) {
    const absolute = dir === "/" ? "/" + name : dir + "/" + name;
    const rel = relative ? relative + "/" + name : name;

    let st: FileStat;
    try {
      st = vol.statSync(absolute);
    } catch {
      continue;
    }

    const isDir = st.isDirectory();

    const entry: ScanEntry = {
      path: rel,
      fullPath: absolute,
      basename: name,
      stats: this.cfg.alwaysStat ? st : undefined,
      dirent: {
        isFile: () => !isDir,
        isDirectory: () => isDir,
        name,
      },
    };

    const category = this.cfg.type || "files";

    if (isDir) {
      if (!this.applyFilter(entry, this.cfg.directoryFilter)) continue;

      if (
        category === "directories" ||
        category === "files_directories" ||
        category === "all"
      ) {
        this.results.push(entry);
      }
      this.crawl(absolute, level + 1, rel);
    } else {
      if (
        category === "files" ||
        category === "files_directories" ||
        category === "all"
      ) {
        if (this.applyFilter(entry, this.cfg.fileFilter)) {
          this.results.push(entry);
        }
      }
    }
  }
};

DirectoryScanner.prototype.applyFilter = function applyFilter(
  this: any,
  entry: ScanEntry,
  filter?: string | string[] | ((e: ScanEntry) => boolean),
): boolean {
  if (!filter) return true;

  if (typeof filter === "function") return filter(entry);

  const patterns = Array.isArray(filter) ? filter : [filter];
  for (const pat of patterns) {
    if (pat.startsWith("!")) {
      if (this.globMatch(entry.basename, pat.slice(1))) return false;
    } else if (this.globMatch(entry.basename, pat)) {
      return true;
    }
  }
  // If every pattern was a negation and none matched, the entry is allowed
  return patterns.length === 0 || patterns.every((p: string) => p.startsWith("!"));
};

DirectoryScanner.prototype.globMatch = function globMatch(filename: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return filename.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return filename.startsWith(pattern.slice(0, -1));
  return filename === pattern;
};

export default function readdirp(
  root: string,
  options?: ScanOptions,
): DirectoryScanner {
  return new DirectoryScanner(root, options);
}

export async function readdirpPromise(
  root: string,
  options?: ScanOptions,
): Promise<ScanEntry[]> {
  return new DirectoryScanner(root, options).toArray();
}

export { readdirp, DirectoryScanner };
