import type { BuiltinFn, ShellContext, ShellResult } from "../shell-types.js";
import {
  fail,
  resolvePath,
  globToRegex,
  RESET,
  GREEN,
  MAGENTA,
  CYAN,
  BOLD_RED,
  yieldToEventLoop,
  regexSafetyError,
} from "../shell-helpers.js";
import { posixToJs } from "../posix-regex.js";

// GNU grep: basic regular expressions by default (-E extended, -F fixed,
// -P JavaScript's), several -e patterns, -i -v -w -x -c -l -L -n -o -q -s
// -H -h -m -A -B -C, -r over folders (from `.` without operands) with
// --include, --exclude and --exclude-dir; colors only on a terminal unless
// --color says otherwise. Exit status 0 when a line is selected, 1 when none
// is, 2 on an error (0 with -q once a line is selected).

type Syntax = "basic" | "extended" | "fixed" | "perl";

interface GrepOptions {
  regex: RegExp;
  global: RegExp;
  invert: boolean;
  count: boolean;
  filesWithMatches: boolean;
  filesWithout: boolean;
  lineNumbers: boolean;
  onlyMatching: boolean;
  quiet: boolean;
  before: number;
  after: number;
  maxCount: number;
  color: boolean;
  maxOutputBytes: number;
  maxInputBytes: number;
  maxLoopIterations: number;
  work: number;
}

interface FileResult {
  text: string;
  hits: number;
}

const USAGE = "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n";

function paint(on: boolean, code: string, text: string): string {
  return on ? `${code}${text}${RESET}` : text;
}

function searchText(content: string, opts: GrepOptions, label: string | undefined): FileResult {
  if (content.length > opts.maxInputBytes) throw new Error("input limit exceeded");
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  if (opts.work + lines.length > opts.maxLoopIterations) throw new Error("operation limit exceeded");
  opts.work += lines.length;

  const matched: number[] = [];
  for (let i = 0; i < lines.length && matched.length < opts.maxCount; i++) {
    opts.regex.lastIndex = 0;
    if (opts.regex.test(lines[i]) !== opts.invert) matched.push(i);
  }
  const hits = matched.length;
  const name = (separator: string) => label === undefined ? "" : paint(opts.color, MAGENTA, label) + paint(opts.color, CYAN, separator);

  if (opts.quiet) return { text: "", hits };
  if (opts.filesWithMatches) return { text: hits ? paint(opts.color, MAGENTA, label ?? "(standard input)") + "\n" : "", hits };
  if (opts.filesWithout) return { text: hits ? "" : paint(opts.color, MAGENTA, label ?? "(standard input)") + "\n", hits };
  if (opts.count) return { text: `${name(":")}${hits}\n`, hits };

  const shown = new Map<number, boolean>();
  const lastShown = matched.length ? matched[matched.length - 1] + opts.after : -1;
  for (const index of matched) {
    for (let j = Math.max(0, index - opts.before); j <= Math.min(lines.length - 1, index + opts.after); j++) {
      if (++opts.work > opts.maxLoopIterations) throw new Error("operation limit exceeded");
      if (!shown.has(j)) shown.set(j, false);
    }
    shown.set(index, true);
  }
  let text = "";
  let previous = -1;
  const context = opts.before > 0 || opts.after > 0;
  for (const index of [...shown.keys()].sort((a, b) => a - b)) {
    if (index > lastShown) break;
    const isMatch = shown.get(index)!;
    if (context && previous >= 0 && index > previous + 1) text += paint(opts.color, CYAN, "--") + "\n";
    previous = index;
    const separator = isMatch ? ":" : "-";
    const prefix = name(separator) + (opts.lineNumbers ? paint(opts.color, GREEN, String(index + 1)) + paint(opts.color, CYAN, separator) : "");
    const line = lines[index];
    if (opts.onlyMatching) {
      if (!isMatch || opts.invert) continue;
      opts.global.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = opts.global.exec(line)) !== null) {
        if (++opts.work > opts.maxLoopIterations) throw new Error("operation limit exceeded");
        if (match[0].length === 0) {
          if (opts.global.lastIndex >= line.length) break;
          opts.global.lastIndex++;
          continue;
        }
        text += prefix + paint(opts.color, BOLD_RED, match[0]) + "\n";
      }
    } else {
      opts.global.lastIndex = 0;
      const highlighted = isMatch && !opts.invert && opts.color
        ? line.replace(opts.global, (m) => m ? `${BOLD_RED}${m}${RESET}` : m)
        : line;
      text += prefix + highlighted + "\n";
    }
    if (text.length > opts.maxOutputBytes) throw new Error("output limit exceeded");
  }
  return { text, hits };
}

export const grep_cmd = (syntaxDefault: Syntax): BuiltinFn => async (args, ctx, stdin) => {
  let syntax = syntaxDefault;
  const patterns: string[] = [];
  const operands: string[] = [];
  let ignoreCase = false, invert = false, count = false, filesWithMatches = false, filesWithout = false;
  let lineNumbers = false, onlyMatching = false, quiet = false, suppress = false, words = false, wholeLines = false;
  let recursive = false, withName: boolean | undefined;
  let before = 0, after = 0, maxCount = Infinity;
  let color: boolean | undefined;
  const include: RegExp[] = [], exclude: RegExp[] = [], excludeDir: RegExp[] = [];
  const glob = (pattern: string) => new RegExp(`^${globToRegex(pattern)}$`);
  const number = (flag: string, value: string | undefined): number | string => {
    const n = Number(value);
    return value !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : `grep: invalid ${flag === "m" ? "max count" : "context length argument"}\n`;
  };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!options || arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (arg === "--") { options = false; continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const value = eq > 0 ? arg.slice(eq + 1) : undefined;
      const needs = () => value ?? args[++i];
      switch (key) {
        case "help": return { stdout: USAGE.split("\n")[0] + "\n", stderr: "", exitCode: 0 };
        case "extended-regexp": syntax = "extended"; break;
        case "fixed-strings": syntax = "fixed"; break;
        case "basic-regexp": syntax = "basic"; break;
        case "perl-regexp": syntax = "perl"; break;
        case "regexp": patterns.push(needs() ?? ""); break;
        case "ignore-case": ignoreCase = true; break;
        case "no-ignore-case": ignoreCase = false; break;
        case "invert-match": invert = true; break;
        case "word-regexp": words = true; break;
        case "line-regexp": wholeLines = true; break;
        case "count": count = true; break;
        case "files-with-matches": filesWithMatches = true; break;
        case "files-without-match": filesWithout = true; break;
        case "line-number": lineNumbers = true; break;
        case "only-matching": onlyMatching = true; break;
        case "quiet": case "silent": quiet = true; break;
        case "no-messages": suppress = true; break;
        case "with-filename": withName = true; break;
        case "no-filename": withName = false; break;
        case "recursive": case "dereference-recursive": recursive = true; break;
        case "include": include.push(glob(needs() ?? "")); break;
        case "exclude": exclude.push(glob(needs() ?? "")); break;
        case "exclude-dir": excludeDir.push(glob(needs() ?? "")); break;
        case "color": case "colour": {
          const when = value ?? "auto";
          color = when === "always" ? true : when === "never" ? false : undefined;
          break;
        }
        case "max-count": case "after-context": case "before-context": case "context": {
          const n = number(key === "max-count" ? "m" : "A", needs());
          if (typeof n === "string") return fail(n, 2);
          if (key === "max-count") maxCount = n;
          if (key === "after-context" || key === "context") after = n;
          if (key === "before-context" || key === "context") before = n;
          break;
        }
        default:
          return fail(`grep: unrecognized option '${arg}'\n${USAGE}`, 2);
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ("eABCmf".includes(flag)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) return fail(`grep: option requires an argument -- '${flag}'\n${USAGE}`, 2);
        if (flag === "e") patterns.push(value);
        else if (flag === "f") {
          try { patterns.push(...ctx.volume.readFileSync(resolvePath(value, ctx.cwd), "utf8").split("\n").filter((line, k, all) => k < all.length - 1 || line !== "")); }
          catch { return fail(`grep: ${value}: No such file or directory\n`, 2); }
        } else {
          const n = number(flag, value);
          if (typeof n === "string") return fail(n, 2);
          if (flag === "m") maxCount = n;
          if (flag === "A" || flag === "C") after = n;
          if (flag === "B" || flag === "C") before = n;
        }
        break;
      }
      if (/\d/.test(flag)) {
        const digits = arg.slice(j).match(/^\d+/)![0];
        before = after = Number(digits);
        j += digits.length - 1;
        continue;
      }
      switch (flag) {
        case "E": syntax = "extended"; break;
        case "F": syntax = "fixed"; break;
        case "G": syntax = "basic"; break;
        case "P": syntax = "perl"; break;
        case "i": case "y": ignoreCase = true; break;
        case "v": invert = true; break;
        case "w": words = true; break;
        case "x": wholeLines = true; break;
        case "c": count = true; break;
        case "l": filesWithMatches = true; break;
        case "L": filesWithout = true; break;
        case "n": lineNumbers = true; break;
        case "o": onlyMatching = true; break;
        case "q": quiet = true; break;
        case "s": suppress = true; break;
        case "H": withName = true; break;
        case "h": withName = false; break;
        case "r": case "R": recursive = true; break;
        case "I": case "a": case "U": case "Z": case "z": case "b": case "T": break;
        default: return fail(`grep: invalid option -- '${flag}'\n${USAGE}`, 2);
      }
    }
  }
  if (!patterns.length) {
    if (!operands.length) return fail(USAGE, 2);
    patterns.push(operands.shift()!);
  }
  // each -e (and each line of a pattern) is an alternative
  const alternatives = patterns.flatMap((pattern) => pattern.split("\n"));
  let source: string;
  try {
    source = alternatives.map((pattern) => {
      let js = syntax === "fixed" ? pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
        : syntax === "perl" ? pattern
        : posixToJs(pattern, syntax === "extended");
      if (words) js = `(?<![\\w])(?:${js})(?![\\w])`;
      if (wholeLines) js = `^(?:${js})$`;
      return js;
    }).map((js) => alternatives.length > 1 ? `(?:${js})` : js).join("|");
  } catch (error) {
    return fail(`grep: ${error instanceof Error ? error.message : String(error)}\n`, 2);
  }
  const safety = regexSafetyError(source, Math.min(ctx.limits?.maxExpansionBytes ?? 1024 * 1024, 64 * 1024));
  if (safety) return fail(`grep: ${safety}\n`, 2);
  let regex: RegExp;
  let global: RegExp;
  try {
    regex = new RegExp(source, ignoreCase ? "i" : "");
    global = new RegExp(source, ignoreCase ? "gi" : "g");
  } catch {
    return fail(`grep: Invalid regular expression: '${alternatives.join("\\n")}'\n`, 2);
  }
  const opts: GrepOptions = {
    regex, global, invert, count, filesWithMatches, filesWithout, lineNumbers, onlyMatching, quiet,
    before, after, maxCount, color: color ?? !ctx.stdoutCaptured,
    maxOutputBytes: ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024,
    maxInputBytes: ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024,
    maxLoopIterations: ctx.limits?.maxLoopIterations ?? 100_000,
    work: 0,
  };

  let stdout = "";
  let stderr = "";
  let hits = 0;
  let errors = false;
  const warn = (message: string) => { errors = true; if (!suppress) stderr += `grep: ${message}\n`; };
  const add = (result: FileResult) => {
    stdout += result.text;
    hits += result.hits;
    if (stdout.length > opts.maxOutputBytes) throw new Error("output limit exceeded");
  };
  const entries = { count: 0 };
  const limit = ctx.limits?.maxFilesystemEntries ?? 100_000;
  const walk = async (full: string, shown: string, label: boolean): Promise<void> => {
    let names: string[];
    try { names = ctx.volume.readdirSync(full); }
    catch { warn(`${shown}: Permission denied`); return; }
    for (const name of names.sort()) {
      if (ctx.signal?.aborted) throw new Error("command cancelled");
      if (++entries.count > limit) throw new Error(`filesystem entry limit ${limit} exceeded`);
      if ((entries.count & 127) === 0) await yieldToEventLoop(ctx.signal);
      const child = full === "/" ? `/${name}` : `${full}/${name}`;
      const childShown = shown === "" ? name : shown.endsWith("/") ? shown + name : `${shown}/${name}`;
      let stat: ReturnType<ShellContext["volume"]["lstatSync"]>;
      try { stat = ctx.volume.lstatSync(child); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (excludeDir.some((re) => re.test(name))) continue;
        await walk(child, childShown, label);
        continue;
      }
      if (include.length && !include.some((re) => re.test(name))) continue;
      if (exclude.some((re) => re.test(name))) continue;
      searchFile(child, childShown, label);
      if (quiet && hits) return;
    }
  };
  const searchFile = (full: string, shown: string, label: boolean) => {
    let content: string;
    try { content = ctx.volume.readFileSync(full, "utf8"); }
    catch { warn(`${shown}: No such file or directory`); return; }
    if (content.includes("\0") && !count && !filesWithMatches && !filesWithout) {
      const result = searchText(content, { ...opts, quiet: true }, undefined);
      hits += result.hits;
      if (result.hits && !quiet) stdout += `Binary file ${shown} matches\n`;
      return;
    }
    add(searchText(content, opts, label ? shown : undefined));
  };

  try {
    if (!operands.length && !recursive) {
      add(searchText(stdin ?? "", opts, withName ? "(standard input)" : undefined));
    } else {
      const targets = operands.length ? operands : ["."];
      const label = withName ?? (recursive || targets.length > 1);
      for (const target of targets) {
        if (quiet && hits) break;
        if (target === "-") { add(searchText(stdin ?? "", opts, label ? "(standard input)" : undefined)); continue; }
        const full = resolvePath(target, ctx.cwd);
        let isDirectory = false;
        try { isDirectory = ctx.volume.statSync(full).isDirectory(); }
        catch { warn(`${target}: No such file or directory`); continue; }
        if (isDirectory) {
          if (!recursive) { warn(`${target}: Is a directory`); continue; }
          // without operands grep -r shows paths without a leading `./`
          await walk(full, operands.length ? target : "", label);
          continue;
        }
        if (recursive && (include.length || exclude.length)) {
          const name = target.slice(target.lastIndexOf("/") + 1);
          if (include.length && !include.some((re) => re.test(name))) continue;
          if (exclude.some((re) => re.test(name))) continue;
        }
        searchFile(full, target, label);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout, stderr: stderr + `grep: ${message}\n`, exitCode: ctx.signal?.aborted ? 130 : 2 };
  }
  const result: ShellResult = { stdout: quiet ? "" : stdout, stderr, exitCode: hits ? 0 : 1 };
  if (errors && !(quiet && hits)) result.exitCode = 2;
  return result;
};
