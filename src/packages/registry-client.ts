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
}

import { NPM_REGISTRY_URL } from "../constants/config";

const NPM_REGISTRY_BASE = NPM_REGISTRY_URL;
const REGISTRY_CACHE_NAME = "nodepod-registry-v1";
const REGISTRY_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const REGISTRY_MEMORY_MAX_ENTRIES = 256;
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

  constructor(config: RegistryConfig = {}) {
    this.baseUrl = (config.endpoint || NPM_REGISTRY_BASE).replace(/\/+$/, '');
    this.metadataStore = config.metadataCache || new Map();
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
    const pending = inFlightMetadata.get(sharedKey);
    if (pending) return pending;

    const request = this.fetchAndCacheManifest(name, requestUrl, sharedKey);
    inFlightMetadata.set(sharedKey, request);
    try {
      return await request;
    } finally {
      inFlightMetadata.delete(sharedKey);
    }
  }

  private async fetchAndCacheManifest(
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

    const resp = await fetch(requestUrl, {
      headers: {
        Accept:
          'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
        ...(persisted?.headers.get("etag")
          ? { "If-None-Match": persisted.headers.get("etag")! }
          : {}),
      },
    });

    if (resp.status === 304 && persisted) {
      const metadata = (await persisted.json()) as PackageMetadata;
      this.metadataStore.set(name, metadata);
      remember(sharedKey, metadata);
      return metadata;
    }

    if (resp.status === 404) {
      throw new Error(`Package "${name}" does not exist in the registry`);
    }
    if (!resp.ok) {
      throw new Error(
        `Registry request for "${name}" failed with HTTP ${resp.status}`
      );
    }

    const metadata = (await resp.json()) as PackageMetadata;
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
    const resp = await fetch(tarballUrl);
    if (!resp.ok) {
      throw new Error(`Tarball download failed (HTTP ${resp.status}): ${tarballUrl}`);
    }
    return resp.arrayBuffer();
  }

  flushCache(): void {
    this.metadataStore.clear();
  }
}

export default RegistryClient;
