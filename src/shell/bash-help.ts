// bash 5's builtins with the synopsis and summary `help` prints for each,
// and its reserved words, for help, type and command -v.

export const BASH_BUILTIN_HELP: Record<string, [synopsis: string, summary: string]> = {
  ":": [":", "Null command."],
  ".": [". filename [arguments]", "Execute commands from a file in the current shell."],
  "[": ["[ arg... ]", "Evaluate conditional expression."],
  alias: ["alias [-p] [name[=value] ... ]", "Define or display aliases."],
  bg: ["bg [job_spec ...]", "Move jobs to the background."],
  bind: ["bind [-lpsvPSVX] [-m keymap] [-f filename] [-q name] [-u name] [-r keyseq] [-x keyseq:shell-command] [keyseq:readline-function or readline-command]", "Set Readline key bindings and variables."],
  break: ["break [n]", "Exit for, while, or until loops."],
  builtin: ["builtin [shell-builtin [arg ...]]", "Execute shell builtins."],
  caller: ["caller [expr]", "Return the context of the current subroutine call."],
  cd: ["cd [-L|[-P [-e]] [-@]] [dir]", "Change the shell working directory."],
  command: ["command [-pVv] command [arg ...]", "Execute a simple command or display information about commands."],
  compgen: ["compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]", "Display possible completions depending on the options."],
  complete: ["complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]", "Specify how arguments are to be completed by Readline."],
  continue: ["continue [n]", "Resume for, while, or until loops."],
  declare: ["declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]", "Set variable values and attributes."],
  dirs: ["dirs [-clpv] [+N] [-N]", "Display directory stack."],
  disown: ["disown [-h] [-ar] [jobspec ... | pid ...]", "Remove jobs from current shell."],
  echo: ["echo [-neE] [arg ...]", "Write arguments to the standard output."],
  enable: ["enable [-a] [-dnps] [-f filename] [name ...]", "Enable and disable shell builtins."],
  eval: ["eval [arg ...]", "Execute arguments as a shell command."],
  exec: ["exec [-cl] [-a name] [command [argument ...]] [redirection ...]", "Replace the shell with the given command."],
  exit: ["exit [n]", "Exit the shell."],
  export: ["export [-fn] [name[=value] ...] or export -p", "Set export attribute for shell variables."],
  false: ["false", "Return an unsuccessful result."],
  fc: ["fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]", "Display or execute commands from the history list."],
  fg: ["fg [job_spec]", "Move job to the foreground."],
  getopts: ["getopts optstring name [arg ...]", "Parse option arguments."],
  hash: ["hash [-lr] [-p pathname] [-dt] [name ...]", "Remember or display program locations."],
  help: ["help [-dms] [pattern ...]", "Display information about builtin commands."],
  history: ["history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]", "Display or manipulate the history list."],
  jobs: ["jobs [-lnprs] [jobspec ...] or jobs -x command [args]", "Display status of jobs."],
  kill: ["kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]", "Send a signal to a job."],
  let: ["let arg [arg ...]", "Evaluate arithmetic expressions."],
  local: ["local [option] name[=value] ...", "Define local variables."],
  logout: ["logout [n]", "Exit a login shell."],
  mapfile: ["mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]", "Read lines from the standard input into an indexed array variable."],
  popd: ["popd [-n] [+N | -N]", "Remove directories from stack."],
  printf: ["printf [-v var] format [arguments]", "Formats and prints ARGUMENTS under control of the FORMAT."],
  pushd: ["pushd [-n] [+N | -N | dir]", "Add directories to stack."],
  pwd: ["pwd [-LP]", "Print the name of the current working directory."],
  read: ["read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]", "Read a line from the standard input and split it into fields."],
  readarray: ["readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]", "Read lines from a file into an array variable."],
  readonly: ["readonly [-aAf] [name[=value] ...] or readonly -p", "Mark shell variables as unchangeable."],
  return: ["return [n]", "Return from a shell function."],
  set: ["set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]", "Set or unset values of shell options and positional parameters."],
  shift: ["shift [n]", "Shift positional parameters."],
  shopt: ["shopt [-pqsu] [-o] [optname ...]", "Set and unset shell options."],
  source: ["source filename [arguments]", "Execute commands from a file in the current shell."],
  suspend: ["suspend [-f]", "Suspend shell execution."],
  test: ["test [expr]", "Evaluate conditional expression."],
  times: ["times", "Display process times."],
  trap: ["trap [-lp] [[arg] signal_spec ...]", "Trap signals and other events."],
  true: ["true", "Return a successful result."],
  type: ["type [-afptP] name [name ...]", "Display information about command type."],
  typeset: ["typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]", "Set variable values and attributes."],
  ulimit: ["ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]", "Modify shell resource limits."],
  umask: ["umask [-p] [-S] [mode]", "Display or set file mode mask."],
  unalias: ["unalias [-a] name [name ...]", "Remove each NAME from the list of defined aliases."],
  unset: ["unset [-f] [-v] [-n] [name ...]", "Unset values and attributes of shell variables and functions."],
  wait: ["wait [-fn] [-p var] [id ...]", "Wait for job completion and return exit status."],
};

export const BASH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until",
  "do", "done", "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
]);

function globToRegExp(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}`);
}

// `help [-dms] [pattern ...]`
export function helpText(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  let mode: "full" | "d" | "s" | "m" = "full";
  const patterns: string[] = [];
  for (const arg of args) {
    if (/^-[dms]+$/.test(arg)) mode = arg.includes("s") ? "s" : arg.includes("d") ? "d" : "m";
    else if (arg !== "--") patterns.push(arg);
  }
  if (!patterns.length) {
    const lines = Object.entries(BASH_BUILTIN_HELP).map(([, [synopsis]]) => ` ${synopsis}`);
    return {
      stdout: "GNU bash, version 5.2.0(1)-release\nThese shell commands are defined internally.  Type `help' to see this list.\nType `help name' to find out more about the function `name'.\n\n" + lines.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }
  let stdout = "";
  let stderr = "";
  for (const pattern of patterns) {
    const re = globToRegExp(pattern);
    const names = Object.keys(BASH_BUILTIN_HELP).filter((name) => name === pattern || re.test(name));
    if (!names.length) {
      stderr += `bash: help: no help topics match \`${pattern}'.  Try \`help help' or \`man -k ${pattern}' or \`info ${pattern}'.\n`;
      continue;
    }
    for (const name of names) {
      const [synopsis, summary] = BASH_BUILTIN_HELP[name];
      if (mode === "s") stdout += `${name}: ${synopsis}\n`;
      else if (mode === "d") stdout += `${name} - ${summary}\n`;
      else if (mode === "m") stdout += `NAME\n    ${name} - ${summary}\n\nSYNOPSIS\n    ${synopsis}\n\n`;
      else stdout += `${name}: ${synopsis}\n    ${summary}\n`;
    }
  }
  return { stdout, stderr, exitCode: stderr && !stdout ? 1 : 0 };
}
