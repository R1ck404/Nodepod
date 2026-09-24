// Shared types for package manager commands (npm, pnpm, yarn, bun).
// Each PM file is a factory that receives these deps from child_process.ts.

import type { ShellCommand, ShellResult, ShellContext } from "../shell-types";

export type PkgManager = "npm" | "pnpm" | "yarn" | "bun";

export interface PmDeps {
  installPackages: (
    args: string[],
    ctx: ShellContext,
    pm?: PkgManager,
  ) => Promise<ShellResult>;
  uninstallPackages: (
    args: string[],
    ctx: ShellContext,
    pm?: PkgManager,
  ) => Promise<ShellResult>;
  listPackages: (ctx: ShellContext, pm?: PkgManager, args?: string[]) => Promise<ShellResult>;
  runScript: (args: string[], ctx: ShellContext) => Promise<ShellResult>;
  npmInitOrCreate: (
    args: string[],
    sub: string,
    ctx: ShellContext,
  ) => Promise<ShellResult>;
  npmInfo: (args: string[], ctx: ShellContext) => Promise<ShellResult>;
  npmPack: (ctx: ShellContext) => ShellResult;
  npmConfig: (args: string[], ctx: ShellContext) => ShellResult;
  npmPkg: (args: string[], ctx: ShellContext) => ShellResult;
  npmCi: (ctx: ShellContext, pm?: PkgManager) => Promise<ShellResult>;
  npmOutdated: (ctx: ShellContext) => Promise<ShellResult>;
  npmAudit: (ctx: ShellContext) => Promise<ShellResult>;
  npmFund: (ctx: ShellContext) => Promise<ShellResult>;
  npmPing: (ctx: ShellContext) => Promise<ShellResult>;
  npmWhoami: (ctx: ShellContext) => Promise<ShellResult>;
  npmCacheClean: () => Promise<ShellResult>;
  npxExecute: (params: string[], ctx: ShellContext) => Promise<ShellResult>;
  executeNodeBinary: (
    filePath: string,
    args: string[],
    ctx: ShellContext,
    opts?: { isFork?: boolean },
  ) => Promise<ShellResult>;
  evalCode: (code: string, ctx: ShellContext) => Promise<ShellResult>;
  printCode: (code: string, ctx: ShellContext) => Promise<ShellResult>;
  removeNodeModules: (cwd: string) => void;
  formatErr: (msg: string, pm: PkgManager) => string;
  formatWarn: (msg: string, pm: PkgManager) => string;
  hasFile: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
}

// `npm -s run build` / `pnpm --silent run build`: the global flag precedes
// the subcommand. Split it off so the dispatcher sees the subcommand first
// and can forward the flag to run-script, its only consumer.
export function splitLeadingSilentFlags(params: string[]): {
  silent: string[];
  params: string[];
} {
  let i = 0;
  while (i < params.length && (params[i] === "-s" || params[i] === "--silent")) i++;
  return { silent: params.slice(0, i), params: params.slice(i) };
}
// re-export so factories can import ShellCommand from one place if needed
export type { ShellCommand };
