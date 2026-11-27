import type { BuiltinFn, ShellContext } from "../shell-types.js";
import { fail, resolvePath, processEscapes } from "../shell-helpers.js";
import { modeString } from "./directory.js";

type Stat = ReturnType<ShellContext["volume"]["lstatSync"]>;

/* ------------------------------------------------------------------ */
/*  stat                                                               */
/* ------------------------------------------------------------------ */

function fileType(stat: Stat): string {
  if (stat.isSymbolicLink()) return "symbolic link";
  if (stat.isDirectory()) return "directory";
  if (stat.isCharacterDevice?.()) return "character special file";
  if (stat.isBlockDevice?.()) return "block special file";
  if (stat.isFIFO?.()) return "fifo";
  if (stat.isSocket?.()) return "socket";
  return stat.size === 0 ? "regular empty file" : "regular file";
}

function timestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const offset = -date.getTimezoneOffset();
  const zone = (offset >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(offset) / 60)) + pad(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}000000 ${zone}`;
}

// GNU stat: the default listing, -c/--format (a newline after each file)
// and --printf (escapes, no newline), -L to follow symlinks, -t terse
export const stat_cmd: BuiltinFn = (args, ctx) => {
  let format: string | null = null;
  let printf = false;
  let follow = false;
  let terse = false;
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--format") { format = args[++i] ?? ""; continue; }
    if (arg.startsWith("--format=")) { format = arg.slice(9); continue; }
    if (arg === "--printf") { format = args[++i] ?? ""; printf = true; continue; }
    if (arg.startsWith("--printf=")) { format = arg.slice(9); printf = true; continue; }
    if (arg === "-L" || arg === "--dereference") { follow = true; continue; }
    if (arg === "-t" || arg === "--terse") { terse = true; continue; }
    if (arg.startsWith("-c") && arg.length > 2) { format = arg.slice(2); continue; }
    if (arg.startsWith("-") && arg !== "-") return fail(`stat: invalid option -- '${arg.replace(/^-+/, "")}'\nTry 'stat --help' for more information.\n`);
    files.push(arg);
  }
  if (!files.length) return fail("stat: missing operand\nTry 'stat --help' for more information.\n");
  const user = ctx.env.USER || "user";
  let stdout = "";
  let stderr = "";
  for (const file of files) {
    const path = resolvePath(file, ctx.cwd);
    let stat: Stat;
    try { stat = follow ? ctx.volume.statSync(path) : ctx.volume.lstatSync(path); }
    catch { stderr += `stat: cannot statx '${file}': No such file or directory\n`; continue; }
    const s = stat as Stat & { ino?: number; nlink?: number; uid?: number; gid?: number; blocks?: number; blksize?: number; atimeMs?: number; ctimeMs?: number; birthtimeMs?: number; dev?: number };
    const uid = s.uid ?? 1000;
    const gid = s.gid ?? 1000;
    const blocks = s.blocks ?? Math.ceil(stat.size / 512);
    let target = "";
    if (stat.isSymbolicLink()) { try { target = ctx.volume.readlinkSync(path); } catch { /* dangling */ } }
    const fields: Record<string, () => string> = {
      n: () => file,
      N: () => target ? `'${file}' -> '${target}'` : `'${file}'`,
      s: () => String(stat.size),
      F: () => fileType(stat),
      a: () => ((stat.mode ?? 0) & 0o7777).toString(8),
      A: () => modeString(stat),
      f: () => (stat.mode ?? 0).toString(16),
      u: () => String(uid),
      U: () => user,
      g: () => String(gid),
      G: () => user,
      i: () => String(s.ino ?? 0),
      h: () => String(s.nlink ?? 1),
      b: () => String(blocks),
      B: () => "512",
      o: () => String(s.blksize ?? 4096),
      d: () => String(s.dev ?? 0),
      D: () => (s.dev ?? 0).toString(16),
      x: () => timestamp(s.atimeMs ?? stat.mtimeMs),
      X: () => String(Math.floor((s.atimeMs ?? stat.mtimeMs) / 1000)),
      y: () => timestamp(stat.mtimeMs),
      Y: () => String(Math.floor(stat.mtimeMs / 1000)),
      z: () => timestamp(s.ctimeMs ?? stat.mtimeMs),
      Z: () => String(Math.floor((s.ctimeMs ?? stat.mtimeMs) / 1000)),
      w: () => s.birthtimeMs ? timestamp(s.birthtimeMs) : "-",
      W: () => s.birthtimeMs ? String(Math.floor(s.birthtimeMs / 1000)) : "0",
      m: () => "/",
      t: () => "0",
      T: () => "0",
    };
    const render = (text: string) => text.replace(/%(-?\d*)([a-zA-Z%])/g, (whole, width: string, code: string) => {
      if (code === "%") return "%";
      const value = fields[code]?.();
      if (value === undefined) return whole;
      const w = Math.abs(Number(width) || 0);
      return width.startsWith("-") ? value.padEnd(w) : value.padStart(w);
    });
    if (format !== null) {
      stdout += printf ? processEscapes(render(format)) : render(format) + "\n";
      continue;
    }
    if (terse) {
      stdout += render("%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o") + "\n";
      continue;
    }
    const name = target ? `${file} -> ${target}` : file;
    stdout += `  File: ${name}\n`
      + `  Size: ${String(stat.size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: ${String(s.blksize ?? 4096).padEnd(6)} ${fileType(stat)}\n`
      + `Device: ${fields.D()}h/${fields.d()}d\tInode: ${String(s.ino ?? 0).padEnd(11)} Links: ${s.nlink ?? 1}\n`
      + `Access: (${fields.a().padStart(4, "0")}/${modeString(stat)})  Uid: (${String(uid).padStart(5)}/${user.padStart(8)})   Gid: (${String(gid).padStart(5)}/${user.padStart(8)})\n`
      + `Access: ${fields.x()}\nModify: ${fields.y()}\nChange: ${fields.z()}\n Birth: ${fields.w()}\n`;
  }
  return { stdout, stderr, exitCode: stderr ? 1 : 0 };
};

/* ------------------------------------------------------------------ */
/*  od                                                                 */
/* ------------------------------------------------------------------ */

const NAMED = ["nul", "soh", "stx", "etx", "eot", "enq", "ack", "bel", "bs", "ht", "nl", "vt", "ff", "cr", "so", "si",
  "dle", "dc1", "dc2", "dc3", "dc4", "nak", "syn", "etb", "can", "em", "sub", "esc", "fs", "gs", "rs", "us", "sp"];
const C_ESCAPES: Record<number, string> = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };

interface OdType {
  kind: "c" | "a" | "o" | "x" | "d" | "u" | "f";
  size: number;
}

const WIDTHS: Record<string, number> = { o1: 3, o2: 6, o4: 11, o8: 22, x1: 2, x2: 4, x4: 8, x8: 16, d1: 4, d2: 6, d4: 11, d8: 20, u1: 3, u2: 5, u4: 10, u8: 20, f4: 14, f8: 23, c1: 3, a1: 3 };

function parseType(spec: string): OdType[] | string {
  const types: OdType[] = [];
  let i = 0;
  while (i < spec.length) {
    const kind = spec[i++] as OdType["kind"];
    if (!"caoxduf".includes(kind)) return `od: invalid type string '${spec}'`;
    let size = kind === "c" || kind === "a" ? 1 : kind === "f" ? 8 : 4;
    const m = spec.slice(i).match(/^(\d+|[CSILFDL])/);
    if (m && kind !== "c" && kind !== "a") {
      const letter: Record<string, number> = { C: 1, S: 2, I: 4, L: 8, F: 4, D: 8 };
      size = letter[m[1]] ?? Number(m[1]);
      i += m[1].length;
    }
    if (!WIDTHS[`${kind}${size}`]) return `od: invalid type string '${spec}'`;
    types.push({ kind, size });
    while (spec[i] === "z") i++;
  }
  return types;
}

// a field's width: its digits and a space, or 4 for c and a
function fieldWidth(type: OdType): number {
  return type.kind === "c" || type.kind === "a" ? 4 : WIDTHS[`${type.kind}${type.size}`] + 1;
}

function formatValue(bytes: Uint8Array, offset: number, type: OdType, width: number): string {
  if (type.kind === "c") {
    const b = bytes[offset];
    const text = C_ESCAPES[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, "0"));
    return text.padStart(width);
  }
  if (type.kind === "a") {
    const b = bytes[offset] & 0x7f;
    return (b === 127 ? "del" : b <= 32 ? NAMED[b] : String.fromCharCode(b)).padStart(width);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, type.size);
  let value: bigint | number;
  if (type.kind === "f") value = type.size === 4 ? view.getFloat32(0, true) : view.getFloat64(0, true);
  else if (type.size === 8) value = type.kind === "d" ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
  else if (type.kind === "d") value = type.size === 1 ? view.getInt8(0) : type.size === 2 ? view.getInt16(0, true) : view.getInt32(0, true);
  else value = type.size === 1 ? view.getUint8(0) : type.size === 2 ? view.getUint16(0, true) : view.getUint32(0, true);
  const digits = WIDTHS[`${type.kind}${type.size}`];
  let text: string;
  if (type.kind === "o") text = value.toString(8).padStart(digits, "0");
  else if (type.kind === "x") text = value.toString(16).padStart(digits, "0");
  else if (type.kind === "f") text = String(value);
  else text = value.toString();
  return text.padStart(width);
}

// GNU od: -t types (c a oN xN dN uN fN), the short forms -b -c -d -o -x -s
// -i -l, -A address radix, -j skip, -N count, -w width, -v; lines identical
// to the one before print as `*`
export const od_cmd: BuiltinFn = (args, ctx, stdin) => {
  const types: OdType[] = [];
  let radix = "o" as "o" | "x" | "d" | "n";
  let skip = 0;
  let count = Infinity;
  let lineWidth = 16;
  let verbose = false;
  const files: string[] = [];
  const short: Record<string, string> = { a: "a", b: "o1", c: "c", d: "u2", o: "o2", x: "x2", s: "d2", i: "d4", l: "d8", f: "f4", D: "u4", O: "o4", X: "x4" };
  const add = (spec: string) => {
    const parsed = parseType(spec);
    if (typeof parsed === "string") return parsed;
    types.push(...parsed);
    return null;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-" || !arg.startsWith("-")) { files.push(arg); continue; }
    if (arg === "-v" || arg === "--output-duplicates") { verbose = true; continue; }
    const withValue = (flag: string) => arg.length > 2 ? arg.slice(2) : args[++i];
    if (arg.startsWith("-t") || arg.startsWith("--format=")) {
      const error = add(arg.startsWith("--") ? arg.slice(9) : withValue("t") ?? "");
      if (error) return fail(error + "\n");
      continue;
    }
    if (arg.startsWith("-A") || arg.startsWith("--address-radix=")) {
      const value = arg.startsWith("--") ? arg.slice(16) : withValue("A");
      if (!value || !"oxdn".includes(value)) return fail(`od: invalid output address radix '${value ?? ""}'; it must be one character from [doxn]\n`);
      radix = value as "o" | "x" | "d" | "n";
      continue;
    }
    if (arg.startsWith("-j") || arg.startsWith("-N") || arg.startsWith("-w")) {
      const value = arg.length > 2 ? arg.slice(2) : args[++i];
      const n = Number(value);
      if (value === undefined || !Number.isSafeInteger(n) || n < 0) return fail(`od: invalid number '${value ?? ""}'\n`);
      if (arg[1] === "j") skip = n;
      else if (arg[1] === "N") count = n;
      else lineWidth = n || 32;
      continue;
    }
    let ok = true;
    for (const flag of arg.slice(1)) {
      if (!short[flag]) { ok = false; break; }
      add(short[flag]);
    }
    if (!ok) return fail(`od: invalid option -- '${arg.slice(1)}'\nTry 'od --help' for more information.\n`);
  }
  if (!types.length) types.push({ kind: "o", size: 2 });
  // with several types, GNU widens the fields so the columns line up
  const perByte = Math.max(...types.map((type) => fieldWidth(type) / type.size));
  const widths = types.map((type) => Math.ceil(perByte * type.size));

  const chunks: Uint8Array[] = [];
  let stderr = "";
  for (const file of files.length ? files : ["-"]) {
    if (file === "-") { chunks.push(new TextEncoder().encode(stdin ?? "")); continue; }
    try {
      const data = ctx.volume.readFileSync(resolvePath(file, ctx.cwd)) as unknown;
      chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBufferLike));
    } catch { stderr += `od: ${file}: No such file or directory\n`; }
  }
  if (stderr) return { stdout: "", stderr, exitCode: 1 };
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.length; }
  const input = all.slice(Math.min(skip, total), Math.min(total, skip + count));

  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const address = (n: number) => radix === "n" ? "" : radix === "x" ? n.toString(16).padStart(6, "0") : radix === "d" ? String(n).padStart(7, "0") : n.toString(8).padStart(7, "0");
  let out = "";
  let previous: string | null = null;
  let starred = false;
  for (let offset = 0; offset < input.length; offset += lineWidth) {
    const line = input.slice(offset, offset + lineWidth);
    const key = line.join(",");
    if (!verbose && previous === key && line.length === lineWidth) {
      if (!starred) out += "*\n";
      starred = true;
      continue;
    }
    previous = key;
    starred = false;
    types.forEach((type, index) => {
      const padded = new Uint8Array(Math.ceil(line.length / type.size) * type.size);
      padded.set(line);
      let text = index === 0 ? address(skip + offset) : " ".repeat(address(0).length);
      for (let i = 0; i < padded.length; i += type.size) text += formatValue(padded, i, type, widths[index]);
      out += text + "\n";
    });
    if (out.length > outputLimit) return fail("od: output limit exceeded\n");
  }
  if (radix !== "n") out += address(skip + input.length) + "\n";
  return { stdout: out, stderr: "", exitCode: 0 };
};
