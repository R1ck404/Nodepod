import type { TransformBatchFile } from "./offload-types.js";

export const TRANSFORM_BATCH_MAX_FILES = 64;
export const TRANSFORM_BATCH_MAX_SOURCE_BYTES = 1024 * 1024;

/** Split files without changing their order or placing an oversized file in a later batch. */
export function chunkTransformFiles(
  files: TransformBatchFile[],
  maxFiles = TRANSFORM_BATCH_MAX_FILES,
  maxSourceBytes = TRANSFORM_BATCH_MAX_SOURCE_BYTES,
): TransformBatchFile[][] {
  const batches: TransformBatchFile[][] = [];
  let current: TransformBatchFile[] = [];
  let currentBytes = 0;

  for (const file of files) {
    const fileBytes = file.source.length;
    if (
      current.length > 0 &&
      (current.length >= maxFiles || currentBytes + fileBytes > maxSourceBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += fileBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
