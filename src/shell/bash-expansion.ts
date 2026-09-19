import type { MemoryVolume } from "../memory-volume";
import { expandGlob } from "./shell-parser";
import type { ShellLimits } from "./shell-options";
import { ShellLimitError } from "./shell-options";

export interface BashExpansionContext {
  env: Record<string, string>;
  cwd: string;
  volume: MemoryVolume;
  lastExit: number;
  positional: string[];
  lastBackgroundPid: number;
  shellName?: string;
  pipeStatuses: number[];
  nounset?: boolean;
  limits: ShellLimits;
  globOptions?: { enabled?: boolean; nullglob?: boolean; dotglob?: boolean };
  commandSubstitution: (command: string) => Promise<{ stdout: string; exitCode: number }>;
  processSubstitution?: (command: string, mode: "read" | "write") => Promise<string>;
}

function braceExpand(word: string, limit: number, recursionDepth = 0, maxDepth = 64): string[] {
  if (recursionDepth > maxDepth) {
    throw new ShellLimitError("maxRecursionDepth", "shell: brace expansion nesting limit exceeded");
  }
  let open = -1;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === "\\") { i++; continue; }
    if (quote) {
      if (word[i] === quote) quote = null;
    } else if (word[i] === "'" || word[i] === '"') {
      quote = word[i] as "'" | '"';
    } else if (word[i] === "{") {
      open = i;
      break;
    }
  }
  if (open < 0) return [word];
  let depth = 0;
  quote = null;
  for (let i = open; i < word.length; i++) {
    if (word[i] === "\\") { i++; continue; }
    if (quote) {
      if (word[i] === quote) quote = null;
      continue;
    }
    if (word[i] === "'" || word[i] === '"') { quote = word[i] as "'" | '"'; continue; }
    if (word[i] === "{") depth++;
    else if (word[i] === "}") {
      depth--;
      if (depth === 0) {
        const body = word.slice(open + 1, i);
        const choices = body.includes("..")
          ? expandRange(body, limit)
          : body.split(",");
        if (choices.length <= 1) return [word];
        const out: string[] = [];
        for (const choice of choices) {
          for (const expanded of braceExpand(
            word.slice(0, open) + choice + word.slice(i + 1),
            limit,
            recursionDepth + 1,
            maxDepth,
          )) {
            out.push(expanded);
            if (out.length > limit) {
              throw new ShellLimitError("maxExpansionBytes", "shell: brace expansion limit exceeded");
            }
          }
        }
        return out;
      }
    }
  }
  return [word];
}

function expandRange(body: string, limit: number): string[] {
  const match = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (!match) return body.split(",");
  const start = parseInt(match[1], 10);
  const end = parseInt(match[2], 10);
  const step = parseInt(match[3] ?? (start <= end ? "1" : "-1"), 10) || 1;
  const actualStep = start <= end ? Math.abs(step) : -Math.abs(step);
  const count = Math.floor(Math.abs(end - start) / Math.abs(actualStep)) + 1;
  if (!Number.isSafeInteger(count) || count > limit) {
    throw new ShellLimitError("maxExpansionBytes", "shell: brace expansion limit exceeded");
  }
  const values: string[] = [];
  if (actualStep > 0) {
    for (let n = start; n <= end; n += actualStep) values.push(String(n));
  } else {
    for (let n = start; n >= end; n += actualStep) values.push(String(n));
  }
  return values;
}

function expandTilde(raw: string, ctx: BashExpansionContext): string {
  // Quoted tildes are ordinary characters. Only the leading unquoted forms
  // that do not require passwd database lookups are virtualized here.
  if (raw.startsWith("~")) {
    if (raw === "~" || raw.startsWith("~/")) {
      return `${ctx.env.HOME ?? "/home/user"}${raw.slice(1)}`;
    }
    if (raw === "~+" || raw.startsWith("~+/")) {
      return `${ctx.env.PWD ?? ctx.cwd}${raw.slice(2)}`;
    }
    if (raw === "~-" || raw.startsWith("~-/")) {
      return `${ctx.env.OLDPWD ?? ctx.cwd}${raw.slice(2)}`;
    }
  }
  return raw;
}

function findMatching(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

function findQuoteEnd(text: string, start: number, quote: "'" | '"'): number {
  if (quote === "'") return text.indexOf(quote, start + 1);
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue;
    let backslashes = 0;
    for (let j = i - 1; j >= start + 1 && text[j] === "\\"; j--) backslashes++;
    if ((backslashes & 1) === 0) return i;
  }
  return -1;
}

function lookupParameter(name: string, ctx: BashExpansionContext): string {
  if (name === "?") return String(ctx.lastExit);
  if (name === "$") return "1";
  if (name === "0") return ctx.shellName ?? "nodepod";
  if (name === "#") return String(ctx.positional.length);
  if (name === "!") return ctx.lastBackgroundPid ? String(ctx.lastBackgroundPid) : "";
  if (name === "PIPESTATUS") return ctx.pipeStatuses.join(" ");
  if (name === "@" || name === "*") return ctx.positional.join(" ");
  const array = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[([@*]|\d+)\]$/);
  if (array) {
    const base = array[1];
    const index = array[2];
    if (index === "@" || index === "*") return ctx.env[`${base}[@]`] ?? ctx.env[base] ?? "";
    return ctx.env[`${base}[${index}]`] ?? "";
  }
  if (/^\d+$/.test(name)) return ctx.positional[parseInt(name, 10) - 1] ?? "";
  if (ctx.nounset && !(name in ctx.env)) {
    throw new Error(`shell: ${name}: unbound variable`);
  }
  return ctx.env[name] ?? "";
}

function expandParameter(raw: string, ctx: BashExpansionContext): string {
  if (!raw.startsWith("${") || !raw.endsWith("}")) return lookupParameter(raw.slice(1), ctx);
  let body = raw.slice(2, -1);
  if (body.startsWith("#")) return String(lookupParameter(body.slice(1), ctx).length);

  const caseModifier = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\^\^|\^|,,|,)$/);
  if (caseModifier) {
    const value = lookupParameter(caseModifier[1], ctx);
    return caseModifier[2].startsWith("^") ? value.toUpperCase() : value.toLowerCase();
  }

  const patternModifier = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(##|#|%%|%)(.*)$/);
  if (patternModifier) {
    const value = lookupParameter(patternModifier[1], ctx);
    const pattern = patternModifier[3].replace(/\*+/g, "*");
    if (!pattern) return value;
    if (value.length * Math.max(1, pattern.length) > ctx.limits.maxLoopIterations) {
      throw new ShellLimitError("maxLoopIterations", "shell: parameter pattern operation limit exceeded");
    }
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const expression = patternModifier[2].startsWith("#") ? `^${escaped}` : `${escaped}$`;
    const match = value.match(new RegExp(expression));
    if (!match) return value;
    return patternModifier[2].length === 2
      ? patternModifier[2].startsWith("#") ? value.slice(match[0].length) : value.slice(0, value.length - match[0].length)
      : patternModifier[2].startsWith("#") ? value.slice(match[0].length) : value.slice(0, value.length - match[0].length);
  }

  const operator = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?|\d+|[@*?])(:?[-+=?])(.*)$/);
  if (operator) {
    const [, name, op, fallback] = operator;
    const value = lookupParameter(name, ctx);
    const empty = value.length === 0;
    if ((op === "-" && ctx.env[name] === undefined) || (op === ":-" && empty)) return fallback;
    if ((op === "+" && ctx.env[name] !== undefined) || (op === ":+" && !empty)) return fallback;
    if (op === "=" || op === ":=") {
      if (ctx.env[name] === undefined || (op === ":=" && empty)) ctx.env[name] = fallback;
      return ctx.env[name];
    }
    if (op === "?" || op === ":?") {
      if (ctx.env[name] === undefined || (op === ":?" && empty)) {
        throw new Error(`shell: ${fallback || name}: parameter is unset`);
      }
    }
    return value;
  }

  // Bash substring syntax: ${var:offset[:length]}.
  const slice = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(-?\d+)(?::\s*(-?\d+))?$/);
  if (slice) {
    const value = lookupParameter(slice[1], ctx);
    const start = parseInt(slice[2], 10);
    const length = slice[3] === undefined ? undefined : parseInt(slice[3], 10);
    return length === undefined ? value.slice(start) : value.slice(start, start + length);
  }

  return lookupParameter(body, ctx);
}

function arithmetic(expression: string, ctx: BashExpansionContext): string {
  if (expression.length > Math.min(ctx.limits.maxExpansionBytes, ctx.limits.maxLoopIterations)) {
    throw new ShellLimitError("maxLoopIterations", "shell: arithmetic expression limit exceeded");
  }
  const substituted = expression.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, (name) => lookupParameter(name, ctx) || "0");
  if (!/^[\d\s()+\-*/%<>&|^~!?=:]+$/.test(substituted)) {
    throw new Error("shell: invalid arithmetic expression");
  }
  let nesting = 0;
  for (const char of substituted) {
    if (char === "(" && ++nesting > ctx.limits.maxRecursionDepth) {
      throw new ShellLimitError("maxRecursionDepth", "shell: arithmetic nesting limit exceeded");
    }
    if (char === ")") nesting--;
  }
  // This is intentionally isolated from the module scope and accepts only
  // the arithmetic character set above. It does not have access to globals.
  const value = Function(`"use strict"; return (${substituted});`)();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("shell: arithmetic overflow");
  return String(Math.trunc(value));
}

async function expandPart(raw: string, ctx: BashExpansionContext): Promise<{
  value: string;
  split: boolean;
  glob: boolean;
  preserveEmpty: boolean;
}> {
  let out = "";
  let split = false;
  let glob = false;
  let preserveEmpty = false;
  for (let i = 0; i < raw.length;) {
    const ch = raw[i];
    if (ch === "'") {
      const end = findQuoteEnd(raw, i, "'");
      if (end < 0) throw new Error("shell: unmatched single quote");
      preserveEmpty = true;
      out += raw.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = findQuoteEnd(raw, i, '"');
      if (end < 0) throw new Error("shell: unmatched double quote");
      preserveEmpty = true;
      const inner = raw.slice(i + 1, end);
      out += await expandInner(inner, ctx, false);
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < raw.length) out += raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(" && raw[i + 2] === "(") {
      const end = raw.indexOf("))", i + 3);
      if (end < 0) throw new Error("shell: unmatched arithmetic expansion");
      out += arithmetic(raw.slice(i + 3, end), ctx);
      split = true;
      i = end + 2;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(") {
      const end = findMatching(raw, i + 1, "(", ")");
      if (end < 0) throw new Error("shell: unmatched command substitution");
      const sub = await ctx.commandSubstitution(raw.slice(i + 2, end));
      out += sub.stdout.replace(/\n+$/, "");
      split = true;
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      let end = i + 1;
      while (end < raw.length && raw[end] !== "`") end++;
      if (end >= raw.length) throw new Error("shell: unmatched command substitution");
      const sub = await ctx.commandSubstitution(raw.slice(i + 1, end));
      out += sub.stdout.replace(/\n+$/, "");
      split = true;
      i = end + 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && raw[i + 1] === "(") {
      const end = findMatching(raw, i + 1, "(", ")");
      if (end < 0) throw new Error("shell: unmatched process substitution");
      if (ctx.processSubstitution) out += await ctx.processSubstitution(raw.slice(i + 2, end), ch === "<" ? "read" : "write");
      else out += raw.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "{") {
      const end = findMatching(raw, i + 1, "{", "}");
      if (end < 0) throw new Error("shell: unmatched parameter expansion");
      out += expandParameter(raw.slice(i, end + 1), ctx);
      split = true;
      i = end + 1;
      continue;
    }
    if (ch === "$" && i + 1 < raw.length) {
      let end = i + 2;
      if (/\d/.test(raw[i + 1]) || /[?!@$#]/.test(raw[i + 1])) {
        end = i + 2;
      } else {
        while (end < raw.length && /[a-zA-Z0-9_]/.test(raw[end])) end++;
      }
      if (end > i + 1) {
        out += lookupParameter(raw.slice(i + 1, end), ctx);
        split = true;
        i = end;
        continue;
      }
    }
    if (ch === "*" || ch === "?") glob = true;
    out += ch;
    i++;
  }
  return { value: out, split, glob, preserveEmpty };
}

// Body of a double-quoted string. Only $-expansions, command substitution
// and the backslash escapes for $ ` " \ <newline> are special; single
// quotes, globs, tildes and process substitution are literal text, so
// `node -e "console.log('x')"` hands the program its quotes intact.
async function expandInner(text: string, ctx: BashExpansionContext, _allowSplit: boolean): Promise<string> {
  const value = await expandQuotedText(text, ctx, { doubleQuoted: true });
  if (value.length > ctx.limits.maxExpansionBytes) {
    throw new ShellLimitError("maxExpansionBytes", "shell: expansion limit exceeded");
  }
  return value;
}

export async function expandWord(raw: string, ctx: BashExpansionContext): Promise<string[]> {
  if (raw === '"$@"' || raw === "${@}") return [...ctx.positional];
  if (raw === '"$*"' || raw === '"${*}"') return [ctx.positional.join(" ")];
  if (raw === "$@") return [...ctx.positional];
  const quotedArray = raw.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\[@\]\}"$/);
  if (quotedArray) return (ctx.env[`${quotedArray[1]}[@]`] ?? "").split(" ").filter((value) => value.length > 0);
  const values: string[] = [];
  let expandedLength = 0;
  for (const braced of braceExpand(
    expandTilde(raw, ctx),
    Math.min(ctx.limits.maxExpansionBytes, ctx.limits.maxLoopIterations),
    0,
    ctx.limits.maxRecursionDepth,
  )) {
    const result = await expandPart(braced, ctx);
    let pieces = result.split
      ? result.value.split(/[ \t\n]+/).filter(Boolean)
      : [result.value];
    if (pieces.length === 0 && result.preserveEmpty) pieces = [""];
    if (result.glob && ctx.globOptions?.enabled !== false) {
      const expanded: string[] = [];
      for (const piece of pieces) {
        const matches = expandGlob(piece, ctx.cwd, ctx.volume, {
          dotglob: ctx.globOptions?.dotglob,
          maxEntries: ctx.limits.maxFilesystemEntries,
          maxOperations: ctx.limits.maxLoopIterations,
          maxPatternLength: ctx.limits.maxExpansionBytes,
        });
        if (ctx.globOptions?.nullglob && matches.length === 1 && matches[0] === piece) continue;
        expanded.push(...matches);
      }
      pieces = expanded;
    }
    values.push(...pieces);
    for (const piece of pieces) expandedLength += piece.length;
    if (expandedLength > ctx.limits.maxExpansionBytes) {
      throw new ShellLimitError("maxExpansionBytes", "shell: expansion limit exceeded");
    }
  }
  return values;
}

export async function expandWords(words: string[], ctx: BashExpansionContext): Promise<string[]> {
  const result: string[] = [];
  for (const word of words) result.push(...await expandWord(word, ctx));
  return result;
}

/** Expand an unquoted here-document body without word splitting or globbing. */
export async function expandHereDocument(text: string, ctx: BashExpansionContext): Promise<string> {
  return expandQuotedText(text, ctx, { doubleQuoted: false });
}

// Shared expansion for the two contexts with the same rules: here-document
// bodies and double-quoted strings (which additionally treat \" as ").
async function expandQuotedText(
  text: string,
  ctx: BashExpansionContext,
  opts: { doubleQuoted: boolean },
): Promise<string> {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if (
        next === "\\" ||
        next === "$" ||
        next === "`" ||
        next === "\n" ||
        (opts.doubleQuoted && next === '"')
      ) {
        if (next !== "\n") out += next;
        i += 2;
      } else {
        out += ch;
        i++;
      }
      continue;
    }
    if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
      const end = text.indexOf("))", i + 3);
      if (end < 0) throw new Error("shell: unmatched arithmetic expansion in here-document");
      out += arithmetic(text.slice(i + 3, end), ctx);
      i = end + 2;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const end = findMatching(text, i + 1, "(", ")");
      if (end < 0) throw new Error("shell: unmatched command substitution in here-document");
      const sub = await ctx.commandSubstitution(text.slice(i + 2, end));
      out += sub.stdout.replace(/\n$/, "");
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) throw new Error("shell: unmatched command substitution in here-document");
      const sub = await ctx.commandSubstitution(text.slice(i + 1, end));
      out += sub.stdout.replace(/\n$/, "");
      i = end + 1;
      continue;
    }
    if (ch === "$" && text[i + 1] === "{") {
      const end = findMatching(text, i + 1, "{", "}");
      if (end < 0) throw new Error("shell: unmatched parameter expansion in here-document");
      out += expandParameter(text.slice(i, end + 1), ctx);
      i = end + 1;
      continue;
    }
    if (ch === "$" && i + 1 < text.length) {
      const next = text[i + 1];
      if (!/\d/.test(next) && !/[?!@$#]/.test(next) && !/[a-zA-Z_]/.test(next)) {
        out += ch;
        i++;
        continue;
      }
      let end = i + 2;
      if (!/\d/.test(next) && !/[?!@$#]/.test(next)) {
        while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) end++;
      }
      out += lookupParameter(text.slice(i + 1, end), ctx);
      i = end;
      continue;
    }
    out += ch;
    i++;
    if (out.length > ctx.limits.maxExpansionBytes) {
      throw new ShellLimitError("maxExpansionBytes", "shell: here-document expansion limit exceeded");
    }
  }
  return out;
}
