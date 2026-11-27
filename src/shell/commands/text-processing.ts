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
import { sed_cmd } from "./sed.js";
import { grep_cmd } from "./grep.js";
import { diff_cmd } from "./diff.js";
import { sort_cmd } from "./sort.js";

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

const printf_cmd: BuiltinFn = (rawArgs, ctx) => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length === 0) return fail("printf: usage: printf [-v var] format [arguments]\n", 2);
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
/*  sort                                                               */
/* ------------------------------------------------------------------ */


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

  let onlyDelimited = false;
  try {
    // options take their value attached (`-d,`, `-f1`) or as the next word,
    // and in their long forms (`--delimiter=,`)
    const long: Record<string, string> = { delimiter: "d", fields: "f", bytes: "b", characters: "c" };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let option: string | null = null;
      let value: string | undefined;
      if (arg === "-s" || arg === "--only-delimited") { onlyDelimited = true; continue; }
      if (arg === "--") { files.push(...args.slice(i + 1)); break; }
      const longMatch = arg.match(/^--([a-z-]+)(?:=(.*))?$/s);
      if (longMatch && (longMatch[1] in long || longMatch[1] === "output-delimiter")) {
        option = longMatch[1] === "output-delimiter" ? "o" : long[longMatch[1]];
        value = longMatch[2] ?? args[++i];
      } else if (/^-[dfbc]/.test(arg)) {
        option = arg[1];
        value = arg.length > 2 ? arg.slice(2) : args[++i];
      } else if (arg === "-" || !arg.startsWith("-")) {
        files.push(arg);
        continue;
      } else {
        continue;
      }
      if (value === undefined) return fail(`cut: option requires an argument -- '${option}'\n`);
      if (option === "d") delimiter = value;
      else if (option === "o") outputDelimiter = value;
      else if (option === "f") fields = parseRangeSpec(value, rangeLimit);
      else if (option === "b") bytes = parseRangeSpec(value, rangeLimit);
      else if (option === "c") chars = parseRangeSpec(value, rangeLimit);
    }
  } catch (error) {
    return fail(`cut: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (fields.length === 0 && bytes.length === 0 && chars.length === 0) {
    return fail("cut: you must specify a list of bytes, characters, or fields\n");
  }

  const outDelim = outputDelimiter ?? delimiter;

  const doCut = (content: string) => {
    const trailingNewline = content.endsWith("\n");
    const lines = (trailingNewline ? content.slice(0, -1) : content).split("\n");
    if (content === "") return "";
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
        // a line without the delimiter is printed whole, or dropped with -s
        if (!line.includes(delimiter)) return onlyDelimited ? null : line;
        const parts = line.split(delimiter);
        return fields.filter((f) => f <= parts.length).map((f) => parts[f - 1]).join(outDelim);
      })
      .filter((line): line is string => line !== null)
      .map((line) => line + "\n")
      .join("");
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
      out += doCut(file === "-" ? stdin ?? "" : ctx.volume.readFileSync(p, "utf8"));
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

// GNU paste: lines of the files side by side, or each file's lines on one
// line with -s; -d's list (with \t, \n, \\ and \0) is used in turn
const paste_cmd: BuiltinFn = (args, ctx, stdin) => {
  let serial = false;
  let delimiters = "\t";
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "--serial") { serial = true; continue; }
    if (arg.startsWith("--delimiters=")) { delimiters = arg.slice(13); continue; }
    for (let j = 1; j < arg.length; j++) {
      if (arg[j] === "s") serial = true;
      else if (arg[j] === "d") { delimiters = j + 1 < arg.length ? arg.slice(j + 1) : args[++i] ?? ""; break; }
      else if (arg[j] === "z") continue;
      else return fail(`paste: invalid option -- '${arg[j]}'\n`);
    }
  }
  const delims: string[] = [];
  for (let i = 0; i < delimiters.length; i++) {
    if (delimiters[i] === "\\" && i + 1 < delimiters.length) {
      const c = delimiters[++i];
      delims.push(c === "t" ? "\t" : c === "n" ? "\n" : c === "0" ? "" : c);
    } else delims.push(delimiters[i]);
  }
  if (!delims.length) delims.push("");
  if (!files.length) files.push("-");
  const toLines = (content: string) => {
    const lines = content.split("\n");
    if (content.endsWith("\n") || content === "") lines.pop();
    return lines;
  };
  const contents: string[][] = [];
  let stdinLines: string[] | null = null;
  for (const file of files) {
    if (file === "-") { stdinLines ??= toLines(stdin ?? ""); contents.push(stdinLines); continue; }
    try { contents.push(toLines(ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8"))); }
    catch { return fail(`paste: ${file}: No such file or directory\n`); }
  }
  const join = (fields: string[]) => fields.reduce((line, field, i) => i === 0 ? field : line + delims[(i - 1) % delims.length] + field, "");
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  let out = "";
  if (serial) {
    for (const lines of contents) {
      if (lines.length > operationLimit) return fail(`paste: operation limit ${operationLimit} exceeded\n`);
      out += join(lines) + "\n";
      if (out.length > outputLimit) return fail(`paste: output limit ${outputLimit} exceeded\n`);
    }
    return ok(out);
  }
  // `paste - -` reads stdin's lines in turn into each column
  const cursors = new Map<string[], number>();
  const maxLen = Math.max(0, ...contents.map((lines) => {
    const sharing = contents.filter((other) => other === lines).length;
    return Math.ceil(lines.length / sharing);
  }));
  if (maxLen * Math.max(1, contents.length) > operationLimit) return fail(`paste: operation limit ${operationLimit} exceeded\n`);
  for (let row = 0; row < maxLen; row++) {
    const fields = contents.map((lines) => {
      const at = cursors.get(lines) ?? 0;
      cursors.set(lines, at + 1);
      return lines[at] ?? "";
    });
    out += join(fields) + "\n";
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
  ["grep", grep_cmd("basic")],
  ["egrep", grep_cmd("extended")],
  ["fgrep", grep_cmd("fixed")],
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
