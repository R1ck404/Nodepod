import type { MemoryVolume } from "../memory-volume";
import { regexSafetyError, resolvePath, yieldToEventLoop } from "./shell-helpers";
import { ShellPipe, type CancellationToken, stringToBytes } from "./shell-stream";
import { ShellLimitError } from "./shell-options";

export interface StreamCommandContext {
  cwd: string;
  env: Record<string, string>;
  volume: MemoryVolume;
  input: ShellPipe | null;
  output: ShellPipe;
  token: CancellationToken;
  maxOutputBytes: number;
  maxLoopIterations: number;
  cancelUpstream: () => void;
}

export interface StreamCommandResult {
  exitCode: number;
  stderr: string;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function writeText(ctx: StreamCommandContext, text: string): Promise<void> {
  const bytes = stringToBytes(text);
  if (bytes.byteLength > ctx.maxOutputBytes) {
    throw new ShellLimitError("maxOutputBytes", "shell: output limit exceeded");
  }
  for (let offset = 0; offset < bytes.byteLength; offset += ctx.output.capacityBytes) {
    await ctx.output.write(
      bytes.slice(offset, Math.min(offset + ctx.output.capacityBytes, bytes.byteLength)),
      ctx.token,
    );
  }
}

async function writeBytes(ctx: StreamCommandContext, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += ctx.output.capacityBytes) {
    await ctx.output.write(
      bytes.slice(offset, Math.min(offset + ctx.output.capacityBytes, bytes.byteLength)),
      ctx.token,
    );
  }
}

function formatCatText(
  content: string,
  options: { numberAll: boolean; numberNonBlank: boolean; squeeze: boolean; showEnds: boolean; showTabs: boolean; showNonprinting: boolean },
  maxLoopIterations: number,
): string {
  let lines = content.split("\n");
  if (lines.length > maxLoopIterations) {
    throw new ShellLimitError("maxLoopIterations", `cat: line limit ${maxLoopIterations} exceeded`);
  }
  if (options.squeeze) {
    const squeezed: string[] = [];
    let previousBlank = false;
    for (const line of lines) {
      const blank = line.length === 0;
      if (blank && previousBlank) continue;
      squeezed.push(line);
      previousBlank = blank;
    }
    lines = squeezed;
  }
  let lineNumber = 1;
  return lines.map((line, index) => {
    let visible = "";
    for (const char of line) {
      const code = char.charCodeAt(0);
      if (code === 9) visible += options.showTabs ? "^I" : char;
      else if (options.showNonprinting && code < 32) visible += `^${String.fromCharCode(code + 64)}`;
      else if (options.showNonprinting && code === 127) visible += "^?";
      else visible += char;
    }
    if (options.showEnds && index < lines.length - 1) visible += "$";
    if (options.numberNonBlank && line.length > 0) visible = `${String(lineNumber++).padStart(6)}\t${visible}`;
    else if (options.numberAll) visible = `${String(lineNumber++).padStart(6)}\t${visible}`;
    return visible;
  }).join("\n");
}

async function readAll(ctx: StreamCommandContext): Promise<string> {
  if (!ctx.input) return "";
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const chunk = await ctx.input.read(ctx.token);
    if (chunk === null) break;
    bytes += chunk.byteLength;
    out += decoder.decode(chunk, { stream: true });
    if (bytes > ctx.maxOutputBytes) {
      throw new ShellLimitError("maxOutputBytes", "shell: input exceeds output limit");
    }
  }
  return out + decoder.decode();
}

async function runEcho(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  let newline = true;
  let interpret = false;
  const values: string[] = [];
  for (const arg of args) {
    if (arg === "-n" && values.length === 0) newline = false;
    else if (arg === "-e" && values.length === 0) interpret = true;
    else values.push(arg);
  }
  let text = values.join(" ");
  if (interpret) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  if (newline) text += "\n";
  await writeText(ctx, text);
  return { exitCode: 0, stderr: "" };
}

async function runPrintf(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  if (args.length === 0) return { exitCode: 0, stderr: "" };
  const format = args[0];
  let index = 1;
  const text = format.replace(/%([sdif%])/g, (_match, type: string) => {
    if (type === "%") return "%";
    const value = args[index++] ?? "";
    if (type === "d" || type === "i") return String(parseInt(value, 10) || 0);
    if (type === "f") return String(parseFloat(value) || 0);
    return value;
  }).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  await writeText(ctx, text);
  return { exitCode: 0, stderr: "" };
}

async function runYes(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const text = (args.length ? args.join(" ") : "y") + "\n";
  const chunk = stringToBytes(text.repeat(Math.max(1, Math.min(128, Math.ceil(4096 / text.length)))));
  while (!ctx.token.signal.aborted) {
    await writeBytes(ctx, chunk);
  }
  return { exitCode: 130, stderr: "" };
}

async function runCat(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const flags = new Set<string>();
  const files: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      for (const flag of arg.slice(1)) flags.add(flag);
    } else {
      files.push(arg);
    }
  }
  const formatting = ["n", "b", "s", "E", "T", "A", "e", "t", "v"].some((flag) => flags.has(flag));
  if (formatting) {
    let content = "";
    const sources = files.length ? files : ["-"];
    for (const file of sources) {
      if (file === "-") content += await readAll(ctx);
      else if (file === "/dev/null") continue;
      else {
        try {
          content += ctx.volume.readFileSync(resolvePath(file, ctx.cwd), "utf8");
        } catch {
          return { exitCode: 1, stderr: `cat: ${file}: No such file or directory\n` };
        }
      }
    }
    await writeText(ctx, formatCatText(content, {
      numberAll: flags.has("n"),
      numberNonBlank: flags.has("b"),
      squeeze: flags.has("s"),
      showEnds: flags.has("E") || flags.has("A") || flags.has("e"),
      showTabs: flags.has("T") || flags.has("A") || flags.has("t"),
      showNonprinting: flags.has("v") || flags.has("A") || flags.has("e") || flags.has("t"),
    }, ctx.maxLoopIterations));
    return { exitCode: 0, stderr: "" };
  }
  if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
    for (;;) {
      const chunk = await ctx.input?.read(ctx.token);
      if (!chunk) break;
      await ctx.output.write(chunk, ctx.token);
    }
    return { exitCode: 0, stderr: "" };
  }
  for (const file of files) {
    if (file === "/dev/null") continue;
    if (file === "/dev/zero") {
      const zeros = new Uint8Array(4096);
      while (!ctx.token.signal.aborted) await writeBytes(ctx, zeros);
      return { exitCode: 130, stderr: "" };
    }
    if (file === "/dev/stdin") {
      for (;;) {
        const chunk = await ctx.input?.read(ctx.token);
        if (chunk === null || chunk === undefined) break;
        await ctx.output.write(chunk, ctx.token);
      }
      continue;
    }
    const path = resolvePath(file, ctx.cwd);
    let content: string;
    try {
      content = ctx.volume.readFileSync(path, "utf8");
    } catch {
      return { exitCode: 1, stderr: `cat: ${file}: No such file or directory\n` };
    }
    await writeText(ctx, content);
  }
  return { exitCode: 0, stderr: "" };
}

async function runHead(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  let lines = 10;
  let bytes: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") {
      const parsed = parseInt(args[++i] ?? "10", 10);
      if (Number.isFinite(parsed)) lines = parsed;
    }
    else if (args[i] === "-c") bytes = parseInt(args[++i] ?? "0", 10) || 0;
    else if (/^-\d+$/.test(args[i])) lines = parseInt(args[i].slice(1), 10);
  }
  if (!ctx.input) return { exitCode: 0, stderr: "" };
  if (bytes === null && lines <= 0) {
    ctx.cancelUpstream();
    return { exitCode: 0, stderr: "" };
  }
  const decoder = new TextDecoder();
  let text = "";
  let lineCount = 0;
  let done = false;
  while (!done) {
    const chunk = await ctx.input.read(ctx.token);
    if (chunk === null) break;
    const decoded = decoder.decode(chunk, { stream: true });
    if (bytes !== null) {
      text += decoded;
      if (text.length >= bytes) {
        text = text.slice(0, bytes);
        done = true;
      }
    } else {
      text += decoded;
      if (lines <= 0) {
        text = "";
        done = true;
        continue;
      }
      lineCount += (decoded.match(/\n/g) ?? []).length;
      if (lineCount >= lines) {
        const parts = text.split("\n");
        text = parts.slice(0, lines).join("\n") + "\n";
        done = true;
      }
    }
  }
  if (!done) text += decoder.decode();
  await writeText(ctx, text);
  if (done) ctx.cancelUpstream();
  return { exitCode: 0, stderr: "" };
}

async function runTail(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  let lines = 10;
  let bytes: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-n") lines = Number(args[++i] ?? "10");
    else if (args[i] === "-c") bytes = Number(args[++i] ?? "0");
    else if (/^-\d+$/.test(args[i])) lines = Number(args[i].slice(1));
  }
  const input = await readAll(ctx);
  const output = bytes !== null
    ? input.slice(-Math.max(0, bytes))
    : lines <= 0
      ? ""
      : (() => {
        const trailingNewline = input.endsWith("\n");
        const values = trailingNewline ? input.slice(0, -1).split("\n") : input.split("\n");
        const selected = values.slice(Math.max(0, values.length - lines)).join("\n");
        return trailingNewline && selected.length > 0 ? `${selected}\n` : selected;
      })();
  await writeText(ctx, output);
  return { exitCode: 0, stderr: "" };
}

async function runWc(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const lineCount = input ? input.split("\n").length - (input.endsWith("\n") ? 1 : 0) : 0;
  const wordCount = input.trim() ? input.trim().split(/\s+/).length : 0;
  const byteCount = new TextEncoder().encode(input).byteLength;
  const flags = args.filter((arg) => arg.startsWith("-")).join("");
  const values = flags.includes("l") || flags.includes("w") || flags.includes("c")
    ? [flags.includes("l") ? lineCount : null, flags.includes("w") ? wordCount : null, flags.includes("c") ? byteCount : null].filter((v): v is number => v !== null)
    : [lineCount, wordCount, byteCount];
  await writeText(ctx, values.join(" ") + "\n");
  return { exitCode: 0, stderr: "" };
}

async function runGrep(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const options = args.filter((arg) => arg.startsWith("-"));
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const pattern = positional[0];
  if (pattern === undefined) return { exitCode: 2, stderr: "grep: missing pattern\n" };
  const safetyError = regexSafetyError(pattern, Math.min(ctx.maxOutputBytes, 64 * 1024));
  if (safetyError) return { exitCode: 2, stderr: `grep: ${safetyError}\n` };
  const invert = options.some((arg) => arg.includes("v"));
  const ignoreCase = options.some((arg) => arg.includes("i"));
  let regex: RegExp;
  try { regex = new RegExp(pattern, ignoreCase ? "i" : ""); }
  catch { return { exitCode: 2, stderr: `grep: Invalid regular expression: '${pattern}'\n` }; }
  const input = await readAll(ctx);
  const matched: string[] = [];
  const lines = input.split("\n");
  if (lines.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `grep: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && (index & 255) === 0) await yieldToEventLoop(ctx.token.signal);
    const line = lines[index];
    if (!line && input.endsWith("\n")) continue;
    if (regex.test(line) !== invert) matched.push(line);
  }
  await writeText(ctx, matched.length ? matched.join("\n") + "\n" : "");
  return { exitCode: matched.length ? 0 : 1, stderr: "" };
}

async function runSort(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const reverse = args.includes("-r") || args.includes("--reverse");
  const numeric = args.includes("-n") || args.includes("--numeric-sort");
  const unique = args.includes("-u") || args.includes("--unique");
  const lines = input.replace(/\n$/, "").split("\n").filter((line) => line.length > 0);
  if (lines.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `sort: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  lines.sort((a, b) => {
    const result = numeric ? (Number(a) || 0) - (Number(b) || 0) : a < b ? -1 : a > b ? 1 : 0;
    return reverse ? -result : result;
  });
  const output = (unique ? lines.filter((line, index) => index === 0 || line !== lines[index - 1]) : lines).join("\n");
  await writeText(ctx, output ? output + "\n" : "");
  return { exitCode: 0, stderr: "" };
}

async function runUniq(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const count = args.includes("-c");
  const onlyDuplicates = args.includes("-d");
  const onlyUnique = args.includes("-u");
  const lines = input.replace(/\n$/, "").split("\n").filter((line) => line.length > 0);
  if (lines.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `uniq: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  const groups: Array<{ line: string; count: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && (index & 255) === 0) await yieldToEventLoop(ctx.token.signal);
    const line = lines[index];
    const last = groups[groups.length - 1];
    if (last?.line === line) last.count++;
    else groups.push({ line, count: 1 });
  }
  const output = groups
    .filter((group) => (!onlyDuplicates || group.count > 1) && (!onlyUnique || group.count === 1))
    .map((group) => count ? `${String(group.count).padStart(7)} ${group.line}` : group.line)
    .join("\n");
  await writeText(ctx, output ? output + "\n" : "");
  return { exitCode: 0, stderr: "" };
}

async function runCut(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const delimiterIndex = args.indexOf("-d");
  const fieldIndex = args.indexOf("-f");
  const delimiter = delimiterIndex >= 0 ? args[delimiterIndex + 1] ?? "\t" : "\t";
  const fields: number[] = [];
  for (const part of (fieldIndex >= 0 ? args[fieldIndex + 1] ?? "" : "").split(",")) {
    const range = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!range) continue;
    const start = Number(range[1]);
    const end = Number(range[2] ?? range[1]);
    const count = Math.max(0, end - start + 1);
    if (!Number.isSafeInteger(count) || fields.length + count > ctx.maxLoopIterations) {
      return { exitCode: 1, stderr: `cut: range contains more than ${ctx.maxLoopIterations} positions\n` };
    }
    for (let index = 0; index < count; index++) fields.push(start + index);
  }
  if (!fields.length) return { exitCode: 2, stderr: "cut: you must specify a list of bytes, characters, or fields\n" };
  const lines = input.split("\n");
  if (lines.length * fields.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `cut: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  const selected: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && (index & 255) === 0) await yieldToEventLoop(ctx.token.signal);
    const parts = lines[index].split(delimiter);
    selected.push(fields.map((field) => parts[field - 1] ?? "").join(delimiter));
  }
  const output = selected.join("\n");
  await writeText(ctx, output);
  return { exitCode: 0, stderr: "" };
}

async function runTr(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const deleteMode = args.includes("-d");
  const squeeze = args.includes("-s");
  const sets = args.filter((arg) => !arg.startsWith("-"));
  const from = sets[0] ?? "";
  const to = sets[1] ?? "";
  const fromChars = [...from];
  const toChars = [...to];
  if (fromChars.length + toChars.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `tr: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  const map = new Map<string, string>();
  fromChars.forEach((char, index) => map.set(char, toChars[Math.min(index, Math.max(0, toChars.length - 1))] ?? ""));
  let output = "";
  let index = 0;
  for (const char of input) {
    if (++index > ctx.maxLoopIterations) {
      return { exitCode: 1, stderr: `tr: operation limit ${ctx.maxLoopIterations} exceeded\n` };
    }
    if ((index & 255) === 0) await yieldToEventLoop(ctx.token.signal);
    if (deleteMode && map.has(char)) continue;
    output += map.has(char) ? map.get(char) : char;
  }
  if (squeeze && to) {
    const squeezeSet = new Set(toChars);
    let squeezed = "";
    let previous = "";
    for (const char of output) {
      if (char === previous && squeezeSet.has(char)) continue;
      squeezed += char;
      previous = char;
    }
    output = squeezed;
  }
  await writeText(ctx, output);
  return { exitCode: 0, stderr: "" };
}

async function runSed(args: string[], ctx: StreamCommandContext): Promise<StreamCommandResult> {
  const input = await readAll(ctx);
  const script = args.find((arg) => arg.startsWith("s/") || arg.startsWith("/"));
  if (!script) {
    await writeText(ctx, input);
    return { exitCode: 0, stderr: "" };
  }
  const match = script.match(/^s([/|#])(.*?)\1(.*?)\1([gip]*)$/);
  if (!match) return { exitCode: 1, stderr: `sed: invalid command: ${script}\n` };
  const safetyError = regexSafetyError(match[2], Math.min(ctx.maxOutputBytes, 64 * 1024));
  if (safetyError) return { exitCode: 1, stderr: `sed: ${safetyError}\n` };
  let pattern: RegExp;
  try { pattern = new RegExp(match[2], (match[4].includes("g") ? "g" : "") + (match[4].includes("i") ? "i" : "")); }
  catch { return { exitCode: 1, stderr: `sed: invalid regular expression: ${match[2]}\n` }; }
  const replacement = match[3].replace(/\\n/g, "\n");
  const lines = input.split("\n");
  if (lines.length > ctx.maxLoopIterations) {
    return { exitCode: 1, stderr: `sed: operation limit ${ctx.maxLoopIterations} exceeded\n` };
  }
  const transformed: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (index > 0 && (index & 255) === 0) await yieldToEventLoop(ctx.token.signal);
    pattern.lastIndex = 0;
    transformed.push(lines[index].replace(pattern, replacement));
  }
  const output = transformed.join("\n");
  await writeText(ctx, output);
  return { exitCode: 0, stderr: "" };
}

const STREAMABLE = new Set(["echo", "printf", "yes", "cat", "head", "tail", "wc", "grep", "sort", "uniq", "cut", "tr", "sed"]);

// /usr/local/bin is where `which` and process.execPath place node and the
// package managers (tsx spawns process.execPath)
export function canonicalVirtualCommandName(name: string): string {
  const match = name.match(/^\/(?:usr\/(?:local\/)?)?bin\/([^/]+)$/);
  return match ? match[1] : name;
}

export function isStreamableCommand(name: string): boolean {
  return STREAMABLE.has(canonicalVirtualCommandName(name));
}

export async function runStreamCommand(
  name: string,
  args: string[],
  ctx: StreamCommandContext,
): Promise<StreamCommandResult> {
  name = canonicalVirtualCommandName(name);
  switch (name) {
    case "echo": return runEcho(args, ctx);
    case "printf": return runPrintf(args, ctx);
    case "yes": return runYes(args, ctx);
    case "cat": return runCat(args, ctx);
    case "head": return runHead(args, ctx);
    case "tail": return runTail(args, ctx);
    case "wc": return runWc(args, ctx);
    case "grep": return runGrep(args, ctx);
    case "sort": return runSort(args, ctx);
    case "uniq": return runUniq(args, ctx);
    case "cut": return runCut(args, ctx);
    case "tr": return runTr(args, ctx);
    case "sed": return runSed(args, ctx);
    default: return { exitCode: 127, stderr: `${name}: command not found\n` };
  }
}
