// Process polyfill -- buildProcessEnv() constructs a full process object

import { EventEmitter, EventHandler } from "./events";
import {
  VERSIONS,
  NODE_SUB_VERSIONS,
  MOCK_OS,
  MOCK_PROCESS,
  MOCK_MEMORY,
  DEFAULT_ENV,
  DEFAULT_TERMINAL,
} from "../constants/config";
import {
  getRegistry,
  ProcessExitSentinel,
  type Handle,
} from "./../helpers/event-loop";

// capture before engine wrapper overrides globalThis.console
const _nativeConsole = console;

export interface ProcessEnvVars {
  [key: string]: string | undefined;
}

interface OutputStreamBridge {
  isTTY: boolean;
  columns: number;
  rows: number;
  write: (data: string | Buffer, encoding?: string, cb?: () => void) => boolean;
  end?: (data?: string, cb?: () => void) => void;
  on: (evt: string, fn: EventHandler) => OutputStreamBridge;
  once: (evt: string, fn: EventHandler) => OutputStreamBridge;
  off: (evt: string, fn: EventHandler) => OutputStreamBridge;
  emit: (evt: string, ...args: unknown[]) => boolean;
  addListener: (evt: string, fn: EventHandler) => OutputStreamBridge;
  removeListener: (evt: string, fn: EventHandler) => OutputStreamBridge;
  removeAllListeners: (evt?: string) => OutputStreamBridge;
  setMaxListeners: (n: number) => OutputStreamBridge;
  getMaxListeners: () => number;
  listenerCount: (evt: string) => number;
  listeners: (evt: string) => EventHandler[];
  rawListeners: (evt: string) => EventHandler[];
  prependListener: (evt: string, fn: EventHandler) => OutputStreamBridge;
  prependOnceListener: (evt: string, fn: EventHandler) => OutputStreamBridge;
  eventNames: () => string[];
  pause?: () => OutputStreamBridge;
  resume?: () => OutputStreamBridge;
  setEncoding?: (enc: string) => OutputStreamBridge;
  clearLine?: (dir: number, cb?: () => void) => boolean;
  cursorTo?: (x: number, y?: number, cb?: () => void) => boolean;
  moveCursor?: (dx: number, dy: number, cb?: () => void) => boolean;
  getWindowSize?: () => [number, number];
  getColorDepth?: (env?: Record<string, string>) => number;
  hasColors?: (
    countOrEnv?: number | Record<string, string>,
    env?: Record<string, string>,
  ) => boolean;
}

interface InputStreamBridge extends OutputStreamBridge {
  read?: (size?: number) => string | Buffer | null;
  setRawMode?: (flag: boolean) => InputStreamBridge;
  isRaw?: boolean;
  destroy?: () => InputStreamBridge;
  pipe?: (dest: any) => any;
  unpipe?: () => InputStreamBridge;
  unshift?: (...args: unknown[]) => void;
  wrap?: (stream: any) => InputStreamBridge;
  readable?: boolean;
  writable?: boolean;
  destroyed?: boolean;
  [Symbol.asyncIterator]?: () => AsyncIterator<any>;
}

export interface ProcessObject {
  env: ProcessEnvVars;
  cwd: () => string;
  chdir: (dir: string) => void;
  _chdirHook?: (dir: string) => void;
  platform: string;
  version: string;
  versions: {
    node: string;
    v8: string;
    uv: string;
    modules: string;
    openssl: string;
    napi: string;
    webcontainer: string;
  };
  argv: string[];
  argv0: string;
  execPath: string;
  execArgv: string[];
  pid: number;
  ppid: number;
  /**
   * undefined by default. user code can set this to seed an exit code for
   * process.exit() (no arg) or natural drain. process.exit(N) overrides
   * and writes N back here.
   */
  exitCode?: number;
  exit: (code?: number) => never;
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) => void;
  stdout: OutputStreamBridge;
  stderr: OutputStreamBridge;
  stdin: InputStreamBridge;
  arch: string;
  title: string;
  hrtime: {
    (prev?: [number, number]): [number, number];
    bigint: () => bigint;
  };
  memoryUsage: () => {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  uptime: () => number;
  cpuUsage: () => { user: number; system: number };
  resourceUsage: () => {
    userCPUTime: number; systemCPUTime: number;
    maxRSS: number; sharedMemorySize: number;
    unsharedDataSize: number; unsharedStackSize: number;
    minorPageFault: number; majorPageFault: number;
    swappedOut: number; fsRead: number; fsWrite: number;
    ipcSent: number; ipcReceived: number;
    signalsCount: number; voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
  abort: () => never;
  kill: (pid: number, signal?: string | number) => boolean;
  umask: (mask?: number) => number;
  config: {
    variables: Record<string, unknown>;
    target_defaults: Record<string, unknown>;
  };
  release: { name: string; sourceUrl: string; headersUrl: string };
  features: {
    inspector: boolean;
    debug: boolean;
    uv: boolean;
    ipv6: boolean;
    tls_alpn: boolean;
    tls_sni: boolean;
    tls_ocsp: boolean;
    tls: boolean;
  };
  debugPort: number;
  allowedNodeEnvironmentFlags: Set<string>;
  on: (evt: string, fn: EventHandler) => ProcessObject;
  once: (evt: string, fn: EventHandler) => ProcessObject;
  off: (evt: string, fn: EventHandler) => ProcessObject;
  emit: (evt: string, ...args: unknown[]) => boolean;
  addListener: (evt: string, fn: EventHandler) => ProcessObject;
  removeListener: (evt: string, fn: EventHandler) => ProcessObject;
  removeAllListeners: (evt?: string) => ProcessObject;
  listeners: (evt: string) => EventHandler[];
  listenerCount: (evt: string) => number;
  prependListener: (evt: string, fn: EventHandler) => ProcessObject;
  prependOnceListener: (evt: string, fn: EventHandler) => ProcessObject;
  eventNames: () => string[];
  setMaxListeners: (n: number) => ProcessObject;
  getMaxListeners: () => number;
  send?: (msg: unknown, cb?: (err: Error | null) => void) => boolean;
  disconnect?: () => void;
  connected?: boolean;
  _debugCwdCalls?: number;
  mainModule?: unknown;
  channel?: unknown;
  noDeprecation?: boolean;
  throwDeprecation?: boolean;
  traceDeprecation?: boolean;
  traceProcessWarnings?: boolean;
  report?: Record<string, unknown>;
  binding?: (name: string) => Record<string, unknown>;
  _linkedBinding?: (name: string) => Record<string, unknown>;
  dlopen?: (module: unknown, filename: string, flags?: number) => void;
  reallyExit?: (code?: number) => void;
  _getActiveRequests?: () => unknown[];
  _getActiveHandles?: () => unknown[];
  getActiveResourcesInfo?: () => string[];
  emitWarning?: (
    warning: string | Error,
    typeOrOptions?: string | { type?: string; code?: string; detail?: string },
    code?: string,
  ) => void;
  hasUncaughtExceptionCaptureCallback?: () => boolean;
  setUncaughtExceptionCaptureCallback?: (
    fn: ((err: Error) => void) | null,
  ) => void;
  sourceMapsEnabled?: boolean;
  setSourceMapsEnabled?: (val: boolean) => void;
  constrainedMemory?: () => number;
  availableMemory?: () => number;
}

function fabricateStream(
  isOutput: boolean,
  writeFn?: (text: string) => boolean,
): OutputStreamBridge & InputStreamBridge {
  const bus = new EventEmitter();

  // raw ANSI writes bypass the stream's write() method
  const rawWrite = (text: string) => {
    if (writeFn) writeFn(text);
  };

  // columns/rows live behind accessors so assigning them fires a 'resize' event,
  // which is what TUI libs like blessed, ink, prompts etc. listen for
  let _cols: number = DEFAULT_TERMINAL.COLUMNS;
  let _rows: number = DEFAULT_TERMINAL.ROWS;

  // stdin ref tracking. node refs the loop while stdin's read side is in
  // flowing mode. .on('data') auto-resumes, .pause() unrefs. removing a
  // data listener does NOT auto-pause in node, callers must call .pause()
  // explicitly (readline.Interface.close() does that for you). output
  // streams never hold the loop alive.
  //
  // 'readable' listeners do NOT ref the loop in node: the stream stays
  // paused until the user calls .read(). only flowing-mode listeners
  // ('data') and explicit .resume() keep us alive.
  //
  // refcount rather than a boolean so two independent subsystems (e.g. a
  // readline.Interface and a direct process.stdin.on('data') consumer)
  // don't stomp each other: a single .pause() won't release the handle
  // while another consumer still expects data.
  let _stdinHandle: Handle | null = null;
  let _stdinRefCount = 0;
  const _stdinRef = () => {
    if (isOutput) return;
    _stdinRefCount++;
    if (!_stdinHandle) _stdinHandle = getRegistry().register("TTYWrap");
  };
  const _stdinUnref = () => {
    if (isOutput) return;
    if (_stdinRefCount === 0) return;
    _stdinRefCount--;
    if (_stdinRefCount === 0 && _stdinHandle) {
      _stdinHandle.close();
      _stdinHandle = null;
    }
  };

  // buffer 'data' emits that arrive before any 'data' listener is attached.
  // real node's stdin is a Readable in paused mode, so it holds bytes in
  // its internal buffer until a consumer attaches and then flushes on
  // attach/resume. our stream is backed by a bare EventEmitter so without
  // this any pre-listener emit is silently dropped. showed up as vite's
  // ~3s gap between "ready" and bindCLIShortcuts attaching readline
  // eating every keystroke typed during the gap.
  const _pendingData: unknown[][] = [];

  const _flushPendingData = () => {
    if (isOutput || _pendingData.length === 0) return;
    // snapshot and clear sync so a handler that schedules another sendStdin
    // during replay doesn't get re-replayed here
    const pending = _pendingData.splice(0);
    // queueMicrotask so the just-added listener is definitely registered
    // (sync call sites expect .on('data', fn).something() chains to finish
    // before data fires), and it matches node's flush-on-next-tick feel
    queueMicrotask(() => {
      for (const args of pending) {
        bus.emit("data", ...(args as unknown[]));
      }
    });
  };

  const stream: OutputStreamBridge & InputStreamBridge = {
    isTTY: false,
    columns: DEFAULT_TERMINAL.COLUMNS,
    rows: DEFAULT_TERMINAL.ROWS,
    isRaw: false,
    on(evt, fn) {
      bus.on(evt, fn);
      // node auto-resumes stdin (refs loop) only for flowing mode, i.e.
      // 'data' listeners. 'readable' keeps the stream paused until the
      // user calls .read(), so we must NOT ref here.
      if (!isOutput && evt === "data") {
        _stdinRef();
        _flushPendingData();
      }
      return stream;
    },
    once(evt, fn) {
      bus.once(evt, fn);
      if (!isOutput && evt === "data") {
        _stdinRef();
        _flushPendingData();
      }
      return stream;
    },
    off(evt, fn) {
      bus.off(evt, fn);
      return stream;
    },
    emit(evt, ...args) {
      // stdin 'data' arriving with no listener: queue instead of dropping,
      // replay when a listener attaches (see _flushPendingData above)
      if (!isOutput && evt === "data" && bus.listenerCount("data") === 0) {
        _pendingData.push(args);
        // EventEmitter.emit returns true iff a listener was called, none here
        return false;
      }
      return bus.emit(evt, ...args);
    },
    addListener(evt, fn) {
      bus.addListener(evt, fn);
      if (!isOutput && evt === "data") {
        _stdinRef();
        _flushPendingData();
      }
      return stream;
    },
    removeListener(evt, fn) {
      bus.removeListener(evt, fn);
      return stream;
    },
    removeAllListeners(evt) {
      bus.removeAllListeners(evt);
      return stream;
    },
    setMaxListeners(n) {
      bus.setMaxListeners(n);
      return stream;
    },
    getMaxListeners() {
      return bus.getMaxListeners();
    },
    listenerCount(evt) {
      return bus.listenerCount(evt);
    },
    listeners(evt) {
      return bus.listeners(evt);
    },
    rawListeners(evt) {
      return bus.rawListeners(evt);
    },
    prependListener(evt, fn) {
      bus.prependListener(evt, fn);
      if (!isOutput && evt === "data") {
        _stdinRef();
        _flushPendingData();
      }
      return stream;
    },
    prependOnceListener(evt, fn) {
      bus.prependOnceListener(evt, fn);
      if (!isOutput && evt === "data") {
        _stdinRef();
        _flushPendingData();
      }
      return stream;
    },
    eventNames() {
      return bus.eventNames();
    },
    pause() {
      _stdinUnref();
      return stream;
    },
    resume() {
      _stdinRef();
      return stream;
    },
    setEncoding(_enc) {
      return stream;
    },
    write(data, _enc?, cb?) {
      if (isOutput && writeFn && data != null) {
        const text = typeof data === "string" ? data : String(data);
        writeFn(text);
      }
      if (cb) queueMicrotask(cb);
      return true;
    },
    end(data?, cb?) {
      if (isOutput && writeFn && data != null) {
        const text = typeof data === "string" ? data : String(data);
        writeFn(text);
      }
      if (cb) queueMicrotask(cb);
    },
    read() {
      return null;
    },
    destroy() {
      return stream;
    },
    pipe(dest: any) {
      const onData = (chunk: any) => {
        if (dest.write) dest.write(chunk);
      };
      bus.on("data", onData);
      // pipe attaches straight to the bus, bypassing stream.on(), so we
      // still need to flush any pre-pipe buffered input. otherwise data
      // typed before the consumer attached gets dropped.
      if (!isOutput) _flushPendingData();
      if (!(stream as any)._pipeDests) (stream as any)._pipeDests = [];
      (stream as any)._pipeDests.push({ dest, onData });
      return dest;
    },
    unpipe(dest?: any) {
      const dests: Array<{ dest: any; onData: Function }> =
        (stream as any)._pipeDests || [];
      if (dest) {
        const idx = dests.findIndex((d) => d.dest === dest);
        if (idx >= 0) {
          bus.off("data", dests[idx].onData as any);
          dests.splice(idx, 1);
        }
      } else {
        for (const d of dests) bus.off("data", d.onData as any);
        dests.length = 0;
      }
      return stream;
    },
    unshift() {},
    wrap() {
      return stream;
    },
    [Symbol.asyncIterator]() {
      return { next: async () => ({ done: true, value: undefined }) };
    },
    readable: true,
    writable: true,
    destroyed: false,
    setRawMode(flag) {
      stream.isRaw = flag;
      return stream;
    },
    clearLine(dir: number, cb?) {
      if (isOutput) {
        if (dir === -1)
          rawWrite("\x1b[1K"); // clear left of cursor
        else if (dir === 1)
          rawWrite("\x1b[0K"); // clear right of cursor
        else rawWrite("\x1b[2K"); // clear entire line
      }
      if (cb) cb();
      return true;
    },
    cursorTo(x: number, y?: number | (() => void), cb?: () => void) {
      if (typeof y === "function") {
        cb = y;
        y = undefined;
      }
      if (isOutput) {
        if (typeof y === "number") {
          rawWrite(`\x1b[${y + 1};${x + 1}H`); // move to row;col
        } else {
          rawWrite(`\x1b[${x + 1}G`); // move to column
        }
      }
      if (typeof cb === "function") cb();
      return true;
    },
    moveCursor(dx: number, dy: number, cb?) {
      if (isOutput) {
        if (dx > 0)
          rawWrite(`\x1b[${dx}C`); // move right
        else if (dx < 0) rawWrite(`\x1b[${-dx}D`); // move left
        if (dy > 0)
          rawWrite(`\x1b[${dy}B`); // move down
        else if (dy < 0) rawWrite(`\x1b[${-dy}A`); // move up
      }
      if (cb) cb();
      return true;
    },
    getWindowSize() {
      return [stream.columns, stream.rows];
    },
    getColorDepth(_env?: Record<string, string>): number {
      return 8;
    },
    hasColors(
      countOrEnv?: number | Record<string, string>,
      _env?: Record<string, string>,
    ): boolean {
      const count = typeof countOrEnv === "number" ? countOrEnv : 256;
      return 256 >= count;
    },
  };

  if (isOutput && writeFn) {
    stream.write = (data: string | Buffer, _enc?: string, cb?: () => void) => {
      const text = typeof data === "string" ? data : data.toString();
      const ok = writeFn(text);
      if (cb) queueMicrotask(cb);
      return ok;
    };
  }

  // only the output streams (stdout/stderr) fire 'resize' in real Node,
  // since stdin is a tty.ReadStream which has no columns/rows/resize.
  // we still keep columns/rows on the stdin object for back-compat with
  // anything that was already reading them, but we don't emit anything.
  if (isOutput) {
    let _silent = false;
    Object.defineProperty(stream, "columns", {
      get() { return _cols; },
      set(v: number) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n) || n === _cols) return;
        _cols = n;
        if (!_silent) bus.emit("resize");
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(stream, "rows", {
      get() { return _rows; },
      set(v: number) {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(n) || n === _rows) return;
        _rows = n;
        if (!_silent) bus.emit("resize");
      },
      enumerable: true,
      configurable: true,
    });

    // update both at once, emit 'resize' once. individual setter assignments
    // still emit as usual, this is just for the common "new size came in" case.
    (stream as any)._setSize = (cols: number, rows: number): boolean => {
      const colsChanged = Number.isFinite(cols) && cols !== _cols;
      const rowsChanged = Number.isFinite(rows) && rows !== _rows;
      if (!colsChanged && !rowsChanged) return false;
      _silent = true;
      try {
        if (colsChanged) (stream as any).columns = cols;
        if (rowsChanged) (stream as any).rows = rows;
      } finally {
        _silent = false;
      }
      bus.emit("resize");
      return true;
    };
  }

  return stream;
}

// batched size update with a single 'resize' event. used by the worker when
// a resize message arrives from main, and by any code that wants to push a
// new size to a TUI without firing two events.
export function setStreamDimensions(
  stream: { _setSize?: (c: number, r: number) => boolean } | null | undefined,
  cols: number,
  rows: number,
): boolean {
  if (!stream || typeof stream._setSize !== "function") return false;
  return stream._setSize(cols, rows);
}

export function buildProcessEnv(config?: {
  cwd?: string;
  env?: ProcessEnvVars;
  onExit?: (code: number) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  pid?: number;
  ppid?: number;
}): ProcessObject {
  let workingDir = config?.cwd || "/";
  let currentUmask = 0o022;
  const bootTime = Date.now();
  const bus = new EventEmitter();

  const envVars: ProcessEnvVars = {
    NODE_ENV: DEFAULT_ENV.NODE_ENV,
    PATH: DEFAULT_ENV.PATH,
    HOME: DEFAULT_ENV.HOME,
    SHELL: DEFAULT_ENV.SHELL,
    TERM: DEFAULT_ENV.TERM,
    COLORTERM: DEFAULT_ENV.COLORTERM,
    REQUIRES_WASM: DEFAULT_ENV.REQUIRES_WASM,
    npm_config_user_agent: DEFAULT_ENV.npm_config_user_agent,
    npm_execpath: DEFAULT_ENV.npm_execpath,
    npm_node_execpath: DEFAULT_ENV.npm_node_execpath,
    NAPI_RS_FORCE_WASM: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    ...config?.env,
  };

  const stdoutStream = fabricateStream(true, (text) => {
    if (config?.onStdout) {
      config.onStdout(text);
    } else {
      _nativeConsole.log(text);
    }
    return true;
  });

  const stderrStream = fabricateStream(true, (text) => {
    if (config?.onStderr) {
      config.onStderr(text);
    } else {
      _nativeConsole.error(text);
    }
    return true;
  });

  const stdinStream = fabricateStream(false);

  const hrtimeFn = function hrtime(prev?: [number, number]): [number, number] {
    const now = performance.now();
    const secs = Math.floor(now / 1000);
    const nanos = Math.floor((now % 1000) * 1e6);
    if (prev) {
      let ds = secs - prev[0];
      let dn = nanos - prev[1];
      if (dn < 0) {
        dn += 1e9;
        ds -= 1;
      }
      return [ds, dn];
    }
    return [secs, nanos];
  };
  hrtimeFn.bigint = (): bigint => BigInt(Math.floor(performance.now() * 1e6));

  const proc: ProcessObject = {
    env: envVars,

    cwd() {
      if (!proc._debugCwdCalls) proc._debugCwdCalls = 0;
      proc._debugCwdCalls++;
      return workingDir;
    },

    chdir(dir: string) {
      if (!dir.startsWith("/")) {
        dir = workingDir + "/" + dir;
      }
      workingDir = dir;
      if (proc._chdirHook) proc._chdirHook(dir);
    },

    platform: MOCK_OS.PLATFORM,
    arch: MOCK_OS.ARCH,
    title: MOCK_PROCESS.TITLE,
    version: VERSIONS.NODE,
    versions: { ...NODE_SUB_VERSIONS },

    argv: ["node", "/index.js"],
    argv0: "node",
    execPath: MOCK_PROCESS.EXEC_PATH,
    execArgv: [],

    pid: config?.pid ?? MOCK_PROCESS.PID,
    ppid: config?.ppid ?? MOCK_PROCESS.PPID,

    // process.exit() with no argument uses process.exitCode, process.exit(N)
    // overrides exitCode and uses N. matches node.
    exit(code?: number) {
      const resolved =
        typeof code === "number"
          ? code
          : typeof proc.exitCode === "number"
            ? proc.exitCode
            : 0;
      proc.exitCode = resolved;
      bus.emit("exit", resolved);
      if (config?.onExit) config.onExit(resolved);
      throw new ProcessExitSentinel(resolved);
    },

    nextTick(fn, ...args) {
      queueMicrotask(() => fn(...args));
    },

    stdout: stdoutStream,
    stderr: stderrStream,
    stdin: stdinStream,

    hrtime: hrtimeFn as ProcessObject["hrtime"],

    memoryUsage: Object.assign(
      function memoryUsage() {
        return {
          rss: MOCK_MEMORY.RSS,
          heapTotal: MOCK_MEMORY.HEAP_TOTAL,
          heapUsed: MOCK_MEMORY.HEAP_USED,
          external: MOCK_MEMORY.EXTERNAL,
          arrayBuffers: 0,
        };
      },
      { rss: () => MOCK_MEMORY.RSS },
    ),

    uptime() {
      return (Date.now() - bootTime) / 1000;
    },

    cpuUsage() {
      return { user: 0, system: 0 };
    },

    resourceUsage() {
      return {
        userCPUTime: 0, systemCPUTime: 0,
        maxRSS: MOCK_MEMORY.RSS / 1024,
        sharedMemorySize: 0, unsharedDataSize: 0, unsharedStackSize: 0,
        minorPageFault: 0, majorPageFault: 0,
        swappedOut: 0, fsRead: 0, fsWrite: 0,
        ipcSent: 0, ipcReceived: 0,
        signalsCount: 0, voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
      };
    },

    abort() {
      throw new Error("process.abort() called");
    },

    kill(_pid: number, _signal?: string | number) {
      // Emit the signal on this process so listeners (e.g. nodemon) can
      // react to SIGINT / SIGUSR2 etc. just like real Node.js.
      const sig = typeof _signal === "string" ? _signal : "SIGTERM";
      bus.emit(sig);
      return true;
    },

    umask(mask?: number) {
      const old = currentUmask;
      if (mask !== undefined) currentUmask = mask;
      return old;
    },

    config: { variables: {}, target_defaults: {} },
    release: { name: "node", sourceUrl: "", headersUrl: "" },
    features: {
      inspector: false,
      debug: false,
      uv: true,
      ipv6: true,
      tls_alpn: true,
      tls_sni: true,
      tls_ocsp: true,
      tls: true,
    },
    debugPort: 9229,
    allowedNodeEnvironmentFlags: new Set<string>(),
    mainModule: undefined as any,
    channel: undefined,
    noDeprecation: false,
    throwDeprecation: false,
    traceDeprecation: false,
    traceProcessWarnings: false,
    report: {
      directory: "",
      filename: "",
      getReport: () => ({}),
      reportOnFatalError: false,
      reportOnSignal: false,
      reportOnUncaughtException: false,
      signal: "SIGUSR2",
      writeReport: () => "",
    },
    binding(name: string): Record<string, unknown> {
      if (name === "natives") return {};
      if (name === "config") return { exposeInternals: false };
      if (name === "constants")
        return {
          os: {
            UV_UDP_REUSEADDR: 4,
            signals: {
              SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
              SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
              SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
              SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21,
              SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26,
              SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
            },
            errno: {},
          },
          fs: {
            O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128,
            O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024, O_NONBLOCK: 2048,
            O_DSYNC: 4096, O_SYNC: 1052672, O_DIRECT: 16384, O_DIRECTORY: 65536,
            O_NOATIME: 262144, O_NOFOLLOW: 131072, O_CLOEXEC: 524288,
            UV_FS_O_FILEMAP: 0,
            S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
            S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152,
            F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
          },
          crypto: {},
          zlib: {},
        };
      if (name === "util") return {};
      if (name === "fs") return {};
      if (name === "buffer") return {};
      if (name === "stream_wrap") return {};
      if (name === "tcp_wrap") return {};
      if (name === "pipe_wrap") return {};
      // throw for unknown bindings so callers fall back gracefully
      throw new Error(`No such module: ${name}`);
    },
    _linkedBinding(_name: string): Record<string, unknown> {
      return {};
    },
    dlopen(_module: unknown, _filename: string, _flags?: number): void {
      throw new Error("process.dlopen is not supported in browser environment");
    },
    reallyExit(_code?: number): void {},
    // libuv splits handles (long-lived: timers, sockets, servers) from
    // requests (short-lived: fs ops, fetches, imports). we map our
    // HandleType enum onto that split for introspection parity.
    _getActiveRequests(): unknown[] {
      const reqTypes = new Set<string>([
        "FSReqCallback", "FetchRequest", "DynamicImport", "WASMWork",
      ]);
      return getRegistry()
        .list()
        .filter((h) => h.refed && reqTypes.has(h.type))
        .map((h) => ({ type: h.type }));
    },
    _getActiveHandles(): unknown[] {
      const reqTypes = new Set<string>([
        "FSReqCallback", "FetchRequest", "DynamicImport", "WASMWork",
      ]);
      return getRegistry()
        .list()
        .filter((h) => h.refed && !reqTypes.has(h.type))
        .map((h) => ({ type: h.type }));
    },
    // node 17.3+: plain string[] of active resource types.
    // see lib/internal/process/per_thread.js.
    getActiveResourcesInfo(): string[] {
      return getRegistry()
        .list()
        .filter((h) => h.refed)
        .map((h) => h.type);
    },
    emitWarning(
      warning: string | Error,
      typeOrOptions?:
        | string
        | { type?: string; code?: string; detail?: string },
      code?: string,
    ): void {
      const msg = typeof warning === "string" ? warning : warning.message;
      const type =
        typeof typeOrOptions === "string"
          ? typeOrOptions
          : (typeOrOptions?.type ?? "Warning");
      bus.emit("warning", { name: type, message: msg, code });
    },
    hasUncaughtExceptionCaptureCallback(): boolean {
      return false;
    },
    setUncaughtExceptionCaptureCallback(
      _fn: ((err: Error) => void) | null,
    ): void {},
    sourceMapsEnabled: false,
    setSourceMapsEnabled(_val: boolean): void {},
    constrainedMemory(): number {
      return 0;
    },
    availableMemory(): number {
      return 512 * 1024 * 1024; // 512MB
    },

    on(evt, fn) {
      bus.on(evt, fn);
      return proc;
    },
    once(evt, fn) {
      bus.once(evt, fn);
      return proc;
    },
    off(evt, fn) {
      bus.off(evt, fn);
      return proc;
    },
    emit(evt, ...args) {
      return bus.emit(evt, ...args);
    },
    addListener(evt, fn) {
      bus.addListener(evt, fn);
      return proc;
    },
    removeListener(evt, fn) {
      bus.removeListener(evt, fn);
      return proc;
    },
    removeAllListeners(evt) {
      bus.removeAllListeners(evt);
      return proc;
    },
    listeners(evt) {
      return bus.listeners(evt);
    },
    listenerCount(evt) {
      return bus.listenerCount(evt);
    },
    prependListener(evt, fn) {
      bus.prependListener(evt, fn);
      return proc;
    },
    prependOnceListener(evt, fn) {
      bus.prependOnceListener(evt, fn);
      return proc;
    },
    eventNames() {
      return bus.eventNames();
    },
    setMaxListeners(n) {
      bus.setMaxListeners(n);
      return proc;
    },
    getMaxListeners() {
      return bus.getMaxListeners();
    },
  };

  return proc;
}

export const process = buildProcessEnv();

export default process;
