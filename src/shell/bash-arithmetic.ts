// Bash arithmetic: the expressions in `$(( ))`, `(( ))`, `for (( ;; ))`,
// `let` and array subscripts. Integers, C's operators with bash's
// precedence, assignments (`=`, `+=`, ...), `++`/`--`, `**`, `?:`, `,`,
// and numbers written as 0x1f, 017 or base#digits. A variable holding an
// expression is evaluated in turn, as in bash.

export interface ArithmeticScope {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

export class ArithmeticError extends Error {}

type Tok = { kind: "num"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

const OPERATORS = [
  "<<=", ">>=", "**", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
  "+=", "-=", "*=", "/=", "%=", "&=", "^=", "|=",
  "+", "-", "*", "/", "%", "<", ">", "=", "!", "~", "&", "^", "|", "?", ":", ",", "(", ")", "[", "]",
];

function parseNumber(text: string): number {
  const based = text.match(/^(\d+)#([0-9a-zA-Z@_]+)$/);
  if (based) {
    const base = Number(based[1]);
    if (base < 2 || base > 64) throw new ArithmeticError(`${text}: invalid arithmetic base`);
    const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_";
    let value = 0;
    for (const ch of based[2]) {
      const digit = base <= 36 ? digits.indexOf(ch.toLowerCase()) : digits.indexOf(ch);
      if (digit < 0 || digit >= base) throw new ArithmeticError(`${text}: value too great for base`);
      value = value * base + digit;
    }
    return value;
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
  if (/^0[0-7]+$/.test(text)) return parseInt(text.slice(1), 8);
  if (/^\d+$/.test(text)) return parseInt(text, 10);
  throw new ArithmeticError(`${text}: value too great for base`);
}

function tokenize(source: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/\d/.test(ch)) {
      const match = source.slice(i).match(/^(?:\d+#[0-9a-zA-Z@_]+|0[xX][0-9a-fA-F]+|\d+)/)!;
      tokens.push({ kind: "num", value: parseNumber(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = source.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/)!;
      tokens.push({ kind: "name", value: match[0] });
      i += match[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new ArithmeticError(`syntax error: invalid arithmetic operator (error token is "${source.slice(i)}")`);
    tokens.push({ kind: "op", value: op });
    i += op.length;
  }
  return tokens;
}

const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="]);
const BINARY: Array<Set<string>> = [
  new Set(["||"]),
  new Set(["&&"]),
  new Set(["|"]),
  new Set(["^"]),
  new Set(["&"]),
  new Set(["==", "!="]),
  new Set(["<", ">", "<=", ">="]),
  new Set(["<<", ">>"]),
  new Set(["+", "-"]),
  new Set(["*", "/", "%"]),
];

function binary(op: string, a: number, b: number): number {
  switch (op) {
    case "||": return a || b ? 1 : 0;
    case "&&": return a && b ? 1 : 0;
    case "|": return Number(BigInt.asIntN(64, BigInt(a) | BigInt(b)));
    case "^": return Number(BigInt.asIntN(64, BigInt(a) ^ BigInt(b)));
    case "&": return Number(BigInt.asIntN(64, BigInt(a) & BigInt(b)));
    case "==": return a === b ? 1 : 0;
    case "!=": return a !== b ? 1 : 0;
    case "<": return a < b ? 1 : 0;
    case ">": return a > b ? 1 : 0;
    case "<=": return a <= b ? 1 : 0;
    case ">=": return a >= b ? 1 : 0;
    case "<<": return Number(BigInt.asIntN(64, BigInt(a) << BigInt(b)));
    case ">>": return Number(BigInt.asIntN(64, BigInt(a) >> BigInt(b)));
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
    case "%":
      if (b === 0) throw new ArithmeticError("division by 0");
      return op === "/" ? Math.trunc(a / b) : a % b;
    case "**":
      if (b < 0) throw new ArithmeticError("exponent less than 0");
      return a ** b;
  }
  throw new ArithmeticError(`syntax error: operand expected`);
}

/** Evaluates a bash arithmetic expression, reading and assigning variables through `scope`. */
export function evaluateArithmetic(source: string, scope: ArithmeticScope, maxDepth = 64): number {
  return evaluate(source, scope, maxDepth, 0);
}

function evaluate(source: string, scope: ArithmeticScope, maxDepth: number, depth: number): number {
  if (depth > maxDepth) throw new ArithmeticError("expression recursion level exceeded");
  if (source.trim() === "") return 0;
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => peek()?.kind === "op" && peek()!.value === value;
  const opIn = (set: Set<string>) => { const t = peek(); return t?.kind === "op" && set.has(t.value); };
  const expect = (value: string) => {
    if (!isOp(value)) throw new ArithmeticError(`syntax error in expression (error token is "${tokenText(pos)}")`);
    pos++;
  };
  const tokenText = (at: number) => tokens.slice(at).map((t) => String(t.value)).join(" ");

  // `skip` evaluates without side effects, for the branch `&&`, `||` and
  // `?:` do not take
  type Ref = { name: string };
  const read = (ref: Ref, skip: boolean): number => {
    if (skip) return 0;
    const raw = scope.get(ref.name);
    if (raw === undefined || raw.trim() === "") return 0;
    const text = raw.trim();
    if (/^-?\d+$/.test(text)) return Number(text);
    return evaluate(text, scope, maxDepth, depth + 1);
  };
  const write = (ref: Ref, value: number, skip: boolean): number => {
    if (!skip) scope.set(ref.name, String(value));
    return value;
  };

  const reference = (skip: boolean): Ref | null => {
    const token = peek();
    if (token?.kind !== "name") return null;
    pos++;
    if (isOp("[")) {
      pos++;
      const start = pos;
      let nesting = 1;
      while (pos < tokens.length && nesting > 0) {
        if (tokens[pos].kind === "op" && tokens[pos].value === "[") nesting++;
        if (tokens[pos].kind === "op" && tokens[pos].value === "]") nesting--;
        pos++;
      }
      if (nesting > 0) throw new ArithmeticError("syntax error: missing `]'");
      const inner = tokens.slice(start, pos - 1);
      const index = skip ? 0 : evaluateTokens(inner);
      return { name: `${token.value}[${index}]` };
    }
    return { name: token.value };
  };
  const evaluateTokens = (inner: Tok[]): number => {
    const text = inner.map((t) => (t.kind === "num" ? String(t.value) : t.value)).join(" ");
    return evaluate(text, scope, maxDepth, depth + 1);
  };

  const comma = (skip: boolean): number => {
    let value = assignment(skip);
    while (isOp(",")) { pos++; value = assignment(skip); }
    return value;
  };
  const assignment = (skip: boolean): number => {
    const start = pos;
    const ref = reference(skip);
    if (ref && opIn(ASSIGN)) {
      const op = (tokens[pos++] as { value: string }).value;
      const rhs = assignment(skip);
      if (op === "=") return write(ref, rhs, skip);
      return write(ref, binary(op.slice(0, -1), read(ref, skip), rhs), skip);
    }
    pos = start;
    return conditional(skip);
  };
  const conditional = (skip: boolean): number => {
    const test = binaryLevel(0, skip);
    if (!isOp("?")) return test;
    pos++;
    const yes = assignment(skip || !test);
    expect(":");
    const no = assignment(skip || !!test);
    return test ? yes : no;
  };
  const binaryLevel = (level: number, skip: boolean): number => {
    if (level >= BINARY.length) return power(skip);
    let left = binaryLevel(level + 1, skip);
    while (opIn(BINARY[level])) {
      const op = (tokens[pos++] as { value: string }).value;
      const shortCircuit = (op === "&&" && !left) || (op === "||" && !!left);
      const right = binaryLevel(level + 1, skip || shortCircuit);
      left = skip ? 0 : binary(op, left, shortCircuit ? (op === "||" ? 1 : 0) : right);
    }
    return left;
  };
  const power = (skip: boolean): number => {
    const base = unary(skip);
    if (!isOp("**")) return base;
    pos++;
    const exponent = power(skip);
    return skip ? 0 : binary("**", base, exponent);
  };
  const unary = (skip: boolean): number => {
    const token = peek();
    if (token?.kind === "op") {
      if (token.value === "++" || token.value === "--") {
        pos++;
        const ref = reference(skip);
        if (!ref) throw new ArithmeticError("syntax error: operand expected");
        return write(ref, read(ref, skip) + (token.value === "++" ? 1 : -1), skip);
      }
      if (token.value === "!") { pos++; return unary(skip) ? 0 : 1; }
      if (token.value === "~") { pos++; return Number(BigInt.asIntN(64, ~BigInt(unary(skip)))); }
      if (token.value === "-") { pos++; return -unary(skip); }
      if (token.value === "+") { pos++; return unary(skip); }
    }
    return postfix(skip);
  };
  const postfix = (skip: boolean): number => {
    const token = peek();
    if (token?.kind === "num") { pos++; return token.value; }
    if (token?.kind === "op" && token.value === "(") {
      pos++;
      const value = comma(skip);
      expect(")");
      return value;
    }
    const ref = reference(skip);
    if (!ref) {
      throw new ArithmeticError(`syntax error: operand expected (error token is "${tokenText(pos)}")`);
    }
    if (isOp("++") || isOp("--")) {
      const op = (tokens[pos++] as { value: string }).value;
      const current = read(ref, skip);
      write(ref, current + (op === "++" ? 1 : -1), skip);
      return current;
    }
    return read(ref, skip);
  };

  const value = comma(false);
  if (pos < tokens.length) {
    throw new ArithmeticError(`syntax error in expression (error token is "${tokenText(pos)}")`);
  }
  if (!Number.isFinite(value)) throw new ArithmeticError("arithmetic overflow");
  return Math.trunc(value);
}
