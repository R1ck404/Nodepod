import type { BuiltinFn } from "../shell-types.js";
import { ok, fail } from "../shell-helpers.js";
import { setArray } from "../bash-expansion.js";

function parseAssignments(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg.slice(0, eq))) {
      values[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
  }
  return values;
}

// Splits a line on IFS like bash's `read`: IFS whitespace is trimmed and
// runs of it separate fields; each other IFS character ends one field. The
// last name takes the rest of the line.
export function splitForRead(line: string, ifs: string, count: number): string[] {
  const white = [...ifs].filter((ch) => ch === " " || ch === "\t" || ch === "\n").join("");
  const isWhite = (ch: string) => white.includes(ch);
  const isDelim = (ch: string) => ifs.includes(ch);
  let i = 0;
  while (i < line.length && isWhite(line[i])) i++;
  const fields: string[] = [];
  while (i < line.length && fields.length < count - 1) {
    let field = "";
    while (i < line.length && !isDelim(line[i])) field += line[i++];
    fields.push(field);
    while (i < line.length && isWhite(line[i])) i++;
    if (i < line.length && isDelim(line[i])) {
      i++;
      while (i < line.length && isWhite(line[i])) i++;
    }
  }
  let rest = line.slice(i);
  let end = rest.length;
  while (end > 0 && isWhite(rest[end - 1])) end--;
  rest = rest.slice(0, end);
  // a single trailing non-whitespace delimiter is dropped (`a,b,` -> `a,b`)
  if (fields.length === count - 1 && rest.length > 0 && isDelim(rest[rest.length - 1]) && !isWhite(rest[rest.length - 1])) {
    const body = rest.slice(0, -1);
    if (![...body].some(isDelim)) rest = body;
  }
  if (count === 1 || i < line.length || rest) fields.push(rest);
  return fields;
}

const readCmd: BuiltinFn = (args, ctx, stdin) => {
  let raw = false;
  let delimiter = "\n";
  let arrayName: string | undefined;
  let maxChars: number | undefined;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (names.length === 0 && arg.startsWith("-") && arg.length > 1 && arg !== "--") {
      for (let j = 1; j < arg.length; j++) {
        const flag = arg[j];
        if (flag === "r") raw = true;
        else if (flag === "s" || flag === "e") continue;
        else if ("pdantuNi".includes(flag)) {
          const value = arg.slice(j + 1) || args[++i] || "";
          if (flag === "d") delimiter = value[0] ?? "\0";
          if (flag === "a") arrayName = value;
          if (flag === "n" || flag === "N") maxChars = parseInt(value, 10);
          break;
        } else {
          return fail(`read: -${flag}: invalid option\n`);
        }
      }
      continue;
    }
    if (arg === "--" && names.length === 0) continue;
    names.push(arg);
  }
  if (stdin === undefined) return fail("read: stdin is not available\n");
  const input = stdin.replace(/\r/g, "");
  let end = delimiter === "\0" ? input.indexOf("\0") : input.indexOf(delimiter);
  const found = end >= 0;
  if (!found) end = input.length;
  let line = input.slice(0, end);
  if (maxChars !== undefined && maxChars >= 0) line = line.slice(0, maxChars);
  if (!raw) {
    line = line.replace(/\\\n/g, "").replace(/\\(.)/g, "$1").replace(/\\$/, "");
  }
  const ifs = ctx.env.IFS ?? " \t\n";
  if (arrayName) {
    const values = line === "" ? [] : splitForRead(line, ifs, Number.MAX_SAFE_INTEGER);
    setArray(ctx.env, arrayName, values);
  } else {
    const variables = names.length ? names : ["REPLY"];
    const fields = names.length ? splitForRead(line, ifs, variables.length) : [line];
    for (let i = 0; i < variables.length; i++) ctx.env[variables[i]] = fields[i] ?? "";
  }
  // like bash, read fails at end of input (no delimiter left), which ends
  // `while read` loops; a last line without a newline is still assigned
  return found || (maxChars !== undefined && line.length >= maxChars) ? ok() : { stdout: "", stderr: "", exitCode: 1 };
};

const mapfileCmd: BuiltinFn = (args, ctx, stdin) => {
  let trim = false;
  let name = "MAPFILE";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-t") trim = true;
    else if (/^-[dnOsuCc]$/.test(args[i])) i++;
    else if (!args[i].startsWith("-")) name = args[i];
  }
  const lines = (stdin ?? "").replace(/\r/g, "").split(/(?<=\n)/);
  if (lines.at(-1) === "") lines.pop();
  setArray(ctx.env, name, trim ? lines.map((line) => line.replace(/\n$/, "")) : lines);
  return ok();
};

const declareCmd: BuiltinFn = (args, ctx) => {
  const values = parseAssignments(args);
  Object.assign(ctx.env, values);
  if (args.length === 0 || args.includes("-p")) {
    let out = "";
    for (const [key, value] of Object.entries(ctx.env)) out += `declare -- ${key}=${JSON.stringify(value)}\n`;
    return ok(out);
  }
  return ok();
};

const readonlyCmd: BuiltinFn = (args, ctx) => {
  const values = parseAssignments(args);
  Object.assign(ctx.env, values);
  return ok();
};

const getoptsCmd: BuiltinFn = (args, ctx) => {
  const variable = args[1] || "OPTARG";
  ctx.env["OPTIND"] = String(parseInt(ctx.env["OPTIND"] || "1", 10));
  ctx.env[variable] = "?";
  return { stdout: "", stderr: "", exitCode: 1 };
};

const helpCmd: BuiltinFn = () => ok(
  "Nodepod Bash builtins: : . alias bg bind break builtin caller case cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait\n",
);

const hashCmd: BuiltinFn = () => ok();
const enableCmd: BuiltinFn = () => ok();
const bindCmd: BuiltinFn = () => ok();
const trapCmd: BuiltinFn = () => ok();
const ulimitCmd: BuiltinFn = () => ok("unlimited\n");
const timesCmd: BuiltinFn = () => ok("0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n");
const umaskCmd: BuiltinFn = (args, ctx) => {
  if (args[0] && /^\d+$/.test(args[0])) ctx.env.UMASK = args[0];
  return ok(`${ctx.env.UMASK || "0022"}\n`);
};

export const bashBuiltinCommands: [string, BuiltinFn][] = [
  ["read", readCmd],
  ["mapfile", mapfileCmd],
  ["readarray", mapfileCmd],
  ["declare", declareCmd],
  ["typeset", declareCmd],
  ["readonly", readonlyCmd],
  ["local", declareCmd],
  ["getopts", getoptsCmd],
  ["help", helpCmd],
  ["hash", hashCmd],
  ["enable", enableCmd],
  ["bind", bindCmd],
  ["trap", trapCmd],
  ["ulimit", ulimitCmd],
  ["times", timesCmd],
  ["umask", umaskCmd],
  ["compgen", () => ok()],
  ["complete", () => ok()],
  ["compopt", () => ok()],
  ["caller", () => ok()],
  ["disown", () => ok()],
  ["suspend", () => ok()],
  ["fc", () => ok()],
  ["logout", () => ok()],
  ["unalias", () => ok()],
  ["break", () => ok()],
  ["continue", () => ok()],
  ["return", () => ok()],
  ["shift", () => ok()],
  ["let", () => ok()],
  ["command", () => ok()],
  ["builtin", () => ok()],
  ["eval", () => ok()],
  ["exec", () => ok()],
  ["pushd", () => ok()],
  ["popd", () => ok()],
  ["dirs", () => ok()],
  ["jobs", () => ok()],
  ["fg", () => ok()],
  ["bg", () => ok()],
  ["wait", () => ok()],
  ["kill", () => ok()],
];
