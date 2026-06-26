import type { IVolume } from "../types/volume";

/* ------------------------------------------------------------------ */
/*  Result & context                                                   */
/* ------------------------------------------------------------------ */

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellContext {
  cwd: string;
  env: Record<string, string>;
  volume: IVolume;
  // run a sub-command through the shell (used by npm run, etc.)
  exec: (cmd: string, opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ShellResult>;
}

export interface ShellCommand {
  name: string;
  execute(args: string[], ctx: ShellContext): Promise<ShellResult>;
}

/* ------------------------------------------------------------------ */
/*  AST nodes                                                          */
/* ------------------------------------------------------------------ */

export interface RedirectNode {
  type: "write" | "append" | "read" | "stderr-to-stdout";
  target: string; // file path (empty for 2>&1)
}

export interface CommandNode {
  kind: "command";
  args: string[];
  redirects: RedirectNode[];
  assignments: Record<string, string>; // KEY=value before the command
}

export interface PipelineNode {
  kind: "pipeline";
  commands: CommandNode[];
}

export type ListOperator = "&&" | "||" | ";";

export interface ListEntry {
  pipeline: PipelineNode;
  next?: ListOperator; // operator after this pipeline (undefined for last)
}

export interface ListNode {
  kind: "list";
  entries: ListEntry[];
}

/* ------------------------------------------------------------------ */
/*  Token types                                                        */
/* ------------------------------------------------------------------ */

export type TokenType =
  | "word"
  | "pipe"          // |
  | "and"           // &&
  | "or"            // ||
  | "semi"          // ;
  | "redirect-out"  // >
  | "redirect-app"  // >>
  | "redirect-in"   // <
  | "redirect-2to1" // 2>&1
  | "newline"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
}

export type BuiltinFn = (
  args: string[],
  ctx: ShellContext,
  stdin?: string,
) => Promise<ShellResult> | ShellResult;
