// POSIX regular expressions (as grep, sed and find use them) translated to
// JavaScript's syntax.
//
// Basic (BRE, the default): `\(` `\)` `\{` `\}` `\|` `\+` `\?` are the
// operators and the bare characters are literal; `*` is literal at the start
// of an expression or group; `^` and `$` anchor only at the ends.
// Extended (ERE, -E): the bare characters are the operators.
// Both: bracket expressions with POSIX classes (`[[:digit:]]`), where a
// backslash is literal and `]` first is a member; GNU's `\<` `\>` `\w` `\s`
// `\b` and back-references `\1`–`\9`.

const CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
};

const SPECIAL_IN_JS = /[.*+?^${}()|[\]\\/]/;

function literal(ch: string): string {
  return SPECIAL_IN_JS.test(ch) ? "\\" + ch : ch;
}

// Translates the bracket expression starting at `start` (the `[`); returns
// the JavaScript class and the index after the closing `]`.
function bracket(pattern: string, start: number): { text: string; end: number } {
  let i = start + 1;
  let out = "[";
  if (pattern[i] === "^") { out += "^"; i++; }
  let first = true;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "]" && !first) return { text: out + "]", end: i + 1 };
    first = false;
    if (ch === "[" && (pattern[i + 1] === ":" || pattern[i + 1] === "=" || pattern[i + 1] === ".")) {
      const kind = pattern[i + 1];
      const close = pattern.indexOf(kind + "]", i + 2);
      if (close > 0) {
        const name = pattern.slice(i + 2, close);
        if (kind === ":") {
          const members = CLASSES[name];
          if (members === undefined) throw new Error(`invalid character class '${name}'`);
          out += members;
        } else {
          for (const c of name) out += literal(c);
        }
        i = close + 2;
        continue;
      }
    }
    // a backslash is literal in a POSIX bracket expression
    if (ch === "\\" || ch === "]" || ch === "[" || ch === "^") out += "\\" + ch;
    else out += ch;
    i++;
  }
  throw new Error("Unmatched [, [^, [:, [., or [=");
}

export function posixToJs(pattern: string, extended: boolean): string {
  let out = "";
  // where `*` is literal and `^` is an anchor in a BRE: the start of the
  // expression, of a group or of an alternative
  let atStart = true;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    const wasStart = atStart;
    atStart = false;
    if (ch === "[") {
      const { text, end } = bracket(pattern, i);
      out += text;
      i = end - 1;
      continue;
    }
    if (ch === "\\") {
      const next = pattern[++i];
      if (next === undefined) throw new Error("trailing backslash (\\)");
      if (!extended && "(){}|+?".includes(next)) {
        out += next;
        if (next === "(" || next === "|") atStart = true;
        continue;
      }
      if (next === "<" || next === ">") { out += "\\b"; continue; }
      if (next === "`") { out += "^"; continue; }
      if (next === "'") { out += "$"; continue; }
      if (/[1-9wWsSbBnt]/.test(next)) { out += "\\" + next; continue; }
      out += literal(next);
      continue;
    }
    if (extended) {
      if (ch === "{" && !/^\{\d+(,\d*)?\}/.test(pattern.slice(i))) { out += "\\{"; continue; }
      if (ch === "(" || ch === "|") atStart = true;
      if (ch === "*" && wasStart) { out += "\\*"; continue; }
      out += ch === "/" ? "\\/" : ch;
      continue;
    }
    if (ch === "*") { out += wasStart ? "\\*" : "*"; continue; }
    if (ch === ".") { out += "."; continue; }
    if (ch === "^") {
      if (wasStart) { out += "^"; atStart = true; continue; }
      out += "\\^";
      continue;
    }
    if (ch === "$") {
      const rest = pattern.slice(i + 1);
      out += rest === "" || rest.startsWith("\\)") || rest.startsWith("\\|") ? "$" : "\\$";
      continue;
    }
    out += literal(ch);
  }
  return out;
}
