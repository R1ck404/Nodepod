import type { ShellCommand } from "../shell-types";
import { splitLeadingSilentFlags, type PmDeps } from "./pm-types";
import { VERSIONS } from "../../constants/config";

const A_RESET = "\x1b[0m";
const A_BOLD = "\x1b[1m";
const A_CYAN = "\x1b[36m";
const A_DIM = "\x1b[2m";

export function createPnpmCommand(deps: PmDeps): ShellCommand {
  return {
    name: "pnpm",
    async execute(rawParams, ctx) {
      const { silent, params } = splitLeadingSilentFlags(rawParams);
      if (!deps.hasFile("/"))
        return { stdout: "", stderr: "Volume unavailable\n", exitCode: 1 };

      const sub = params[0];
      if (!sub || sub === "help" || sub === "--help") {
        return {
          stdout:
            `${A_BOLD}Usage:${A_RESET} pnpm <command>\n\n` +
            `  ${A_CYAN}add${A_RESET} [pkg]         Install packages\n` +
            `  ${A_CYAN}install${A_RESET}           Install from package.json\n` +
            `  ${A_CYAN}remove${A_RESET} <pkg>      Remove a package\n` +
            `  ${A_CYAN}run${A_RESET} <script>      Run a script\n` +
            `  ${A_CYAN}exec${A_RESET} <cmd>        Execute a binary\n` +
            `  ${A_CYAN}dlx${A_RESET} <pkg>         Download and execute a package\n\n` +
            `  ${A_CYAN}list${A_RESET}              List packages\n` +
            `  ${A_CYAN}init${A_RESET}              Create package.json\n` +
            `  ${A_CYAN}create${A_RESET} <pkg>      Create a project\n\n` +
            `${A_DIM}pnpm ${VERSIONS.PNPM}${A_RESET}\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      switch (sub) {
        case "add": {
          return deps.installPackages(params.slice(1), ctx, "pnpm");
        }
        case "install":
        case "i": {
          return deps.installPackages(params.slice(1), ctx, "pnpm");
        }
        case "remove":
        case "rm":
        case "uninstall":
        case "un":
          return deps.uninstallPackages(params.slice(1), ctx, "pnpm");
        case "list":
        case "ls":
          return deps.listPackages(ctx, "pnpm");
        case "run":
          return deps.runScript([...silent, ...params.slice(1)], ctx);
        case "start":
          return deps.runScript([...silent, "start"], ctx);
        case "test":
        case "t":
          return deps.runScript([...silent, "test"], ctx);
        case "exec":
          return deps.npxExecute(params.slice(1), ctx);
        case "dlx":
          return deps.npxExecute(params.slice(1), ctx);
        case "init":
        case "create":
          return deps.npmInitOrCreate(params.slice(1), sub, ctx);
        case "version":
        case "-v":
        case "--version":
          return { stdout: VERSIONS.PNPM + "\n", stderr: "", exitCode: 0 };
        case "audit":
          return deps.npmAudit(ctx);
        case "outdated":
          return deps.npmOutdated(ctx);
        case "why":
          return {
            stdout: "",
            stderr: deps.formatErr("why: not available in nodepod", "pnpm"),
            exitCode: 1,
          };
        default:
          // pnpm accepts `pnpm <script>` as shorthand for `pnpm run <script>`.
          return deps.runScript([...silent, ...params], ctx);
      }
    },
  };
}
