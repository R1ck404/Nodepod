import type { MemoryVolume } from "../memory-volume.js";
import { expandGlob } from "./shell-parser.js";
import type { ShellLimits } from "./shell-options.js";
import { ShellLimitError } from "./shell-options.js";
import { ArithmeticError, evaluateArithmetic } from "./bash-arithmetic.js";
import type { ArithmeticScope } from "./bash-arithmetic.js";

export interface BashExpansionContext {
  env: Record<string, string>;
  cwd: string;
  volume: MemoryVolume;
  lastExit: number;
  positional: string[];
  lastBackgroundPid: number;
  /** `$$`: the shell's process ID. */
  pid?: number;
  /** `$PPID`. */
  ppid?: number;
  /** When the shell started, for `$SECONDS`. */
  startedAt?: number;
  shellName?: string;
  pipeStatuses: number[];
  nounset?: boolean;
  limits: ShellLimits;
  globOptions?: { enabled?: boolean; nullglob?: boolean; dotglob?: boolean; globstar?: boolean };
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
    } else if (word[i] === "$" && (word[i + 1] === "{" || word[i + 1] === "(")) {
      // `${x,}` and `$(…)` are expansions, not brace lists
      const end = findMatching(word, i + 1, word[i + 1], word[i + 1] === "{" ? "}" : ")");
      if (end < 0) return [word];
      i = end;
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

// `{1..5}`, `{01..10..2}` (zero padding follows the widest end) and
// `{a..e}` (single characters).
function expandRange(body: string, limit: number): string[] {
  const letters = body.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
  const match = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (!match && !letters) return body.split(",");
  const start = letters ? letters[1].charCodeAt(0) : parseInt(match![1], 10);
  const end = letters ? letters[2].charCodeAt(0) : parseInt(match![2], 10);
  const step = parseInt((letters ? letters[3] : match![3]) ?? "1", 10) || 1;
  const actualStep = start <= end ? Math.abs(step) : -Math.abs(step);
  const count = Math.floor(Math.abs(end - start) / Math.abs(actualStep)) + 1;
  if (!Number.isSafeInteger(count) || count > limit) {
    throw new ShellLimitError("maxExpansionBytes", "shell: brace expansion limit exceeded");
  }
  const padded = match && /^-?0\d/.test(match[1]) || match && /^-?0\d/.test(match[2]);
  const width = match ? Math.max(match[1].length, match[2].length) : 0;
  const format = (n: number): string => {
    if (letters) return String.fromCharCode(n);
    if (!padded) return String(n);
    const digits = String(Math.abs(n)).padStart(n < 0 ? width - 1 : width, "0");
    return n < 0 ? `-${digits}` : digits;
  };
  const values: string[] = [];
  if (actualStep > 0) {
    for (let n = start; n <= end; n += actualStep) values.push(format(n));
  } else {
    for (let n = start; n >= end; n += actualStep) values.push(format(n));
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

// Arrays are stored in the environment as `name[key]` entries, with
// `name[@]` holding the elements joined by spaces and `name` the first.
export function arrayKeys(env: Record<string, string>, name: string): string[] {
  const prefix = `${name}[`;
  const keys: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix) && key.endsWith("]")) {
      const inner = key.slice(prefix.length, -1);
      if (inner !== "@" && inner !== "*") keys.push(inner);
    }
  }
  if (keys.every((key) => /^\d+$/.test(key))) keys.sort((a, b) => Number(a) - Number(b));
  return keys;
}

export function arrayValues(env: Record<string, string>, name: string): string[] {
  const keys = arrayKeys(env, name);
  if (keys.length === 0) return env[name] === undefined ? [] : [env[name]];
  return keys.map((key) => env[`${name}[${key}]`]);
}

/** Replaces the array `name` with `values`, indexed from 0. */
export function setArray(env: Record<string, string>, name: string, values: string[]): void {
  for (const key of arrayKeys(env, name)) delete env[`${name}[${key}]`];
  values.forEach((value, index) => { env[`${name}[${index}]`] = value; });
  syncArray(env, name);
}

/** Refreshes `name[@]` and `name` after an element of the array changed. */
export function syncArray(env: Record<string, string>, name: string): void {
  const keys = arrayKeys(env, name);
  if (keys.length === 0) {
    delete env[`${name}[@]`];
    return;
  }
  env[`${name}[@]`] = keys.map((key) => env[`${name}[${key}]`]).join(" ");
  const first = env[`${name}[0]`];
  if (first !== undefined) env[name] = first;
  else if (!/^\d+$/.test(keys[0])) delete env[name];
}

// The key a subscript names: a number, an associative key, or a variable
// holding the index (`${arr[i]}`).
function subscriptKey(base: string, index: string, ctx: BashExpansionContext): string {
  if (/^-?\d+$/.test(index)) {
    const n = parseInt(index, 10);
    if (n >= 0) return String(n);
    const keys = arrayKeys(ctx.env, base);
    const last = keys.length ? Number(keys[keys.length - 1]) : -1;
    return String(last + 1 + n);
  }
  if (`${base}[${index}]` in ctx.env) return index;
  // an indexed array's subscript is arithmetic: `${arr[i]}`, `${arr[i+1]}`
  try {
    const n = Number(arithmetic(index, ctx));
    return n >= 0 ? String(n) : subscriptKey(base, String(n), ctx);
  } catch {
    return index;
  }
}

// Variables bash sets in every shell without exporting them, so they stay
// out of the environment programs see.
function shellVariable(name: string, ctx: BashExpansionContext): string | undefined {
  switch (name) {
    case "RANDOM": return String(Math.floor(Math.random() * 32768));
    case "UID":
    case "EUID": return "1000";
    case "PPID": return String(ctx.ppid ?? 1);
    case "BASHPID": return String(ctx.pid ?? 1);
    case "HOSTNAME": return "nodepod";
    case "BASH": return "/bin/bash";
    case "BASH_VERSION": return "5.2.0(1)-release";
    case "SECONDS": return String(Math.floor((Date.now() - (ctx.startedAt ?? Date.now())) / 1000));
  }
  return undefined;
}

function lookupParameter(name: string, ctx: BashExpansionContext): string {
  if (name === "?") return String(ctx.lastExit);
  if (name === "$") return String(ctx.pid ?? 1);
  if (name === "0") return ctx.shellName ?? "nodepod";
  if (name === "#") return String(ctx.positional.length);
  if (name === "!") return ctx.lastBackgroundPid ? String(ctx.lastBackgroundPid) : "";
  if (!(name in ctx.env)) {
    const dynamic = shellVariable(name, ctx);
    if (dynamic !== undefined) return dynamic;
  }
  if (name === "PIPESTATUS") return ctx.pipeStatuses.join(" ");
  if (name === "@" || name === "*") return ctx.positional.join(" ");
  const array = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (array) {
    const base = array[1];
    const index = array[2];
    if (base === "PIPESTATUS") {
      return index === "@" || index === "*" ? ctx.pipeStatuses.join(" ") : String(ctx.pipeStatuses[Number(index)] ?? "");
    }
    if (index === "@" || index === "*") return arrayValues(ctx.env, base).join(" ");
    const key = subscriptKey(base, index, ctx);
    if (key === "0" && arrayKeys(ctx.env, base).length === 0) return ctx.env[base] ?? "";
    return ctx.env[`${base}[${key}]`] ?? "";
  }
  if (/^\d+$/.test(name)) return ctx.positional[parseInt(name, 10) - 1] ?? "";
  if (ctx.nounset && !(name in ctx.env)) {
    if (shellVariable(name, ctx) !== undefined) return shellVariable(name, ctx)!;
    throw new UnboundVariableError(name);
  }
  return ctx.env[name] ?? "";
}

/** `set -u` and an unset variable: a non-interactive shell exits with 127. */
export class UnboundVariableError extends Error {
  constructor(readonly variable: string) {
    super(`shell: ${variable}: unbound variable`);
  }
}

// A glob pattern as a regular expression source, for `${x#pat}`, `${x/pat/rep}`.
function patternSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (ch === "*") {
      out += "[\\s\\S]*";
      while (pattern[i + 1] === "*") i++;
    } else if (ch === "?") {
      out += "[\\s\\S]";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end < 0) { out += "\\["; continue; }
      let cls = pattern.slice(i + 1, end);
      if (cls.startsWith("!")) cls = "^" + cls.slice(1);
      out += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  return out;
}

// Splits `pat/rep` at the first `/` that is not escaped or quoted.
function splitReplacement(text: string): [string, string | undefined] {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "/") return [text.slice(0, i), text.slice(i + 1)];
  }
  return [text, undefined];
}

// The words inside `${...}` (fallbacks, patterns, replacements) expand
// like a quoted word: parameters, substitutions and quote removal, no
// splitting.
async function expandOperand(text: string, ctx: BashExpansionContext): Promise<string> {
  if (!/[$`'"\\~]/.test(text)) return text;
  return (await expandPart(expandTilde(text, ctx), ctx)).value;
}

const NAME = String.raw`[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?|\d+|[@*?#$!]`;

async function expandParameter(raw: string, ctx: BashExpansionContext): Promise<string> {
  if (!raw.startsWith("${") || !raw.endsWith("}")) return lookupParameter(raw.slice(1), ctx);
  const body = raw.slice(2, -1);
  if (body === "#" || body === "!" || body === "$" || body === "?") return lookupParameter(body, ctx);

  const length = body.match(/^#([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (length) return String(arrayValues(ctx.env, length[1]).length);
  if (body === "#@" || body === "#*") return String(ctx.positional.length);
  if (body.startsWith("#") && new RegExp(`^#(?:${NAME})$`).test(body)) {
    return String(lookupParameter(body.slice(1), ctx).length);
  }

  const keys = body.match(/^!([a-zA-Z_][a-zA-Z0-9_]*)\[([@*])\]$/);
  if (keys) {
    const found = arrayKeys(ctx.env, keys[1]);
    return (found.length === 0 && ctx.env[keys[1]] !== undefined ? ["0"] : found).join(" ");
  }
  const indirect = body.match(/^!([a-zA-Z_][a-zA-Z0-9_]*)$/);
  if (indirect) {
    const target = lookupParameter(indirect[1], ctx);
    return target ? lookupParameter(target, ctx) : "";
  }

  const caseModifier = body.match(new RegExp(`^(${NAME})(\\^\\^|\\^|,,|,)$`));
  if (caseModifier) {
    const value = lookupParameter(caseModifier[1], ctx);
    const all = caseModifier[2].length === 2;
    const upper = caseModifier[2].startsWith("^");
    if (all) return upper ? value.toUpperCase() : value.toLowerCase();
    return (upper ? value.charAt(0).toUpperCase() : value.charAt(0).toLowerCase()) + value.slice(1);
  }

  const patternModifier = body.match(new RegExp(`^(${NAME})(##|#|%%|%)([\\s\\S]*)$`));
  if (patternModifier) {
    const [, name, op, rawPattern] = patternModifier;
    const value = lookupParameter(name, ctx);
    const pattern = await expandOperand(rawPattern, ctx);
    if (!pattern) return value;
    if ((value.length + 1) * (value.length + 1) > ctx.limits.maxLoopIterations) {
      throw new ShellLimitError("maxLoopIterations", "shell: parameter pattern operation limit exceeded");
    }
    const whole = new RegExp(`^(?:${patternSource(pattern)})$`);
    const n = value.length;
    if (op === "#") { for (let k = 0; k <= n; k++) if (whole.test(value.slice(0, k))) return value.slice(k); }
    if (op === "##") { for (let k = n; k >= 0; k--) if (whole.test(value.slice(0, k))) return value.slice(k); }
    if (op === "%") { for (let k = n; k >= 0; k--) if (whole.test(value.slice(k))) return value.slice(0, k); }
    if (op === "%%") { for (let k = 0; k <= n; k++) if (whole.test(value.slice(k))) return value.slice(0, k); }
    return value;
  }

  const replacement = body.match(new RegExp(`^(${NAME})\\/(\\/|#|%)?([\\s\\S]*)$`));
  if (replacement) {
    const [, name, mode, rest] = replacement;
    const value = lookupParameter(name, ctx);
    const [rawPattern, rawReplacement] = splitReplacement(rest);
    const pattern = await expandOperand(rawPattern, ctx);
    if (!pattern) return value;
    const with_ = rawReplacement === undefined ? "" : await expandOperand(rawReplacement, ctx);
    const source = patternSource(pattern);
    const regex = new RegExp(mode === "#" ? `^(?:${source})` : mode === "%" ? `(?:${source})$` : source, mode === "/" ? "g" : "");
    return value.replace(regex, () => with_);
  }

  const operator = body.match(new RegExp(`^(${NAME})(:?[-+=?])([\\s\\S]*)$`));
  if (operator) {
    const [, name, op, rawFallback] = operator;
    const value = lookupParameter(name, ctx);
    const isSet = /^\d+$/.test(name) ? Number(name) <= ctx.positional.length
      : name === "@" || name === "*" ? ctx.positional.length > 0
        : ctx.env[name] !== undefined || (name.includes("[") && value !== "");
    const empty = value.length === 0;
    if ((op === "-" && !isSet) || (op === ":-" && empty)) return expandOperand(rawFallback, ctx);
    if ((op === "+" && isSet) || (op === ":+" && !empty)) return expandOperand(rawFallback, ctx);
    if (op === "+" || op === ":+") return "";
    if (op === "=" || op === ":=") {
      if (!isSet || (op === ":=" && empty)) ctx.env[name] = await expandOperand(rawFallback, ctx);
      return ctx.env[name] ?? value;
    }
    if (op === "?" || op === ":?") {
      if (!isSet || (op === ":?" && empty)) {
        const message = rawFallback ? await expandOperand(rawFallback, ctx) : "parameter null or not set";
        throw new Error(`shell: ${name}: ${message}`);
      }
    }
    return value;
  }

  // Bash substring syntax: ${var:offset[:length]}.
  const slice = body.match(new RegExp(`^(${NAME}):([^:]*)(?::([\\s\\S]*))?$`));
  if (slice) {
    const value = lookupParameter(slice[1], ctx);
    let start = Number(await expandArithmetic(slice[2] || "0", ctx));
    if (start < 0) start = Math.max(0, value.length + start);
    if (slice[3] === undefined) return value.slice(start);
    const len = Number(await expandArithmetic(slice[3] || "0", ctx));
    return len < 0 ? value.slice(start, value.length + len) : value.slice(start, start + len);
  }

  if (!new RegExp(`^(?:${NAME})$`).test(body)) throw new Error(`shell: \${${body}}: bad substitution`);
  return lookupParameter(body, ctx);
}

function arithmetic(expression: string, ctx: BashExpansionContext): string {
  if (expression.length > Math.min(ctx.limits.maxExpansionBytes, ctx.limits.maxLoopIterations)) {
    throw new ShellLimitError("maxLoopIterations", "shell: arithmetic expression limit exceeded");
  }
  const scope: ArithmeticScope = {
    get: (name) => {
      const element = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(\d+)\]$/);
      if (element && element[2] === "0" && arrayKeys(ctx.env, element[1]).length === 0) return ctx.env[element[1]];
      if (!(name in ctx.env) && shellVariable(name, ctx) !== undefined) return shellVariable(name, ctx);
      if (!element && ctx.nounset && !(name in ctx.env)) throw new UnboundVariableError(name);
      return ctx.env[name];
    },
    set: (name, value) => {
      ctx.env[name] = value;
      const element = name.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[/);
      if (element) syncArray(ctx.env, element[1]);
      else if (arrayKeys(ctx.env, name).length > 0) {
        ctx.env[`${name}[0]`] = value;
        syncArray(ctx.env, name);
      }
    },
  };
  try {
    return String(evaluateArithmetic(expression, scope, ctx.limits.maxRecursionDepth));
  } catch (error) {
    if (error instanceof ArithmeticError) throw new Error(`shell: ${expression.trim()}: ${error.message}`);
    throw error;
  }
}

/** Expands and evaluates the text of `(( ))`, `for (( ;; ))` or `let`. */
export async function evaluateArithmeticText(expression: string, ctx: BashExpansionContext): Promise<number> {
  return Number(await expandArithmetic(expression, ctx));
}

// The index of the last `)` of the `$(( ... ))` at `start`, matching nested
// parentheses so `$(( $(cmd) + 1 ))` and `$(( (1 + 2) * 3 ))` end at the
// right place, or -1.
function arithmeticEnd(text: string, start: number): number {
  const end = findMatching(text, start + 1, "(", ")");
  return end > start + 2 && text[end - 1] === ")" ? end : -1;
}

// Parameters and command substitutions inside `$(( ))` expand before the
// expression is evaluated, as in bash.
async function expandArithmetic(expression: string, ctx: BashExpansionContext): Promise<string> {
  const expanded = /[$`]/.test(expression) ? await expandInner(expression, ctx, false) : expression;
  return arithmetic(expanded, ctx);
}

// `escapeQuoted` rewrites quoted and backslash-escaped text, so a pattern
// keeps `"*"` literal while an unquoted `*` still matches.
async function expandPart(raw: string, ctx: BashExpansionContext, escapeQuoted?: (text: string) => string): Promise<{
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
      out += escapeQuoted ? escapeQuoted(raw.slice(i + 1, end)) : raw.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      const end = findQuoteEnd(raw, i, '"');
      if (end < 0) throw new Error("shell: unmatched double quote");
      preserveEmpty = true;
      const inner = await expandInner(raw.slice(i + 1, end), ctx, false);
      out += escapeQuoted ? escapeQuoted(inner) : inner;
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < raw.length) out += escapeQuoted ? escapeQuoted(raw[i + 1]) : raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "(" && raw[i + 2] === "(") {
      const end = arithmeticEnd(raw, i);
      if (end < 0) throw new Error("shell: unmatched arithmetic expansion");
      out += await expandArithmetic(raw.slice(i + 3, end - 1), ctx);
      split = true;
      i = end + 1;
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
      out += await expandParameter(raw.slice(i, end + 1), ctx);
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
    if (ch === "*" || ch === "?" || ch === "[") glob = true;
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
  if (quotedArray) return arrayValues(ctx.env, quotedArray[1]);
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
          globstar: ctx.globOptions?.globstar,
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

/** One word expanded without splitting or globbing: `case` words and `[[ ]]` operands. */
export async function expandText(raw: string, ctx: BashExpansionContext): Promise<string> {
  return (await expandPart(expandTilde(raw, ctx), ctx)).value;
}

/** A pattern word (`case`, `[[ == ]]`): quoted characters come back backslash-escaped. */
export async function expandPattern(raw: string, ctx: BashExpansionContext): Promise<string> {
  return (await expandPart(expandTilde(raw, ctx), ctx, (text) => text.replace(/[*?[\]\\]/g, "\\$&"))).value;
}

/** The right side of `[[ =~ ]]`: quoted characters match themselves. */
export async function expandRegex(raw: string, ctx: BashExpansionContext): Promise<string> {
  return (await expandPart(raw, ctx, (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))).value;
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
      const end = arithmeticEnd(text, i);
      if (end < 0) throw new Error("shell: unmatched arithmetic expansion in here-document");
      out += await expandArithmetic(text.slice(i + 3, end - 1), ctx);
      i = end + 1;
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
      out += await expandParameter(text.slice(i, end + 1), ctx);
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
