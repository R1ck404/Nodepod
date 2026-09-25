// Tarball downloads started while an install is still resolving. Resolving a
// tree is a chain of registry round trips and extraction used to wait for
// the whole of it before fetching the first archive; now each archive is
// requested as soon as its version is chosen, and extraction takes the bytes
// (or the download in flight) from here.

import { downloadTarball } from "./registry-client";
import { getTarballCache } from "../persistence/tarball-cache";

const MAX_IN_FLIGHT = 16;
// archives prefetched and not taken yet (a tree whose install stops early
// leaves some behind)
const MAX_PENDING = 512;

const pending = new Map<string, Promise<ArrayBuffer | null>>();
const queue: Array<() => void> = [];
let inFlight = 0;

function slot(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(() => {
    inFlight++;
    resolve();
  }));
}

function release(): void {
  inFlight--;
  queue.shift()?.();
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  await slot();
  try {
    try {
      const cache = await getTarballCache();
      const hit = cache ? await cache.get(url) : null;
      if (hit) return hit;
    } catch {
      /* no cache: download */
    }
    return await downloadTarball(url);
  } catch {
    // extraction downloads it again and reports the error
    return null;
  } finally {
    release();
  }
}

/** Start getting a package archive (tarball cache, then the registry). */
export function prefetchTarball(url: string | undefined): void {
  if (!url || pending.has(url) || pending.size >= MAX_PENDING) return;
  pending.set(url, fetchBytes(url));
}

/** The prefetched archive for `url`, or null if none was started. Taken once. */
export function takePrefetchedTarball(url: string): Promise<ArrayBuffer | null> | null {
  const started = pending.get(url);
  if (!started) return null;
  pending.delete(url);
  return started;
}

/**
 * Let go of the archives an install prefetched and did not extract (packages
 * it found already installed, or everything after it failed).
 */
export function releasePrefetchedTarballs(urls: Iterable<string | undefined>): void {
  for (const url of urls) if (url) pending.delete(url);
}
