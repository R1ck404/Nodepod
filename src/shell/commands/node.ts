import type { ShellCommand } from "../shell-types.js";
import type { PmDeps } from "./pm-types.js";
import { VERSIONS } from "../../constants/config.js";
import { parseAst } from "../../polyfills/rollup.js";
import { isTypeScriptFile, stripTypeScript } from "../../strip-typescript.js";
import { resolvePath } from "../shell-helpers.js";

const A_RESET = "\x1b[0m";
const A_BOLD = "\x1b[1m";

export function createNodeCommand(deps: PmDeps): ShellCommand {
  return {
    name: "node",
    async execute(params, ctx) {
      if (!deps.hasFile("/"))
        return { stdout: "", stderr: "Volume unavailable\n", exitCode: 1 };

      let target: string | null = null;
      let evalCode: string | null = null;
      let printCode: string | null = null;
      let checkOnly = false;
      let testMode = false;
      const testFiles: string[] = [];
      const scriptArgs: string[] = [];
      const execArgv: string[] = [];
      let collectingArgs = false;

      for (let i = 0; i < params.length; i++) {
        if (collectingArgs) {
          scriptArgs.push(params[i]);
          continue;
        }
        if (params[i] === "-e" || params[i] === "--eval") {
          evalCode = params[++i] ?? "";
        } else if (params[i] === "-p" || params[i] === "--print") {
          printCode = params[++i] ?? "";
        } else if (params[i] === "--test") {
          testMode = true;
        } else if (testMode && params[i].startsWith("--test-")) {
          // --test-reporter, --test-name-pattern, ... are accepted; values in the --flag=value form
          // need no extra handling, and space-separated values are skipped.
          if (!params[i].includes("=") && params[i + 1] && !params[i + 1].startsWith("-")) i++;
        } else if (testMode && !params[i].startsWith("-")) {
          testFiles.push(params[i]);
        } else if (params[i] === "--check" || params[i] === "-c") {
          checkOnly = true;
        } else if (params[i] === "--version" || params[i] === "-v") {
          return { stdout: VERSIONS.NODE + "\n", stderr: "", exitCode: 0 };
        } else if (params[i] === "--help" || params[i] === "-h") {
          return {
            stdout: `${A_BOLD}Usage:${A_RESET} node [options] [script.js] [arguments]\n`,
            stderr: "",
            exitCode: 0,
          };
        } else if (params[i] === "--conditions" || params[i] === "-C") {
          execArgv.push(params[i], params[++i] ?? "");
        } else if (
          params[i] === "-r" ||
          params[i] === "--require" ||
          params[i] === "--experimental-specifier-resolution" ||
          params[i] === "--loader" ||
          params[i] === "--import"
        ) {
          i++;
        } else if (params[i].startsWith("-")) {
          // skip unknown flags (--harmony, --inspect, etc.)
          execArgv.push(params[i]);
        } else {
          target = params[i];
          collectingArgs = true;
        }
      }

      if (evalCode !== null) {
        return deps.evalCode(evalCode, ctx);
      }

      if (testMode) {
        return runTestFiles(deps, ctx, testFiles, execArgv);
      }
      if (printCode !== null) {
        return deps.printCode(printCode, ctx);
      }

      if (!target)
        return {
          stdout: "",
          stderr: `${A_BOLD}Usage:${A_RESET} node <file> [args...]\n`,
          exitCode: 1,
        };

      if (checkOnly) {
        const fullPath = resolvePath(target, ctx.cwd);
        let source: string;
        try {
          source = ctx.volume.readFileSync(fullPath, "utf8");
        } catch {
          return {
            stdout: "",
            stderr: `node: ${target}: No such file or directory\n`,
            exitCode: 1,
          };
        }
        const sourceLimit = ctx.limits?.maxExpansionBytes ?? 1024 * 1024;
        if (source.length > sourceLimit) {
          return {
            stdout: "",
            stderr: `node: source exceeds ${sourceLimit} characters\n`,
            exitCode: 1,
          };
        }
        if (isTypeScriptFile(fullPath)) {
          source = stripTypeScript(source, fullPath);
        }
        try {
          parseAst(source, undefined, fullPath);
          return { stdout: "", stderr: "", exitCode: 0 };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            stdout: "",
            stderr: `${fullPath}\n${msg}\n`,
            exitCode: 1,
          };
        }
      }

      return deps.executeNodeBinary(target, scriptArgs, ctx, { execArgv });
    },
  };
}

/** Node's default test-file patterns: test.js, test-*.js, *.test.js, *-test.js, *_test.js and test/ folders. */
const TEST_FILE = /(^|\/)(test|test-.+|.+[.\-_]test)\.(c|m)?js$/;
const SCRIPT_FILE = /\.(c|m)?js$/;

function findTestFiles(ctx: Parameters<ShellCommand["execute"]>[1], dir: string, inTestDir: boolean, found: string[]): void {
  let names: string[];
  try {
    names = ctx.volume.readdirSync(dir) as string[];
  } catch {
    return;
  }
  for (const name of [...names].sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = ctx.volume.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) findTestFiles(ctx, full, inTestDir || name === "test", found);
    else if (TEST_FILE.test(full) || (inTestDir && SCRIPT_FILE.test(name))) found.push(full);
  }
}

/** `node --test [files]`: runs each test file in turn and fails if any of them fails. */
async function runTestFiles(
  deps: PmDeps,
  ctx: Parameters<ShellCommand["execute"]>[1],
  files: string[],
  execArgv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const targets: string[] = [];
  if (files.length) {
    for (const f of files) {
      const full = resolvePath(f, ctx.cwd);
      let isDir = false;
      try {
        isDir = ctx.volume.statSync(full).isDirectory();
      } catch {
        return { stdout: "", stderr: `Could not find '${full}'\n`, exitCode: 1 };
      }
      // Every script under a test/ folder is a test file, including when that folder is the one given.
      if (isDir) findTestFiles(ctx, full, full.split("/").includes("test"), targets);
      else targets.push(full);
    }
  } else {
    findTestFiles(ctx, ctx.cwd, false, targets);
  }
  if (!targets.length) {
    return { stdout: "ℹ tests 0\nℹ pass 0\nℹ fail 0\n", stderr: "", exitCode: 0 };
  }
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const file of targets) {
    const result = await deps.executeNodeBinary(file, [], ctx, { execArgv });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) exitCode = 1;
  }
  return { stdout, stderr, exitCode };
}

export function createNpxCommand(deps: PmDeps): ShellCommand {
  return {
    name: "npx",
    async execute(params, ctx) {
      return deps.npxExecute(params, ctx);
    },
  };
}
