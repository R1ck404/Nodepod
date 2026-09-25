// readline polyfill — createInterface, emitKeypressEvents, terminal helpers
// we track line/cursor on every keystroke because @clack reads rl.line directly

import { EventEmitter } from "./events";
import { getRegistry, type Handle } from "../helpers/event-loop";

// the wait loop checks this so it doesn't bail while the user is typing
let _activeInterfaceCount = 0;

export function getActiveInterfaceCount(): number {
  return _activeInterfaceCount;
}

export function setActiveInterfaceCount(n: number): void {
  _activeInterfaceCount = n;
}

export function resetActiveInterfaceCount(): void {
  _activeInterfaceCount = 0;
}


export interface InterfaceConfig {
  input?: unknown;
  output?: unknown;
  terminal?: boolean;
  prompt?: string;
  historySize?: number;
  history?: string[];
  removeHistoryDuplicates?: boolean;
  completer?: (line: string) => [string[], string] | void;
  crlfDelay?: number;
  escapeCodeTimeout?: number;
  tabSize?: number;
  signal?: AbortSignal;
}

// turns raw data events into proper keypress events

const KEYPRESS_DECODER = Symbol("keypressDecoder");

// parses individual chars (including escape sequences) and fires keypress
function parseAndEmitKeypress(
  stream: any,
  char: string,
  escapeBuf: string[],
): string[] {
  if (escapeBuf.length > 0) {
    escapeBuf.push(char);
    const seq = escapeBuf.join("");

    if (seq.length >= 3 && seq[1] === "[") {
      // CSI escape sequence (arrows, home, end, etc.)
      const lastChar = seq[seq.length - 1];
      if (/[A-Za-z~]/.test(lastChar)) {
        let name = "";
        let ctrl = false;
        if (lastChar === "A") name = "up";
        else if (lastChar === "B") name = "down";
        else if (lastChar === "C") name = "right";
        else if (lastChar === "D") name = "left";
        else if (lastChar === "H") name = "home";
        else if (lastChar === "F") name = "end";
        else if (seq === "\x1b[3~") name = "delete";
        else if (seq === "\x1b[2~") name = "insert";
        else if (seq === "\x1b[5~") name = "pageup";
        else if (seq === "\x1b[6~") name = "pagedown";
        else if (seq === "\x1b[1;5C") { name = "right"; ctrl = true; }  // Ctrl+Right
        else if (seq === "\x1b[1;5D") { name = "left"; ctrl = true; }   // Ctrl+Left
        else name = lastChar;

        stream.emit("keypress", seq, {
          sequence: seq,
          name,
          ctrl,
          meta: false,
          shift: false,
        });
        return [];
      }
      if (seq.length > 8) {
        stream.emit("keypress", seq, {
          sequence: seq,
          name: "unknown",
          ctrl: false,
          meta: false,
          shift: false,
        });
        return [];
      }
      return escapeBuf;
    }

    if (seq.length >= 3 && seq[1] === "O") {
      const lastChar = seq[seq.length - 1];
      let name = "";
      if (lastChar === "A") name = "up";
      else if (lastChar === "B") name = "down";
      else if (lastChar === "C") name = "right";
      else if (lastChar === "D") name = "left";
      else if (lastChar === "H") name = "home";
      else if (lastChar === "F") name = "end";
      else name = lastChar;

      stream.emit("keypress", seq, {
        sequence: seq,
        name,
        ctrl: false,
        meta: false,
        shift: false,
      });
      return [];
    }

    if (seq.length >= 2 && seq[1] !== "[" && seq[1] !== "O") {
      // Alt+letter combo
      const metaChar = seq[1];
      let name = metaChar;
      if (metaChar.charCodeAt(0) >= 32) {
        name = metaChar.toLowerCase();
      }
      stream.emit("keypress", seq, {
        sequence: seq,
        name,
        ctrl: false,
        meta: true,
        shift: false,
      });
      return [];
    }

    return escapeBuf;
  }

  if (char === "\x1b") {
    return [char];
  }

  let name = char;
  let ctrl = false;
  if (char === "\r" || char === "\n") name = "return";
  else if (char === "\x7f" || char === "\b") name = "backspace";
  else if (char === "\t") name = "tab";
  else if (char === " ") name = "space";
  else if (char.charCodeAt(0) < 32) {
    ctrl = true;
    name = String.fromCharCode(char.charCodeAt(0) + 96);
  }

  stream.emit("keypress", char, {
    sequence: char,
    name,
    ctrl,
    meta: false,
    shift: false,
  });

  return [];
}

export function emitKeypressEvents(stream: unknown, _iface?: Interface): void {
  if (!stream || typeof (stream as any).on !== "function") return;
  if ((stream as any)[KEYPRESS_DECODER]) return;
  (stream as any)[KEYPRESS_DECODER] = true;

  let escapeBuf: string[] = [];
  let escapeTimeout: ReturnType<typeof setTimeout> | null = null;

  (stream as any).on("data", (data: unknown) => {
    if ((stream as any).listenerCount("keypress") <= 0) return;
    const text = typeof data === "string" ? data : String(data);

    for (const char of text) {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      escapeBuf = parseAndEmitKeypress(stream as any, char, escapeBuf);

      // if we're mid-escape, flush it after a short timeout
      if (escapeBuf.length > 0) {
        escapeTimeout = setTimeout(() => {
          if (escapeBuf.length > 0) {
            const seq = escapeBuf.join("");
            (stream as any).emit("keypress", seq, {
              sequence: seq,
              name: "escape",
              ctrl: false,
              meta: false,
              shift: false,
            });
            escapeBuf = [];
          }
        }, 50);
      }
    }
  });
}

// word boundary helpers for Ctrl+Left/Right, Ctrl+W, etc.

function wordLeft(line: string, cursor: number): number {
  let i = cursor - 1;
  while (i >= 0 && /\s/.test(line[i])) i--;
  while (i >= 0 && !/\s/.test(line[i])) i--;
  return i + 1;
}

function wordRight(line: string, cursor: number): number {
  let i = cursor;
  while (i < line.length && !/\s/.test(line[i])) i++;
  while (i < line.length && /\s/.test(line[i])) i++;
  return i;
}


export interface Interface extends EventEmitter {
  _promptStr: string;
  input: unknown;
  output: unknown;
  closed: boolean;
  _lineBuffer: string;
  _pendingQuestions: Array<{
    query: string;
    handler: (answer: string) => void;
    signal?: AbortSignal;
    abortListener?: () => void;
  }>;
  terminal: boolean;
  line: string;
  cursor: number;
  history: string[];
  _historyIndex: number;
  _historySize: number;
  _removeHistoryDuplicates: boolean;
  _savedLine: string;
  _killRing: string[];
  _refreshLine(): void;
  _onKeypress(char: string | undefined, key: any): void;
  _onData(text: string): void;
  _addToHistory(line: string): void;
  prompt(preserveCursor?: boolean): void;
  setPrompt(text: string): void;
  getPrompt(): string;
  question(query: string, optsOrHandler?: unknown, handler?: (answer: string) => void): void;
  pause(): this;
  resume(): this;
  close(): void;
  ref(): this;
  unref(): this;
  write(data: string | null, _key?: { ctrl?: boolean; name?: string; meta?: boolean; shift?: boolean; sequence?: string }): void;
  clearLine(dir?: number): void;
  getCursorPos(): { rows: number; cols: number };
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
}

interface InterfaceConstructor {
  new (cfg?: InterfaceConfig): Interface;
  (this: any, cfg?: InterfaceConfig): void;
  prototype: any;
}

export const Interface = function Interface(this: any, cfg?: InterfaceConfig) {
  if (!this) return;
  EventEmitter.call(this);
  this._promptStr = cfg?.prompt ?? "> ";
  this.input = cfg?.input;
  this.output = cfg?.output;
  this.closed = false;
  this._lineBuffer = "";
  this._pendingQuestions = [];
  // like node: a terminal interface only when the output is a TTY. One with
  // just an input (vite's shortcuts: createInterface({ input: process.stdin })
  // reading "q"/"h" lines) stays in line mode, so stdin stays cooked and
  // Ctrl+C is a SIGINT that ends the process. In raw mode the keystroke went
  // to the process as data and nothing ended it.
  if (cfg?.terminal !== undefined) {
    this.terminal = cfg.terminal;
  } else {
    const inputIsTTY = !!(cfg?.input as any)?.isTTY;
    const outputIsTTY = !!(cfg?.output as any)?.isTTY;
    this.terminal = inputIsTTY && cfg?.output != null && outputIsTTY;
  }
  this.line = "";
  this.cursor = 0;

  this._historySize = cfg?.historySize ?? 30;
  this._removeHistoryDuplicates = cfg?.removeHistoryDuplicates ?? false;
  this.history = Array.isArray(cfg?.history) ? cfg!.history.slice(0, this._historySize) : [];
  this._historyIndex = -1;
  this._savedLine = "";
  this._killRing = [];

  if (cfg?.signal) {
    const signal = cfg.signal;
    if (signal.aborted) {
      queueMicrotask(() => this.close());
    } else {
      const onAbort = () => this.close();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  if (this.input && typeof (this.input as any).on === "function") {
    _activeInterfaceCount++;
    (this as any)._elHandle = getRegistry().register("ReadlineInterface");
    const inputStream = this.input as EventEmitter;
    const self = this;

    // remember every listener we attach so close() can drop them. otherwise
    // each closed readline leaves dead keypress/data/end handlers on stdin
    // and they pile up across lifecycles.
    const installed: Array<{ evt: string; fn: (...a: any[]) => void }> = [];
    const installAndTrack = (evt: string, fn: (...a: any[]) => void) => {
      inputStream.on(evt, fn);
      installed.push({ evt, fn });
    };
    (this as any)._installedListeners = installed;

    if (this.terminal) {
      // raw mode so we get individual keystrokes instead of line-buffered input
      if (typeof (this.input as any).setRawMode === "function") {
        (this.input as any).setRawMode(true);
      }

      emitKeypressEvents(this.input, this);

      installAndTrack("keypress", (char: string | undefined, key: any) => {
        if (self.closed) return;
        self._onKeypress(char, key);
      });
    } else {
      installAndTrack("data", (data: unknown) => {
        if (self.closed) return;
        const text = typeof data === "string" ? data : String(data);
        self._onData(text);
      });
    }

    installAndTrack("end", () => {
      if (!self.closed) self.close();
    });
  }
} as unknown as InterfaceConstructor;

Object.setPrototypeOf(Interface.prototype, EventEmitter.prototype);

Interface.prototype._refreshLine = function _refreshLine(this: any): void {
  if (this.output && typeof (this.output as any).write === "function") {
    (this.output as any).write(this.line);
  }
};

Interface.prototype._addToHistory = function _addToHistory(this: any, line: string): void {
  if (this._historySize === 0 || !line) return;

  if (this._removeHistoryDuplicates) {
    const idx = this.history.indexOf(line);
    if (idx !== -1) this.history.splice(idx, 1);
  }

  this.history.unshift(line);
  if (this.history.length > this._historySize) {
    this.history.length = this._historySize;
  }

  this._historyIndex = -1;
  this.emit("history", this.history);
};

Interface.prototype._onKeypress = function _onKeypress(this: any, char: string | undefined, key: any): void {
  if (!key) return;

  // Ctrl+C
  if (key.ctrl && key.name === "c") {
    if (this.listenerCount("SIGINT") > 0) {
      this.emit("SIGINT");
    } else {
      this.close();
    }
    return;
  }

  // Ctrl+Z
  if (key.ctrl && key.name === "z") {
    if (this.listenerCount("SIGTSTP") > 0) {
      this.emit("SIGTSTP");
    }
    return;
  }

  // Enter — submit the line
  if (key.name === "return") {
    const line = this._lineBuffer;
    this._lineBuffer = "";
    this.line = line;

    this._addToHistory(line);

    if (this._pendingQuestions.length > 0) {
      const q = this._pendingQuestions.shift()!;
      if (q.signal && q.abortListener) {
        q.signal.removeEventListener("abort", q.abortListener);
      }
      q.handler(line);
    }

    this.emit("line", line);
    this.line = "";
    this.cursor = 0;
    return;
  }

  // Backspace
  if (key.name === "backspace") {
    if (this.cursor > 0) {
      const deleted = this._lineBuffer[this.cursor - 1];
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor - 1) +
        this._lineBuffer.slice(this.cursor);
      this.cursor--;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Delete
  if (key.name === "delete") {
    if (this.cursor < this._lineBuffer.length) {
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor) +
        this._lineBuffer.slice(this.cursor + 1);
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Ctrl+D — delete char or close if empty
  if (key.ctrl && key.name === "d") {
    if (this._lineBuffer.length === 0) {
      this.close();
    } else if (this.cursor < this._lineBuffer.length) {
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor) +
        this._lineBuffer.slice(this.cursor + 1);
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // arrow keys
  if (key.name === "left" && !key.ctrl && !key.meta) {
    this.cursor = Math.max(0, this.cursor - 1);
    this._refreshLine();
    return;
  }
  if (key.name === "right" && !key.ctrl && !key.meta) {
    this.cursor = Math.min(this._lineBuffer.length, this.cursor + 1);
    this._refreshLine();
    return;
  }

  // Ctrl+Left / Alt+B — jump word left
  if ((key.ctrl && key.name === "left") || (key.meta && key.name === "b")) {
    this.cursor = wordLeft(this._lineBuffer, this.cursor);
    this._refreshLine();
    return;
  }

  // Ctrl+Right / Alt+F — jump word right
  if ((key.ctrl && key.name === "right") || (key.meta && key.name === "f")) {
    this.cursor = wordRight(this._lineBuffer, this.cursor);
    this._refreshLine();
    return;
  }

  // Home / Ctrl+A
  if (key.name === "home" || (key.ctrl && key.name === "a")) {
    this.cursor = 0;
    this._refreshLine();
    return;
  }

  // End / Ctrl+E
  if (key.name === "end" || (key.ctrl && key.name === "e")) {
    this.cursor = this._lineBuffer.length;
    this._refreshLine();
    return;
  }

  // Ctrl+B — back one char
  if (key.ctrl && key.name === "b") {
    this.cursor = Math.max(0, this.cursor - 1);
    this._refreshLine();
    return;
  }

  // Ctrl+F — forward one char
  if (key.ctrl && key.name === "f") {
    this.cursor = Math.min(this._lineBuffer.length, this.cursor + 1);
    this._refreshLine();
    return;
  }

  // Up / Ctrl+P — previous history entry
  if (key.name === "up" || (key.ctrl && key.name === "p")) {
    if (this.history.length > 0 && this._historyIndex < this.history.length - 1) {
      if (this._historyIndex === -1) {
        this._savedLine = this._lineBuffer;
      }
      this._historyIndex++;
      this._lineBuffer = this.history[this._historyIndex];
      this.cursor = this._lineBuffer.length;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Down / Ctrl+N — next history entry
  if (key.name === "down" || (key.ctrl && key.name === "n")) {
    if (this._historyIndex > 0) {
      this._historyIndex--;
      this._lineBuffer = this.history[this._historyIndex];
      this.cursor = this._lineBuffer.length;
      this.line = this._lineBuffer;
      this._refreshLine();
    } else if (this._historyIndex === 0) {
      this._historyIndex = -1;
      this._lineBuffer = this._savedLine;
      this.cursor = this._lineBuffer.length;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Ctrl+U — kill everything before cursor
  if (key.ctrl && key.name === "u") {
    const killed = this._lineBuffer.slice(0, this.cursor);
    if (killed) this._killRing.push(killed);
    this._lineBuffer = this._lineBuffer.slice(this.cursor);
    this.cursor = 0;
    this.line = this._lineBuffer;
    this._refreshLine();
    return;
  }

  // Ctrl+K — kill everything after cursor
  if (key.ctrl && key.name === "k") {
    const killed = this._lineBuffer.slice(this.cursor);
    if (killed) this._killRing.push(killed);
    this._lineBuffer = this._lineBuffer.slice(0, this.cursor);
    this.line = this._lineBuffer;
    this._refreshLine();
    return;
  }

  // Ctrl+H — same as backspace
  if (key.ctrl && key.name === "h") {
    if (this.cursor > 0) {
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor - 1) +
        this._lineBuffer.slice(this.cursor);
      this.cursor--;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Ctrl+W — delete word backward
  if (key.ctrl && key.name === "w") {
    const newPos = wordLeft(this._lineBuffer, this.cursor);
    const killed = this._lineBuffer.slice(newPos, this.cursor);
    if (killed) this._killRing.push(killed);
    this._lineBuffer =
      this._lineBuffer.slice(0, newPos) +
      this._lineBuffer.slice(this.cursor);
    this.cursor = newPos;
    this.line = this._lineBuffer;
    this._refreshLine();
    return;
  }

  // Alt+D — delete word forward
  if (key.meta && key.name === "d") {
    const newPos = wordRight(this._lineBuffer, this.cursor);
    const killed = this._lineBuffer.slice(this.cursor, newPos);
    if (killed) this._killRing.push(killed);
    this._lineBuffer =
      this._lineBuffer.slice(0, this.cursor) +
      this._lineBuffer.slice(newPos);
    this.line = this._lineBuffer;
    this._refreshLine();
    return;
  }

  // Ctrl+Y — paste last killed text
  if (key.ctrl && key.name === "y") {
    if (this._killRing.length > 0) {
      const text = this._killRing[this._killRing.length - 1];
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor) +
        text +
        this._lineBuffer.slice(this.cursor);
      this.cursor += text.length;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
    return;
  }

  // Ctrl+L — clear screen
  if (key.ctrl && key.name === "l") {
    if (this.output && typeof (this.output as any).write === "function") {
      (this.output as any).write("\x1b[2J\x1b[H");
    }
    this._refreshLine();
    return;
  }

  // regular printable character
  if (
    char &&
    !key.ctrl &&
    !key.meta &&
    char.length === 1 &&
    char.charCodeAt(0) >= 32
  ) {
    this._lineBuffer =
      this._lineBuffer.slice(0, this.cursor) +
      char +
      this._lineBuffer.slice(this.cursor);
    this.cursor++;
    this.line = this._lineBuffer;
    this._refreshLine();
    return;
  }

};

Interface.prototype._onData = function _onData(this: any, text: string): void {
  for (const char of text) {
    if (char === "\n" || char === "\r") {
      const line = this._lineBuffer;
      this._lineBuffer = "";
      this.line = line;

      this._addToHistory(line);

      if (this._pendingQuestions.length > 0) {
        const q = this._pendingQuestions.shift()!;
        if (q.signal && q.abortListener) {
          q.signal.removeEventListener("abort", q.abortListener);
        }
        q.handler(line);
      }

      this.emit("line", line);
      this.line = "";
      this.cursor = 0;
    } else if (char === "\x7f" || char === "\b") {
      if (this._lineBuffer.length > 0) {
        this._lineBuffer =
          this._lineBuffer.slice(0, this.cursor - 1) +
          this._lineBuffer.slice(this.cursor);
        this.cursor = Math.max(0, this.cursor - 1);
        this.line = this._lineBuffer;
        this._refreshLine();
      }
    } else if (char.charCodeAt(0) >= 32) {
      this._lineBuffer =
        this._lineBuffer.slice(0, this.cursor) +
        char +
        this._lineBuffer.slice(this.cursor);
      this.cursor++;
      this.line = this._lineBuffer;
      this._refreshLine();
    }
  }
};

Interface.prototype.prompt = function prompt(this: any, preserveCursor?: boolean): void {
  if (this.output && typeof (this.output as any).write === "function") {
    (this.output as any).write(this._promptStr);
  }
  if (!preserveCursor) {
    this.cursor = 0;
    this.line = "";
    this._lineBuffer = "";
  }
};

Interface.prototype.setPrompt = function setPrompt(this: any, text: string): void {
  this._promptStr = text;
};

Interface.prototype.getPrompt = function getPrompt(this: any): string {
  return this._promptStr;
};

Interface.prototype.question = function question(
  this: any,
  query: string,
  optsOrHandler?: unknown,
  handler?: (answer: string) => void,
): void {
  let actualHandler: ((answer: string) => void) | undefined;
  let signal: AbortSignal | undefined;

  if (typeof optsOrHandler === "function") {
    actualHandler = optsOrHandler as (answer: string) => void;
  } else if (optsOrHandler && typeof optsOrHandler === "object") {
    signal = (optsOrHandler as any).signal;
    actualHandler = handler;
  } else {
    actualHandler = handler;
  }

  if (!actualHandler) return;

  if (signal?.aborted) {
    const err = new DOMException("The operation was aborted", "AbortError");
    throw err;
  }

  if (this.output && typeof (this.output as any).write === "function") {
    (this.output as any).write(query);
  }

  if (this.input && typeof (this.input as any).on === "function") {
    const entry: any = { query, handler: actualHandler, signal };

    if (signal) {
      const onAbort = () => {
        const idx = this._pendingQuestions.indexOf(entry);
        if (idx !== -1) this._pendingQuestions.splice(idx, 1);
        actualHandler!("");
      };
      entry.abortListener = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }

    this._pendingQuestions.push(entry);
  } else {
    setTimeout(() => actualHandler!(""), 0);
  }
};

Interface.prototype.pause = function pause(this: any): any {
  if (this.input && typeof (this.input as any).pause === "function") {
    (this.input as any).pause();
  }
  this.emit("pause");
  return this;
};

Interface.prototype.resume = function resume(this: any): any {
  if (this.input && typeof (this.input as any).resume === "function") {
    (this.input as any).resume();
  }
  this.emit("resume");
  return this;
};

// node's Interface.ref/unref lets users opt out of keeping the loop alive
// while the interface is still open. forward to our Handle.
Interface.prototype.ref = function ref(this: any): any {
  const h = (this as any)._elHandle as Handle | undefined;
  if (h) h.ref();
  return this;
};

Interface.prototype.unref = function unref(this: any): any {
  const h = (this as any)._elHandle as Handle | undefined;
  if (h) h.unref();
  return this;
};

Interface.prototype.close = function close(this: any): void {
  if (this.closed) return;
  this.closed = true;
  // put raw mode back how it was
  if (this.terminal && this.input && typeof (this.input as any).setRawMode === "function") {
    (this.input as any).setRawMode(false);
  }
  if (this.input && typeof (this.input as any).on === "function") {
    _activeInterfaceCount = Math.max(0, _activeInterfaceCount - 1);
    const h = (this as any)._elHandle as Handle | undefined;
    if (h) {
      h.close();
      (this as any)._elHandle = undefined;
    }
    // drop the listeners we put on input. otherwise a long-lived stdin keeps
    // a stack of dead handlers (keypress/data/end) from every past readline,
    // which starts interfering with later ones on the same stdin (e.g.
    // create-vite's prompts vs vite's q-shortcut).
    const installed = (this as any)._installedListeners as
      | Array<{ evt: string; fn: (...a: any[]) => void }>
      | undefined;
    if (installed && typeof (this.input as any).removeListener === "function") {
      for (const { evt, fn } of installed) {
        try { (this.input as any).removeListener(evt, fn); } catch { /* ignore */ }
      }
      installed.length = 0;
    }
    // pause the input so the process can exit once the readline is gone.
    // node's stdin handle unrefs on pause and releases the loop.
    if (typeof (this.input as any).pause === "function") {
      try { (this.input as any).pause(); } catch { /* ignore */ }
    }
  }
  // answer any pending questions with empty string
  for (const q of this._pendingQuestions) {
    if (q.signal && q.abortListener) {
      q.signal.removeEventListener("abort", q.abortListener);
    }
    q.handler("");
  }
  this._pendingQuestions.length = 0;
  this.emit("close");
};

// `using rl = ...` support
if (typeof Symbol.dispose !== "undefined") {
  (Interface.prototype as any)[Symbol.dispose] = function (this: any): void {
    this.close();
  };
}

Interface.prototype.write = function write(
  this: any,
  data: string | null,
  _key?: {
    ctrl?: boolean;
    name?: string;
    meta?: boolean;
    shift?: boolean;
    sequence?: string;
  },
): void {
  if (this.closed) return;

  if (data === null || data === undefined) {
    if (_key) {
      // fire a keypress on input so things like @clack pick it up
      const emitOnInput =
        this.input && typeof (this.input as any).emit === "function";

      if (_key.ctrl && _key.name === "c") {
        if (this.listenerCount("SIGINT") > 0) {
          this.emit("SIGINT");
        } else {
          this.close();
        }
        return;
      }
      if (_key.ctrl && _key.name === "h") {
        if (this.cursor > 0) {
          this._lineBuffer =
            this._lineBuffer.slice(0, this.cursor - 1) +
            this._lineBuffer.slice(this.cursor);
          this.cursor--;
          this.line = this._lineBuffer;
        }
        if (emitOnInput) {
          (this.input as any).emit("keypress", "\x7f", {
            sequence: "\x7f",
            name: "backspace",
            ctrl: false,
            meta: false,
            shift: false,
          });
        }
        return;
      }
      if (_key.ctrl && _key.name === "u") {
        const killed = this._lineBuffer.slice(0, this.cursor);
        if (killed) this._killRing.push(killed);
        this._lineBuffer = this._lineBuffer.slice(this.cursor);
        this.cursor = 0;
        this.line = this._lineBuffer;
        return;
      }
      if (_key.ctrl && _key.name === "k") {
        const killed = this._lineBuffer.slice(this.cursor);
        if (killed) this._killRing.push(killed);
        this._lineBuffer = this._lineBuffer.slice(0, this.cursor);
        this.line = this._lineBuffer;
        return;
      }
      if (_key.ctrl && _key.name === "w") {
        const newPos = wordLeft(this._lineBuffer, this.cursor);
        const killed = this._lineBuffer.slice(newPos, this.cursor);
        if (killed) this._killRing.push(killed);
        this._lineBuffer =
          this._lineBuffer.slice(0, newPos) +
          this._lineBuffer.slice(this.cursor);
        this.cursor = newPos;
        this.line = this._lineBuffer;
        return;
      }
      if (_key.ctrl && _key.name === "y") {
        if (this._killRing.length > 0) {
          const text = this._killRing[this._killRing.length - 1];
          this._lineBuffer =
            this._lineBuffer.slice(0, this.cursor) +
            text +
            this._lineBuffer.slice(this.cursor);
          this.cursor += text.length;
          this.line = this._lineBuffer;
        }
        return;
      }
      if (_key.ctrl && _key.name === "a") {
        this.cursor = 0;
        return;
      }
      if (_key.ctrl && _key.name === "e") {
        this.cursor = this._lineBuffer.length;
        return;
      }
      if (_key.ctrl && _key.name === "b") {
        this.cursor = Math.max(0, this.cursor - 1);
        return;
      }
      if (_key.ctrl && _key.name === "f") {
        this.cursor = Math.min(this._lineBuffer.length, this.cursor + 1);
        return;
      }
      if (_key.ctrl && _key.name === "d") {
        if (this._lineBuffer.length === 0) {
          this.close();
        } else if (this.cursor < this._lineBuffer.length) {
          this._lineBuffer =
            this._lineBuffer.slice(0, this.cursor) +
            this._lineBuffer.slice(this.cursor + 1);
          this.line = this._lineBuffer;
        }
        return;
      }
      if (_key.ctrl && _key.name === "l") {
        if (this.output && typeof (this.output as any).write === "function") {
          (this.output as any).write("\x1b[2J\x1b[H");
        }
        return;
      }
      if (_key.name === "left") {
        if (_key.ctrl || _key.meta) {
          this.cursor = wordLeft(this._lineBuffer, this.cursor);
        } else {
          this.cursor = Math.max(0, this.cursor - 1);
        }
        return;
      }
      if (_key.name === "right") {
        if (_key.ctrl || _key.meta) {
          this.cursor = wordRight(this._lineBuffer, this.cursor);
        } else {
          this.cursor = Math.min(this._lineBuffer.length, this.cursor + 1);
        }
        return;
      }
      if (_key.name === "home") {
        this.cursor = 0;
        return;
      }
      if (_key.name === "end") {
        this.cursor = this._lineBuffer.length;
        return;
      }
      if (_key.name === "up") {
        if (this.history.length > 0 && this._historyIndex < this.history.length - 1) {
          if (this._historyIndex === -1) this._savedLine = this._lineBuffer;
          this._historyIndex++;
          this._lineBuffer = this.history[this._historyIndex];
          this.cursor = this._lineBuffer.length;
          this.line = this._lineBuffer;
        }
        return;
      }
      if (_key.name === "down") {
        if (this._historyIndex > 0) {
          this._historyIndex--;
          this._lineBuffer = this.history[this._historyIndex];
          this.cursor = this._lineBuffer.length;
          this.line = this._lineBuffer;
        } else if (this._historyIndex === 0) {
          this._historyIndex = -1;
          this._lineBuffer = this._savedLine;
          this.cursor = this._lineBuffer.length;
          this.line = this._lineBuffer;
        }
        return;
      }
      if (_key.meta && _key.name === "b") {
        this.cursor = wordLeft(this._lineBuffer, this.cursor);
        return;
      }
      if (_key.meta && _key.name === "f") {
        this.cursor = wordRight(this._lineBuffer, this.cursor);
        return;
      }
      if (_key.meta && _key.name === "d") {
        const newPos = wordRight(this._lineBuffer, this.cursor);
        const killed = this._lineBuffer.slice(this.cursor, newPos);
        if (killed) this._killRing.push(killed);
        this._lineBuffer =
          this._lineBuffer.slice(0, this.cursor) +
          this._lineBuffer.slice(newPos);
        this.line = this._lineBuffer;
        return;
      }
    }
    return;
  }

  if (_key?.ctrl && _key?.name === "c") {
    if (this.listenerCount("SIGINT") > 0) {
      this.emit("SIGINT");
    } else {
      this.close();
    }
    return;
  }

  this._onData(data);
};

// @inquirer calls rl.clearLine(0) directly so we need this on the interface
Interface.prototype.clearLine = function clearLine(this: any, dir?: number): void {
  this._lineBuffer = "";
  this.line = "";
  this.cursor = 0;
  if (this.output && typeof (this.output as any).clearLine === "function") {
    (this.output as any).clearLine(dir ?? 0);
  }
};

Interface.prototype.getCursorPos = function getCursorPos(this: any): { rows: number; cols: number } {
  // cursor position relative to prompt, wrapping at terminal width
  const promptLen = typeof this._promptStr === "string" ? this._promptStr.length : 0;
  const columns = (this.output && (this.output as any).columns) || 80;
  const offset = promptLen + this.cursor;
  return {
    rows: Math.floor(offset / columns),
    cols: offset % columns,
  };
};

// Lines are queued from the moment the iterator is created: a chunk holding
// several lines emits them all at once, before the loop asks for the next.
// Leaving the loop early closes the interface, as in node.
Interface.prototype[Symbol.asyncIterator] = function (this: any): AsyncIterableIterator<string> {
  const self = this;
  const queued: string[] = [];
  // next() calls made before their line arrived, oldest first
  const waiting: Array<(result: IteratorResult<string>) => void> = [];
  let done = !!self.closed;
  const finish = () => {
    for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true });
  };
  const onLine = (line: string) => {
    const resolve = waiting.shift();
    if (resolve) resolve({ value: line, done: false });
    else queued.push(line);
  };
  const onClose = () => {
    done = true;
    self.removeListener("line", onLine);
    finish();
  };
  if (!done) {
    self.on("line", onLine);
    self.once("close", onClose);
  }
  const iterator: AsyncIterableIterator<string> = {
    next(): Promise<IteratorResult<string>> {
      if (queued.length > 0) return Promise.resolve({ value: queued.shift()!, done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        waiting.push(resolve);
      });
    },
    return(): Promise<IteratorResult<string>> {
      self.removeListener("line", onLine);
      self.removeListener("close", onClose);
      done = true;
      queued.length = 0;
      finish();
      if (!self.closed) self.close();
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
};


export function createInterface(
  cfgOrInput?: InterfaceConfig | unknown,
  output?: unknown,
): Interface {
  if (
    cfgOrInput &&
    typeof cfgOrInput === "object" &&
    !("on" in (cfgOrInput as any)) &&
    !("read" in (cfgOrInput as any))
  ) {
    return new Interface(cfgOrInput as InterfaceConfig);
  }
  return new Interface({ input: cfgOrInput, output });
}


export function clearLine(
  stream: unknown,
  dir: number,
  done?: () => void,
): boolean {
  if (stream && typeof (stream as any).clearLine === "function") {
    return (stream as any).clearLine(dir, done);
  }
  if (done) done();
  return true;
}

export function clearScreenDown(stream: unknown, done?: () => void): boolean {
  if (stream && typeof (stream as any).write === "function") {
    (stream as any).write("\x1b[J");
  }
  if (done) done();
  return true;
}

export function cursorTo(
  stream: unknown,
  x: number,
  yOrDone?: number | (() => void),
  done?: () => void,
): boolean {
  const cb = typeof yOrDone === "function" ? yOrDone : done;
  if (stream && typeof (stream as any).cursorTo === "function") {
    return (stream as any).cursorTo(
      x,
      typeof yOrDone === "number" ? yOrDone : undefined,
      cb,
    );
  }
  if (cb) cb();
  return true;
}

export function moveCursor(
  stream: unknown,
  dx: number,
  dy: number,
  done?: () => void,
): boolean {
  if (stream && typeof (stream as any).moveCursor === "function") {
    return (stream as any).moveCursor(dx, dy, done);
  }
  if (done) done();
  return true;
}


// promises API

class ReadlineWriter {
  private _stream: any;
  private _buffer: string[];
  private _autoCommit: boolean;

  constructor(stream: any, opts?: { autoCommit?: boolean }) {
    this._stream = stream;
    this._buffer = [];
    this._autoCommit = opts?.autoCommit ?? false;
  }

  clearLine(dir: -1 | 0 | 1): this {
    let seq: string;
    if (dir === -1) seq = "\x1b[1K";
    else if (dir === 1) seq = "\x1b[0K";
    else seq = "\x1b[2K";
    if (this._autoCommit) {
      this._stream.write(seq);
    } else {
      this._buffer.push(seq);
    }
    return this;
  }

  clearScreenDown(): this {
    const seq = "\x1b[J";
    if (this._autoCommit) {
      this._stream.write(seq);
    } else {
      this._buffer.push(seq);
    }
    return this;
  }

  cursorTo(x: number, y?: number): this {
    let seq: string;
    if (y !== undefined) {
      seq = `\x1b[${y + 1};${x + 1}H`;
    } else {
      seq = `\x1b[${x + 1}G`;
    }
    if (this._autoCommit) {
      this._stream.write(seq);
    } else {
      this._buffer.push(seq);
    }
    return this;
  }

  moveCursor(dx: number, dy: number): this {
    const parts: string[] = [];
    if (dx > 0) parts.push(`\x1b[${dx}C`);
    else if (dx < 0) parts.push(`\x1b[${-dx}D`);
    if (dy > 0) parts.push(`\x1b[${dy}B`);
    else if (dy < 0) parts.push(`\x1b[${-dy}A`);
    const seq = parts.join("");
    if (seq) {
      if (this._autoCommit) {
        this._stream.write(seq);
      } else {
        this._buffer.push(seq);
      }
    }
    return this;
  }

  commit(): Promise<void> {
    if (this._buffer.length > 0) {
      this._stream.write(this._buffer.join(""));
      this._buffer.length = 0;
    }
    return Promise.resolve();
  }

  rollback(): this {
    this._buffer.length = 0;
    return this;
  }
}

export const promises = {
  createInterface(cfg?: InterfaceConfig): any {
    const rl = createInterface(cfg);
    const wrapper: any = Object.create(rl);

    wrapper.question = function (
      query: string,
      opts?: { signal?: AbortSignal },
    ): Promise<string> {
      return new Promise((resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new DOMException("The operation was aborted", "AbortError"));
          return;
        }

        let onAbort: (() => void) | undefined;

        const handler = (answer: string) => {
          if (opts?.signal && onAbort) {
            opts.signal.removeEventListener("abort", onAbort);
          }
          resolve(answer);
        };

        if (opts?.signal) {
          onAbort = () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }

        rl.question(query, handler);
      });
    };

    return wrapper;
  },

  Readline: ReadlineWriter,
};


export default {
  Interface,
  createInterface,
  clearLine,
  clearScreenDown,
  cursorTo,
  moveCursor,
  emitKeypressEvents,
  promises,
};
