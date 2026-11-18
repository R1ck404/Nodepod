import type { BuiltinFn, ShellContext, ShellResult } from "../shell-types.js";
import {
  ok,
  fail,
  EXIT_OK,
  EXIT_FAIL,
  resolvePath,
  parseArgs,
  processEscapes,
  expandCharClass,
  RESET,
  GREEN,
  MAGENTA,
  CYAN,
  BOLD_RED,
  yieldToEventLoop,
  regexSafetyError,
} from "../shell-helpers.js";
import { YES_REPEAT_COUNT } from "../../constants/config.js";

/* ------------------------------------------------------------------ */
/*  echo / printf                                                      */
/* ------------------------------------------------------------------ */

const echo: BuiltinFn = (args) => {
  let noNewline = false;
  let enableEscapes = false;
  let start = 0;

  while (start < args.length) {
    const a = args[start];
    if (a === "-n") {
      noNewline = true;
      start++;
    } else if (a === "-e") {
      enableEscapes = true;
      start++;
    } else if (a === "-E") {
      enableEscapes = false;
      start++;
    } else if (a === "-ne" || a === "-en") {
      noNewline = true;
      enableEscapes = true;
      start++;
    } else if (a === "-nE" || a === "-En") {
      noNewline = true;
      start++;
    } else break;
  }

  let output = args.slice(start).join(" ");
  if (enableEscapes) output = processEscapes(output);
  return ok(output + (noNewline ? "" : "\n"));
};

function formatPrintfOnce(
  fmt: string,
  vals: string[],
  initialIndex = 0,
  outputLimit = 4 * 1024 * 1024,
): { output: string; nextIndex: number } {
  let out = "";
  let vi = initialIndex;

  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === "\\" && i + 1 < fmt.length) {
      const c = fmt[i + 1];
      if (c === "n") { out += "\n"; i += 2; continue; }
      if (c === "t") { out += "\t"; i += 2; continue; }
      if (c === "r") { out += "\r"; i += 2; continue; }
      if (c === "a") { out += "\x07"; i += 2; continue; }
      if (c === "b") { out += "\b"; i += 2; continue; }
      if (c === "f") { out += "\f"; i += 2; continue; }
      if (c === "v") { out += "\x0b"; i += 2; continue; }
      if (c === "\\") { out += "\\"; i += 2; continue; }
      if (c === "0") {
        let oct = "";
        let j = i + 2;
        while (j < fmt.length && j < i + 5 && fmt[j] >= "0" && fmt[j] <= "7")
          oct += fmt[j++];
        out += String.fromCharCode(parseInt(oct || "0", 8));
        i = j;
        continue;
      }
      if (c === "x") {
        const hex = fmt.slice(i + 2, i + 4).match(/^[0-9a-fA-F]+/)?.[0] ?? "";
        if (hex) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2 + hex.length;
          continue;
        }
      }
      out += fmt[i];
      i++;
      continue;
    }

    if (fmt[i] === "%" && i + 1 < fmt.length) {
      i++;
      let fmtFlags = "";
      while ("-+ 0#".includes(fmt[i])) fmtFlags += fmt[i++];
      let width = "";
      if (fmt[i] === "*") { width = vals[vi++] ?? "0"; i++; }
      else { while (fmt[i] >= "0" && fmt[i] <= "9") width += fmt[i++]; }
      let prec = "";
      if (fmt[i] === ".") {
        i++;
        if (fmt[i] === "*") { prec = vals[vi++] ?? "0"; i++; }
        else { while (fmt[i] >= "0" && fmt[i] <= "9") prec += fmt[i++]; }
      }
      const spec = fmt[i++];
      const val = vals[vi++] ?? "";
      const parsedWidth = width === "" ? 0 : Number(width);
      if (!Number.isFinite(parsedWidth) || parsedWidth < 0 || parsedWidth > outputLimit) {
        throw new Error("field width exceeds output limit");
      }
      const parsedPrecision = prec === "" ? null : Number(prec);
      if (parsedPrecision !== null && (!Number.isFinite(parsedPrecision) || parsedPrecision < 0 || parsedPrecision > outputLimit)) {
        throw new Error("precision exceeds output limit");
      }

      if (spec === "%") { out += "%"; vi--; continue; }
      if (spec === "s") {
        let s = val;
        if (prec) s = s.slice(0, parseInt(prec));
        const w = parseInt(width) || 0;
        if (fmtFlags.includes("-")) out += s.padEnd(w);
        else out += s.padStart(w);
        continue;
      }
      if (spec === "d" || spec === "i") {
        const n = parseInt(val) || 0;
        let s = (fmtFlags.includes("+") && n >= 0 ? "+" : "") + String(n);
        if (fmtFlags.includes(" ") && n >= 0 && !fmtFlags.includes("+")) s = " " + s;
        const w = parseInt(width) || 0;
        const pad = fmtFlags.includes("0") && !fmtFlags.includes("-") ? "0" : " ";
        if (fmtFlags.includes("-")) out += s.padEnd(w);
        else if (pad === "0" && s[0] === "-") out += "-" + s.slice(1).padStart(w - 1, "0");
        else out += s.padStart(w, pad);
        continue;
      }
      if (spec === "f") {
        const n = parseFloat(val) || 0;
        const p = prec !== "" ? parseInt(prec) : 6;
        let s = n.toFixed(p);
        if (fmtFlags.includes("+") && n >= 0) s = "+" + s;
        const w = parseInt(width) || 0;
        if (fmtFlags.includes("-")) out += s.padEnd(w);
        else out += s.padStart(w, fmtFlags.includes("0") ? "0" : " ");
        continue;
      }
      if (spec === "x") {
        const n = (parseInt(val) || 0) >>> 0;
        let s = n.toString(16);
        if (fmtFlags.includes("#") && n !== 0) s = "0x" + s;
        out += s.padStart(parseInt(width) || 0, fmtFlags.includes("0") ? "0" : " ");
        continue;
      }
      if (spec === "X") {
        const n = (parseInt(val) || 0) >>> 0;
        let s = n.toString(16).toUpperCase();
        if (fmtFlags.includes("#") && n !== 0) s = "0X" + s;
        out += s.padStart(parseInt(width) || 0, fmtFlags.includes("0") ? "0" : " ");
        continue;
      }
      if (spec === "o") {
        const n = (parseInt(val) || 0) >>> 0;
        let s = n.toString(8);
        if (fmtFlags.includes("#") && n !== 0) s = "0" + s;
        out += s.padStart(parseInt(width) || 0, fmtFlags.includes("0") ? "0" : " ");
        continue;
      }
      if (spec === "e" || spec === "E") {
        const n = parseFloat(val) || 0;
        const p = prec !== "" ? parseInt(prec) : 6;
        let s = spec === "E" ? n.toExponential(p).toUpperCase() : n.toExponential(p);
        if (fmtFlags.includes("+") && n >= 0) s = "+" + s;
        out += s.padStart(parseInt(width) || 0);
        continue;
      }
      if (spec === "g" || spec === "G") {
        const n = parseFloat(val) || 0;
        const p = prec !== "" ? parseInt(prec) : 6;
        let s = spec === "G" ? n.toPrecision(p).toUpperCase() : n.toPrecision(p);
        if (fmtFlags.includes("+") && n >= 0) s = "+" + s;
        out += s.padStart(parseInt(width) || 0);
        continue;
      }
      if (spec === "c") { out += val ? val[0] : ""; continue; }
      out += "%" + spec;
      vi--;
      continue;
    }
    out += fmt[i++];
    if (out.length > outputLimit) throw new Error("output limit exceeded");
  }
  if (out.length > outputLimit) throw new Error("output limit exceeded");
  return { output: out, nextIndex: vi };
}

const printf_cmd: BuiltinFn = (args, ctx) => {
  if (args.length === 0) return ok();
  const fmt = args[0];
  const vals = args.slice(1);
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const conversionCount = [...fmt.matchAll(/%(?:[-+ 0#]*\d*(?:\.\d+)?[sdifxXoeEgGc%])/g)].filter((match) => match[0] !== "%%").length;
  try {
    const first = formatPrintfOnce(fmt, vals, 0, outputLimit);
    if (vals.length === 0 || conversionCount === 0) return ok(first.output);
    let output = first.output;
    let index = first.nextIndex;
    while (index < vals.length && index > 0) {
      const next = formatPrintfOnce(fmt, vals, index, outputLimit - output.length);
      output += next.output;
      if (output.length > outputLimit) throw new Error("output limit exceeded");
      if (next.nextIndex === index) break;
      index = next.nextIndex;
    }
    return ok(output);
  } catch (error) {
    return fail(`printf: ${error instanceof Error ? error.message : String(error)}\n`);
  }
};

/* ------------------------------------------------------------------ */
/*  grep / egrep / fgrep                                               */
/* ------------------------------------------------------------------ */

interface GrepOpts {
  regex: RegExp;
  highlightRe: RegExp;
  patternStr: string;
  ignoreCase: boolean;
  invert: boolean;
  countOnly: boolean;
  filesOnly: boolean;
  lineNumbers: boolean;
  onlyMatching: boolean;
  quiet: boolean;
  beforeCtx: number;
  afterCtx: number;
  maxCount: number;
  maxOutputBytes: number;
  maxInputBytes: number;
  maxLoopIterations: number;
  work: number;
}

interface GrepLinesResult {
  text: string;
  hits: number;
}

function grepLines(content: string, opts: GrepOpts, label?: string): GrepLinesResult {
  const {
    regex, highlightRe, patternStr, ignoreCase, invert,
    countOnly, filesOnly, lineNumbers, onlyMatching, quiet,
    beforeCtx, afterCtx, maxCount,
  } = opts;
  if (content.length > opts.maxInputBytes) throw new Error("input limit exceeded");
  const lines = content.split("\n");
  if (opts.work + lines.length > opts.maxLoopIterations) throw new Error("operation limit exceeded");
  opts.work += lines.length;
  const matchedIndices = new Set<number>();
  let matchCount = 0;

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]) !== invert) {
      matchedIndices.add(i);
      matchCount++;
      if (matchCount >= maxCount) break;
    }
  }

  const hits = matchedIndices.size;

  if (countOnly) {
    return {
      text:
        (label ? `${MAGENTA}${label}${RESET}${CYAN}:${RESET}` : "") +
        hits +
        "\n",
      hits,
    };
  }
  if (filesOnly && hits > 0) {
    return { text: `${MAGENTA}${label ?? ""}${RESET}\n`, hits };
  }
  if (quiet) return { text: hits > 0 ? "\0" : "", hits };

  const showLines = new Set<number>();
  for (const idx of matchedIndices) {
    for (
      let j = Math.max(0, idx - beforeCtx);
      j <= Math.min(lines.length - 1, idx + afterCtx);
      j++
    ) {
      if (++opts.work > opts.maxLoopIterations) throw new Error("operation limit exceeded");
      showLines.add(j);
    }
  }

  let out = "";
  let prevShown = -2;
  for (let i = 0; i < lines.length; i++) {
    if (!showLines.has(i)) continue;
    if (
      prevShown >= 0 &&
      i > prevShown + 1 &&
      (beforeCtx > 0 || afterCtx > 0)
    ) {
      out += "--\n";
    }
    prevShown = i;

    const isMatch = matchedIndices.has(i);
    const sep = isMatch ? `${CYAN}:${RESET}` : `${CYAN}-${RESET}`;
    const prefix = label ? `${MAGENTA}${label}${RESET}${sep}` : "";
    const num = lineNumbers ? `${GREEN}${i + 1}${RESET}${sep}` : "";

    if (onlyMatching && isMatch && !invert) {
      const gRe = new RegExp(patternStr, ignoreCase ? "gi" : "g");
      let m: RegExpExecArray | null;
      while ((m = gRe.exec(lines[i])) !== null) {
        if (++opts.work > opts.maxLoopIterations) throw new Error("operation limit exceeded");
        // JavaScript global regexes do not advance after an empty match.
        // GNU grep -o does not print empty matches, so advance manually and
        // suppress them instead of spinning forever.
        if (m[0].length === 0) {
          if (gRe.lastIndex >= lines[i].length) break;
          gRe.lastIndex++;
          continue;
        }
        out += `${prefix}${num}${BOLD_RED}${m[0]}${RESET}\n`;
        if (out.length > opts.maxOutputBytes) throw new Error("output limit exceeded");
      }
    } else {
      const hl =
        isMatch && !invert
          ? lines[i].replace(highlightRe, (m) => `${BOLD_RED}${m}${RESET}`)
          : lines[i];
      out += `${prefix}${num}${hl}\n`;
      if (out.length > opts.maxOutputBytes) throw new Error("output limit exceeded");
    }
  }

  return { text: out, hits };
}

async function grepDirFull(
  ctx: ShellContext,
  dir: string,
  opts: GrepOpts,
  state: { entries: number },
): Promise<GrepLinesResult> {
  let text = "";
  let hits = 0;
  let names: string[];
  try {
    names = ctx.volume.readdirSync(dir);
  } catch {
    return { text, hits };
  }
  for (const name of names) {
    if (ctx.signal?.aborted) throw new Error("command cancelled");
    const limit = ctx.limits?.maxFilesystemEntries ?? 100_000;
    if (++state.entries > limit) throw new Error(`filesystem entry limit ${limit} exceeded`);
    if ((state.entries & 127) === 0) await yieldToEventLoop(ctx.signal);
    const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
    let st: ReturnType<ShellContext["volume"]["lstatSync"]>;
    try { st = ctx.volume.lstatSync(full); } catch { continue; }
    if (st.isDirectory()) {
      const nested = await grepDirFull(ctx, full, opts, state);
      text += nested.text;
      hits += nested.hits;
    } else if (!st.isSymbolicLink()) {
      try {
        const content = ctx.volume.readFileSync(full, "utf8");
        const result = grepLines(content, opts, full);
        text += result.text;
        hits += result.hits;
      } catch (error) {
        if (error instanceof Error && error.message === "output limit exceeded") throw error;
        /* skip binary/unreadable */
      }
    }
    if (text.length > opts.maxOutputBytes) throw new Error("output limit exceeded");
  }
  return { text, hits };
}

const grep_cmd: BuiltinFn = async (args, ctx, stdin) => {
  const { flags, opts: parsedOpts, positional } = parseArgs(
    args,
    [
      "i", "v", "c", "l", "n", "r", "R", "o", "w", "x",
      "E", "F", "P", "H", "h", "q", "s", "z",
    ],
    ["A", "B", "C", "m", "e", "f"],
  );
  const ignoreCase = flags.has("i");
  const invert = flags.has("v");
  const countOnly = flags.has("c");
  const filesOnly = flags.has("l");
  const lineNumbers = flags.has("n");
  const recursive = flags.has("r") || flags.has("R");
  const onlyMatching = flags.has("o");
  const wordRegex = flags.has("w");
  const lineRegex = flags.has("x");
  const fixedStrings = flags.has("F");
  const quiet = flags.has("q");
  const suppressErrors = flags.has("s");
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  const parseCount = (value: string | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? Math.min(parsed, operationLimit) : fallback;
  };
  const afterCtx = parseCount(parsedOpts["A"] ?? parsedOpts["C"], 0);
  const beforeCtx = parseCount(parsedOpts["B"] ?? parsedOpts["C"], 0);
  const maxCount = parseCount(parsedOpts["m"], Infinity);

  let patternStr: string;
  if (parsedOpts["e"] !== undefined) {
    patternStr = parsedOpts["e"];
  } else if (positional.length === 0) {
    return fail("grep: missing pattern\n");
  } else {
    patternStr = positional.shift()!;
  }

  if (fixedStrings)
    patternStr = patternStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wordRegex) patternStr = `\\b${patternStr}\\b`;
  if (lineRegex) patternStr = `^${patternStr}$`;

  const regexError = regexSafetyError(
    patternStr,
    Math.min(ctx.limits?.maxExpansionBytes ?? 1024 * 1024, 64 * 1024),
  );
  if (regexError) return fail(`grep: ${regexError}\n`, 2);

  let regex: RegExp;
  let highlightRe: RegExp;
  try {
    regex = new RegExp(patternStr, ignoreCase ? "im" : "m");
    highlightRe = new RegExp(patternStr, ignoreCase ? "gi" : "g");
  } catch {
    return fail(`grep: Invalid regular expression: '${patternStr}'\n`);
  }

  const grepOpts: GrepOpts = {
    regex, highlightRe, patternStr, ignoreCase, invert,
    countOnly, filesOnly, lineNumbers, onlyMatching, quiet,
    beforeCtx, afterCtx, maxCount,
    maxOutputBytes: ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024,
    maxInputBytes: ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024,
    maxLoopIterations: operationLimit,
    work: 0,
  };

  const files = positional;

  if (files.length === 0 && stdin !== undefined) {
    let result: GrepLinesResult;
    try { result = grepLines(stdin, grepOpts); }
    catch (error) { return fail(`grep: ${error instanceof Error ? error.message : String(error)}\n`); }
    if (quiet) return result.hits > 0 ? EXIT_OK : EXIT_FAIL;
    return result.hits > 0
      ? ok(result.text)
      : { stdout: result.text, stderr: "", exitCode: 1 };
  }

  if (files.length === 0) {
    return fail("grep: missing file operand\n");
  }

  let out = "";
  const multiFile = files.length > 1 || recursive;
  let totalHits = 0;
  const walkState = { entries: 0 };

  for (const file of files) {
    if (ctx.signal?.aborted) return fail("grep: command cancelled\n", 130);
    const p = resolvePath(file, ctx.cwd);
    try {
      const st = ctx.volume.statSync(p);
      if (st.isDirectory()) {
        if (recursive) {
          const r = await grepDirFull(ctx, p, grepOpts, walkState);
          out += r.text;
          totalHits += r.hits;
        } else if (!suppressErrors) {
          out += `grep: ${file}: Is a directory\n`;
        }
        continue;
      }
      const content = ctx.volume.readFileSync(p, "utf8");
      const result = grepLines(content, grepOpts, multiFile ? file : undefined);
      out += result.text;
      totalHits += result.hits;
      if (out.length > grepOpts.maxOutputBytes) throw new Error("output limit exceeded");
    } catch (error) {
      if (error instanceof Error && (error.message.includes("limit") || error.message === "command cancelled")) {
        return fail(`grep: ${error.message}\n`, ctx.signal?.aborted ? 130 : 1);
      }
      if (!suppressErrors)
        return fail(`grep: ${file}: No such file or directory\n`);
    }
  }

  if (quiet) return totalHits > 0 ? EXIT_OK : EXIT_FAIL;
  return totalHits > 0 ? ok(out) : { stdout: out, stderr: "", exitCode: 1 };
};

/* ------------------------------------------------------------------ */
/*  sed                                                                */
/* ------------------------------------------------------------------ */

interface SedCmd {
  addr?:
    | { type: "line"; n: number }
    | { type: "range"; from: number; to: number }
    | { type: "last" }
    | { type: "regex"; re: RegExp };
  type: string;
  pattern?: string;
  replacement?: string;
  sFlags?: string;
  substitutionRe?: RegExp;
  text?: string;
  printAfter?: boolean;
}

function parseSedScript(script: string, regexLimit: number): SedCmd[] | string {
  const cmds: SedCmd[] = [];
  const parts = script.split(/\s*;\s*|\n/).filter(Boolean);

  for (const part of parts) {
    let rest = part.trim();
    if (!rest) continue;

    let addr: SedCmd["addr"];
    if (rest[0] === "$") {
      addr = { type: "last" };
      rest = rest.slice(1);
    } else if (/^\d/.test(rest)) {
      const m = rest.match(/^(\d+)(?:,(\d+|\$))?/);
      if (m) {
        rest = rest.slice(m[0].length);
        if (m[2]) {
          const to = m[2] === "$" ? Infinity : parseInt(m[2]);
          addr = { type: "range", from: parseInt(m[1]), to };
        } else {
          addr = { type: "line", n: parseInt(m[1]) };
        }
      }
    } else if (rest[0] === "/") {
      const end = rest.indexOf("/", 1);
      if (end > 0) {
        const pattern = rest.slice(1, end);
        const safetyError = regexSafetyError(pattern, regexLimit);
        if (safetyError) return safetyError;
        try {
          addr = { type: "regex", re: new RegExp(pattern) };
        } catch {
          return `invalid regular expression: ${pattern}`;
        }
        rest = rest.slice(end + 1);
      }
    }

    const cmd = rest[0];
    rest = rest.slice(1);

    if (cmd === "s") {
      const delim = rest[0];
      if (!delim) return `unsupported expression: ${part}`;
      const parts2 = rest.slice(1).split(delim);
      if (parts2.length < 2) return `unsupported expression: ${part}`;
      const printAfter = parts2[2]?.includes("p") ?? false;
      const sFlags = (parts2[2] ?? "").replace("p", "") || undefined;
      const safetyError = regexSafetyError(parts2[0], regexLimit);
      if (safetyError) return safetyError;
      let substitutionRe: RegExp;
      try {
        substitutionRe = new RegExp(parts2[0], sFlags);
      } catch {
        return `invalid regular expression: ${parts2[0]}`;
      }
      cmds.push({ addr, type: "s", pattern: parts2[0], replacement: parts2[1], sFlags, substitutionRe, printAfter });
    } else if (cmd === "d") { cmds.push({ addr, type: "d" }); }
    else if (cmd === "p") { cmds.push({ addr, type: "p" }); }
    else if (cmd === "q") { cmds.push({ addr, type: "q" }); }
    else if (cmd === "a") { cmds.push({ addr, type: "a", text: rest.replace(/^\\?\s*/, "") }); }
    else if (cmd === "i") { cmds.push({ addr, type: "i", text: rest.replace(/^\\?\s*/, "") }); }
    else if (cmd === "c") { cmds.push({ addr, type: "c", text: rest.replace(/^\\?\s*/, "") }); }
    else if (cmd === "y") {
      const delim2 = rest[0];
      const parts2 = rest.slice(1).split(delim2);
      if (parts2.length < 2) return `unsupported expression: ${part}`;
      cmds.push({ addr, type: "y", pattern: parts2[0], replacement: parts2[1] });
    } else if (cmd === "=") { cmds.push({ addr, type: "=" }); }
    else { return `unsupported command: ${cmd}`; }
  }
  return cmds;
}

function sedAddressMatch(
  addr: SedCmd["addr"],
  lineNum: number,
  totalLines: number,
  _line: string,
): boolean {
  if (!addr) return true;
  if (addr.type === "line") return lineNum === addr.n;
  if (addr.type === "range")
    return lineNum >= addr.from && lineNum <= (addr.to === Infinity ? totalLines : addr.to);
  if (addr.type === "last") return lineNum === totalLines;
  if (addr.type === "regex") return addr.re.test(_line);
  return true;
}

const sed_cmd: BuiltinFn = (args, ctx, stdin) => {
  const { flags, positional } = parseArgs(args, ["i", "n", "r", "E"]);
  const inPlace = flags.has("i");
  const quietMode = flags.has("n");

  if (positional.length === 0) return fail("sed: missing expression\n");

  const expressions = positional[0];
  const files = positional.slice(1);

  const cmds = parseSedScript(
    expressions,
    Math.min(ctx.limits?.maxExpansionBytes ?? 1024 * 1024, 64 * 1024),
  );
  if (typeof cmds === "string") return fail(`sed: ${cmds}\n`);

  const doSed = (content: string): string => {
    const inputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
    if (content.length > inputLimit) throw new Error(`input limit ${inputLimit} exceeded`);
    // drop trailing empty segment from a final newline so $ is the last real line
    const lines = content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
    if (lines.length * Math.max(1, cmds.length) > operationLimit) {
      throw new Error(`operation limit ${operationLimit} exceeded`);
    }
    const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
    let out = "";
    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const isLast = i === lines.length - 1;
      let line = lines[i];
      let suppress = quietMode;
      let deleted = false;

      for (const cmd of cmds) {
        if (deleted) break;
        if (!sedAddressMatch(cmd.addr, lineNum, lines.length, line)) continue;

        switch (cmd.type) {
          case "s": {
            const re = cmd.substitutionRe!;
            re.lastIndex = 0;
            line = line.replace(re, cmd.replacement!);
            re.lastIndex = 0;
            if (cmd.printAfter && re.test(lines[i])) suppress = false;
            break;
          }
          case "d": deleted = true; break;
          case "p": out += line + "\n"; break;
          case "q": { if (!suppress) out += line + "\n"; return out; }
          case "a": out += line + "\n" + cmd.text! + "\n"; suppress = true; break;
          case "i": out += cmd.text! + "\n"; break;
          case "c": out += cmd.text! + "\n"; deleted = true; break;
          case "y": {
            const from = cmd.pattern!;
            const to = cmd.replacement!;
            let result = "";
            for (const ch of line) {
              const idx = from.indexOf(ch);
              result += idx >= 0 ? to[idx] : ch;
            }
            line = result;
            break;
          }
          case "=": out += lineNum + "\n"; break;
        }
      }
      if (!deleted && !suppress) {
        out += line + (isLast && !content.endsWith("\n") ? "" : "\n");
      }
      if (out.length > outputLimit) throw new Error("output limit exceeded");
    }
    return out;
  };

  const runSed = (content: string): ShellResult | string => {
    try {
      return doSed(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`sed: ${msg}\n`);
    }
  };

  if (files.length === 0 && stdin !== undefined) {
    const result = runSed(stdin);
    return typeof result === "string" ? ok(result) : result;
  }
  if (files.length === 0) return fail("sed: missing input\n");

  let out = "";
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    try {
      const content = ctx.volume.readFileSync(p, "utf8");
      const result = runSed(content);
      if (typeof result !== "string") return result;
      if (inPlace) {
        ctx.volume.writeFileSync(p, result);
      } else {
        out += result;
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("invalid regular expression")) {
        return fail(`sed: ${e.message}\n`);
      }
      return fail(`sed: ${file}: No such file or directory\n`);
    }
  }
  return ok(out);
};

/* ------------------------------------------------------------------ */
/*  sort                                                               */
/* ------------------------------------------------------------------ */

const sort_cmd: BuiltinFn = (args, ctx, stdin) => {
  const { flags, opts, positional } = parseArgs(
    args,
    ["r", "n", "u", "f", "h", "V", "b", "s"],
    ["k", "t", "o"],
  );
  const reverse = flags.has("r");
  const numeric = flags.has("n");
  const unique = flags.has("u");
  const ignoreCase = flags.has("f");
  const humanNumeric = flags.has("h");
  const versionSort = flags.has("V");
  const stable = flags.has("s");
  const keySpec = opts["k"];
  const fieldSep = opts["t"];
  const outputFile = opts["o"];

  let content = stdin ?? "";
  if (positional.length > 0) {
    const p = resolvePath(positional[0], ctx.cwd);
    try {
      content = ctx.volume.readFileSync(p, "utf8");
    } catch {
      return fail(`sort: ${positional[0]}: No such file or directory\n`);
    }
  }

  let lines = content.split("\n").filter(Boolean);
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (lines.length > operationLimit) return fail(`sort: operation limit ${operationLimit} exceeded\n`);

  const getKey = (line: string): string => {
    if (!keySpec) return line;
    const sep = fieldSep || /\s+/;
    const fields = line.split(sep);
    const [startSpec, endSpec] = keySpec.split(",");
    const startField = parseInt(startSpec) - 1;
    const endField = endSpec ? parseInt(endSpec) - 1 : startField;
    return fields
      .slice(startField, endField + 1)
      .join(typeof sep === "string" ? sep : " ");
  };

  const parseHumanSize = (s: string): number => {
    const m = s.trim().match(/^([\d.]+)([KMGTPE]i?)?$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const u = (m[2] || "").toUpperCase().replace("I", "");
    const mult: Record<string, number> = {
      "": 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776,
    };
    return n * (mult[u] || 1);
  };

  const compare = (a: string, b: string): number => {
    let ka = getKey(a), kb = getKey(b);
    if (ignoreCase) { ka = ka.toLowerCase(); kb = kb.toLowerCase(); }
    if (numeric) return parseFloat(ka) - parseFloat(kb);
    if (humanNumeric) return parseHumanSize(ka) - parseHumanSize(kb);
    if (versionSort)
      return ka.localeCompare(kb, undefined, { numeric: true, sensitivity: "base" });
    return ka.localeCompare(kb);
  };

  if (stable) {
    const indexed = lines.map((l, i) => ({ l, i }));
    indexed.sort((a, b) => compare(a.l, b.l) || a.i - b.i);
    lines = indexed.map((x) => x.l);
  } else {
    lines.sort(compare);
  }
  if (reverse) lines.reverse();
  if (unique) {
    const seen = new Set<string>();
    lines = lines.filter((l) => {
      const k = ignoreCase ? getKey(l).toLowerCase() : getKey(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  const result = lines.join("\n") + (lines.length ? "\n" : "");
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  if (result.length > outputLimit) return fail(`sort: output limit ${outputLimit} exceeded\n`);
  if (outputFile) {
    const p = resolvePath(outputFile, ctx.cwd);
    try {
      ctx.volume.writeFileSync(p, result);
    } catch {
      /* */
    }
  }
  return ok(result);
};

/* ------------------------------------------------------------------ */
/*  uniq                                                               */
/* ------------------------------------------------------------------ */

const uniq_cmd: BuiltinFn = (args, ctx, stdin) => {
  const { flags, opts, positional } = parseArgs(
    args,
    ["c", "d", "u", "i"],
    ["f", "s", "w"],
  );
  const count = flags.has("c");
  const dupsOnly = flags.has("d");
  const uniqueOnly = flags.has("u");
  const ignoreCase = flags.has("i");
  const skipFields = parseInt(opts["f"] || "0");
  const skipChars = parseInt(opts["s"] || "0");
  const checkChars = opts["w"] ? parseInt(opts["w"]) : Infinity;

  let content = stdin ?? "";
  if (positional.length > 0) {
    const p = resolvePath(positional[0], ctx.cwd);
    try {
      content = ctx.volume.readFileSync(p, "utf8");
    } catch {
      return fail(`uniq: ${positional[0]}: No such file or directory\n`);
    }
  }

  const getKey = (line: string): string => {
    let l = line;
    if (skipFields > 0) {
      const parts = l.split(/\s+/);
      l = parts.slice(skipFields).join(" ");
    }
    if (skipChars > 0) l = l.slice(skipChars);
    if (checkChars < Infinity) l = l.slice(0, checkChars);
    if (ignoreCase) l = l.toLowerCase();
    return l;
  };

  const lines = content.split("\n");
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (lines.length > operationLimit) return fail(`uniq: operation limit ${operationLimit} exceeded\n`);
  const result: string[] = [];
  let prev = "";
  let prevLine = "";
  let prevCount = 0;

  for (const line of lines) {
    const key = getKey(line);
    if (key === prev) {
      prevCount++;
    } else {
      if (prevCount > 0) {
        const show = dupsOnly ? prevCount > 1 : uniqueOnly ? prevCount === 1 : true;
        if (show)
          result.push(count ? `${String(prevCount).padStart(7)} ${prevLine}` : prevLine);
      }
      prev = key;
      prevLine = line;
      prevCount = 1;
    }
  }
  if (prevCount > 0 && prevLine !== "") {
    const show = dupsOnly ? prevCount > 1 : uniqueOnly ? prevCount === 1 : true;
    if (show)
      result.push(count ? `${String(prevCount).padStart(7)} ${prevLine}` : prevLine);
  }

  const output = result.join("\n") + (result.length ? "\n" : "");
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  return output.length > outputLimit ? fail(`uniq: output limit ${outputLimit} exceeded\n`) : ok(output);
};

/* ------------------------------------------------------------------ */
/*  tr                                                                 */
/* ------------------------------------------------------------------ */

function expandRange(s: string): string {
  return s.replace(/(.)-(.)/g, (_, a: string, b: string) => {
    let result = "";
    const start = a.charCodeAt(0);
    const end = b.charCodeAt(0);
    for (let i = start; i <= end; i++) result += String.fromCharCode(i);
    return result;
  });
}

function squeezeDups(s: string, chars: Set<string>): string {
  let out = "";
  let prev = "";
  for (const ch of s) {
    if (ch === prev && chars.has(ch)) continue;
    out += ch;
    prev = ch;
  }
  return out;
}

function buildComplement(set: string): string {
  const setChars = new Set(set);
  let result = "";
  for (let i = 0; i < 128; i++) {
    const ch = String.fromCharCode(i);
    if (!setChars.has(ch)) result += ch;
  }
  return result;
}

const tr_cmd: BuiltinFn = (args, ctx, stdin) => {
  const { flags, positional } = parseArgs(args, ["d", "s", "c", "C"]);
  const deleteMode = flags.has("d");
  const squeeze = flags.has("s");
  const complement = flags.has("c") || flags.has("C");

  if (positional.length === 0) return fail("tr: missing operand\n");
  const content = stdin ?? "";

  let set1 = expandCharClass(positional[0]);
  const set2 = positional.length > 1 ? expandCharClass(positional[1]) : "";

  set1 = expandRange(set1);
  const expandedSet2 = set2 ? expandRange(set2) : "";
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  const lookupWidth = !deleteMode || complement ? Math.max(1, set1.length) : 1;
  if (content.length * lookupWidth > operationLimit) {
    return fail(`tr: operation limit ${operationLimit} exceeded\n`);
  }

  if (deleteMode) {
    const chars = complement ? null : new Set(set1);
    let out = "";
    for (const ch of content) {
      const inSet = chars ? chars.has(ch) : set1.includes(ch);
      if (complement ? inSet : !inSet) out += ch;
    }
    if (squeeze && expandedSet2) {
      const squeezeSet = new Set(expandedSet2);
      out = squeezeDups(out, squeezeSet);
    }
    return ok(out);
  }

  if (positional.length < 2 && !squeeze) return fail("tr: missing operand\n");

  if (squeeze && positional.length === 1) {
    const squeezeSet = new Set(set1);
    return ok(squeezeDups(content, squeezeSet));
  }

  let out = "";
  const s1 = complement ? buildComplement(set1) : set1;
  for (const ch of content) {
    const idx = s1.indexOf(ch);
    if (idx >= 0) {
      const replacement =
        idx < expandedSet2.length
          ? expandedSet2[idx]
          : expandedSet2[expandedSet2.length - 1] || ch;
      out += replacement;
    } else {
      out += ch;
    }
  }

  if (squeeze) {
    const squeezeSet = new Set(expandedSet2);
    out = squeezeDups(out, squeezeSet);
  }
  return ok(out);
};

/* ------------------------------------------------------------------ */
/*  cut                                                                */
/* ------------------------------------------------------------------ */

function parseRangeSpec(spec: string, limit: number): number[] {
  const result: number[] = [];
  for (const part of spec.split(",")) {
    const range = part.match(/^(\d+)-(\d*)$/);
    if (range) {
      const start = parseInt(range[1]);
      const end = range[2] ? parseInt(range[2]) : start + 100;
      const count = Math.max(0, end - start + 1);
      if (!Number.isSafeInteger(count) || result.length + count > limit) {
        throw new Error(`range contains more than ${limit} positions`);
      }
      for (let i = start; i <= end; i++) result.push(i);
    } else {
      result.push(parseInt(part));
    }
  }
  return result.filter((n) => !isNaN(n));
}

const cut_cmd: BuiltinFn = (args, ctx, stdin) => {
  let delimiter = "\t";
  let fields: number[] = [];
  let bytes: number[] = [];
  let chars: number[] = [];
  let outputDelimiter: string | null = null;
  const files: string[] = [];
  const rangeLimit = Math.min(
    ctx.limits?.maxLoopIterations ?? 1_000_000,
    ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024,
  );

  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-d" && i + 1 < args.length) delimiter = args[++i];
      else if (args[i] === "-f" && i + 1 < args.length)
        fields = parseRangeSpec(args[++i], rangeLimit);
      else if (args[i] === "-b" && i + 1 < args.length)
        bytes = parseRangeSpec(args[++i], rangeLimit);
      else if (args[i] === "-c" && i + 1 < args.length)
        chars = parseRangeSpec(args[++i], rangeLimit);
      else if (args[i] === "--output-delimiter" && i + 1 < args.length)
        outputDelimiter = args[++i];
      else if (!args[i].startsWith("-")) files.push(args[i]);
    }
  } catch (error) {
    return fail(`cut: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const outDelim = outputDelimiter ?? delimiter;

  const doCut = (content: string) => {
    const lines = content.split("\n");
    const selectionCount = (bytes.length > 0 ? bytes.length : chars.length > 0 ? chars.length : fields.length);
    if (lines.length * Math.max(1, selectionCount) > rangeLimit) {
      throw new Error(`operation limit ${rangeLimit} exceeded`);
    }
    const output = lines
      .map((line) => {
        if (bytes.length > 0 || chars.length > 0) {
          const indices = bytes.length > 0 ? bytes : chars;
          return indices.map((idx) => line[idx - 1] ?? "").join("");
        }
        const parts = line.split(delimiter);
        return fields.map((f) => parts[f - 1] ?? "").join(outDelim);
      })
      .join("\n");
    const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
    if (output.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
    return output;
  };

  if (files.length === 0) {
    try { return ok(doCut(stdin ?? "")); }
    catch (error) { return fail(`cut: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  let out = "";
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    try {
      out += doCut(ctx.volume.readFileSync(p, "utf8"));
      if (out.length > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) throw new Error("output limit exceeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("limit")) return fail(`cut: ${message}\n`);
      return fail(`cut: ${file}: No such file or directory\n`);
    }
  }
  return ok(out);
};

/* ------------------------------------------------------------------ */
/*  Small text utilities                                               */
/* ------------------------------------------------------------------ */

const rev_cmd: BuiltinFn = (args, ctx, stdin) => {
  let content = stdin ?? "";
  if (args.length > 0) {
    const p = resolvePath(args[0], ctx.cwd);
    try {
      content = ctx.volume.readFileSync(p, "utf8");
    } catch {
      return fail(`rev: ${args[0]}: No such file or directory\n`);
    }
  }
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  if (content.length > outputLimit) return fail(`rev: input limit ${outputLimit} exceeded\n`);
  return ok(
    content
      .split("\n")
      .map((l) => [...l].reverse().join(""))
      .join("\n"),
  );
};

const paste_cmd: BuiltinFn = (args, ctx, stdin) => {
  const { opts, positional } = parseArgs(args, ["s"], ["d"]);
  const delim = opts["d"] || "\t";

  const contents: string[][] = [];
  for (const file of positional) {
    if (file === "-" && stdin) {
      contents.push(stdin.split("\n"));
      continue;
    }
    const p = resolvePath(file, ctx.cwd);
    try {
      contents.push(ctx.volume.readFileSync(p, "utf8").split("\n"));
    } catch {
      return fail(`paste: ${file}: No such file or directory\n`);
    }
  }
  if (contents.length === 0 && stdin) contents.push(stdin.split("\n"));

  const maxLen = contents.reduce((max, content) => Math.max(max, content.length), 0);
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (maxLen * Math.max(1, contents.length) > operationLimit) {
    return fail(`paste: operation limit ${operationLimit} exceeded\n`);
  }
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  let out = "";
  for (let i = 0; i < maxLen; i++) {
    out += contents.map((c) => c[i] ?? "").join(delim) + "\n";
    if (out.length > outputLimit) return fail(`paste: output limit ${outputLimit} exceeded\n`);
  }
  return ok(out);
};

const comm_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["1", "2", "3"]);
  if (positional.length < 2) return fail("comm: missing operand\n");

  const readFile = (f: string) => {
    const p = resolvePath(f, ctx.cwd);
    return ctx.volume.readFileSync(p, "utf8").split("\n").filter(Boolean);
  };

  try {
    const a = readFile(positional[0]);
    const b = readFile(positional[1]);
    const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
    if (a.length + b.length > operationLimit) return fail(`comm: operation limit ${operationLimit} exceeded\n`);
    const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
    let out = "";
    let ai = 0, bi = 0;
    while (ai < a.length || bi < b.length) {
      if (ai >= a.length) {
        if (!flags.has("2"))
          out += "\t" + (flags.has("1") ? "" : "\t") + b[bi] + "\n";
        bi++;
      } else if (bi >= b.length) {
        if (!flags.has("1")) out += a[ai] + "\n";
        ai++;
      } else if (a[ai] < b[bi]) {
        if (!flags.has("1")) out += a[ai] + "\n";
        ai++;
      } else if (a[ai] > b[bi]) {
        if (!flags.has("2"))
          out += "\t" + (flags.has("1") ? "" : "\t") + b[bi] + "\n";
        bi++;
      } else {
        if (!flags.has("3")) out += "\t\t" + a[ai] + "\n";
        ai++;
        bi++;
      }
      if (out.length > outputLimit) return fail(`comm: output limit ${outputLimit} exceeded\n`);
    }
    return ok(out);
  } catch (e) {
    return fail(`comm: ${e instanceof Error ? e.message : String(e)}\n`);
  }
};

/* ------------------------------------------------------------------ */
/*  diff                                                               */
/* ------------------------------------------------------------------ */

function simpleLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return result.reverse();
}

const diff_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["u", "q", "r", "N"]);
  if (positional.length < 2) return fail("diff: missing operand\n");

  const brief = flags.has("q");
  const unified = flags.has("u");

  const p1 = resolvePath(positional[0], ctx.cwd);
  const p2 = resolvePath(positional[1], ctx.cwd);

  try {
    const aText = ctx.volume.readFileSync(p1, "utf8");
    const bText = ctx.volume.readFileSync(p2, "utf8");
    const inputLimit = (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024) * 2;
    if (aText.length + bText.length > inputLimit) {
      return fail(`diff: input exceeds ${inputLimit} bytes\n`);
    }
    const a = aText.split("\n");
    const b = bText.split("\n");

    if (aText === bText) return ok();
    if (brief)
      return {
        stdout: `Files ${positional[0]} and ${positional[1]} differ\n`,
        stderr: "",
        exitCode: 1,
      };

    let out = "";
    const workLimit = ctx.limits?.maxLoopIterations ?? 100_000;
    const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
    if (unified) {
      const cells = (a.length + 1) * (b.length + 1);
      if (!Number.isSafeInteger(cells) || cells > workLimit) {
        return fail(`diff: comparison limit ${workLimit} exceeded\n`);
      }
      out += `--- ${positional[0]}\n+++ ${positional[1]}\n`;
      out += `@@ -1,${a.length} +1,${b.length} @@\n`;
      const lcs = simpleLCS(a, b);
      let ai = 0, bi = 0, li = 0;
      while (ai < a.length || bi < b.length) {
        if (
          li < lcs.length &&
          ai < a.length && a[ai] === lcs[li] &&
          bi < b.length && b[bi] === lcs[li]
        ) {
          out += ` ${a[ai]}\n`;
          ai++; bi++; li++;
        } else if (ai < a.length && (li >= lcs.length || a[ai] !== lcs[li])) {
          out += `-${a[ai]}\n`;
          ai++;
        } else if (bi < b.length) {
          out += `+${b[bi]}\n`;
          bi++;
        }
        if (out.length > outputLimit) return fail(`diff: output limit ${outputLimit} exceeded\n`);
      }
    } else {
      if (Math.max(a.length, b.length) > workLimit) {
        return fail(`diff: comparison limit ${workLimit} exceeded\n`);
      }
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) out += `> ${b[i]}\n`;
        else if (i >= b.length) out += `< ${a[i]}\n`;
        else if (a[i] !== b[i]) {
          out += `< ${a[i]}\n---\n> ${b[i]}\n`;
        }
        if (out.length > outputLimit) return fail(`diff: output limit ${outputLimit} exceeded\n`);
      }
    }

    return { stdout: out, stderr: "", exitCode: 1 };
  } catch (e) {
    return fail(`diff: ${e instanceof Error ? e.message : String(e)}\n`);
  }
};

/* ------------------------------------------------------------------ */
/*  seq / yes                                                          */
/* ------------------------------------------------------------------ */

const seq_cmd: BuiltinFn = async (args, ctx) => {
  if (args.length === 0) return fail("seq: missing operand\n");
  let first = 1, increment = 1, last = 1;
  if (args.length === 1) {
    last = parseFloat(args[0]);
  } else if (args.length === 2) {
    first = parseFloat(args[0]);
    last = parseFloat(args[1]);
  } else {
    first = parseFloat(args[0]);
    increment = parseFloat(args[1]);
    last = parseFloat(args[2]);
  }

  if (![first, increment, last].every(Number.isFinite) || increment === 0) {
    return fail("seq: invalid floating point argument\n");
  }
  const span = (last - first) / increment;
  const count = span < 0 ? 0 : Math.floor(span + Number.EPSILON) + 1;
  const iterationLimit = ctx.limits?.maxLoopIterations ?? 1_000_000;
  if (!Number.isSafeInteger(count) || count > iterationLimit) {
    return fail(`seq: iteration limit ${iterationLimit} exceeded\n`);
  }
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const lines: string[] = [];
  let outputLength = 0;
  for (let index = 0; index < count; index++) {
    if (ctx.signal?.aborted) return fail("seq: command cancelled\n", 130);
    if (index > 0 && (index & 255) === 0) await yieldToEventLoop(ctx.signal);
    const line = String(first + index * increment);
    outputLength += line.length + 1;
    if (outputLength > outputLimit) return fail(`seq: output exceeds ${outputLimit} bytes\n`);
    lines.push(line);
  }
  return ok(lines.join("\n") + (lines.length ? "\n" : ""));
};

const yes_cmd: BuiltinFn = (args) => {
  const text = args.length > 0 ? args.join(" ") : "y";
  return ok((text + "\n").repeat(YES_REPEAT_COUNT));
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const textProcessingCommands: [string, BuiltinFn][] = [
  ["echo", echo],
  ["printf", printf_cmd],
  ["grep", grep_cmd],
  ["egrep", grep_cmd],
  ["fgrep", grep_cmd],
  ["sed", sed_cmd],
  ["sort", sort_cmd],
  ["uniq", uniq_cmd],
  ["tr", tr_cmd],
  ["cut", cut_cmd],
  ["rev", rev_cmd],
  ["paste", paste_cmd],
  ["comm", comm_cmd],
  ["diff", diff_cmd],
  ["seq", seq_cmd],
  ["yes", yes_cmd],
];
