import type { BuiltinFn } from "../shell-types.js";
import {
  ok,
  fail,
  resolvePath,
  parseArgs,
  humanSize,
  pathModule,
  MONTHS_SHORT,
  RESET,
  DIM,
  GREEN,
  CYAN,
  BOLD_BLUE,
  yieldToEventLoop,
} from "../shell-helpers.js";
import { LS_BLOCK_SIZE } from "../../constants/config.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function colorName(name: string, isDir: boolean): string {
  if (isDir) return `${BOLD_BLUE}${name}${RESET}`;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  if (ext === ".sh" || ext === ".bin") return `${GREEN}${name}${RESET}`;
  return name;
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

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

const ls: BuiltinFn = async (args, ctx) => {
  const { flags, positional } = parseArgs(args, [
    "l",
    "a",
    "A",
    "R",
    "1",
    "h",
    "S",
    "t",
    "r",
    "F",
    "d",
    "i",
  ]);
  const showAll = flags.has("a");
  const showAlmostAll = flags.has("A");
  const longForm = flags.has("l");
  const recursive = flags.has("R");
  const onePerLine = flags.has("1") || longForm;
  const humanReadable = flags.has("h");
  const sortBySize = flags.has("S");
  const sortByTime = flags.has("t");
  const reverseSort = flags.has("r");
  const classify = flags.has("F");
  const dirOnly = flags.has("d");
  const showInode = flags.has("i");

  const dir =
    positional.length > 0 ? resolvePath(positional[0], ctx.cwd) : ctx.cwd;

  let visited = 0;
  const entryLimit = ctx.limits?.maxFilesystemEntries ?? 100_000;
  const outputLimit = ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024;
  const append = (current: string, addition: string): string => {
    if (current.length + addition.length > outputLimit) {
      throw new Error(`output exceeds ${outputLimit} bytes`);
    }
    return current + addition;
  };
  const visit = async (): Promise<void> => {
    if (ctx.signal?.aborted) throw new Error("command cancelled");
    if (++visited > entryLimit) throw new Error(`filesystem entry limit ${entryLimit} exceeded`);
    if ((visited & 127) === 0) await yieldToEventLoop(ctx.signal);
  };

  const lsDir = async (d: string, prefix: string): Promise<string> => {
    await visit();
    if (dirOnly) {
      const name = positional[0] || d;
      if (longForm) {
        const st = ctx.volume.lstatSync(d);
        const isDir = st.isDirectory();
        const mode = isDir
          ? `${CYAN}drwxr-xr-x${RESET}`
          : `${DIM}-rw-r--r--${RESET}`;
        return `${mode} 1 user user ${String(0).padStart(6)} ${lsDate(new Date(st.mtimeMs || Date.now()))} ${colorName(name, isDir)}\n`;
      }
      return colorName(name, true) + "\n";
    }

    let entries: string[];
    try {
      entries = ctx.volume.readdirSync(d);
    } catch {
      return `ls: cannot access '${d}': No such file or directory\n`;
    }

    if (showAll) {
      // MemoryVolume's readdirSync intentionally omits the synthetic dot
      // entries. `ls -a` must add them, while `-A` must continue to omit them.
      entries = [".", "..", ...entries.filter((e) => e !== "." && e !== "..")];
    } else if (showAlmostAll)
      entries = entries.filter((e) => e !== "." && e !== "..");
    else entries = entries.filter((e) => !e.startsWith("."));

    interface EntryInfo {
      name: string;
      isDir: boolean;
      size: number;
      mtime: number;
    }
    const infos: EntryInfo[] = [];
    for (const name of entries) {
      await visit();
      const full = d === "/" ? `/${name}` : `${d}/${name}`;
      try {
        // Do not follow child symlinks during recursive traversal. This is
        // both Bash-compatible for `ls -R` and prevents symlink cycles.
        const st = ctx.volume.lstatSync(full);
        const isDir = st.isDirectory();
        const size = isDir ? 0 : st.size;
        infos.push({ name, isDir, size, mtime: st.mtimeMs || 0 });
      } catch {
        infos.push({ name, isDir: false, size: 0, mtime: 0 });
      }
    }

    if (sortBySize) infos.sort((a, b) => b.size - a.size);
    else if (sortByTime) infos.sort((a, b) => b.mtime - a.mtime);
    else infos.sort((a, b) => a.name.localeCompare(b.name));
    if (reverseSort) infos.reverse();

    let out = prefix ? `${BOLD_BLUE}${prefix}${RESET}:\n` : "";

    if (longForm) {
      const totalBlocks = infos.reduce(
        (s, e) => s + Math.ceil(e.size / LS_BLOCK_SIZE),
        0,
      );
      out = append(out, `total ${totalBlocks}\n`);
      for (const info of infos) {
        const mode = info.isDir
          ? `${CYAN}drwxr-xr-x${RESET}`
          : `${DIM}-rw-r--r--${RESET}`;
        const sizeStr = humanReadable
          ? humanSize(info.size).padStart(5)
          : String(info.size).padStart(6);
        const date = lsDate(new Date(info.mtime || Date.now()));
        const colored = colorName(info.name, info.isDir);
        const suffix = classify
          ? info.isDir
            ? "/"
            : ""
          : info.isDir
            ? "/"
            : "";
        const inode = showInode
          ? `${String(Math.abs(hashCode(d + "/" + info.name))).padStart(7)} `
          : "";
        out = append(out, `${inode}${mode} 1 user user ${sizeStr} ${date} ${colored}${suffix}\n`);
      }
    } else if (onePerLine) {
      for (const info of infos) {
        const inode = showInode
          ? `${String(Math.abs(hashCode(d + "/" + info.name))).padStart(7)} `
          : "";
        const suffix = classify ? (info.isDir ? "/" : "") : "";
        out = append(out, `${inode}${colorName(info.name, info.isDir)}${suffix}\n`);
      }
    } else {
      const colored = infos.map((info) => {
        const suffix = classify ? (info.isDir ? "/" : "") : "";
        return colorName(info.name, info.isDir) + suffix;
      });
      if (colored.length > 0) out = append(out, colored.join("  ") + "\n");
    }

    if (recursive) {
      for (const info of infos) {
        if (info.name === "." || info.name === "..") continue;
        if (info.isDir) {
          const full = d === "/" ? `/${info.name}` : `${d}/${info.name}`;
          out = append(out, "\n" + await lsDir(full, full));
        }
      }
    }

    return out;
  };

  try {
    const st = ctx.volume.statSync(dir);
    if (st.isFile() && !dirOnly) {
      if (longForm) {
        const size = st.size;
        const sizeStr = humanReadable
          ? humanSize(size).padStart(5)
          : String(size).padStart(6);
        const date = lsDate(new Date(st.mtimeMs || Date.now()));
        return ok(
          `${DIM}-rw-r--r--${RESET} 1 user user ${sizeStr} ${date} ${positional[0]}\n`,
        );
      }
      return ok(positional[0] + "\n");
    }
  } catch {
    return fail(
      `ls: cannot access '${positional[0] || dir}': No such file or directory\n`,
    );
  }

  try {
    return ok(await lsDir(dir, positional.length > 1 ? dir : ""));
  } catch (error) {
    return fail(`ls: ${error instanceof Error ? error.message : String(error)}\n`, ctx.signal?.aborted ? 130 : 1);
  }
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
