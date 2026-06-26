// Chokidar-compatible file watcher on top of IVolume.watch()


import type { FileWatchHandle, FileStat } from "../memory-volume";
import type { IVolume } from "../types/volume";
import { setSharedVolume, getSharedVolume } from "./volume-registry";


export function setVolume(vol: IVolume): void {
  setSharedVolume(vol);
}


type Listener = (...args: unknown[]) => void;

interface MiniEmitter {
  handlers: Map<string, Set<Listener>>;
  on(name: string, fn: Listener): this;
  off(name: string, fn: Listener): this;
  fire(name: string, ...args: unknown[]): void;
}

interface MiniEmitterConstructor {
  new (): MiniEmitter;
  (this: any): void;
  prototype: any;
}

const MiniEmitter = function MiniEmitter(this: any) {
  if (!this) return;
  this.handlers = new Map<string, Set<Listener>>();
} as unknown as MiniEmitterConstructor;

MiniEmitter.prototype.on = function on(this: any, name: string, fn: Listener): any {
  if (!this.handlers.has(name)) this.handlers.set(name, new Set());
  this.handlers.get(name)!.add(fn);
  return this;
};

MiniEmitter.prototype.off = function off(this: any, name: string, fn: Listener): any {
  this.handlers.get(name)?.delete(fn);
  return this;
};

MiniEmitter.prototype.fire = function fire(this: any, name: string, ...args: unknown[]): void {
  const set = this.handlers.get(name);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(...args);
    } catch {
      /* swallow listener errors */
    }
  }
};


export interface WatcherConfig {
  persistent?: boolean;
  ignored?:
    | string
    | RegExp
    | ((p: string) => boolean)
    | Array<string | RegExp | ((p: string) => boolean)>;
  ignoreInitial?: boolean;
  followSymlinks?: boolean;
  cwd?: string;
  disableGlobbing?: boolean;
  usePolling?: boolean;
  interval?: number;
  binaryInterval?: number;
  alwaysStat?: boolean;
  depth?: number;
  awaitWriteFinish?:
    | boolean
    | { stabilityThreshold?: number; pollInterval?: number };
  ignorePermissionErrors?: boolean;
  atomic?: boolean | number;
}


export interface PathWatcher extends MiniEmitter {
  vol: IVolume;
  cfg: WatcherConfig;
  handles: Map<string, FileWatchHandle>;
  terminated: boolean;
  initialised: boolean;
  add(targets: string | readonly string[]): this;
  unwatch(targets: string | readonly string[]): this;
  close(): Promise<void>;
  getWatched(): Record<string, string[]>;
  resolvePath(raw: string): string;
  isExcluded(target: string): boolean;
  gatherInitial(dir: string, queue: Array<() => void>): void;
  attachWatcher(target: string, filterFor?: string): void;
  watchSubtree(dir: string, level?: number): void;
}

interface PathWatcherConstructor {
  new (cfg?: WatcherConfig): PathWatcher;
  (this: any, cfg?: WatcherConfig): void;
  prototype: any;
}

export const PathWatcher = function PathWatcher(this: any, cfg: WatcherConfig = {}) {
  if (!this) return;
  MiniEmitter.call(this);
  const vol = getSharedVolume();
  if (!vol) {
    throw new Error(
      "chokidar: IVolume not set. Call setVolume() first.",
    );
  }
  this.vol = vol;
  this.cfg = cfg;
  this.handles = new Map<string, FileWatchHandle>();
  this.terminated = false;
  this.initialised = false;
} as unknown as PathWatcherConstructor;

Object.setPrototypeOf(PathWatcher.prototype, MiniEmitter.prototype);

PathWatcher.prototype.add = function add(this: any, targets: string | readonly string[]): any {
  if (this.terminated) return this;

  const list = Array.isArray(targets) ? targets : [targets];
  const deferred: Array<() => void> = [];

  for (const raw of list) {
    const absolute = this.resolvePath(raw);
    if (this.isExcluded(absolute) || this.handles.has(absolute)) continue;

    try {
      if (!this.vol.existsSync(absolute)) {
        // Path does not exist yet -- watch its parent so we detect creation
        const parentDir =
          absolute.substring(0, absolute.lastIndexOf("/")) || "/";
        if (this.vol.existsSync(parentDir)) {
          this.attachWatcher(parentDir, absolute);
        }
        continue;
      }

      const info = this.vol.statSync(absolute);

      if (!this.cfg.ignoreInitial) {
        if (info.isDirectory()) {
          this.gatherInitial(absolute, deferred);
        } else {
          deferred.push(() => this.fire("add", absolute, info));
        }
      }

      this.attachWatcher(absolute);

      if (info.isDirectory()) {
        this.watchSubtree(absolute);
      }
    } catch (err) {
      this.fire("error", err);
    }
  }

  if (!this.initialised) {
    this.initialised = true;
    setTimeout(() => {
      for (const emit of deferred) emit();
      this.fire("ready");
    }, 0);
  }

  return this;
};

PathWatcher.prototype.unwatch = function unwatch(this: any, targets: string | readonly string[]): any {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const raw of list) {
    const absolute = this.resolvePath(raw);
    const h = this.handles.get(absolute);
    if (h) {
      h.close();
      this.handles.delete(absolute);
    }
  }
  return this;
};

PathWatcher.prototype.close = function close(this: any): Promise<void> {
  this.terminated = true;
  for (const h of this.handles.values()) h.close();
  this.handles.clear();
  this.fire("close");
  return Promise.resolve();
};

PathWatcher.prototype.getWatched = function getWatched(this: any): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const p of this.handles.keys()) {
    const dir = p.substring(0, p.lastIndexOf("/")) || "/";
    const base = p.substring(p.lastIndexOf("/") + 1);
    if (!result[dir]) result[dir] = [];
    result[dir].push(base);
  }
  return result;
};

PathWatcher.prototype.resolvePath = function resolvePath(this: any, raw: string): string {
  let p = raw;
  if (this.cfg.cwd && !p.startsWith("/")) {
    p = this.cfg.cwd + "/" + p;
  }
  if (!p.startsWith("/")) p = "/" + p;
  return p;
};

PathWatcher.prototype.isExcluded = function isExcluded(this: any, target: string): boolean {
  const { ignored } = this.cfg;
  if (!ignored) return false;

  const rules = Array.isArray(ignored) ? ignored : [ignored];
  for (const rule of rules) {
    if (typeof rule === "string") {
      if (target === rule || target.startsWith(rule + "/")) return true;
    } else if (rule instanceof RegExp) {
      if (rule.test(target)) return true;
    } else if (typeof rule === "function") {
      if (rule(target)) return true;
    }
  }
  return false;
};

PathWatcher.prototype.gatherInitial = function gatherInitial(this: any, dir: string, queue: Array<() => void>): void {
  try {
    const children = this.vol.readdirSync(dir);
    for (const child of children) {
      const full = dir === "/" ? "/" + child : dir + "/" + child;
      if (this.isExcluded(full)) continue;
      const st = this.vol.statSync(full);
      if (st.isDirectory()) {
        queue.push(() => this.fire("addDir", full, st));
        this.gatherInitial(full, queue);
      } else {
        queue.push(() => this.fire("add", full, st));
      }
    }
  } catch {
    /* swallow read errors during initial scan */
  }
};

PathWatcher.prototype.attachWatcher = function attachWatcher(this: any, target: string, filterFor?: string): void {
  if (this.handles.has(target)) return;

  const self = this;
  const handle = this.vol.watch(
    target,
    { recursive: true },
    (kind: string, filename: string | null) => {
      if (self.terminated) return;

      let resolved: string;
      if (filename) {
        resolved = target === "/" ? "/" + filename : target + "/" + filename;
      } else {
        resolved = target;
      }

      if (
        filterFor &&
        resolved !== filterFor &&
        !resolved.startsWith(filterFor + "/")
      )
        return;
      if (self.isExcluded(resolved)) return;

      if (kind === "rename") {
        if (self.vol.existsSync(resolved)) {
          try {
            const st = self.vol.statSync(resolved);
            const eventName = st.isDirectory() ? "addDir" : "add";
            self.fire(eventName, resolved, st);
            self.fire("all", eventName, resolved, st);
          } catch {
            /* vanished between check and stat */
          }
        } else {
          self.fire("unlink", resolved);
          self.fire("all", "unlink", resolved);
        }
      } else if (kind === "change") {
        try {
          const st = self.vol.statSync(resolved);
          self.fire("change", resolved, st);
          self.fire("all", "change", resolved, st);
        } catch {
          self.fire("unlink", resolved);
          self.fire("all", "unlink", resolved);
        }
      }
    },
  );

  this.handles.set(target, handle);
};

PathWatcher.prototype.watchSubtree = function watchSubtree(this: any, dir: string, level: number = 0): void {
  if (this.cfg.depth !== undefined && level > this.cfg.depth) return;
  try {
    const children = this.vol.readdirSync(dir);
    for (const name of children) {
      const full = dir === "/" ? "/" + name : dir + "/" + name;
      if (this.isExcluded(full)) continue;
      try {
        if (this.vol.statSync(full).isDirectory()) {
          this.attachWatcher(full);
          this.watchSubtree(full, level + 1);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
};

export function watch(
  targets: string | readonly string[],
  options?: WatcherConfig,
): PathWatcher {
  const watcher = new PathWatcher(options);
  watcher.add(targets);
  return watcher;
}

export default { watch, PathWatcher, setVolume };
