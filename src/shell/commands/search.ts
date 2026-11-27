import type { BuiltinFn } from "../shell-types.js";
import type { MemoryVolume } from "../../memory-volume.js";
import { ok, fail, resolvePath, globToRegex, yieldToEventLoop } from "../shell-helpers.js";
import { LS_BLOCK_SIZE } from "../../constants/config.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

function matchSize(fileSize: number, spec: string): boolean {
  const m = spec.match(/^([+-]?)(\d+)([cwbkMG]?)$/);
  if (!m) return true;
  const op = m[1];
  let n = parseInt(m[2]);
  const unit = m[3];
  if (unit === "c") {
    /* bytes */
  } else if (unit === "w") n *= 2;
  else if (unit === "k") n *= 1024;
  else if (unit === "M") n *= 1048576;
  else if (unit === "G") n *= 1073741824;
  else n *= LS_BLOCK_SIZE;

  if (op === "+") return fileSize > n;
  if (op === "-") return fileSize < n;
  return fileSize === n;
}

function matchMtime(mtimeMs: number, spec: string): boolean {
  const m = spec.match(/^([+-]?)(\d+)$/);
  if (!m) return true;
  const op = m[1];
  const days = parseInt(m[2]);
  const age = (Date.now() - mtimeMs) / 86400000;
  if (op === "+") return age > days;
  if (op === "-") return age < days;
  return Math.floor(age) === days;
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

// `path` is the path as find prints it (from the starting point as typed),
// `real` is the absolute path in the volume.
type FindEntry = { path: string; real: string; name: string; stat: ReturnType<MemoryVolume["statSync"]> };
type FindEval = { value: boolean; prune?: boolean; stdout: string; stderr: string };
type FindNode =
  | { kind: "true" | "false" }
  | { kind: "not"; child: FindNode }
  | { kind: "and" | "or"; left: FindNode; right: FindNode }
  | { kind: "test"; run: (entry: FindEntry) => Promise<FindEval> };

const find_cmd: BuiltinFn = async (args, ctx) => {
  let maxDepth = Infinity;
  let minDepth = 0;
  let depthFirst = false;
  const paths: { real: string; display: string }[] = [];
  let index = 0;
  while (index < args.length && !args[index].startsWith("-") && args[index] !== "!" && args[index] !== "(" && args[index] !== "\\(") {
    const typed = args[index++];
    paths.push({ real: resolvePath(typed, ctx.cwd), display: typed });
  }
  if (!paths.length) paths.push({ real: ctx.cwd, display: "." });

  const expression: string[] = [];
  while (index < args.length) {
    const token = args[index++];
    if (token === "-maxdepth" || token === "-mindepth") {
      const value = args[index++];
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        return fail(`find: expected a non-negative integer after ${token}\n`);
      }
      if (token === "-maxdepth") maxDepth = parsed;
      else minDepth = parsed;
      continue;
    }
    if (token === "-depth") { depthFirst = true; continue; }
    if (token === "-delete") depthFirst = true;
    expression.push(token);
  }

  let hasAction = false;
  const batchedRuns: (() => Promise<{ status: number; stdout: string; stderr: string }>)[] = [];
  const action = (run: (entry: FindEntry) => Promise<FindEval>): FindNode => {
    hasAction = true;
    return { kind: "test", run };
  };
  const primary = (entryTest: (entry: FindEntry) => boolean): FindNode => ({
    kind: "test",
    run: async (entry) => ({ value: entryTest(entry), stdout: "", stderr: "" }),
  });

  let cursor = 0;
  const recursionLimit = ctx.limits?.maxRecursionDepth ?? 64;
  const parsePrimary = (depth = 0): FindNode => {
    if (depth > recursionLimit) throw new Error("find: expression nesting limit " + recursionLimit + " exceeded");
    const token = expression[cursor++];
    if (token === undefined) throw new Error("find: expected an expression");
    if (token === ")" || token === "\\)") throw new Error("find: unexpected ')' in expression");
    if (token === "!" || token === "-not") return { kind: "not", child: parsePrimary(depth + 1) };
    if (token === "(" || token === "\\(") {
      const node = parseOr(depth + 1);
      if (expression[cursor] !== ")" && expression[cursor] !== "\\)") throw new Error("find: missing ')' in expression");
      cursor++;
      return node;
    }
    if (token === "-true") return { kind: "true" };
    if (token === "-false") return { kind: "false" };
    if (token === "-name" || token === "-iname") {
      const pattern = expression[cursor++];
      if (pattern === undefined) throw new Error("find: missing argument to '" + token + "'");
      const re = new RegExp(`^${globToRegex(token === "-iname" ? pattern.toLowerCase() : pattern)}$`);
      return primary((entry) => re.test(token === "-iname" ? entry.name.toLowerCase() : entry.name));
    }
    if (token === "-path" || token === "-wholename") {
      const rawPattern = expression[cursor++];
      if (rawPattern === undefined) throw new Error("find: missing argument to '" + token + "'");
      const pattern = rawPattern.replace(/\\(.)/g, "$1");
      const re = new RegExp(`^${globToRegex(pattern)}$`);
      return primary((entry) => re.test(entry.path));
    }
    if (token === "-type") {
      const type = expression[cursor++];
      if (!type || !["f", "d", "l"].includes(type)) throw new Error("find: invalid argument '" + (type ?? "") + "' to '-type'");
      return primary((entry) => type === "f" ? entry.stat.isFile() : type === "d" ? entry.stat.isDirectory() : entry.stat.isSymbolicLink());
    }
    if (token === "-size") {
      const spec = expression[cursor++];
      if (spec === undefined) throw new Error("find: missing argument to '-size'");
      return primary((entry) => matchSize(entry.stat.size, spec));
    }
    if (token === "-newer") {
      const reference = expression[cursor++];
      if (reference === undefined) throw new Error("find: missing argument to '-newer'");
      let referenceTime: number;
      try { referenceTime = ctx.volume.statSync(resolvePath(reference, ctx.cwd)).mtimeMs; }
      catch { throw new Error(`find: '${reference}': No such file or directory`); }
      return primary((entry) => entry.stat.mtimeMs > referenceTime);
    }
    if (token === "-mtime") {
      const spec = expression[cursor++];
      if (spec === undefined) throw new Error("find: missing argument to '-mtime'");
      return primary((entry) => matchMtime(entry.stat.mtimeMs, spec));
    }
    if (token === "-empty") {
      return primary((entry) => entry.stat.isDirectory() ? ctx.volume.readdirSync(entry.real).length === 0 : entry.stat.isFile() && entry.stat.size === 0);
    }
    if (token === "-prune") {
      return { kind: "test", run: async (entry) => ({ value: true, prune: entry.stat.isDirectory(), stdout: "", stderr: "" }) };
    }
    if (token === "-print" || token === "-print0") {
      const separator = token === "-print0" ? "\0" : "\n";
      return action(async (entry) => ({ value: true, stdout: entry.path + separator, stderr: "" }));
    }
    if (token === "-delete") {
      return action(async (entry) => {
        try {
          if (entry.stat.isDirectory()) ctx.volume.rmdirSync(entry.real);
          else ctx.volume.unlinkSync(entry.real);
          return { value: true, prune: true, stdout: "", stderr: "" };
        } catch (error) {
          return { value: false, stdout: "", stderr: `find: ${entry.path}: ${(error as Error).message}\n` };
        }
      });
    }
    if (token === "-exec" || token === "-execdir") {
      const command: string[] = [];
      // `;` ends the command; `+` does only straight after `{}`
      while (cursor < expression.length && expression[cursor] !== ";" && !(expression[cursor] === "+" && command[command.length - 1] === "{}")) {
        command.push(expression[cursor++]);
      }
      if (cursor >= expression.length || !command.length) throw new Error("find: missing argument to '" + token + "'");
      const batched = expression[cursor++] === "+";
      const inDir = token === "-execdir";
      const target = (entry: FindEntry) => inDir ? (entry.name === "/" ? "/" : "./" + entry.name) : entry.path;
      const folder = (entry: FindEntry) => inDir ? entry.real.slice(0, entry.real.lastIndexOf("/")) || "/" : ctx.cwd;
      const run = async (cwd: string, targets: string[]): Promise<FindEval> => {
        const commandArgs = batched
          ? command.flatMap((part, i) => i === command.length - 1 ? targets : [part])
          : command.map((part) => part.replaceAll("{}", targets[0]));
        const result = await ctx.exec(commandArgs.map(shellQuote).join(" "), { cwd, env: ctx.env });
        return { value: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
      };
      if (!batched) return action((entry) => run(folder(entry), [target(entry)]));
      // `{} +` collects the paths (per folder for -execdir) and runs the
      // command once at the end, like find's own batching
      const batches = new Map<string, string[]>();
      batchedRuns.push(async () => {
        let status = 0;
        let stdout = "";
        let stderr = "";
        for (const [cwd, targets] of batches) {
          const result = await run(cwd, targets);
          if (!result.value) status = 1;
          stdout += result.stdout;
          stderr += result.stderr;
        }
        return { status, stdout, stderr };
      });
      return action(async (entry) => {
        const cwd = folder(entry);
        const list = batches.get(cwd) ?? [];
        list.push(target(entry));
        batches.set(cwd, list);
        return { value: true, stdout: "", stderr: "" };
      });
    }
    throw new Error("find: unknown predicate '" + token + "'");
  };
  const combineBalanced = (nodes: FindNode[], kind: "and" | "or"): FindNode => {
    while (nodes.length > 1) {
      const next: FindNode[] = [];
      for (let i = 0; i < nodes.length; i += 2) {
        next.push(i + 1 < nodes.length ? { kind, left: nodes[i], right: nodes[i + 1] } : nodes[i]);
      }
      nodes = next;
    }
    return nodes[0] ?? { kind: "true" };
  };
  const parseAnd = (depth = 0): FindNode => {
    const nodes = [parsePrimary(depth)];
    while (cursor < expression.length && expression[cursor] !== "-o" && expression[cursor] !== "-or" && expression[cursor] !== ")" && expression[cursor] !== "\\)") {
      if (expression[cursor] === "-a" || expression[cursor] === "-and") cursor++;
      nodes.push(parsePrimary(depth));
    }
    return combineBalanced(nodes, "and");
  };
  const parseOr = (depth = 0): FindNode => {
    const nodes = [parseAnd(depth)];
    while (expression[cursor] === "-o" || expression[cursor] === "-or") {
      cursor++;
      nodes.push(parseAnd(depth));
    }
    return combineBalanced(nodes, "or");
  };
  let root: FindNode;
  try {
    root = expression.length ? parseOr() : { kind: "true" };
    if (cursor !== expression.length) throw new Error("find: unexpected expression token '" + expression[cursor] + "'");
  } catch (error) {
    return fail((error instanceof Error ? error.message : String(error)) + "\n");
  }

  const evaluate = async (node: FindNode, entry: FindEntry, depth = 0): Promise<FindEval> => {
    if (depth > recursionLimit) throw new Error("find: expression evaluation limit " + recursionLimit + " exceeded");
    if (node.kind === "true") return { value: true, stdout: "", stderr: "" };
    if (node.kind === "false") return { value: false, stdout: "", stderr: "" };
    if (node.kind === "test") return node.run(entry);
    if (node.kind === "not") {
      const child = await evaluate(node.child, entry, depth + 1);
      return { ...child, value: !child.value };
    }
    if (node.kind !== "and" && node.kind !== "or") return { value: false, stdout: "", stderr: "" };
    const left = await evaluate(node.left, entry, depth + 1);
    if (node.kind === "and" && !left.value) return left;
    if (node.kind === "or" && left.value) return left;
    const right = await evaluate(node.right, entry, depth + 1);
    return { value: node.kind === "and" ? right.value : right.value, prune: left.prune || right.prune, stdout: left.stdout + right.stdout, stderr: left.stderr + right.stderr };
  };

  const outputs: string[] = [];
  let errors = "";
  let collectedLength = 0;
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const appendOutput = (value: string, stderr = false): void => {
    if (!value) return;
    collectedLength += value.length;
    if (collectedLength > outputLimit) throw new Error("find: output limit " + outputLimit + " exceeded");
    if (stderr) errors += value;
    else outputs.push(value);
  };
  let visited = 0;
  let batchFailed = false;
  const limit = ctx.limits?.maxFilesystemEntries ?? 100000;
  const walk = async (path: string, display: string, depth: number): Promise<void> => {
    if (ctx.signal?.aborted) throw new Error("find: command cancelled");
    if (++visited > limit) throw new Error(`find: filesystem entry limit ${limit} exceeded`);
    let stat: ReturnType<MemoryVolume["lstatSync"]>;
    try {
      // find does not follow symlinks unless -L is requested. Using lstat here
      // also prevents a workspace symlink or symlink loop from expanding the
      // traversal beyond the requested tree.
      stat = ctx.volume.lstatSync(path);
    } catch { return; }
    const name = path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
    const entry = { path: display, real: path, name, stat };
    const evaluateEntry = async (): Promise<FindEval> => {
      if (depth < minDepth || depth > maxDepth) return { value: true, stdout: "", stderr: "" };
      const result = await evaluate(root, entry);
      if (result.value && !hasAction) appendOutput(display + "\n");
      appendOutput(result.stdout);
      appendOutput(result.stderr, true);
      return result;
    };

    const preOrder = depthFirst ? { value: true, stdout: "", stderr: "" } : await evaluateEntry();
    if (stat.isDirectory() && depth < maxDepth && (depthFirst || !preOrder.prune)) {
      for (const child of ctx.volume.readdirSync(path)) {
        if (ctx.signal?.aborted) throw new Error("find: command cancelled");
        const childPath = path === "/" ? `/${child}` : `${path}/${child}`;
        await walk(childPath, display.endsWith("/") ? display + child : `${display}/${child}`, depth + 1);
        if ((visited & 255) === 0) await yieldToEventLoop(ctx.signal);
      }
    }
    // with -depth (or -delete) an entry is evaluated after its contents
    if (depthFirst) await evaluateEntry();
  };
  try {
    for (const path of paths) {
      try { ctx.volume.lstatSync(path.real); }
      catch { appendOutput(`find: '${path.display}': No such file or directory\n`, true); continue; }
      await walk(path.real, path.display, 0);
    }
    for (const runBatch of batchedRuns) {
      const result = await runBatch();
      appendOutput(result.stdout);
      appendOutput(result.stderr, true);
      if (result.status) batchFailed = true;
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)) + "\n";
    if (collectedLength + message.length <= outputLimit) errors += message;
    else errors = "find: output limit " + outputLimit + " exceeded\n";
    return { stdout: outputs.join(""), stderr: errors, exitCode: ctx.signal?.aborted ? 130 : 1 };
  }
  return { stdout: outputs.join(""), stderr: errors, exitCode: errors || batchFailed ? 1 : 0 };
};

const xargs_cmd: BuiltinFn = async (args, ctx, stdin) => {
  if (!stdin) return ok();

  let maxArgs = Infinity;
  let placeholder = "";
  let nullDelim = false;
  const cmdParts: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n" && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return fail(`xargs: invalid number for -n: '${args[i]}'\n`);
      maxArgs = parsed;
    }
    else if (args[i] === "-I" && i + 1 < args.length) placeholder = args[++i];
    else if (args[i] === "-0" || args[i] === "--null") nullDelim = true;
    else if (args[i] === "-t") {
      /* */
    } else cmdParts.push(args[i]);
  }

  if (cmdParts.length === 0) cmdParts.push("echo");

  const iterationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  const items: string[] = [];
  if (nullDelim) {
    let start = 0;
    while (start <= stdin.length) {
      const end = stdin.indexOf("\0", start);
      const item = stdin.slice(start, end < 0 ? stdin.length : end);
      if (item) items.push(item);
      if (items.length > iterationLimit) return fail(`xargs: item limit ${iterationLimit} exceeded\n`);
      if (end < 0) break;
      start = end + 1;
    }
  } else {
    const matches = stdin.matchAll(/\S+/g);
    for (const match of matches) {
      items.push(match[0]);
      if (items.length > iterationLimit) return fail(`xargs: item limit ${iterationLimit} exceeded\n`);
    }
  }
  const invocationCount = placeholder
    ? items.length
    : maxArgs < Infinity
      ? Math.ceil(items.length / Math.max(1, maxArgs))
      : items.length > 0 ? 1 : 0;
  if (!Number.isSafeInteger(invocationCount) || invocationCount > iterationLimit) {
    return fail(`xargs: invocation limit ${iterationLimit} exceeded\n`);
  }
  const cmd = cmdParts.map(shellQuote).join(" ");
  let out = "";
  let err = "";
  let lastCode = 0;

  if (placeholder) {
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      if (ctx.signal?.aborted) return fail("xargs: command cancelled\n", 130);
      if (itemIndex > 0 && (itemIndex & 127) === 0) await yieldToEventLoop(ctx.signal);
      const item = items[itemIndex];
      const expanded = cmdParts
        .map((part) => (part.includes(placeholder) ? part.split(placeholder).join(item) : part))
        .map(shellQuote)
        .join(" ");
      if (expanded.length > (ctx.limits?.maxExpansionBytes ?? 1024 * 1024)) return fail("xargs: command size limit exceeded\n");
      const result = await ctx.exec(expanded, { cwd: ctx.cwd, env: ctx.env });
      out += result.stdout;
      err += result.stderr;
      lastCode = result.exitCode;
      if (out.length + err.length > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) {
        return fail("xargs: output limit exceeded\n");
      }
    }
  } else if (maxArgs < Infinity) {
    for (let i = 0; i < items.length; i += maxArgs) {
      if (ctx.signal?.aborted) return fail("xargs: command cancelled\n", 130);
      if (i > 0 && (i & 127) === 0) await yieldToEventLoop(ctx.signal);
      const batch = items.slice(i, i + maxArgs).map(shellQuote).join(" ");
      if (cmd.length + batch.length + 1 > (ctx.limits?.maxExpansionBytes ?? 1024 * 1024)) return fail("xargs: command size limit exceeded\n");
      const result = await ctx.exec(`${cmd} ${batch}`, {
        cwd: ctx.cwd,
        env: ctx.env,
      });
      out += result.stdout;
      err += result.stderr;
      lastCode = result.exitCode;
      if (out.length + err.length > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) {
        return fail("xargs: output limit exceeded\n");
      }
    }
  } else {
    const expanded = `${cmd} ${items.map(shellQuote).join(" ")}`;
    if (expanded.length > (ctx.limits?.maxExpansionBytes ?? 1024 * 1024)) return fail("xargs: command size limit exceeded\n");
    const result = await ctx.exec(expanded, {
      cwd: ctx.cwd,
      env: ctx.env,
    });
    out += result.stdout;
    err += result.stderr;
    lastCode = result.exitCode;
    if (out.length + err.length > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) {
      return fail("xargs: output limit exceeded\n");
    }
  }

  return { stdout: out, stderr: err, exitCode: lastCode };
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const searchCommands: [string, BuiltinFn][] = [
  ["find", find_cmd],
  ["xargs", xargs_cmd],
];
