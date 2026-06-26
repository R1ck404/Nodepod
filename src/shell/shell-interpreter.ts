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
import type { IVolume } from "../types/volume";
import { parse, expandGlob } from "./shell-parser";
import { builtins } from "./shell-builtins";

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
  private volume: IVolume;
  private cwd: string;
  private env: Record<string, string>;
  private commands = new Map<string, ShellCommand>();
  private lastExit = 0;
  private aliases = new Map<string, string>();
  // serializes concurrent exec() calls to prevent cwd save/restore races
  private _execQueue: Promise<ShellResult> = Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

  private _spawnChild: SpawnChildCallback | null = null;

  constructor(
    volume: IVolume,
    opts?: { cwd?: string; env?: Record<string, string> },
  ) {
    this.volume = volume;
    this.cwd = opts?.cwd ?? "/";
    this.env = opts?.env ? { ...opts.env } : {};
    this.env.PWD = this.cwd;
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

  async exec(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ShellResult> {
    // serialize cwd/env-overriding calls to prevent save/restore races
    if (opts?.cwd || opts?.env) {
      const prev = this._execQueue;
      let resolve!: (r: ShellResult) => void;
      this._execQueue = new Promise<ShellResult>((r) => { resolve = r; });
      await prev.catch(() => {});
      try {
        const r = await this._execInner(command, opts);
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
    return this._execInner(command, opts);
  }

  private async _execInner(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ShellResult> {
    const prevCwd = this.cwd;
    const prevEnv = { ...this.env };

    if (opts?.cwd) {
      this.cwd = opts.cwd;
      this.env.PWD = opts.cwd;
    }
    if (opts?.env) {
      Object.assign(this.env, opts.env);
    }

    try {
      const expanded = await this.expandCommandSubstitution(command);

      const ast = parse(expanded, this.env, this.lastExit);
      return await this.execList(ast);
    } catch (e) {
      return {
        stdout: "",
        stderr: `shell: ${e instanceof Error ? e.message : String(e)}\n`,
        exitCode: 1,
      };
    } finally {
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
    if (cmd.args.length === 0) {
      for (const [k, v] of Object.entries(cmd.assignments)) {
        this.env[k] = v;
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    let expandedArgs: string[] = [];
    for (const arg of cmd.args) {
      expandedArgs.push(...expandGlob(arg, this.cwd, this.volume));
    }

    const alias = this.aliases.get(expandedArgs[0]);
    if (alias) {
      const aliasArgs = alias.split(/\s+/);
      expandedArgs = [...aliasArgs, ...expandedArgs.slice(1)];
    }

    // extract "sh -c" commands and execute them
    if (expandedArgs[0] === "sh" && expandedArgs[1] === "-c" && expandedArgs[2]) {
      return this.exec(expandedArgs[2], { cwd: this.cwd, env: this.env });
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
    const builtin = builtins.get(name);
    if (builtin) {
      const r = builtin(args, ctx, stdin);
      result = r instanceof Promise ? await r : r;
      if (name === "cd") {
        this.cwd = ctx.cwd;
        this.env = ctx.env;
      }
      if (name === "export" || name === "unset") {
        this.env = ctx.env;
      }
    } else if (name === "alias") {
      result = this.handleAlias(args);
    } else if (name === "source" || name === ".") {
      result = await this.handleSource(args);
    } else if (name === "history") {
      result = { stdout: "", stderr: "", exitCode: 0 };
    } else if (this.commands.has(name)) {
      try {
        result = await this.commands.get(name)!.execute(args, ctx);
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
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private buildContext(): ShellContext {
    return {
      cwd: this.cwd,
      env: { ...this.env },
      volume: this.volume,
      exec: (cmd, opts) => this.exec(cmd, opts),
    };
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
        const content = this.volume.readFileSync(candidate, "utf8");
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

    for (const r of cmd.redirects) {
      if (r.type === "stderr-to-stdout") {
        stdout += stderr;
        stderr = "";
        continue;
      }

      if (r.type === "write" || r.type === "append") {
        const p = this.resolvePath(r.target);
        try {
          if (r.type === "append" && this.volume.existsSync(p)) {
            const existing = this.volume.readFileSync(p, "utf8");
            this.volume.writeFileSync(p, existing + stdout);
          } else {
            const dir = this.normalizePath(p.substring(0, p.lastIndexOf("/")));
            if (dir && dir !== "/" && !this.volume.existsSync(dir)) {
              this.volume.mkdirSync(dir, { recursive: true });
            }
            this.volume.writeFileSync(p, stdout);
          }
          stdout = "";
        } catch (e) {
          stderr += `shell: ${r.target}: ${e instanceof Error ? e.message : "Cannot write"}\n`;
          exitCode = 1;
        }
      }
    }

    return { stdout, stderr, exitCode };
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
        this.aliases.set(arg.slice(0, eq), val);
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
      return this.exec(content);
    } catch {
      return {
        stdout: "",
        stderr: `source: ${args[0]}: No such file or directory\n`,
        exitCode: 1,
      };
    }
  }
}
