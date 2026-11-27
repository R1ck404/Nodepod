import type { BuiltinFn, ShellContext } from "../shell-types.js";
import {
  ok,
  fail,
  EXIT_FAIL,
  resolvePath,
  parseArgs,
  pathModule,
  MONTHS_SHORT,
  MONTHS_LONG,
  DAYS_SHORT,
  DAYS_LONG,
  waitForShellDelay,
} from "../shell-helpers.js";

// set by the registry so `which` and `type` can check builtins
let _builtins: Map<string, BuiltinFn> | null = null;

export function setBuiltinsRef(b: Map<string, BuiltinFn>): void {
  _builtins = b;
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

const exportCmd: BuiltinFn = (args, ctx) => {
  if (args.length === 0) {
    let out = "";
    for (const [k, v] of Object.entries(ctx.env)) {
      out += `declare -x ${k}="${v}"\n`;
    }
    return ok(out);
  }
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq > 0) {
      ctx.env[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }
  return ok();
};

const unset: BuiltinFn = (args, ctx) => {
  for (const name of args) delete ctx.env[name];
  return ok();
};

const envCmd: BuiltinFn = (_args, ctx) => {
  let out = "";
  for (const [k, v] of Object.entries(ctx.env)) out += `${k}=${v}\n`;
  return ok(out);
};

const which: BuiltinFn = (args, ctx) => {
  if (args.length === 0) return fail("which: missing argument\n");

  const { flags } = parseArgs(args, ["a"]);
  const showAll = flags.has("a");
  const names = args.filter((a) => !a.startsWith("-"));

  let out = "";
  for (const name of names) {
    const found: string[] = [];

    if (_builtins?.has(name)) found.push(`${name}: shell built-in command`);

    const knownBins: Record<string, string> = {
      node: "/usr/local/bin/node",
      npm: "/usr/local/bin/npm",
      npx: "/usr/local/bin/npx",
      pnpm: "/usr/local/bin/pnpm",
      yarn: "/usr/local/bin/yarn",
      bun: "/usr/local/bin/bun",
      bunx: "/usr/local/bin/bunx",
    };
    if (knownBins[name]) found.push(knownBins[name]);

    const binPath = `/node_modules/.bin/${name}`;
    if (ctx.volume.existsSync(binPath)) found.push(binPath);

    const pathDirs = (ctx.env.PATH || "").split(":").filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = `${dir}/${name}`;
      if (ctx.volume.existsSync(candidate)) {
        if (!found.includes(candidate)) found.push(candidate);
      }
    }

    if (found.length === 0) {
      out += `${name} not found\n`;
    } else if (showAll) {
      for (const f of found) out += f + "\n";
    } else {
      out += found[0] + "\n";
    }
  }
  return out.includes("not found")
    ? { stdout: out, stderr: "", exitCode: 1 }
    : ok(out);
};

const typeCmd: BuiltinFn = (args, ctx) => {
  if (args.length === 0) return fail("type: missing argument\n");
  const name = args[0];
  if (_builtins?.has(name)) return ok(`${name} is a shell builtin\n`);

  const w = which([name], ctx);
  if (typeof w === "object" && "exitCode" in w && w.exitCode === 0) {
    return ok(`${name} is ${w.stdout.trim()}\n`);
  }
  return fail(`type: ${name}: not found\n`);
};

const trueCmd: BuiltinFn = () => ok();
const falseCmd: BuiltinFn = () => EXIT_FAIL;

const exitCmd: BuiltinFn = (args) => {
  const code = args[0] ? parseInt(args[0], 10) : 0;
  return { stdout: "", stderr: "", exitCode: code };
};

const clear: BuiltinFn = () => ok("\x1b[H\x1b[2J\x1b[3J");

/* ------------------------------------------------------------------ */
/*  test / [                                                           */
/* ------------------------------------------------------------------ */

function evalTest(args: string[], ctx: ShellContext): boolean {
  if (args.length === 0) return false;

  if (args[0] === "!") return !evalTest(args.slice(1), ctx);

  if (args[0] === "(" && args[args.length - 1] === ")") {
    return evalTest(args.slice(1, -1), ctx);
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o") {
      return (
        evalTest(args.slice(0, i), ctx) || evalTest(args.slice(i + 1), ctx)
      );
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-a") {
      return (
        evalTest(args.slice(0, i), ctx) && evalTest(args.slice(i + 1), ctx)
      );
    }
  }

  if (args.length === 1) return args[0].length > 0;

  if (args.length === 2) {
    const [flag, val] = args;
    const p = resolvePath(val, ctx.cwd);

    if (flag === "-f") {
      try { return ctx.volume.statSync(p).isFile(); } catch { return false; }
    }
    if (flag === "-d") {
      try { return ctx.volume.statSync(p).isDirectory(); } catch { return false; }
    }
    if (flag === "-e") return ctx.volume.existsSync(p);
    if (flag === "-c" || flag === "-b" || flag === "-p" || flag === "-S") {
      try {
        const st = ctx.volume.statSync(p);
        if (flag === "-c") return st.isCharacterDevice();
        if (flag === "-b") return st.isBlockDevice();
        return flag === "-p" ? st.isFIFO() : st.isSocket();
      } catch { return false; }
    }
    if (flag === "-L" || flag === "-h") {
      try {
        return ctx.volume.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    }
    if (flag === "-s") {
      try { return ctx.volume.readFileSync(p).length > 0; } catch { return false; }
    }
    if (flag === "-r" || flag === "-w" || flag === "-x") {
      try {
        ctx.volume.accessSync(p, flag === "-r" ? 4 : flag === "-w" ? 2 : 1);
        return true;
      } catch {
        return false;
      }
    }
    if (flag === "-n") return val.length > 0;
    if (flag === "-z") return val.length === 0;
    if (flag === "-t") return false;
  }

  if (args.length === 3) {
    const [left, op, right] = args;
    if (op === "=" || op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (op === "-eq") return parseInt(left) === parseInt(right);
    if (op === "-ne") return parseInt(left) !== parseInt(right);
    if (op === "-lt") return parseInt(left) < parseInt(right);
    if (op === "-le") return parseInt(left) <= parseInt(right);
    if (op === "-gt") return parseInt(left) > parseInt(right);
    if (op === "-ge") return parseInt(left) >= parseInt(right);

    if (op === "-nt" || op === "-ot" || op === "-ef") {
      try {
        const sl = ctx.volume.statSync(resolvePath(left, ctx.cwd));
        const sr = ctx.volume.statSync(resolvePath(right, ctx.cwd));
        if (op === "-nt") return (sl.mtimeMs || 0) > (sr.mtimeMs || 0);
        if (op === "-ot") return (sl.mtimeMs || 0) < (sr.mtimeMs || 0);
        if (op === "-ef")
          return resolvePath(left, ctx.cwd) === resolvePath(right, ctx.cwd);
      } catch {
        return false;
      }
    }
  }

  return false;
}

const test_cmd: BuiltinFn = (args, ctx) => {
  const testArgs = [...args];
  if (testArgs[testArgs.length - 1] === "]") testArgs.pop();
  return { stdout: "", stderr: "", exitCode: evalTest(testArgs, ctx) ? 0 : 1 };
};

/* ------------------------------------------------------------------ */
/*  date                                                               */
/* ------------------------------------------------------------------ */

function getTimezoneAbbr(d: Date): string {
  const str = d.toTimeString();
  const m = str.match(/\((.+?)\)/);
  if (m) {
    const words = m[1].split(" ");
    if (words.length === 1) return words[0];
    return words.map((w) => w[0]).join("");
  }
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const min = String(Math.abs(off) % 60).padStart(2, "0");
  return `${sign}${h}${min}`;
}

function formatDate(d: Date, fmt: string, utc: boolean): string {
  const g = utc
    ? {
        Y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
        H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(),
        w: d.getUTCDay(),
      }
    : {
        Y: d.getFullYear(), m: d.getMonth(), d: d.getDate(),
        H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(),
        w: d.getDay(),
      };
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === "%" && i + 1 < fmt.length) {
      const s = fmt[++i];
      if (s === "Y") out += g.Y;
      else if (s === "y") out += String(g.Y).slice(-2);
      else if (s === "m") out += String(g.m + 1).padStart(2, "0");
      else if (s === "d") out += String(g.d).padStart(2, "0");
      else if (s === "e") out += String(g.d).padStart(2, " ");
      else if (s === "H") out += String(g.H).padStart(2, "0");
      else if (s === "M") out += String(g.M).padStart(2, "0");
      else if (s === "S") out += String(g.S).padStart(2, "0");
      else if (s === "I") out += String(g.H % 12 || 12).padStart(2, "0");
      else if (s === "p") out += g.H < 12 ? "AM" : "PM";
      else if (s === "P") out += g.H < 12 ? "am" : "pm";
      else if (s === "a") out += DAYS_SHORT[g.w];
      else if (s === "A") out += DAYS_LONG[g.w];
      else if (s === "b" || s === "h") out += MONTHS_SHORT[g.m];
      else if (s === "B") out += MONTHS_LONG[g.m];
      else if (s === "w") out += g.w;
      else if (s === "u") out += g.w === 0 ? 7 : g.w;
      else if (s === "j") {
        const jan1 = new Date(g.Y, 0, 1);
        const diff = d.getTime() - jan1.getTime();
        out += String(Math.floor(diff / 86400000) + 1).padStart(3, "0");
      } else if (s === "s") out += Math.floor(d.getTime() / 1000);
      else if (s === "N") out += String(d.getMilliseconds() * 1000000).padStart(9, "0");
      else if (s === "n") out += "\n";
      else if (s === "t") out += "\t";
      else if (s === "T")
        out += `${String(g.H).padStart(2, "0")}:${String(g.M).padStart(2, "0")}:${String(g.S).padStart(2, "0")}`;
      else if (s === "R")
        out += `${String(g.H).padStart(2, "0")}:${String(g.M).padStart(2, "0")}`;
      else if (s === "F")
        out += `${g.Y}-${String(g.m + 1).padStart(2, "0")}-${String(g.d).padStart(2, "0")}`;
      else if (s === "D")
        out += `${String(g.m + 1).padStart(2, "0")}/${String(g.d).padStart(2, "0")}/${String(g.Y).slice(-2)}`;
      else if (s === "Z") out += utc ? "UTC" : getTimezoneAbbr(d);
      else if (s === "%") out += "%";
      else out += "%" + s;
    } else {
      out += fmt[i];
    }
  }
  return out;
}

const date_cmd: BuiltinFn = (args) => {
  const { flags, opts, positional } = parseArgs(args, ["u", "R", "I"], ["d"]);
  const utc = flags.has("u");
  const rfc = flags.has("R");
  const iso = flags.has("I");
  const dateStr = opts["d"];

  const d = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(d.getTime())) return fail(`date: invalid date '${dateStr}'\n`);

  const fmt = positional.find((a) => a.startsWith("+"));
  if (fmt) return ok(formatDate(d, fmt.slice(1), utc) + "\n");
  if (rfc) return ok(d.toUTCString() + "\n");
  if (iso) return ok(d.toISOString().slice(0, 10) + "\n");

  const day = DAYS_SHORT[utc ? d.getUTCDay() : d.getDay()];
  const mon = MONTHS_SHORT[utc ? d.getUTCMonth() : d.getMonth()];
  const date = utc ? d.getUTCDate() : d.getDate();
  const hh = String(utc ? d.getUTCHours() : d.getHours()).padStart(2, "0");
  const mm = String(utc ? d.getUTCMinutes() : d.getMinutes()).padStart(2, "0");
  const ss = String(utc ? d.getUTCSeconds() : d.getSeconds()).padStart(2, "0");
  const year = utc ? d.getUTCFullYear() : d.getFullYear();
  const tz = utc ? "UTC" : getTimezoneAbbr(d);

  return ok(
    `${day} ${mon} ${String(date).padStart(2, " ")} ${hh}:${mm}:${ss} ${tz} ${year}\n`,
  );
};

/* ------------------------------------------------------------------ */
/*  sleep                                                              */
/* ------------------------------------------------------------------ */

const sleep_cmd: BuiltinFn = async (args, ctx) => {
  const seconds = parseFloat(args[0] || "0");
  if (!Number.isFinite(seconds) || seconds < 0) {
    return fail(`sleep: invalid time interval '${args[0] ?? ""}'\n`);
  }
  if (seconds > 0) {
    const signal = ctx.signal;
    const completed = await waitForShellDelay(seconds * 1000, signal);
    if (!completed) return { stdout: "", stderr: "", exitCode: 130 };
  }
  return ok();
};

/* ------------------------------------------------------------------ */
/*  Registry                                                           */
/* ------------------------------------------------------------------ */

export const shellEnvCommands: [string, BuiltinFn][] = [
  ["export", exportCmd],
  ["unset", unset],
  ["env", envCmd],
  ["which", which],
  ["type", typeCmd],
  ["true", trueCmd],
  ["false", falseCmd],
  [":", trueCmd],
  ["exit", exitCmd],
  ["clear", clear],
  ["test", test_cmd],
  ["[", test_cmd],
  ["date", date_cmd],
  ["sleep", sleep_cmd],
];
