import type { BuiltinFn } from "../shell-types.js";
import { fail, resolvePath, collator } from "../shell-helpers.js";

// GNU sort: keys (-k F[.C][opts][,F[.C][opts]], several), -t, the orderings
// -n -g -h -M -V -d -f -i -b -r per key or for the whole line, GNU's
// last-resort comparison of whole lines (off with -s or -u), -u, -c/-C,
// -o (written after all input is read, so `sort -o f f` works), several
// files and `-`.

interface Ordering {
  blanks: boolean;
  dictionary: boolean;
  foldCase: boolean;
  ignoreNonprinting: boolean;
  numeric: boolean;
  general: boolean;
  human: boolean;
  month: boolean;
  version: boolean;
  reverse: boolean;
}

interface Key extends Ordering {
  startField: number;
  startChar: number;
  endField: number;   // 0: to the end of the line
  endChar: number;    // 0: to the end of the field
  startBlanks: boolean;
  endBlanks: boolean;
}

const noOrdering = (): Ordering => ({
  blanks: false, dictionary: false, foldCase: false, ignoreNonprinting: false,
  numeric: false, general: false, human: false, month: false, version: false, reverse: false,
});

function applyFlag(ordering: Ordering, flag: string): boolean {
  switch (flag) {
    case "b": ordering.blanks = true; return true;
    case "d": ordering.dictionary = true; return true;
    case "f": ordering.foldCase = true; return true;
    case "i": ordering.ignoreNonprinting = true; return true;
    case "n": ordering.numeric = true; return true;
    case "g": ordering.general = true; return true;
    case "h": ordering.human = true; return true;
    case "M": ordering.month = true; return true;
    case "V": ordering.version = true; return true;
    case "r": ordering.reverse = true; return true;
    default: return false;
  }
}

function parseKey(spec: string, global: Ordering): Key | string {
  const m = spec.match(/^(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfgiMhnRrV]*))?$/);
  if (!m || Number(m[1]) === 0 || (m[2] !== undefined && Number(m[2]) === 0)) return `sort: invalid number at field start: invalid count at start of '${spec}'\n`;
  const ordering = noOrdering();
  const flags = (m[3] ?? "") + (m[6] ?? "");
  for (const flag of flags) applyFlag(ordering, flag);
  // a key without its own ordering options takes the global ones
  const hasOwn = flags.replace(/b/g, "") !== "";
  const base = hasOwn ? ordering : { ...global, blanks: global.blanks || ordering.blanks };
  return {
    ...base,
    startField: Number(m[1]),
    startChar: m[2] ? Number(m[2]) : 1,
    endField: m[4] ? Number(m[4]) : 0,
    endChar: m[5] ? Number(m[5]) : 0,
    startBlanks: (m[3] ?? "").includes("b") || (!hasOwn && global.blanks),
    endBlanks: (m[6] ?? "").includes("b") || (!hasOwn && global.blanks),
  };
}

// fields as GNU sort splits them: with -t at each separator; otherwise each
// field starts with the blanks before it
function fieldStarts(line: string, separator: string | undefined): { start: number; end: number }[] {
  const fields: { start: number; end: number }[] = [];
  if (separator !== undefined) {
    let start = 0;
    for (;;) {
      const at = line.indexOf(separator, start);
      if (at < 0) { fields.push({ start, end: line.length }); break; }
      fields.push({ start, end: at });
      start = at + separator.length;
    }
    return fields;
  }
  let i = 0;
  while (i < line.length) {
    const start = i;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    while (i < line.length && line[i] !== " " && line[i] !== "\t") i++;
    fields.push({ start, end: i });
  }
  if (!fields.length) fields.push({ start: 0, end: 0 });
  return fields;
}

function keyText(line: string, key: Key, separator: string | undefined): string {
  const fields = fieldStarts(line, separator);
  const skipBlanks = (from: number, limit: number) => {
    while (from < limit && (line[from] === " " || line[from] === "\t")) from++;
    return from;
  };
  if (key.startField > fields.length) return "";
  const startFieldInfo = fields[key.startField - 1];
  let start = startFieldInfo.start;
  if (key.startBlanks) start = skipBlanks(start, startFieldInfo.end);
  start = Math.min(start + key.startChar - 1, startFieldInfo.end);
  let end = line.length;
  if (key.endField) {
    if (key.endField <= fields.length) {
      const endFieldInfo = fields[key.endField - 1];
      if (key.endChar === 0) end = endFieldInfo.end;
      else {
        let from = endFieldInfo.start;
        if (key.endBlanks) from = skipBlanks(from, endFieldInfo.end);
        end = Math.min(from + key.endChar, endFieldInfo.end);
      }
    }
  }
  return end > start ? line.slice(start, end) : "";
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function numericValue(text: string): number {
  const m = text.match(/^\s*(-?)(\d*)(?:\.(\d*))?/);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return 0;
  return Number(`${m[1]}${m[2] || "0"}.${m[3] || "0"}`);
}

function humanValue(text: string): number {
  const m = text.match(/^\s*(-?\d*(?:\.\d*)?)([KMGTPEZY]?)/i);
  if (!m || !/\d/.test(m[1])) return 0;
  const power = " KMGTPEZY".indexOf((m[2] || " ").toUpperCase());
  const value = Number(m[1]);
  // GNU compares the suffix first, then the number: 2000K < 1M
  return (value < 0 ? -1 : 1) * (Math.max(power, 0) * 1e15 + Math.abs(value));
}

function versionCompare(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = Number(x) - Number(y);
      if (diff) return diff;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}

function compareBy(ordering: Ordering, a: string, b: string, plain: (a: string, b: string) => number): number {
  let x = a;
  let y = b;
  if (ordering.blanks) { x = x.replace(/^[ \t]+/, ""); y = y.replace(/^[ \t]+/, ""); }
  if (ordering.dictionary) { x = x.replace(/[^A-Za-z0-9 \t]/g, ""); y = y.replace(/[^A-Za-z0-9 \t]/g, ""); }
  if (ordering.ignoreNonprinting) { x = x.replace(/[^\x20-\x7e]/g, ""); y = y.replace(/[^\x20-\x7e]/g, ""); }
  let result: number;
  if (ordering.numeric) result = numericValue(x) - numericValue(y);
  else if (ordering.general) {
    const nx = parseFloat(x), ny = parseFloat(y);
    result = Number.isNaN(nx) ? (Number.isNaN(ny) ? 0 : -1) : Number.isNaN(ny) ? 1 : nx - ny;
  } else if (ordering.human) result = humanValue(x) - humanValue(y);
  else if (ordering.month) {
    const mx = MONTHS.indexOf(x.trim().slice(0, 3).toUpperCase());
    const my = MONTHS.indexOf(y.trim().slice(0, 3).toUpperCase());
    result = mx - my;
  } else if (ordering.version) result = versionCompare(x, y);
  else if (ordering.foldCase) result = plain(x.toUpperCase(), y.toUpperCase());
  else result = plain(x, y);
  result = Math.sign(result);
  return ordering.reverse ? -result : result;
}

export const sort_cmd: BuiltinFn = (args, ctx, stdin) => {
  const plain = collator(ctx.env);
  const global = noOrdering();
  const keySpecs: string[] = [];
  let separator: string | undefined;
  let output: string | undefined;
  let unique = false;
  let stable = false;
  let check: "report" | "quiet" | null = null;
  const files: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!options || arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "--") { options = false; continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const value = () => eq > 0 ? arg.slice(eq + 1) : args[++i];
      const longFlags: Record<string, string> = {
        "ignore-leading-blanks": "b", "dictionary-order": "d", "ignore-case": "f", "ignore-nonprinting": "i",
        "numeric-sort": "n", "general-numeric-sort": "g", "human-numeric-sort": "h", "month-sort": "M",
        "version-sort": "V", reverse: "r",
      };
      if (longFlags[name]) applyFlag(global, longFlags[name]);
      else if (name === "unique") unique = true;
      else if (name === "stable") stable = true;
      else if (name === "check") check = value() === "quiet" ? "quiet" : "report";
      else if (name === "key") keySpecs.push(value() ?? "");
      else if (name === "field-separator") separator = value();
      else if (name === "output") output = value();
      else if (name === "merge" || name === "random-sort" || name.startsWith("parallel") || name.startsWith("buffer-size") || name.startsWith("temporary-directory")) continue;
      else return fail(`sort: unrecognized option '${arg}'\nTry 'sort --help' for more information.\n`, 2);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ("ktoST".includes(flag)) {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        if (value === undefined) return fail(`sort: option requires an argument -- '${flag}'\n`, 2);
        if (flag === "k") keySpecs.push(value);
        else if (flag === "t") {
          if (value.length !== 1 && value !== "\\0") return fail(`sort: multi-character tab '${value}'\n`, 2);
          separator = value === "\\0" ? "\0" : value;
        } else if (flag === "o") output = value;
        break;
      }
      if (applyFlag(global, flag)) continue;
      if (flag === "u") unique = true;
      else if (flag === "s") stable = true;
      else if (flag === "c") check = "report";
      else if (flag === "C") check = "quiet";
      else if (flag === "m" || flag === "R" || flag === "z") continue;
      else return fail(`sort: invalid option -- '${flag}'\nTry 'sort --help' for more information.\n`, 2);
    }
  }
  const keys: Key[] = [];
  for (const spec of keySpecs) {
    const key = parseKey(spec, global);
    if (typeof key === "string") return fail(key, 2);
    keys.push(key);
  }

  const lines: string[] = [];
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  for (const file of files.length ? files : ["-"]) {
    let content: string;
    if (file === "-") content = stdin ?? "";
    else {
      try { content = ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8"); }
      catch { return fail(`sort: cannot read: ${file}: No such file or directory\n`, 2); }
    }
    const split = content.split("\n");
    if (content.endsWith("\n") || content === "") split.pop();
    lines.push(...split);
    if (lines.length > operationLimit) return fail(`sort: operation limit ${operationLimit} exceeded\n`, 2);
  }

  const compareKeys = (a: string, b: string): number => {
    if (!keys.length) return compareBy({ ...global, reverse: false }, a, b, plain);
    for (const key of keys) {
      const result = compareBy({ ...key, reverse: false }, keyText(a, key, separator), keyText(b, key, separator), plain);
      if (result) return key.reverse ? -result : result;
    }
    return 0;
  };
  // without keys the global -r applies to the comparison itself
  const keyed = (a: string, b: string) => {
    const result = compareKeys(a, b);
    return !keys.length && global.reverse ? -result : result;
  };
  const lastResort = !stable && !unique;
  const compare = (a: string, b: string): number => {
    const result = keyed(a, b);
    if (result || !lastResort) return result;
    const whole = plain(a, b);
    return global.reverse ? -whole : whole;
  };

  if (check) {
    for (let i = 1; i < lines.length; i++) {
      const result = compare(lines[i - 1], lines[i]);
      if (result > 0 || (unique && keyed(lines[i - 1], lines[i]) === 0)) {
        return check === "quiet"
          ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: "", stderr: `sort: ${files[0] ?? "-"}:${i + 1}: disorder: ${lines[i]}\n`, exitCode: 1 };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  const sorted = lines.map((line, index) => ({ line, index }))
    .sort((a, b) => compare(a.line, b.line) || a.index - b.index)
    .map((entry) => entry.line);
  const result = unique ? sorted.filter((line, i) => i === 0 || keyed(sorted[i - 1], line) !== 0) : sorted;
  const text = result.length ? result.join("\n") + "\n" : "";
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  if (text.length > outputLimit) return fail(`sort: output limit ${outputLimit} exceeded\n`, 2);
  if (output !== undefined) {
    try { ctx.volume.writeFileSync(resolvePath(output, ctx.cwd), text); }
    catch { return fail(`sort: open failed: ${output}: No such file or directory\n`, 2); }
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  return { stdout: text, stderr: "", exitCode: 0 };
};
