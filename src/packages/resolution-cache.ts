import type { ResolvedDependency } from "./version-resolver";

const CACHE_NAME = "nodepod-resolution-v1";
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CACHE_SCHEMA = 1;
const memoryCache = new Map<string, Map<string, ResolvedDependency>>();
const inFlight = new Map<string, Promise<Map<string, ResolvedDependency>>>();

function requestFor(key: string): Request {
  return new Request(`https://nodepod.invalid/resolution/${encodeURIComponent(key)}`);
}

function cloneTree(tree: Map<string, ResolvedDependency>): Map<string, ResolvedDependency> {
  return new Map([...tree].map(([name, dep]) => [name, {
    ...dep,
    dependencies: { ...dep.dependencies },
  }]));
}

async function readPersistent(key: string): Promise<Map<string, ResolvedDependency> | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(requestFor(key));
    if (!response) return null;
    const value = await response.json() as {
      schema?: number;
      createdAt?: number;
      entries?: Array<[string, ResolvedDependency]>;
    };
    if (value.schema !== CACHE_SCHEMA || !Array.isArray(value.entries)) return null;
    if (!value.createdAt || Date.now() - value.createdAt > CACHE_MAX_AGE_MS) return null;
    return new Map(value.entries);
  } catch {
    return null;
  }
}

async function writePersistent(key: string, tree: Map<string, ResolvedDependency>): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(requestFor(key), new Response(JSON.stringify({
      schema: CACHE_SCHEMA,
      createdAt: Date.now(),
      entries: [...tree],
    }), { headers: { "content-type": "application/json" } }));
  } catch {
    /* optional cache */
  }
}

export async function resolveWithCache(
  key: string,
  resolver: () => Promise<Map<string, ResolvedDependency>>,
): Promise<{ tree: Map<string, ResolvedDependency>; hit: boolean }> {
  const memory = memoryCache.get(key);
  if (memory) return { tree: cloneTree(memory), hit: true };

  const persistent = await readPersistent(key);
  if (persistent) {
    memoryCache.set(key, persistent);
    return { tree: cloneTree(persistent), hit: true };
  }

  let pending = inFlight.get(key);
  const shared = Boolean(pending);
  if (!pending) {
    pending = resolver();
    inFlight.set(key, pending);
  }
  try {
    const tree = await pending;
    memoryCache.set(key, cloneTree(tree));
    if (!shared) await writePersistent(key, tree);
    return { tree: cloneTree(tree), hit: shared };
  } finally {
    if (!shared) inFlight.delete(key);
  }
}

export function clearResolutionMemoryCache(): void {
  memoryCache.clear();
  inFlight.clear();
}
