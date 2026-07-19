// Node-compatible import.meta object for ScriptEngine module wrappers.
// Mirrors Node's host-defined import.meta fields (url/filename/dirname/resolve/main).
// Vite-only APIs (glob/env/hot) are intentionally absent — those are compile-time.

import { pathToFileURL, fileURLToPath } from "../polyfills/url";
import * as pathPolyfill from "../polyfills/path";

export interface NodeImportMeta {
  url: string;
  filename: string;
  dirname: string;
  /** true when this module is the process entry point (Node >= 24.2 / 22.18). */
  main: boolean;
  /** Resolve a specifier to a URL string relative to this module (or parent). */
  resolve: (specifier: string, parent?: string | URL) => string;
}

export interface CreateImportMetaOptions {
  filename: string;
  dirname: string;
  /** Resolve a specifier to an absolute filesystem path (or bare builtin id). */
  resolvePath: (specifier: string, fromDir: string) => string;
  isMain: boolean;
  /** Return true when `id` is a node builtin (with or without node: prefix). */
  isBuiltin?: (id: string) => boolean;
}

function toFileUrlString(fsPath: string): string {
  if (fsPath.startsWith("file://")) return fsPath;
  return pathToFileURL(fsPath).href;
}

function parentToDir(parent: string | URL, fallbackDir: string): string {
  try {
    const href = typeof parent === "string" ? parent : parent.href;
    if (href.startsWith("file:")) {
      return pathPolyfill.dirname(fileURLToPath(href));
    }
    // non-file parents: best-effort path-like
    if (href.startsWith("/")) return pathPolyfill.dirname(href);
  } catch {
    /* fall through */
  }
  return fallbackDir;
}

/**
 * Build the import.meta object injected as $importMeta into every module wrapper.
 */
export function createImportMeta(opts: CreateImportMetaOptions): NodeImportMeta {
  const filename = opts.filename;
  const dirname = opts.dirname;
  const metaUrl = toFileUrlString(filename);
  const isBuiltin = opts.isBuiltin ?? (() => false);

  const resolve = (specifier: string, parent?: string | URL): string => {
    if (typeof specifier !== "string") {
      const err: any = new TypeError(
        `The "specifier" argument must be of type string. Received type ${typeof specifier}`,
      );
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }

    // Bare builtins resolve to node: URLs, matching Node.
    const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (isBuiltin(specifier) || isBuiltin(bare)) {
      return specifier.startsWith("node:") ? specifier : `node:${specifier}`;
    }

    const fromDir =
      parent !== undefined ? parentToDir(parent, dirname) : dirname;

    try {
      const resolved = opts.resolvePath(specifier, fromDir);
      if (typeof resolved !== "string" || resolved.length === 0) {
        const err: any = new Error(
          `Cannot find module '${specifier}' imported from ${filename}`,
        );
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      }
      // Resolver may return bare builtin ids for node: lookups
      if (isBuiltin(resolved) || resolved.startsWith("node:")) {
        return resolved.startsWith("node:") ? resolved : `node:${resolved}`;
      }
      return toFileUrlString(resolved);
    } catch (e: any) {
      if (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") {
        const err: any = new Error(
          `Cannot find module '${specifier}' imported from ${filename}`,
        );
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      }
      throw e;
    }
  };

  return {
    url: metaUrl,
    filename,
    dirname,
    main: opts.isMain,
    resolve,
  };
}
