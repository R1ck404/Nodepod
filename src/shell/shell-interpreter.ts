// Shell interpreter: pipes, &&/||/;, redirections, variable expansion,
// globbing, command substitution, builtins, and registered commands.

import type {
  ShellResult,
  ShellContext,
  ShellCommand,
  ListNode,
  PipelineNode,
  CommandNode,
  BuiltinFn,
} from "./shell-types";
import type { MemoryVolume } from "../memory-volume";
import { parse, expandGlob } from "./shell-parser";
import { builtins } from "./shell-builtins";
import type { ShellOptions, ResolvedShellOptions } from "./shell-options";
import { resolveShellOptions, ShellLimitError } from "./shell-options";
import {
  parseBash,
  type BashList,
  type BashAndOr,
  type BashPipeline,
  type BashCommand,
  type BashSimpleCommand,
  type BashRedirect,
  type BashCaseCommand,
  type BashConditionalCommand,
  type BashArithmeticCommand,
  type BashSelectCommand,
  type BashCoprocCommand,
} from "./bash-parser";
import { expandHereDocument, expandWords, expandWord } from "./bash-expansion";
import type { BashExpansionContext } from "./bash-expansion";
import type { ShellResult as StreamShellResult } from "./shell-types";
import {
  isStreamableCommand,
  runStreamCommand,
  canonicalVirtualCommandName,
} from "./shell-stream-commands";
import { ShellCancellation, ShellPipe, streamToString } from "./shell-stream";
import { yieldToEventLoop } from "./shell-helpers";

type ShellControl = { kind: "break" | "continue" | "return"; code?: number; stdout?: string; stderr?: string };

/* ------------------------------------------------------------------ */
/*  NodepodShell                                                        */
/* ------------------------------------------------------------------ */

// In a worker, the shell can't spawn new workers directly.
// This callback sends a spawn request to the main thread's ProcessManager.
export type SpawnChildCallback = (
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string>; stdio?: "pipe" | "inherit" },
) => Promise<{ pid: number; exitCode: number; stdout: string; stderr: string }>;

export class NodepodShell {
  private volume: MemoryVolume;
  private cwd: string;
  private env: Record<string, string>;
  private commands = new Map<string, ShellCommand>();
  private lastExit = 0;
  private aliases = new Map<string, string>();
  private history: string[] = [];
  // serializes concurrent exec() calls to prevent cwd save/restore races
  private _execQueue: Promise<ShellResult> = Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

  private _spawnChild: SpawnChildCallback | null = null;
  private shellOptions: ResolvedShellOptions;
  private pipefail = false;
  private errexit = false;
  private nounset = false;
  private globEnabled = true;
  private nullglob = false;
  private dotglob = false;
  private positional: string[] = [];
  private shellName = "nodepod";
  private recursionDepth = 0;
  private lastBackgroundPid = 0;
  private pipeStatuses: number[] = [];
  private functions = new Map<string, BashCommand>();
  private jobs = new Map<number, {
    id: number;
    command: string;
    state: "running" | "done" | "failed" | "stopped";
    promise: Promise<ShellResult>;
    shell: NodepodShell;
    cancellation: ShellCancellation;
    result?: ShellResult;
  }>();
  private detachedJobs = new Set<Promise<ShellResult>>();
  private nextJobId = 1;
  private activeSignal: AbortSignal | null = null;
  private backgroundStdout: ((text: string) => void) | null = null;
  private backgroundStderr: ((text: string) => void) | null = null;
  private commandSubstitutionDepth = 0;
  private arithmeticDepth = 0;
  private lastCommandSubstitutionExit = 0;
  private processSubstitutionCounter = 0;
  private processSubstitutionScopes: string[][] = [];
  private directoryStack: string[] = [];
  private traps = new Map<string, string>();
  private readonlyNames = new Set<string>();
  private localScopes: Array<Map<string, string | undefined>> = [];
  private signalCleanup: (() => void) | null = null;

  constructor(
    volume: MemoryVolume,
    opts?: { cwd?: string; env?: Record<string, string>; shell?: ShellOptions },
  ) {
    this.volume = volume;
    this.cwd = opts?.cwd ?? "/";
    this.env = opts?.env ? { ...opts.env } : {};
    this.env.PWD = this.cwd;
    this.shellOptions = resolveShellOptions(opts?.shell);
    this.installVirtualOs();
    this.loadHistory();
  }

  registerCommand(cmd: ShellCommand): void {
    this.commands.set(cmd.name, cmd);
  }

  setSpawnChildCallback(cb: SpawnChildCallback | null): void {
    this._spawnChild = cb;
  }

  getSpawnChildCallback(): SpawnChildCallback | null {
    return this._spawnChild;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.env.PWD = cwd;
  }

  getEnv(): Record<string, string> {
    return this.env;
  }

  setCancellationSignal(signal: AbortSignal | null): void {
    this.signalCleanup?.();
    this.signalCleanup = null;
    this.activeSignal = signal;
    if (signal) {
      const onAbort = () => {
        const trap = this.traps.get("INT") ?? this.traps.get("SIGINT") ?? this.traps.get("TERM") ?? this.traps.get("SIGTERM");
        if (!trap) return;
        const previousSignal = this.activeSignal;
        this.activeSignal = null;
        void this.exec(trap).finally(() => { this.activeSignal = previousSignal; });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.signalCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  setBackgroundOutputCallbacks(
    onStdout: ((text: string) => void) | null,
    onStderr: ((text: string) => void) | null,
  ): void {
    this.backgroundStdout = onStdout;
    this.backgroundStderr = onStderr;
  }

  async exec(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ShellResult> {
    // Utilities such as `timeout` need a cancellable child execution without
    // mutating this shell's active signal or shared cwd/environment state.
    if (opts?.signal && opts.signal !== this.activeSignal) {
      const child = this.createExecutionClone();
      child.setCancellationSignal(opts.signal);
      return child.exec(command, { cwd: opts.cwd, env: opts.env });
    }
    // serialize cwd/env-overriding calls to prevent save/restore races
    if (opts?.cwd || opts?.env) {
      const prev = this._execQueue;
      let resolve!: (r: ShellResult) => void;
      this._execQueue = new Promise<ShellResult>((r) => { resolve = r; });
      await prev.catch(() => {});
      try {
        const r = await this.execWithDeadline(command, opts);
        resolve(r);
        return r;
      } catch (e) {
        const err: ShellResult = {
          stdout: "",
          stderr: `shell: ${e instanceof Error ? e.message : String(e)}\n`,
          exitCode: 1,
        };
        resolve(err);
        return err;
      }
    }
    return this.execWithDeadline(command, opts);
  }

  private async execWithDeadline(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ShellResult> {
    const timeoutMs = this.shellOptions.limits.commandTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return this._execInner(command, opts);
    const controller = new AbortController();
    const previousSignal = this.activeSignal;
    const forwardAbort = () => controller.abort(previousSignal?.reason);
    previousSignal?.addEventListener("abort", forwardAbort, { once: true });
    this.setCancellationSignal(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const task = this._execInner(command, opts);
      const deadline = new Promise<ShellResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error("shell: command timed out"));
          resolve({ stdout: "", stderr: `shell: command timed out after ${timeoutMs}ms\n`, exitCode: 124 });
        }, timeoutMs);
      });
      return await Promise.race([task, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      previousSignal?.removeEventListener("abort", forwardAbort);
      this.setCancellationSignal(previousSignal);
    }
  }

  private async _execInner(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
  ): Promise<ShellResult> {
    const prevCwd = this.cwd;
    const prevEnv = { ...this.env };
    const temporaryPaths: string[] = [];
    this.processSubstitutionScopes.push(temporaryPaths);

    if (opts?.cwd) {
      this.cwd = opts.cwd;
      this.env.PWD = opts.cwd;
    }
    if (opts?.env) {
      Object.assign(this.env, opts.env);
    }

    try {
      if (command.length > this.shellOptions.limits.maxExpansionBytes) {
        throw new ShellLimitError(
          "maxExpansionBytes",
          `shell: command exceeds ${this.shellOptions.limits.maxExpansionBytes} characters`,
        );
      }
      const trimmed = command.trim();
      if (trimmed && !opts?.cwd && !opts?.env) {
        this.recordHistory(trimmed);
      }

      const ast = parseBash(command, this.shellOptions.limits.maxRecursionDepth);
      const result = await this.execBashList(ast);
      this.assertEnvironmentState();
      const outputBytes = new TextEncoder().encode(result.stdout).byteLength;
      const errorBytes = new TextEncoder().encode(result.stderr).byteLength;
      if (outputBytes + errorBytes > this.shellOptions.limits.maxOutputBytes) {
        return {
          stdout: "",
          stderr: `shell: output exceeds ${this.shellOptions.limits.maxOutputBytes} bytes\n`,
          exitCode: 1,
        };
      }
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof ShellLimitError) {
        this.cwd = prevCwd;
        this.env = prevEnv;
      }
      return {
        stdout: "",
        stderr: `${message.startsWith("shell:") ? message : `shell: ${message}`}\n`,
        exitCode: 1,
      };
    } finally {
      this.processSubstitutionScopes.pop();
      for (const path of temporaryPaths) {
        try { this.volume.unlinkSync(path); } catch { /* already consumed or unavailable */ }
      }
      // only restore cwd if cd didn't change it
      if (opts?.cwd && this.cwd === opts.cwd) {
        this.cwd = prevCwd;
        this.env.PWD = prevCwd;
      }
      if (opts?.env) {
        for (const key of Object.keys(opts.env)) {
          if (key in prevEnv) {
            this.env[key] = prevEnv[key];
          } else {
            delete this.env[key];
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  AST execution                                                    */
  /* ---------------------------------------------------------------- */

  private async execList(list: ListNode): Promise<ShellResult> {
    let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };

    for (let i = 0; i < list.entries.length; i++) {
      const entry = list.entries[i];
      const pipeResult = await this.execPipeline(entry.pipeline);

      result = {
        stdout: result.stdout + pipeResult.stdout,
        stderr: result.stderr + pipeResult.stderr,
        exitCode: pipeResult.exitCode,
      };
      this.assertCollectedOutput(result.stdout, result.stderr);
      this.lastExit = pipeResult.exitCode;

      if (entry.next === "&&" && pipeResult.exitCode !== 0) break;
      if (entry.next === "||" && pipeResult.exitCode === 0) break;
    }

    return result;
  }

  private async execPipeline(pipeline: PipelineNode): Promise<ShellResult> {
    if (pipeline.commands.length === 1) {
      return this.execCommand(pipeline.commands[0]);
    }

    let stdin: string | undefined;
    let lastResult: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
    let allStderr = "";

    for (const cmd of pipeline.commands) {
      const result = await this.execCommand(cmd, stdin);
      allStderr += result.stderr;
      this.assertCollectedOutput(result.stdout, allStderr);
      stdin = result.stdout;
      lastResult = result;
    }

    return {
      stdout: lastResult.stdout,
      stderr: allStderr,
      exitCode: lastResult.exitCode,
    };
  }

  private async execCommand(
    cmd: CommandNode,
    stdin?: string,
  ): Promise<ShellResult> {
    if (this.activeSignal?.aborted) {
      return { stdout: "", stderr: "", exitCode: 130 };
    }
    if (cmd.args.length === 0) {
      for (const [k, v] of Object.entries(cmd.assignments)) {
        this.env[k] = v;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    // Bash expansion is performed by execBashCommand before this legacy
    // dispatch path. Keeping this method expansion-free prevents quoted globs
    // from being expanded a second time.
    let expandedArgs: string[] = [...cmd.args];

    const alias = this.aliases.get(expandedArgs[0]);
    if (alias) {
      const aliasArgs = alias.split(/\s+/);
      expandedArgs = [...aliasArgs, ...expandedArgs.slice(1)];
    }

    // extract "sh -c" commands and execute them
    if (expandedArgs[0] === "sh" && expandedArgs[1] === "-c" && expandedArgs[2]) {
      const child = this.createExecutionClone();
      if (this.activeSignal) child.setCancellationSignal(this.activeSignal);
      return child.exec(expandedArgs[2], { cwd: this.cwd, env: this.env });
    }

    const name = expandedArgs[0];
    const args = expandedArgs.slice(1);

    if (stdin === undefined) {
      for (const r of cmd.redirects) {
        if (r.type === "read") {
          const p = this.resolvePath(r.target);
          try {
            stdin = this.volume.readFileSync(p, "utf8");
          } catch {
            return {
              stdout: "",
              stderr: `shell: ${r.target}: No such file or directory\n`,
              exitCode: 1,
            };
          }
        }
      }
    }

    const savedEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(cmd.assignments)) {
      savedEnv[k] = this.env[k];
      this.env[k] = v;
    }

    const ctx = this.buildContext();
    let result: ShellResult;

    // dispatch: builtin > registered command > PATH lookup > error
    const builtin = builtins.get(name) ?? builtins.get(canonicalVirtualCommandName(name));
    const command = this.commands.get(name) ?? this.commands.get(canonicalVirtualCommandName(name));
    if (builtin) {
      const r = builtin(args, ctx, stdin);
      result = await r;
      this.cwd = ctx.cwd;
      this.env = ctx.env;
    } else if (name === "alias") {
      result = this.handleAlias(args);
    } else if (name === "source" || name === ".") {
      result = await this.handleSource(args);
    } else if (name === "history") {
      result = this.handleHistory(args);
    } else if (command) {
      try {
        result = await command.execute(args, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        result = {
          stdout: "",
          stderr: `${name}: ${msg}\n`,
          exitCode: 1,
        };
      }
      this.cwd = ctx.cwd;
      this.env = ctx.env;
    } else {
      const resolvedBin = this.resolveFromPath(name);
      if (resolvedBin && this.commands.has("node")) {
        try {
          result = await this.commands
            .get("node")!
            .execute([resolvedBin, ...args], ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = {
            stdout: "",
            stderr: `${name}: ${msg}\n`,
            exitCode: 1,
          };
        }
        this.cwd = ctx.cwd;
        this.env = ctx.env;
      } else {
        result = {
          stdout: "",
          stderr: `${name}: command not found\n`,
          exitCode: 127,
        };
      }
    }

    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete this.env[k];
      else this.env[k] = v;
    }

    result = await this.applyRedirects(result, cmd);

    this.lastExit = result.exitCode;
    return result;
  }

  /* ---------------------------------------------------------------- */
  /*  Bash AST execution                                               */
  /* ---------------------------------------------------------------- */

  private async execBashList(list: BashList): Promise<ShellResult> {
    let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
    for (const entry of list.entries) {
      if (this.activeSignal?.aborted) return { ...result, exitCode: 130 };
      const run = () => this.execBashAndOr(entry.command);
      if (entry.separator === "&" && this.shellOptions.jobControl) {
        const id = this.nextJobId++;
        if (
          this.jobs.size >= this.shellOptions.limits.maxJobs ||
          this.jobs.size + this.detachedJobs.size >= this.shellOptions.limits.maxProcesses
        ) {
          return {
            stdout: result.stdout,
            stderr: `${result.stderr}shell: maximum jobs exceeded\n`,
            exitCode: 1,
          };
        }
        const jobShell = this.createExecutionClone();
        const cancellation = new ShellCancellation();
        jobShell.setCancellationSignal(cancellation.signal);
        const promise = jobShell.execBashAndOr(entry.command).then((r) => {
          this.backgroundStdout?.(r.stdout);
          this.backgroundStderr?.(r.stderr);
          return { ...r, stdout: "", stderr: "" };
        });
        this.jobs.set(id, {
          id,
          command: this.describeBashCommand(entry.command),
          state: "running",
          promise,
          shell: jobShell,
          cancellation,
        });
        this.lastBackgroundPid = id;
        void promise.then(
          (r) => {
            const job = this.jobs.get(id);
            if (job) {
              job.state = r.exitCode === 0 ? "done" : "failed";
              job.result = r;
            }
          },
          (e) => {
            const job = this.jobs.get(id);
            if (job) {
              job.state = "failed";
              job.result = { stdout: "", stderr: `shell: ${String(e)}\n`, exitCode: 1 };
            }
          },
        );
        result = { stdout: "", stderr: "", exitCode: 0 };
      } else {
        let next: ShellResult;
        try {
          next = await run();
        } catch (control) {
          if ((control as ShellControl)?.kind === "return") {
            throw { ...(control as ShellControl), stdout: result.stdout, stderr: result.stderr } satisfies ShellControl;
          }
          throw control;
        }
        result = {
          stdout: result.stdout + next.stdout,
          stderr: result.stderr + next.stderr,
          exitCode: next.exitCode,
        };
        this.assertCollectedOutput(result.stdout, result.stderr);
        if (this.errexit && next.exitCode !== 0) break;
      }
      this.lastExit = result.exitCode;
    }
    return result;
  }

  private async execBashAndOr(andOr: BashAndOr): Promise<ShellResult> {
    let result = await this.execBashPipeline(andOr.first);
    for (const branch of andOr.rest) {
      if (branch.op === "&&" && result.exitCode !== 0) continue;
      if (branch.op === "||" && result.exitCode === 0) continue;
      const next = await this.execBashPipeline(branch.pipeline);
      result = {
        stdout: result.stdout + next.stdout,
        stderr: result.stderr + next.stderr,
        exitCode: next.exitCode,
      };
      this.assertCollectedOutput(result.stdout, result.stderr);
    }
    return result;
  }

  private async execBashPipeline(pipeline: BashPipeline): Promise<ShellResult> {
    if (pipeline.commands.length > this.shellOptions.limits.maxProcesses) {
      return {
        stdout: "",
        stderr: `shell: pipeline exceeds ${this.shellOptions.limits.maxProcesses} processes\n`,
        exitCode: 1,
      };
    }
    if (
      pipeline.commands.length > 1 &&
      pipeline.commands.every(
        (command): command is BashSimpleCommand =>
          command.kind === "simple" &&
          command.assignments.length === 0 &&
          command.redirects.length === 0 &&
          command.words.length > 0 &&
          isStreamableCommand(command.words[0]),
      )
    ) {
      return this.execStreamPipeline(pipeline);
    }
    // legacy command adapters collect ShellResult output. run each stage in its
    // own promise to preserve compound-command and background-job lifecycles.
    let stdin: string | undefined;
    let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
    const statuses: number[] = [];
    for (const command of pipeline.commands) {
      const next = await this.execBashCommand(command, stdin);
      statuses.push(next.exitCode);
      result = { stdout: next.stdout, stderr: result.stderr + next.stderr, exitCode: next.exitCode };
      this.assertCollectedOutput(result.stdout, result.stderr);
      stdin = next.stdout;
    }
    this.pipeStatuses = statuses;
    if (this.pipefail) {
      let failed: number | undefined;
      for (let i = statuses.length - 1; i >= 0; i--) {
        if (statuses[i] !== 0) {
          failed = statuses[i];
          break;
        }
      }
      if (failed !== undefined) result.exitCode = failed;
    }
    if (pipeline.negated) result.exitCode = result.exitCode === 0 ? 1 : 0;
    return result;
  }

  private async execStreamPipeline(pipeline: BashPipeline): Promise<ShellResult> {
    const pipelineCancel = new ShellCancellation();
    const upstreamControllers = pipeline.commands.map(() => new ShellCancellation());
    const parentSignal = this.activeSignal;
    let removeParentAbortListener = () => {};
    if (parentSignal) {
      if (parentSignal.aborted) pipelineCancel.cancel(parentSignal.reason);
      else {
        const onParentAbort = () => pipelineCancel.cancel(parentSignal.reason);
        parentSignal.addEventListener("abort", onParentAbort, { once: true });
        removeParentAbortListener = () => parentSignal.removeEventListener("abort", onParentAbort);
      }
    }
    const pipes = pipeline.commands.slice(0, -1).map(
      () => new ShellPipe(this.shellOptions.limits.maxPipelineBufferBytes),
    );
    const finalOutput = new ShellPipe(this.shellOptions.limits.maxPipelineBufferBytes);
    const statuses: number[] = [];
    const errors: string[] = [];

    const streamCommands = pipeline.commands as BashSimpleCommand[];
    const tasks = streamCommands.map(async (command, index) => {
      const stageToken = upstreamControllers[index];
      const output = index === pipeline.commands.length - 1 ? finalOutput : pipes[index];
      const input = index === 0 ? null : pipes[index - 1];
      const cancelUpstream = () => {
        for (let i = 0; i < index; i++) upstreamControllers[i].cancel(new Error("shell: downstream command closed pipe"));
      };
      let expanded: string[] = [];
      try {
        expanded = await this.expandBashWords(command.words);
        pipelineCancel.onCancel(() => stageToken.cancel(pipelineCancel.signal.reason));
        if (pipelineCancel.signal.aborted) stageToken.cancel(pipelineCancel.signal.reason);
        const result = await runStreamCommand(expanded[0], expanded.slice(1), {
          cwd: this.cwd,
          env: this.env,
          volume: this.volume,
          input,
          output,
          token: stageToken,
          maxOutputBytes: this.shellOptions.limits.maxOutputBytes,
          maxLoopIterations: this.shellOptions.limits.maxLoopIterations,
          cancelUpstream,
        });
        statuses[index] = result.exitCode;
        if (result.stderr) errors[index] = result.stderr;
      } catch (error) {
        const cancellationReason = stageToken.signal.reason;
        statuses[index] = stageToken.signal.aborted
          ? cancellationReason instanceof Error && cancellationReason.message.includes("downstream command closed pipe") ? 141 : 130
          : 1;
        if (!stageToken.signal.aborted) {
          errors[index] = `${expanded[0] ?? command.words[0] ?? "command"}: ${error instanceof Error ? error.message : String(error)}\n`;
        }
      } finally {
        // A stage may finish without consuming all input (for example
        // `yes | cat file`) or may fail before its first read. Always cancel
        // its producers so bounded-pipe writers cannot remain stranded.
        if (index > 0) cancelUpstream();
        output.end();
      }
    });

    const stdoutPromise = streamToString(
      finalOutput,
      pipelineCancel,
      this.shellOptions.limits.maxOutputBytes,
    ).catch((error) => {
      pipelineCancel.cancel(error);
      throw error;
    });
    try {
      await Promise.all(tasks);
      let stdout = "";
      try {
        stdout = await stdoutPromise;
      } catch (error) {
        return {
          stdout: "",
          stderr: `shell: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
        };
      }

      this.pipeStatuses = statuses;
      let exitCode = statuses[statuses.length - 1] ?? 0;
      if (this.pipefail) {
        for (let i = statuses.length - 1; i >= 0; i--) {
          if (statuses[i] !== 0) {
            exitCode = statuses[i];
            break;
          }
        }
      }
      if (pipeline.negated) exitCode = exitCode === 0 ? 1 : 0;
      return { stdout, stderr: errors.filter(Boolean).join(""), exitCode };
    } finally {
      removeParentAbortListener();
    }
  }

  private async execBashCommand(command: BashCommand, stdin?: string): Promise<ShellResult> {
    if (command.kind === "simple") return this.execBashSimple(command, stdin);
    if (command.kind === "group" || command.kind === "subshell") {
      const previousCwd = this.cwd;
      const previousEnv = this.env;
      const previousExit = this.lastExit;
      if (command.kind === "subshell") this.env = { ...this.env };
      const result = await this.execBashList(command.body);
      if (command.kind === "subshell") {
        this.cwd = previousCwd;
        this.env = previousEnv;
        this.lastExit = previousExit;
      }
      return result;
    }
    if (command.kind === "function") {
      if (!this.functions.has(command.name) && this.functions.size >= this.shellOptions.limits.maxFilesystemEntries) {
        return { stdout: "", stderr: "shell: function table limit exceeded\n", exitCode: 1 };
      }
      this.functions.set(command.name, command.body);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.kind === "if") {
      for (const branch of command.branches) {
        const condition = await this.execBashList(branch.condition);
        if (condition.exitCode === 0) return this.execBashList(branch.body);
      }
      return command.elseBody
        ? this.execBashList(command.elseBody)
        : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (command.kind === "while" || command.kind === "until") {
      let output = "";
      let error = "";
      let exitCode = 0;
      let stoppedByCondition = false;
      let stoppedByControl = false;
      for (let i = 0; i < this.shellOptions.limits.maxLoopIterations; i++) {
        if (!await this.canContinueLoop(i)) return { stdout: output, stderr: error, exitCode: 130 };
        const condition = await this.execBashList(command.condition);
        const shouldRun = command.kind === "while" ? condition.exitCode === 0 : condition.exitCode !== 0;
        if (!shouldRun) { stoppedByCondition = true; break; }
        try {
          const body = await this.execBashList(command.body);
          output += body.stdout;
          error += body.stderr;
          this.assertCollectedOutput(output, error);
          exitCode = body.exitCode;
        } catch (control) {
          if ((control as ShellControl)?.kind === "break") { stoppedByControl = true; break; }
          if ((control as ShellControl)?.kind === "continue") continue;
          throw control;
        }
      }
      if (!stoppedByCondition && !stoppedByControl) return { stdout: output, stderr: `${error}shell: loop iteration limit exceeded\n`, exitCode: 1 };
      return { stdout: output, stderr: error, exitCode };
    }
    if (command.kind === "for") {
      const words = command.words
        ? await this.expandBashWords(command.words)
        : [...this.positional];
      let output = "";
      let error = "";
      let exitCode = 0;
      const loopCount = Math.min(words.length, this.shellOptions.limits.maxLoopIterations);
      for (let i = 0; i < loopCount; i++) {
        if (!await this.canContinueLoop(i)) return { stdout: output, stderr: error, exitCode: 130 };
        this.env[command.variable] = words[i];
        try {
          const body = await this.execBashList(command.body);
          output += body.stdout;
          error += body.stderr;
          this.assertCollectedOutput(output, error);
          exitCode = body.exitCode;
        } catch (control) {
          if ((control as ShellControl)?.kind === "break") break;
          if ((control as ShellControl)?.kind === "continue") continue;
          throw control;
        }
      }
      if (loopCount < words.length) return { stdout: output, stderr: `${error}shell: loop iteration limit exceeded\n`, exitCode: 1 };
      return { stdout: output, stderr: error, exitCode };
    }
    if (command.kind === "arithmetic-for") {
      let output = "";
      let error = "";
      let exitCode = 0;
      let stoppedByCondition = false;
      let stoppedByControl = false;
      await this.evalArithmeticExpression(command.init);
      for (let i = 0; i < this.shellOptions.limits.maxLoopIterations; i++) {
        if (!await this.canContinueLoop(i)) return { stdout: output, stderr: error, exitCode: 130 };
        const condition = await this.evalArithmeticExpression(command.condition);
        if (!condition) { stoppedByCondition = true; break; }
        let continued = false;
        try {
          const body = await this.execBashList(command.body);
          output += body.stdout;
          error += body.stderr;
          this.assertCollectedOutput(output, error);
          exitCode = body.exitCode;
        } catch (control) {
          if ((control as ShellControl)?.kind === "break") { stoppedByControl = true; break; }
          if ((control as ShellControl)?.kind === "continue") continued = true;
          else throw control;
        }
        await this.evalArithmeticExpression(command.update);
        if (continued) continue;
      }
      if (!stoppedByCondition && !stoppedByControl) {
        return { stdout: output, stderr: `${error}shell: loop iteration limit exceeded\n`, exitCode: 1 };
      }
      return { stdout: output, stderr: error, exitCode };
    }
    if (command.kind === "case") return this.execBashCase(command);
    if (command.kind === "conditional") return this.execBashConditional(command);
    if (command.kind === "arithmetic") return this.execBashArithmetic(command);
    if (command.kind === "select") return this.execBashSelect(command, stdin);
    if (command.kind === "coproc") return this.execBashCoproc(command);
    return { stdout: "", stderr: "shell: unsupported command\n", exitCode: 2 };
  }

  private async execBashCase(command: BashCaseCommand): Promise<ShellResult> {
    const word = this.expandCaseText(command.word);
    let matchIndex = -1;
    for (let i = 0; i < command.clauses.length; i++) {
      if (command.clauses[i].patterns.some((pattern) => this.casePatternMatches(word, pattern))) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex < 0) return { stdout: "", stderr: "", exitCode: 0 };

    let output = "";
    let error = "";
    let exitCode = 0;
    let index = matchIndex;
    while (index < command.clauses.length) {
      const clause = command.clauses[index];
      const result = await this.execBashList(clause.body);
      output += result.stdout;
      error += result.stderr;
      this.assertCollectedOutput(output, error);
      exitCode = result.exitCode;
      if (clause.terminator === ";&") {
        index++;
        continue;
      }
      if (clause.terminator === ";;&") {
        index++;
        while (index < command.clauses.length) {
          if (command.clauses[index].patterns.some((pattern) => this.casePatternMatches(word, pattern))) break;
          index++;
        }
        continue;
      }
      break;
    }
    return { stdout: output, stderr: error, exitCode };
  }

  private async execBashArithmetic(command: BashArithmeticCommand): Promise<ShellResult> {
    try {
      const numeric = await this.evalArithmeticExpression(command.expression);
      return { stdout: "", stderr: "", exitCode: Number.isFinite(numeric) && numeric !== 0 ? 0 : 1 };
    } catch (error) {
      return { stdout: "", stderr: `shell: ${(error as Error).message}\n`, exitCode: 2 };
    }
  }

  private async evalArithmeticExpression(expression: string): Promise<number> {
    if (this.arithmeticDepth >= this.shellOptions.limits.maxRecursionDepth) {
      throw new ShellLimitError("maxRecursionDepth", "shell: arithmetic nesting limit exceeded");
    }
    this.arithmeticDepth++;
    try { return await this.evalArithmeticExpressionUnchecked(expression); }
    finally { this.arithmeticDepth--; }
  }

  private async evalArithmeticExpressionUnchecked(expression: string): Promise<number> {
    const source = expression.trim();
    const update = source.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+\+|--)$/);
    if (update) {
      const current = Number(this.env[update[1]] ?? "0") || 0;
      const next = current + (update[2] === "++" ? 1 : -1);
      this.env[update[1]] = String(next);
      return update[2] === "++" ? current : current;
    }
    const assignment = source.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+=|-=|\*=|\/=|=)(.*)$/);
    if (assignment) {
      const rhs = await this.evalArithmeticExpression(assignment[3]);
      const current = Number(this.env[assignment[1]] ?? "0") || 0;
      const value = assignment[2] === "+=" ? current + rhs
        : assignment[2] === "-=" ? current - rhs
          : assignment[2] === "*=" ? current * rhs
            : assignment[2] === "/=" ? current / (rhs || 1)
              : rhs;
      this.env[assignment[1]] = String(Math.trunc(value));
      return value;
    }
    const value = (await this.expandBashWords([`$(( ${source} ))`]))[0] ?? "0";
    return Number(value) || 0;
  }

  private async execBashConditional(command: BashConditionalCommand): Promise<ShellResult> {
    const tokens = command.words.map((word) => this.expandCaseText(word));
    let position = 0;
    let conditionalDepth = 0;
    const parsePrimary = (): boolean => {
      if (++conditionalDepth > this.shellOptions.limits.maxRecursionDepth) {
        throw new ShellLimitError("maxRecursionDepth", "shell: conditional nesting limit exceeded");
      }
      try {
      if (tokens[position] === "(") {
        position++;
        const value = parseOr();
        if (tokens[position] === ")") position++;
        return value;
      }
      if (tokens[position] === "!") {
        position++;
        return !parsePrimary();
      }
      const left = tokens[position++] ?? "";
      const unary = new Set(["-e", "-f", "-d", "-r", "-w", "-x", "-s", "-b", "-c", "-p", "-L", "-h", "-v", "-n", "-z"]);
      if (unary.has(left)) {
        const value = tokens[position++] ?? "";
        if (left === "-n") return value.length > 0;
        if (left === "-z") return value.length === 0;
        if (left === "-v") return Object.prototype.hasOwnProperty.call(this.env, value);
        try {
          const stat = this.volume.statSync(this.resolvePath(value));
          if (left === "-e") return true;
          if (left === "-f") return stat.isFile();
          if (left === "-d") return stat.isDirectory();
          if (left === "-s") return stat.isFile() && this.volume.readFileSync(this.resolvePath(value)).byteLength > 0;
          if (left === "-r" || left === "-w" || left === "-x") {
            try {
              this.volume.accessSync(this.resolvePath(value), left === "-r" ? 4 : left === "-w" ? 2 : 1);
              return true;
            } catch { return false; }
          }
          return true;
        } catch {
          return false;
        }
      }
      const operator = tokens[position];
      if (operator && ["=", "==", "!=", "=~", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-nt", "-ot", "-ef"].includes(operator)) {
        position++;
        const right = tokens[position++] ?? "";
        if (operator === "=" || operator === "==") return this.casePatternMatches(left, right);
        if (operator === "!=") return !this.casePatternMatches(left, right);
        if (operator === "=~") {
          try { return new RegExp(right).test(left); } catch { return false; }
        }
        if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
          const a = Number(left) || 0;
          const b = Number(right) || 0;
          if (operator === "-eq") return a === b;
          if (operator === "-ne") return a !== b;
          if (operator === "-lt") return a < b;
          if (operator === "-le") return a <= b;
          if (operator === "-gt") return a > b;
          return a >= b;
        }
        try {
          const a = this.volume.statSync(this.resolvePath(left));
          const b = this.volume.statSync(this.resolvePath(right));
          if (operator === "-nt") return a.mtimeMs > b.mtimeMs;
          if (operator === "-ot") return a.mtimeMs < b.mtimeMs;
          return this.volume.realpathSync(this.resolvePath(left)) === this.volume.realpathSync(this.resolvePath(right));
        } catch { return false; }
      }
      return left.length > 0;
      } finally {
        conditionalDepth--;
      }
    };
    const parseAnd = (): boolean => {
      let value = parsePrimary();
      while (tokens[position] === "&&" || tokens[position] === "-a") {
        position++;
        value = parsePrimary() && value;
      }
      return value;
    };
    const parseOr = (): boolean => {
      let value = parseAnd();
      while (tokens[position] === "||" || tokens[position] === "-o") {
        position++;
        value = parseAnd() || value;
      }
      return value;
    };
    return { stdout: "", stderr: "", exitCode: parseOr() ? 0 : 1 };
  }

  private async execBashSelect(command: BashSelectCommand, stdin?: string): Promise<ShellResult> {
    const choices = await this.expandBashWords(command.words);
    const inputs = (stdin ?? "").split(/\r?\n/).filter((line) => line.length > 0);
    let output = "";
    let error = "";
    let exitCode = 0;
    const loopCount = Math.min(inputs.length, this.shellOptions.limits.maxLoopIterations);
    for (let inputIndex = 0; inputIndex < loopCount; inputIndex++) {
      if (!await this.canContinueLoop(inputIndex)) return { stdout: output, stderr: error, exitCode: 130 };
      const input = inputs[inputIndex];
      const index = Number.parseInt(input, 10) - 1;
      this.env.REPLY = input;
      this.env[command.variable] = index >= 0 && index < choices.length ? choices[index] : "";
      try {
        const result = await this.execBashList(command.body);
        output += result.stdout;
        error += result.stderr;
        this.assertCollectedOutput(output, error);
        exitCode = result.exitCode;
      } catch (control) {
        if ((control as ShellControl)?.kind === "break") break;
        throw control;
      }
    }
    if (loopCount < inputs.length) {
      return { stdout: output, stderr: `${error}shell: loop iteration limit exceeded\n`, exitCode: 1 };
    }
    return { stdout: output, stderr: error, exitCode };
  }

  private async execBashCoproc(command: BashCoprocCommand): Promise<ShellResult> {
    if (
      !this.shellOptions.jobControl ||
      this.jobs.size >= this.shellOptions.limits.maxJobs ||
      this.jobs.size + this.detachedJobs.size >= this.shellOptions.limits.maxProcesses
    ) {
      return { stdout: "", stderr: "coproc: maximum jobs exceeded\n", exitCode: 1 };
    }
    const id = this.nextJobId++;
    const jobShell = this.createExecutionClone();
    const cancellation = new ShellCancellation();
    jobShell.setCancellationSignal(cancellation.signal);
    const promise = jobShell.execBashCommand(command.body);
    this.jobs.set(id, { id, command: `coproc ${command.name}`, state: "running", promise, shell: jobShell, cancellation });
    this.lastBackgroundPid = id;
    this.env.COPROC_PID = String(id);
    this.env[`${command.name}_PID`] = String(id);
    void promise.then((result) => {
      const job = this.jobs.get(id);
      if (job) { job.state = result.exitCode === 0 ? "done" : "failed"; job.result = result; }
    }, (error) => {
      const job = this.jobs.get(id);
      if (job) { job.state = "failed"; job.result = { stdout: "", stderr: `${String(error)}\n`, exitCode: 1 }; }
    });
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private expandCaseText(raw: string): string {
    let text = raw.replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1");
    text = text.replace(/\\(.)/g, "$1");
    text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => this.env[name] ?? "");
    text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_all, name: string) => this.env[name] ?? "");
    return text;
  }

  private casePatternMatches(value: string, rawPattern: string): boolean {
    const pattern = this.expandCaseText(rawPattern).replace(/\*+/g, "*");
    if (value.length * Math.max(1, pattern.length) > this.shellOptions.limits.maxLoopIterations) {
      throw new ShellLimitError("maxLoopIterations", "shell: case pattern operation limit exceeded");
    }
    let regex = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (ch === "*") regex += ".*";
      else if (ch === "?") regex += ".";
      else if (ch === "[") {
        const end = pattern.indexOf("]", i + 1);
        if (end < 0) regex += "\\[";
        else {
          let cls = pattern.slice(i + 1, end);
          if (cls.startsWith("!")) cls = "^" + cls.slice(1);
          regex += `[${cls}]`;
          i = end;
        }
      } else {
        regex += ch.replace(/[\\^$+.()|{}]/g, "\\$&");
      }
    }
    try {
      return new RegExp(`${regex}$`).test(value);
    } catch {
      return false;
    }
  }

  private async execBashSimple(command: BashSimpleCommand, stdin?: string): Promise<ShellResult> {
    this.lastCommandSubstitutionExit = 0;
    const assignmentValues: Record<string, string> = {};
    for (const assignment of command.assignments) {
      const eq = assignment.indexOf("=");
      const name = eq < 0 ? assignment : assignment.slice(0, eq);
      if (this.readonlyNames.has(name) && name in this.env) {
        return { stdout: "", stderr: `shell: ${name}: readonly variable\n`, exitCode: 1 };
      }
      const value = eq < 0 ? "" : assignment.slice(eq + 1);
      const arrayMatch = value.match(/^\((.*)\)$/s);
      if (arrayMatch && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        const rawElements = arrayMatch[1].match(/'[^']*'|"[^"]*"|[^\s]+/g) ?? [];
        if (rawElements.length > this.shellOptions.limits.maxLoopIterations) {
          return { stdout: "", stderr: "shell: array element limit exceeded\n", exitCode: 1 };
        }
        const values: string[] = [];
        for (const element of rawElements) values.push((await this.expandBashWords([element]))[0] ?? "");
        assignmentValues[name] = values.join(" ");
        assignmentValues[`${name}[@]`] = values.join(" ");
        values.forEach((item, index) => { assignmentValues[`${name}[${index}]`] = item; });
        continue;
      }
      const expanded = await this.expandBashWords([value]);
      assignmentValues[name] = expanded.join(" ");
    }

    const args = await this.expandBashWords(command.words);
    let commandPrefixes = 0;
    while (args.length > 0 && (args[0] === "command" || args[0] === "builtin" || args[0] === "exec")) {
      args.shift();
      if (++commandPrefixes > this.shellOptions.limits.maxRecursionDepth) {
        return { stdout: "", stderr: "shell: command prefix limit exceeded\n", exitCode: 1 };
      }
    }
    if (args.length === 0) {
      const newNames = Object.keys(assignmentValues).filter((name) => !(name in this.env)).length;
      if (Object.keys(this.env).length + newNames > this.shellOptions.limits.maxFilesystemEntries) {
        return { stdout: "", stderr: "shell: variable table limit exceeded\n", exitCode: 1 };
      }
      Object.assign(this.env, assignmentValues);
      return { stdout: "", stderr: "", exitCode: this.lastCommandSubstitutionExit };
    }

    // the installed paths name the same shells: spawn's `shell` option and
    // `which bash` (zx) hand out /bin/sh and /bin/bash
    if (/^(?:\/usr)?\/bin\/(?:ba)?sh$/.test(args[0])) args[0] = args[0].slice(args[0].lastIndexOf("/") + 1);
    if ((args[0] === "bash" || args[0] === "sh") && args[1] === "-c") {
      const previous = this.positional;
      const previousName = this.shellName;
      this.positional = args.slice(3);
      this.shellName = args[0];
      try { return await this.execNested(args[2] ?? "", args[0]); }
      finally { this.positional = previous; this.shellName = previousName; }
    }
    if (args[0] === "bash" || args[0] === "sh") {
      const script = args[1];
      if (!script) return { stdout: "", stderr: "", exitCode: 0 };
      return this.execScriptFile(script, args.slice(2), args[0]);
    }
    const scriptPath = this.resolvePath(args[0]);
    if (this.volume.existsSync(scriptPath)) {
      try {
        const content = this.volume.readFileSync(scriptPath, "utf8");
        if (content.startsWith("#!") && /(?:^|\/)(?:ba)?sh(?:\s|$)/.test(content.slice(2, content.indexOf("\n") < 0 ? content.length : content.indexOf("\n")))) {
          return this.execScriptFile(args[0], args.slice(1), args[0]);
        }
      } catch {
        /* fall through to normal command lookup */
      }
    }

    if (args[0] === "set") return this.execSet(args.slice(1));
    if (args[0] === "let") return this.execLet(args.slice(1));
    if (args[0] === "getopts") return this.execGetopts(args.slice(1));
    if (args[0] === "readonly") return this.execReadonly(args.slice(1));
    if (args[0] === "local") return this.execLocal(args.slice(1));
    if (args[0] === "shopt") return this.execShopt(args.slice(1));
    if (args[0] === "jobs" || args[0] === "wait" || args[0] === "fg" || args[0] === "bg" || args[0] === "kill" || args[0] === "disown") {
      return this.execJobsBuiltin(args[0], args.slice(1));
    }
    if (args[0] === "trap") return this.execTrap(args.slice(1));

    if (args[0] === "break" || args[0] === "continue") {
      throw { kind: args[0] as "break" | "continue" } satisfies ShellControl;
    }
    if (args[0] === "return") {
      if (this.localScopes.length === 0) return { stdout: "", stderr: "return: can only `return' from a function or sourced script\n", exitCode: 1 };
      throw { kind: "return", code: parseInt(args[1] ?? "0", 10) || 0 } satisfies ShellControl;
    }
    if (args[0] === "shift") {
      this.positional = this.positional.slice(parseInt(args[1] ?? "1", 10) || 1);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "eval") return this.execNested(args.slice(1).join(" "), "eval");
    if (args[0] === "unalias") {
      for (const alias of args.slice(1)) this.aliases.delete(alias);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "pushd") {
      if (this.directoryStack.length >= this.shellOptions.limits.maxRecursionDepth) {
        return { stdout: "", stderr: "pushd: directory stack limit exceeded\n", exitCode: 1 };
      }
      this.directoryStack.push(this.cwd);
      return this.exec("cd " + (args[1] ?? this.directoryStack.shift() ?? "/"));
    }
    if (args[0] === "popd") {
      const target = this.directoryStack.pop();
      if (!target) return { stdout: "", stderr: "popd: directory stack empty\n", exitCode: 1 };
      return this.exec(`cd '${target.replace(/'/g, "'\\''")}'`);
    }
    if (args[0] === "dirs") {
      return { stdout: [this.cwd, ...[...this.directoryStack].reverse()].join(" ") + "\n", stderr: "", exitCode: 0 };
    }

    const fn = this.functions.get(args[0]);
    if (fn) {
      if (this.recursionDepth >= this.shellOptions.limits.maxRecursionDepth) {
        return { stdout: "", stderr: `shell: recursion depth exceeds ${this.shellOptions.limits.maxRecursionDepth}\n`, exitCode: 1 };
      }
      const previous = this.positional;
      this.positional = args.slice(1);
      this.recursionDepth++;
      this.localScopes.push(new Map());
      try {
        return await this.execBashCommand(fn);
      } catch (control) {
        if ((control as ShellControl)?.kind === "return") {
          return {
            stdout: (control as ShellControl).stdout ?? "",
            stderr: (control as ShellControl).stderr ?? "",
            exitCode: (control as ShellControl).code ?? 0,
          };
        }
        throw control;
      } finally {
        const locals = this.localScopes.pop()!;
        for (const [name, value] of locals) {
          if (value === undefined) delete this.env[name];
          else this.env[name] = value;
        }
        this.recursionDepth--;
        this.positional = previous;
      }
    }

    const redirects: CommandNode["redirects"] = [];
    let redirectedStdin = stdin;
    for (const redirect of command.redirects) {
      const rawTarget = redirect.target ?? "";
      const target = redirect.heredoc ? rawTarget : ((await this.expandBashWords([rawTarget]))[0] ?? "");
      if (redirect.heredoc) {
        redirectedStdin = redirect.heredoc.expand === false
          ? redirect.heredoc.body
          : await expandHereDocument(redirect.heredoc.body, this.createExpansionContext());
      } else if (redirect.op === "<<<") {
        redirectedStdin = (await this.expandBashWords([target])).join(" ") + "\n";
      } else if (redirect.op === "2>&1") {
        redirects.push({ type: "stderr-to-stdout", target: "" });
      } else if (redirect.op === ">&" && redirect.fd === 2 && target === "1") {
        redirects.push({ type: "stderr-to-stdout", target: "" });
      } else if (redirect.op === ">&" && redirect.fd === 1 && target === "2") {
        redirects.push({ type: "stdout-to-stderr", target: "" });
      } else if (redirect.op === ">&-" && redirect.fd === 2) {
        redirects.push({ type: "stderr-write", target: "/dev/null" });
      } else if (redirect.op === ">&-" && redirect.fd === 1) {
        redirects.push({ type: "write", target: "/dev/null" });
      } else if (redirect.op === "&>") {
        redirects.push({ type: "write", target });
        redirects.push({ type: "stderr-to-stdout", target: "" });
      } else if (redirect.op === "&>>") {
        redirects.push({ type: "append", target });
        redirects.push({ type: "stderr-to-stdout", target: "" });
      } else if (redirect.fd === 2 && (redirect.op === ">" || redirect.op === ">|")) redirects.push({ type: "stderr-write", target });
      else if (redirect.fd === 2 && redirect.op === ">>") redirects.push({ type: "stderr-append", target });
      else if (redirect.op === ">" || redirect.op === ">|") redirects.push({ type: "write", target });
      else if (redirect.op === ">>") redirects.push({ type: "append", target });
      else if (redirect.op === "<") redirects.push({ type: "read", target });
      else if (redirect.op === "2>") redirects.push({ type: "stderr-write", target });
      else if (redirect.op === "2>>") redirects.push({ type: "stderr-append", target });
    }

    const previousEnv: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(assignmentValues)) {
      previousEnv[key] = this.env[key];
      this.env[key] = value;
    }
    try {
      return await this.execCommand({ kind: "command", args, redirects, assignments: {} }, redirectedStdin);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete this.env[key];
        else this.env[key] = value;
      }
    }
  }

  private async expandBashWords(words: string[]): Promise<string[]> {
    return expandWords(words, this.createExpansionContext());
  }

  private createExpansionContext(): BashExpansionContext {
    return {
      env: this.env,
      cwd: this.cwd,
      volume: this.volume,
      lastExit: this.lastExit,
      positional: this.positional,
      lastBackgroundPid: this.lastBackgroundPid,
      pipeStatuses: this.pipeStatuses,
      nounset: this.nounset,
      shellName: this.shellName,
      globOptions: { enabled: this.globEnabled, nullglob: this.nullglob, dotglob: this.dotglob },
      limits: this.shellOptions.limits,
      commandSubstitution: async (command) => {
        if (this.commandSubstitutionDepth >= this.shellOptions.limits.maxCommandSubstitutionDepth) {
          throw new Error(`shell: command substitution nesting exceeds ${this.shellOptions.limits.maxCommandSubstitutionDepth}`);
        }
        this.commandSubstitutionDepth++;
        try {
          const child = this.createExecutionClone();
          child.commandSubstitutionDepth = this.commandSubstitutionDepth;
          child.setCancellationSignal(this.activeSignal);
          const result = await child.exec(command);
          this.lastCommandSubstitutionExit = result.exitCode;
          return { stdout: result.stdout, exitCode: result.exitCode };
        } finally {
          this.commandSubstitutionDepth--;
        }
      },
      processSubstitution: async (command, mode) => {
        const scope = this.processSubstitutionScopes[this.processSubstitutionScopes.length - 1];
        if (!scope || scope.length >= this.shellOptions.limits.maxProcesses) {
          throw new ShellLimitError("maxProcesses", "shell: process substitution limit exceeded");
        }
        const path = `/tmp/.nodepod-proc-${++this.processSubstitutionCounter}`;
        const child = this.createExecutionClone();
        child.setCancellationSignal(this.activeSignal);
        const result = await child.exec(command);
        try {
          this.volume.writeFileSync(path, mode === "read" ? result.stdout : "");
          scope.push(path);
        } catch { /* virtual process path remains best effort */ }
        return path;
      },
    };
  }

  private execSet(args: string[]): ShellResult {
    if (args.length === 0) {
      let out = "";
      for (const [key, value] of Object.entries(this.env)) out += `${key}=${value}\n`;
      return { stdout: out, stderr: "", exitCode: 0 };
    }
    const positionalMarker = args.indexOf("--");
    if (positionalMarker >= 0) {
      this.positional = args.slice(positionalMarker + 1);
      args = args.slice(0, positionalMarker);
    }
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-e") this.errexit = true;
      else if (arg === "+e") this.errexit = false;
      else if (arg === "-u") this.nounset = true;
      else if (arg === "+u") this.nounset = false;
      else if (arg === "-f") this.globEnabled = false;
      else if (arg === "+f") this.globEnabled = true;
      else if (arg === "-o" || arg === "+o") {
        const option = args[++i] ?? "";
        const enabled = arg === "-o";
        if (option === "errexit") this.errexit = enabled;
        else if (option === "nounset") this.nounset = enabled;
        else if (option === "pipefail") this.pipefail = enabled;
      } else if (/^-\d+$/.test(arg)) {
        this.positional = this.positional.slice(parseInt(arg.slice(1), 10));
      } else if (!arg.startsWith("-")) {
        this.positional = args.slice(i);
        break;
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async execLet(args: string[]): Promise<ShellResult> {
    let value = 0;
    for (const expression of args) value = await this.evalArithmeticExpression(expression);
    return { stdout: "", stderr: "", exitCode: value === 0 ? 1 : 0 };
  }

  private execReadonly(args: string[]): ShellResult {
    for (const arg of args) {
      if (arg === "-p") continue;
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { stdout: "", stderr: `readonly: ${name}: invalid name\n`, exitCode: 1 };
      if (eq >= 0) this.env[name] = arg.slice(eq + 1);
      this.readonlyNames.add(name);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async execLocal(args: string[]): Promise<ShellResult> {
    const scope = this.localScopes[this.localScopes.length - 1];
    if (!scope) return { stdout: "", stderr: "local: can only be used in a function\n", exitCode: 1 };
    for (const arg of args) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { stdout: "", stderr: `local: ${name}: invalid name\n`, exitCode: 1 };
      if (!scope.has(name)) scope.set(name, this.env[name]);
      this.env[name] = eq >= 0 ? (await this.expandBashWords([arg.slice(eq + 1)]))[0] ?? "" : "";
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private execGetopts(args: string[]): ShellResult {
    const optstring = args[0] ?? "";
    const variable = args[1] ?? "OPTARG";
    let index = Number(this.env.OPTIND ?? "1") || 1;
    const positional = this.positional;
    if (index > positional.length) return { stdout: "", stderr: "", exitCode: 1 };
    const current = positional[index - 1] ?? "";
    if (!current.startsWith("-") || current === "-") return { stdout: "", stderr: "", exitCode: 1 };
    if (current === "--") { this.env.OPTIND = String(index + 1); return { stdout: "", stderr: "", exitCode: 1 }; }
    const option = current[1];
    const specIndex = optstring.indexOf(option);
    if (specIndex < 0) {
      this.env[variable] = "?";
      this.env.OPTARG = option;
      this.env.OPTIND = String(index + 1);
      return { stdout: "", stderr: `getopts: illegal option -- ${option}\n`, exitCode: 0 };
    }
    if (optstring[specIndex + 1] === ":") {
      const value = current.slice(2) || positional[index] || "";
      if (!value) {
        this.env[variable] = ":";
        this.env.OPTARG = option;
        this.env.OPTIND = String(index + 1);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      this.env.OPTARG = value;
      this.env.OPTIND = String(current.length > 2 ? index + 1 : index + 2);
    } else {
      this.env.OPTARG = "";
      this.env.OPTIND = String(index + 1);
    }
    this.env[variable] = option;
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private execShopt(args: string[]): ShellResult {
    let mode: "show" | "set" | "unset" | "query" = "show";
    const names: string[] = [];
    for (const arg of args) {
      if (arg === "-s") mode = "set";
      else if (arg === "-u") mode = "unset";
      else if (arg === "-q") mode = "query";
      else if (!arg.startsWith("-")) names.push(arg);
    }
    const known = new Set(["nullglob", "dotglob"]);
    const read = (name: string): boolean => name === "nullglob" ? this.nullglob : name === "dotglob" ? this.dotglob : false;
    const write = (name: string, value: boolean): void => {
      if (name === "nullglob") this.nullglob = value;
      if (name === "dotglob") this.dotglob = value;
    };
    if (mode === "set" || mode === "unset") {
      for (const name of names) {
        if (!known.has(name)) return { stdout: "", stderr: `shopt: ${name}: invalid shell option name\n`, exitCode: 1 };
        write(name, mode === "set");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    const selected = names.length ? names : [...known];
    let out = "";
    let status = 0;
    for (const name of selected) {
      if (!known.has(name)) { status = 1; continue; }
      if (mode === "query") { if (!read(name)) status = 1; }
      else out += `${name}\t${read(name) ? "on" : "off"}\n`;
    }
    return { stdout: out, stderr: "", exitCode: status };
  }

  private execTrap(args: string[]): ShellResult {
    if (args.length === 0 || args[0] === "-p") {
      let stdout = "";
      for (const [signal, command] of this.traps) stdout += `trap -- '${command.replace(/'/g, "'\\''")}' ${signal}\n`;
      return { stdout, stderr: "", exitCode: 0 };
    }
    const command = args[0];
    for (const signal of args.slice(1)) {
      const normalized = signal.replace(/^SIG/, "");
      if (command === "-" || command === "") this.traps.delete(normalized);
      else this.traps.set(normalized, command);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async execScriptFile(script: string, args: string[], interpreter: string): Promise<ShellResult> {
    const path = this.resolvePath(script);
    let source: string;
    try {
      source = this.volume.readFileSync(path, "utf8");
    } catch {
      return { stdout: "", stderr: `${interpreter}: ${script}: No such file or directory\n`, exitCode: 127 };
    }
    if (source.startsWith("#!")) {
      const newline = source.indexOf("\n");
      source = newline < 0 ? "" : source.slice(newline + 1);
    }
    const previous = this.positional;
    const previousName = this.shellName;
    this.positional = args;
    this.shellName = script;
    try {
      return await this.execNested(source, interpreter);
    } finally {
      this.positional = previous;
      this.shellName = previousName;
    }
  }

  private async execJobsBuiltin(name: string, args: string[]): Promise<ShellResult> {
    if (name === "jobs") {
      let out = "";
      for (const job of this.jobs.values()) out += `[${job.id}] ${job.state}\t${job.command}\n`;
      return { stdout: out, stderr: "", exitCode: 0 };
    }
    const idArgs = name === "kill" ? args.filter((arg) => !/^-[A-Za-z]+$/.test(arg)) : args;
    const ids = idArgs.length ? idArgs.map((arg) => parseInt(arg.replace(/^%/, ""), 10)).filter(Number.isFinite) : [...this.jobs.keys()];
    if (name === "wait") {
      let result: ShellResult = { stdout: "", stderr: "", exitCode: 0 };
      for (const id of ids) {
        const job = this.jobs.get(id);
        if (!job) {
          result = { stdout: "", stderr: `wait: ${id}: no such job\n`, exitCode: 127 };
          continue;
        }
        result = await job.promise;
        this.jobs.delete(id);
      }
      return result;
    }
    if (name === "fg") {
      const job = this.jobs.get(ids[0] ?? Math.max(...this.jobs.keys(), 0));
      if (!job) return { stdout: "", stderr: "fg: no such job\n", exitCode: 1 };
      const result = await job.promise;
      this.jobs.delete(job.id);
      return result;
    }
    if (name === "bg") {
      const job = this.jobs.get(ids[0] ?? Math.max(...this.jobs.keys(), 0));
      if (!job) return { stdout: "", stderr: "bg: no such job\n", exitCode: 1 };
      if (job.state === "stopped") job.state = "running";
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (name === "kill") {
      let killed = 0;
      for (const id of ids) {
        const job = this.jobs.get(id);
        if (!job) continue;
        job.cancellation.cancel(new Error("shell: job terminated"));
        job.state = "failed";
        killed++;
      }
      return killed ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: "kill: no such job\n", exitCode: 1 };
    }
    if (name === "disown") {
      for (const id of ids) {
        const job = this.jobs.get(id);
        if (!job) continue;
        this.jobs.delete(id);
        this.detachedJobs.add(job.promise);
        void job.promise.then(
          () => this.detachedJobs.delete(job.promise),
          () => this.detachedJobs.delete(job.promise),
        );
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: `${name}: job control is managed by the terminal\n`, exitCode: 0 };
  }

  private createExecutionClone(): NodepodShell {
    const clone = new NodepodShell(this.volume, {
      cwd: this.cwd,
      env: { ...this.env },
      shell: { limits: { ...this.shellOptions.limits }, jobControl: this.shellOptions.jobControl },
    });
    clone.commands = this.commands;
    clone.aliases = new Map(this.aliases);
    clone.functions = new Map(this.functions);
    clone.pipefail = this.pipefail;
    clone.errexit = this.errexit;
    clone.nounset = this.nounset;
    clone.globEnabled = this.globEnabled;
    clone.nullglob = this.nullglob;
    clone.dotglob = this.dotglob;
    clone.positional = [...this.positional];
    clone.lastExit = this.lastExit;
    clone.recursionDepth = this.recursionDepth;
    clone.commandSubstitutionDepth = this.commandSubstitutionDepth;
    clone.arithmeticDepth = this.arithmeticDepth;
    clone.traps = new Map(this.traps);
    clone.readonlyNames = new Set(this.readonlyNames);
    clone.setSpawnChildCallback(this._spawnChild);
    clone.setBackgroundOutputCallbacks(this.backgroundStdout, this.backgroundStderr);
    return clone;
  }

  private describeBashCommand(andOr: BashAndOr): string {
    const first = andOr.first.commands[0];
    if (first.kind === "simple") return first.words[0] ?? "(command)";
    return `(${first.kind})`;
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private assertCollectedOutput(stdout: string, stderr: string): void {
    // UTF-8 byte length is always at least the UTF-16 code-unit count for the
    // strings used here. This cheap incremental guard prevents unbounded
    // concatenation; _execInner performs the exact byte check once at exit.
    const limit = this.shellOptions.limits.maxOutputBytes;
    if (stdout.length + stderr.length > limit) {
      throw new ShellLimitError("maxOutputBytes", `shell: output exceeds ${limit} bytes`);
    }
  }

  private assertEnvironmentState(): void {
    const entries = Object.entries(this.env);
    if (entries.length > this.shellOptions.limits.maxFilesystemEntries) {
      throw new ShellLimitError("maxFilesystemEntries", "shell: variable table limit exceeded");
    }
    let size = 0;
    for (const [name, value] of entries) {
      size += name.length + value.length + 2;
      if (size > this.shellOptions.limits.maxExpansionBytes) {
        throw new ShellLimitError("maxExpansionBytes", "shell: environment size limit exceeded");
      }
    }
  }

  private async canContinueLoop(iteration: number): Promise<boolean> {
    if (this.activeSignal?.aborted) return false;
    if (iteration > 0 && (iteration & 255) === 0) {
      try { await yieldToEventLoop(this.activeSignal ?? undefined); }
      catch { return false; }
    }
    return !this.activeSignal?.aborted;
  }

  private buildContext(): ShellContext {
    return {
      cwd: this.cwd,
      env: { ...this.env },
      volume: this.volume,
      signal: this.activeSignal ?? undefined,
      limits: this.shellOptions.limits,
      // Utility-launched commands have process-like isolation. Besides being
      // the correct cwd/environment behavior, this prevents a nested command
      // from waiting on the serialization slot held by its own parent.
      exec: (cmd, opts) => {
        const child = this.createExecutionClone();
        const signal = opts?.signal ?? this.activeSignal;
        if (signal) child.setCancellationSignal(signal);
        return child.exec(cmd, { cwd: opts?.cwd, env: opts?.env });
      },
    };
  }

  private installVirtualOs(): void {
    try {
      this.volume.mkdirSync("/tmp", { recursive: true, mode: 0o1777 });
      this.volume.mkdirSync("/dev", { recursive: true, mode: 0o755 });
      for (const device of ["null", "stdin", "stdout", "stderr", "zero"]) {
        const path = `/dev/${device}`;
        if (!this.volume.existsSync(path)) this.volume.writeFileSync(path, "");
      }
      // sh and bash are built in; executable entries let PATH lookups
      // (`which bash`, zx picking its shell) find them where node would
      this.volume.mkdirSync("/bin", { recursive: true, mode: 0o755 });
      for (const shell of ["sh", "bash"]) {
        const path = `/bin/${shell}`;
        if (this.volume.existsSync(path)) continue;
        this.volume.writeFileSync(path, "# built into the nodepod shell\n");
        this.volume.chmodSync(path, 0o755);
      }
    } catch {
      // Read-only snapshots can still use the path-aware stream adapters.
    }
  }

  private resolvePath(p: string): string {
    if (p.startsWith("/")) return this.normalizePath(p);
    return this.normalizePath(`${this.cwd}/${p}`);
  }

  // Search PATH for a command. Parses .bin stubs to find the real JS entry point.
  private resolveFromPath(name: string): string | null {
    const pathStr = this.env.PATH || "";
    const dirs = pathStr.split(":");

    for (const dir of dirs) {
      if (!dir) continue;
      const candidate = `${dir}/${name}`;
      if (!this.volume.existsSync(candidate)) continue;

      try {
        const content = this.volume.readFileSync(candidate, "utf8").slice(0, 64 * 1024);
        // bin stubs: node "/node_modules/pkg/index.js" "$@"
        const match = content.match(/node\s+"([^"]+)"/);
        if (match && this.volume.existsSync(match[1])) {
          return match[1];
        }
        if (
          content.startsWith("#!/") ||
          content.startsWith("'use strict'") ||
          content.startsWith('"use strict"') ||
          content.startsWith("var ") ||
          content.startsWith("const ") ||
          content.startsWith("import ") ||
          content.startsWith("module.")
        ) {
          return candidate;
        }
      } catch {
        /* skip */
      }
    }

    return null;
  }

  private normalizePath(raw: string): string {
    const parts = raw.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === "..") stack.pop();
      else if (part !== ".") stack.push(part);
    }
    return "/" + stack.join("/");
  }

  private async applyRedirects(
    result: ShellResult,
    cmd: CommandNode,
  ): Promise<ShellResult> {
    let { stdout, stderr, exitCode } = result;

    type Destination = { kind: "capture" } | { kind: "file"; path: string; append: boolean };
    let stdoutDestination: Destination = { kind: "capture" };
    let stderrDestination: Destination = { kind: "capture" };
    let stderrMovedToStdout = false;
    let stdoutMovedToStderr = false;
    const fileContents = new Map<string, string>();
    const fileTargets = new Map<string, string>();
    const redirectedFileLimit = this.shellOptions.limits.maxOutputBytes * 32;

    const prepareFile = (target: string, append: boolean): Destination => {
      const path = this.resolvePath(target);
      const previous = fileContents.get(path);
      if (previous === undefined || !append) {
        let initial = "";
        if (append && this.volume.existsSync(path)) {
          try { initial = this.volume.readFileSync(path, "utf8"); } catch { initial = ""; }
        }
        if (initial.length > redirectedFileLimit) {
          throw new ShellLimitError("maxOutputBytes", `shell: redirected file exceeds ${redirectedFileLimit} bytes`);
        }
        fileContents.set(path, initial);
      }
      fileTargets.set(path, target);
      return { kind: "file", path, append };
    };

    // Redirections are applied left-to-right. A descriptor duplication copies
    // the current destination, which is why 2>&1 >file differs from >file 2>&1.
    for (const r of cmd.redirects) {
      if (r.type === "stderr-to-stdout") {
        stderrDestination = stdoutDestination;
        stderrMovedToStdout = true;
      } else if (r.type === "stdout-to-stderr") {
        stdoutDestination = stderrDestination;
        stdoutMovedToStderr = true;
      } else if (r.type === "write") {
        stdoutDestination = prepareFile(r.target, false);
      } else if (r.type === "append") {
        stdoutDestination = prepareFile(r.target, true);
      } else if (r.type === "stderr-write") {
        stderrDestination = prepareFile(r.target, false);
      } else if (r.type === "stderr-append") {
        stderrDestination = prepareFile(r.target, true);
      }
    }

    const mergedOutput = stderrMovedToStdout && stdoutDestination.kind === "capture";
    const movedToStderr = stdoutMovedToStderr && stderrDestination.kind === "capture";
    const writeOutput = (destination: Destination, content: string): void => {
      if (destination.kind !== "file") return;
      const next = (fileContents.get(destination.path) ?? "") + content;
      if (next.length > redirectedFileLimit) {
        throw new ShellLimitError("maxOutputBytes", `shell: redirected file exceeds ${redirectedFileLimit} bytes`);
      }
      fileContents.set(destination.path, next);
    };
    writeOutput(stdoutDestination, stdout);
    writeOutput(stderrDestination, stderr);
    if (mergedOutput) {
      stdout += stderr;
      stderr = "";
    } else if (movedToStderr) {
      stderr += stdout;
      stdout = "";
    }

    for (const [path, content] of fileContents) {
      if (path === "/dev/null") continue;
      try {
        const dir = this.normalizePath(path.substring(0, path.lastIndexOf("/")));
        if (dir && dir !== "/" && !this.volume.existsSync(dir)) {
          this.volume.mkdirSync(dir, { recursive: true });
        }
        this.volume.writeFileSync(path, content);
      } catch (e) {
        const target = fileTargets.get(path) ?? path;
        stderr += `shell: ${target}: ${e instanceof Error ? e.message : "Cannot write"}\n`;
        exitCode = 1;
      }
    }

    if (stdoutDestination.kind === "file") stdout = "";
    if (stderrDestination.kind === "file") stderr = "";
    return { stdout, stderr, exitCode };
  }

  private historyPath(): string {
    const hist = this.env.HISTFILE;
    if (hist) return hist.startsWith("/") ? hist : this.resolvePath(hist);
    const home = this.env.HOME || "/home/user";
    return `${home}/.nodepod_history`;
  }

  private loadHistory(): void {
    try {
      const p = this.historyPath();
      if (!this.volume.existsSync(p)) return;
      const raw = this.volume.readFileSync(p, "utf8");
      const bounded = raw.length > this.shellOptions.limits.maxOutputBytes
        ? raw.slice(-this.shellOptions.limits.maxOutputBytes)
        : raw;
      this.history = bounded.split("\n").filter((l) => l.length > 0);
      this.trimHistory();
    } catch {
      /* ignore */
    }
  }

  private persistHistory(): void {
    try {
      const p = this.historyPath();
      const dir = this.normalizePath(p.substring(0, p.lastIndexOf("/")));
      if (dir && dir !== "/" && !this.volume.existsSync(dir)) {
        this.volume.mkdirSync(dir, { recursive: true });
      }
      this.trimHistory();
      this.volume.writeFileSync(p, this.history.join("\n") + (this.history.length ? "\n" : ""));
    } catch {
      /* ignore */
    }
  }

  private recordHistory(command: string): void {
    if (!command || command === "history") return;
    this.history.push(command);
    this.persistHistory();
  }

  private trimHistory(): void {
    const requested = parseInt(this.env.HISTSIZE || "1000", 10);
    const maxEntries = Number.isFinite(requested)
      ? Math.max(0, Math.min(requested, this.shellOptions.limits.maxFilesystemEntries))
      : 1000;
    if (maxEntries === 0) this.history = [];
    else if (this.history.length > maxEntries) this.history = this.history.slice(-maxEntries);
    const maxBytes = this.shellOptions.limits.maxOutputBytes;
    let total = 0;
    let first = this.history.length;
    while (first > 0) {
      const next = this.history[first - 1].length + 1;
      if (total + next > maxBytes) break;
      total += next;
      first--;
    }
    if (first > 0) this.history = this.history.slice(first);
  }

  private handleHistory(_args: string[]): ShellResult {
    let out = "";
    for (let i = 0; i < this.history.length; i++) {
      out += `  ${String(i + 1).padStart(4)}  ${this.history[i]}\n`;
    }
    return { stdout: out, stderr: "", exitCode: 0 };
  }

  private async expandCommandSubstitution(input: string): Promise<string> {
    let result = "";
    let i = 0;

    while (i < input.length) {
      if (input[i] === "'") {
        result += "'";
        i++;
        while (i < input.length && input[i] !== "'") {
          result += input[i++];
        }
        if (i < input.length) result += input[i++];
        continue;
      }

      if (input[i] === "$" && input[i + 1] === "(") {
        i += 2;
        let depth = 1;
        let subCmd = "";
        while (i < input.length && depth > 0) {
          if (input[i] === "(") depth++;
          if (input[i] === ")") depth--;
          if (depth > 0) subCmd += input[i];
          i++;
        }
        const subResult = await this.exec(subCmd);
        result += subResult.stdout.replace(/\n$/, "");
        continue;
      }

      if (input[i] === "`") {
        i++;
        let subCmd = "";
        while (i < input.length && input[i] !== "`") {
          subCmd += input[i++];
        }
        if (i < input.length) i++;
        const subResult = await this.exec(subCmd);
        result += subResult.stdout.replace(/\n$/, "");
        continue;
      }

      result += input[i++];
    }

    return result;
  }

  private handleAlias(args: string[]): ShellResult {
    if (args.length === 0) {
      let out = "";
      for (const [k, v] of this.aliases) out += `alias ${k}='${v}'\n`;
      return { stdout: out, stderr: "", exitCode: 0 };
    }
    for (const arg of args) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        let val = arg.slice(eq + 1);
        if (
          (val.startsWith("'") && val.endsWith("'")) ||
          (val.startsWith('"') && val.endsWith('"'))
        ) {
          val = val.slice(1, -1);
        }
        const name = arg.slice(0, eq);
        if (!this.aliases.has(name) && this.aliases.size >= this.shellOptions.limits.maxFilesystemEntries) {
          return { stdout: "", stderr: "alias: alias table limit exceeded\n", exitCode: 1 };
        }
        this.aliases.set(name, val);
      } else {
        const val = this.aliases.get(arg);
        if (val)
          return { stdout: `alias ${arg}='${val}'\n`, stderr: "", exitCode: 0 };
        return {
          stdout: "",
          stderr: `alias: ${arg}: not found\n`,
          exitCode: 1,
        };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  private async handleSource(args: string[]): Promise<ShellResult> {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "source: missing file argument\n",
        exitCode: 1,
      };
    }
    const p = this.resolvePath(args[0]);
    try {
      const content = this.volume.readFileSync(p, "utf8");
      return this.execNested(content, "source");
    } catch {
      return {
        stdout: "",
        stderr: `source: ${args[0]}: No such file or directory\n`,
        exitCode: 1,
      };
    }
  }

  private async execNested(command: string, label: string): Promise<ShellResult> {
    if (this.recursionDepth >= this.shellOptions.limits.maxRecursionDepth) {
      return {
        stdout: "",
        stderr: `${label}: recursion depth exceeds ${this.shellOptions.limits.maxRecursionDepth}\n`,
        exitCode: 1,
      };
    }
    this.recursionDepth++;
    try {
      return await this.exec(command);
    } finally {
      this.recursionDepth--;
    }
  }
}
