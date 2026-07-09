// Version Resolver — semver parsing, range matching, and dependency tree resolution.

import { RegistryClient, VersionDetail } from "./registry-client";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedDependency {
  name: string;
  version: string;
  tarballUrl: string;
  dependencies: Record<string, string>;
  shasum?: string;
}

export interface ResolutionConfig {
  registry?: RegistryClient;
  devDependencies?: boolean;
  optionalDependencies?: boolean;
  onProgress?: (msg: string) => void;
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

// Returns null for unparseable strings
export function parseSemver(raw: string): SemverComponents | null {
  const m = raw.match(SEMVER_PATTERN);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
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
    return a.prerelease.localeCompare(b.prerelease);
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
    const base = padVersion(range.slice(1));
    const bv = parseSemver(base);
    if (!bv) return false;

    if (sv.major !== bv.major) return false;
    if (bv.major === 0) {
      if (bv.minor !== 0 && sv.minor !== bv.minor) return false;
      if (bv.minor === 0 && sv.minor !== 0) return false;
    }
    return compareSemver(version, base) >= 0;
  }

  if (range.startsWith("~")) {
    const base = padVersion(range.slice(1));
    const bv = parseSemver(base);
    if (!bv) return false;
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
    /^\d+$/.test(range) ||
    /^\d+\.\d+$/.test(range)
  ) {
    const segments = range.replace(/[xX]/g, "").split(".").filter(Boolean);
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
  const descending = [...available].sort((a, b) => compareSemver(b, a));
  for (const candidate of descending) {
    if (satisfiesRange(candidate, range)) return candidate;
  }
  return null;
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

  await walkDependency(rootName, versionRange, state);
  return state.completed;
}

export async function resolveFromManifest(
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  },
  config: ResolutionConfig = {},
): Promise<Map<string, ResolvedDependency>> {
  const client = config.registry || new RegistryClient();
  const state = createState(client, config);

  const allDeps: Record<string, string> = { ...manifest.dependencies };
  if (config.devDependencies && manifest.devDependencies) {
    Object.assign(allDeps, manifest.devDependencies);
  }

  const entries = Object.entries(allDeps);

  // Claim root slots for every direct manifest dep before walking transitive
  // edges or auto-installed peers. Otherwise a plugin's peer range (e.g.
  // @tailwindcss/vite wanting vite@^5||^8) can hoist a newer major before
  // the project's own vite@^5 devDependency is seen.
  for (const [depName, depRange] of entries) {
    await walkDependency(depName, depRange, state, "", { walkEdges: false });
  }

  // Walk transitive and peer edges for each direct manifest dependency.
  for (const [depName] of entries) {
    await walkDependencyEdges(depName, state);
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
      deferred.reject(err);
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
  const allVersions = Object.keys(metadata.versions);

  let chosenVersion: string;
  if (versionConstraint === "latest" || versionConstraint === "*") {
    chosenVersion = metadata["dist-tags"].latest;
  } else if (metadata["dist-tags"][versionConstraint]) {
    chosenVersion = metadata["dist-tags"][versionConstraint];
  } else {
    const best = pickBestMatch(allVersions, versionConstraint);
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
    version: chosenVersion,
    tarballUrl: versionInfo.dist.tarball,
    dependencies: versionInfo.dependencies || {},
    shasum: versionInfo.dist.shasum,
  };
  completed.set(placementKey, resolved);

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

  const metadata = await state.registry.fetchManifest(resolved.name);
  const versionInfo = metadata.versions[resolved.version];
  if (!versionInfo) return;

  await walkEdgesForPackage(
    placementKey,
    resolved.name,
    versionInfo,
    state,
  );
}

async function walkEdgesForPackage(
  placementKey: string,
  installName: string,
  versionInfo: VersionDetail,
  state: TreeWalkState,
): Promise<void> {
  // non-optional peers are included (npm v7+ behaviour)
  const edges: Record<string, string> = {};

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
        edges[optName] = optRange as string;
      }
    } else {
      // Always include wasm32-wasi optional deps — they're WASM alternatives
      // to native bindings and are the only variant that can run in-browser
      const optNames = Object.keys(versionInfo.optionalDependencies);
      let hasWasmVariant = false;
      for (const [optName, optRange] of Object.entries(versionInfo.optionalDependencies)) {
        if (optName.includes("wasm32-wasi") || optName.includes("wasm")) {
          edges[optName] = optRange as string;
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
            try { await walkDependency(alt, "*", state, placementKey); } catch { /* package may not exist */ }
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
