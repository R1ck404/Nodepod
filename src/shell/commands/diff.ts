import type { BuiltinFn, ShellContext } from "../shell-types.js";
import { resolvePath } from "../shell-helpers.js";

// GNU diff: the normal format (`2c2`, `3a4,5`, `1,2d0`), -u/-U N unified
// hunks with GNU's headers, -q, -s, -i, -w, -b, -B, -r over folders and
// `-` for stdin, with "\ No newline at end of file". Exit status 0 when the
// inputs are the same, 1 when they differ, 2 on trouble.

type Op = { kind: "=" | "-" | "+"; a: number; b: number };

interface Text {
  lines: string[];
  newlineAtEnd: boolean;
}

function split(content: string): Text {
  const lines = content.split("\n");
  const newlineAtEnd = content.endsWith("\n");
  if (newlineAtEnd || content === "") lines.pop();
  return { lines, newlineAtEnd };
}

// Myers' O(ND) diff over line keys; `limit` bounds the edit-graph steps and
// 100 times that the lines compared along diagonals
function editScript(a: string[], b: string[], limit: number): Op[] {
  let snakes = 0;
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  const trace: number[][] = [];
  let work = 0;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; if (++snakes > limit * 100) throw new Error("comparison limit exceeded"); }
      v[offset + k] = x;
      if (x >= n && y >= m) { trace.push(v.slice()); break outer; }
      if (++work > limit) throw new Error("comparison limit exceeded");
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push({ kind: "=", a: --x, b: --y });
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: "+", a: x, b: --y });
    else ops.push({ kind: "-", a: --x, b: y });
  }
  while (x > 0 && y > 0) ops.push({ kind: "=", a: --x, b: --y });
  return ops.reverse();
}

function range(start: number, count: number): string {
  // 1-based lines start..start+count-1
  return count <= 1 ? String(count === 0 ? start - 1 : start) : `${start},${start + count - 1}`;
}

function unifiedRange(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? String(start) : `${start},${count}`;
}

function stamp(ctx: ShellContext, path: string | null): string {
  let date = new Date();
  if (path) {
    try { date = new Date(ctx.volume.statSync(path).mtimeMs); } catch { /* now */ }
  }
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -date.getTimezoneOffset();
  const zone = (offset >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(offset) / 60)) + pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}000000 ${zone}`;
}

interface Options {
  unified: number | null;
  brief: boolean;
  reportSame: boolean;
  ignoreCase: boolean;
  ignoreAllSpace: boolean;
  ignoreSpaceChange: boolean;
  ignoreBlankLines: boolean;
  recursive: boolean;
  newFile: boolean;
}

function compareTexts(left: Text, right: Text, labels: [string, string], paths: [string | null, string | null], options: Options, ctx: ShellContext): string | null {
  const key = (text: Text) => text.lines.map((line, index) => {
    let k = line;
    if (options.ignoreAllSpace) k = k.replace(/\s+/g, "");
    else if (options.ignoreSpaceChange) k = k.replace(/\s+/g, " ").replace(/ $/, "");
    if (options.ignoreCase) k = k.toLowerCase();
    // a last line without a newline differs from the same line with one
    return index === text.lines.length - 1 && !text.newlineAtEnd ? k + "\0" : k;
  });
  const limit = ctx.limits?.maxLoopIterations ?? 100_000;
  const ops = editScript(key(left), key(right), limit);
  let changes = ops.some((op) => op.kind !== "=");
  if (changes && options.ignoreBlankLines) {
    changes = ops.some((op) => (op.kind === "-" && left.lines[op.a].trim() !== "") || (op.kind === "+" && right.lines[op.b].trim() !== ""));
  }
  if (!changes) return null;
  if (options.brief) return `Files ${labels[0]} and ${labels[1]} differ\n`;

  const noNewline = "\\ No newline at end of file\n";
  const aLine = (index: number, prefix: string) => prefix + left.lines[index] + "\n" + (index === left.lines.length - 1 && !left.newlineAtEnd ? noNewline : "");
  const bLine = (index: number, prefix: string) => prefix + right.lines[index] + "\n" + (index === right.lines.length - 1 && !right.newlineAtEnd ? noNewline : "");

  let out = "";
  if (options.unified === null) {
    for (let i = 0; i < ops.length;) {
      if (ops[i].kind === "=") { i++; continue; }
      const startA = ops[i].a;
      const startB = ops[i].b;
      const removed: number[] = [];
      const added: number[] = [];
      while (i < ops.length && ops[i].kind !== "=") {
        if (ops[i].kind === "-") removed.push(ops[i].a);
        else added.push(ops[i].b);
        i++;
      }
      if (removed.length && added.length) {
        out += `${range(startA + 1, removed.length)}c${range(startB + 1, added.length)}\n`;
        for (const index of removed) out += aLine(index, "< ");
        out += "---\n";
        for (const index of added) out += bLine(index, "> ");
      } else if (removed.length) {
        out += `${range(startA + 1, removed.length)}d${startB}\n`;
        for (const index of removed) out += aLine(index, "< ");
      } else {
        out += `${startA}a${range(startB + 1, added.length)}\n`;
        for (const index of added) out += bLine(index, "> ");
      }
    }
    return out;
  }

  const context = options.unified;
  out += `--- ${labels[0]}\t${stamp(ctx, paths[0])}\n+++ ${labels[1]}\t${stamp(ctx, paths[1])}\n`;
  const changed = ops.map((op, index) => op.kind !== "=" ? index : -1).filter((index) => index >= 0);
  let h = 0;
  while (h < changed.length) {
    let first = Math.max(0, changed[h] - context);
    let last = Math.min(ops.length - 1, changed[h] + context);
    while (h + 1 < changed.length && changed[h + 1] - context <= last + 1) {
      h++;
      last = Math.min(ops.length - 1, changed[h] + context);
    }
    h++;
    first = Math.max(0, first);
    const hunk = ops.slice(first, last + 1);
    const aStart = (hunk.find((op) => op.kind !== "+")?.a ?? hunk[0].a) + 1;
    const bStart = (hunk.find((op) => op.kind !== "-")?.b ?? hunk[0].b) + 1;
    const aCount = hunk.filter((op) => op.kind !== "+").length;
    const bCount = hunk.filter((op) => op.kind !== "-").length;
    out += `@@ -${unifiedRange(aCount ? aStart : hunk[0].a + 1, aCount)} +${unifiedRange(bCount ? bStart : hunk[0].b + 1, bCount)} @@\n`;
    for (const op of hunk) {
      if (op.kind === "=") out += aLine(op.a, " ");
      else if (op.kind === "-") out += aLine(op.a, "-");
      else out += bLine(op.b, "+");
    }
  }
  return out;
}

export const diff_cmd: BuiltinFn = async (args, ctx, stdin) => {
  const options: Options = {
    unified: null, brief: false, reportSame: false, ignoreCase: false, ignoreAllSpace: false,
    ignoreSpaceChange: false, ignoreBlankLines: false, recursive: false, newFile: false,
  };
  const operands: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (endOfOptions || arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (arg === "--") { endOfOptions = true; continue; }
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split("=");
      if (name === "unified") options.unified = value === undefined ? 3 : Number(value);
      else if (name === "brief") options.brief = true;
      else if (name === "report-identical-files") options.reportSame = true;
      else if (name === "ignore-case") options.ignoreCase = true;
      else if (name === "ignore-all-space") options.ignoreAllSpace = true;
      else if (name === "ignore-space-change") options.ignoreSpaceChange = true;
      else if (name === "ignore-blank-lines") options.ignoreBlankLines = true;
      else if (name === "recursive") options.recursive = true;
      else if (name === "new-file") options.newFile = true;
      else if (name === "color" || name === "strip-trailing-cr" || name === "text") continue;
      else return { stdout: "", stderr: `diff: unrecognized option '${arg}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 };
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (flag === "U") {
        const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
        options.unified = Number(value);
        if (!Number.isSafeInteger(options.unified) || options.unified < 0) return { stdout: "", stderr: `diff: invalid context length '${value}'\n`, exitCode: 2 };
        break;
      }
      if (/\d/.test(flag)) { options.unified = Number(arg.slice(j).match(/^\d+/)![0]); break; }
      if (flag === "u") options.unified ??= 3;
      else if (flag === "q") options.brief = true;
      else if (flag === "s") options.reportSame = true;
      else if (flag === "i") options.ignoreCase = true;
      else if (flag === "w") options.ignoreAllSpace = true;
      else if (flag === "b") options.ignoreSpaceChange = true;
      else if (flag === "B") options.ignoreBlankLines = true;
      else if (flag === "r") options.recursive = true;
      else if (flag === "N") options.newFile = true;
      else if (flag === "a" || flag === "t") continue;
      else return { stdout: "", stderr: `diff: invalid option -- '${flag}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 };
    }
  }
  if (operands.length < 2) {
    return { stdout: "", stderr: `diff: missing operand after '${operands[0] ?? "diff"}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 };
  }
  if (operands.length > 2) return { stdout: "", stderr: `diff: extra operand '${operands[2]}'\ndiff: Try 'diff --help' for more information.\n`, exitCode: 2 };

  let stdout = "";
  let stderr = "";
  let status = 0;
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const kind = (path: string): "file" | "dir" | null => {
    try { return ctx.volume.statSync(path).isDirectory() ? "dir" : "file"; } catch { return null; }
  };
  const read = (path: string): Text => split(ctx.volume.readFileSync(path, "utf8"));
  const compareFiles = (aShown: string, bShown: string, aPath: string | null, bPath: string | null, header: string) => {
    for (const [shown, path] of [[aShown, aPath], [bShown, bPath]] as const) {
      if (path !== null && !kind(path) && !options.newFile) {
        stderr += `diff: ${shown}: No such file or directory\n`;
        status = 2;
        return;
      }
    }
    const left = aPath === null ? split(stdin ?? "") : kind(aPath) ? read(aPath) : split("");
    const right = bPath === null ? split(stdin ?? "") : kind(bPath) ? read(bPath) : split("");
    const result = compareTexts(left, right, [aShown, bShown], [aPath, bPath], options, ctx);
    if (result === null) {
      if (options.reportSame) stdout += `Files ${aShown} and ${bShown} are identical\n`;
      return;
    }
    status = 1;
    stdout += (header && !options.brief ? header : "") + result;
    if (stdout.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
  };
  const compareDirs = (aShown: string, bShown: string, aPath: string, bPath: string) => {
    const names = new Set([...ctx.volume.readdirSync(aPath), ...ctx.volume.readdirSync(bPath)]);
    for (const name of [...names].sort()) {
      const a = `${aPath}/${name}`;
      const b = `${bPath}/${name}`;
      const aKind = kind(a);
      const bKind = kind(b);
      const aChild = `${aShown}/${name}`;
      const bChild = `${bShown}/${name}`;
      if (!aKind || !bKind) {
        if (options.newFile && (aKind ?? bKind) === "file") { compareFiles(aChild, bChild, a, b, `diff ${options.unified !== null ? "-u " : ""}${options.recursive ? "-r " : ""}${aChild} ${bChild}\n`); continue; }
        stdout += `Only in ${aKind ? aShown : bShown}: ${name}\n`;
        status = 1;
        continue;
      }
      if (aKind === "dir" && bKind === "dir") {
        if (options.recursive) compareDirs(aChild, bChild, a, b);
        else stdout += `Common subdirectories: ${aChild} and ${bChild}\n`;
        continue;
      }
      if (aKind !== bKind) {
        stdout += `File ${aChild} is a ${aKind === "dir" ? "directory" : "regular file"} while file ${bChild} is a ${bKind === "dir" ? "directory" : "regular file"}\n`;
        status = 1;
        continue;
      }
      compareFiles(aChild, bChild, a, b, `diff ${options.unified !== null ? "-u " : ""}${options.recursive ? "-r " : ""}${aChild} ${bChild}\n`);
    }
  };

  try {
    const [aShown, bShown] = operands;
    const aPath = aShown === "-" ? null : resolvePath(aShown, ctx.cwd);
    const bPath = bShown === "-" ? null : resolvePath(bShown, ctx.cwd);
    const aKind = aPath === null ? "file" : kind(aPath);
    const bKind = bPath === null ? "file" : kind(bPath);
    for (const [shown, k] of [[aShown, aKind], [bShown, bKind]] as const) {
      if (!k && !(options.newFile && (aKind ?? bKind))) stderr += `diff: ${shown}: No such file or directory\n`;
    }
    if (stderr) return { stdout, stderr, exitCode: 2 };
    if (aKind === "dir" && bKind === "dir") compareDirs(aShown, bShown, aPath!, bPath!);
    else if (aKind === "dir" || bKind === "dir") {
      // diff dir file compares dir/file's name in the folder
      const dirPath = aKind === "dir" ? aPath! : bPath!;
      const file = aKind === "dir" ? bShown : aShown;
      const name = file.slice(file.lastIndexOf("/") + 1);
      const inDir = `${dirPath}/${name}`;
      const inDirShown = `${aKind === "dir" ? aShown : bShown}/${name}`;
      if (aKind === "dir") compareFiles(inDirShown, bShown, inDir, bPath, "");
      else compareFiles(aShown, inDirShown, aPath, inDir, "");
    } else compareFiles(aShown, bShown, aPath, bPath, "");
  } catch (error) {
    return { stdout, stderr: stderr + `diff: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 2 };
  }
  return { stdout, stderr, exitCode: status };
};
