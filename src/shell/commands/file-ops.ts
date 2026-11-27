import type { BuiltinFn, ShellContext, ShellResult } from "../shell-types.js";
import {
  ok,
  fail,
  resolvePath,
  parseArgs,
  pathModule,
  yieldToEventLoop,
} from "../shell-helpers.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// GNU cat's -n, -b, -s, -E, -T and -v over one input; `state` carries the
// line number and the last line's blankness across inputs, as GNU's does.
function formatCat(
  content: string,
  numberAll: boolean,
  numberNonBlank: boolean,
  squeeze: boolean,
  showEnds: boolean,
  showTabs: boolean,
  showNonprinting: boolean,
  state: { line: number; previousBlank: boolean },
): string {
  if (!numberAll && !numberNonBlank && !squeeze && !showEnds && !showTabs && !showNonprinting) return content;
  const endsWithNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (endsWithNewline) lines.pop();
  let out = "";
  lines.forEach((line, index) => {
    const hasNewline = index < lines.length - 1 || endsWithNewline;
    const blank = line.length === 0;
    if (squeeze && blank && state.previousBlank && hasNewline) return;
    state.previousBlank = blank;
    let text = line;
    if (showNonprinting) {
      let visible = "";
      for (const char of text) {
        const code = char.charCodeAt(0);
        if (code === 9) visible += showTabs ? "^I" : char;
        else if (code < 32) visible += `^${String.fromCharCode(code + 64)}`;
        else if (code === 127) visible += "^?";
        else visible += char;
      }
      text = visible;
    } else if (showTabs) text = text.replace(/\t/g, "^I");
    if (numberNonBlank ? !blank : numberAll) text = `${String(state.line++).padStart(6)}\t${text}`;
    if (showEnds && hasNewline) text += "$";
    out += text + (hasNewline ? "\n" : "");
  });
  return out;
}

interface TreeWalkState {
  entries: number;
}

function visitTreeEntry(ctx: ShellContext, state: TreeWalkState): void {
  if (ctx.signal?.aborted) throw new Error("shell: command cancelled");
  state.entries++;
  const limit = ctx.limits?.maxFilesystemEntries ?? 100_000;
  if (state.entries > limit) {
    throw new Error(`shell: filesystem entry limit ${limit} exceeded`);
  }
}

async function yieldTreeWork(ctx: ShellContext, state: TreeWalkState): Promise<void> {
  if ((state.entries & 127) === 0) await yieldToEventLoop(ctx.signal);
}

async function copyTree(ctx: ShellContext, src: string, dst: string, state: TreeWalkState): Promise<void> {
  visitTreeEntry(ctx, state);
  await yieldTreeWork(ctx, state);
  const stat = ctx.volume.lstatSync(src);
  if (stat.isSymbolicLink()) {
    const parent = pathModule.dirname(dst);
    ctx.volume.mkdirSync(parent, { recursive: true });
    if (ctx.volume.existsSync(dst)) ctx.volume.unlinkSync(dst);
    ctx.volume.symlinkSync(ctx.volume.readlinkSync(src), dst);
    return;
  }
  if (!stat.isDirectory()) {
    const parent = pathModule.dirname(dst);
    ctx.volume.mkdirSync(parent, { recursive: true });
    ctx.volume.writeFileSync(dst, ctx.volume.readFileSync(src));
    return;
  }

  ctx.volume.mkdirSync(dst, { recursive: true });
  for (const name of ctx.volume.readdirSync(src)) {
    await copyTree(ctx, `${src}/${name}`, `${dst}/${name}`, state);
  }
}

async function removeTree(ctx: ShellContext, dir: string, state: TreeWalkState): Promise<void> {
  visitTreeEntry(ctx, state);
  await yieldTreeWork(ctx, state);
  const stat = ctx.volume.lstatSync(dir);
  if (!stat.isDirectory()) {
    ctx.volume.unlinkSync(dir);
    return;
  }
  for (const name of ctx.volume.readdirSync(dir)) {
    await removeTree(ctx, `${dir}/${name}`, state);
  }
  ctx.volume.rmdirSync(dir);
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

const cat: BuiltinFn = (args, ctx, stdin) => {
  const { flags, positional } = parseArgs(args, [
    "n",
    "b",
    "s",
    "E",
    "T",
    "A",
    "e",
    "t",
    "v",
  ]);
  const numberAll = flags.has("n");
  const numberNonBlank = flags.has("b");
  const squeeze = flags.has("s");
  const showEnds = flags.has("E") || flags.has("A") || flags.has("e");
  const showTabs = flags.has("T") || flags.has("A") || flags.has("t");
  const showNonprinting = flags.has("v") || flags.has("A") || flags.has("e") || flags.has("t");
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const state = { line: 1, previousBlank: false };
  const appendFormatted = (current: string, content: string): string => {
    if (content.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
    const formatted = formatCat(content, numberAll, numberNonBlank, squeeze, showEnds, showTabs, showNonprinting, state);
    if (current.length + formatted.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
    return current + formatted;
  };

  if (positional.length === 0 && stdin !== undefined) {
    try { return ok(appendFormatted("", stdin)); }
    catch (error) { return fail(`cat: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  if (positional.length === 0) return fail("cat: missing operand\n");

  let out = "";
  let stderr = "";
  for (const file of positional) {
    if (file === "-") {
      try { out = appendFormatted(out, stdin ?? ""); }
      catch (error) { return fail(`cat: ${error instanceof Error ? error.message : String(error)}\n`); }
      continue;
    }
    const p = resolvePath(file, ctx.cwd);
    let content: string;
    try {
      content = ctx.volume.readFileSync(p, "utf8");
    } catch {
      let directory = false;
      try { directory = ctx.volume.statSync(p).isDirectory(); } catch { /* missing */ }
      stderr += `cat: ${file}: ${directory ? "Is a directory" : "No such file or directory"}\n`;
      continue;
    }
    try { out = appendFormatted(out, content); }
    catch (error) { return { stdout: out, stderr: stderr + `cat: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }; }
  }
  return { stdout: out, stderr, exitCode: stderr ? 1 : 0 };
};

// head and tail: -n/-c with GNU's forms (`-n 5`, `-n5`, `-5`, `--lines=5`,
// head's `-n -5` for all but the last 5, tail's `-n +5` from the 5th and the
// old `+5`), `==> file <==` headers for several files (-q, -v), and errors
// that don't stop the other files.
function headTail(name: "head" | "tail"): BuiltinFn {
  return (args, ctx, stdin) => {
    let count = 10;
    let bytes = false;
    let fromStart = false;   // tail +N, or head -N's "all but the last N"
    let headers: boolean | undefined;
    const files: string[] = [];
    const usage = (value: string) => fail(`${name}: invalid number of ${bytes ? "bytes" : "lines"}: '${value}'\n`);
    const setCount = (value: string | undefined, isBytes: boolean): ShellResult | null => {
      bytes = isBytes;
      if (value === undefined) return fail(`${name}: option requires an argument -- '${isBytes ? "c" : "n"}'\n`);
      const m = value.match(/^([+-]?)(\d+)([kKmMgGbB]?)$/);
      if (!m) return usage(value);
      const unit = { "": 1, k: 1024, K: 1024, m: 1048576, M: 1048576, g: 1073741824, G: 1073741824, b: 512, B: 512 }[m[3]] ?? 1;
      count = Number(m[2]) * unit;
      fromStart = name === "tail" ? m[1] === "+" : m[1] === "-";
      return null;
    };
    let options = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!options || arg === "-" || !arg.startsWith("-") || (name === "tail" && /^\+\d+$/.test(arg) && i === 0)) {
        if (name === "tail" && options && /^\+\d+$/.test(arg) && i === 0) { count = Number(arg.slice(1)); fromStart = true; continue; }
        files.push(arg);
        continue;
      }
      if (arg === "--") { options = false; continue; }
      let error: ShellResult | null = null;
      if (arg.startsWith("--lines")) error = setCount(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i], false);
      else if (arg.startsWith("--bytes")) error = setCount(arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i], true);
      else if (arg === "--quiet" || arg === "--silent") headers = false;
      else if (arg === "--verbose") headers = true;
      else if (arg === "--follow" || arg === "-F" || arg.startsWith("--retry") || arg.startsWith("--sleep-interval") || arg.startsWith("--pid")) continue;
      else if (/^-\d+$/.test(arg)) { count = Number(arg.slice(1)); fromStart = false; bytes = false; }
      else {
        for (let j = 1; j < arg.length; j++) {
          const flag = arg[j];
          if (flag === "n" || flag === "c") {
            error = setCount(j + 1 < arg.length ? arg.slice(j + 1) : args[++i], flag === "c");
            break;
          }
          if (flag === "q") headers = false;
          else if (flag === "v") headers = true;
          else if (flag === "f" && name === "tail") continue; // a file in the volume doesn't grow while tail runs
          else if (flag === "z") continue;
          else return fail(`${name}: invalid option -- '${flag}'\n`);
        }
      }
      if (error) return error;
    }
    const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
    if (!bytes && count > operationLimit && !(name === "tail" && fromStart) && !(name === "head" && fromStart)) {
      return fail(`${name}: line limit ${operationLimit} exceeded\n`);
    }
    const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;

    const cut = (content: string): string => {
      if (bytes) {
        if (name === "head") return fromStart ? content.slice(0, Math.max(0, content.length - count)) : content.slice(0, count);
        return fromStart ? content.slice(Math.max(0, count - 1)) : count === 0 ? "" : content.slice(-count);
      }
      // line starts; a last line without a newline still counts
      const starts = [0];
      for (let i = content.indexOf("\n"); i >= 0 && i < content.length - 1; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
      const lines = content === "" ? 0 : starts.length;
      const at = (line: number) => line >= lines ? content.length : starts[line];
      if (name === "head") return content.slice(0, at(fromStart ? Math.max(0, lines - count) : count));
      return content.slice(at(fromStart ? Math.max(0, count - 1) : Math.max(0, lines - count)));
    };

    if (!files.length) files.push("-");
    const showHeaders = headers ?? files.length > 1;
    let out = "";
    let stderr = "";
    let first = true;
    for (const file of files) {
      let content: string;
      if (file === "-") content = stdin ?? "";
      else {
        try { content = ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8"); }
        catch {
          let directory = false;
          try { directory = ctx.volume.statSync(resolvePath(file, ctx.cwd)).isDirectory(); } catch { /* missing */ }
          stderr += directory ? `${name}: error reading '${file}': Is a directory\n` : `${name}: cannot open '${file}' for reading: No such file or directory\n`;
          continue;
        }
      }
      if (showHeaders) out += `${first ? "" : "\n"}==> ${file === "-" ? "standard input" : file} <==\n`;
      first = false;
      out += cut(content);
      if (out.length > outputLimit) return fail(`${name}: output limit ${outputLimit} exceeded\n`);
    }
    return { stdout: out, stderr, exitCode: stderr ? 1 : 0 };
  };
}

const head = headTail("head");
const tail = headTail("tail");

// A `touch -d` date: ISO dates and times (a date alone, or a time without a
// zone, is local time, as in GNU date), `@seconds`, `now`, `today`,
// `yesterday` and `tomorrow`.
function parseTouchDate(text: string): number | null {
  const trimmed = text.trim();
  const epoch = trimmed.match(/^@(-?\d+(?:\.\d+)?)$/);
  if (epoch) return Number(epoch[1]) * 1000;
  const now = new Date();
  const day = 86_400_000;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (trimmed === "now") return now.getTime();
  if (trimmed === "today") return midnight;
  if (trimmed === "yesterday") return now.getTime() - day;
  if (trimmed === "tomorrow") return now.getTime() + day;
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i);
  if (!iso) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const [, y, mo, d, h = "0", mi = "0", sec = "0", frac = "", zone] = iso;
  const ms = frac ? Math.round(Number(frac) * 1000) : 0;
  if (!zone) return new Date(+y, +mo - 1, +d, +h, +mi, +sec, ms).getTime();
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms);
  if (/^(Z|UTC)$/i.test(zone)) return utc;
  const sign = zone[0] === "-" ? -1 : 1;
  const digits = zone.slice(1).replace(":", "");
  return utc - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
}

// `touch -t [[CC]YY]MMDDhhmm[.ss]`, in local time
function parseTouchStamp(text: string): number | null {
  const m = text.match(/^(\d{2}|\d{4})?(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/);
  if (!m) return null;
  let year = m[1] === undefined ? new Date().getFullYear() : Number(m[1]);
  if (m[1]?.length === 2) year += year < 69 ? 2000 : 1900;
  return new Date(year, +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime();
}

const touch: BuiltinFn = (args, ctx) => {
  let noCreate = false;
  let onlyAccess = false;
  let onlyModify = false;
  let time: number | undefined;
  const files: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!options || arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "--") { options = false; continue; }
    const long = arg.match(/^--(date|reference)=(.*)$/);
    const value = (name: string): string | undefined => long ? long[2] : args[++i];
    if (arg === "-d" || arg.startsWith("--date")) {
      const text = value("date");
      const parsed = text === undefined ? null : parseTouchDate(text);
      if (parsed === null) return fail(`touch: invalid date format '${text ?? ""}'\n`);
      time = parsed;
    } else if (arg === "-t") {
      const text = args[++i];
      const parsed = text === undefined ? null : parseTouchStamp(text);
      if (parsed === null) return fail(`touch: invalid date format '${text ?? ""}'\n`);
      time = parsed;
    } else if (arg === "-r" || arg.startsWith("--reference")) {
      const reference = value("reference");
      if (reference === undefined) return fail("touch: option requires an argument -- 'r'\n");
      try { time = ctx.volume.statSync(resolvePath(reference, ctx.cwd)).mtimeMs; }
      catch { return fail(`touch: failed to get attributes of '${reference}': No such file or directory\n`); }
    } else if (arg === "--no-create") noCreate = true;
    else if (/^-[acmf]+$/.test(arg)) {
      if (arg.includes("c")) noCreate = true;
      if (arg.includes("a")) onlyAccess = true;
      if (arg.includes("m")) onlyModify = true;
    } else return fail(`touch: invalid option -- '${arg.replace(/^-+/, "")}'\n`);
  }
  if (files.length === 0) return fail("touch: missing file operand\n");
  const stamp = time ?? Date.now();
  let stderr = "";
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    if (!ctx.volume.existsSync(p)) {
      if (noCreate) continue;
      try { ctx.volume.writeFileSync(p, ""); }
      catch { stderr += `touch: cannot touch '${file}': No such file or directory\n`; continue; }
    }
    const stat = ctx.volume.statSync(p);
    const atime = onlyModify && !onlyAccess ? stat.atimeMs : stamp;
    const mtime = onlyAccess && !onlyModify ? stat.mtimeMs : stamp;
    ctx.volume.utimesSync(p, new Date(atime), new Date(mtime));
  }
  return stderr ? fail(stderr) : ok();
};

const cpCmd: BuiltinFn = async (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["r", "R", "f", "n", "v"]);
  const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
  const verbose = flags.has("v");

  if (positional.length < 2) return fail("cp: missing operand\n");

  const dest = positional[positional.length - 1];
  const sources = positional.slice(0, -1);
  const dstPath = resolvePath(dest, ctx.cwd);
  const walkState: TreeWalkState = { entries: 0 };
  let out = "";

  for (const src of sources) {
    const srcPath = resolvePath(src, ctx.cwd);
    try {
      const st = ctx.volume.lstatSync(srcPath);
      if (st.isDirectory()) {
        if (!recursive)
          return fail(`cp: -r not specified; omitting directory '${src}'\n`);
        let destFinal = dstPath;
        if (ctx.volume.existsSync(dstPath) && ctx.volume.lstatSync(dstPath).isDirectory()) {
          destFinal = `${dstPath}/${pathModule.basename(srcPath)}`;
        }
        await copyTree(ctx, srcPath, destFinal, walkState);
        if (verbose) out += `'${src}' -> '${dest}'\n`;
      } else if (st.isSymbolicLink()) {
        let destFinal = dstPath;
        if (ctx.volume.existsSync(dstPath) && ctx.volume.lstatSync(dstPath).isDirectory()) {
          destFinal = `${dstPath}/${pathModule.basename(srcPath)}`;
        }
        await copyTree(ctx, srcPath, destFinal, walkState);
        if (verbose) out += `'${src}' -> '${dest}'\n`;
      } else {
        let destFinal = dstPath;
        if (ctx.volume.existsSync(dstPath)) {
          try {
            if (ctx.volume.statSync(dstPath).isDirectory()) {
              destFinal = `${dstPath}/${pathModule.basename(srcPath)}`;
            }
          } catch {
            /* */
          }
        }
        ctx.volume.writeFileSync(destFinal, ctx.volume.readFileSync(srcPath));
        if (verbose) out += `'${src}' -> '${dest}'\n`;
      }
    } catch (error) {
      if (ctx.signal?.aborted) return fail("cp: command cancelled\n", 130);
      if (error instanceof Error && error.message.startsWith("shell: ")) return fail(`${error.message}\n`);
      return fail(`cp: cannot stat '${src}': No such file or directory\n`);
    }
  }
  return ok(out);
};

const mv: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["f", "n", "v"]);
  const verbose = flags.has("v");
  if (positional.length < 2) return fail("mv: missing operand\n");

  const dest = positional[positional.length - 1];
  const sources = positional.slice(0, -1);
  const dstPath = resolvePath(dest, ctx.cwd);
  let out = "";

  for (const src of sources) {
    const srcPath = resolvePath(src, ctx.cwd);
    try {
      let destFinal = dstPath;
      if (ctx.volume.existsSync(dstPath)) {
        try {
          if (ctx.volume.statSync(dstPath).isDirectory()) {
            destFinal = `${dstPath}/${pathModule.basename(srcPath)}`;
          }
        } catch {
          /* */
        }
      }
      ctx.volume.renameSync(srcPath, destFinal);
      if (verbose) out += `renamed '${src}' -> '${dest}'\n`;
    } catch {
      return fail(
        `mv: cannot move '${src}' to '${dest}': No such file or directory\n`,
      );
    }
  }
  return ok(out);
};

const rm: BuiltinFn = async (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["r", "R", "f", "v"]);
  const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
  const force = flags.has("f") || flags.has("force");
  const verbose = flags.has("v");

  if (positional.length === 0 && !force) return fail("rm: missing operand\n");

  const walkState: TreeWalkState = { entries: 0 };
  let out = "";
  for (const target of positional) {
    const p = resolvePath(target, ctx.cwd);
    if (!ctx.volume.existsSync(p)) {
      if (force) continue;
      return fail(`rm: cannot remove '${target}': No such file or directory\n`);
    }
    const st = ctx.volume.lstatSync(p);
    if (st.isDirectory()) {
      if (!recursive)
        return fail(`rm: cannot remove '${target}': Is a directory\n`);
      await removeTree(ctx, p, walkState);
      if (verbose) out += `removed directory '${target}'\n`;
    } else {
      ctx.volume.unlinkSync(p);
      if (verbose) out += `removed '${target}'\n`;
    }
  }
  return ok(out);
};

const mkdir_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["p", "v"]);
  const recursive = flags.has("p");
  const verbose = flags.has("v");

  if (positional.length === 0) return fail("mkdir: missing operand\n");

  let out = "";
  for (const dir of positional) {
    const p = resolvePath(dir, ctx.cwd);
    try {
      ctx.volume.mkdirSync(p, { recursive });
      if (verbose) out += `mkdir: created directory '${dir}'\n`;
    } catch (e) {
      if (!recursive)
        return fail(
          `mkdir: cannot create directory '${dir}': ${e instanceof Error ? e.message : String(e)}\n`,
        );
    }
  }
  return ok(out);
};

const rmdir_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["p", "v"]);
  const parents = flags.has("p");
  const verbose = flags.has("v");

  if (positional.length === 0) return fail("rmdir: missing operand\n");

  let out = "";
  for (const dir of positional) {
    let p = resolvePath(dir, ctx.cwd);
    try {
      ctx.volume.rmdirSync(p);
      if (verbose) out += `rmdir: removing directory, '${dir}'\n`;
      if (parents) {
        while (p !== "/") {
          p = pathModule.dirname(p);
          if (p === "/") break;
          try {
            ctx.volume.rmdirSync(p);
          } catch {
            break;
          }
        }
      }
    } catch {
      return fail(
        `rmdir: failed to remove '${dir}': Directory not empty or not found\n`,
      );
    }
  }
  return ok(out);
};

// A chmod mode: octal (`644`, `0755`) or symbolic clauses (`u+x`, `go-w`,
// `a=r,u+w`, `+x`), applied to the current mode as GNU chmod does. Without
// `ugoa`, `+`/`=` follow the umask (022) and `-` clears for everyone.
function applyMode(spec: string, current: number, isDirectory: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  const umask = 0o022;
  let mode = current & 0o7777;
  for (const clause of spec.split(",")) {
    const m = clause.match(/^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/);
    if (!m) return null;
    const who = m[1].replace(/a/g, "ugo");
    const mask = (who.includes("u") ? 0o4700 : 0) | (who.includes("g") ? 0o2070 : 0) | (who.includes("o") ? 0o1007 : 0);
    const target = who ? mask : 0o7777;
    for (const action of m[2].match(/[-+=][rwxXstugo]*/g) ?? []) {
      const op = action[0];
      let bits = 0;
      for (const p of action.slice(1)) {
        if (p === "r") bits |= 0o444;
        else if (p === "w") bits |= 0o222;
        else if (p === "x") bits |= 0o111;
        else if (p === "X") { if (isDirectory || (mode & 0o111)) bits |= 0o111; }
        else if (p === "s") bits |= 0o6000;
        else if (p === "t") bits |= 0o1000;
        else {
          const shift = p === "u" ? 6 : p === "g" ? 3 : 0;
          const copied = (mode >> shift) & 7;
          bits |= (copied << 6) | (copied << 3) | copied;
        }
      }
      bits &= target;
      if (!who && op !== "-") bits &= ~umask;
      if (op === "+") mode |= bits;
      else if (op === "-") mode &= ~bits;
      else mode = (mode & ~(target & 0o7777 & (who ? mask : 0o777))) | bits;
    }
  }
  return mode;
}

const chmod: BuiltinFn = async (args, ctx) => {
  let recursive = false;
  let verbose = false;
  let rest = args;
  while (rest.length && /^-[Rrvcf]+$/.test(rest[0])) {
    if (/[Rr]/.test(rest[0])) recursive = true;
    if (/[vc]/.test(rest[0])) verbose = true;
    rest = rest.slice(1);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  const tryHelp = "Try 'chmod --help' for more information.\n";
  if (rest.length === 0) return fail("chmod: missing operand\n" + tryHelp);
  const modeStr = rest[0];
  const files = rest.slice(1);
  if (files.length === 0) return fail(`chmod: missing operand after '${modeStr}'\n` + tryHelp);
  if (applyMode(modeStr, 0o644, false) === null) return fail(`chmod: invalid mode: '${modeStr}'\n` + tryHelp);
  let out = "";
  let stderr = "";
  const state: TreeWalkState = { entries: 0 };
  const change = async (p: string, shown: string): Promise<void> => {
    const stat = ctx.volume.statSync(p);
    const mode = applyMode(modeStr, stat.mode, stat.isDirectory())!;
    ctx.volume.chmodSync(p, mode);
    if (verbose) out += `mode of '${shown}' changed to ${mode.toString(8).padStart(4, "0")}\n`;
    if (recursive && stat.isDirectory()) {
      for (const name of ctx.volume.readdirSync(p)) {
        visitTreeEntry(ctx, state);
        await yieldTreeWork(ctx, state);
        if (ctx.volume.lstatSync(`${p}/${name}`).isSymbolicLink()) continue;
        await change(`${p}/${name}`, `${shown}/${name}`);
      }
    }
  };
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    if (!ctx.volume.existsSync(p)) { stderr += `chmod: cannot access '${file}': No such file or directory\n`; continue; }
    try { await change(p, file); }
    catch (e: any) { stderr += `chmod: ${file}: ${e?.message || "failed"}\n`; }
  }
  return stderr ? { stdout: out, stderr, exitCode: 1 } : ok(out);
};

// GNU wc's layout: each count is right-aligned to one width, separated by a
// space. The width is the digits of the files' total size, or 7 when stdin
// is counted; a single count of a single input is printed unpadded.
const wc: BuiltinFn = (args, ctx, stdin) => {
  const { flags, positional } = parseArgs(args, ["l", "w", "c", "m", "L"]);
  const showLines = flags.has("l") || flags.has("lines");
  const showWords = flags.has("w") || flags.has("words");
  const showBytes = flags.has("c") || flags.has("bytes");
  const showChars = flags.has("m") || flags.has("chars");
  const showMaxLine = flags.has("L") || flags.has("max-line-length");
  const showAll =
    !showLines && !showWords && !showBytes && !showChars && !showMaxLine;
  const inputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;

  type Counts = { lines: number; words: number; chars: number; bytes: number; maxLine: number };
  const count = (content: string): Counts => ({
    lines: (content.match(/\n/g) ?? []).length,
    words: content.split(/\s+/).filter(Boolean).length,
    chars: [...content].length,
    bytes: new TextEncoder().encode(content).length,
    maxLine: content.split("\n").reduce((mx, l) => Math.max(mx, l.length), 0),
  });
  const columns = (c: Counts): number[] => {
    const values: number[] = [];
    if (showAll || showLines) values.push(c.lines);
    if (showAll || showWords) values.push(c.words);
    if (showChars) values.push(c.chars);
    if (showAll || showBytes) values.push(c.bytes);
    if (showMaxLine) values.push(c.maxLine);
    return values;
  };

  const rows: Array<{ counts: Counts; label?: string }> = [];
  const readsStdin = positional.length === 0;
  if (readsStdin) {
    if (stdin === undefined) return fail("wc: missing operand\n");
    if (stdin.length > inputLimit) return fail(`wc: input limit ${inputLimit} exceeded\n`);
    rows.push({ counts: count(stdin) });
  } else {
    for (const file of positional) {
      const content = file === "-" ? stdin ?? "" : (() => {
        try { return ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8"); }
        catch { return null; }
      })();
      if (content === null) return fail(`wc: ${file}: No such file or directory\n`);
      if (content.length > inputLimit) return fail(`wc: ${file}: input limit ${inputLimit} exceeded\n`);
      rows.push({ counts: count(content), label: file });
    }
  }
  if (rows.length > 1) {
    const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
    for (const { counts } of rows) {
      total.lines += counts.lines;
      total.words += counts.words;
      total.chars += counts.chars;
      total.bytes += counts.bytes;
      total.maxLine = Math.max(total.maxLine, counts.maxLine);
    }
    rows.push({ counts: total, label: "total" });
  }

  const inputs = readsStdin ? 1 : positional.length;
  const singleColumn = columns(rows[0].counts).length === 1;
  let width: number;
  if (singleColumn && inputs === 1) width = 1;
  else if (readsStdin || positional.includes("-")) width = 7;
  else {
    const totalBytes = rows.slice(0, positional.length).reduce((sum, row) => sum + row.counts.bytes, 0);
    width = String(totalBytes).length;
  }
  const out = rows
    .map(({ counts, label }) => columns(counts).map((value) => String(value).padStart(width)).join(" ") + (label ? ` ${label}` : "") + "\n")
    .join("");
  return ok(out);
};

const tee: BuiltinFn = (args, ctx, stdin) => {
  const { flags, positional } = parseArgs(args, ["a"]);
  const append = flags.has("a");
  const content = stdin ?? "";
  const fileLimit = (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024) * 32;
  if (content.length > fileLimit) return fail(`tee: input limit ${fileLimit} exceeded\n`);

  for (const file of positional) {
    const p = resolvePath(file, ctx.cwd);
    if (append && ctx.volume.existsSync(p)) {
      const existing = ctx.volume.readFileSync(p, "utf8");
      if (existing.length + content.length > fileLimit) return fail(`tee: file size limit ${fileLimit} exceeded\n`);
      ctx.volume.writeFileSync(p, existing + content);
    } else {
      ctx.volume.writeFileSync(p, content);
    }
  }
  return ok(content);
};

const readlink_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["f", "e", "m", "n", "q", "z"]);
  if (positional.length === 0) return fail("readlink: missing operand\n");
  const p = resolvePath(positional[0], ctx.cwd);
  try {
    if (flags.has("f") || flags.has("e") || flags.has("m")) {
      return ok(ctx.volume.realpathSync(p) + "\n");
    }
    return ok(ctx.volume.readlinkSync(p) + "\n");
  } catch (e: any) {
    return fail(`readlink: ${positional[0]}: ${e?.message || "failed"}\n`);
  }
};

// ln [-sfnv] TARGET [LINK_NAME | DIRECTORY]: one operand links into the
// current folder, a folder as the last operand links inside it
const ln_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["s", "f", "n", "v", "T"]);
  if (positional.length === 0) return fail("ln: missing file operand\nTry 'ln --help' for more information.\n");
  const symbolic = flags.has("s") || flags.has("symbolic");
  const force = flags.has("f") || flags.has("force");
  const kind = symbolic ? "symbolic link" : "hard link";
  const targets = positional.length === 1 ? positional : positional.slice(0, -1);
  const last = positional.length === 1 ? "." : positional[positional.length - 1];
  const lastPath = resolvePath(last, ctx.cwd);
  let intoDir = false;
  try { intoDir = !flags.has("T") && ctx.volume.statSync(lastPath).isDirectory() && !(flags.has("n") && ctx.volume.lstatSync(lastPath).isSymbolicLink()); } catch { /* new name */ }
  if (targets.length > 1 && !intoDir) return fail(`ln: target '${last}' is not a directory\n`);
  let out = "";
  let stderr = "";
  for (const target of targets) {
    const base = target.replace(/\/+$/, "").split("/").pop() || target;
    const shown = intoDir ? (last === "." && positional.length === 1 ? base : `${last.replace(/\/+$/, "")}/${base}`) : last;
    const linkPath = intoDir ? `${lastPath}/${base}` : lastPath;
    if (!symbolic && !ctx.volume.existsSync(resolvePath(target, ctx.cwd))) {
      stderr += `ln: failed to access '${target}': No such file or directory\n`;
      continue;
    }
    let exists = false;
    try { ctx.volume.lstatSync(linkPath); exists = true; } catch { /* free */ }
    if (exists) {
      if (!force) { stderr += `ln: failed to create ${kind} '${shown}': File exists\n`; continue; }
      ctx.volume.unlinkSync(linkPath);
    }
    try {
      // a symlink stores its target as typed (relative targets are valid)
      if (symbolic) ctx.volume.symlinkSync(target, linkPath);
      else ctx.volume.linkSync(resolvePath(target, ctx.cwd), linkPath);
      if (flags.has("v")) out += `'${shown}' -> '${target}'\n`;
    } catch (e: any) {
      stderr += `ln: failed to create ${kind} '${shown}': ${e?.code === "ENOENT" ? "No such file or directory" : e?.message || "failed"}\n`;
    }
  }
  return { stdout: out, stderr, exitCode: stderr ? 1 : 0 };
};

const writeFile: BuiltinFn = (args, ctx) => {
  if (args.length < 2) return fail("write: missing arguments\n");
  const path = resolvePath(args[0], ctx.cwd);
  ctx.volume.writeFileSync(path, args.slice(1).join(" "));
  return ok();
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const fileOpsCommands: [string, BuiltinFn][] = [
  ["cat", cat],
  ["head", head],
  ["tail", tail],
  ["touch", touch],
  ["cp", cpCmd],
  ["mv", mv],
  ["rm", rm],
  ["mkdir", mkdir_cmd],
  ["rmdir", rmdir_cmd],
  ["chmod", chmod],
  ["wc", wc],
  ["tee", tee],
  ["ln", ln_cmd],
  ["readlink", readlink_cmd],
  ["write", writeFile],
];
