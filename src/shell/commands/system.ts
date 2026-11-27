import type { BuiltinFn } from "../shell-types.js";
import { fail, ok, resolvePath, scheduleLongTimeout, yieldToEventLoop } from "../shell-helpers.js";
import { stat_cmd, od_cmd } from "./stat-od.js";

function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseTimeoutDuration(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }[(match[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h" | "d"];
  const milliseconds = amount * multiplier;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

const whoami: BuiltinFn = (_args, ctx) => ok(`${ctx.env.USER || ctx.env.LOGNAME || "user"}\n`);

const id: BuiltinFn = (_args, ctx) => {
  const user = ctx.env.USER || ctx.env.LOGNAME || "user";
  return ok(`uid=1000(${user}) gid=1000(${user}) groups=1000(${user})\n`);
};

const uname: BuiltinFn = (args) => {
  const fields: Record<string, string> = {
    s: "Nodepod",
    n: "nodepod",
    r: "virtual",
    v: "Nodepod virtual kernel",
    m: "browser",
  };
  if (args.includes("-a")) return ok(Object.values(fields).join(" ") + "\n");
  const flag = args.find((arg) => /^-[snrvm]$/.test(arg))?.slice(1) ?? "s";
  return ok(`${fields[flag] ?? fields.s}\n`);
};

const hostname: BuiltinFn = (_args, ctx) => ok(`${ctx.env.HOSTNAME || "nodepod"}\n`);


const duCmd: BuiltinFn = async (args, ctx) => {
  const human = args.includes("-h") || args.includes("--human-readable");
  const targets = args.filter((arg) => !arg.startsWith("-"));
  const root = resolvePath(targets[0] ?? ".", ctx.cwd);
  let entries = 0;
  const sizeOf = async (path: string): Promise<number> => {
    if (ctx.signal?.aborted) throw new Error("command cancelled");
    if (++entries > (ctx.limits?.maxFilesystemEntries ?? 100000)) throw new Error("filesystem entry limit exceeded");
    if ((entries & 127) === 0) await yieldToEventLoop(ctx.signal);
    const stat = ctx.volume.lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const name of ctx.volume.readdirSync(path)) {
      total += await sizeOf(path === "/" ? `/${name}` : `${path}/${name}`);
    }
    return total;
  };
  try {
    const bytes = await sizeOf(root);
    const shown = human ? `${(bytes / 1024).toFixed(bytes < 1024 ? 1 : 0)}K` : String(Math.ceil(bytes / 1024));
    return ok(`${shown}\t${targets[0] ?? "."}\n`);
  } catch (error) {
    return fail(`du: ${(error as Error).message}\n`);
  }
};

const mktempCmd: BuiltinFn = (args, ctx) => {
  const directory = args.includes("-d");
  const template = args.find((arg) => !arg.startsWith("-")) ?? "/tmp/tmp.XXXXXX";
  const raw = template.includes("/") ? template : `${ctx.env.TMPDIR || "/tmp"}/${template}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = Math.floor(Math.random() * 0xffffff).toString(36).padStart(6, "0").slice(-6);
    const path = raw.replace(/X{3,}/, suffix);
    if (ctx.volume.existsSync(resolvePath(path, ctx.cwd))) continue;
    try {
      const resolved = resolvePath(path, ctx.cwd);
      if (directory) ctx.volume.mkdirSync(resolved, { recursive: false, mode: 0o700 });
      else ctx.volume.writeFileSync(resolved, "");
      return ok(path + "\n");
    } catch {
      /* retry another name */
    }
  }
  return fail("mktemp: failed to create unique temporary name\n");
};

const foldCmd: BuiltinFn = (args, ctx, stdin) => {
  const widthIndex = args.indexOf("-w");
  const requestedWidth = Number(widthIndex >= 0 ? args[widthIndex + 1] : 80);
  const operationLimit = ctx.limits?.maxLoopIterations ?? 100_000;
  if (!Number.isSafeInteger(requestedWidth) || requestedWidth <= 0 || requestedWidth > operationLimit) {
    return fail(`fold: invalid width '${args[widthIndex + 1] ?? ""}'\n`);
  }
  const width = requestedWidth;
  const input = stdin ?? "";
  if (input.length > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) return fail("fold: input limit exceeded\n");
  return ok(input.split("\n").map((line) => line.match(new RegExp(`.{1,${width}}`, "g"))?.join("\n") ?? "").join("\n"));
};

const base64Cmd: BuiltinFn = (args, ctx, stdin) => {
  const decode = args.includes("-d") || args.includes("--decode");
  const source = stdin ?? (args.find((arg) => !arg.startsWith("-")) ? ctx.volume.readFileSync(resolvePath(args.find((arg) => !arg.startsWith("-"))!, ctx.cwd), "utf8") : "");
  try {
    if (decode) {
      const estimatedBytes = Math.ceil(source.replace(/\s+/g, "").length * 3 / 4);
      if (estimatedBytes > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) return fail("base64: output limit exceeded\n");
      const binary = atob(source.replace(/\s+/g, ""));
      return ok(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    }
    const bytes = new TextEncoder().encode(source);
    if (Math.ceil(bytes.length / 3) * 4 + 1 > (ctx.limits?.maxOutputBytes ?? 4 * 1024 * 1024)) {
      return fail("base64: output limit exceeded\n");
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return ok(btoa(binary) + "\n");
  } catch {
    return fail("base64: invalid input\n");
  }
};


/**
 * GNU timeout-compatible virtual utility. The command runs in a cancellable
 * shell clone, so expiry interrupts cooperative commands instead of merely
 * returning early while the child keeps running in the background.
 */
const timeoutCmd: BuiltinFn = async (args, ctx) => {
  let preserveStatus = false;
  let signal = "TERM";
  let killAfter: number | null = null;
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") { index++; break; }
    if (arg === "--preserve-status") { preserveStatus = true; index++; continue; }
    if (arg === "--foreground") { index++; continue; }
    if (arg === "-s" || arg === "--signal") {
      signal = args[index + 1] ?? "TERM";
      index += 2;
      continue;
    }
    if (arg.startsWith("--signal=")) {
      signal = arg.slice("--signal=".length) || "TERM";
      index++;
      continue;
    }
    if (arg === "-k" || arg === "--kill-after") {
      const duration = parseTimeoutDuration(args[index + 1] ?? "");
      if (duration === null) return fail(`timeout: invalid time interval '${args[index + 1] ?? ""}'\n`, 125);
      killAfter = duration;
      index += 2;
      continue;
    }
    if (arg.startsWith("--kill-after=")) {
      const duration = parseTimeoutDuration(arg.slice("--kill-after=".length));
      if (duration === null) return fail(`timeout: invalid time interval '${arg.slice("--kill-after=".length)}'\n`, 125);
      killAfter = duration;
      index++;
      continue;
    }
    if (arg.startsWith("-")) return fail(`timeout: unrecognized option '${arg}'\n`, 125);
    break;
  }

  const duration = parseTimeoutDuration(args[index] ?? "");
  if (duration === null) return fail("timeout: invalid or missing duration\n", 125);
  index++;
  if (index >= args.length) return fail("timeout: missing command\n", 125);

  const command = args.slice(index).map(shellQuote).join(" ");
  const controller = new AbortController();
  let timedOut = false;
  let parentCancelled = false;
  let cancelTimer: (() => void) | undefined;
  let cancelKillTimer: (() => void) | undefined;

  const onParentAbort = () => {
    parentCancelled = true;
    controller.abort(ctx.signal?.reason);
  };
  if (ctx.signal?.aborted) onParentAbort();
  else ctx.signal?.addEventListener("abort", onParentAbort, { once: true });

  if (!parentCancelled && duration > 0) {
    cancelTimer = scheduleLongTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timeout: sending signal ${signal}`));
      if (killAfter !== null && killAfter > 0) {
        cancelKillTimer = scheduleLongTimeout(
          () => controller.abort(new Error("timeout: kill-after expired")),
          killAfter,
        );
      }
    }, duration);
  }

  try {
    const result = await ctx.exec(command, {
      cwd: ctx.cwd,
      env: ctx.env,
      signal: controller.signal,
    });
    if (!result) return fail("timeout: child command returned no result\n");
    if (parentCancelled) return { ...result, exitCode: 130 };
    if (timedOut) return { ...result, exitCode: preserveStatus ? result.exitCode : 124 };
    return result;
  } finally {
    cancelTimer?.();
    cancelKillTimer?.();
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
};

export const systemCommands: [string, BuiltinFn][] = [
  ["whoami", whoami],
  ["id", id],
  ["uname", uname],
  ["hostname", hostname],
  ["stat", stat_cmd],
  ["du", duCmd],
  ["mktemp", mktempCmd],
  ["fold", foldCmd],
  ["base64", base64Cmd],
  ["od", od_cmd],
  ["timeout", timeoutCmd],
];
