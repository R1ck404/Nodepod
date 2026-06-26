// Shared IVolume reference for polyfills that need VFS access


import type { IVolume } from "../types/volume";

let sharedVolume: IVolume | null = null;

// must be called once during init before watchers/scanners are used
export function setSharedVolume(vol: IVolume): void {
  sharedVolume = vol;
}

export function getSharedVolume(): IVolume | null {
  return sharedVolume;
}
