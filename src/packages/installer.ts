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
import { PINNED_ESBUILD_WASM } from "../constants/cdn-urls";
import type { PerformanceTracker } from "../performance-tracker";
import type { NodepodProfilerImpl, ProfileSpanToken } from "../profiling/profiler";
import { resolveWithCache } from "./resolution-cache";
import { NPM_REGISTRY_URL } from "../constants/config";
import { writeNpmPackageLock } from "./pm-cli";
import {
  discoverWorkspaces,
  workspaceDependencyNames,
  type WorkspaceGraph,
} from "./workspace";

const RESOLVER_CACHE_VERSION = 2;
const MATERIALIZE_ATTEMPTS = 3;
const MATERIALIZE_RETRY_DELAY_MS = 750;
const SNAPSHOT_CACHE_VERSION = 4;
const TRANSFORMER_CACHE_VERSION = `esbuild-wasm@${PINNED_ESBUILD_WASM}:cjs-esnext-neutral-v1`;

// Some package managers and bundlers derive their WASI package name at
// runtime instead of declaring it in optionalDependencies. Keep this generic:
// discover the standard wasm32-wasi package convention from the installed
// package code rather than naming a particular tool or binding.
const WASI_PACKAGE_REFERENCE_RE =
  /["'`]((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+-wasm32-wasi)(?:\/[^"'`\\]*)?["'`]/gi;
const WASI_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".mjs",
  ".mts",
  ".ts",
]);

/** Return literal npm package references using the wasm32-wasi convention. */
export function findWasiPackageReferences(source: string): string[] {
  const references = new Set<string>();
  for (const match of source.matchAll(WASI_PACKAGE_REFERENCE_RE)) {
    references.add(match[1]);
  }
  return [...references];
}

function stableRecord(record: Record<string, string> | undefined): string {
  return JSON.stringify(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

// the SDK passes no registry, the shell passes the resolved default URL:
// both mean the public registry and must share cache entries
function cacheRegistry(registry: string | undefined): string {
  if (!registry) return "default";
  const trimmed = registry.replace(/\/+$/, "");
  return trimmed === NPM_REGISTRY_URL ? "default" : trimmed;
}

export function manifestSnapshotKey(raw: string, flags: InstallFlags = {}): string {
  return quickDigest(JSON.stringify({
    version: SNAPSHOT_CACHE_VERSION,
    transformer: TRANSFORMER_CACHE_VERSION,
    manifest: raw,
    registry: cacheRegistry(flags.registry),
    dev: !!flags.withDevDeps,
    optional: !!flags.withOptionalDeps,
    transform: isEagerTransform(flags.transformModules) ? "eager" : "lazy",
  }));
}

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
  /** Prefer lockfile tarball URL + SRI for the root package being installed. */
  lockEntry?: { resolved?: string; integrity?: string };
}

// "eager" | true → install-time transforms; false | undefined → lazy (default)
export function isEagerTransform(value: boolean | "eager" | undefined): boolean {
  return value === "eager" || value === true;
}

export function isManifestSnapshotComplete(
  snapshot: Parameters<typeof restoreBinarySnapshot>[1],
  workingDir: string,
  manifest: PackageManifest,
  flags: InstallFlags = {},
): boolean {
  const requiredPackages = {
    ...manifest.dependencies,
    ...(flags.withDevDeps ? manifest.devDependencies : undefined),
  };
  const cachedPaths = new Set(snapshot.manifest.map((entry) => entry.path));
  return Object.keys(requiredPackages).every((name) =>
    cachedPaths.has(path.join(workingDir, "node_modules", name, "package.json")),
  );
}

export interface InstallOutcome {
  resolved: Map<string, ResolvedDependency>;
  newPackages: string[];
}

export interface WorkspaceInstallOutcome {
  graph: WorkspaceGraph;
  installs: Array<{ root: string; outcome: InstallOutcome }>;
}

interface WasiCompanionCandidate {
  parentPlacement: string;
  packageName: string;
  versionRange: string;
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
  private _performance: PerformanceTracker | null;
  private _profiler: NodepodProfilerImpl | null;

  constructor(
    vol: MemoryVolume,
    opts: {
      cwd?: string;
      snapshotCache?: IDBSnapshotCache | null;
      performanceTracker?: PerformanceTracker | null;
      profiler?: NodepodProfilerImpl | null;
    } & RegistryConfig = {},
  ) {
    this.vol = vol;
    this.registryClient = new RegistryClient(opts);
    this.workingDir = opts.cwd || "/";
    this._snapshotCache = opts.snapshotCache ?? null;
    this._performance = opts.performanceTracker ?? null;
    this._profiler = opts.profiler ?? null;
  }

  private profileSpan(
    name: string,
    category: "packages" | "snapshots" | "modules" | "workers" = "packages",
    metadata?: Record<string, string | number | boolean>,
  ): ProfileSpanToken | null {
    return this._profiler?.begin(name, { category, metadata }) ?? null;
  }

  private endProfileSpan(token: ProfileSpanToken | null): void {
    this._profiler?.end(token);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async install(
    packageName: string,
    version?: string,
    flags: InstallFlags = {},
  ): Promise<InstallOutcome> {
    const stopInstall = this._performance?.start("install.total");
    const installSpan = this.profileSpan("packages.install");
    const { onProgress } = flags;

    const spec = splitSpecifier(packageName);
    const targetName = spec.name;
    const targetRange = version || spec.version || "latest";

    onProgress?.(`Resolving ${targetName}@${targetRange}...`);

    const resolutionOpts: ResolutionConfig = {
      registry: flags.registry
        ? new RegistryClient({ endpoint: flags.registry, profiler: this._profiler })
        : this.registryClient,
      devDependencies: flags.withDevDeps,
      optionalDependencies: flags.withOptionalDeps,
      onProgress,
    };

    const stopResolution = this._performance?.start("install.resolve");
    const resolutionSpan = this.profileSpan("packages.resolve");
    const resolutionKey = quickDigest(JSON.stringify({
      version: RESOLVER_CACHE_VERSION,
      package: targetName,
      range: targetRange,
      registry: cacheRegistry(flags.registry),
      dev: !!flags.withDevDeps,
      optional: !!flags.withOptionalDeps,
    }));
    const resolved = await resolveWithCache(resolutionKey, () =>
      resolveDependencyTree(targetName, targetRange, resolutionOpts));
    const tree = resolved.tree;
    if (resolved.hit) {
      this._performance?.increment("install.resolutionCacheHits");
      this._profiler?.count("packages.resolutionCacheHits");
    }
    stopResolution?.();
    this.endProfileSpan(resolutionSpan);

    // Prefer package-lock resolved URL + SRI for the root package (npm ci)
    if (flags.lockEntry) {
      const root = tree.get(targetName);
      if (root) {
        if (flags.lockEntry.resolved) root.tarballUrl = flags.lockEntry.resolved;
        if (flags.lockEntry.integrity) root.integrity = flags.lockEntry.integrity;
      }
    }

    // snapshot cache keyed by the resolved package set — skips download,
    // extract, and transform on warm runs (resolution still hit the registry).
    // TODO(follow-up): upgrade quickDigest to SHA-256 via sync-digest.ts
    const transformMode = isEagerTransform(flags.transformModules) ? "eager" : "lazy";
    const treeKey = this._snapshotCache
      ? "tree:" + quickDigest(
          [...tree].map(([n, d]) => `${n}@${d.version}`).sort().join(",") +
            "|" + this.workingDir +
            "|" + SNAPSHOT_CACHE_VERSION +
            "|" + TRANSFORMER_CACHE_VERSION +
            "|" + transformMode,
        )
      : null;

    if (this._snapshotCache && treeKey) {
      try {
        const cached = await this._snapshotCache.get(treeKey);
        if (cached) {
          onProgress?.("Restoring cached packages...");
          const stopRestore = this._performance?.start("install.restore");
          const restoreSpan = this.profileSpan("snapshots.restore", "snapshots");
          const restored = restoreBinarySnapshot(this.vol, cached);
          stopRestore?.();
          this.endProfileSpan(restoreSpan);
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
          this._performance?.increment("install.cacheHits");
          this._profiler?.count("packages.snapshotCacheHits");
          stopInstall?.();
          this.endProfileSpan(installSpan);
          return { resolved: tree, newPackages: [] };
        }
      } catch {
        // cache error — proceed with normal install
      }
    }

    const stopMaterialize = this._performance?.start("install.materialize");
    const materializeSpan = this.profileSpan("packages.materialize");
    const newPkgs = await this.materializeWithWasiCompanions(
      tree,
      flags,
      resolutionOpts,
    );
    stopMaterialize?.();
    this.endProfileSpan(materializeSpan);

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

    stopInstall?.();
    this.endProfileSpan(installSpan);
    return { resolved: tree, newPackages: newPkgs };
  }

  async installFromManifest(
    manifestPath?: string,
    flags: InstallFlags = {},
  ): Promise<InstallOutcome> {
    const stopInstall = this._performance?.start("install.total");
    const installSpan = this.profileSpan("packages.install");
    const { onProgress } = flags;

    const jsonPath = manifestPath || path.join(this.workingDir, "package.json");

    if (!this.vol.existsSync(jsonPath)) {
      throw new Error(`Manifest not found at ${jsonPath}`);
    }

    const raw = this.vol.readFileSync(jsonPath, "utf8");
    const manifest: PackageManifest = JSON.parse(raw);

    // Check IDB snapshot cache — skip full install if we have a cached node_modules
    const cacheKey = this._snapshotCache ? manifestSnapshotKey(raw, flags) : null;
    if (this._snapshotCache && cacheKey) {
      try {
        const cached = await this._snapshotCache.get(cacheKey);
        if (cached && isManifestSnapshotComplete(cached, this.workingDir, manifest, flags)) {
          onProgress?.("Restoring cached node_modules...");
          const stopRestore = this._performance?.start("install.restore");
          const restoreSpan = this.profileSpan("snapshots.restore", "snapshots");
          const restored = restoreBinarySnapshot(this.vol, cached);
          stopRestore?.();
          this.endProfileSpan(restoreSpan);
          onProgress?.(`Restored ${restored} cached entries`);
          this._performance?.increment("install.cacheHits");
          this._profiler?.count("packages.snapshotCacheHits");
          stopInstall?.();
          this.endProfileSpan(installSpan);
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

    const stopResolution = this._performance?.start("install.resolve");
    const resolutionSpan = this.profileSpan("packages.resolve");
    const resolutionKey = quickDigest(JSON.stringify({
      version: RESOLVER_CACHE_VERSION,
      registry: cacheRegistry(flags.registry),
      dependencies: stableRecord(manifest.dependencies),
      devDependencies: flags.withDevDeps ? stableRecord(manifest.devDependencies) : "",
      optionalDependencies: flags.withOptionalDeps ? stableRecord(manifest.optionalDependencies) : "",
    }));
    const resolved = await resolveWithCache(resolutionKey, () =>
      resolveFromManifest(manifest, resolutionOpts));
    const tree = resolved.tree;
    if (resolved.hit) {
      this._performance?.increment("install.resolutionCacheHits");
      this._profiler?.count("packages.resolutionCacheHits");
    }
    stopResolution?.();
    this.endProfileSpan(resolutionSpan);

    const stopMaterialize = this._performance?.start("install.materialize");
    const materializeSpan = this.profileSpan("packages.materialize");
    const newPkgs = await this.materializeWithWasiCompanions(
      tree,
      flags,
      resolutionOpts,
    );
    stopMaterialize?.();
    this.endProfileSpan(materializeSpan);

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

    stopInstall?.();
    this.endProfileSpan(installSpan);
    return { resolved: tree, newPackages: newPkgs };
  }

  /**
   * Install a root npm workspace and each child workspace. Workspace-local
   * dependencies are linked through the VFS after external dependencies are
   * installed in the package that consumes them.
   */
  async installWorkspace(
    rootManifestPath?: string,
    flags: InstallFlags = {},
  ): Promise<WorkspaceInstallOutcome> {
    const manifestPath = rootManifestPath || path.join(this.workingDir, "package.json");
    const root = path.dirname(manifestPath);
    const graph = discoverWorkspaces(this.vol, root);
    const installs: Array<{ root: string; outcome: InstallOutcome }> = [];

    const installExternal = async (
      packageRoot: string,
      sourcePath: string,
      manifest: PackageManifest,
    ) => {
      const localNames = workspaceDependencyNames(manifest);
      const filtered = { ...manifest } as Record<string, unknown>;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        const values = { ...(manifest[section] ?? {}) } as Record<string, string>;
        for (const name of localNames) delete values[name];
        filtered[section] = values;
      }
      const temporaryPath = path.join(packageRoot, ".nodepod-install-manifest.json");
      this.vol.writeFileSync(temporaryPath, JSON.stringify(filtered));
      try {
        const installer = new DependencyInstaller(this.vol, {
          cwd: packageRoot,
          snapshotCache: this._snapshotCache,
          performanceTracker: this._performance,
        });
        const outcome = await installer.installFromManifest(temporaryPath, flags);
        installs.push({ root: packageRoot, outcome });
      } finally {
        if (this.vol.existsSync(temporaryPath)) this.vol.unlinkSync(temporaryPath);
      }
      void sourcePath;
    };

    const rootManifest = JSON.parse(this.vol.readFileSync(manifestPath, "utf8")) as PackageManifest;
    await installExternal(root, manifestPath, rootManifest);
    for (const workspace of graph.packages) {
      await installExternal(workspace.root, path.join(workspace.root, "package.json"), workspace.manifest);
    }

    const linkPackage = (consumerRoot: string, dependencyName: string, targetRoot: string) => {
      const destination = path.join(consumerRoot, "node_modules", dependencyName);
      const parent = path.dirname(destination);
      this.vol.mkdirSync(parent, { recursive: true });
      if (this.vol.existsSync(destination)) {
        try {
          this.vol.removeTreeSync(destination);
        } catch {
          this.vol.unlinkSync(destination);
        }
      }
      this.vol.symlinkSync(targetRoot, destination, "dir");
    };

    const consumers = [
      { root, manifest: rootManifest },
      ...graph.packages.map((workspace) => ({ root: workspace.root, manifest: workspace.manifest })),
    ];
    for (const consumer of consumers) {
      const dependencies = new Set<string>();
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        for (const name of Object.keys(consumer.manifest[section] ?? {})) dependencies.add(name);
      }
      for (const name of dependencies) {
        const target = graph.byName.get(name);
        if (target) linkPackage(consumer.root, name, target.root);
      }
    }

    return { graph, installs };
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

  /**
   * Materialize the resolved tree, then add any WASI companions referenced by
   * the installed package code. This handles packages that omit the companion
   * from optionalDependencies and only discover it in a runtime fallback.
   */
  private async materializeWithWasiCompanions(
    tree: Map<string, ResolvedDependency>,
    flags: InstallFlags,
    resolutionOpts: ResolutionConfig,
  ): Promise<string[]> {
    const installed: string[] = [];
    const seenCandidates = new Set<string>();

    // A companion can itself depend on another WASI companion. Continue until
    // a pass adds nothing; the candidate set is bounded by package contents.
    for (let pass = 0; pass < 16; pass++) {
      installed.push(...await this.materializePackages(tree, flags));

      const candidates = this.findWasiCompanionCandidates(tree);
      let added = false;

      for (const candidate of candidates) {
        const candidateKey = [
          candidate.parentPlacement,
          candidate.packageName,
          candidate.versionRange,
        ].join("|");
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);

        let companionTree: Map<string, ResolvedDependency>;
        try {
          const resolutionKey = quickDigest(JSON.stringify({
            version: RESOLVER_CACHE_VERSION,
            package: candidate.packageName,
            range: candidate.versionRange,
            registry: cacheRegistry(flags.registry),
            dev: !!flags.withDevDeps,
            optional: !!flags.withOptionalDeps,
          }));
          const resolved = await resolveWithCache(resolutionKey, () =>
            resolveDependencyTree(
              candidate.packageName,
              candidate.versionRange,
              resolutionOpts,
            ));
          companionTree = resolved.tree;
        } catch (error) {
          // A package may contain a platform branch that is not published for
          // the current parent version. Keep the existing runtime fallback in
          // that case; an unavailable companion must not break installation.
          flags.onProgress?.(
            `  Skipping unavailable WASI companion ${candidate.packageName}@${candidate.versionRange}: ${error}`,
          );
          continue;
        }

        const companionRoot = path.join(
          candidate.parentPlacement,
          "node_modules",
          candidate.packageName,
        );

        for (const [placement, dependency] of companionTree) {
          // Keep the companion's complete dependency closure private to the
          // companion. This avoids accidentally reusing a conflicting hoisted
          // package from the host tree while preserving normal Node lookup.
          const targetPlacement = placement === candidate.packageName
            ? companionRoot
            : path.join(companionRoot, "node_modules", placement);
          if (tree.has(targetPlacement)) continue;
          tree.set(targetPlacement, dependency);
          added = true;
        }
      }

      if (!added) break;
    }

    return [...new Set(installed)];
  }

  private findWasiCompanionCandidates(
    tree: Map<string, ResolvedDependency>,
  ): WasiCompanionCandidate[] {
    const candidates: WasiCompanionCandidate[] = [];
    const nmRoot = path.join(this.workingDir, "node_modules");

    for (const [parentPlacement, dependency] of tree) {
      const packageDir = path.join(nmRoot, parentPlacement);
      const references = new Set<string>();
      const files = [packageDir];

      while (files.length > 0) {
        const current = files.pop()!;
        let entries: string[];
        try {
          entries = this.vol.readdirSync(current);
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry === "node_modules" || entry === ".git") continue;
          const filePath = path.join(current, entry);
          let stat;
          try {
            stat = this.vol.statSync(filePath);
          } catch {
            continue;
          }
          if (stat.isDirectory()) {
            files.push(filePath);
            continue;
          }

          const extension = path.extname(entry).toLowerCase();
          if (!WASI_SOURCE_EXTENSIONS.has(extension) || stat.size > 16 * 1024 * 1024) {
            continue;
          }
          try {
            for (const reference of findWasiPackageReferences(
              this.vol.readFileSync(filePath, "utf8"),
            )) {
              references.add(reference);
            }
          } catch {
            // Binary or otherwise unreadable source is irrelevant here.
          }
        }
      }

      let packageJson: {
        name?: string;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      } = {};
      try {
        packageJson = JSON.parse(
          this.vol.readFileSync(path.join(packageDir, "package.json"), "utf8"),
        );
      } catch {
        // The resolved dependency still provides a safe version fallback.
      }

      for (const packageName of references) {
        // A companion's loader may mention its own package name while
        // constructing a diagnostic or resolving its runtime entry point.
        // That is not a request to install an infinite nested copy.
        if (packageName === (packageJson.name || dependency.name)) continue;
        const nestedPlacement = path.join(
          parentPlacement,
          "node_modules",
          packageName,
        );
        // A root-level companion is already visible to Node's lookup from any
        // package, so do not install a duplicate nested copy.
        if (tree.has(nestedPlacement) || tree.has(packageName)) continue;

        candidates.push({
          parentPlacement,
          packageName,
          versionRange:
            packageJson.optionalDependencies?.[packageName] ??
            packageJson.dependencies?.[packageName] ??
            dependency.version,
        });
      }
    }

    return candidates;
  }

  // Download, extract, transform, and wire up packages not already in node_modules
  private async materializePackages(
    tree: Map<string, ResolvedDependency>,
    flags: InstallFlags,
  ): Promise<string[]> {
    const { onProgress } = flags;
    const additions: string[] = [];

    const nmRoot = path.join(this.workingDir, "node_modules");
    this.vol.mkdirSync(nmRoot, { recursive: true });

    // Only need main-thread transformer as fallback when workers aren't available
    const shouldTransform = isEagerTransform(flags.transformModules);
    if (shouldTransform && !transformerReady) {
      if (typeof Worker === "undefined") {
        onProgress?.("Preparing module transformer...");
        await prepareTransformer();
      }
      transformerReady = true;
    }

    const isUpToDate = (depName: string, dep: ResolvedDependency): boolean => {
      const existingManifest = path.join(nmRoot, depName, "package.json");
      if (!this.vol.existsSync(existingManifest)) return false;
      try {
        const current = JSON.parse(this.vol.readFileSync(existingManifest, "utf8"));
        return current.version === dep.version;
      } catch {
        return false; // corrupt manifest, reinstall
      }
    };

    // Safe to batch aggressively since extract + transform are offloaded to workers
    // downloads stay work-conserving while archive inflation is serialized
    const WORKER_COUNT = 6;
    const byDepth = new Map<number, Array<{ depName: string; dep: ResolvedDependency }>>();
    for (const [depName, dep] of tree) {
      const depth = depName.split("/node_modules/").length - 1;
      const group = byDepth.get(depth) ?? [];
      group.push({ depName, dep });
      byDepth.set(depth, group);
    }
    onProgress?.(`Downloading up to ${tree.size} package(s)...`);

    // One failed package must not abort the whole install: every other
    // package is still materialized, and the failures are reported together
    // at the end so the tree is as complete as it can be.
    const failures: Array<{ depName: string; version: string; error: unknown }> = [];

    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      // Decide what is up to date only now: a shallower package that was just
      // re-extracted replaced its whole directory, so nested entries that
      // looked installed when the install started may be gone.
      const group = byDepth.get(depth)!.filter(({ depName, dep }) => {
        if (isUpToDate(depName, dep)) {
          onProgress?.(`Skipping ${depName}@${dep.version} (up to date)`);
          return false;
        }
        return true;
      });
      let nextPackage = 0;
      const runLane = async () => {
        while (nextPackage < group.length) {
          const { depName, dep } = group[nextPackage++];
          const targetDir = path.join(nmRoot, depName);
          onProgress?.(`  Fetching ${depName}@${dep.version}...`);
          try {
            await this.materializeOne(depName, dep, targetDir, flags);
          } catch (error) {
            failures.push({ depName, version: dep.version, error });
            onProgress?.(
              `  Failed ${depName}@${dep.version}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }

          this.createBinStubs(nmRoot, depName, targetDir);
          additions.push(depName);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(WORKER_COUNT, group.length) }, () => runLane()),
      );
    }

    // Validate the whole tree, not just this run's downloads: anything the
    // resolver expects must be present with the resolved version.
    const incomplete = [...tree].filter(([depName, dep]) => !isUpToDate(depName, dep));
    if (failures.length > 0 || incomplete.length > 0) {
      const detail = failures.map(({ depName, version, error }) =>
        `${depName}@${version}: ${error instanceof Error ? error.message : String(error)}`,
      );
      const missing = incomplete
        .map(([depName]) => depName)
        .filter((depName) => !failures.some((f) => f.depName === depName));
      const parts: string[] = [];
      if (detail.length > 0) parts.push(`failed: ${detail.join("; ")}`);
      if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
      throw new Error(`Installation incomplete (${parts.join(" | ")})`);
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

  // Download + extract one package into targetDir, replacing whatever version
  // is there while keeping its nested node_modules (installed children of the
  // previous copy) so they don't have to be fetched again. The archive is
  // staged in /.nodepod/install and moved into place in one rename, so a
  // failed attempt leaves the previous copy untouched.
  private async materializeOne(
    depName: string,
    dep: ResolvedDependency,
    targetDir: string,
    flags: InstallFlags,
  ): Promise<void> {
    const { onProgress } = flags;
    const nestedDir = path.join(targetDir, "node_modules");
    const parkedNested = this.vol.existsSync(nestedDir)
      ? `/.nodepod/install/nested-${Date.now()}-${Math.random().toString(36).slice(2)}`
      : null;
    if (parkedNested) {
      this.vol.mkdirSync(path.dirname(parkedNested), { recursive: true });
      this.vol.renameSync(nestedDir, parkedNested);
    }

    let lastError: unknown = null;
    let extracted = false;
    try {
      for (let attempt = 0; attempt < MATERIALIZE_ATTEMPTS && !extracted; attempt++) {
        if (attempt > 0) {
          onProgress?.(
            `  Retrying ${depName}@${dep.version} (attempt ${attempt + 1}/${MATERIALIZE_ATTEMPTS})...`,
          );
          await new Promise<void>((r) => setTimeout(r, MATERIALIZE_RETRY_DELAY_MS * attempt));
        }
        try {
          await downloadAndExtract(dep.tarballUrl, this.vol, targetDir, {
            stripComponents: 1,
            expectedShasum: dep.shasum,
            expectedIntegrity: dep.integrity,
            profiler: this._profiler,
          });
          const manifestPath = path.join(targetDir, "package.json");
          if (!this.vol.existsSync(manifestPath)) {
            throw new Error(`Package archive did not contain ${manifestPath}`);
          }
          let installedVersion: string | undefined;
          try {
            installedVersion = JSON.parse(this.vol.readFileSync(manifestPath, "utf8")).version;
          } catch {
            throw new Error(`Package archive contained an unreadable ${manifestPath}`);
          }
          if (installedVersion !== dep.version) {
            throw new Error(
              `Package archive contained ${depName}@${installedVersion ?? "?"}, expected ${dep.version}`,
            );
          }
          extracted = true;
        } catch (error) {
          lastError = error;
        }
      }
      if (!extracted) throw lastError;
    } finally {
      // put the children back under whichever copy is now in place
      if (parkedNested && this.vol.existsSync(parkedNested)) {
        try {
          if (!this.vol.existsSync(targetDir)) this.vol.mkdirSync(targetDir, { recursive: true });
          if (this.vol.existsSync(nestedDir)) this.vol.removeTreeSync(nestedDir);
          this.vol.renameSync(parkedNested, nestedDir);
        } catch {
          /* leave the parked copy for the tree validation to report */
        }
      }
    }

    if (isEagerTransform(flags.transformModules)) {
      try {
        const transformed = await convertPackage(
          this.vol,
          targetDir,
          onProgress,
          this._profiler,
        );
        if (transformed > 0) {
          onProgress?.(`  Transformed ${transformed} file(s) in ${depName}`);
        }
      } catch (err) {
        onProgress?.(`  Warning: transformation failed for ${depName}: ${err}`);
      }
    }
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
    this.vol.mkdirSync(path.join(this.workingDir, "node_modules"), {
      recursive: true,
    });
    this.vol.writeFileSync(lockPath, JSON.stringify(entries, null, 2));

    let rootPkg: { name?: string; version?: string } | undefined;
    try {
      const pjPath = path.join(this.workingDir, "package.json");
      if (this.vol.existsSync(pjPath)) {
        const pj = JSON.parse(this.vol.readFileSync(pjPath, "utf8"));
        rootPkg = { name: pj.name, version: pj.version };
      }
    } catch {
      /* */
    }
    writeNpmPackageLock(this.vol, this.workingDir, tree, rootPkg);
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
