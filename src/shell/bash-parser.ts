/**
 * Dependency-free Bash grammar front-end.
 *
 * The legacy parser remains exported as `parse()` for consumers that use the
 * small AST directly. NodepodShell uses this parser for execution so quote
 * information is preserved until the expansion phase.
 */

export interface BashSyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

type TokenKind = "word" | "operator" | "newline" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

export type BashRedirect = {
  op: string;
  fd?: number;
  target?: string;
  heredoc?: { delimiter: string; stripTabs: boolean; body: string; expand?: boolean };
};

export interface BashSimpleCommand {
  kind: "simple";
  assignments: string[];
  words: string[];
  redirects: BashRedirect[];
}

export interface BashGroupCommand {
  kind: "group" | "subshell";
  body: BashList;
}

export interface BashIfCommand {
  kind: "if";
  branches: Array<{ condition: BashList; body: BashList }>;
  elseBody?: BashList;
}

export interface BashLoopCommand {
  kind: "while" | "until";
  condition: BashList;
  body: BashList;
}

export interface BashForCommand {
  kind: "for";
  variable: string;
  words: string[] | null;
  body: BashList;
}

export interface BashArithmeticForCommand {
  kind: "arithmetic-for";
  init: string;
  condition: string;
  update: string;
  body: BashList;
}

export interface BashCaseClause {
  patterns: string[];
  body: BashList;
  terminator: ";;" | ";&" | ";;&" | null;
}

export interface BashCaseCommand {
  kind: "case";
  word: string;
  clauses: BashCaseClause[];
}

export interface BashSelectCommand {
  kind: "select";
  variable: string;
  words: string[];
  body: BashList;
}

export interface BashConditionalCommand {
  kind: "conditional";
  words: string[];
}

export interface BashArithmeticCommand {
  kind: "arithmetic";
  expression: string;
}

export interface BashCoprocCommand {
  kind: "coproc";
  name: string;
  body: BashCommand;
}

// A compound command with redirects after it (`while ...; done < file`).
export interface BashRedirectedCommand {
  kind: "redirected";
  body: BashCommand;
  redirects: BashRedirect[];
}

export interface BashFunctionCommand {
  kind: "function";
  name: string;
  body: BashCommand;
}

export type BashCommand =
  | BashSimpleCommand
  | BashGroupCommand
  | BashIfCommand
  | BashLoopCommand
  | BashForCommand
  | BashArithmeticForCommand
  | BashCaseCommand
  | BashSelectCommand
  | BashConditionalCommand
  | BashArithmeticCommand
  | BashCoprocCommand
  | BashRedirectedCommand
  | BashFunctionCommand;

export interface BashPipeline {
  kind: "pipeline";
  commands: BashCommand[];
  negated: boolean;
  background: boolean;
  /** `time` (bash's report) or `time -p` (POSIX's) before the pipeline. */
  timed?: "bash" | "posix";
}

export interface BashAndOr {
  kind: "and-or";
  first: BashPipeline;
  rest: Array<{ op: "&&" | "||"; pipeline: BashPipeline }>;
}

export interface BashListEntry {
  command: BashAndOr;
  separator?: ";" | "&" | "newline";
}

export interface BashList {
  kind: "list";
  entries: BashListEntry[];
}

const OPERATORS = [
  "2>&1", "2>>", "2>", "&>>", "&>", "<<<", "<<-", "<<", ">>",
  ">|", "<>", ">&-", ">&", "<&-", "<&", ";;&", ";;", ";", "&&", "||", "|&", "|", "&", "(",
  ")", "((", "))", "[[", "]]", "{", "}", "<", ">", "!",
].sort((a, b) => b.length - a.length);

function syntax(message: string, source: string, offset: number): BashSyntaxError {
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = offset - lastNewline;
  const error = new Error(`${message} at ${line}:${column}`) as BashSyntaxError;
  Object.defineProperties(error, {
    name: { value: "BashSyntaxError" },
    offset: { value: offset },
    line: { value: line },
    column: { value: column },
  });
  return error;
}

function startsOperator(source: string, offset: number): string | null {
  for (const op of OPERATORS) {
    if (source.startsWith(op, offset)) return op;
  }
  return null;
}

function isWordBoundary(source: string, offset: number): boolean {
  return offset === 0 || /[\s;|&(){}<>!]/.test(source[offset - 1] ?? "");
}

// `{` and `}` are reserved words only as whole words: `{}` (find -exec) is a word.
function isStandaloneBrace(source: string, offset: number): boolean {
  const previous = offset === 0 ? "" : source[offset - 1];
  const next = source[offset + 1] ?? "";
  return (previous === "" || /[\s;|&()<>]/.test(previous)) && (next === "" || /[\s;|&()<>]/.test(next));
}

function substitutionEnd(source: string, start: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

// The `}` closing the `${` at `start`, so `${#x}`, `${x// /_}` and
// `${x:-a b}` stay one word.
function parameterEnd(source: string, start: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "$" && source[i + 1] === "(") {
      const end = substitutionEnd(source, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function hereDocDelimiter(rawDelimiter: string): { delimiter: string; expand: boolean } {
  return {
    expand: !/[\'"\\]/.test(rawDelimiter),
    delimiter: rawDelimiter
      .replace(/^'(.*)'$/, "$1")
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(.)/g, "$1"),
  };
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let awaitingHereDoc: { stripTabs: boolean } | null = null;
  const pendingHereDocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      tokens.push({ kind: "newline", value: "\n", start: i, end: ++i });
      if (pendingHereDocs.length > 0) {
        for (const pending of pendingHereDocs) {
          let found = false;
          while (i <= source.length) {
            const nextNewline = source.indexOf("\n", i);
            const lineEnd = nextNewline < 0 ? source.length : nextNewline;
            const rawLine = source.slice(i, lineEnd).replace(/\r$/, "");
            const compareLine = pending.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
            if (compareLine === pending.delimiter) {
              found = true;
              if (nextNewline < 0) {
                i = source.length;
              } else {
                tokens.push({ kind: "newline", value: "\n", start: lineEnd, end: nextNewline + 1 });
                i = nextNewline + 1;
              }
              break;
            }
            if (nextNewline < 0) break;
            i = nextNewline + 1;
          }
          if (!found) {
            throw syntax(`here-document delimited by end-of-file (wanted '${pending.delimiter}')`, source, i);
          }
        }
        pendingHereDocs.length = 0;
      }
      continue;
    }
    if (ch === "#" && isWordBoundary(source, i)) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if ((ch === "<" || ch === ">") && source[i + 1] === "(") {
      const end = substitutionEnd(source, i + 1);
      if (end < 0) throw syntax("unmatched process substitution", source, i);
      tokens.push({ kind: "word", value: source.slice(i, end + 1), start: i, end: end + 1 });
      i = end + 1;
      continue;
    }

    const operator = startsOperator(source, i);
    // `!` is an operator only at a command boundary; elsewhere it is a word.
    const braceOperator = operator === "{" || operator === "}";
    if (operator && (!braceOperator || isStandaloneBrace(source, i)) && (operator !== "!" || isWordBoundary(source, i))) {
      tokens.push({ kind: "operator", value: operator, start: i, end: i + operator.length });
      if (operator === "<<" || operator === "<<-") awaitingHereDoc = { stripTabs: operator === "<<-" };
      i += operator.length;
      continue;
    }

    const start = i;
    let value = "";
    let quote: "single" | "double" | null = null;
    let escaped = false;
    while (i < source.length) {
      const c = source[i];
      if (escaped) {
        if (c === "\n") {
          i++;
          escaped = false;
          continue;
        }
        value += "\\" + c;
        i++;
        escaped = false;
        continue;
      }
      if (c === "\\" && quote !== "single") {
        escaped = true;
        i++;
        continue;
      }
      // `$'…'`: ANSI-C quoting, where `\'` doesn't end the quote
      if (!quote && c === "$" && source[i + 1] === "'") {
        let end = i + 2;
        while (end < source.length && source[end] !== "'") end += source[end] === "\\" ? 2 : 1;
        if (end >= source.length) throw syntax("unexpected end of quoted string", source, i);
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (!quote && c === "$" && source[i + 1] === "(") {
        const end = substitutionEnd(source, i + 1);
        if (end < 0) throw syntax("unmatched command substitution", source, i);
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (!quote && c === "$" && source[i + 1] === "{") {
        const end = parameterEnd(source, i + 1);
        if (end < 0) throw syntax("unmatched parameter expansion", source, i);
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (!quote && (c === "<" || c === ">") && source[i + 1] === "(") {
        const end = substitutionEnd(source, i + 1);
        if (end < 0) throw syntax("unmatched process substitution", source, i);
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (!quote && c === "`") {
        const end = source.indexOf("`", i + 1);
        if (end < 0) throw syntax("unmatched command substitution", source, i);
        value += source.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (quote === "single") {
        value += c;
        i++;
        if (c === "'") quote = null;
        continue;
      }
      if (quote === "double") {
        value += c;
        i++;
        if (c === '"') quote = null;
        continue;
      }
      if (c === "'") {
        quote = "single";
        value += c;
        i++;
        continue;
      }
      if (c === '"') {
        quote = "double";
        value += c;
        i++;
        continue;
      }
      const nestedOperator = startsOperator(source, i);
      const nestedBrace = nestedOperator === "{" || nestedOperator === "}";
      const nestedOperatorIsBoundary = nestedOperator
        && (!nestedBrace || isStandaloneBrace(source, i))
        && (nestedOperator !== "!" || isWordBoundary(source, i));
      if (c === "\n" || c === " " || c === "\t" || nestedOperatorIsBoundary) break;
      value += c;
      i++;
    }
    if (quote) throw syntax("unexpected end of quoted string", source, start);
    if (escaped) throw syntax("trailing backslash", source, i);
    if (value) {
      tokens.push({ kind: "word", value, start, end: i });
      if (awaitingHereDoc) {
        pendingHereDocs.push({ delimiter: hereDocDelimiter(value).delimiter, stripTabs: awaitingHereDoc.stripTabs });
        awaitingHereDoc = null;
      }
    }
    else if (i === start) {
      // Lexer bugs must become structured syntax errors, never a synchronous
      // no-progress loop that freezes the shell worker.
      throw syntax(`unexpected token '${source[i]}'`, source, i);
    }
  }

  tokens.push({ kind: "eof", value: "", start: source.length, end: source.length });
  return tokens;
}

class Parser {
  private pos = 0;
  private nestedDepth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
    private readonly maxDepth: number,
  ) {}

  parse(): BashList {
    const list = this.parseList(new Set());
    const rest = this.peek();
    if (rest.kind !== "eof") throw syntax(`unexpected token '${rest.value}'`, this.source, rest.start);
    return list;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private accept(value: string): boolean {
    if (this.peek().value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(value: string): Token {
    const token = this.peek();
    if (token.value !== value) {
      throw syntax(`expected '${value}', got '${token.value || "end of input"}'`, this.source, token.start);
    }
    return this.advance();
  }

  private skipNewlines(): void {
    while (this.peek().kind === "newline") this.advance();
  }

  private parseNestedList(stopWords: Set<string>): BashList {
    if (this.nestedDepth >= this.maxDepth) {
      throw syntax(`parser nesting exceeds ${this.maxDepth}`, this.source, this.peek().start);
    }
    this.nestedDepth++;
    try { return this.parseList(stopWords); }
    finally { this.nestedDepth--; }
  }

  private parseList(stopWords: Set<string>): BashList {
    const entries: BashListEntry[] = [];
    this.skipNewlines();
    while (this.peek().kind !== "eof") {
      const current = this.peek();
      if (stopWords.has(current.value)) break;
      if (current.value === "}") break;
      if (current.value === ")") break;

      const command = this.parseAndOr(stopWords);
      let separator: BashListEntry["separator"];
      if (this.accept(";")) {
        separator = ";";
        if (this.accept(";")) throw syntax("unexpected ';;'", this.source, current.start);
      } else if (this.accept("&")) {
        separator = "&";
      } else if (this.peek().kind === "newline") {
        separator = "newline";
        this.skipNewlines();
      }
      entries.push({ command, separator });

      // `( cmd )` needs no separator before its `)`, nor a compound command
      // before `}` (`{ { cmd; } }`); after a simple command `}` is a word
      if (!separator && this.peek().kind !== "eof" && !stopWords.has(this.peek().value) && this.peek().value !== ")" && this.peek().value !== "}") {
        throw syntax(`unexpected token '${this.peek().value}'`, this.source, this.peek().start);
      }
      if (separator === "&") this.skipNewlines();
    }
    return { kind: "list", entries };
  }

  private parseAndOr(stopWords: Set<string>): BashAndOr {
    const first = this.parsePipeline(stopWords);
    const rest: BashAndOr["rest"] = [];
    while (this.peek().value === "&&" || this.peek().value === "||") {
      const op = this.advance().value as "&&" | "||";
      this.skipNewlines();
      rest.push({ op, pipeline: this.parsePipeline(stopWords) });
    }
    return { kind: "and-or", first, rest };
  }

  private parsePipeline(stopWords: Set<string>): BashPipeline {
    // `time [-p]` is a reserved word that times the whole pipeline
    let timed: BashPipeline["timed"];
    if (this.peek().kind === "word" && this.peek().value === "time") {
      this.advance();
      timed = "bash";
      if (this.peek().kind === "word" && this.peek().value === "-p") {
        this.advance();
        timed = "posix";
      }
    }
    const negated = this.accept("!");
    this.skipNewlines();
    if (timed && (this.peek().kind === "eof" || this.peek().kind === "newline" || /^(?:;|&&|\|\||&|\)|\})$/.test(this.peek().value))) {
      // a bare `time` times nothing
      return { kind: "pipeline", commands: [{ kind: "group", body: { kind: "list", entries: [] } }], negated, background: false, timed };
    }
    const commands = [this.parseCommand(stopWords)];
    while (this.peek().value === "|" || this.peek().value === "|&") {
      const op = this.advance().value;
      this.skipNewlines();
      if (op === "|&") {
        // `a |& b` is `a 2>&1 | b`
        const previous = commands[commands.length - 1];
        const redirect: BashRedirect = { op: "2>&1", fd: 2 };
        if (previous.kind === "simple" || previous.kind === "redirected") previous.redirects.push(redirect);
        else commands[commands.length - 1] = { kind: "redirected", body: previous, redirects: [redirect] };
      }
      commands.push(this.parseCommand(stopWords));
    }
    return { kind: "pipeline", commands, negated, background: false, ...(timed ? { timed } : {}) };
  }

  private parseCommand(stopWords: Set<string>): BashCommand {
    const token = this.peek();
    if (token.kind === "eof" || token.kind === "newline") {
      throw syntax("expected command", this.source, token.start);
    }

    if (token.value === "(") {
      this.advance();
      const body = this.parseNestedList(new Set());
      this.expect(")");
      return this.withTrailingRedirects({ kind: "subshell", body });
    }
    if (token.value === "{") {
      this.advance();
      const body = this.parseNestedList(new Set());
      this.expect("}");
      return this.withTrailingRedirects({ kind: "group", body });
    }
    if (token.value === "if") return this.withTrailingRedirects(this.parseIf());
    if (token.value === "while" || token.value === "until") return this.withTrailingRedirects(this.parseLoop(token.value as "while" | "until"));
    if (token.value === "for") return this.withTrailingRedirects(this.parseFor());
    if (token.value === "case") return this.withTrailingRedirects(this.parseCase());
    if (token.value === "select") return this.withTrailingRedirects(this.parseSelect());
    if (token.value === "[[") return this.withTrailingRedirects(this.parseConditional());
    if (token.value === "((") return this.withTrailingRedirects(this.parseArithmetic());
    if (token.value === "coproc") return this.parseCoproc();
    if (token.value === "function") return this.parseFunction(true);
    if (token.kind === "word" && this.peek(1).value === "(" && this.peek(2).value === ")") {
      return this.parseFunction(false);
    }

    return this.parseSimple(stopWords);
  }

  // Parses one redirect at the current token (`> f`, `2>&1`, `<<EOF`), or
  // returns null when the token doesn't start one.
  private parseRedirect(): BashRedirect | null {
    const token = this.peek();
    if (token.kind === "word" && /^\d+$/.test(token.value) && this.isRedirect(this.peek(1).value)) {
      const fd = Number(this.advance().value);
      const op = this.advance().value;
      if (op === ">&-" || op === "<&-") return { op, fd };
      const target = this.peek();
      if (target.kind !== "word") throw syntax(`redirection '${op}' requires a target`, this.source, target.start);
      this.advance();
      return { op, target: target.value, fd };
    }
    if (!this.isRedirect(token.value)) return null;
    const op = this.advance().value;
    if (op === "2>&1") return { op, target: "1", fd: 2 };
    if (op === ">&-" || op === "<&-") return { op, fd: this.extractFd(op) };
    const target = this.peek();
    if (target.kind !== "word") {
      throw syntax(`redirection '${op}' requires a target`, this.source, target.start);
    }
    this.advance();
    const redirect: BashRedirect = { op, target: target.value, fd: this.extractFd(op) };
    if (op === "<<" || op === "<<-") {
      redirect.heredoc = this.readHereDoc(target.value, op === "<<-");
    }
    return redirect;
  }

  // Redirects after a compound command apply to the whole command.
  private withTrailingRedirects(body: BashCommand): BashCommand {
    const redirects: BashRedirect[] = [];
    for (let redirect = this.parseRedirect(); redirect; redirect = this.parseRedirect()) redirects.push(redirect);
    return redirects.length ? { kind: "redirected", body, redirects } : body;
  }

  private parseSimple(_stopWords: Set<string>): BashSimpleCommand {
    const assignments: string[] = [];
    const words: string[] = [];
    const redirects: BashRedirect[] = [];
    let sawWord = false;

    // `}` closes a group only where a command could start: `echo a }` prints "a }"
    const isWord = () => this.peek().kind === "word" || (words.length > 0 && this.peek().value === "}");
    while (isWord() || this.isRedirect(this.peek().value)) {
      const token = this.peek();
      const redirect = this.parseRedirect();
      if (redirect) {
        redirects.push(redirect);
        continue;
      }

      this.advance();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*\+?=$/.test(token.value) && this.peek().value === "(") {
        this.advance();
        const elements: string[] = [];
        while (this.peek().kind !== "eof" && this.peek().value !== ")") {
          if (this.peek().kind !== "word") throw syntax("invalid array assignment", this.source, this.peek().start);
          elements.push(this.advance().value);
        }
        this.expect(")");
        const combined = `${token.value}(${elements.join(" ")})`;
        if (!sawWord) assignments.push(combined);
        else words.push(combined);
        continue;
      }
      if (!sawWord && /^[a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]+\])?\+?=/.test(token.value)) {
        assignments.push(token.value);
      } else {
        sawWord = true;
        words.push(token.value);
      }
    }

    if (assignments.length === 0 && words.length === 0 && redirects.length === 0) {
      throw syntax("expected command", this.source, this.peek().start);
    }
    return { kind: "simple", assignments, words, redirects };
  }

  private parseIf(): BashIfCommand {
    this.expect("if");
    const branches: BashIfCommand["branches"] = [];
    const condition = this.parseNestedList(new Set(["then"]));
    this.expect("then");
    const body = this.parseNestedList(new Set(["elif", "else", "fi"]));
    branches.push({ condition, body });
    while (this.accept("elif")) {
      const nextCondition = this.parseNestedList(new Set(["then"]));
      this.expect("then");
      const nextBody = this.parseNestedList(new Set(["elif", "else", "fi"]));
      branches.push({ condition: nextCondition, body: nextBody });
    }
    let elseBody: BashList | undefined;
    if (this.accept("else")) elseBody = this.parseNestedList(new Set(["fi"]));
    this.expect("fi");
    return { kind: "if", branches, elseBody };
  }

  private parseLoop(kind: "while" | "until"): BashLoopCommand {
    this.expect(kind);
    const condition = this.parseNestedList(new Set(["do"]));
    this.expect("do");
    const body = this.parseNestedList(new Set(["done"]));
    this.expect("done");
    return { kind, condition, body };
  }

  private parseFor(): BashForCommand | BashArithmeticForCommand {
    this.expect("for");
    if (this.accept("((")) {
      const parts: string[] = [];
      while (this.peek().kind !== "eof" && this.peek().value !== "))") parts.push(this.advance().value);
      this.expect("))");
      this.accept(";");
      this.skipNewlines();
      this.expect("do");
      const body = this.parseNestedList(new Set(["done"]));
      this.expect("done");
      const expressions = parts.join(" ").split(";").map((part) => part.trim());
      if (expressions.length !== 3) throw syntax("arithmetic for requires init, condition, and update", this.source, this.peek().start);
      return { kind: "arithmetic-for", init: expressions[0], condition: expressions[1], update: expressions[2], body };
    }
    const name = this.peek();
    if (name.kind !== "word" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.value)) {
      throw syntax("for requires a valid variable name", this.source, name.start);
    }
    this.advance();
    let words: string[] | null = null;
    if (this.accept("in")) {
      words = [];
      while (this.peek().kind === "word") words.push(this.advance().value);
    }
    this.accept(";");
    this.skipNewlines();
    this.expect("do");
    const body = this.parseNestedList(new Set(["done"]));
    this.expect("done");
    return { kind: "for", variable: name.value, words, body };
  }

  private parseSelect(): BashSelectCommand {
    this.expect("select");
    const name = this.peek();
    if (name.kind !== "word" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.value)) {
      throw syntax("select requires a valid variable name", this.source, name.start);
    }
    this.advance();
    const words: string[] = [];
    this.accept("in");
    while (this.peek().kind === "word") words.push(this.advance().value);
    if (this.accept(";")) this.skipNewlines();
    this.expect("do");
    const body = this.parseNestedList(new Set(["done"]));
    this.expect("done");
    return { kind: "select", variable: name.value, words, body };
  }

  private parseConditional(): BashConditionalCommand {
    this.expect("[[");
    const words: string[] = [];
    const ends = () => this.peek().kind === "eof" || this.peek().value === "]]" || this.peek().kind === "newline";
    while (!ends()) {
      const token = this.advance();
      words.push(token.value);
      if (token.value === "=~" && !ends()) {
        // the regex runs to the next blank, parentheses and `|` included
        const start = this.peek().start;
        let end = this.advance().end;
        while (!ends() && this.peek().start === end) end = this.advance().end;
        words.push(this.source.slice(start, end));
      }
    }
    this.expect("]]");
    return { kind: "conditional", words };
  }

  private parseArithmetic(): BashArithmeticCommand {
    this.expect("((");
    const parts: string[] = [];
    while (this.peek().kind !== "eof" && this.peek().value !== "))" && this.peek().kind !== "newline") {
      parts.push(this.advance().value);
    }
    this.expect("))");
    return { kind: "arithmetic", expression: parts.join(" ") };
  }

  private parseCoproc(): BashCoprocCommand {
    this.expect("coproc");
    let name = "COPROC";
    if (this.peek().kind === "word" && this.peek().value !== "{" && this.peek().value !== "(") name = this.advance().value;
    return { kind: "coproc", name, body: this.parseCommand(new Set()) };
  }

  private parseCase(): BashCaseCommand {
    this.expect("case");
    const word = this.peek();
    if (word.kind !== "word") throw syntax("case requires a word", this.source, word.start);
    this.advance();
    this.expect("in");
    this.skipNewlines();

    const clauses: BashCaseClause[] = [];
    while (this.peek().kind !== "eof" && this.peek().value !== "esac") {
      const patterns: string[] = [];
      const first = this.peek();
      if (first.kind !== "word") throw syntax("case pattern is required", this.source, first.start);
      patterns.push(this.advance().value);
      while (this.accept("|")) {
        const pattern = this.peek();
        if (pattern.kind !== "word") throw syntax("case pattern is required", this.source, pattern.start);
        patterns.push(this.advance().value);
      }
      this.expect(")");
      const body = this.parseNestedList(new Set([";;", ";&", ";;&", "esac"]));
      let terminator: BashCaseClause["terminator"] = null;
      if (this.peek().value === ";;" || this.peek().value === ";&" || this.peek().value === ";;&") {
        terminator = this.advance().value as BashCaseClause["terminator"];
        this.skipNewlines();
      }
      clauses.push({ patterns, body, terminator });
      if (terminator === null && this.peek().value !== "esac") {
        throw syntax("expected ';;' or 'esac'", this.source, this.peek().start);
      }
    }
    this.expect("esac");
    return { kind: "case", word: word.value, clauses };
  }

  private parseFunction(withKeyword: boolean): BashFunctionCommand {
    if (withKeyword) {
      this.expect("function");
      if (this.peek().value === "{") {
        throw syntax("function name is required", this.source, this.peek().start);
      }
    }
    const name = this.advance();
    if (name.kind !== "word") throw syntax("function name is required", this.source, name.start);
    if (withKeyword && this.accept("(")) this.expect(")");
    if (!withKeyword) {
      this.expect("(");
      this.expect(")");
    }
    this.skipNewlines();
    return { kind: "function", name: name.value, body: this.parseCommand(new Set()) };
  }

  private isRedirect(value: string): boolean {
    return /^(?:\d+)?(?:>>|>|<|<>|<<-?|<<<|>&-?|<&-?|&>|&>>|2>&1)$/.test(value);
  }

  private readHereDoc(rawDelimiter: string, stripTabs: boolean): BashRedirect["heredoc"] {
    const { delimiter, expand } = hereDocDelimiter(rawDelimiter);
    const lineStart = this.source.indexOf("\n", this.peek(-1).end);
    if (lineStart < 0) return { delimiter, stripTabs, body: "", expand };
    const bodyStart = lineStart + 1;
    let cursor = bodyStart;
    while (cursor <= this.source.length) {
      const nextNewline = this.source.indexOf("\n", cursor);
      const lineEnd = nextNewline < 0 ? this.source.length : nextNewline;
      const rawLine = this.source.slice(cursor, lineEnd).replace(/\r$/, "");
      const compareLine = stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
      if (compareLine === delimiter) {
        // Consume the delimiter token itself but leave the newline that ends
        // the here-document in the token stream. That newline separates this
        // command from the next command, just as it does in Bash.
        const end = lineEnd;
        while (this.peek().start < end) this.advance();
        let body = this.source.slice(bodyStart, cursor);
        if (stripTabs) body = body.replace(/^\t/gm, "");
        return { delimiter, stripTabs, body, expand };
      }
      if (nextNewline < 0) break;
      cursor = nextNewline + 1;
    }
    throw syntax(`here-document delimited by end-of-file (wanted '${delimiter}')`, this.source, bodyStart);
  }

  private extractFd(value: string): number | undefined {
    const match = value.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : undefined;
  }
}

export function parseBash(source: string, maxDepth = 64): BashList {
  const boundedDepth = Number.isFinite(maxDepth) ? Math.max(1, Math.floor(maxDepth)) : 64;
  return new Parser(lex(source), source, boundedDepth).parse();
}
