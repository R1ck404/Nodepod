import type { BuiltinFn, ShellContext } from "../shell-types.js";
import { ok, fail, resolvePath, regexSafetyError } from "../shell-helpers.js";
import { posixToJs } from "../posix-regex.js";

// GNU sed: scripts from -e, -f or the first operand; addresses (`N`, `$`,
// `/re/`, `first~step`, ranges with `N`, `/re/`, `+N`, `~N` and `0,/re/`, `!`);
// blocks; s with `&`, `\1`–`\9`, `\n`, `\U` `\L` `\u` `\l` `\E` and the flags
// g, p, N, i, m, w; y; a, i, c (one-line and `a\` forms); d, D, p, P, n, N,
// g, G, h, H, x, z, =, l, q, Q, b, t, T, :label, r, w, F. Basic regular
// expressions by default, extended with -E or -r.

type Address =
  | { kind: "line"; n: number }
  | { kind: "last" }
  | { kind: "zero" }
  | { kind: "step"; first: number; step: number }
  | { kind: "re"; re: RegExp | null };
type EndAddress = Address | { kind: "plus"; n: number } | { kind: "multiple"; n: number };

type Part =
  | { kind: "text"; text: string }
  | { kind: "group"; n: number }
  | { kind: "case"; mode: "U" | "L" | "E" | "u" | "l" };

interface Command {
  name: string;
  a1?: Address;
  a2?: EndAddress;
  negate: boolean;
  // range state
  active?: boolean;
  endLine?: number;
  // arguments
  text?: string;
  label?: string;
  target?: number;
  re?: RegExp | null;
  parts?: Part[];
  global?: boolean;
  occurrence?: number;
  print?: number;
  file?: string;
  from?: string;
  to?: string;
  code?: number;
}

class SedError extends Error {}

function parseScript(script: string, extended: boolean, regexLimit: number): Command[] {
  const commands: Command[] = [];
  const blocks: number[] = [];
  let i = 0;
  const error = (message: string): never => {
    throw new SedError(`-e expression #1, char ${i}: ${message}`);
  };
  const compile = (source: string, flags: string): RegExp | null => {
    if (source === "") return null;
    const safety = regexSafetyError(source, regexLimit);
    if (safety) error(safety);
    try { return new RegExp(posixToJs(source, extended), flags); }
    catch (e) { return error(e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : "invalid regular expression"); }
  };
  // reads to an unescaped `delim`; `\delim` becomes delim and `\n` a newline
  // (outside a regex, where the translator keeps it)
  const delimited = (delim: string, forRegex: boolean, unterminated = "unterminated address regex"): string => {
    let text = "";
    let inBracket = false;
    while (i < script.length) {
      const ch = script[i];
      if (forRegex && ch === "[" && !inBracket) {
        inBracket = true;
        text += ch;
        i++;
        if (script[i] === "^") { text += script[i++]; }
        if (script[i] === "]") { text += script[i++]; }
        continue;
      }
      if (inBracket) {
        if (ch === "]") inBracket = false;
        text += ch;
        i++;
        continue;
      }
      if (ch === "\\") {
        const next = script[i + 1];
        if (next === undefined) break;
        if (next === delim) text += delim === "&" && !forRegex ? "\\&" : delim;
        else if (next === "\n") text += forRegex ? "\\n" : "\n";
        else if (next === "n" && !forRegex) text += "\n";
        else text += "\\" + next;
        i += 2;
        continue;
      }
      if (ch === delim) { i++; return text; }
      if (ch === "\n" && forRegex) break;
      text += ch;
      i++;
    }
    return error(unterminated);
  };
  const skipBlanks = () => { while (script[i] === " " || script[i] === "\t") i++; };
  const number = (): number => {
    const m = script.slice(i).match(/^\d+/);
    if (!m) return error("expected a number");
    i += m[0].length;
    return Number(m[0]);
  };
  const regexAddress = (): Address => {
    let delim = "/";
    if (script[i] === "\\") { delim = script[i + 1]; i += 2; }
    else i++;
    const source = delimited(delim, true);
    let flags = "s";
    while (script[i] === "I" || script[i] === "M") {
      flags += script[i] === "I" ? "i" : "m";
      i++;
    }
    return { kind: "re", re: compile(source, flags) };
  };
  const address = (): Address | undefined => {
    const ch = script[i];
    if (ch === "$") { i++; return { kind: "last" }; }
    if (ch === "/" || ch === "\\") return regexAddress();
    if (ch !== undefined && /\d/.test(ch)) {
      const n = number();
      if (script[i] === "~") {
        i++;
        return { kind: "step", first: n, step: number() };
      }
      return n === 0 ? { kind: "zero" } : { kind: "line", n };
    }
    return undefined;
  };
  const toEndOfLine = (): string => {
    const end = script.indexOf("\n", i);
    const text = script.slice(i, end < 0 ? script.length : end);
    i = end < 0 ? script.length : end;
    return text;
  };
  // a, i, c text: `a\` then lines, or `a text`; a backslash before a newline
  // continues the text, and other backslashes are dropped
  const commandText = (): string => {
    skipBlanks();
    if (script[i] === "\\") {
      i++;
      if (script[i] === "\n") i++;
      else skipBlanks();
    }
    let text = "";
    while (i < script.length && script[i] !== "\n") {
      if (script[i] === "\\" && i + 1 < script.length) {
        text += script[i + 1];
        i += 2;
        continue;
      }
      text += script[i++];
    }
    return text;
  };
  const label = (): string => {
    skipBlanks();
    let text = "";
    while (i < script.length && script[i] !== "\n" && script[i] !== ";") text += script[i++];
    return text.trim();
  };
  const replacement = (text: string): Part[] => {
    const parts: Part[] = [];
    let literal = "";
    const flush = () => { if (literal) parts.push({ kind: "text", text: literal }); literal = ""; };
    for (let j = 0; j < text.length; j++) {
      const ch = text[j];
      if (ch === "&") { flush(); parts.push({ kind: "group", n: 0 }); continue; }
      if (ch === "\\" && j + 1 < text.length) {
        const next = text[++j];
        if (/\d/.test(next)) { flush(); parts.push({ kind: "group", n: Number(next) }); }
        else if ("ULEul".includes(next)) { flush(); parts.push({ kind: "case", mode: next as "U" }); }
        else if (next === "n") literal += "\n";
        else if (next === "t") literal += "\t";
        else literal += next;
        continue;
      }
      literal += ch;
    }
    flush();
    return parts;
  };

  while (i < script.length) {
    while (i < script.length && /[\s;]/.test(script[i])) i++;
    if (i >= script.length) break;
    if (script[i] === "#") { toEndOfLine(); continue; }
    const command: Command = { name: "", negate: false };
    command.a1 = address();
    if (command.a1 && script[i] === ",") {
      i++;
      skipBlanks();
      if (script[i] === "+") { i++; command.a2 = { kind: "plus", n: number() }; }
      else if (script[i] === "~") { i++; command.a2 = { kind: "multiple", n: number() }; }
      else {
        const end = address();
        if (!end || end.kind === "zero" || end.kind === "step") error("unexpected `,'");
        command.a2 = end;
      }
    }
    if (command.a1?.kind === "zero" && command.a2?.kind !== "re") error("invalid usage of line address 0");
    skipBlanks();
    while (script[i] === "!") { command.negate = true; i++; skipBlanks(); }
    const name = script[i++];
    if (name === undefined) error("missing command");
    command.name = name;
    switch (name) {
      case "{":
        blocks.push(commands.length);
        commands.push(command);
        continue;
      case "}":
        if (command.a1) error("} doesn't want any addresses");
        if (!blocks.length) error("unexpected `}'");
        commands[blocks.pop()!].target = commands.length + 1;
        commands.push(command);
        break;
      case "=": case "d": case "D": case "g": case "G": case "h": case "H": case "l":
      case "n": case "N": case "p": case "P": case "x": case "z": case "F":
        commands.push(command);
        break;
      case "q": case "Q":
        skipBlanks();
        command.code = /\d/.test(script[i] ?? "") ? number() : 0;
        commands.push(command);
        break;
      case "a": case "i": case "c":
        command.text = commandText();
        commands.push(command);
        break;
      case ":":
        if (command.a1) error(": doesn't want any addresses");
        command.label = label();
        if (!command.label) error("\":\" lacks a label");
        commands.push(command);
        break;
      case "b": case "t": case "T":
        command.label = label();
        commands.push(command);
        break;
      case "r": case "R": case "w": case "W":
        skipBlanks();
        command.file = toEndOfLine();
        if (!command.file) error(`missing filename in r/R/w/W commands`);
        commands.push(command);
        break;
      case "s": {
        const delim = script[i++];
        if (delim === undefined || delim === "\n" || delim === "\\") error("unterminated `s' command");
        const source = delimited(delim, true, "unterminated `s' command");
        const replaced = delimited(delim, false, "unterminated `s' command");
        let flags = "s";
        command.global = false;
        command.print = 0;
        while (i < script.length) {
          const flag = script[i];
          if (flag === "g") command.global = true;
          else if (flag === "p") command.print! += 1;
          else if (flag === "i" || flag === "I") flags += "i";
          else if (flag === "m" || flag === "M") flags += "m";
          else if (/\d/.test(flag)) { command.occurrence = number(); if (command.occurrence === 0) error("number option to `s' command may not be zero"); continue; }
          else if (flag === "w") { i++; skipBlanks(); command.file = toEndOfLine(); break; }
          else if (flag === "e") { /* not supported: runs nothing */ }
          else break;
          i++;
        }
        command.re = compile(source, flags + "g");
        command.parts = replacement(replaced);
        commands.push(command);
        break;
      }
      case "y": {
        const delim = script[i++];
        if (delim === undefined) error("unterminated `y' command");
        const unescape = (text: string) => text.replace(/\\(.)/g, (_, c) => c === "n" ? "\n" : c === "t" ? "\t" : c);
        const from = unescape(delimited(delim, false, "unterminated `y' command"));
        const to = unescape(delimited(delim, false, "unterminated `y' command"));
        if ([...from].length !== [...to].length) error("strings for `y' command are different lengths");
        command.from = from;
        command.to = to;
        commands.push(command);
        break;
      }
      default:
        error(`unknown command: \`${name}'`);
    }
    skipBlanks();
    if (i < script.length && !/[;\n}#]/.test(script[i])) { i++; error(`extra characters after command`); }
  }
  if (blocks.length) { i = script.length; error("unmatched `{'"); }
  const labels = new Map<string, number>();
  commands.forEach((command, index) => {
    if (command.name === ":") labels.set(command.label!, index);
  });
  for (const command of commands) {
    if (command.name === "b" || command.name === "t" || command.name === "T") {
      if (!command.label) command.target = commands.length;
      else if (labels.has(command.label)) command.target = labels.get(command.label);
      else throw new SedError(`-e expression #1, char ${script.length}: can't find label for jump to \`${command.label}'`);
    }
  }
  return commands;
}

function escapeForL(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\x07") out += "\\a";
    else if (ch === "\v") out += "\\v";
    else if (code < 32 || code === 127) out += "\\" + code.toString(8).padStart(3, "0");
    else out += ch;
  }
  return out + "$";
}

interface Input {
  name: string;
  lines: string[];
  // whether the last line ended in a newline
  newlineAtEnd: boolean;
}

function splitInput(name: string, content: string): Input {
  const lines = content.split("\n");
  const newlineAtEnd = content.endsWith("\n");
  if (newlineAtEnd || content === "") lines.pop();
  return { name, lines, newlineAtEnd };
}

interface RunResult {
  output: string;
  exitCode: number;
  quit: boolean;
}

function run(commands: Command[], inputs: Input[], quiet: boolean, ctx: ShellContext, writes: Map<string, string>): RunResult {
  const operationLimit = (ctx.limits?.maxLoopIterations ?? 100_000) * 10;
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  let operations = 0;
  let output = "";
  const emit = (text: string) => {
    output += text;
    if (output.length > outputLimit) throw new SedError(`output limit ${outputLimit} exceeded`);
  };
  const queue: { name: string; line: number }[] = [];
  for (const input of inputs) input.lines.forEach((_, line) => queue.push({ name: input.name, line }));
  const byName = new Map(inputs.map((input) => [input.name, input]));
  let position = 0;
  let lineNumber = 0;
  let current = queue[0];
  const isLast = () => position >= queue.length;
  const next = (): string | undefined => {
    if (position >= queue.length) return undefined;
    current = queue[position++];
    lineNumber++;
    return byName.get(current.name)!.lines[current.line];
  };
  const endsWithNewline = () => {
    const input = byName.get(current.name)!;
    return !isLast() || input.newlineAtEnd || current.line < input.lines.length - 1;
  };
  let lastRegex: RegExp | null = null;
  const regex = (re: RegExp | null | undefined): RegExp => {
    const chosen = re ?? lastRegex;
    if (!chosen) throw new SedError("no previous regular expression");
    lastRegex = chosen;
    return chosen;
  };
  const test = (re: RegExp | null, text: string): boolean => {
    const chosen = regex(re);
    chosen.lastIndex = 0;
    const result = chosen.test(text);
    chosen.lastIndex = 0;
    return result;
  };
  const matches = (address: Address, space: string): boolean => {
    switch (address.kind) {
      case "line": return lineNumber === address.n;
      case "last": return isLast();
      case "zero": return false;
      case "step": return address.step <= 0 ? lineNumber === address.first : lineNumber >= address.first && (lineNumber - address.first) % address.step === 0;
      case "re": return test(address.re, space);
    }
  };
  const selected = (command: Command, space: string): boolean => {
    if (!command.a1) return true;
    if (!command.a2) return matches(command.a1, space);
    const end = command.a2;
    const closes = (): boolean => {
      switch (end.kind) {
        case "line": return lineNumber >= end.n;
        case "plus": return lineNumber >= command.endLine!;
        case "multiple": return end.n <= 0 || lineNumber % end.n === 0;
        default: return matches(end, space);
      }
    };
    if (command.active) {
      if (closes()) command.active = false;
      return true;
    }
    const starts = command.a1.kind === "zero" ? lineNumber === 1 : matches(command.a1, space);
    if (!starts) return false;
    command.active = true;
    if (command.a1.kind === "zero") {
      if (closes()) command.active = false;
      return true;
    }
    if (end.kind === "line" && end.n <= lineNumber) command.active = false;
    else if (end.kind === "plus") { command.endLine = lineNumber + end.n; if (end.n === 0) command.active = false; }
    else if (end.kind === "multiple" && (end.n <= 0 || lineNumber % end.n === 0)) command.active = false;
    return true;
  };
  const substitute = (command: Command, space: string): { text: string; changed: boolean } => {
    const re = regex(command.re);
    re.lastIndex = 0;
    let result = "";
    let last = 0;
    let count = 0;
    let changed = false;
    const wanted = command.occurrence ?? 1;
    let match: RegExpExecArray | null;
    let previousEnd = -1;
    while ((match = re.exec(space)) !== null) {
      if (++operations > operationLimit) throw new SedError(`operation limit exceeded`);
      // as in GNU sed, an empty match right after a match doesn't count
      if (match[0].length === 0 && match.index === previousEnd) {
        if (re.lastIndex >= space.length) break;
        re.lastIndex++;
        continue;
      }
      previousEnd = match.index + match[0].length;
      count++;
      if (count >= wanted) {
        result += space.slice(last, match.index) + expand(command.parts!, match);
        last = match.index + match[0].length;
        changed = true;
        if (!command.global) break;
      }
      if (match[0].length === 0) {
        if (re.lastIndex >= space.length) break;
        re.lastIndex++;
      }
    }
    re.lastIndex = 0;
    return { text: changed ? result + space.slice(last) : space, changed };
  };
  const expand = (parts: Part[], match: RegExpExecArray): string => {
    let out = "";
    let mode: "U" | "L" | "E" = "E";
    let once: "u" | "l" | null = null;
    const add = (text: string) => {
      for (const ch of text) {
        let c = mode === "U" ? ch.toUpperCase() : mode === "L" ? ch.toLowerCase() : ch;
        if (once) { c = once === "u" ? c.toUpperCase() : c.toLowerCase(); once = null; }
        out += c;
      }
    };
    for (const part of parts) {
      if (part.kind === "text") add(part.text);
      else if (part.kind === "group") add(match[part.n] ?? "");
      else if (part.mode === "u" || part.mode === "l") once = part.mode;
      else mode = part.mode;
    }
    return out;
  };

  let hold = "";
  let space = next();
  let exitCode = 0;
  let quit = false;
  while (space !== undefined) {
    let appended = "";
    let autoprint = !quiet;
    let substituted = false;
    let restart = false;
    let pc = 0;
    cycle: while (pc < commands.length) {
      if (++operations > operationLimit) throw new SedError(`operation limit exceeded`);
      const command = commands[pc];
      if (command.name === "}" || command.name === ":") { pc++; continue; }
      if (selected(command, space) === command.negate) {
        pc = command.name === "{" ? command.target! : pc + 1;
        continue;
      }
      switch (command.name) {
        case "{": break;
        case "=": emit(`${lineNumber}\n`); break;
        case "a": appended += command.text + "\n"; break;
        case "i": emit(command.text + "\n"); break;
        case "c":
          if (!command.a2 || !command.active || command.negate) emit(command.text + "\n");
          autoprint = false;
          break cycle;
        case "d": autoprint = false; break cycle;
        case "D": {
          const newline = space.indexOf("\n");
          if (newline < 0) { autoprint = false; break cycle; }
          space = space.slice(newline + 1);
          autoprint = false;
          restart = true;
          break cycle;
        }
        case "g": space = hold; break;
        case "G": space += "\n" + hold; break;
        case "h": hold = space; break;
        case "H": hold += "\n" + space; break;
        case "x": [space, hold] = [hold, space]; break;
        case "z": space = ""; break;
        case "l": emit(escapeForL(space) + "\n"); break;
        case "F": emit((current.name === "" ? "-" : current.name) + "\n"); break;
        case "p": emit(space + "\n"); break;
        case "P": emit(space.split("\n")[0] + "\n"); break;
        case "n": {
          if (isLast()) { if (quiet) autoprint = false; break cycle; }
          if (!quiet) emit(space + "\n");
          emit(appended);
          appended = "";
          space = next()!;
          break;
        }
        case "N": {
          if (isLast()) break cycle;
          space += "\n" + next()!;
          break;
        }
        case "q": exitCode = command.code ?? 0; quit = true; break cycle;
        case "Q": exitCode = command.code ?? 0; quit = true; autoprint = false; break cycle;
        case "b": pc = command.target!; continue cycle;
        case "t":
          if (substituted) { substituted = false; pc = command.target!; continue cycle; }
          break;
        case "T":
          if (!substituted) { pc = command.target!; continue cycle; }
          substituted = false;
          break;
        case "r":
        case "R": {
          try {
            const content = ctx.volume.readFileSync(resolvePath(command.file!, ctx.cwd), "utf8");
            appended += command.name === "R" ? (content.split("\n")[0] + "\n") : content.endsWith("\n") || !content ? content : content + "\n";
          } catch { /* a missing file is ignored, as in GNU sed */ }
          break;
        }
        case "w":
        case "W":
          writes.set(command.file!, (writes.get(command.file!) ?? "") + (command.name === "W" ? space.split("\n")[0] : space) + "\n");
          break;
        case "s": {
          const result = substitute(command, space);
          if (result.changed) {
            space = result.text;
            substituted = true;
            for (let p = 0; p < command.print!; p++) emit(space + "\n");
            if (command.file) writes.set(command.file, (writes.get(command.file) ?? "") + space + "\n");
          }
          break;
        }
        case "y": {
          const from = [...command.from!];
          const to = [...command.to!];
          space = [...space].map((ch) => { const index = from.indexOf(ch); return index >= 0 ? to[index] : ch; }).join("");
          break;
        }
      }
      pc++;
    }
    if (autoprint) emit(space + (endsWithNewline() ? "\n" : ""));
    emit(appended);
    if (quit) break;
    if (restart && space !== "") continue;
    space = next();
  }
  return { output, exitCode, quit };
}

const USAGE = "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n";

export const sed_cmd: BuiltinFn = (args, ctx, stdin) => {
  let quiet = false;
  let extended = false;
  let inPlace: string | null = null;
  let separate = false;
  const scripts: string[] = [];
  const files: string[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!options || arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "--") { options = false; continue; }
    if (arg === "--help") return ok(USAGE);
    if (arg === "--quiet" || arg === "--silent") { quiet = true; continue; }
    if (arg === "--regexp-extended") { extended = true; continue; }
    if (arg === "--separate") { separate = true; continue; }
    if (arg === "--posix" || arg === "--unbuffered" || arg === "--debug" || arg === "--sandbox") continue;
    if (arg.startsWith("--expression=")) { scripts.push(arg.slice(13)); continue; }
    if (arg === "--expression") { scripts.push(args[++index] ?? ""); continue; }
    if (arg.startsWith("--in-place")) { inPlace = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : ""; separate = true; continue; }
    if (arg.startsWith("--file")) {
      const file = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
      try { scripts.push(ctx.volume.readFileSync(resolvePath(file ?? "", ctx.cwd), "utf8").replace(/\n$/, "")); }
      catch { return fail(`sed: couldn't open file ${file}: No such file or directory\n`); }
      continue;
    }
    if (arg.startsWith("--")) return fail(`sed: unknown option -- '${arg.slice(2)}'\n${USAGE}`);
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (flag === "n") quiet = true;
      else if (flag === "E" || flag === "r") extended = true;
      else if (flag === "s") separate = true;
      else if (flag === "u" || flag === "z") continue;
      else if (flag === "i") { inPlace = arg.slice(j + 1); separate = true; break; }
      else if (flag === "e" || flag === "f") {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++index];
        if (value === undefined) return fail(`sed: option requires an argument -- '${flag}'\n${USAGE}`);
        if (flag === "e") scripts.push(value);
        else {
          try { scripts.push(ctx.volume.readFileSync(resolvePath(value, ctx.cwd), "utf8").replace(/\n$/, "")); }
          catch { return fail(`sed: couldn't open file ${value}: No such file or directory\n`); }
        }
        break;
      } else return fail(`sed: invalid option -- '${flag}'\n${USAGE}`);
    }
  }
  if (!scripts.length) {
    if (!files.length) return fail(USAGE);
    scripts.push(files.shift()!);
  }
  const script = scripts.join("\n");
  if (/^#n\n?/.test(script) && (script.length === 2 || script[2] === "\n")) quiet = true;

  let commands: Command[];
  try { commands = parseScript(script, extended, Math.min(ctx.limits?.maxExpansionBytes ?? 1024 * 1024, 64 * 1024)); }
  catch (error) { return fail(`sed: ${error instanceof Error ? error.message : String(error)}\n`); }

  const inputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  let stderr = "";
  let status = 0;
  const inputs: Input[] = [];
  if (!files.length) {
    if (inPlace !== null) return fail("sed: no input files\n", 1);
    inputs.push(splitInput("", stdin ?? ""));
  } else {
    for (const file of files) {
      if (file === "-") { inputs.push(splitInput("-", stdin ?? "")); continue; }
      try {
        const content = ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8");
        if (content.length > inputLimit) return fail(`sed: input limit ${inputLimit} exceeded\n`);
        inputs.push(splitInput(file, content));
      } catch {
        let directory = false;
        try { directory = ctx.volume.statSync(resolvePath(file, ctx.cwd)).isDirectory(); } catch { /* missing */ }
        stderr += directory ? `sed: couldn't edit ${file}: not a regular file\n` : `sed: can't read ${file}: No such file or directory\n`;
        status = 2;
      }
    }
  }

  const writes = new Map<string, string>();
  for (const command of commands) if (command.file && (command.name === "w" || command.name === "W" || command.name === "s")) writes.set(command.file, "");
  let stdout = "";
  try {
    const groups = separate ? inputs.map((input) => [input]) : [inputs];
    for (const group of groups) {
      for (const command of commands) { command.active = false; command.endLine = undefined; }
      const result = run(commands, group, quiet, ctx, writes);
      if (inPlace !== null && group[0]?.name && group[0].name !== "-") {
        const path = resolvePath(group[0].name, ctx.cwd);
        if (inPlace) {
          const backup = inPlace.includes("*") ? inPlace.replace(/\*/g, group[0].name) : group[0].name + inPlace;
          ctx.volume.writeFileSync(resolvePath(backup, ctx.cwd), ctx.volume.readFileSync(path));
        }
        ctx.volume.writeFileSync(path, result.output);
      } else {
        stdout += result.output;
      }
      if (result.quit) { status = result.exitCode; break; }
    }
  } catch (error) {
    return { stdout, stderr: stderr + `sed: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 4 };
  }
  for (const [file, content] of writes) {
    if (file === "/dev/stdout") { stdout += content; continue; }
    if (file === "/dev/stderr") { stderr += content; continue; }
    try { ctx.volume.writeFileSync(resolvePath(file, ctx.cwd), content); }
    catch { stderr += `sed: couldn't open file ${file}: No such file or directory\n`; status = 4; }
  }
  return { stdout, stderr, exitCode: status };
};
