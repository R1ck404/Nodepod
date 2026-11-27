import type { BuiltinFn, ShellContext } from "../shell-types.js";
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

function formatCat(
  content: string,
  numberAll: boolean,
  numberNonBlank: boolean,
  squeeze: boolean,
  showEnds: boolean,
  showTabs: boolean,
  showNonprinting: boolean,
): string {
  let lines = content.split("\n");
  if (squeeze) {
    const squeezed: string[] = [];
    let prevBlank = false;
    for (const line of lines) {
      const blank = line.length === 0;
      if (blank && prevBlank) continue;
      squeezed.push(line);
      prevBlank = blank;
    }
    lines = squeezed;
  }
  let lineNum = 1;
  const result = lines.map((line, idx) => {
    let l = line;
    if (showNonprinting) {
      let visible = "";
      for (const char of l) {
        const code = char.charCodeAt(0);
        if (code === 9) visible += showTabs ? "^I" : char;
        else if (code < 32) visible += `^${String.fromCharCode(code + 64)}`;
        else if (code === 127) visible += "^?";
        else visible += char;
      }
      l = visible;
    } else if (showTabs) l = l.replace(/\t/g, "^I");
    if (showEnds && idx < lines.length - 1) l += "$";
    if (numberNonBlank) {
      if (line.length > 0) l = `${String(lineNum++).padStart(6)}\t${l}`;
    } else if (numberAll) {
      l = `${String(lineNum++).padStart(6)}\t${l}`;
    }
    return l;
  });
  return result.join("\n");
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
  const appendFormatted = (current: string, content: string): string => {
    if (content.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
    const formatted = formatCat(content, numberAll, numberNonBlank, squeeze, showEnds, showTabs, showNonprinting);
    if (current.length + formatted.length > outputLimit) throw new Error(`output limit ${outputLimit} exceeded`);
    return current + formatted;
  };

  if (positional.length === 0 && stdin !== undefined) {
    try { return ok(appendFormatted("", stdin)); }
    catch (error) { return fail(`cat: ${error instanceof Error ? error.message : String(error)}\n`); }
  }
  if (positional.length === 0) return fail("cat: missing operand\n");

  let out = "";
  for (const file of positional) {
    if (file === "-" && stdin !== undefined) {
      try { out = appendFormatted(out, stdin); }
      catch (error) { return fail(`cat: ${error instanceof Error ? error.message : String(error)}\n`); }
      continue;
    }
    const p = resolvePath(file, ctx.cwd);
    try {
      const content = ctx.volume.readFileSync(p, "utf8");
      out = appendFormatted(out, content);
    } catch (error) {
      if (error instanceof Error && error.message.includes("limit")) return fail(`cat: ${error.message}\n`);
      return fail(`cat: ${file}: No such file or directory\n`);
    }
  }
  return ok(out);
};

const head: BuiltinFn = (args, ctx, stdin) => {
  let n = 10;
  let byteMode = false;
  let bytes = 0;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed)) n = parsed;
    } else if (args[i] === "-c" && i + 1 < args.length) {
      bytes = parseInt(args[++i], 10) || 0;
      byteMode = true;
    } else if (args[i].startsWith("-") && /^\d+$/.test(args[i].slice(1))) {
      n = parseInt(args[i].slice(1), 10);
    } else if (!args[i].startsWith("-")) {
      files.push(args[i]);
    }
  }

  const doHead = (content: string) => {
    if (byteMode) return content.slice(0, bytes);
    if (n <= 0) return "";
    let end = 0;
    for (let count = 0; count < n; count++) {
      const newline = content.indexOf("\n", end);
      if (newline < 0) return content;
      end = newline + 1;
    }
    return content.slice(0, end);
  };

  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (!byteMode && n > operationLimit) return fail(`head: line limit ${operationLimit} exceeded\n`);
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;

  if (files.length === 0 && stdin !== undefined) return ok(doHead(stdin));
  if (files.length === 0) return fail("head: missing operand\n");

  let out = "";
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    try {
      const content = ctx.volume.readFileSync(p, "utf8");
      if (files.length > 1) out += `==> ${file} <==\n`;
      out += doHead(content);
      if (out.length > outputLimit) return fail(`head: output limit ${outputLimit} exceeded\n`);
    } catch {
      return fail(`head: ${file}: No such file or directory\n`);
    }
  }
  return ok(out);
};

const tail: BuiltinFn = (args, ctx, stdin) => {
  let n = 10;
  let byteMode = false;
  let bytes = 0;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (Number.isFinite(parsed)) n = parsed;
    } else if (args[i] === "-c" && i + 1 < args.length) {
      bytes = parseInt(args[++i], 10) || 0;
      byteMode = true;
    } else if (args[i] === "-f") {
      // -f (follow) can't work in VFS, ignore
    } else if (args[i].startsWith("-") && /^\d+$/.test(args[i].slice(1))) {
      n = parseInt(args[i].slice(1), 10);
    } else if (!args[i].startsWith("-")) {
      files.push(args[i]);
    }
  }

  const doTail = (content: string) => {
    if (byteMode) return content.slice(-bytes);
    if (n <= 0) return "";
    let cursor = content.endsWith("\n") ? content.length - 1 : content.length;
    for (let count = 0; count < n; count++) {
      const newline = content.lastIndexOf("\n", cursor - 1);
      if (newline < 0) return content;
      cursor = newline;
    }
    return content.slice(cursor + 1);
  };

  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (!byteMode && n > operationLimit) return fail(`tail: line limit ${operationLimit} exceeded\n`);
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;

  if (files.length === 0 && stdin !== undefined) return ok(doTail(stdin));
  if (files.length === 0) return fail("tail: missing operand\n");

  let out = "";
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    try {
      const content = ctx.volume.readFileSync(p, "utf8");
      if (files.length > 1) out += `==> ${file} <==\n`;
      out += doTail(content);
      if (out.length > outputLimit) return fail(`tail: output limit ${outputLimit} exceeded\n`);
    } catch {
      return fail(`tail: ${file}: No such file or directory\n`);
    }
  }
  return ok(out);
};

const touch: BuiltinFn = (args, ctx) => {
  if (args.length === 0) return fail("touch: missing operand\n");
  for (const file of args) {
    if (file.startsWith("-")) continue;
    const p = resolvePath(file, ctx.cwd);
    if (!ctx.volume.existsSync(p)) {
      ctx.volume.writeFileSync(p, "");
    }
  }
  return ok();
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

const chmod: BuiltinFn = (args, ctx) => {
  if (args.length < 2) return fail("chmod: missing operand\n");
  const modeStr = args[0];
  const files = args.slice(1);
  if (!/^[0-7]{3,4}$/.test(modeStr)) {
    return fail(`chmod: invalid mode: '${modeStr}'\n`);
  }
  const mode = parseInt(modeStr, 8);
  for (const file of files) {
    const p = resolvePath(file, ctx.cwd);
    try {
      ctx.volume.chmodSync(p, mode);
    } catch (e: any) {
      return fail(`chmod: ${file}: ${e?.message || "failed"}\n`);
    }
  }
  return ok();
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

const ln_cmd: BuiltinFn = (args, ctx) => {
  const { flags, positional } = parseArgs(args, ["s", "f"]);
  if (positional.length < 2) return fail("ln: missing operand\n");
  const src = positional[0];
  const dst = resolvePath(positional[1], ctx.cwd);
  const srcPath = resolvePath(src, ctx.cwd);
  try {
    if (flags.has("f") && ctx.volume.existsSync(dst)) {
      ctx.volume.unlinkSync(dst);
    }
    if (flags.has("s")) {
      // store the original target string (relative targets are valid)
      ctx.volume.symlinkSync(src, dst);
      return ok();
    }
    ctx.volume.linkSync(srcPath, dst);
    return ok();
  } catch (e: any) {
    return fail(
      `ln: cannot create link '${positional[1]}': ${e?.message || "failed"}\n`,
    );
  }
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
