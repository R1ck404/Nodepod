import type { BuiltinFn } from "../shell-types.js";
import {
  ok,
  fail,
  resolvePath,
  parseArgs,
  humanSize,
  collator,
  pathModule,
  MONTHS_SHORT,
  RESET,
  BOLD_BLUE,
  yieldToEventLoop,
} from "../shell-helpers.js";
import type { MemoryVolume } from "../../memory-volume.js";

const BOLD_CYAN = "\x1b[1;36m";
const BOLD_GREEN = "\x1b[1;32m";
const BOLD_YELLOW = "\x1b[1;33m";
import { LS_BLOCK_SIZE } from "../../constants/config.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type Stat = ReturnType<MemoryVolume["lstatSync"]>;

// `-rwxr-xr-x` from a stat's mode, as ls -l prints it
export function modeString(stat: Stat): string {
  const mode = stat.mode ?? 0;
  const type = stat.isSymbolicLink() ? "l" : stat.isDirectory() ? "d"
    : stat.isCharacterDevice?.() ? "c" : stat.isBlockDevice?.() ? "b"
    : stat.isFIFO?.() ? "p" : stat.isSocket?.() ? "s" : "-";
  const triple = (shift: number, special: number, specialChar: string): string => {
    const bits = (mode >> shift) & 7;
    const exec = bits & 1;
    const x = mode & special ? (exec ? specialChar : specialChar.toUpperCase()) : exec ? "x" : "-";
    return (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + x;
  };
  return type + triple(6, 0o4000, "s") + triple(3, 0o2000, "s") + triple(0, 0o1000, "t");
}

function lsDate(d: Date): string {
  const mon = MONTHS_SHORT[d.getMonth()];
  const day = String(d.getDate()).padStart(2, " ");
  const now = new Date();
  const sixMonthsAgo = new Date(
    now.getFullYear(),
    now.getMonth() - 6,
    now.getDate(),
  );
  if (d < sixMonthsAgo || d > now) {
    return `${mon} ${day}  ${d.getFullYear()}`;
  }
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${hh}:${mm}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

const LS_USAGE = `Usage: ls [OPTION]... [FILE]...
List information about the FILEs (the current directory by default).
Sort entries alphabetically unless a sort option is given.

  -a, --all                  do not ignore entries starting with .
  -A, --almost-all           do not list implied . and ..
      --color[=WHEN]         color the output WHEN: always, auto or never
  -d, --directory            list directories themselves, not their contents
  -F, --classify             append an indicator (one of */=>@|) to entries
  -h, --human-readable       with -l, print sizes like 1K 234M 2G
  -i, --inode                print the index number of each file
  -l                         use a long listing format
  -p                         append / to directories
  -r, --reverse              reverse order while sorting
  -R, --recursive            list subdirectories recursively
  -S                         sort by file size, largest first
  -t                         sort by time, newest first
  -1                         list one file per line
      --help                 display this help and exit
`;

interface LsEntry {
  name: string;      // as printed
  full: string;      // absolute path in the volume
  stat: Stat;
  target?: string;   // a symlink's target
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

// GNU ls: one name per line when the output isn't a terminal, columns when
// it is; colors only on a terminal (or --color=always).
const ls: BuiltinFn = async (args, ctx) => {
  const flags = new Set<string>();
  const operands: string[] = [];
  let color: boolean | undefined;
  const longFlags: Record<string, string> = {
    all: "a", "almost-all": "A", directory: "d", classify: "F", "human-readable": "h",
    inode: "i", reverse: "r", recursive: "R",
  };
  let options = true;
  for (const arg of args) {
    if (!options || arg === "-" || !arg.startsWith("-")) { operands.push(arg); continue; }
    if (arg === "--") { options = false; continue; }
    if (arg === "--help") return ok(LS_USAGE);
    if (arg.startsWith("--color")) {
      const when = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "always";
      if (when === "always" || when === "yes" || when === "force") color = true;
      else if (when === "never" || when === "no" || when === "none") color = false;
      else if (when === "auto" || when === "tty" || when === "if-tty") color = undefined;
      else return fail(`ls: invalid argument '${when}' for '--color'\n`, 2);
      continue;
    }
    if (arg.startsWith("--")) {
      const short = longFlags[arg.slice(2)];
      if (!short) return fail(`ls: unrecognized option '${arg}'\nTry 'ls --help' for more information.\n`, 2);
      flags.add(short);
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (!"laARhStrFdi1pCx".includes(ch)) return fail(`ls: invalid option -- '${ch}'\nTry 'ls --help' for more information.\n`, 2);
      flags.add(ch);
    }
  }
  const showAll = flags.has("a");
  const showAlmostAll = flags.has("A");
  const longForm = flags.has("l");
  const recursive = flags.has("R");
  const humanReadable = flags.has("h");
  const classify = flags.has("F");
  const slashDirs = flags.has("p");
  const dirOnly = flags.has("d");
  const showInode = flags.has("i");
  const toTerminal = !ctx.stdoutCaptured;
  const useColor = color ?? toTerminal;
  const onePerLine = flags.has("1") || longForm || (!toTerminal && !flags.has("C") && !flags.has("x"));
  const width = Math.max(1, Number(ctx.env.COLUMNS) || 80);
  const order = collator(ctx.env);

  let visited = 0;
  const entryLimit = ctx.limits?.maxFilesystemEntries ?? 100_000;
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  let out = "";
  let stderr = "";
  let status = 0;
  const write = (text: string): void => {
    if (out.length + text.length > outputLimit) throw new Error(`output exceeds ${outputLimit} bytes`);
    out += text;
  };
  const visit = async (): Promise<void> => {
    if (ctx.signal?.aborted) throw new Error("command cancelled");
    if (++visited > entryLimit) throw new Error(`filesystem entry limit ${entryLimit} exceeded`);
    if ((visited & 127) === 0) await yieldToEventLoop(ctx.signal);
  };

  const executable = (stat: Stat) => !stat.isDirectory() && ((stat.mode ?? 0) & 0o111) !== 0;
  const paint = (entry: LsEntry): string => {
    if (!useColor) return entry.name;
    const { stat } = entry;
    if (stat.isSymbolicLink()) return `${BOLD_CYAN}${entry.name}${RESET}`;
    if (stat.isDirectory()) return `${BOLD_BLUE}${entry.name}${RESET}`;
    if (stat.isCharacterDevice?.() || stat.isBlockDevice?.()) return `${BOLD_YELLOW}${entry.name}${RESET}`;
    if (executable(stat)) return `${BOLD_GREEN}${entry.name}${RESET}`;
    return entry.name;
  };
  const indicator = (stat: Stat): string => {
    if (classify) {
      if (stat.isDirectory()) return "/";
      if (stat.isSymbolicLink()) return longForm ? "" : "@";
      if (stat.isFIFO?.()) return "|";
      if (stat.isSocket?.()) return "=";
      if (executable(stat)) return "*";
    } else if (slashDirs && stat.isDirectory()) return "/";
    return "";
  };
  const inodeOf = (entry: LsEntry) => String((entry.stat as { ino?: number }).ino || Math.abs(hashCode(entry.full)));

  const sortEntries = (entries: LsEntry[]): LsEntry[] => {
    const byName = (a: LsEntry, b: LsEntry) => order(a.name, b.name);
    if (flags.has("S")) entries.sort((a, b) => b.stat.size - a.stat.size || byName(a, b));
    else if (flags.has("t")) entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || byName(a, b));
    else entries.sort(byName);
    if (flags.has("r")) entries.reverse();
    return entries;
  };

  const print = (entries: LsEntry[], withTotal: boolean): void => {
    if (longForm) {
      if (withTotal) {
        const blocks = entries.reduce((sum, e) => sum + (e.stat.isDirectory() ? 0 : Math.ceil(e.stat.size / LS_BLOCK_SIZE)), 0);
        write(`total ${blocks}\n`);
      }
      const rows = entries.map((entry) => ({
        entry,
        inode: inodeOf(entry),
        links: String((entry.stat as { nlink?: number }).nlink || 1),
        size: humanReadable ? humanSize(entry.stat.size) : String(entry.stat.size),
      }));
      const w = (key: "inode" | "links" | "size") => Math.max(0, ...rows.map((r) => r[key].length));
      const inodeWidth = w("inode"), linkWidth = w("links"), sizeWidth = w("size");
      for (const row of rows) {
        const { entry } = row;
        const inode = showInode ? row.inode.padStart(inodeWidth) + " " : "";
        const link = entry.target !== undefined ? ` -> ${entry.target}` : "";
        write(`${inode}${modeString(entry.stat)} ${row.links.padStart(linkWidth)} user user ${row.size.padStart(sizeWidth)} ${lsDate(new Date(entry.stat.mtimeMs || Date.now()))} ${paint(entry)}${indicator(entry.stat)}${link}\n`);
      }
      return;
    }
    const cells = entries.map((entry) => {
      const inode = showInode ? inodeOf(entry) + " " : "";
      const suffix = indicator(entry.stat);
      return { text: inode + paint(entry) + suffix, length: inode.length + entry.name.length + suffix.length };
    });
    if (onePerLine) {
      for (const cell of cells) write(cell.text + "\n");
      return;
    }
    if (!cells.length) return;
    // as many columns as fit, filled top to bottom (-x: left to right)
    const across = flags.has("x");
    let columns = 1;
    let widths = [Math.max(...cells.map((c) => c.length))];
    for (let cols = cells.length; cols > 1; cols--) {
      const rows = Math.ceil(cells.length / cols);
      const used = across ? cols : Math.ceil(cells.length / rows);
      const colWidths = new Array(used).fill(0);
      cells.forEach((cell, i) => {
        const col = across ? i % cols : Math.floor(i / rows);
        colWidths[col] = Math.max(colWidths[col], cell.length);
      });
      const total = colWidths.reduce((sum, cw) => sum + cw, 0) + 2 * (used - 1);
      if (total < width) { columns = used; widths = colWidths; break; }
    }
    const rows = Math.ceil(cells.length / columns);
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < columns; c++) {
        const index = across ? r * columns + c : c * rows + r;
        const cell = cells[index];
        if (!cell) continue;
        const nextIndex = across ? index + 1 : (c + 1) * rows + r;
        const last = c === columns - 1 || !cells[nextIndex] || (across && (index + 1) % columns === 0);
        line += last ? cell.text : cell.text + " ".repeat(widths[c] - cell.length + 2);
      }
      write(line + "\n");
    }
  };

  const entryFor = (name: string, full: string): LsEntry => {
    const stat = ctx.volume.lstatSync(full);
    const entry: LsEntry = { name, full, stat };
    if (stat.isSymbolicLink()) {
      try { entry.target = ctx.volume.readlinkSync(full); } catch { entry.target = ""; }
    }
    return entry;
  };

  const listDir = async (full: string, label: string, header: boolean, first: boolean): Promise<void> => {
    await visit();
    let names: string[];
    try { names = ctx.volume.readdirSync(full); }
    catch {
      stderr += `ls: cannot open directory '${label}': Permission denied\n`;
      status = 2;
      return;
    }
    if (showAll) names = [".", "..", ...names.filter((e) => e !== "." && e !== "..")];
    else if (showAlmostAll) names = names.filter((e) => e !== "." && e !== "..");
    else names = names.filter((e) => !e.startsWith("."));
    const entries: LsEntry[] = [];
    for (const name of names) {
      await visit();
      const child = name === "." ? full : name === ".." ? (full === "/" ? "/" : full.slice(0, full.lastIndexOf("/")) || "/") : full === "/" ? `/${name}` : `${full}/${name}`;
      try { entries.push(entryFor(name, child)); }
      catch { /* vanished while listing */ }
    }
    sortEntries(entries);
    if (header) write(`${first ? "" : "\n"}${label}:\n`);
    print(entries, true);
    if (!recursive) return;
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || !entry.stat.isDirectory()) continue;
      const childLabel = label.endsWith("/") ? label + entry.name : `${label}/${entry.name}`;
      await listDir(entry.full, childLabel, true, false);
    }
  };

  try {
    const typed = operands.length ? operands : ["."];
    const files: LsEntry[] = [];
    const dirs: LsEntry[] = [];
    for (const operand of typed) {
      const full = resolvePath(operand, ctx.cwd);
      let entry: LsEntry;
      try { entry = entryFor(operand, full); }
      catch {
        stderr += `ls: cannot access '${operand}': No such file or directory\n`;
        status = 2;
        continue;
      }
      // a symlink to a folder is listed as the folder unless -l or -d
      let isDir = entry.stat.isDirectory();
      if (entry.stat.isSymbolicLink() && !longForm && !dirOnly) {
        try { isDir = ctx.volume.statSync(full).isDirectory(); } catch { /* dangling */ }
      }
      if (isDir && !dirOnly) dirs.push(entry);
      else files.push(entry);
    }
    sortEntries(files);
    sortEntries(dirs);
    if (files.length) print(files, false);
    const headers = typed.length > 1 || recursive;
    for (const [i, dir] of dirs.entries()) {
      await listDir(dir.full, dir.name, headers, i === 0 && !files.length);
    }
  } catch (error) {
    return { stdout: out, stderr: stderr + `ls: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: ctx.signal?.aborted ? 130 : 2 };
  }
  return { stdout: out, stderr, exitCode: status };
};

const cd: BuiltinFn = (args, ctx) => {
  const target = args[0] || ctx.env.HOME || "/";
  let newDir: string;

  if (target === "-") {
    newDir = ctx.env.OLDPWD || ctx.cwd;
  } else {
    newDir = resolvePath(target, ctx.cwd);
  }

  try {
    const st = ctx.volume.statSync(newDir);
    if (!st.isDirectory()) return fail(`cd: not a directory: ${target}\n`);
    ctx.env.OLDPWD = ctx.cwd;
    ctx.cwd = newDir;
    ctx.env.PWD = newDir;
    // keep process.cwd() in sync
    try {
      (globalThis as any).process?.chdir?.(newDir);
    } catch {}
    return ok();
  } catch {
    return fail(`cd: no such file or directory: ${target}\n`);
  }
};

const pwd: BuiltinFn = (_args, ctx) => {
  return ok(ctx.cwd + "\n");
};

const basename_cmd: BuiltinFn = (args) => {
  const { positional } = parseArgs(args, ["a", "z"], ["s"]);
  if (positional.length === 0) return fail("basename: missing operand\n");

  const suffix = positional[1] || "";
  let result = pathModule.basename(positional[0]);
  if (suffix && result.endsWith(suffix)) {
    result = result.slice(0, -suffix.length);
  }
  return ok(result + "\n");
};

const dirname_cmd: BuiltinFn = (args) => {
  if (args.length === 0) return fail("dirname: missing operand\n");
  return ok(pathModule.dirname(args[0]) + "\n");
};

const realpath_cmd: BuiltinFn = (args, ctx) => {
  if (args.length === 0) return fail("realpath: missing operand\n");
  const p = resolvePath(args[0], ctx.cwd);
  if (!ctx.volume.existsSync(p))
    return fail(`realpath: ${args[0]}: No such file or directory\n`);
  return ok(p + "\n");
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const directoryCommands: [string, BuiltinFn][] = [
  ["ls", ls],
  ["cd", cd],
  ["pwd", pwd],
  ["basename", basename_cmd],
  ["dirname", dirname_cmd],
  ["realpath", realpath_cmd],
];
