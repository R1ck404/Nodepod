/**
 * 53-bit content hash (cyrb53), for keys that must not collide across
 * contents of the same length (persisted transform caches).
 */
export function contentDigest(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// DJB2 hash for cache keys
export function quickDigest(input: string): string {
  let accumulator = 0;
  for (let i = 0; i < input.length; i++) {
    accumulator = ((accumulator << 5) - accumulator) + input.charCodeAt(i);
    accumulator |= 0;
  }
  return accumulator.toString(36);
}
