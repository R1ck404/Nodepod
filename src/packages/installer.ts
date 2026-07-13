// Dependency Installer
// Handles the full install lifecycle: resolve, download, extract, transform, bin stubs, lock file.

import { MemoryVolume } from "../memory-volume";
import { RegistryClient, RegistryConfig } from "./registry-client";
import {
  resolveDependencyTree,
  resolveFromManifest,
  ResolvedDependency,
  ResolutionConfig,
} from "./version-resolver";
import { downloadAndExtract } from "./archive-extractor";
import { convertPackage, prepareTransformer } from "../module-transformer";
import type { PackageManifest } from "../types/manifest";
import * as path from "../polyfills/path";
import type { IDBSnapshotCache } from "../persistence/idb-cache";
import { quickDigest } from "../helpers/digest";
import {
  createFilteredBinarySnapshot,
  restoreBinarySnapshot,
} from "../persistence/binary-snapshot";
import { getTarballCache } from "../persistence/tarball-cache";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstallFlags {
  registry?: string;
  persist?: boolean;
  persistDev?: boolean;
  withDevDeps?: boolean;
  withOptionalDeps?: boolean;
  onProgress?: (message: string) => void;
  /**
   * Module transform timing. Default is lazy: install only downloads and
   * extracts; the runtime module loader converts ESM/CJS on first require()
   * (and caches it). Pass "eager" (or the legacy `true`) to run esbuild over
   * every installed file at install time like before.
   */
  transformModules?: boolean | "eager";
}

// "eager" | true → install-time transforms; false | undefined → lazy (default)
export function isEagerTransform(value: boolean | "eager" | undefined): boolean {
  return value === "eager" || value === true;
}

export interface InstallOutcome {
  resolved: Map<string, ResolvedDependency>;
  newPackages: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalize bin field — handles both shorthand string and object forms
function normalizeBinField(
  packageName: string,
  bin?: string | Record<string, string>,
): Record<string, string> {
  if (!bin) return {};
  if (typeof bin === "string") {
    const command = packageName.includes("/")
      ? packageName.split("/").pop()!
      : packageName;
    return { [command]: bin };
  }
  return bin;
}

// Walk up from a package directory to the enclosing `node_modules` folder.
// Handles scoped packages (whose direct parent is the scope dir, not
// node_modules) and nested placements like `.../foo/node_modules/bar`.
function enclosingNodeModules(pkgDir: string): string {
  let dir = path.dirname(pkgDir);
  while (dir !== "/" && dir !== "" && path.basename(dir) !== "node_modules") {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

// Split "express@4.18.2" or "@types/node@20" into name + version
function splitSpecifier(spec: string): { name: string; version?: string } {
  if (spec.startsWith("@")) {
    const slashIdx = spec.indexOf("/");
    if (slashIdx === -1)
      throw new Error(`Malformed package specifier: ${spec}`);

    const tail = spec.slice(slashIdx + 1);
    const atIdx = tail.indexOf("@");
    if (atIdx === -1) return { name: spec };
    return {
      name: spec.slice(0, slashIdx + 1 + atIdx),
      version: tail.slice(atIdx + 1),
    };
  }

  const atIdx = spec.indexOf("@");
  if (atIdx === -1) return { name: spec };
  return {
    name: spec.slice(0, atIdx),
    version: spec.slice(atIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

let transformerReady = false;

export class DependencyInstaller {
  private vol: MemoryVolume;
  private registryClient: RegistryClient;
  private workingDir: string;
  private _snapshotCache: IDBSnapshotCache | null;

  constructor(vol: MemoryVolume, opts: { cwd?: string; snapshotCache?: IDBSnapshotCache | null } & RegistryConfig = {}) {
    this.vol = vol;
    this.registryClient = new RegistryClient(opts);
    this.workingDir = opts.cwd || "/";
    this._snapshotCache = opts.snapshotCache ?? null;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async install(
    packageName: string,
    version?: string,
    flags: InstallFlags = {},
  ): Promise<InstallOutcome> {
    const { onProgress } = flags;

    const spec = splitSpecifier(packageName);
    const targetName = spec.name;
    const targetRange = version || spec.version || "latest";

    onProgress?.(`Resolving ${targetName}@${targetRange}...`);

    const resolutionOpts: ResolutionConfig = {
      registry: flags.registry
        ? new RegistryClient({ endpoint: flags.registry })
        : this.registryClient,
      devDependencies: flags.withDevDeps,
      optionalDependencies: flags.withOptionalDeps,
      onProgress,
    };

    const tree = await resolveDependencyTree(
      targetName,
      targetRange,
      resolutionOpts,
    );

    // snapshot cache keyed by the resolved package set — skips download,
    // extract, and transform on warm runs (resolution still hit the registry).
    // TODO(follow-up): upgrade quickDigest to SHA-256 via sync-digest.ts
    const treeKey = this._snapshotCache
      ? "tree:" + quickDigest(
          [...tree].map(([n, d]) => `${n}@${d.version}`).sort().join(",") +
            "|" + this.workingDir,
        )
      : null;

    if (this._snapshotCache && treeKey) {
      try {
        const cached = await this._snapshotCache.get(treeKey);
        if (cached) {
          onProgress?.("Restoring cached packages...");
          const restored = restoreBinarySnapshot(this.vol, cached);
          // bin stubs + lock file are deterministic — recreate from the tree
          const nmRoot = path.join(this.workingDir, "node_modules");
          for (const [depName] of tree) {
            this.createBinStubs(nmRoot, depName, path.join(nmRoot, depName));
          }
          this.writeLockFile(tree);
          if (flags.persist || flags.persistDev) {
            const entry = tree.get(targetName);
            if (entry) {
              await this.patchManifest(targetName, `^${entry.version}`, !!flags.persistDev);
            }
          }
          onProgress?.(`Restored ${restored} cached entries`);
          return { resolved: tree, newPackages: [] };
        }
      } catch {
        // cache error — proceed with normal install
      }
    }

    const newPkgs = await this.materializePackages(tree, flags);

    // cache just this tree's package dirs so unrelated node_modules content
    // from the session doesn't leak into the entry
    if (this._snapshotCache && treeKey && newPkgs.length > 0) {
      try {
        const nmRoot = path.join(this.workingDir, "node_modules");
        const prefixes = [...tree.keys()].map((n) => path.join(nmRoot, n));
        const snapshot = createFilteredBinarySnapshot(this.vol, (p) =>
          prefixes.some((prefix) => p === prefix || p.startsWith(prefix + "/")),
        );
        await this._snapshotCache.set(treeKey, snapshot);
      } catch { /* cache write failure is non-fatal */ }
    }

    if (flags.persist || flags.persistDev) {
      const entry = tree.get(targetName);
      if (entry) {
        await this.patchManifest(
          targetName,
          `^${entry.version}`,
          !!flags.persistDev,
        );
      }
    }

    onProgress?.(`Installed ${tree.size} package(s)`);

    return { resolved: tree, newPackages: newPkgs };
  }

  async installFromManifest(
    manifestPath?: string,
    flags: InstallFlags = {},
  ): Promise<InstallOutcome> {
    const { onProgress } = flags;

    const jsonPath = manifestPath || path.join(this.workingDir, "package.json");

    if (!this.vol.existsSync(jsonPath)) {
      throw new Error(`Manifest not found at ${jsonPath}`);
    }

    const raw = this.vol.readFileSync(jsonPath, "utf8");
    const manifest: PackageManifest = JSON.parse(raw);

    // Check IDB snapshot cache — skip full install if we have a cached node_modules
    const cacheKey = this._snapshotCache ? quickDigest(raw) : null;
    if (this._snapshotCache && cacheKey) {
      try {
        const cached = await this._snapshotCache.get(cacheKey);
        if (cached) {
          onProgress?.("Restoring cached node_modules...");
          const restored = restoreBinarySnapshot(this.vol, cached);
          onProgress?.(`Restored ${restored} cached entries`);
          return { resolved: new Map(), newPackages: [] };
        }
      } catch {
        // Cache miss or error — proceed with normal install
      }
    }

    onProgress?.("Resolving dependency tree...");

    const resolutionOpts: ResolutionConfig = {
      registry: flags.registry
        ? new RegistryClient({ endpoint: flags.registry })
        : this.registryClient,
      devDependencies: flags.withDevDeps,
      optionalDependencies: flags.withOptionalDeps,
      onProgress,
    };

    const tree = await resolveFromManifest(manifest, resolutionOpts);

    const newPkgs = await this.materializePackages(tree, flags);

    // Cache the installed node_modules snapshot for future reuse (raw bytes,
    // no base64 — restores go through the bulk binary path)
    if (this._snapshotCache && cacheKey && newPkgs.length > 0) {
      try {
        const snapshot = createFilteredBinarySnapshot(this.vol, (p) =>
          p.includes("/node_modules/"),
        );
        await this._snapshotCache.set(cacheKey, snapshot);
      } catch { /* cache write failure is non-fatal */ }
    }

    onProgress?.(`Installed ${tree.size} package(s)`);

    return { resolved: tree, newPackages: newPkgs };
  }

  listInstalled(): Record<string, string> {
    const nmDir = path.join(this.workingDir, "node_modules");
    if (!this.vol.existsSync(nmDir)) return {};

    const result: Record<string, string> = {};
    const topLevel = this.vol.readdirSync(nmDir) as string[];

    for (const entry of topLevel) {
      if (entry.startsWith(".")) continue;

      if (entry.startsWith("@")) {
        const scopeDir = path.join(nmDir, entry);
        const scopedEntries = this.vol.readdirSync(scopeDir) as string[];
        for (const child of scopedEntries) {
          const manifest = path.join(scopeDir, child, "package.json");
          if (this.vol.existsSync(manifest)) {
            const data = JSON.parse(this.vol.readFileSync(manifest, "utf8"));
            result[`${entry}/${child}`] = data.version;
          }
        }
      } else {
        const manifest = path.join(nmDir, entry, "package.json");
        if (this.vol.existsSync(manifest)) {
          const data = JSON.parse(this.vol.readFileSync(manifest, "utf8"));
          result[entry] = data.version;
        }
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  // Download, extract, transform, and wire up packages not already in node_modules
  private async materializePackages(
    tree: Map<string, ResolvedDependency>,
    flags: InstallFlags,
  ): Promise<string[]> {
    const { onProgress } = flags;
    const additions: string[] = [];

    const nmRoot = path.join(this.workingDir, "node_modules");
    this.vol.mkdirSync(nmRoot, { recursive: true });

    const pending: Array<{
      depName: string;
      dep: ResolvedDependency;
      targetDir: string;
    }> = [];

    for (const [depName, dep] of tree) {
      const targetDir = path.join(nmRoot, depName);
      const existingManifest = path.join(targetDir, "package.json");

      if (this.vol.existsSync(existingManifest)) {
        try {
          const current = JSON.parse(
            this.vol.readFileSync(existingManifest, "utf8"),
          );
          if (current.version === dep.version) {
            onProgress?.(`Skipping ${depName}@${dep.version} (up to date)`);
            continue;
          }
        } catch {
          // corrupt manifest, reinstall
        }
      }

      pending.push({ depName, dep, targetDir });
    }

    // Only need main-thread transformer as fallback when workers aren't available
    const shouldTransform = isEagerTransform(flags.transformModules);
    if (shouldTransform && !transformerReady) {
      if (typeof Worker === "undefined") {
        onProgress?.("Preparing module transformer...");
        await prepareTransformer();
      }
      transformerReady = true;
    }

    // Safe to batch aggressively since extract + transform are offloaded to workers
    // archive inflation is serialized separately; four fetch/transform lanes
    // recover cold-install speed without recreating the old six-inflate peak.
    const WORKER_COUNT = 4;
    onProgress?.(`Downloading ${pending.length} package(s)...`);

    for (let offset = 0; offset < pending.length; offset += WORKER_COUNT) {
      const batch = pending.slice(offset, offset + WORKER_COUNT);

      await Promise.all(
        batch.map(async ({ depName, dep, targetDir }) => {
          onProgress?.(`  Fetching ${depName}@${dep.version}...`);

          await downloadAndExtract(dep.tarballUrl, this.vol, targetDir, {
            stripComponents: 1,
            expectedShasum: dep.shasum,
          });

          if (shouldTransform) {
            try {
              const transformed = await convertPackage(
                this.vol,
                targetDir,
                onProgress,
              );
              if (transformed > 0) {
                onProgress?.(
                  `  Transformed ${transformed} file(s) in ${depName}`,
                );
              }
            } catch (err) {
              onProgress?.(
                `  Warning: transformation failed for ${depName}: ${err}`,
              );
            }
          }

          this.createBinStubs(nmRoot, depName, targetDir);

          additions.push(depName);
        }),
      );
    }

    this.writeLockFile(tree);

    // keep the tarball cache under its byte/age budget (fire and forget)
    if (additions.length > 0) {
      getTarballCache()
        .then((cache) => cache?.prune())
        .catch(() => {});
    }

    return additions;
  }

  private createBinStubs(
    _nmRoot: string,
    depName: string,
    pkgDir: string,
  ): void {
    try {
      const manifestPath = path.join(pkgDir, "package.json");
      if (!this.vol.existsSync(manifestPath)) return;

      const data = JSON.parse(this.vol.readFileSync(manifestPath, "utf8"));
      const bins = normalizeBinField(depName, data.bin);
      // Bin stubs live alongside the enclosing node_modules so nested
      // deps (e.g. ember-cli/node_modules/foo) get their bins in the
      // parent's .bin, not the top-level one where they'd collide with a
      // hoisted version.
      const binDir = path.join(enclosingNodeModules(pkgDir), ".bin");

      for (const [cmd, relPath] of Object.entries(bins)) {
        this.vol.mkdirSync(binDir, { recursive: true });
        const target = path.join(pkgDir, relPath);
        this.vol.writeFileSync(
          path.join(binDir, cmd),
          `node "${target}" "$@"\n`,
        );
      }
    } catch {
      // best-effort
    }
  }

  private writeLockFile(tree: Map<string, ResolvedDependency>): void {
    const entries: Record<string, { version: string; resolved: string }> = {};

    for (const [depName, dep] of tree) {
      entries[depName] = {
        version: dep.version,
        resolved: dep.tarballUrl,
      };
    }

    const lockPath = path.join(
      this.workingDir,
      "node_modules",
      ".package-lock.json",
    );
    this.vol.writeFileSync(lockPath, JSON.stringify(entries, null, 2));
  }

  private async patchManifest(
    depName: string,
    versionSpec: string,
    asDev: boolean,
  ): Promise<void> {
    const jsonPath = path.join(this.workingDir, "package.json");

    let manifest: Record<string, unknown> = {};
    if (this.vol.existsSync(jsonPath)) {
      manifest = JSON.parse(this.vol.readFileSync(jsonPath, "utf8"));
    }

    const section = asDev ? "devDependencies" : "dependencies";
    if (!manifest[section]) {
      manifest[section] = {};
    }
    (manifest[section] as Record<string, string>)[depName] = versionSpec;

    this.vol.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

// One-shot install: `install("express@4.18.2", vol)`
export async function install(
  specifier: string,
  vol: MemoryVolume,
  flags?: InstallFlags,
): Promise<InstallOutcome> {
  const installer = new DependencyInstaller(vol);
  return installer.install(specifier, undefined, flags);
}

export { RegistryClient } from "./registry-client";
export type {
  RegistryConfig,
  VersionDetail,
  PackageMetadata,
} from "./registry-client";
export type { ResolvedDependency, ResolutionConfig } from "./version-resolver";
export type { ExtractionOptions } from "./archive-extractor";
export { splitSpecifier };
