// Shared MemoryVolume reference for polyfills that need VFS access


import type { MemoryVolume } from "../memory-volume.js";

let sharedVolume: MemoryVolume | null = null;

// must be called once during init before watchers/scanners are used
export function setSharedVolume(vol: MemoryVolume): void {
  sharedVolume = vol;
}

export function getSharedVolume(): MemoryVolume | null {
  return sharedVolume;
}
