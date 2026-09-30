// lightweight REPL stub for compatibility


import { EventEmitter } from "./events";
import { builtinModules } from "./module";

export const _builtinLibs = builtinModules.filter(name => !name.startsWith("node:") && !name.startsWith("_"));

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const REPL_MODE_SLOPPY = Symbol.for("repl-sloppy");
export const REPL_MODE_STRICT = Symbol.for("repl-strict");

/* ------------------------------------------------------------------ */
/*  Recoverable                                                        */
/* ------------------------------------------------------------------ */

export interface Recoverable extends SyntaxError {
  err: Error;
}

interface RecoverableConstructor {
  new (err: Error): Recoverable;
  (this: any, err: Error): void;
  prototype: any;
}

export const Recoverable = function Recoverable(this: any, err: Error) {
  if (!this) return;
  SyntaxError.call(this, err.message);
  this.message = err.message;
  this.name = "SyntaxError";
  this.err = err;
  if (Error.captureStackTrace) Error.captureStackTrace(this, Recoverable);
} as unknown as RecoverableConstructor;

Object.setPrototypeOf(Recoverable.prototype, SyntaxError.prototype);

/* ------------------------------------------------------------------ */
/*  REPLServer                                                         */
/* ------------------------------------------------------------------ */

export interface REPLServer extends EventEmitter {
  context: Record<string, unknown>;
  terminal: boolean;
  _prompt: string;
  _commands: Map<string, { help: string; action: Function }>;
  setPrompt(prompt: string): void;
  getPrompt(): string;
  displayPrompt(_preserveCursor?: boolean): void;
  defineCommand(keyword: string, cmd: { help?: string; action: Function } | Function): void;
  close(): void;
  setupHistory(_historyPath: string, cb: (err: Error | null, repl: REPLServer) => void): void;
}

interface REPLServerConstructor {
  new (options?: string | Record<string, unknown>): REPLServer;
  (this: any, options?: string | Record<string, unknown>): void;
  prototype: any;
}

export const REPLServer = function REPLServer(this: any, options?: string | Record<string, unknown>) {
  if (!this) return;
  EventEmitter.call(this);
  this.context = Object.create(null);
  this.terminal = false;
  this._prompt = "> ";
  this._commands = new Map<string, { help: string; action: Function }>();
  if (typeof options === "string") {
    this._prompt = options;
  } else if (options) {
    if (typeof options.prompt === "string") this._prompt = options.prompt;
    if (options.terminal !== undefined) this.terminal = !!options.terminal;
  }
} as unknown as REPLServerConstructor;

Object.setPrototypeOf(REPLServer.prototype, EventEmitter.prototype);

REPLServer.prototype.setPrompt = function setPrompt(this: any, prompt: string): void {
  this._prompt = prompt;
};

REPLServer.prototype.getPrompt = function getPrompt(this: any): string {
  return this._prompt;
};

REPLServer.prototype.displayPrompt = function displayPrompt(_preserveCursor?: boolean): void {
};

REPLServer.prototype.defineCommand = function defineCommand(
  this: any,
  keyword: string,
  cmd: { help?: string; action: Function } | Function,
): void {
  if (typeof cmd === "function") {
    this._commands.set(keyword, { help: "", action: cmd });
  } else {
    this._commands.set(keyword, { help: cmd.help || "", action: cmd.action });
  }
};

REPLServer.prototype.close = function close(this: any): void {
  this.emit("exit");
  this.emit("close");
};

REPLServer.prototype.setupHistory = function setupHistory(
  this: any,
  _historyPath: string,
  cb: (err: Error | null, repl: REPLServer) => void,
): void {
  cb(null, this);
};

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function start(
  options?: string | Record<string, unknown>,
): REPLServer {
  return new REPLServer(options);
}

/* ------------------------------------------------------------------ */
/*  Default export                                                     */
/* ------------------------------------------------------------------ */

export default {
  _builtinLibs,
  start,
  REPLServer,
  Recoverable,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
};
