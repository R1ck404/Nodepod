import type { RuntimeHost } from "./types";

const GLOBAL_FACTORY_KEY = "__NODEPOD_CREATE_BROWSER_HOST__";

let _host: RuntimeHost | null = null;
let _defaultFactory: (() => RuntimeHost) | null = null;

function readGlobalFactory(): (() => RuntimeHost) | null {
  try {
    const hooked = (globalThis as Record<string, unknown>)[GLOBAL_FACTORY_KEY];
    return typeof hooked === "function"
      ? (hooked as () => RuntimeHost)
      : null;
  } catch {
    return null;
  }
}

/** Used by the browser entry / browser-host to register a lazy default. */
export function registerDefaultHostFactory(
  factory: (() => RuntimeHost) | null,
): void {
  _defaultFactory = factory;
  try {
    const g = globalThis as Record<string, unknown>;
    if (factory) g[GLOBAL_FACTORY_KEY] = factory;
    else delete g[GLOBAL_FACTORY_KEY];
  } catch {
    /* ignore — non-writable globalThis in exotic hosts */
  }
}

/** Install a runtime host (browser default, or Node via `@r1ck404/nodepod/headless`). */
export function setRuntimeHost(host: RuntimeHost): void {
  _host = host;
}

function resolveFactory(): (() => RuntimeHost) | null {
  return _defaultFactory ?? readGlobalFactory();
}

export function getRuntimeHost(): RuntimeHost {
  if (!_host) {
    const factory = resolveFactory();
    if (!factory) {
      throw new Error(
        "[Nodepod] No RuntimeHost registered. Import @r1ck404/nodepod or @r1ck404/nodepod/headless.",
      );
    }
    _defaultFactory = factory;
    _host = factory();
  }
  return _host;
}

/**
 * Resolve a RuntimeHost after async chunk init. `vite-plugin-top-level-await`
 * wraps chunks in async IIFEs, so browser-host's
 * `globalThis.__NODEPOD_CREATE_BROWSER_HOST__ = ...` can land a tick after
 * static imports finish. Headless callers that already `setRuntimeHost` return
 * immediately.
 */
export async function ensureRuntimeHost(): Promise<RuntimeHost> {
  if (_host) return _host;

  for (let i = 0; i < 50; i++) {
    const factory = resolveFactory();
    if (factory) {
      _defaultFactory = factory;
      _host = factory();
      return _host;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  return getRuntimeHost();
}

/** Reset the active host instance (tests). */
export function resetRuntimeHost(): void {
  _host?.disposeGlobalResources?.();
  _host = null;
}
