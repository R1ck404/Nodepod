// Single esbuild-wasm instance per realm. Both the `esbuild` polyfill and
// the install-time module transformer used to boot their own copy of the
// ~10MB binary; this module owns the one shared init promise, stored on
// globalThis so duplicate bundle copies of this file still converge.

import {
  CDN_ESBUILD_ESM,
  CDN_ESBUILD_BINARY,
  CDN_ESBUILD_BUNDLE,
  cdnImport,
} from "../constants/cdn-urls";

export type EsbuildEngine = typeof import("esbuild-wasm");

// esbuild runs as Go compiled to wasm, one runtime per instance, each in its
// own worker. Its linear memory grows to fit the largest single call (a
// build holds every module's AST at once: over 100MB per MB of input, so
// pre-bundling a UI kit passes 400MB) and wasm memory never shrinks, so a
// long-lived dev server kept its startup pre-bundle's high-water mark
// forever. Between calls Go's GC does reclaim: many small transforms don't
// grow it. So an instance that has run a call over RETIRE_CALL_BYTES of
// input is detached: new calls go to a fresh instance (a few ms to start
// from the shared compiled module) and the old worker is terminated as soon
// as the calls still running on it return.
const RETIRE_CALL_BYTES = 512 * 1024;

interface Instance {
  engine: EsbuildEngine;
  // null if esbuild's worker couldn't be captured: never terminated
  worker: Worker | null;
  // calls running on it
  pending: number;
  // takes no new calls; terminated once pending reaches 0
  detached: boolean;
}

interface EngineState {
  generation: number;
  primary: Instance | null;
  // a wasm binary other than the pinned default, from initialize({ wasmURL })
  customWasmURL?: string;
}

interface EsbuildGlobal {
  __nodepodEsbuild?: Promise<EsbuildEngine>;
  __nodepodEsbuildReady?: EsbuildEngine;
  __esbuild?: EsbuildEngine;
  __nodepodEsbuildState?: EngineState;
}

function engineState(): EngineState {
  const g = globalThis as EsbuildGlobal;
  return (g.__nodepodEsbuildState ??= { generation: 0, primary: null });
}

// esbuild-wasm spawns its worker synchronously inside initialize(): capture
// it so the instance can be retired later
function initializeCapturingWorker(
  engine: EsbuildEngine,
  options: Parameters<EsbuildEngine["initialize"]>[0],
): { ready: Promise<void>; worker: () => Worker | null } {
  const g = globalThis as { Worker?: typeof Worker };
  const NativeWorker = g.Worker;
  let spawned: Worker | null = null;
  if (typeof NativeWorker === "function") {
    const Capturing = function (this: unknown, ...args: ConstructorParameters<typeof Worker>) {
      const w = new NativeWorker(...args);
      spawned = w;
      return w;
    } as unknown as typeof Worker;
    Capturing.prototype = NativeWorker.prototype;
    g.Worker = Capturing;
  }
  let ready: Promise<void>;
  try {
    ready = engine.initialize(options);
  } finally {
    if (NativeWorker) g.Worker = NativeWorker;
  }
  return { ready, worker: () => spawned };
}

/**
 * Get (initializing on first call) the realm-wide esbuild-wasm instance.
 * A host page may pre-provide its own instance on `globalThis.__esbuild`.
 * Failed initialization clears the shared promise so callers can retry.
 */
export function getEsbuild(opts?: { wasmURL?: string }): Promise<EsbuildEngine> {
  const g = globalThis as EsbuildGlobal;
  const state = engineState();

  if (g.__nodepodEsbuild) return g.__nodepodEsbuild;
  // like esbuild's own initialize(): a binary URL only applies to the call
  // that actually starts it (and then to its replacements)
  if (opts?.wasmURL && opts.wasmURL !== CDN_ESBUILD_BINARY && state.generation === 0 && !state.primary) {
    state.customWasmURL = opts.wasmURL;
  }

  if (g.__esbuild) {
    g.__nodepodEsbuildReady = g.__esbuild;
    g.__nodepodEsbuild = Promise.resolve(g.__esbuild);
    return g.__nodepodEsbuild;
  }

  const generation = state.generation;
  _instancesCreated++;
  g.__nodepodEsbuild = (async () => {
    try {
      const customWasmURL = state.customWasmURL;
      const [loaded, sharedModule] = await Promise.all([
        // a retired instance's module can't be initialized again: later
        // generations load their own module instance
        cdnImport(
          state.generation === 0
            ? CDN_ESBUILD_ESM
            : `${CDN_ESBUILD_BUNDLE}?nodepod-instance=${state.generation}`,
        ),
        customWasmURL ? null : requestSharedModule(),
      ]);
      const engine: EsbuildEngine = loaded.default || loaded;
      const instance: Instance = { engine, worker: null, pending: 0, detached: false };
      let init: ReturnType<typeof initializeCapturingWorker> | null = null;
      try {
        init = initializeCapturingWorker(
          engine,
          sharedModule
            ? { wasmModule: sharedModule }
            : { wasmURL: customWasmURL || CDN_ESBUILD_BINARY },
        );
        await init.ready;
        instance.worker = init.worker();
      } catch (initErr) {
        if (
          !(
            initErr instanceof Error &&
            initErr.message.includes('Cannot call "initialize" more than once')
          )
        ) {
          try {
            init?.worker()?.terminate();
          } catch {
            /* gone */
          }
          throw initErr;
        }
      }
      if (state.generation !== generation) {
        // disposed (or replaced) while starting: this one is nobody's
        terminate(instance);
        throw new Error("esbuild: stopped while initializing");
      }
      state.primary = instance;
      g.__nodepodEsbuildReady = engine;
      return engine;
    } catch (err) {
      if (state.generation === generation) g.__nodepodEsbuild = undefined;
      throw new Error(`esbuild: initialization failed -- ${err}`);
    }
  })();

  return g.__nodepodEsbuild;
}

// Every instance loads its own copy of esbuild's JS (an initialized module
// can't be started again), and module records are never freed: past this
// many in one realm, instances are no longer replaced or added.
const MAX_INSTANCES = 24;
let _instancesCreated = 0;

// Inside a process worker the main thread shares one compiled module per
// session (see esbuild-wasm-module.ts); on the main thread, use it directly.
async function requestSharedModule(): Promise<WebAssembly.Module | null> {
  const request = (globalThis as { __nodepodRequestEsbuildModule?: () => Promise<WebAssembly.Module | null> })
    .__nodepodRequestEsbuildModule;
  try {
    if (request) return await request();
    if (typeof document !== "undefined") {
      const { getSharedEsbuildModule } = await import("./esbuild-wasm-module");
      return await getSharedEsbuildModule();
    }
  } catch {
    /* fall back to wasmURL */
  }
  return null;
}

/** The initialized instance, or null if init hasn't completed yet. */
export function getEsbuildIfReady(): EsbuildEngine | null {
  return (globalThis as EsbuildGlobal).__nodepodEsbuildReady ?? null;
}

// ── Leases ──
// Every call runs on a leased instance, so an instance is never terminated
// under a running call.

export interface EsbuildLease {
  engine: EsbuildEngine;
  /** End the call. `inputBytes`: the source it processed (all of a build's inputs). */
  release(inputBytes?: number): void;
}

function lease(instance: Instance | null, engine: EsbuildEngine): EsbuildLease {
  if (instance) instance.pending++;
  let released = false;
  return {
    engine,
    release(inputBytes = 0) {
      if (released || !instance) return;
      released = true;
      instance.pending--;
      if (inputBytes >= RETIRE_CALL_BYTES) detach(instance);
      if (instance.detached && instance.pending === 0) terminate(instance);
    },
  };
}

/** Lease the primary instance (initializing it if needed) for one call. */
export async function acquireEsbuild(opts?: { wasmURL?: string }): Promise<EsbuildLease> {
  const g = globalThis as EsbuildGlobal;
  for (let attempt = 0; attempt < 8; attempt++) {
    const engine = getEsbuildIfReady() ?? (await getEsbuild(opts));
    const primary = engineState().primary;
    if (primary && primary.engine === engine) return lease(primary, engine);
    // a host-provided instance isn't ours to track or stop
    if (!primary && engine === g.__esbuild) return lease(null, engine);
    // detached while this call waited for it: take its replacement. A ready
    // engine that isn't the primary is stale; start a fresh one
    if (getEsbuildIfReady() === engine) {
      g.__nodepodEsbuildReady = undefined;
      g.__nodepodEsbuild = undefined;
    }
  }
  throw new Error("esbuild: no instance available");
}

function detach(instance: Instance): void {
  if (instance.detached || !instance.worker) return;
  const state = engineState();
  // the primary is replaced by a new instance: keep it past the limit
  if (state.primary === instance && _instancesCreated >= MAX_INSTANCES) return;
  instance.detached = true;
  if (state.primary === instance) {
    const g = globalThis as EsbuildGlobal;
    state.primary = null;
    state.generation++;
    g.__nodepodEsbuildReady = undefined;
    g.__nodepodEsbuild = undefined;
    // start the replacement now so the next call (an HMR transform, the
    // next build) doesn't wait for it
    void getEsbuild().catch(() => {});
    return;
  }
  const i = _lanes.findIndex((l) => l.instance === instance);
  if (i >= 0) {
    const [lane] = _lanes.splice(i, 1);
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
  }
}

function terminate(instance: Instance): void {
  try {
    instance.worker?.terminate();
  } catch {
    /* already gone */
  }
  instance.worker = null;
}

// ── Transform lanes ──
// esbuild-wasm is single-threaded Go: every transform() queues behind the
// previous one. Bundlers and dev servers issue one transform per module,
// many at a time, while their own thread also has work to do, so a queue
// forms on the one instance. When it does, extra instances (instantiated from
// the same compiled module) take transforms too, and are retired once idle.
// build()/context() stay on the primary instance.
const MAX_EXTRA_LANES = Math.max(
  0,
  Math.min(2, ((globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency ?? 2) - 2),
);
// calls on every instance before another lane is started
const LANE_SPAWN_BACKLOG = 3;
const LANE_IDLE_MS = 3000;

interface Lane {
  instance: Instance | null; // null while starting
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const _lanes: Lane[] = [];
let _laneCounter = 0;

function spawnLane(): void {
  const lane: Lane = { instance: null, idleTimer: null };
  _lanes.push(lane);
  _instancesCreated++;
  void (async () => {
    let init: ReturnType<typeof initializeCapturingWorker> | null = null;
    try {
      const [loaded, sharedModule] = await Promise.all([
        cdnImport(`${CDN_ESBUILD_BUNDLE}?nodepod-lane=${++_laneCounter}`),
        requestSharedModule(),
      ]);
      if (!sharedModule) throw new Error("no shared module");
      const engine: EsbuildEngine = loaded.default || loaded;
      init = initializeCapturingWorker(engine, { wasmModule: sharedModule });
      await init.ready;
      const instance: Instance = { engine, worker: init.worker(), pending: 0, detached: false };
      if (!_lanes.includes(lane) || !instance.worker) {
        // disposed while starting, or not stoppable: don't keep it
        terminate(instance);
        throw new Error("lane dropped");
      }
      lane.instance = instance;
      scheduleLaneIdle(lane);
    } catch {
      // lanes are an optimization: drop this one and stay on the primary
      if (!lane.instance) {
        try {
          init?.worker()?.terminate();
        } catch {
          /* gone */
        }
      }
      const i = _lanes.indexOf(lane);
      if (i >= 0) _lanes.splice(i, 1);
    }
  })();
}

function scheduleLaneIdle(lane: Lane): void {
  if (lane.idleTimer) clearTimeout(lane.idleTimer);
  const timer = setTimeout(() => {
    lane.idleTimer = null;
    const instance = lane.instance;
    if (instance && instance.pending === 0) {
      detach(instance);
      terminate(instance);
    }
  }, LANE_IDLE_MS);
  // in process workers setTimeout is the node timers polyfill: don't let
  // this timer keep the process alive
  (timer as unknown as { unref?: () => void }).unref?.();
  lane.idleTimer = timer;
}

/**
 * Run one esbuild transform on the least-loaded instance, starting extra
 * instances while the primary is backed up. `inputBytes`: the source size.
 */
export async function runEsbuildTransform<T>(
  run: (engine: EsbuildEngine) => Promise<T>,
  inputBytes = 0,
): Promise<T> {
  const state = engineState();
  const primary = state.primary;
  // no primary (starting, or being replaced): any ready lane beats waiting
  let bestLoad = primary ? primary.pending : Infinity;
  let best: Lane | null = null;
  for (const lane of _lanes) {
    const instance = lane.instance;
    if (instance && !instance.detached && instance.pending < bestLoad) {
      best = lane;
      bestLoad = instance.pending;
    }
  }
  if (
    !best &&
    primary &&
    primary.pending >= LANE_SPAWN_BACKLOG &&
    _lanes.length < MAX_EXTRA_LANES &&
    _instancesCreated < MAX_INSTANCES &&
    _lanes.every((l) => l.instance && l.instance.pending >= LANE_SPAWN_BACKLOG) &&
    !state.customWasmURL &&
    typeof Worker === "function"
  ) {
    spawnLane();
  }
  if (best?.instance) {
    const lane = best;
    const instance = best.instance;
    if (lane.idleTimer) {
      clearTimeout(lane.idleTimer);
      lane.idleTimer = null;
    }
    const leased = lease(instance, instance.engine);
    try {
      return await run(leased.engine);
    } finally {
      leased.release(inputBytes);
      if (!instance.detached && instance.pending === 0) scheduleLaneIdle(lane);
    }
  }
  const leased = await acquireEsbuild();
  try {
    return await run(leased.engine);
  } finally {
    leased.release(inputBytes);
  }
}

/**
 * Initialize esbuild in the background and run it once, so a tool that is
 * about to use it (dev servers, bundlers, test runners) finds a warm engine.
 * esbuild-wasm runs in its own worker, so this overlaps with the tool's own
 * startup instead of adding to it. Failures are ignored; the real call
 * reports them.
 */
export function prewarmEsbuild(): void {
  const g = globalThis as EsbuildGlobal;
  if (g.__nodepodEsbuild) return;
  void acquireEsbuild()
    .then(async (leased) => {
      try {
        const engine = leased.engine;
        await engine.transform("export const a: number = 1", { loader: "ts" } as never);
        await engine.build({
          stdin: { contents: "import { a } from './a'; export default a", loader: "ts", resolveDir: "/" },
          plugins: [
            {
              name: "nodepod-prewarm",
              setup(b: any) {
                b.onResolve({ filter: /.*/ }, (args: any) => ({ path: args.path, namespace: "prewarm" }));
                b.onLoad({ filter: /.*/, namespace: "prewarm" }, () => ({ contents: "export const a = 1", loader: "js" }));
              },
            },
          ],
          bundle: true,
          write: false,
          format: "esm",
          logLevel: "silent",
        });
      } finally {
        leased.release();
      }
    })
    .catch(() => {});
}

export function disposeEsbuild(): void {
  const g = globalThis as EsbuildGlobal;
  const state = engineState();
  for (const lane of _lanes.splice(0)) {
    if (lane.idleTimer) clearTimeout(lane.idleTimer);
    if (lane.instance) terminate(lane.instance);
  }
  try { (g.__nodepodEsbuildReady as any)?.stop?.(); } catch { /* ignore */ }
  const primary = state.primary;
  // a host-provided instance isn't ours to stop
  if (primary && !(g.__esbuild && primary.engine === g.__esbuild)) {
    primary.detached = true;
    terminate(primary);
  }
  state.primary = null;
  state.generation++;
  g.__nodepodEsbuildReady = undefined;
  g.__nodepodEsbuild = undefined;
}
