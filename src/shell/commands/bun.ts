import type { ShellCommand } from "../shell-types";
import { splitLeadingSilentFlags, type PmDeps } from "./pm-types";
import { VERSIONS } from "../../constants/config";

const A_RESET = "\x1b[0m";
const A_BOLD = "\x1b[1m";
const A_CYAN = "\x1b[36m";
const A_DIM = "\x1b[2m";

export function createBunCommand(deps: PmDeps): ShellCommand {
  return {
    name: "bun",
    async execute(rawParams, ctx) {
      const { silent, params } = splitLeadingSilentFlags(rawParams);
      if (!deps.hasFile("/"))
        return { stdout: "", stderr: "Volume unavailable\n", exitCode: 1 };

      const sub = params[0];
      if (!sub || sub === "help" || sub === "--help") {
        return {
          stdout:
            `${A_BOLD}Usage:${A_RESET} bun <command>\n\n` +
            `  ${A_CYAN}run${A_RESET} <script|file> Run a script or file\n` +
            `  ${A_CYAN}install${A_RESET}           Install dependencies\n` +
            `  ${A_CYAN}add${A_RESET} [pkg]         Add a package\n` +
            `  ${A_CYAN}remove${A_RESET} <pkg>      Remove a package\n` +
            `  ${A_CYAN}x${A_RESET} <pkg>           Execute a package\n` +
            `  ${A_CYAN}init${A_RESET}              Create package.json\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      switch (sub) {
        case "run": {
          const target = params[1];
          if (!target) {
            return {
              stdout: "",
              stderr: "error: Missing script or file\n",
              exitCode: 1,
            };
          }
          if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(target) || target.startsWith("/")) {
            return deps.executeNodeBinary(target, params.slice(2), ctx);
          }
          return deps.runScript([...silent, ...params.slice(1)], ctx);
        }
        case "start":
          return deps.runScript([...silent, "start"], ctx);
        case "test":
        case "t":
          return deps.runScript([...silent, "test"], ctx);
        case "install":
        case "i": {
          const rejected = deps.rejectGlobal(params.slice(1), "bun");
          if (rejected) return rejected;
          return deps.installPackages(params.slice(1), ctx, "bun");
        }
        case "add": {
          const rejected = deps.rejectGlobal(params.slice(1), "bun");
          if (rejected) return rejected;
          return deps.installPackages(params.slice(1), ctx, "bun");
        }
        case "remove":
        case "rm":
          return deps.uninstallPackages(params.slice(1), ctx, "bun");
        case "x":
          return deps.npxExecute(params.slice(1), ctx);
        case "init":
        case "create":
          return deps.npmInitOrCreate(params.slice(1), sub, ctx);
        case "pm": {
          const pmSub = params[1];
          if (pmSub === "ls" || pmSub === "list")
            return deps.listPackages(ctx, "bun");
          if (pmSub === "cache") {
            if (params[2] === "rm" || params[2] === "clear" || params[2] === "clean") {
              return deps.npmCacheClean();
            }
            return {
              stdout: "",
              stderr: deps.formatErr(
                "bun pm cache: use `bun pm cache rm` to clear",
                "bun",
              ),
              exitCode: 1,
            };
          }
          return {
            stdout: `${A_DIM}bun pm: available subcommands: ls, cache${A_RESET}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        case "version":
        case "-v":
        case "--version":
          return { stdout: VERSIONS.BUN + "\n", stderr: "", exitCode: 0 };
        case "upgrade":
          return {
            stdout: "",
            stderr: deps.formatErr(
              "upgrade: not applicable in nodepod (runtime is embedded)",
              "bun",
            ),
            exitCode: 1,
          };
        case "audit":
          return deps.npmAudit(ctx);
        case "outdated":
          return deps.npmOutdated(ctx);
        default: {
          // bare `bun <file>` runs it directly, otherwise treat as script
          if (params[0] && !params[0].startsWith("-")) {
            const filePath = params[0].startsWith("/")
              ? params[0]
              : `${ctx.cwd}/${params[0]}`.replace(/\/+/g, "/");
            if (deps.hasFile(filePath)) {
              return deps.executeNodeBinary(params[0], params.slice(1), ctx);
            }
            return deps.runScript([...silent, ...params], ctx);
          }
          return {
            stdout: "",
            stderr: `error: unknown command "${sub}"\n`,
            exitCode: 1,
          };
        }
      }
    },
  };
}

export function createBunxCommand(deps: PmDeps): ShellCommand {
  return {
    name: "bunx",
    async execute(params, ctx) {
      return deps.npxExecute(params, ctx);
    },
  };
}
