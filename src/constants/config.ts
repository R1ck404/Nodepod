// Centralized config constants. Import from here instead of hardcoding.

// ---------------------------------------------------------------------------
// Runtime version strings
// ---------------------------------------------------------------------------

export const VERSIONS = {
  NODE: "v22.12.0",
  NODE_BARE: "22.12.0",
  NPM: "10.0.0",
  PNPM: "9.15.4",
  YARN: "4.6.0",
  BUN: "1.1.38",
  BUN_V: "v1.1.38",
  GIT: "2.43.0",
} as const;

export const NODE_SUB_VERSIONS = {
  node: VERSIONS.NODE_BARE,
  v8: "11.3.244.8",
  uv: "1.44.2",
  modules: "115",
  openssl: "3.0.13",
  napi: "9",
  webcontainer: "1.0.0",
} as const;

// ---------------------------------------------------------------------------
// npm registry
// ---------------------------------------------------------------------------

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const NPM_REGISTRY_URL_SLASH = "https://registry.npmjs.org/";

// ---------------------------------------------------------------------------
// CDN (pako only -- the rest are in cdn-urls.ts)
// ---------------------------------------------------------------------------

export const PINNED_PAKO = "2.1.0";
export const CDN_PAKO = `https://esm.sh/pako@${PINNED_PAKO}`;

// ---------------------------------------------------------------------------
// Module resolution file extensions
// ---------------------------------------------------------------------------

export const RESOLVE_EXTENSIONS = [
  ".js",
  ".ts",
  ".jsx",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

export const MAIN_FIELD_EXTENSIONS = [
  ".js",
  ".ts",
  ".tsx",
  ".mts",
  ".jsx",
  ".json",
  ".mjs",
  ".cjs",
] as const;

export const INDEX_FILES = [
  "index.js",
  "index.ts",
  "index.tsx",
  "index.mjs",
  "index.cjs",
] as const;

export const IMPORTS_FIELD_EXTENSIONS = [
  ".js",
  ".ts",
  ".cjs",
  ".mjs",
  ".json",
] as const;

export const ESBUILD_LOADER_MAP: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".json": "json",
  ".css": "css",
  ".map": "json",
  ".txt": "text",
  ".wasm": "file",
};

// ---------------------------------------------------------------------------
// Mock system environment
// ---------------------------------------------------------------------------

export const MOCK_OS = {
  PLATFORM: "linux" as const,
  ARCH: "x64" as const,
  TYPE: "Linux",
  RELEASE: "5.10.0",
  VERSION: "#1 SMP",
  MACHINE: "x86_64",
  HOSTNAME: "localhost",
  HOMEDIR: "/home/user",
  TMPDIR: "/tmp",
  SHELL: "/bin/bash",
  USERNAME: "user",
  ENDIANNESS: "LE" as const,
} as const;

export const MOCK_IDS = {
  UID: 1000,
  GID: 1000,
} as const;

export const MOCK_FS = {
  BLOCK_SIZE: 4096,
  BLOCK_CALC_SIZE: 512,
} as const;

export const MOCK_CPU = {
  MODEL: "Virtual CPU",
  SPEED: 2400,
  COUNT: 2,
} as const;

export const MOCK_MEMORY = {
  TOTAL: 4 * 1024 * 1024 * 1024,
  FREE: 2 * 1024 * 1024 * 1024,
  RSS: 50 * 1024 * 1024,
  HEAP_TOTAL: 30 * 1024 * 1024,
  HEAP_USED: 20 * 1024 * 1024,
  EXTERNAL: 1 * 1024 * 1024,
} as const;

export const MOCK_LOADAVG: readonly [number, number, number] = [0.5, 0.5, 0.5];

export const DEFAULT_TERMINAL = {
  COLUMNS: 80,
  ROWS: 24,
  FONT_SIZE: 13,
} as const;

export const MOCK_PROCESS = {
  PID: 1,
  PPID: 0,
  TITLE: "node",
  EXEC_PATH: "/usr/local/bin/node",
} as const;

// ---------------------------------------------------------------------------
// Default environment variables
// ---------------------------------------------------------------------------

export const DEFAULT_ENV = {
  NODE_ENV: "development",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/",
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  REQUIRES_WASM: "true",
  npm_config_user_agent: `npm/${VERSIONS.NPM} node/${VERSIONS.NODE} linux x64 workspaces/false`,
  npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  npm_node_execpath: "/usr/local/bin/node",
} as const;

// ---------------------------------------------------------------------------
// Timeouts and limits
// ---------------------------------------------------------------------------

export const TIMEOUTS = {
  SYNC_OP: 120_000,
  WAIT_LOOP_TICK: 200,
  SW_HEARTBEAT: 20_000,
  /** cap on navigator.serviceWorker.ready so init doesn't hang forever if the
   *  SW gets stuck installing/waiting */
  SW_ACTIVATION: 10_000,
  WORKER_REAP_INTERVAL: 10_000,
  WORKER_IDLE_TIMEOUT: 30_000,
  WORKER_INIT_TIMEOUT: 30_000,
  HTTP_KEEP_ALIVE: 5000,
  HTTP_HEADERS: 60000,
  // Cold-start budget for an in-process HTTP request handler. Some Vite plugin
  // pipelines do real work the FIRST time a request arrives -- e.g. Tailwind
  // v4's @tailwindcss/vite spins up @tailwindcss/oxide-wasm32-wasi, which
  // compiles a large napi-rs WASM, instantiates emnapi's worker pool and runs
  // an initial content scan -- while rolldown is still streaming dep-
  // optimization tsfn calls into the same engine-worker thread. The combined
  // load can push the first /src/index.css response past 2 minutes (issue #54),
  // so we give it a generous ceiling. Subsequent requests hit warm caches and
  // return in milliseconds.
  HTTP_DISPATCH_SAFETY: 300000,
} as const;

export const LIMITS = {
  MAX_RESOLVE_DEPTH: 50,
  MODULE_CACHE_MAX: 2000,
  MAX_WORKERS_CAP: 4,
} as const;

// ---------------------------------------------------------------------------
// Port range for net.Server.listen(0)
// ---------------------------------------------------------------------------

export const PORT_RANGE = {
  BASE: 3000,
  RANGE: 1000,
} as const;

// ---------------------------------------------------------------------------
// CDN
// ---------------------------------------------------------------------------

export const DEFAULT_NODEPOD_CDN = "https://unpkg.com/@scelar/nodepod/dist/index.js";

// ---------------------------------------------------------------------------
// PIDs
// ---------------------------------------------------------------------------

export const MOCK_PID = {
  BASE: 1000,
  RANGE: 10000,
} as const;

// ---------------------------------------------------------------------------
// Shell constants
// ---------------------------------------------------------------------------

export const LS_BLOCK_SIZE = 512;
export const YES_REPEAT_COUNT = 100;

// ---------------------------------------------------------------------------
// WebSocket opcodes (RFC 6455)
// ---------------------------------------------------------------------------

export const WS_OPCODE = {
  TEXT: 0x01,
  BINARY: 0x02,
  CLOSE: 0x08,
  PING: 0x09,
  PONG: 0x0a,
} as const;
