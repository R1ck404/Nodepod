import type { BuiltinFn } from "../shell-types.js";
import { ok, fail } from "../shell-helpers.js";

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

const readCmd: BuiltinFn = (args, ctx, stdin) => {
  if (stdin === undefined) return fail("read: stdin is not available\n");
  const names = args.filter((arg) => !arg.startsWith("-") && arg !== "--");
  const variables = names.length ? names : ["REPLY"];
  const lines = stdin.replace(/\r/g, "").split("\n");
  const line = lines[0] ?? "";
  const fields = line.split(/\s+/);
  for (let i = 0; i < variables.length; i++) {
    ctx.env[variables[i]] = i === variables.length - 1
      ? fields.slice(i).join(" ")
      : fields[i] ?? "";
  }
  // like bash, read fails at end of input (no newline left), which ends
  // `while read` loops; a last line without a newline is still assigned
  return stdin.includes("\n") ? ok() : { stdout: "", stderr: "", exitCode: 1 };
};

const mapfileCmd: BuiltinFn = (args, ctx, stdin) => {
  const name = args.find((arg) => !arg.startsWith("-")) ?? "MAPFILE";
  const lines = (stdin ?? "").replace(/\r/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  ctx.env[name] = lines.join("\n");
  ctx.env[`${name}[@]`] = lines.join("\n");
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
