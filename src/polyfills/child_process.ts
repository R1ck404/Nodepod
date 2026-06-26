// child_process polyfill -- exec, execSync, spawn, fork backed by NodepodShell.
// Integrates with IVolume directly.

import { NodepodShell } from "../shell/shell-interpreter";
import type { ShellResult, ShellContext } from "../shell/shell-types";
import { EventEmitter } from "./events";
import { Readable, Writable } from "./stream";
import { Buffer } from "./buffer";
import type { IVolume } from "../types/volume";
import { ScriptEngine } from "../script-engine";
import type { PackageManifest } from "../types/manifest";
import { resetActiveInterfaceCount } from "./readline";
import {
  getRegistry,
  isExitSentinel,
  ProcessExitSentinel,
  type Handle,
} from "../helpers/event-loop";
import { createProcessContext, getActiveContext, setActiveContext } from "../threading/process-context";
import type { ProcessContext } from "../threading/process-context";
import type { PmDeps, PkgManager } from "../shell/commands/pm-types";
import { createNpmCommand } from "../shell/commands/npm";
import { createPnpmCommand } from "../shell/commands/pnpm";
import { createYarnCommand } from "../shell/commands/yarn";
import { createBunCommand, createBunxCommand } from "../shell/commands/bun";
import { createNodeCommand, createNpxCommand } from "../shell/commands/node";
import { createGitCommand } from "../shell/commands/git";
import { format as utilFormat } from "./util";
import { VERSIONS, NPM_REGISTRY_URL_SLASH, DEFAULT_ENV, MOCK_PID } from "../constants/config";
import { closeAllServers, getAllServers } from "./http";
import { disposeAllTimers } from "./timers";
import type { SyncChannelWorker } from "../threading/sync-channel";

let _shell: NodepodShell | null = null;
let _vol: IVolume | null = null;

// grab the native setTimeout before script-engine patches it. we use this
// to yield to the host task queue without creating a tracked Handle that
// would bump the refed count.
const _nativeSetTimeout: typeof globalThis.setTimeout =
  globalThis.setTimeout.bind(globalThis);

let _syncChannel: SyncChannelWorker | null = null;
let _sabEnabled = true;

let _stdoutSink: ((text: string) => void) | null = null;
let _stderrSink: ((text: string) => void) | null = null;
let _haltSignal: AbortSignal | null = null;

let _termCols: (() => number) | null = null;
let _termRows: (() => number) | null = null;

let _rawModeChangeCb: ((isRaw: boolean) => void) | null = null;

// every executeNodeBinary adds its proc here so terminal resizes can be
// pushed to the currently-running script. cleared on exit.
const _activeProcs = new Set<{
  stdout: { _setSize?: (c: number, r: number) => boolean };
  stderr: { _setSize?: (c: number, r: number) => boolean };
}>();

// called by the worker when it gets a "resize" from the main thread.
// matches Node: only stdout and stderr fire 'resize', stdin is a ReadStream
// and doesn't have the event at all.
export function notifyTerminalResize(cols: number, rows: number): void {
  for (const p of _activeProcs) {
    p.stdout?._setSize?.(cols, rows);
    p.stderr?._setSize?.(cols, rows);
  }
}

// context-aware state accessors: check ProcessContext first, fall back to module globals

function getStdoutSink(): ((text: string) => void) | null {
  const ctx = getActiveContext();
  return ctx?.stdoutSink ?? _stdoutSink;
}

function getStderrSink(): ((text: string) => void) | null {
  const ctx = getActiveContext();
  return ctx?.stderrSink ?? _stderrSink;
}

function getHaltSignal(): AbortSignal | null {
  const ctx = getActiveContext();
  return ctx ? ctx.abortController.signal : _haltSignal;
}

function getLiveStdin(): { emit: (e: string, ...a: unknown[]) => void } | null {
  const ctx = getActiveContext();
  return ctx?.liveStdin ?? _liveStdin;
}

function getTermCols(): number {
  const ctx = getActiveContext();
  return ctx?.termCols?.() ?? _termCols?.() ?? 80;
}

function getTermRows(): number {
  const ctx = getActiveContext();
  return ctx?.termRows?.() ?? _termRows?.() ?? 24;
}

function formatThrown(e: unknown): string {
  if (e instanceof Error) {
    const prefix =
      e.constructor?.name && e.constructor.name !== "Error"
        ? `${e.constructor.name}: `
        : "";
    let msg = prefix + (e.message || e.name || "Unknown error");
    if (e.stack) msg += "\n" + e.stack;
    return msg;
  }
  if (e === null || e === undefined) return "Script threw a falsy value";
  return String(e) || "Unknown error (non-Error object thrown)";
}

export function setStreamingCallbacks(cfg: {
  onStdout?: (t: string) => void;
  onStderr?: (t: string) => void;
  signal?: AbortSignal;
  getCols?: () => number;
  getRows?: () => number;
  onRawModeChange?: (isRaw: boolean) => void;
}): void {
  _stdoutSink = cfg.onStdout ?? null;
  _stderrSink = cfg.onStderr ?? null;
  _haltSignal = cfg.signal ?? null;
  _termCols = cfg.getCols ?? null;
  _termRows = cfg.getRows ?? null;
  _rawModeChangeCb = cfg.onRawModeChange ?? null;

  // also update active ProcessContext if present
  const ctx = getActiveContext();
  if (ctx) {
    ctx.stdoutSink = cfg.onStdout ?? null;
    ctx.stderrSink = cfg.onStderr ?? null;
    if (cfg.signal) {
      cfg.signal.addEventListener("abort", () => ctx.abortController.abort(), { once: true });
    }
    ctx.termCols = cfg.getCols ?? null;
    ctx.termRows = cfg.getRows ?? null;
  }
}

export function clearStreamingCallbacks(): void {
  _stdoutSink = null;
  _stderrSink = null;
  _haltSignal = null;
  _termCols = null;
  _termRows = null;
  _rawModeChangeCb = null;

  // also clear active ProcessContext if present
  const ctx = getActiveContext();
  if (ctx) {
    ctx.stdoutSink = null;
    ctx.stderrSink = null;
    ctx.termCols = null;
    ctx.termRows = null;
  }
}

// set the SyncChannelWorker for true blocking execSync/spawnSync in worker mode
export function setSyncChannel(channel: SyncChannelWorker): void {
  _syncChannel = channel;
}

export function setSabEnabled(enabled: boolean): void {
  _sabEnabled = enabled;
}

// onStdout/onStderr fire in real-time as output arrives; promise resolves on child exit
export type SpawnChildCallback = (
  command: string,
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
    stdio?: "pipe" | "inherit";
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
) => Promise<{ pid: number; exitCode: number; stdout: string; stderr: string }>;

let _spawnChildFn: SpawnChildCallback | null = null;

export function setSpawnChildCallback(fn: SpawnChildCallback): void {
  _spawnChildFn = fn;
}

// returns ForkHandle immediately; onExit fires when the child exits
export type ForkChildCallback = (
  modulePath: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    onIPC?: (data: unknown) => void;
    onExit?: (exitCode: number) => void;
  },
) => {
  sendIPC: (data: unknown) => void;
  disconnect: () => void;
  requestId: number;
};

let _forkChildFn: ForkChildCallback | null = null;

export function setForkChildCallback(fn: ForkChildCallback): void {
  _forkChildFn = fn;
}

// IPC plumbing for when this worker IS a forked child
let _ipcSendFn: ((data: unknown) => void) | null = null;
let _ipcReceiveHandler: ((data: unknown) => void) | null = null;
// messages that arrive before the handler is wired (parent sends before child's ENB sets up the handler)
let _ipcQueue: unknown[] = [];

export function setIPCSend(fn: (data: unknown) => void): void {
  _ipcSendFn = fn;
}

export function setIPCReceiveHandler(fn: (data: unknown) => void): void {
  _ipcReceiveHandler = fn;
  // replay any messages that arrived before the handler was set
  if (_ipcQueue.length > 0) {
    const queued = _ipcQueue;
    _ipcQueue = [];
    for (const msg of queued) fn(msg);
  }
}

// called by process-worker-entry when an IPC message arrives
export function handleIPCFromParent(data: unknown): void {
  if (_ipcReceiveHandler) {
    _ipcReceiveHandler(data);
  } else {
    // handler not wired yet, queue for replay
    _ipcQueue.push(data);
  }
}

export function getShellCwd(): string {
  return _shell?.getCwd() ?? "/";
}

// called by process.chdir() so subsequent exec/spawn without explicit cwd pick up the new dir
export function setShellCwd(dir: string): void {
  if (_shell) _shell.setCwd(dir);
}

// runs command inline in the current worker via NodepodShell (NOT a child process).
// child_process.exec() spawns a new worker; shellExec() runs in THIS process.
export function shellExec(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string> },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void {
  if (!_shell) {
    callback(new Error("[Nodepod] Shell not initialized"), "", "");
    return;
  }
  _shell.exec(cmd, opts).then(
    (result) => {
      if (result.exitCode !== 0) {
        const e = new Error(`Command failed: ${cmd}`);
        (e as any).code = result.exitCode;
        callback(e, result.stdout, result.stderr);
      } else {
        callback(null, result.stdout, result.stderr);
      }
    },
    (e) => {
      callback(e instanceof Error ? e : new Error(String(e)), "", "");
    },
  );
}

let _liveStdin: { emit: (e: string, ...a: unknown[]) => void } | null = null;

// check if the live process stdin is in raw mode (library handles its own echo)
export function isStdinRaw(): boolean {
  const stdin = getLiveStdin();
  if (!stdin) return false;
  return !!(stdin as any).isRaw;
}

export function sendStdin(text: string): void {
  const stdin = getLiveStdin();
  if (!stdin) {
    return;
  }
  // emit 'data' only -- readline.emitKeypressEvents() parses data into 'keypress' events
  // automatically, matching real Node.js
  stdin.emit("data", text);
}

export function initShellExec(volume: IVolume, opts?: { cwd?: string; env?: Record<string, string> }): void {
  _vol = volume;

  _shell = new NodepodShell(volume, {
    cwd: opts?.cwd ?? "/",
    env: {
      HOME: "/home/user",
      USER: "user",
      PATH: "/usr/local/bin:/usr/bin:/bin:/node_modules/.bin",
      NODE_ENV: "development",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      npm_config_user_agent: DEFAULT_ENV.npm_config_user_agent,
      npm_execpath: DEFAULT_ENV.npm_execpath,
      npm_node_execpath: DEFAULT_ENV.npm_node_execpath,
      ...opts?.env,
    },
  });

  const pmDeps: PmDeps = {
    installPackages,
    uninstallPackages,
    listPackages,
    runScript,
    npmInitOrCreate,
    npmInfo,
    npmPack,
    npmConfig,
    npxExecute,
    executeNodeBinary,
    evalCode: (code, ctx) => evalNodeCode(code, ctx),
    printCode: (code, ctx) => printNodeCode(code, ctx),
    removeNodeModules: (cwd) => {
      const dir = `${cwd}/node_modules`.replace(/\/+/g, "/");
      if (_vol!.existsSync(dir)) removeDir(_vol!, dir);
    },
    formatErr,
    formatWarn,
    hasFile: (p) => !!_vol && _vol.existsSync(p),
    readFile: (p) => _vol!.readFileSync(p, "utf8") as string,
    writeFile: (p, data) => _vol!.writeFileSync(p, data),
  };

  _shell.registerCommand(createNodeCommand(pmDeps));
  _shell.registerCommand(createNpxCommand(pmDeps));
  _shell.registerCommand(createNpmCommand(pmDeps));
  _shell.registerCommand(createPnpmCommand(pmDeps));
  _shell.registerCommand(createYarnCommand(pmDeps));
  _shell.registerCommand(createBunCommand(pmDeps));
  _shell.registerCommand(createBunxCommand(pmDeps));
  _shell.registerCommand(createGitCommand());
}

// node -e / -p helpers (used by PmDeps)

function evalNodeCode(code: string, ctx: ShellContext): Promise<ShellResult> {
  if (!_vol) return Promise.resolve({ stdout: "", stderr: "Volume unavailable\n", exitCode: 1 });
  const evalPath = `/<eval-${Date.now()}-${Math.random().toString(36).slice(2)}>.js`;
  _vol.writeFileSync(evalPath, code);
  return executeNodeBinary(evalPath, [], ctx).finally(() => {
    try {
      if (_vol!.existsSync(evalPath)) _vol!.unlinkSync(evalPath);
    } catch {
      /* ignore */
    }
  });
}

function printNodeCode(code: string, ctx: ShellContext): Promise<ShellResult> {
  const wrapped = `const __nodepodPrintResult = (${code});\nif (typeof __nodepodPrintResult !== 'undefined') { process.stdout.write(String(__nodepodPrintResult) + '\\n'); }\n`;
  return evalNodeCode(wrapped, ctx);
}

// npm helpers

function removeDir(vol: IVolume, dir: string): void {
  for (const name of vol.readdirSync(dir)) {
    const full = `${dir}/${name}`;
    const st = vol.statSync(full);
    if (st.isDirectory()) removeDir(vol, full);
    else vol.unlinkSync(full);
  }
  vol.rmdirSync(dir);
}

function loadManifest(
  cwd: string,
): { pkg: PackageManifest } | { fail: ShellResult } {
  const p = `${cwd}/package.json`.replace(/\/+/g, "/");
  if (!_vol!.existsSync(p))
    return {
      fail: {
        stdout: "",
        stderr: formatErr("package.json not found", "npm"),
        exitCode: 1,
      },
    };
  try {
    return {
      pkg: JSON.parse(_vol!.readFileSync(p, "utf8")) as PackageManifest,
    };
  } catch {
    return {
      fail: {
        stdout: "",
        stderr: formatErr("Malformed package.json", "npm"),
        exitCode: 1,
      },
    };
  }
}

async function runScript(
  args: string[],
  ctx: ShellContext,
): Promise<ShellResult> {
  const name = args[0];
  if (!name) {
    const r = loadManifest(ctx.cwd);
    if ("fail" in r) return r.fail;
    const scripts = r.pkg.scripts ?? {};
    const keys = Object.keys(scripts);
    if (keys.length === 0) return { stdout: "", stderr: "", exitCode: 0 };
    let text = `Scripts in ${r.pkg.name ?? ""}:\n`;
    for (const k of keys) text += `  ${k}\n    ${scripts[k]}\n`;
    return { stdout: text, stderr: "", exitCode: 0 };
  }

  // extra arguments after "--" separator (npm run dev -- --webpack)
  const dashIdx = args.indexOf("--");
  const extraArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  const r = loadManifest(ctx.cwd);
  if ("fail" in r) return r.fail;
  const scripts = r.pkg.scripts ?? {};
  let cmd = scripts[name];
  if (!cmd) {
    let msg = formatErr(`Missing script: "${name}"`, "npm");
    const avail = Object.keys(scripts);
    if (avail.length) {
      msg += "\nAvailable:\n";
      for (const s of avail)
        msg += `  ${A_CYAN}${s}${A_RESET}: ${A_DIM}${scripts[s]}${A_RESET}\n`;
    }
    return { stdout: "", stderr: msg, exitCode: 1 };
  }

  // append extra args after "--" to the script command (real npm behavior)
  if (extraArgs.length > 0) {
    cmd += " " + extraArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ");
  }

  // prepend cwd's node_modules/.bin to PATH (matches real npm behavior)
  const binDir = `${ctx.cwd}/node_modules/.bin`.replace(/\/+/g, "/");
  const existingPath = ctx.env.PATH || "";
  const pathWithBin = existingPath.includes(binDir)
    ? existingPath
    : `${binDir}:${existingPath}`;

  const env: Record<string, string> = {
    ...ctx.env,
    PATH: pathWithBin,
    npm_lifecycle_event: name,
  };
  if (r.pkg.name) env.npm_package_name = r.pkg.name;
  if (r.pkg.version) env.npm_package_version = r.pkg.version;

  let allOut = "";
  let allErr = "";
  const label = `${r.pkg.name ?? ""}@${r.pkg.version ?? ""}`;

  const pre = scripts[`pre${name}`];
  if (pre) {
    const hdr = `\n> ${label} pre${name}\n> ${pre}\n\n`;
    allErr += hdr;
    if (_stderrSink) _stderrSink(hdr);
    const pr = await ctx.exec(pre, { cwd: ctx.cwd, env });
    allOut += pr.stdout;
    allErr += pr.stderr;
    if (pr.exitCode !== 0)
      return { stdout: allOut, stderr: allErr, exitCode: pr.exitCode };
  }

  const mainHdr = `\n> ${label} ${name}\n> ${cmd}\n\n`;
  allErr += mainHdr;
  if (_stderrSink) _stderrSink(mainHdr);
  const mr = await ctx.exec(cmd, { cwd: ctx.cwd, env });
  allOut += mr.stdout;
  allErr += mr.stderr;
  if (mr.exitCode !== 0)
    return { stdout: allOut, stderr: allErr, exitCode: mr.exitCode };

  const post = scripts[`post${name}`];
  if (post) {
    const hdr = `\n> ${label} post${name}\n> ${post}\n\n`;
    allErr += hdr;
    if (_stderrSink) _stderrSink(hdr);
    const po = await ctx.exec(post, { cwd: ctx.cwd, env });
    allOut += po.stdout;
    allErr += po.stderr;
    if (po.exitCode !== 0)
      return { stdout: allOut, stderr: allErr, exitCode: po.exitCode };
  }

  return { stdout: allOut, stderr: allErr, exitCode: 0 };
}

// ANSI + spinner helpers for npm install output

const A_RESET = "\x1b[0m";
const A_BOLD = "\x1b[1m";
const A_DIM = "\x1b[2m";
const A_RED = "\x1b[31m";
const A_GREEN = "\x1b[32m";
const A_YELLOW = "\x1b[33m";
const A_BLUE = "\x1b[34m";
const A_MAGENTA = "\x1b[35m";
const A_CYAN = "\x1b[36m";
const A_WHITE = "\x1b[37m";
const ERASE_LINE = "\x1b[2K";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function createSpinner(text: string, writeFn: (s: string) => void) {
  let frame = 0;
  let current = text;
  const id = setInterval(() => {
    writeFn(
      `${ERASE_LINE}\r${A_CYAN}${SPINNER_FRAMES[frame]}${A_RESET} ${current}`,
    );
    frame = (frame + 1) % SPINNER_FRAMES.length;
  }, 80);

  return {
    update(t: string) {
      current = t;
    },
    succeed(t: string) {
      clearInterval(id);
      writeFn(`${ERASE_LINE}\r${A_GREEN}✔${A_RESET} ${t}\n`);
    },
    fail(t: string) {
      clearInterval(id);
      writeFn(`${ERASE_LINE}\r${A_RED}✖${A_RESET} ${t}\n`);
    },
    stop() {
      clearInterval(id);
    },
  };
}

// per-PM accent colors
const PM_COLORS: Record<PkgManager, string> = {
  npm: A_RED,
  pnpm: A_YELLOW,
  yarn: A_BLUE,
  bun: A_WHITE,
};

function formatProgress(msg: string, pm: PkgManager = "npm"): string {
  const accent = PM_COLORS[pm];

  const resolving = msg.match(/^Resolving\s+(.+?)\.{3}$/);
  if (resolving)
    return `${A_DIM}Resolving${A_RESET} ${accent}${resolving[1]}${A_RESET}${A_DIM}...${A_RESET}`;

  const downloading = msg.match(/^Downloading\s+(\d+)\s+package/);
  if (downloading)
    return `${A_DIM}Downloading${A_RESET} ${A_YELLOW}${downloading[1]}${A_RESET} ${A_DIM}packages...${A_RESET}`;

  const fetching = msg.match(/^(?:\s*)?Fetching\s+(.+?)\.{3}$/);
  if (fetching)
    return `${A_DIM}Fetching${A_RESET} ${accent}${fetching[1]}${A_RESET}${A_DIM}...${A_RESET}`;

  const transformed = msg.match(/^(?:\s*)?Transformed\s+(\d+)\s+file/);
  if (transformed) return `${A_DIM}${msg.trim()}${A_RESET}`;

  const installed = msg.match(/^Installed\s+(\d+)/);
  if (installed) return `${A_GREEN}${msg}${A_RESET}`;

  const skipping = msg.match(/^Skipping\s+(.+?)\s+\(up to date\)$/);
  if (skipping)
    return `${A_DIM}Skipping${A_RESET} ${accent}${skipping[1]}${A_RESET} ${A_DIM}(up to date)${A_RESET}`;

  return msg;
}

function formatInstallSummary(
  totalAdded: number,
  elapsed: string,
  pm: PkgManager,
): string {
  const pkgs = `${totalAdded} package${totalAdded !== 1 ? "s" : ""}`;
  switch (pm) {
    case "npm":
      return `${A_BOLD}added ${pkgs}${A_RESET} ${A_DIM}in ${elapsed}s${A_RESET}`;
    case "pnpm":
      return `${A_BOLD}packages:${A_RESET} ${A_GREEN}+${totalAdded}${A_RESET}\n${A_DIM}Done in ${elapsed}s${A_RESET}`;
    case "yarn":
      return `${A_BOLD}${pkgs} added${A_RESET} ${A_DIM}in ${elapsed}s${A_RESET}`;
    case "bun":
      return `${A_BOLD}${pkgs} installed${A_RESET} ${A_DIM}[${elapsed}s]${A_RESET}`;
  }
}

function formatErr(msg: string, pm: PkgManager): string {
  switch (pm) {
    case "npm":
      return `${A_RED}npm ERR!${A_RESET} ${msg}\n`;
    case "pnpm":
      return `${A_RED} ERR_PNPM${A_RESET}  ${msg}\n`;
    case "yarn":
      return `${A_RED}error${A_RESET} ${msg}\n`;
    case "bun":
      return `${A_RED}error:${A_RESET} ${msg}\n`;
  }
}

function formatWarn(msg: string, pm: PkgManager): string {
  switch (pm) {
    case "npm":
      return `${A_YELLOW}npm WARN${A_RESET} ${msg}\n`;
    case "pnpm":
      return `${A_YELLOW} WARN${A_RESET}  ${msg}\n`;
    case "yarn":
      return `${A_YELLOW}warning${A_RESET} ${msg}\n`;
    case "bun":
      return `${A_YELLOW}warn:${A_RESET} ${msg}\n`;
  }
}

async function installPackages(
  args: string[],
  ctx: ShellContext,
  pm: PkgManager = "npm",
): Promise<ShellResult> {
  const { DependencyInstaller } = await import("../packages/installer");
  const installer = new DependencyInstaller(_vol!, { cwd: ctx.cwd });
  let out = "";
  const write = _stdoutSink ?? ((_s: string) => {});
  const startTime = Date.now();
  const accent = PM_COLORS[pm];

  const spinnerText =
    pm === "bun"
      ? `${A_DIM}bun install${A_RESET} ${A_DIM}${VERSIONS.BUN_V}${A_RESET}`
      : `${A_DIM}Resolving dependencies...${A_RESET}`;
  const spinner = createSpinner(spinnerText, write);

  try {
    const names = args.filter((a: string) => !a.startsWith("-"));
    const onProgress = (m: string) => {
      const colored = formatProgress(m, pm);
      out += m + "\n";
      spinner.update(colored);
    };

    const isDev = args.some(
      (a: string) =>
        a === "-D" || a === "--save-dev" || a === "--dev",
    );
    const noSave = args.some(
      (a: string) => a === "--no-save",
    );

    let registryUrl: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--registry" && args[i + 1]) {
        registryUrl = args[i + 1];
        break;
      }
      if (a.startsWith("--registry=")) {
        registryUrl = a.slice("--registry=".length);
        break;
      }
    }

    let totalAdded = 0;
    if (names.length === 0) {
      const ir = await installer.installFromManifest(undefined, {
        withDevDeps: true,
        onProgress,
        registry: registryUrl,
      });
      totalAdded = ir.newPackages.length;
    } else {
      for (const n of names) {
        const ir = await installer.install(n, undefined, {
          persist: !noSave,
          persistDev: isDev && !noSave,
          onProgress,
          registry: registryUrl,
        });
        totalAdded += ir.newPackages.length;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary = formatInstallSummary(totalAdded, elapsed, pm);
    spinner.succeed(summary);
    out += `added ${totalAdded} packages in ${elapsed}s\n`;

    return { stdout: out, stderr: "", exitCode: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    spinner.fail(`${A_RED}${msg}${A_RESET}`);
    return {
      stdout: out,
      stderr: formatErr(msg, pm),
      exitCode: 1,
    };
  }
}

async function uninstallPackages(
  args: string[],
  ctx: ShellContext,
  pm: PkgManager = "npm",
): Promise<ShellResult> {
  const names = args.filter((a) => !a.startsWith("-"));
  if (names.length === 0)
    return {
      stdout: "",
      stderr: formatErr("Must specify package to remove", pm),
      exitCode: 1,
    };

  const write = _stdoutSink ?? ((_s: string) => {});
  let out = "";
  for (const name of names) {
    const pkgDir = `${ctx.cwd}/node_modules/${name}`.replace(/\/+/g, "/");
    if (_vol!.existsSync(pkgDir)) {
      try {
        removeDir(_vol!, pkgDir);
        const msg =
          pm === "bun"
            ? `${A_DIM}-${A_RESET} ${name}`
            : pm === "pnpm"
              ? `${A_RED}-${A_RESET} ${name}`
              : `removed ${name}`;
        out += msg + "\n";
        write(msg + "\n");
      } catch (e) {
        return {
          stdout: out,
          stderr: formatErr(
            `Failed to remove ${name}: ${e instanceof Error ? e.message : String(e)}`,
            pm,
          ),
          exitCode: 1,
        };
      }
    } else {
      out += formatWarn(`${name} not installed`, pm);
    }

    const r = loadManifest(ctx.cwd);
    if (!("fail" in r)) {
      const pkg = r.pkg;
      let changed = false;
      if (pkg.dependencies?.[name]) {
        delete pkg.dependencies[name];
        changed = true;
      }
      if (pkg.devDependencies?.[name]) {
        delete pkg.devDependencies[name];
        changed = true;
      }
      if (changed) {
        const p = `${ctx.cwd}/package.json`.replace(/\/+/g, "/");
        _vol!.writeFileSync(p, JSON.stringify(pkg, null, 2));
      }
    }
  }

  return { stdout: out, stderr: "", exitCode: 0 };
}

async function listPackages(
  ctx: ShellContext,
  pm: PkgManager = "npm",
): Promise<ShellResult> {
  const { DependencyInstaller } = await import("../packages/installer");
  const installer = new DependencyInstaller(_vol!, { cwd: ctx.cwd });
  const pkgs = installer.listInstalled();
  const entries = Object.entries(pkgs);
  if (entries.length === 0)
    return { stdout: `${A_DIM}(empty)${A_RESET}\n`, stderr: "", exitCode: 0 };

  const r = loadManifest(ctx.cwd);
  const label = !("fail" in r)
    ? `${r.pkg.name ?? "project"}@${r.pkg.version ?? "0.0.0"}`
    : ctx.cwd;

  let text = "";
  switch (pm) {
    case "npm":
      text += `${label} ${ctx.cwd}\n`;
      for (let i = 0; i < entries.length; i++) {
        const [n, v] = entries[i];
        const isLast = i === entries.length - 1;
        text += `${isLast ? "└──" : "├──"} ${n}@${A_DIM}${v}${A_RESET}\n`;
      }
      break;
    case "pnpm":
      text += `${A_DIM}Legend: production dependency, optional only, dev only${A_RESET}\n\n`;
      text += `${label} ${ctx.cwd}\n\n`;
      text += `${A_BOLD}dependencies:${A_RESET}\n`;
      for (const [n, v] of entries) text += `${n} ${A_DIM}${v}${A_RESET}\n`;
      break;
    case "yarn":
      text += `${A_BOLD}${label}${A_RESET}\n`;
      for (let i = 0; i < entries.length; i++) {
        const [n, v] = entries[i];
        const isLast = i === entries.length - 1;
        text += `${isLast ? "└─" : "├─"} ${n}@${A_CYAN}${v}${A_RESET}\n`;
      }
      break;
    case "bun":
      for (const [n, v] of entries) text += `${n}@${A_DIM}${v}${A_RESET}\n`;
      text += `\n${A_DIM}${entries.length} packages installed${A_RESET}\n`;
      break;
  }
  return { stdout: text, stderr: "", exitCode: 0 };
}

async function npmInitOrCreate(
  args: string[],
  sub: string,
  ctx: ShellContext,
): Promise<ShellResult> {
  const flags = args.filter((a) => a.startsWith("-"));
  const positional = args.filter((a) => !a.startsWith("-"));

  // npm create <pkg> / npm init <pkg> → npx create-<pkg>
  if (sub === "create" || (sub === "init" && positional.length > 0)) {
    const initializer = positional[0];
    let pkgSpec: string;
    if (initializer.startsWith("@")) {
      // scoped: npm create @scope/pkg → npx @scope/create-pkg
      pkgSpec = initializer;
    } else {
      // vite@latest → create-vite@latest
      const atIdx = initializer.indexOf("@");
      if (atIdx > 0) {
        const name = initializer.slice(0, atIdx);
        const ver = initializer.slice(atIdx);
        pkgSpec = `create-${name}${ver}`;
      } else {
        pkgSpec = `create-${initializer}`;
      }
    }
    return npxExecute(["-y", pkgSpec, ...positional.slice(1), ...flags], ctx);
  }

  // plain npm init [-y] → create package.json
  const p = `${ctx.cwd}/package.json`.replace(/\/+/g, "/");
  if (_vol!.existsSync(p)) {
    return {
      stdout: "",
      stderr: formatWarn("package.json already exists", "npm"),
      exitCode: 0,
    };
  }

  const isYes = flags.includes("-y") || flags.includes("--yes");
  const name = ctx.cwd.split("/").filter(Boolean).pop() || "my-project";

  const pkg: PackageManifest = {
    name,
    version: "1.0.0",
    description: "",
    main: "index.js",
    scripts: {
      test: 'echo "Error: no test specified" && exit 1',
      start: "node index.js",
    },
    keywords: [],
    author: "",
    license: "ISC",
  };

  _vol!.writeFileSync(p, JSON.stringify(pkg, null, 2));
  const out = isYes
    ? `Wrote to ${p}\n`
    : `Wrote to ${p}\n\n${JSON.stringify(pkg, null, 2)}\n`;
  return { stdout: out, stderr: "", exitCode: 0 };
}

async function npmInfo(
  args: string[],
  ctx: ShellContext,
): Promise<ShellResult> {
  const name = args[0];
  if (!name)
    return {
      stdout: "",
      stderr: formatErr("Usage: npm info <package>", "npm"),
      exitCode: 1,
    };

  const pkgJsonPath = `/node_modules/${name}/package.json`;
  if (_vol!.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(
        _vol!.readFileSync(pkgJsonPath, "utf8"),
      ) as PackageManifest;
      let out = `${pkg.name}@${pkg.version}\n`;
      if (pkg.description) out += `${pkg.description}\n`;
      if (pkg.license) out += `license: ${pkg.license}\n`;
      if (pkg.homepage) out += `homepage: ${pkg.homepage}\n`;
      if (pkg.dependencies) {
        out += "\ndependencies:\n";
        for (const [k, v] of Object.entries(pkg.dependencies))
          out += `  ${k}: ${v}\n`;
      }
      return { stdout: out, stderr: "", exitCode: 0 };
    } catch {
      /* fallthrough */
    }
  }

  // fall back to registry
  try {
    const { RegistryClient } = await import("../packages/registry-client");
    const client = new RegistryClient();
    const meta = await client.fetchManifest(name);
    const latest = meta["dist-tags"]?.latest;
    let out = `${name}@${latest ?? "unknown"}\n`;
    if (latest && meta.versions[latest]) {
      const ver = meta.versions[latest] as unknown as Record<string, unknown>;
      if (ver.description) out += `${ver.description}\n`;
      if (ver.license) out += `license: ${ver.license}\n`;
      if (ver.homepage) out += `homepage: ${ver.homepage}\n`;
    }
    return { stdout: out, stderr: "", exitCode: 0 };
  } catch (e) {
    return {
      stdout: "",
      stderr: formatErr(`Not found: ${name}`, "npm"),
      exitCode: 1,
    };
  }
}

function npmPack(ctx: ShellContext): ShellResult {
  const r = loadManifest(ctx.cwd);
  if ("fail" in r) return r.fail;

  const notice = `${A_DIM}npm notice${A_RESET}`;
  let out = `${notice}\n`;
  out += `${notice} ${A_BOLD}package:${A_RESET} ${r.pkg.name}@${r.pkg.version}\n`;

  const files: string[] = [];
  const walk = (dir: string) => {
    try {
      for (const name of _vol!.readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const full = `${dir}/${name}`;
        const st = _vol!.statSync(full);
        if (st.isDirectory()) walk(full);
        else files.push(full);
      }
    } catch {
      /* */
    }
  };
  walk(ctx.cwd);

  for (const f of files) out += `${notice} ${f}\n`;
  out += `${notice} ${A_BOLD}total files:${A_RESET} ${files.length}\n`;
  return { stdout: out, stderr: "", exitCode: 0 };
}

function npmConfig(args: string[], ctx: ShellContext): ShellResult {
  const sub = args[0];
  if (!sub || sub === "list") {
    let out = "; nodepod project config\n";
    out += `prefix = "${ctx.cwd}"\n`;
    out += `registry = "${NPM_REGISTRY_URL_SLASH}"\n`;
    return { stdout: out, stderr: "", exitCode: 0 };
  }
  if (sub === "get") {
    const key = args[1];
    if (key === "prefix")
      return { stdout: ctx.cwd + "\n", stderr: "", exitCode: 0 };
    if (key === "registry")
      return {
        stdout: NPM_REGISTRY_URL_SLASH + "\n",
        stderr: "",
        exitCode: 0,
      };
    return { stdout: "undefined\n", stderr: "", exitCode: 0 };
  }
  if (sub === "set") {
    return {
      stdout: "",
      stderr: formatWarn("config set: not supported in nodepod", "npm"),
      exitCode: 0,
    };
  }
  return {
    stdout: "",
    stderr: formatErr(`config: unknown subcommand "${sub}"`, "npm"),
    exitCode: 1,
  };
}

// Direct node binary execution (shared by node command & npx)

export async function executeNodeBinary(
  filePath: string,
  args: string[],
  ctx: ShellContext,
  opts?: {
    isFork?: boolean;
    workerThreadsOverride?: {
      isMainThread: boolean;
      parentPort: unknown;
      workerData: unknown;
      threadId: number;
    };
  },
): Promise<ShellResult> {
  if (!_vol) return { stdout: "", stderr: "Volume unavailable\n", exitCode: 1 };

  const rawPath = filePath.startsWith("/")
    ? filePath
    : `${ctx.cwd}/${filePath}`.replace(/\/+/g, "/");

  // resolve entry file: exact path, then extensions, then directory index
  let resolved = "";
  if (_vol.existsSync(rawPath) && !_vol.statSync(rawPath).isDirectory()) {
    resolved = rawPath;
  } else {
    const exts = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"];
    for (const ext of exts) {
      if (_vol.existsSync(rawPath + ext)) { resolved = rawPath + ext; break; }
    }
    if (!resolved) {
      // try as directory with index file
      const dirPath = rawPath.endsWith("/") ? rawPath : rawPath + "/";
      for (const idx of ["index.js", "index.mjs", "index.ts", "index.cjs"]) {
        if (_vol.existsSync(dirPath + idx)) { resolved = dirPath + idx; break; }
      }
    }
  }

  if (!resolved) {
    const errMsg = `Cannot locate module '${rawPath}'\n`;
    const errSink = getStderrSink();
    if (errSink) errSink(errMsg);
    return {
      stdout: "",
      stderr: errMsg,
      exitCode: 1,
    };
  }

  let out = "";
  let err = "";
  let didExit = false;
  let code = 0;

  const pushOut = (s: string): boolean => {
    out += s;
    const sink = getStdoutSink();
    if (sink) sink(s);
    return true;
  };
  const pushErr = (s: string): boolean => {
    err += s;
    const sink = getStderrSink();
    if (sink) sink(s);
    return true;
  };

  // ScriptEngine's module wrapper overwrites globalThis.process -- save and restore
  const savedProcess = (globalThis as any).process;

  // isolate this script's HandleRegistry from the outer (vitest/host) process.
  // without this, any setTimeout the host schedules ends up in the same
  // _globalRegistry the wait loop inspects, so outer timers count as live
  // handles and we block forever waiting for a drain that won't come. still
  // inherit streaming config so stdout/stderr/resize keep working.
  const prevCtx = getActiveContext();
  const localCtx = createProcessContext({
    volume: _vol,
    cwd: ctx.cwd,
    env: ctx.env,
  });
  localCtx.stdoutSink = prevCtx?.stdoutSink ?? _stdoutSink;
  localCtx.stderrSink = prevCtx?.stderrSink ?? _stderrSink;
  localCtx.liveStdin = prevCtx?.liveStdin ?? _liveStdin;
  localCtx.termCols = prevCtx?.termCols ?? _termCols;
  localCtx.termRows = prevCtx?.termRows ?? _termRows;
  // Propagate halt/abort from parent context or module signal
  if (prevCtx && prevCtx.abortController.signal.aborted) {
    localCtx.abortController.abort();
  } else if (_haltSignal?.aborted) {
    localCtx.abortController.abort();
  } else if (_haltSignal) {
    _haltSignal.addEventListener(
      "abort",
      () => localCtx.abortController.abort(),
      { once: true },
    );
  }
  setActiveContext(localCtx);

  try {
  const sandbox = new ScriptEngine(_vol, {
    cwd: ctx.cwd,
    env: ctx.env,
    enableSharedArrayBuffer: _sabEnabled,
    onConsole: (m: string, cArgs: unknown[]) => {
      // filter out process.exit sentinel errors logged by library code
      if (cArgs.length === 1) {
        const a = cArgs[0];
        if (isExitSentinel(a)) return;
        // a library may have stringified the sentinel before logging
        // (e.g. console.error(String(err))). message format is stable
        // so matching on toString is fine. worst case we swallow a user
        // log line that happens to start with the same prefix.
        if (typeof a === "string" && a.startsWith("Error: Process exited with code")) return;
      }
      // error/warn → stderr, everything else → stdout
      const line = utilFormat(cArgs[0], ...cArgs.slice(1)) + "\n";
      m === "error" ? pushErr(line) : pushOut(line);
    },
    onStdout: pushOut,
    onStderr: pushErr,
    workerThreadsOverride: opts?.workerThreadsOverride,
  });

  const proc = sandbox.getProcess();

  // sync shell cwd when process.chdir() is called (create-next-app etc. depend on this)
  proc._chdirHook = (dir: string) => {
    if (_shell) _shell.setCwd(dir);
  };

  // resolves when proc.exit() is called. the wait loop races this against
  // drainPromise/haltPromise so an exit() from an event handler (e.g.
  // vite's `q` shortcut) wakes the loop right away instead of waiting
  // for the next handle drain.
  let exitResolve!: () => void;
  const exitPromise = new Promise<void>((r) => { exitResolve = r; });

  proc.exit = ((c = 0) => {
    // suppress exit when dev servers are active (SES/error handlers call exit(1) but we want to keep serving)
    if (getAllServers().size > 0 && c !== 0) {
      return;
    }
    if (!didExit) {
      didExit = true;
      code = c;
      proc.emit("exit", c);
      exitResolve();
    }
    // always throw to halt. matches real node process.exit() which
    // terminates immediately. TLA .catch and try/catch use isExitSentinel()
    // to detect and suppress this unwind.
    throw new ProcessExitSentinel(c);
  }) as (c?: number) => never;

  proc.argv = ["node", resolved, ...args];

  // wire IPC for forked children
  if (_ipcSendFn) {
    proc.send = ((msg: unknown, _cb?: (e: Error | null) => void): boolean => {
      if (_ipcSendFn) {
        _ipcSendFn(msg);
        if (typeof _cb === "function") _cb(null);
        return true;
      }
      return false;
    }) as any;
    proc.connected = true;
    proc.disconnect = (() => {
      proc.connected = false;
    }) as () => void;

    // incoming IPC from parent → emit on process (also replays queued messages)
    setIPCReceiveHandler((data: unknown) => {
      proc.emit("message", data);
    });
  }

  const prevLiveStdin = _liveStdin;
  // capture locally -- the module-level _haltSignal gets cleared by clearStreamingCallbacks()
  // while this ENB's wait loop may still be running
  const myHaltSignal = getHaltSignal();
  if (myHaltSignal) {
    proc.stdout.isTTY = true;
    proc.stderr.isTTY = true;
    proc.stdin.isTTY = true;
    // sync terminal dimensions for TUI libraries
    const cols = getTermCols();
    const rows = getTermRows();
    proc.stdout.columns = cols;
    proc.stdout.rows = rows;
    proc.stderr.columns = cols;
    proc.stderr.rows = rows;
    // stdin intentionally skipped -- real Node's tty.ReadStream has no
    // columns/rows/resize, TUIs watch process.stdout for dimensions
    proc.stdin.setRawMode = (flag: boolean) => {
      proc.stdin.isRaw = flag;
      // notify terminal so it switches echo mode
      if (_rawModeChangeCb) _rawModeChangeCb(flag);
      return proc.stdin;
    };
    _liveStdin = proc.stdin;
    // also update context's liveStdin
    const ctx = getActiveContext();
    if (ctx) ctx.liveStdin = proc.stdin;

    // register with the resize broadcaster so live SIGWINCH-style updates
    // reach the running script's process.stdout / stderr / stdin
    _activeProcs.add(proc as any);
  }

  // forked children keep an IPCChannel handle for the whole fork lifetime,
  // released on disconnect or exit. "IPCChannel" matches what real node
  // reports from process.getActiveResourcesInfo() for fork IPC channels.
  const isFork = !!opts?.isFork;
  let ipcHandle: Handle | null = null;
  if (isFork) {
    ipcHandle = getRegistry().register("IPCChannel");
    const origDisconnect = proc.disconnect;
    proc.disconnect = (() => {
      origDisconnect?.call(proc);
      ipcHandle?.close();
      ipcHandle = null;
    }) as () => void;
  }

  let scriptError: Error | null = null;
  let tlaSettled = false;
  // wake the loop on TLA settle so we don't have to poll
  let tlaResolve!: () => void;
  const tlaDonePromise = new Promise<void>((r) => { tlaResolve = r; });

  try {
    const tlaPromise = sandbox.runFileTLA(resolved);
    tlaPromise
      .catch((e) => {
        if (isExitSentinel(e)) {
          return;
        }
        const msg = formatThrown(e);
        pushErr(`Error: ${msg}\n`);
        if (!didExit) {
          didExit = true;
          code = 1;
        }
      })
      .finally(() => {
        tlaSettled = true;
        tlaResolve();
      });
  } catch (e) {
    if (isExitSentinel(e)) {
      // handled by didExit flag
    } else {
      const msg = formatThrown(e);
      scriptError = e instanceof Error ? e : new Error(msg);
    }
  }

  const cleanup = () => {
    if (savedProcess) (globalThis as any).process = savedProcess;
  };

  if (scriptError) {
    cleanup();
    const errMsg = scriptError.message || scriptError.name || "Unknown error";
    const errStack = scriptError.stack || "";
    const fullMsg =
      errStack && !errStack.includes(errMsg)
        ? `${errMsg}\n${errStack}`
        : errStack || errMsg;
    return { stdout: out, stderr: err + `Error: ${fullMsg}\n`, exitCode: 1 };
  }

  // process.exit() called synchronously -- bail
  if (didExit) {
    cleanup();
    return { stdout: out, stderr: err, exitCode: code };
  }

  // yield once before the first wait-loop decision. crossing a macrotask
  // boundary drains the whole microtask queue, which lets deep await chains
  // (common in create-qwik style CLIs: await a; await b; await c; finally
  // setTimeout) reach their Handle-registering point before we check
  // activeRefedCount.
  await new Promise<void>((r) => _nativeSetTimeout(r, 0));

  // node exit rule, libuv parity: the loop is alive iff TLA is pending or
  // activeRefedCount > 0. no timeouts, no output heuristics. every async
  // primitive refs its own Handle and we trust the counter.
  const registry = getRegistry();
  const shouldStayAlive = (): boolean => {
    if (!tlaSettled) return true;
    return registry.activeRefedCount() > 0;
  };

  // resolve the tentative exit code node-style: explicit process.exit(c)
  // wins, otherwise process.exitCode (user-settable), otherwise 0.
  const currentCode = (): number => {
    if (didExit) return code;
    const ec = (proc as any).exitCode;
    return typeof ec === "number" ? ec : 0;
  };

  // beforeExit state carries across fast-path and wait-loop exits. reset to
  // false whenever activeRefedCount > 0 again so each drain-to-zero cycle
  // can fire it (matches node's SpinEventLoop).
  let beforeExitEmitted = false;
  const emitBeforeExitOnce = async () => {
    if (beforeExitEmitted) return;
    beforeExitEmitted = true;
    const beforeCode = currentCode();
    // proc.emit is sync. if a handler calls process.exit() it throws the
    // sentinel, let didExit propagate and bail without emitting further.
    try {
      proc.emit("beforeExit", beforeCode);
    } catch (e) {
      if (isExitSentinel(e)) {
        return;
      }
      // other handler errors: swallow (matches node's exit-time semantics)
    }
    try {
      await registry.emitBeforeExit(beforeCode);
    } catch (e) {
      if (isExitSentinel(e)) {
        return;
      }
    }
    // full drain via a native setTimeout(0). queueMicrotask only covers
    // one microtask step, but await chains keep queueing more microtasks.
    // setTimeout(0) crosses a macrotask boundary and forces V8 to flush
    // every pending microtask before resuming us. using the NATIVE
    // setTimeout (captured before patching) means this yield doesn't
    // register a tracked Handle that would inflate the refed count.
    await new Promise<void>((r) => _nativeSetTimeout(r, 0));
  };

  // fast path: script finished synchronously with nothing scheduled.
  // still emit beforeExit; handlers may schedule more work and if they
  // do we fall through into the real wait loop below.
  if (!myHaltSignal && !shouldStayAlive()) {
    if (!didExit) await emitBeforeExitOnce();
    if (!didExit && !shouldStayAlive()) {
      const finalCode = currentCode();
      // emit 'exit' on natural drain. node fires it once, whether the
      // loop drained naturally or process.exit() was called. the exit()
      // path already emitted it from the proc.exit override.
      try { proc.emit("exit", finalCode); } catch { /* ignore */ }
      cleanup();
      return { stdout: out, stderr: err, exitCode: finalCode };
    }
    // a beforeExit handler revived the loop, fall through to the wait loop
    if (shouldStayAlive()) beforeExitEmitted = false;
  }

  // avoid duplicate output when same error fires as both 'error' and 'unhandledrejection'
  const handledErrors = new WeakSet<object>();

  const rejHandler = (ev: PromiseRejectionEvent) => {
    ev.preventDefault();
    const r = ev.reason;
    if (isExitSentinel(r)) {
      return;
    }
    // mark as handled so errHandler doesn't double-log
    if (r != null && typeof r === "object") handledErrors.add(r);
    try {
      const hasHandler = proc.listenerCount
        ? proc.listenerCount("unhandledRejection") > 0
        : false;
      proc.emit("unhandledRejection", r, ev.promise);
      if (hasHandler) return;
    } catch { /* ignore */ }
    const rejMsg = r instanceof Error
      ? `Unhandled rejection: ${r.message}\n${r.stack ?? ""}\n`
      : `Unhandled rejection: ${String(r)}\n`;
    pushErr(rejMsg);
  };
  const errHandler = (ev: ErrorEvent) => {
    ev.preventDefault();
    const e = ev.error ?? new Error(ev.message || "Unknown error");
    if (isExitSentinel(e)) {
      return;
    }
    // same error may fire on both unhandledrejection and error, dedupe.
    if (e != null && typeof e === "object" && handledErrors.has(e)) return;
    if (e != null && typeof e === "object") handledErrors.add(e);
    // webpack and friends register uncaughtException handlers for graceful recovery
    try {
      const hasUncaught = proc.listenerCount
        ? proc.listenerCount("uncaughtException") > 0
        : false;
      proc.emit("uncaughtException", e);
      if (hasUncaught) return;
    } catch { /* ignore */ }
    // if there's an unhandledRejection listener, it'll handle this, don't double-log
    try {
      const hasRej = proc.listenerCount
        ? proc.listenerCount("unhandledRejection") > 0
        : false;
      if (hasRej) return;
    } catch { /* ignore */ }
    const msg = e instanceof Error
      ? `${e.stack || e.message}\n`
      : `Uncaught: ${String(e)}\n`;
    pushErr(msg);
  };
  // browser and Worker globalThis has addEventListener, node-test doesn't.
  const hasGlobalEvents = typeof (globalThis as any).addEventListener === "function";
  if (hasGlobalEvents) {
    (globalThis as any).addEventListener("unhandledrejection", rejHandler);
    (globalThis as any).addEventListener("error", errHandler);
  }

  try {
    // resolves when Ctrl+C / signal fires
    const haltPromise = myHaltSignal
      ? new Promise<void>((r) => {
          if (myHaltSignal!.aborted) { r(); return; }
          myHaltSignal!.addEventListener("abort", () => r(), { once: true });
        })
      : null;

    // event-driven wait loop. wake sources:
    //   drainPromise: activeRefedCount transitions to 0
    //   tlaDonePromise: top-level-await settles
    //   haltPromise: Ctrl+C / SIGINT
    //   exitPromise: process.exit() from anywhere (including async handlers
    //     like vite's `q` shortcut). without this, an exit() from a handler
    //     that runs while we're awaiting drainPromise wouldn't wake us until
    //     drain happens, which might never happen if readline/stdin keep
    //     the loop alive.
    // on any wake, check if we should still be alive. if not, emit beforeExit,
    // let handlers schedule more work, re-check, exit if truly drained.

    while (!didExit && !myHaltSignal?.aborted) {
      // TLA still pending, wait for it (or drain/halt/exit).
      if (!tlaSettled) {
        const racers: Promise<unknown>[] = [
          tlaDonePromise,
          registry.drainPromise(),
          exitPromise,
        ];
        if (haltPromise) racers.push(haltPromise);
        await Promise.race(racers);
        continue;
      }

      // TLA has settled. Check live handles.
      if (registry.activeRefedCount() === 0) {
        if (!beforeExitEmitted) {
          await emitBeforeExitOnce();
          if (didExit || myHaltSignal?.aborted) break;
          if (registry.activeRefedCount() > 0) {
            // a beforeExit handler revived us, reset for the next drain
            beforeExitEmitted = false;
            continue;
          }
        }
        break;
      }

      // something is refed, wait for drain/halt/exit.
      const racers: Promise<unknown>[] = [registry.drainPromise(), exitPromise];
      if (haltPromise) racers.push(haltPromise);
      await Promise.race(racers);

      // if anything was scheduled while draining, allow beforeExit to fire
      // again on the next drain-to-zero cycle
      if (registry.activeRefedCount() > 0) beforeExitEmitted = false;
    }

    const finalCode = currentCode();
    // emit 'exit' on natural drain. process.exit() path already emitted
    // it from proc.exit, so skip if didExit is true.
    if (!didExit) {
      try { proc.emit("exit", finalCode); } catch { /* ignore */ }
    }
    return { stdout: out, stderr: err, exitCode: finalCode };
  } finally {
    cleanup();
    // defuse proc.exit so floating promises don't throw unhandled rejections
    proc.exit = (() => {}) as unknown as (c?: number) => never;
    if (hasGlobalEvents) {
      (globalThis as any).removeEventListener("unhandledrejection", rejHandler);
      (globalThis as any).removeEventListener("error", errHandler);
    }
    _liveStdin = prevLiveStdin;
    const ctxRestore = getActiveContext();
    if (ctxRestore) ctxRestore.liveStdin = prevLiveStdin;
    _activeProcs.delete(proc as any);
    closeAllServers();
    disposeAllTimers();
    getRegistry().closeAll();
    resetActiveInterfaceCount();
  }
  } finally {
    // restore outer process context. must happen AFTER the inner finally
    // has closed this script's registry and restored streaming callbacks.
    // reached from every exit path including early returns and thrown
    // errors from ScriptEngine construction.
    setActiveContext(prevCtx);
  }
}

async function npxExecute(
  params: string[],
  ctx: ShellContext,
): Promise<ShellResult> {
  if (!_vol) return { stdout: "", stderr: "Volume unavailable\n", exitCode: 1 };

  // parse npx flags
  let autoInstall = true;
  let installPkg: string | null = null;
  const filteredParams: string[] = [];
  let separatorSeen = false;

  for (let i = 0; i < params.length; i++) {
    if (separatorSeen) {
      filteredParams.push(params[i]);
      continue;
    }
    if (params[i] === "--") {
      separatorSeen = true;
      continue;
    }
    if (params[i] === "-y" || params[i] === "--yes") {
      autoInstall = true;
      continue;
    }
    if (params[i] === "-n" || params[i] === "--no") {
      autoInstall = false;
      continue;
    }
    if (
      (params[i] === "-p" || params[i] === "--package") &&
      i + 1 < params.length
    ) {
      installPkg = params[++i];
      continue;
    }
    if (params[i] === "--help" || params[i] === "-h") {
      return {
        stdout:
          `${A_BOLD}Usage:${A_RESET} npx [options] <command> [args...]\n\n` +
          `${A_BOLD}Options:${A_RESET}\n` +
          `  ${A_CYAN}-y${A_RESET}, ${A_CYAN}--yes${A_RESET}       Auto-confirm install\n` +
          `  ${A_CYAN}-n${A_RESET}, ${A_CYAN}--no${A_RESET}        Don't install if not found\n` +
          `  ${A_CYAN}-p${A_RESET}, ${A_CYAN}--package${A_RESET}   Specify package to install\n` +
          `  ${A_CYAN}--${A_RESET}              Separator for command args\n`,
        stderr: "",
        exitCode: 0,
      };
    }
    filteredParams.push(params[i]);
  }

  let pkgSpec = filteredParams[0];
  if (!pkgSpec) {
    return {
      stdout: "",
      stderr: formatErr("missing command", "npm"),
      exitCode: 1,
    };
  }

  let cmdName: string;
  let version: string | undefined;
  if (pkgSpec.startsWith("@")) {
    // scoped: @scope/name or @scope/name@version
    const rest = pkgSpec.slice(1);
    const atIdx = rest.indexOf("@");
    if (atIdx > 0 && rest.indexOf("/") < atIdx) {
      cmdName = "@" + rest.slice(0, atIdx);
      version = rest.slice(atIdx + 1);
    } else {
      cmdName = pkgSpec;
    }
  } else {
    const atIdx = pkgSpec.indexOf("@");
    if (atIdx > 0) {
      cmdName = pkgSpec.slice(0, atIdx);
      version = pkgSpec.slice(atIdx + 1);
    } else {
      cmdName = pkgSpec;
    }
  }

  // -p overrides the package to install
  const actualPkg = installPkg || pkgSpec;
  const actualPkgName = installPkg
    ? installPkg.replace(/@[^@/]+$/, "").replace(/^@/, "")
    : cmdName;

  let resolvedBin = findBinary(cmdName, _vol, ctx.cwd);

  // not found locally -- try installing
  if (!resolvedBin && autoInstall) {
    const installResult = await installPackages([actualPkg], ctx);
    if (installResult.exitCode !== 0) return installResult;
    resolvedBin = findBinary(cmdName, _vol, ctx.cwd);
  }

  if (!resolvedBin) {
    return {
      stdout: "",
      stderr: `npx: command '${cmdName}' not found\n`,
      exitCode: 1,
    };
  }

  // run directly via node handler to avoid shell re-parsing mangling arguments
  return executeNodeBinary(resolvedBin, filteredParams.slice(1), ctx);
}

function findBinary(
  name: string,
  vol: IVolume,
  cwd?: string,
): string | null {
  const cleanName = name.startsWith("@") ? name : name;
  const shortName = cleanName.includes("/")
    ? cleanName.split("/").pop()!
    : cleanName;

  // cwd-local first, then root fallback
  const searchRoots =
    cwd && cwd !== "/"
      ? [`${cwd}/node_modules`, `/node_modules`]
      : [`/node_modules`];

  for (const nmDir of searchRoots) {
    // check package.json bin field for the real JS entry point
    const pkgJsonPath = `${nmDir}/${cleanName}/package.json`;
    if (vol.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(
          vol.readFileSync(pkgJsonPath, "utf8") as string,
        ) as PackageManifest;
        if (pkg.bin) {
          if (typeof pkg.bin === "string") {
            return `${nmDir}/${cleanName}/${pkg.bin}`;
          }
          if (typeof pkg.bin === "object") {
            const binMap = pkg.bin as Record<string, string>;
            const binEntry =
              binMap[shortName] ||
              binMap[cleanName] ||
              Object.values(binMap)[0];
            if (binEntry) return `${nmDir}/${cleanName}/${binEntry}`;
          }
        }
        // fallback to main
        if (pkg.main) return `${nmDir}/${cleanName}/${pkg.main}`;
      } catch {
        /* ignore */
      }
    }

    // .bin stubs -- resolve through to the actual JS target they reference
    const binPath = `${nmDir}/.bin/${name}`;
    if (vol.existsSync(binPath)) {
      try {
        const stub = vol.readFileSync(binPath, "utf8");
        // stubs look like: node "/node_modules/pkg/index.js" "$@"
        const match = stub.match(/node\s+"([^"]+)"/);
        if (match && vol.existsSync(match[1])) return match[1];
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  encoding?: BufferEncoding | "buffer";
  timeout?: number;
  maxBuffer?: number;
  shell?: string | boolean;
}

export type RunCallback = (
  err: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

export interface SpawnConfig {
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean | string;
  stdio?: "pipe" | "inherit" | "ignore" | Array<"pipe" | "inherit" | "ignore">;
}

export function exec(
  command: string,
  optsOrCb?: RunOptions | RunCallback,
  cb?: RunCallback,
): ShellProcess {
  let options: RunOptions = {};
  let done: RunCallback | undefined;
  if (typeof optsOrCb === "function") {
    done = optsOrCb;
  } else if (optsOrCb) {
    options = optsOrCb;
    done = cb;
  }

  const child = new ShellProcess();

  if (!_shell) {
    const e = new Error("[Nodepod] exec requires shell. Call initShellExec() first.");
    setTimeout(() => {
      child.emit("error", e);
      if (done) done(e, "", "");
    }, 0);
    return child;
  }

  const cwd = options.cwd ?? getShellCwd();
  const env = (options.env as Record<string, string>) ?? undefined;

  // run inline via NodepodShell -- only fork() gets a dedicated worker
  _shell.exec(command, { cwd, env }).then(
    (result) => {
      const { stdout, stderr, exitCode } = result;
      if (stdout) child.stdout?.push(Buffer.from(stdout));
      if (stderr) child.stderr?.push(Buffer.from(stderr));
      child.stdout?.push(null);
      child.stderr?.push(null);
      child.exitCode = exitCode;
      child.emit("close", exitCode, null);
      child.emit("exit", exitCode, null);
      if (done) {
        if (exitCode !== 0) {
          const e = new Error(`Command failed: ${command}`);
          (e as any).code = exitCode;
          done(e, stdout ?? "", stderr ?? "");
        } else {
          done(null, stdout ?? "", stderr ?? "");
        }
      }
    },
    (e) => {
      child.emit("error", e instanceof Error ? e : new Error(String(e)));
      if (done) done(e instanceof Error ? e : new Error(String(e)), "", "");
    },
  );

  return child;
}

export function execSync(cmd: string, opts?: RunOptions): string | Buffer {
  const trimmed = cmd.trim();
  const encoding = opts?.encoding;

  // fast path: trivially synchronous commands (version checks, echo, pwd)
  const result = handleSyncCommand(trimmed, opts);
  if (result !== null) {
    if (encoding === "buffer") return Buffer.from(result);
    return result;
  }

  // true blocking path via Atomics.wait()
  if (!_syncChannel) {
    throw new Error(
      "[Nodepod] execSync needs SharedArrayBuffer + SyncChannel. " +
      "enable COOP/COEP headers, or drop `enableSharedArrayBuffer: false` from NodepodOptions.",
    );
  }

  const slot = _syncChannel.allocateSlot();
  const cwd = opts?.cwd ?? (globalThis as any).process?.cwd?.() ?? "/";
  const env = (opts?.env as Record<string, string>) ?? {};

  (self as any).postMessage({
    type: "spawn-sync",
    requestId: _nextSyncRequestId++,
    command: trimmed.split(/\s+/)[0],
    args: trimmed.split(/\s+/).slice(1),
    cwd,
    env,
    syncSlot: slot,
    shellCommand: trimmed,
  });

  // blocks until main thread spawns child and child completes
  const { exitCode, stdout } = _syncChannel.waitForResult(slot, 120_000);

  if (exitCode !== 0) {
    const err: any = new Error(`Command failed: ${trimmed}\n${stdout}`);
    err.status = exitCode;
    err.stderr = Buffer.from("");
    err.stdout = Buffer.from(stdout);
    err.output = [null, err.stdout, err.stderr];
    throw err;
  }

  if (encoding === "buffer") return Buffer.from(stdout);
  return stdout;
}

let _nextSyncRequestId = 1;

const KNOWN_BINS: Record<string, string> = {
  node: "/usr/local/bin/node",
  npm: "/usr/local/bin/npm",
  npx: "/usr/local/bin/npx",
  pnpm: "/usr/local/bin/pnpm",
  yarn: "/usr/local/bin/yarn",
  bun: "/usr/local/bin/bun",
  bunx: "/usr/local/bin/bunx",
  git: "/usr/bin/git",
};

function isBinaryAvailable(name: string): string | null {
  if (KNOWN_BINS[name]) return KNOWN_BINS[name];
  if (_vol) {
    const binPath = `/node_modules/.bin/${name}`;
    if (_vol.existsSync(binPath)) return binPath;
  }
  return null;
}

// throw an error matching real Node.js execSync behaviour for failed commands
function throwCommandNotFound(cmd: string): never {
  const err: any = new Error(
    `Command failed: ${cmd}\n/bin/sh: 1: ${cmd.split(/\s+/)[0]}: not found\n`,
  );
  err.status = 127;
  err.stderr = Buffer.from(`/bin/sh: 1: ${cmd.split(/\s+/)[0]}: not found\n`);
  err.stdout = Buffer.from("");
  throw err;
}

function _findGitDir(cwd: string): { gitDir: string; workDir: string } | null {
  if (!_vol) return null;
  let dir = cwd;
  while (true) {
    const gitPath = dir + "/.git";
    try { if (_vol.existsSync(gitPath)) return { gitDir: gitPath, workDir: dir }; } catch { /* */ }
    const parent = dir.substring(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  try { if (_vol.existsSync("/.git")) return { gitDir: "/.git", workDir: "/" }; } catch { /* */ }
  return null;
}

function _readHeadBranch(gitDir: string): string {
  try {
    const head = (_vol!.readFileSync(gitDir + "/HEAD", "utf8" as any) as string).trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice(16);
    return head.slice(0, 7);
  } catch { return "main"; }
}

function _resolveHeadHash(gitDir: string): string | null {
  try {
    const head = (_vol!.readFileSync(gitDir + "/HEAD", "utf8" as any) as string).trim();
    if (head.startsWith("ref: ")) {
      const refPath = gitDir + "/" + head.slice(5);
      return (_vol!.readFileSync(refPath, "utf8" as any) as string).trim();
    }
    return head;
  } catch { return null; }
}

function _readGitConfigKey(gitDir: string, key: string): string | null {
  try {
    const config = _vol!.readFileSync(gitDir + "/config", "utf8" as any) as string;
    const parts = key.split(".");
    let sectionName: string, subSection: string | null = null, propName: string;
    if (parts.length === 3) { sectionName = parts[0]; subSection = parts[1]; propName = parts[2]; }
    else if (parts.length === 2) { sectionName = parts[0]; propName = parts[1]; }
    else return null;
    const lines = config.split("\n");
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inSection = subSection
          ? trimmed === `[${sectionName} "${subSection}"]`
          : trimmed === `[${sectionName}]`;
        continue;
      }
      if (inSection) {
        const m = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
        if (m && m[1] === propName) return m[2].trim();
      }
    }
  } catch { /* */ }
  return null;
}

function handleSyncCommand(cmd: string, opts?: RunOptions): string | null {
  if (/^node\s+(--version|-v)\s*$/.test(cmd)) return VERSIONS.NODE + "\n";
  if (/^npm\s+(--version|-v)\s*$/.test(cmd)) return VERSIONS.NPM + "\n";
  if (/^pnpm\s+(--version|-v)\s*$/.test(cmd)) return VERSIONS.PNPM + "\n";
  if (/^yarn\s+(--version|-v)\s*$/.test(cmd)) return VERSIONS.YARN + "\n";
  if (/^bun\s+(--version|-v)\s*$/.test(cmd)) return VERSIONS.BUN + "\n";

  // which / command -v
  const whichMatch = cmd.match(/^(?:which|command\s+-v)\s+(\S+)\s*$/);
  if (whichMatch) {
    const binName = whichMatch[1];
    const binPath = isBinaryAvailable(binName);
    if (binPath) return binPath + "\n";
    throwCommandNotFound(cmd);
  }

  // <binary> --version / -v
  const versionMatch = cmd.match(/^(\S+)\s+(--version|-v)\s*$/);
  if (versionMatch) {
    const binName = versionMatch[1];
    if (
      binName === "node" ||
      binName === "npm" ||
      binName === "pnpm" ||
      binName === "yarn" ||
      binName === "bun"
    )
      return null; // handled above
    if (!isBinaryAvailable(binName)) throwCommandNotFound(cmd);
    // known binary but no version handler -- fall through to async
  }

  // registry queries (Next.js uses this to find npm registry)
  if (/^(?:npm|yarn|pnpm)\s+config\s+get\s+registry\s*$/.test(cmd)) {
    return NPM_REGISTRY_URL_SLASH.replace(/\/$/, "") + "\n";
  }

  const echoMatch = cmd.match(/^echo\s+["']?(.*?)["']?\s*$/);
  if (echoMatch) return echoMatch[1] + "\n";
  if (/^uname\s+-s\s*$/.test(cmd)) return "Linux\n";
  if (/^uname\s+-m\s*$/.test(cmd)) return "x86_64\n";
  if (/^uname\s+-a\s*$/.test(cmd))
    return "Linux nodepod 5.10.0 #1 SMP x86_64 GNU/Linux\n";
  // git fast-path for sync commands
  if (/^git\s+(--version|-v)\s*$/.test(cmd) || cmd === "git --version") {
    return "git version " + VERSIONS.GIT + "\n";
  }
  if (_vol) {
    const gitRevParseMatch = cmd.match(/^git\s+rev-parse\s+(.+)$/);
    if (gitRevParseMatch) {
      const gitArgs = gitRevParseMatch[1].trim();
      const cwd = opts?.cwd || "/";
      const gd = _findGitDir(cwd);
      if (gitArgs === "--show-toplevel") return gd ? gd.workDir + "\n" : "";
      if (gitArgs === "--is-inside-work-tree") return gd ? "true\n" : "false\n";
      if (gitArgs === "--git-dir") return gd ? ".git\n" : "";
      if (gitArgs === "--is-bare-repository") return "false\n";
      if (gitArgs === "--abbrev-ref HEAD" && gd) return _readHeadBranch(gd.gitDir) + "\n";
      if ((gitArgs === "HEAD" || gitArgs === "--verify HEAD") && gd) {
        const h = _resolveHeadHash(gd.gitDir);
        return h ? h + "\n" : "";
      }
      if (gitArgs === "--short HEAD" && gd) {
        const h = _resolveHeadHash(gd.gitDir);
        return h ? h.slice(0, 7) + "\n" : "";
      }
    }
    if (/^git\s+branch\s+--show-current\s*$/.test(cmd)) {
      const cwd = opts?.cwd || "/";
      const gd = _findGitDir(cwd);
      if (gd) return _readHeadBranch(gd.gitDir) + "\n";
    }
    const gitConfigGetMatch = cmd.match(/^git\s+config\s+(?:--get\s+)?(\S+)\s*$/);
    if (gitConfigGetMatch) {
      const cwd = opts?.cwd || "/";
      const gd = _findGitDir(cwd);
      if (gd) {
        const val = _readGitConfigKey(gd.gitDir, gitConfigGetMatch[1]);
        return val !== null ? val + "\n" : "";
      }
      return "";
    }
  }
  // catch-all for git
  if (/^git\s/.test(cmd)) return "";
  if (cmd === "true" || cmd === ":") return "";
  if (cmd === "pwd") return (opts?.cwd || "/") + "\n";
  if (cmd.startsWith("cat ") && _vol) {
    const path = cmd.slice(4).trim().replace(/['"]/g, "");
    try {
      return _vol.readFileSync(path, "utf8" as any);
    } catch {
      return "";
    }
  }
  if ((cmd === "ls" || cmd.startsWith("ls ")) && _vol) {
    const dir =
      cmd === "ls"
        ? opts?.cwd || "/"
        : cmd.slice(3).trim().replace(/['"]/g, "");
    try {
      return _vol.readdirSync(dir).join("\n") + "\n";
    } catch {
      return "";
    }
  }
  const testMatch = cmd.match(
    /^(?:test|\[)\s+(-[fd])\s+["']?(.*?)["']?\s*\]?\s*$/,
  );
  if (testMatch && _vol) {
    const flag = testMatch[1];
    const path = testMatch[2];
    try {
      const st = _vol.statSync(path);
      if (flag === "-f" && st.isFile()) return "";
      if (flag === "-d" && st.isDirectory()) return "";
    } catch {
      /* */
    }
    return "";
  }
  return null;
}

// stdio normalizer. accepts:
//   'pipe'|'inherit'|'ignore'     expanded to [same, same, same]
//   ['pipe','inherit','ignore']   kept as-is, padded to 3
//   undefined                     'pipe' (node's default for spawn)
function normalizeStdio(
  stdio: SpawnConfig["stdio"] | undefined,
): ["pipe" | "inherit" | "ignore", "pipe" | "inherit" | "ignore", "pipe" | "inherit" | "ignore"] {
  const norm = (v: unknown): "pipe" | "inherit" | "ignore" => {
    if (v === "inherit" || v === "ignore" || v === "pipe") return v;
    // streams, fds, null/undefined: treat as pipe
    return "pipe";
  };
  if (stdio == null) return ["pipe", "pipe", "pipe"];
  if (typeof stdio === "string") {
    const v = norm(stdio);
    return [v, v, v];
  }
  if (Array.isArray(stdio)) {
    return [norm(stdio[0]), norm(stdio[1]), norm(stdio[2])];
  }
  return ["pipe", "pipe", "pipe"];
}

export function spawn(
  command: string,
  argsOrOpts?: string[] | SpawnConfig,
  opts?: SpawnConfig,
): ShellProcess {
  let spawnArgs: string[] = [];
  let cfg: SpawnConfig = {};
  if (Array.isArray(argsOrOpts)) {
    spawnArgs = argsOrOpts;
    cfg = opts ?? {};
  } else if (argsOrOpts) cfg = argsOrOpts;

  const child = new ShellProcess();
  // normalize stdio, node parity: 'pipe' default, 'inherit' to share parent
  // streams, 'ignore' to drop. current spawn protocol only carries one
  // top-level "pipe"|"inherit" so we pass "inherit" when stdin is inherit,
  // else "pipe". stdout/stderr inherit works anyway because the streaming
  // onStdout/onStderr callbacks route through getStdoutSink/getStderrSink.
  const stdioArr = normalizeStdio(cfg.stdio);
  const stdinInherit = stdioArr[0] === "inherit";
  const stdoutInherit = stdioArr[1] === "inherit";
  const stderrInherit = stdioArr[2] === "inherit";

  // spawn gets a dedicated worker (streaming output, long-lived). exec runs
  // inline since it collects all output at the end.
  if (_spawnChildFn) {
    const cwd = cfg.cwd ?? getShellCwd();
    const env = (cfg.env as Record<string, string>) ?? {};
    const fullCmd = spawnArgs.length ? `${command} ${spawnArgs.join(" ")}` : command;

    // keep parent alive while child is running. stash the Handle on the
    // ShellProcess so its .ref()/.unref() can forward to it.
    const childHandle = getRegistry().register("ChildProcess");
    (child as any)._elHandle = childHandle;

    // builtins like ls don't stream, so track whether callbacks actually fired
    let stdoutStreamed = false;
    let stderrStreamed = false;

    _spawnChildFn(command, spawnArgs, {
      cwd,
      env,
      stdio: stdinInherit ? "inherit" : "pipe",
      onStdout: (data: string) => {
        stdoutStreamed = true;
        // pipe: buffer for parent to read via child.stdout.on('data')
        // ignore: drop entirely
        if (stdioArr[1] === "pipe") child.stdout?.push(Buffer.from(data));
        // inherit: also route through parent's stdout sink (terminal).
        // we always route to the terminal sink for compatibility, this is
        // what pre-stdio-normalization behavior did.
        if (stdoutInherit) {
          const sink = getStdoutSink();
          if (sink) sink(data);
        }
      },
      onStderr: (data: string) => {
        stderrStreamed = true;
        if (stdioArr[2] === "pipe") child.stderr?.push(Buffer.from(data));
        if (stderrInherit) {
          const sink = getStderrSink();
          if (sink) sink(data);
        }
      },
    }).then(({ exitCode, stdout, stderr }) => {
      childHandle.close();
      // For commands that don't stream (builtins), push the buffered output
      if (!stdoutStreamed && stdout) child.stdout?.push(Buffer.from(stdout));
      if (!stderrStreamed && stderr) child.stderr?.push(Buffer.from(stderr));
      child.stdout?.push(null);
      child.stderr?.push(null);
      child.exitCode = exitCode;
      child.emit("close", exitCode, null);
      child.emit("exit", exitCode, null);
    }).catch((e) => {
      childHandle.close();
      child.emit("error", e instanceof Error ? e : new Error(String(e)));
    });
  } else if (_shell) {
    // fallback: inline execution (no streaming)
    const cwd = cfg.cwd ?? getShellCwd();
    const env = (cfg.env as Record<string, string>) ?? undefined;
    const fullCmd = spawnArgs.length
      ? `${command} ${spawnArgs.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}`
      : command;

    _shell.exec(fullCmd, { cwd, env }).then(
      (result) => {
        const { stdout, stderr, exitCode } = result;
        if (stdout) child.stdout?.push(Buffer.from(stdout));
        if (stderr) child.stderr?.push(Buffer.from(stderr));
        child.stdout?.push(null);
        child.stderr?.push(null);
        child.exitCode = exitCode;
        child.emit("close", exitCode, null);
        child.emit("exit", exitCode, null);
      },
      (e) => {
        child.emit("error", e instanceof Error ? e : new Error(String(e)));
      },
    );
  } else {
    setTimeout(() => {
      child.emit("error", new Error("[Nodepod] spawn requires shell or worker mode."));
    }, 0);
  }

  // real Node emits this on next tick so listeners can attach first
  queueMicrotask(() => child.emit("spawn"));

  return child;
}

export function spawnSync(
  cmd: string,
  args?: string[] | SpawnConfig,
  opts?: SpawnConfig,
): {
  stdout: Buffer;
  stderr: Buffer;
  status: number;
  signal: null;
  pid: number;
  output: [null, Buffer, Buffer];
  error?: Error;
} {
  let spawnArgs: string[] = [];
  let cfg: SpawnConfig = {};
  if (Array.isArray(args)) {
    spawnArgs = args;
    cfg = opts ?? {};
  } else if (args) {
    cfg = args;
  }

  const full = spawnArgs.length ? `${cmd} ${spawnArgs.join(" ")}` : cmd;
  const syncResult = handleSyncCommand(full, { cwd: cfg.cwd, env: cfg.env });

  if (syncResult !== null) {
    const stdout = Buffer.from(syncResult);
    const stderr = Buffer.from("");
    return {
      stdout,
      stderr,
      status: 0,
      signal: null,
      pid: MOCK_PID.BASE + Math.floor(Math.random() * MOCK_PID.RANGE),
      output: [null, stdout, stderr],
    };
  }

  // true blocking path via Atomics.wait()
  if (!_syncChannel) {
    throw new Error(
      "[Nodepod] spawnSync needs SharedArrayBuffer + SyncChannel. " +
      "enable COOP/COEP headers, or drop `enableSharedArrayBuffer: false` from NodepodOptions.",
    );
  }

  const slot = _syncChannel.allocateSlot();
  const cwd = cfg.cwd ?? (globalThis as any).process?.cwd?.() ?? "/";
  const env = (cfg.env as Record<string, string>) ?? {};
  // carry stdio to the main thread so it knows whether terminal stdin should
  // be forwarded to the child (inherit) vs ignored (pipe). see the spawn-sync
  // handler in process-manager.ts.
  const stdioArr = normalizeStdio(cfg.stdio);

  (self as any).postMessage({
    type: "spawn-sync",
    requestId: _nextSyncRequestId++,
    command: full.split(/\s+/)[0],
    args: full.split(/\s+/).slice(1),
    cwd,
    env,
    syncSlot: slot,
    shellCommand: full,
    stdio: stdioArr,
  });

  // blocks until main thread spawns child and child completes
  try {
    const { exitCode, stdout: stdoutStr } = _syncChannel.waitForResult(slot, 120_000);
    const stdout = Buffer.from(stdoutStr);
    const stderr = Buffer.from("");
    return {
      stdout,
      stderr,
      status: exitCode,
      signal: null,
      pid: MOCK_PID.BASE + Math.floor(Math.random() * MOCK_PID.RANGE),
      output: [null, stdout, stderr],
    };
  } catch (e: any) {
    const stdout = Buffer.from(e?.stdout ?? "");
    const stderr = Buffer.from(e?.message ?? "");
    return {
      stdout,
      stderr,
      status: e?.status ?? 1,
      signal: null,
      pid: MOCK_PID.BASE + Math.floor(Math.random() * MOCK_PID.RANGE),
      output: [null, stdout, stderr],
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

export function execFileSync(
  file: string,
  args?: string[],
  opts?: RunOptions,
): string | Buffer {
  const cmd = args?.length ? `${file} ${args.join(" ")}` : file;
  return execSync(cmd, opts);
}

export function execFile(
  file: string,
  argsOrOpts?: string[] | RunOptions | RunCallback,
  optsOrCb?: RunOptions | RunCallback,
  cb?: RunCallback,
): ShellProcess {
  let fileArgs: string[] = [];
  let options: RunOptions = {};
  let done: RunCallback | undefined;

  if (Array.isArray(argsOrOpts)) {
    fileArgs = argsOrOpts;
    if (typeof optsOrCb === "function") done = optsOrCb;
    else if (optsOrCb) {
      options = optsOrCb;
      done = cb;
    }
  } else if (typeof argsOrOpts === "function") {
    done = argsOrOpts;
  } else if (argsOrOpts) {
    options = argsOrOpts;
    done = optsOrCb as RunCallback;
  }

  const cmd = fileArgs.length ? `${file} ${fileArgs.join(" ")}` : file;
  return exec(cmd, options, done);
}

export function fork(
  modulePath: string,
  argsOrOpts?: string[] | Record<string, unknown>,
  opts?: Record<string, unknown>,
): ShellProcess {
  let args: string[] = [];
  let cfg: Record<string, unknown> = {};
  if (Array.isArray(argsOrOpts)) {
    args = argsOrOpts;
    cfg = opts ?? {};
  } else if (argsOrOpts) cfg = argsOrOpts;

  const cwd = (cfg.cwd as string) || getShellCwd();
  const env = (cfg.env as Record<string, string>) ||
    (_shell?.getEnv() ?? {});

  const resolved = modulePath.startsWith("/")
    ? modulePath
    : `${cwd}/${modulePath}`.replace(/\/+/g, "/");

  const child = new ShellProcess();
  child.connected = true;
  child.spawnargs = ["node", resolved, ...args];
  child.spawnfile = "node";

  if (!_forkChildFn) {
    setTimeout(() => {
      child.emit("error", new Error("[Nodepod] fork requires worker mode. No forkChild callback set."));
    }, 0);
    return child;
  }

  // keep parent alive while the forked child runs. stash on ShellProcess
  // so .ref()/.unref() forward to it.
  const childHandle = getRegistry().register("ChildProcess");
  (child as any)._elHandle = childHandle;
  const handle = _forkChildFn(resolved, args, {
    cwd,
    env,
    onStdout: (data: string) => {
      child.stdout?.emit("data", data);
      // also route through parent's stdout sink (fork inherits stdio by default)
      const sink = getStdoutSink();
      if (sink) sink(data);
    },
    onStderr: (data: string) => {
      child.stderr?.emit("data", data);
      const sink = getStderrSink();
      if (sink) sink(data);
    },
    onIPC: (data: unknown) => {
      child.emit("message", data);
    },
    onExit: (exitCode: number) => {
      childHandle.close();
      child.exitCode = exitCode;
      child.connected = false;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
    },
  });

  // parent→child IPC
  child.send = (msg: unknown, _cb?: (e: Error | null) => void): boolean => {
    if (!child.connected) return false;
    handle.sendIPC(msg);
    return true;
  };

  child.kill = (sig?: string): boolean => {
    child.killed = true;
    child.connected = false;
    handle.disconnect();
    child.emit("exit", null, sig ?? "SIGTERM");
    child.emit("close", null, sig ?? "SIGTERM");
    return true;
  };

  child.disconnect = (): void => {
    child.connected = false;
    handle.disconnect();
    child.emit("disconnect");
  };

  return child;
}

export interface ShellProcess extends EventEmitter {
  pid: number;
  connected: boolean;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  spawnargs: string[];
  spawnfile: string;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(sig?: string): boolean;
  disconnect(): void;
  send(msg: unknown, cb?: (e: Error | null) => void): boolean;
  ref(): this;
  unref(): this;
}

interface ShellProcessConstructor {
  new (): ShellProcess;
  (this: any): void;
  prototype: any;
}

export const ShellProcess = function ShellProcess(this: any) {
  if (!this) return;
  EventEmitter.call(this);
  this.pid = MOCK_PID.BASE + Math.floor(Math.random() * MOCK_PID.RANGE);
  this.connected = false;
  this.killed = false;
  this.exitCode = null;
  this.signalCode = null;
  this.spawnargs = [];
  this.spawnfile = "";
  this.stdin = new Writable();
  this.stdout = new Readable();
  this.stderr = new Readable();
} as unknown as ShellProcessConstructor;

Object.setPrototypeOf(ShellProcess.prototype, EventEmitter.prototype);

ShellProcess.prototype.kill = function kill(this: any, sig?: string): boolean {
  this.killed = true;
  this.emit("exit", null, sig ?? "SIGTERM");
  return true;
};

ShellProcess.prototype.disconnect = function disconnect(this: any): void {
  this.connected = false;
};

ShellProcess.prototype.send = function send(this: any, msg: unknown, cb?: (e: Error | null) => void): boolean {
  if (cb) cb(new Error("IPC unavailable"));
  return false;
};

ShellProcess.prototype.ref = function ref(this: any): any {
  const h = this._elHandle as Handle | undefined;
  if (h) h.ref();
  return this;
};

ShellProcess.prototype.unref = function unref(this: any): any {
  const h = this._elHandle as Handle | undefined;
  if (h) h.unref();
  return this;
};

export default {
  exec,
  execSync,
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  fork,
  ShellProcess,
  initShellExec,
  shellExec,
  setStreamingCallbacks,
  clearStreamingCallbacks,
  sendStdin,
  setSyncChannel,
  setSabEnabled,
  setSpawnChildCallback,
  setForkChildCallback,
  setIPCSend,
  setIPCReceiveHandler,
  handleIPCFromParent,
  executeNodeBinary,
  notifyTerminalResize,
};
