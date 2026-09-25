// Version Resolver — semver parsing, range matching, and dependency tree resolution.

import { RegistryClient, VersionDetail, type PackageMetadata } from "./registry-client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedDependency {
  name: string;
  /** Registry name used for fetch (differs from `name` for npm: aliases). */
  fetchName: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
  shasum?: string;
  /** npm lockfile SRI (sha512-…) when installing from a lock entry */
  integrity?: string;
}

export interface ResolutionConfig {
  registry?: RegistryClient;
  devDependencies?: boolean;
  optionalDependencies?: boolean;
  onProgress?: (msg: string) => void;
  /** A package version was chosen for a place in the tree (it may be placed again elsewhere). */
  onResolved?: (dep: ResolvedDependency) => void;
}

// ---------------------------------------------------------------------------
// Semver data structures
// ---------------------------------------------------------------------------

export interface SemverComponents {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

// ---------------------------------------------------------------------------
// Semver parsing and comparison
// ---------------------------------------------------------------------------

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;

// A resolution compares the same version strings over and over (every sort
// of a package's thousands of versions, every range check): parse each once.
// The results are shared, callers only read them.
const parsedVersions = new Map<string, SemverComponents | null>();
const PARSED_VERSIONS_MAX = 200_000;

// Returns null for unparseable strings
export function parseSemver(raw: string): SemverComponents | null {
  const known = parsedVersions.get(raw);
  if (known !== undefined) return known;
  const m = raw.match(SEMVER_PATTERN);
  const parsed = m
    ? {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        prerelease: m[4],
      }
    : null;
  if (parsedVersions.size >= PARSED_VERSIONS_MAX) parsedVersions.clear();
  parsedVersions.set(raw, parsed);
  return parsed;
}

// Standard three-way comparison: negative if left < right, 0 if equal, positive if left > right
export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);

  if (!a || !b) return left.localeCompare(right);

  const majorDiff = a.major - b.major;
  if (majorDiff !== 0) return majorDiff;

  const minorDiff = a.minor - b.minor;
  if (minorDiff !== 0) return minorDiff;

  const patchDiff = a.patch - b.patch;
  if (patchDiff !== 0) return patchDiff;

  // pre-release has lower precedence than release
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return comparePrereleaseIds(a.prerelease, b.prerelease);
  }

  return 0;
}

/** Semver prerelease identifier compare: numeric by number, else ASCII. */
function comparePrereleaseIds(left: string, right: string): number {
  const aParts = left.split(".");
  const bParts = right.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    if (i >= aParts.length) return -1;
    if (i >= bParts.length) return 1;
    const aNum = /^\d+$/.test(aParts[i]);
    const bNum = /^\d+$/.test(bParts[i]);
    if (aNum && bNum) {
      const diff = Number(aParts[i]) - Number(bParts[i]);
      if (diff !== 0) return diff;
    } else if (aNum !== bNum) {
      // numeric identifiers have lower precedence than non-numeric
      return aNum ? -1 : 1;
    } else {
      const cmp = aParts[i].localeCompare(bParts[i]);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Range satisfaction
// ---------------------------------------------------------------------------

// Supports: exact, ^, ~, *, x-ranges, comparators, compound, hyphen, || unions
export function satisfiesRange(version: string, range: string): boolean {
  const sv = parseSemver(version);
  if (!sv) return false;

  // pre-release versions only match ranges that explicitly include a prerelease
  // for the SAME major.minor.patch (npm semantics). e.g. 5.0.0-next.0 matches
  // ^5.0.0-beta.0 but NOT >=4.0.0-beta.0 (different major.minor.patch)
  if (sv.prerelease) {
    // Extract the comparator version(s) from the range and check if any
    // share the same major.minor.patch as the candidate
    const rangeVersions = range.match(/\d+\.\d+\.\d+(?:-[^\s)]*)?/g) || [];
    const hasMatchingPrerelease = rangeVersions.some((rv) => {
      if (!rv.includes("-")) return false;
      const rvParsed = parseSemver(rv);
      return (
        rvParsed &&
        rvParsed.major === sv.major &&
        rvParsed.minor === sv.minor &&
        rvParsed.patch === sv.patch
      );
    });
    if (!hasMatchingPrerelease) return false;
  }

  range = range.trim();

  if (range === "*" || range === "latest" || range === "") return true;

  if (range.includes("||")) {
    return range.split("||").some((sub) => satisfiesRange(version, sub.trim()));
  }

  if (range.includes(" - ")) {
    const [lo, hi] = range.split(" - ").map((s) => s.trim());
    return compareSemver(version, lo) >= 0 && compareSemver(version, hi) <= 0;
  }

  // compound comparators like ">=1.2.0 <3.0.0"
  const comparatorSegments = range.match(
    /(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?(?:\.\d+)?(?:-[^\s]*)?)/g,
  );
  if (comparatorSegments && comparatorSegments.length > 1) {
    return comparatorSegments.every((seg) => {
      const parts = seg.match(
        /^(>=|<=|>|<|=)\s*(\d+(?:\.\d+)?(?:\.\d+)?(?:-[^\s]*)?)$/,
      );
      if (!parts) return true;
      const op = parts[1];
      let target = parts[2];
      // pad partial versions: "3" -> "3.0.0"
      const dots = (target.match(/\./g) || []).length;
      if (dots === 0) target += ".0.0";
      else if (dots === 1) target += ".0";
      return applyOperator(version, op, target);
    });
  }

  if (range.startsWith("^")) {
    const caretRaw = range.slice(1).trim();
    const base = padVersion(caretRaw);
    const bv = parseSemver(base);
    if (!bv) return false;

    if (sv.major !== bv.major) return false;
    if (bv.major === 0) {
      if (bv.minor !== 0 && sv.minor !== bv.minor) return false;
      // ^0.0.x pins patch: only that exact 0.0.patch (and compatible prereleases)
      if (bv.minor === 0) {
        if (sv.minor !== 0) return false;
        if (sv.patch !== bv.patch) return false;
      }
    }
    return compareSemver(version, base) >= 0;
  }

  if (range.startsWith("~")) {
    const tildeRaw = range.slice(1).trim();
    const parts = tildeRaw.replace(/[xX*]/g, "0").split(".");
    const base = padVersion(tildeRaw);
    const bv = parseSemver(base);
    if (!bv) return false;
    // ~1 => >=1.0.0 <2.0.0; ~1.2 => >=1.2.0 <1.3.0
    if (parts.length === 1) {
      return sv.major === bv.major && compareSemver(version, base) >= 0;
    }
    return (
      sv.major === bv.major &&
      sv.minor === bv.minor &&
      compareSemver(version, base) >= 0
    );
  }

  if (range.startsWith(">="))
    return compareSemver(version, padVersion(range.slice(2).trim())) >= 0;
  if (range.startsWith(">"))
    return compareSemver(version, padVersion(range.slice(1).trim())) > 0;
  if (range.startsWith("<="))
    return compareSemver(version, padVersion(range.slice(2).trim())) <= 0;
  if (range.startsWith("<"))
    return compareSemver(version, padVersion(range.slice(1).trim())) < 0;
  if (range.startsWith("="))
    return compareSemver(version, padVersion(range.slice(1).trim())) === 0;

  if (
    range.includes("x") ||
    range.includes("X") ||
    range.includes("*") ||
    /^\d+$/.test(range) ||
    /^\d+\.\d+$/.test(range)
  ) {
    const segments = range.replace(/[xX*]/g, "").split(".").filter(Boolean);
    if (segments.length === 1) return sv.major === Number(segments[0]);
    if (segments.length === 2) {
      return (
        sv.major === Number(segments[0]) && sv.minor === Number(segments[1])
      );
    }
  }

  if (range.includes(" ")) {
    return range
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => satisfiesRange(version, part));
  }

  if (/^\d+\.\d+\.\d+/.test(range)) {
    const exact = range.match(/^(\d+\.\d+\.\d+(?:-[^\s]+)?)/);
    if (exact) return compareSemver(version, exact[1]) === 0;
  }

  return compareSemver(version, range) === 0;
}

// "3" -> "3.0.0", "0.10.x" -> "0.10.0"
function padVersion(v: string): string {
  const parts = v.replace(/[xX*]/g, "0").split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

function applyOperator(ver: string, op: string, target: string): boolean {
  const cmp = compareSemver(ver, target);
  switch (op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

// Pick the highest version satisfying the range, or null
export function pickBestMatch(
  available: string[],
  range: string,
): string | null {
  return pickFromDescending([...available].sort((a, b) => compareSemver(b, a)), range);
}

function pickFromDescending(descending: readonly string[], range: string): string | null {
  for (const candidate of descending) {
    if (satisfiesRange(candidate, range)) return candidate;
  }
  return null;
}

// a package's versions, highest first, sorted once per metadata document
const descendingVersions = new WeakMap<object, readonly string[]>();

function pickFromMetadata(metadata: PackageMetadata, range: string): string | null {
  let descending = descendingVersions.get(metadata.versions);
  if (!descending) {
    descending = Object.keys(metadata.versions).sort((a, b) => compareSemver(b, a));
    descendingVersions.set(metadata.versions, descending);
  }
  return pickFromDescending(descending, range);
}

// ---------------------------------------------------------------------------
// npm alias handling
// ---------------------------------------------------------------------------

// Parse "npm:strip-ansi@^6.0.1" into { realName, realRange }
function parseNpmAlias(range: string): { realName: string; realRange: string } | null {
  if (!range.startsWith("npm:")) return null;
  const rest = range.slice(4);
  let atIdx: number;
  if (rest.startsWith("@")) {
    // scoped: find the second @ after the scope
    atIdx = rest.indexOf("@", 1);
  } else {
    atIdx = rest.indexOf("@");
  }
  if (atIdx === -1) {
    return { realName: rest, realRange: "latest" };
  }
  return {
    realName: rest.slice(0, atIdx),
    realRange: rest.slice(atIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// Full dependency tree resolution
// ---------------------------------------------------------------------------

// The resolver produces a map keyed by *placement path* — where a package
// should be materialised relative to the project's node_modules root. For
// hoisted packages the key is just the package name ("find-up"). When two
// requirers ask for incompatible versions of the same package, the second
// one is nested under the requirer ("ember-cli/node_modules/find-up") so
// Node's resolution walk finds the correct version from each consumer.
interface TreeWalkState {
  registry: RegistryClient;
  // placementKey → resolved dependency
  completed: Map<string, ResolvedDependency>;
  // Tracks the hoisted (root) version of each package name. Stored as a
  // promise so concurrent walks for the same name all see the same outcome
  // instead of racing to write to `completed`.
  rootPromises: Map<string, Promise<ResolvedDependency>>;
  // Per-placement resolution promises, to dedup concurrent nested installs.
  placementPromises: Map<string, Promise<void>>;
  config: ResolutionConfig;
}

function createState(
  client: RegistryClient,
  config: ResolutionConfig,
): TreeWalkState {
  return {
    registry: client,
    completed: new Map(),
    rootPromises: new Map(),
    placementPromises: new Map(),
    config,
  };
}

export async function resolveDependencyTree(
  rootName: string,
  versionRange: string = "latest",
  config: ResolutionConfig = {},
): Promise<Map<string, ResolvedDependency>> {
  const client = config.registry || new RegistryClient();
  const state = createState(client, config);

  await prefetchMetadata(client, [[rootName, versionRange]], config);
  await walkDependency(rootName, versionRange, state);
  return state.completed;
}

// The tree walk below decides placement in a fixed order, and much of it
// runs one registry round trip after another (claims, edges in chunks, each
// waiting on whole subtrees). This pass first walks the same graph by
// name and range with many requests in flight, so the metadata is already in
// the registry client's cache when the walk asks for it: resolution costs
// roughly the graph's depth in round trips, with results unchanged. Failures
// are left for the walk itself to report.
const PREFETCH_CONCURRENCY = 24;

function pickVersion(metadata: PackageMetadata, range: string): string | null {
  if (range === "latest" || range === "*") return metadata["dist-tags"].latest ?? null;
  if (metadata["dist-tags"][range]) return metadata["dist-tags"][range];
  return pickFromMetadata(metadata, range);
}

function prefetchMetadata(
  client: RegistryClient,
  roots: Array<[string, string]>,
  config: ResolutionConfig,
): Promise<void> {
  const seen = new Set<string>();
  const queue: Array<[string, string]> = roots.slice();
  let active = 0;
  return new Promise<void>((resolve) => {
    const enqueueEdges = (name: string, info: VersionDetail): void => {
      const peerMeta = info.peerDependenciesMeta || {};
      for (const [peer, range] of Object.entries(info.peerDependencies || {})) {
        if (!peerMeta[peer]?.optional) queue.push([peer, range]);
      }
      for (const entry of Object.entries(info.dependencies || {})) queue.push(entry);
      const optional = info.optionalDependencies || {};
      const optNames = Object.keys(optional);
      if (config.optionalDependencies) {
        for (const entry of Object.entries(optional)) queue.push(entry as [string, string]);
      } else {
        // same selection as walkEdgesForPackage: wasm variants, or the
        // {pkg}-wasm32-wasi / {pkg}-wasm guesses for native-only packages
        const wasm = optNames.filter((n) => n.includes("wasm32-wasi") || n.includes("wasm"));
        for (const n of wasm) queue.push([n, optional[n] as string]);
        if (wasm.length === 0 && optNames.length >= 2) {
          const platformRe = /-(darwin|linux|win32|freebsd|android|sunos)-(x64|x86|arm64|arm|ia32|s390x|ppc64|mips|riscv)/;
          if (optNames.every((n) => platformRe.test(n))) {
            queue.push([name + "-wasm32-wasi", "*"], [name + "-wasm", "*"]);
          }
        }
      }
    };
    const pump = (): void => {
      while (active < PREFETCH_CONCURRENCY && queue.length > 0) {
        const [name, rawRange] = queue.shift()!;
        // a spec this pass can't read is left for the walk to report
        let fetchName: string;
        let range: string;
        try {
          if (typeof rawRange !== "string") continue;
          const alias = parseNpmAlias(rawRange);
          fetchName = alias?.realName ?? name;
          range = alias?.realRange ?? rawRange;
        } catch {
          continue;
        }
        const key = `${fetchName}@${range}`;
        if (seen.has(key)) continue;
        seen.add(key);
        active++;
        let request: Promise<PackageMetadata>;
        try {
          request = client.fetchManifest(fetchName);
        } catch (err) {
          request = Promise.reject(err);
        }
        request
          .then((metadata) => {
            const version = pickVersion(metadata, range);
            const info = version ? metadata.versions[version] : undefined;
            if (info) enqueueEdges(name, info);
          })
          .catch(() => {})
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) resolve();
    };
    pump();
  });
}

export async function resolveFromManifest(
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  },
  config: ResolutionConfig = {},
): Promise<Map<string, ResolvedDependency>> {
  const client = config.registry || new RegistryClient();
  const state = createState(client, config);

  const allDeps: Record<string, string> = { ...manifest.dependencies };
  if (config.devDependencies && manifest.devDependencies) {
    Object.assign(allDeps, manifest.devDependencies);
  }

  const optionalRoot =
    config.optionalDependencies && manifest.optionalDependencies
      ? Object.entries(manifest.optionalDependencies)
      : [];

  const entries = Object.entries(allDeps);

  await prefetchMetadata(client, [...entries, ...optionalRoot], config);

  // Claim root slots for every direct manifest dep before walking transitive
  // edges or auto-installed peers. Otherwise a plugin's peer range (e.g.
  // @tailwindcss/vite wanting vite@^5||^8) can hoist a newer major before
  // the project's own vite@^5 devDependency is seen.
  for (const [depName, depRange] of entries) {
    await walkDependency(depName, depRange, state, "", { walkEdges: false });
  }

  for (const [depName, depRange] of optionalRoot) {
    try {
      await walkDependency(depName, depRange, state, "", { walkEdges: false });
    } catch {
      /* optional root deps may fail to resolve */
    }
  }

  // Walk transitive and peer edges for each direct manifest dependency.
  for (const [depName] of entries) {
    await walkDependencyEdges(depName, state);
  }

  for (const [depName] of optionalRoot) {
    try {
      await walkDependencyEdges(depName, state);
    } catch {
      /* optional root edge walks may fail */
    }
  }

  return state.completed;
}

// Recursively resolve a package and its transitive deps.
//
// Placement strategy: hoist to root whenever possible, nest under the
// requiring package when the root already holds an incompatible version.
// This mirrors npm's own algorithm and is what lets packages with
// conflicting version requirements (e.g. ember-cli wants find-up@^8 while
// one of its transitive deps wants find-up@^5) coexist correctly.
//
// `parentPath` is the placement key of the package that pulled this one
// in. Empty string means "called directly from a manifest" — at that
// level there is no enclosing package to nest under, so top-level
// conflicts silently reuse the first-chosen version (same as npm warning
// on conflicting peer deps at the top level).
async function walkDependency(
  pkgName: string,
  versionConstraint: string,
  state: TreeWalkState,
  parentPath: string = "",
  options: { walkEdges?: boolean } = {},
): Promise<void> {
  const walkEdges = options.walkEdges !== false;
  const { rootPromises, placementPromises, completed } = state;

  // npm aliases: fetch the real package but install under the alias name
  const alias = parseNpmAlias(versionConstraint);
  const installName = pkgName;
  const fetchName = alias?.realName ?? pkgName;
  versionConstraint = alias?.realRange ?? versionConstraint;

  // --- Synchronous decision: claim root or plan a nested install ---
  // This block MUST NOT await — between checking `rootPromises.get` and
  // calling `rootPromises.set` we rely on single-threaded atomicity so
  // the first concurrent walk wins the root slot.
  const existingRootPromise = rootPromises.get(installName);

  if (!existingRootPromise) {
    // Claim root for this package.
    const placementKey = installName;
    const deferred = createDeferred<ResolvedDependency>();
    rootPromises.set(installName, deferred.promise);
    try {
      const resolved = await installPackageAt(
        placementKey,
        fetchName,
        installName,
        versionConstraint,
        state,
        walkEdges,
      );
      deferred.resolve(resolved);
    } catch (err) {
      // Drop the claim so a later hard edge can retry; silence the deferred
      // rejection so soft-fail optional walks don't emit unhandledRejection.
      rootPromises.delete(installName);
      deferred.reject(err);
      void deferred.promise.catch(() => {});
      throw err;
    }
    return;
  }

  // Someone else owns the root slot. Usually we wait for them, but if
  // this is a cycle (A -> B -> A), the outer walk that claimed root has
  // already set `completed[installName]` before recursing into its edges.
  // Reading it directly avoids deadlocking on its own promise.
  let rootDep: ResolvedDependency;
  const alreadyResolved = completed.get(installName);
  if (alreadyResolved) {
    rootDep = alreadyResolved;
  } else {
    try {
      rootDep = await existingRootPromise;
    } catch {
      // Root resolution failed; nothing we can do at nested level either.
      return;
    }
  }
  if (satisfiesRange(rootDep.version, versionConstraint)) return; // reuse
  if (!parentPath) return; // top-level conflict: first-chosen wins

  const placementKey = `${parentPath}/node_modules/${installName}`;

  // Nested install dedup: another sibling may have already claimed this
  // exact placement.
  const existingPlacement = placementPromises.get(placementKey);
  if (existingPlacement) {
    await existingPlacement;
    return;
  }
  if (completed.has(placementKey)) {
    const existing = completed.get(placementKey)!;
    if (satisfiesRange(existing.version, versionConstraint)) return;
    // Conflict at nested level — rare; accept what we have.
    return;
  }

  const nestedPromise = installPackageAt(
    placementKey,
    fetchName,
    installName,
    versionConstraint,
    state,
  );
  placementPromises.set(
    placementKey,
    nestedPromise.then(() => undefined),
  );
  await nestedPromise;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  // Cast via unknown: the Promise constructor runs the executor synchronously,
  // so resolve/reject are definitely assigned before new Promise() returns,
  // but TS control-flow analysis can't prove that.
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Fetch the manifest for fetchName, choose a version, record the entry at
// placementKey, and optionally walk transitive/peer edges.
async function installPackageAt(
  placementKey: string,
  fetchName: string,
  installName: string,
  versionConstraint: string,
  state: TreeWalkState,
  walkEdges: boolean = true,
): Promise<ResolvedDependency> {
  const { registry, completed, config } = state;

  const existing = completed.get(placementKey);
  if (existing) return existing;

  config.onProgress?.(`Resolving ${fetchName}@${versionConstraint}`);

  const metadata = await registry.fetchManifest(fetchName);

  let chosenVersion: string;
  if (versionConstraint === "latest" || versionConstraint === "*") {
    chosenVersion = metadata["dist-tags"].latest;
  } else if (metadata["dist-tags"][versionConstraint]) {
    chosenVersion = metadata["dist-tags"][versionConstraint];
  } else {
    const best = pickFromMetadata(metadata, versionConstraint);
    if (!best) {
      throw new Error(
        `Could not find a version of "${fetchName}" matching "${versionConstraint}"`,
      );
    }
    chosenVersion = best;
  }

  const versionInfo: VersionDetail = metadata.versions[chosenVersion];

  const resolved: ResolvedDependency = {
    name: installName,
    fetchName,
    version: chosenVersion,
    tarballUrl: versionInfo.dist.tarball,
    dependencies: versionInfo.dependencies || {},
    shasum: versionInfo.dist.shasum,
  };
  completed.set(placementKey, resolved);
  config.onResolved?.(resolved);

  if (walkEdges) {
    await walkEdgesForPackage(placementKey, installName, versionInfo, state);
  }

  return resolved;
}

async function walkDependencyEdges(
  placementKey: string,
  state: TreeWalkState,
): Promise<void> {
  const resolved = state.completed.get(placementKey);
  if (!resolved) return;

  const metadata = await state.registry.fetchManifest(resolved.fetchName);
  const versionInfo = metadata.versions[resolved.version];
  if (!versionInfo) return;

  await walkEdgesForPackage(
    placementKey,
    resolved.name,
    versionInfo,
    state,
  );
}

async function walkOptionalSoft(
  childName: string,
  childRange: string,
  state: TreeWalkState,
  placementKey: string,
): Promise<void> {
  try {
    await walkDependency(childName, childRange, state, placementKey);
  } catch {
    /* optional dependency failures are ignored */
  }
}

async function walkEdgesForPackage(
  placementKey: string,
  installName: string,
  versionInfo: VersionDetail,
  state: TreeWalkState,
): Promise<void> {
  // non-optional peers are included (npm v7+ behaviour)
  const edges: Record<string, string> = {};
  const optionalEdges: Record<string, string> = {};

  if (versionInfo.peerDependencies) {
    const peerMeta = versionInfo.peerDependenciesMeta || {};
    for (const [peer, peerRange] of Object.entries(
      versionInfo.peerDependencies,
    )) {
      if (!peerMeta[peer]?.optional) {
        edges[peer] = peerRange;
      }
    }
  }

  // regular deps take precedence over peers
  if (versionInfo.dependencies) {
    Object.assign(edges, versionInfo.dependencies);
  }

  if (versionInfo.optionalDependencies) {
    const optEntries = Object.entries(versionInfo.optionalDependencies);

    if (state.config.optionalDependencies) {
      for (const [optName, optRange] of optEntries) {
        optionalEdges[optName] = optRange as string;
      }
    } else {
      // Always include wasm32-wasi optional deps — they're WASM alternatives
      // to native bindings and are the only variant that can run in-browser
      const optNames = Object.keys(versionInfo.optionalDependencies);
      let hasWasmVariant = false;
      for (const [optName, optRange] of Object.entries(versionInfo.optionalDependencies)) {
        if (optName.includes("wasm32-wasi") || optName.includes("wasm")) {
          optionalEdges[optName] = optRange as string;
          hasWasmVariant = true;
        }
      }

      // generic napi-rs detection: if ALL optional deps are platform-specific
      // native bindings (contain OS/arch tags) but no WASM variant exists, try
      // {pkg}-wasm32-wasi and {pkg}-wasm as alternatives. covers packages like
      // lightningcss that ship a separate -wasm package. errors are swallowed
      // since these may not exist on the registry
      if (!hasWasmVariant && optNames.length >= 2) {
        const platformRe = /-(darwin|linux|win32|freebsd|android|sunos)-(x64|x86|arm64|arm|ia32|s390x|ppc64|mips|riscv)/;
        const allPlatform = optNames.every(n => platformRe.test(n));
        if (allPlatform) {
          const wasmAltsToTry = [installName + "-wasm32-wasi", installName + "-wasm"];
          await Promise.all(wasmAltsToTry.map(async (alt) => {
            await walkOptionalSoft(alt, "*", state, placementKey);
          }));
        }
      }
    }
  }

  const edgeList = Object.entries(edges);
  const PARALLEL_LIMIT = 8;

  for (let start = 0; start < edgeList.length; start += PARALLEL_LIMIT) {
    const chunk = edgeList.slice(start, start + PARALLEL_LIMIT);
    await Promise.all(
      chunk.map(([childName, childRange]) =>
        walkDependency(childName, childRange, state, placementKey),
      ),
    );
  }

  const optList = Object.entries(optionalEdges);
  for (let start = 0; start < optList.length; start += PARALLEL_LIMIT) {
    const chunk = optList.slice(start, start + PARALLEL_LIMIT);
    await Promise.all(
      chunk.map(([childName, childRange]) =>
        walkOptionalSoft(childName, childRange, state, placementKey),
      ),
    );
  }

  await nestPeerConsumers(placementKey, { ...edges, ...optionalEdges }, state);
}

// Node resolution from `fromKey`: the placement key `name` resolves to, walking
// up through each enclosing node_modules to the root.
function visiblePlacement(
  fromKey: string,
  name: string,
  completed: Map<string, ResolvedDependency>,
): string | undefined {
  let key = fromKey;
  while (key) {
    const nested = `${key}/node_modules/${name}`;
    if (completed.has(nested)) return nested;
    const cut = key.lastIndexOf("/node_modules/");
    key = cut < 0 ? "" : key.slice(0, cut);
  }
  return completed.has(name) ? name : undefined;
}

// A dependency with peer dependencies has to see the same peers as the package
// that depends on it. When the requirer nested its own copy of a peer (it pins
// a version the root doesn't hold) but the dependency itself was reused from
// higher up, the dependency would resolve the other copy: napi-rs wasm bindings
// pin @emnapi/core 2.x while a shared @napi-rs/wasm-runtime at the root picked
// up a root @emnapi 1.x, and the mismatched pair fails at load. npm nests the
// dependency next to the requirer's peers in that case, and so do we.
async function nestPeerConsumers(
  placementKey: string,
  edges: Record<string, string>,
  state: TreeWalkState,
): Promise<void> {
  const { completed, registry } = state;
  for (const [childName, childRange] of Object.entries(edges)) {
    const childKey = visiblePlacement(placementKey, childName, completed);
    if (!childKey || childKey.startsWith(`${placementKey}/node_modules/`)) continue;
    const child = completed.get(childKey)!;
    let info: VersionDetail | undefined;
    try {
      info = (await registry.fetchManifest(child.fetchName)).versions[child.version];
    } catch {
      continue;
    }
    const peers = Object.keys(info?.peerDependencies || {});
    const mismatched = peers.some((peer) => {
      const own = visiblePlacement(placementKey, peer, completed);
      return own !== undefined && own !== visiblePlacement(childKey, peer, completed);
    });
    if (!mismatched) continue;

    const nestedKey = `${placementKey}/node_modules/${childName}`;
    const pending = state.placementPromises.get(nestedKey);
    if (pending) {
      await pending;
      continue;
    }
    if (completed.has(nestedKey)) continue;
    const alias = parseNpmAlias(childRange);
    const nested = installPackageAt(
      nestedKey,
      alias?.realName ?? child.fetchName,
      childName,
      alias ? alias.realRange : child.version,
      state,
    );
    state.placementPromises.set(nestedKey, nested.then(() => undefined));
    try {
      await nested;
    } catch {
      /* keep the shared copy if the nested install can't resolve */
    }
  }
}

// ---------------------------------------------------------------------------
// Class facade
// ---------------------------------------------------------------------------

export class VersionResolver {
  parse = parseSemver;
  compare = compareSemver;
  satisfies = satisfiesRange;
  pickBest = pickBestMatch;
  resolveTree = resolveDependencyTree;
  resolveManifest = resolveFromManifest;
}

export default VersionResolver;
