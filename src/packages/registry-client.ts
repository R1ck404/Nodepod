// Registry Client — fetches package metadata, versions, and tarballs from npm.

export interface VersionDetail {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  dist: {
    tarball: string;
    shasum: string;
    integrity?: string;
  };
  main?: string;
  module?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, string> | string;
}

export interface PackageMetadata {
  name: string;
  'dist-tags': {
    latest: string;
    [label: string]: string;
  };
  versions: Record<string, VersionDetail>;
  time?: Record<string, string>;
}

export interface RegistryConfig {
  endpoint?: string;
  metadataCache?: Map<string, PackageMetadata>;
  profiler?: NodepodProfilerImpl | null;
}

import { NPM_REGISTRY_URL } from "../constants/config";
import { getProxy } from "../cross-origin";
import type { NodepodProfilerImpl } from "../profiling/profiler";
import {
  fetchWithRetry,
  METADATA_TIMEOUT_MS,
  readBodyWithTimeout,
  RegistryFetchError,
  TARBALL_TIMEOUT_MS,
} from "./registry-fetch";

const NPM_REGISTRY_BASE = NPM_REGISTRY_URL;
const REGISTRY_CACHE_NAME = "nodepod-registry-v1";
const REGISTRY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const REGISTRY_MEMORY_MAX_ENTRIES = 256;
// how long a 404 answers repeat requests (a package published meanwhile is
// found again after this)
const NOT_FOUND_TTL_MS = 60_000;
const sharedMetadata = new Map<string, PackageMetadata>();
const inFlightMetadata = new Map<string, Promise<PackageMetadata>>();

function remember(key: string, metadata: PackageMetadata): void {
  sharedMetadata.delete(key);
  sharedMetadata.set(key, metadata);
  while (sharedMetadata.size > REGISTRY_MEMORY_MAX_ENTRIES) {
    const oldest = sharedMetadata.keys().next().value;
    if (oldest === undefined) break;
    sharedMetadata.delete(oldest);
  }
}

async function openRegistryCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(REGISTRY_CACHE_NAME);
  } catch {
    return null;
  }
}

// @scope/pkg -> @scope%2fpkg
function encodeForUrl(pkgName: string): string {
  return pkgName.replace(/\//g, '%2f');
}

export class RegistryClient {
  private baseUrl: string;
  private metadataStore: Map<string, PackageMetadata>;
  // packages the registry just said don't exist: an install asks for some
  // names twice (the resolver's prefetch, then its walk; wasm variant
  // guesses), and a 404 answers both
  private notFound = new Map<string, { error: Error; at: number }>();
  private profiler: NodepodProfilerImpl | null;

  constructor(config: RegistryConfig = {}) {
    this.baseUrl = (config.endpoint || NPM_REGISTRY_BASE).replace(/\/+$/, '');
    this.metadataStore = config.metadataCache || new Map();
    this.profiler = config.profiler ?? null;
  }

  // Cached per client instance
  async fetchManifest(name: string): Promise<PackageMetadata> {
    const cached = this.metadataStore.get(name);
    if (cached) {
      return cached;
    }

    const requestUrl = `${this.baseUrl}/${encodeForUrl(name)}`;
    const sharedKey = `${this.baseUrl}|${name}`;
    const shared = sharedMetadata.get(sharedKey);
    if (shared) {
      this.metadataStore.set(name, shared);
      return shared;
    }
    const miss = this.notFound.get(name);
    if (miss && Date.now() - miss.at < NOT_FOUND_TTL_MS) throw miss.error;

    const pending = inFlightMetadata.get(sharedKey);
    if (pending) return pending;

    const request = this.fetchAndCacheManifest(name, requestUrl, sharedKey);
    inFlightMetadata.set(sharedKey, request);
    try {
      return await request;
    } catch (err) {
      if (err instanceof Error && err.message.endsWith("does not exist in the registry")) {
        this.notFound.set(name, { error: err, at: Date.now() });
      }
      throw err;
    } finally {
      inFlightMetadata.delete(sharedKey);
    }
  }

  private async fetchAndCacheManifest(
    name: string,
    requestUrl: string,
    sharedKey: string,
  ): Promise<PackageMetadata> {
    const profileSpan = this.profiler?.begin("packages.registry.fetchManifest", {
      category: "packages",
      metadata: { packageName: name },
    }) ?? null;
    try {
      return await this.fetchAndCacheManifestInternal(name, requestUrl, sharedKey);
    } finally {
      this.profiler?.end(profileSpan);
    }
  }

  private async fetchAndCacheManifestInternal(
    name: string,
    requestUrl: string,
    sharedKey: string,
  ): Promise<PackageMetadata> {
    const persistentCache = await openRegistryCache();
    const persisted = persistentCache
      ? await persistentCache.match(requestUrl).catch(() => undefined)
      : undefined;
    const storedAt = Number(persisted?.headers.get("x-nodepod-stored-at") ?? 0);
    if (persisted && storedAt > 0 && Date.now() - storedAt < REGISTRY_CACHE_MAX_AGE_MS) {
      const metadata = (await persisted.json()) as PackageMetadata;
      this.metadataStore.set(name, metadata);
      remember(sharedKey, metadata);
      return metadata;
    }

    // Avoid If-None-Match: it triggers a CORS preflight, and npm's OPTIONS /
    // scoped-404 responses often omit Access-Control-Allow-Origin. Local TTL
    // above is enough for browser caching.
    const requestInit: RequestInit = {
      headers: {
        Accept:
          "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
      },
    };
    // Bounded: a relay that never answers must not pin the whole install
    // (`Resolving foo@latest` forever) until the caller's watchdog fires.
    let resp: Response;
    let proxyFallbackFailed: string | null = null;
    try {
      resp = await fetchWithRetry(requestUrl, {
        timeoutMs: METADATA_TIMEOUT_MS,
        init: requestInit,
        label: `registry metadata for "${name}"`,
      });
      // Some configured CORS proxies return a synthetic 404 when they are
      // unavailable. Retry the registry directly so a real package (React is
      // the common example) is not reported as missing.
      if (resp.status === 404 && getProxy()) {
        try {
          resp = await fetchWithRetry(requestUrl, {
            timeoutMs: METADATA_TIMEOUT_MS,
            init: requestInit,
            label: `registry metadata for "${name}"`,
            fetchImpl: (url, init) => fetch(url, init),
          });
        } catch (error) {
          proxyFallbackFailed =
            error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to fetch package "${name}" from the registry (${detail}). ` +
          `The package may not exist, or the registry blocked the browser request.`,
      );
    }

    if (resp.status === 404) {
      if (proxyFallbackFailed) {
        throw new Error(
          `Configured CORS proxy returned HTTP 404 for package "${name}"; ` +
            `the direct registry request also failed (${proxyFallbackFailed}).`,
        );
      }
      throw new Error(`Package "${name}" does not exist in the registry`);
    }
    if (!resp.ok) {
      throw new Error(
        `Registry request for "${name}" failed with HTTP ${resp.status}`
      );
    }

    let metadata: PackageMetadata;
    try {
      const bytes = await readBodyWithTimeout(
        resp,
        METADATA_TIMEOUT_MS,
        `registry metadata for "${name}"`,
      );
      metadata = JSON.parse(new TextDecoder().decode(bytes)) as PackageMetadata;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Registry metadata for "${name}" could not be read (${detail})`);
    }
    if (!metadata || typeof metadata !== "object" || !metadata.versions) {
      throw new Error(`Registry metadata for "${name}" is malformed`);
    }
    this.metadataStore.set(name, metadata);
    remember(sharedKey, metadata);

    if (persistentCache) {
      const headers = new Headers(resp.headers);
      headers.set("content-type", "application/json");
      headers.set("x-nodepod-stored-at", String(Date.now()));
      const body = JSON.stringify(metadata);
      void persistentCache.put(requestUrl, new Response(body, {
        status: 200,
        headers,
      })).catch(() => {});
    }

    return metadata;
  }

  // Resolves dist-tags (e.g. "latest", "next") to concrete versions
  async fetchVersion(name: string, version: string): Promise<VersionDetail> {
    const metadata = await this.fetchManifest(name);

    const taggedVersion = metadata['dist-tags'][version];
    const resolvedVersion = taggedVersion || version;

    const detail = metadata.versions[resolvedVersion];
    if (!detail) {
      throw new Error(
        `Version "${version}" does not exist for package "${name}"`
      );
    }

    return detail;
  }

  async getLatestVersion(name: string): Promise<string> {
    const metadata = await this.fetchManifest(name);
    return metadata['dist-tags'].latest;
  }

  async listVersions(name: string): Promise<string[]> {
    const metadata = await this.fetchManifest(name);
    return Object.keys(metadata.versions);
  }

  async getTarballUrl(name: string, version: string): Promise<string> {
    const detail = await this.fetchVersion(name, version);
    return detail.dist.tarball;
  }

  async downloadArchive(tarballUrl: string): Promise<ArrayBuffer> {
    const profileSpan = this.profiler?.begin("packages.registry.download", {
      category: "packages",
      metadata: { url: tarballUrl },
    }) ?? null;
    try {
      return await downloadTarball(tarballUrl);
    } finally {
      this.profiler?.end(profileSpan);
    }
  }

  flushCache(): void {
    this.metadataStore.clear();
  }
}

/** Download a tarball with per-attempt deadlines and bounded retries. */
export async function downloadTarball(tarballUrl: string): Promise<ArrayBuffer> {
  let resp: Response;
  try {
    resp = await fetchWithRetry(tarballUrl, {
      timeoutMs: TARBALL_TIMEOUT_MS,
      label: "tarball download",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Tarball download failed (${detail}): ${tarballUrl}`);
  }
  if (!resp.ok) {
    throw new Error(`Tarball download failed (HTTP ${resp.status}): ${tarballUrl}`);
  }
  try {
    return await readBodyWithTimeout(resp, TARBALL_TIMEOUT_MS, "tarball download");
  } catch (error) {
    if (error instanceof RegistryFetchError) {
      throw new Error(`Tarball download failed (${error.message}): ${tarballUrl}`);
    }
    throw error;
  }
}

export function flushSharedRegistryCache(): void {
  sharedMetadata.clear();
  inFlightMetadata.clear();
}

export default RegistryClient;
