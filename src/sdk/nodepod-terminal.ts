// Interactive terminal with line editing, history, raw/cooked mode, etc.
// xterm.js is a peer dep -- passed in via TerminalOptions, not imported here.

import type { TerminalOptions, TerminalTheme } from "./types";
import { DEFAULT_TERMINAL } from "../constants/config";

// GitHub Dark theme
const DEFAULT_THEME: TerminalTheme = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#0d1117",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#8b949e",
  brightRed: "#f85149",
  brightGreen: "#3fb950",
  brightYellow: "#d29922",
  brightBlue: "#58a6ff",
  brightMagenta: "#bc8cff",
  brightCyan: "#39c5cf",
  brightWhite: "#ffffff",
};

const DEFAULT_PROMPT = (cwd: string) =>
  `\x1b[36mnodepod\x1b[0m:\x1b[34m${cwd}\x1b[0m$ `;

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  if (strs.length === 1) return strs[0];
  let prefix = strs[0];
  for (let i = 1; i < strs.length && prefix.length > 0; i++) {
    const s = strs[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

// Wired by Nodepod.createTerminal()
export interface TerminalWiring {
  onCommand: (cmd: string) => Promise<void>;
  getSendStdin: () => ((data: string) => void) | null;
  getIsStdinRaw: () => boolean;
  getActiveAbort: () => AbortController | null;
  setActiveAbort: (ac: AbortController | null) => void;
  /** tab-completion hook. returns candidates + the slice to replace. */
  getCompletions?: (
    line: string,
    cursorPos: number,
    cwd: string,
  ) => {
    token: string;
    tokenStart: number;
    matches: string[];
  };
  /** called after xterm reflows so the worker side (and any TUI running
   * inside it) can update process.stdout.columns/rows and fire 'resize'. */
  onResize?: (cols: number, rows: number) => void;
}

export class NodepodTerminal {
  private _term: any = null;
  private _fitAddon: any = null;
  private _serializeAddon: any = null;
  private _serializedBuffer = "";
  private _dataDisposable: any = null;
  private _xtermResizeDisposable: any = null;
  private _resizeHandler: (() => void) | null = null;
  private _resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  private _lastNotifiedCols = -1;
  private _lastNotifiedRows = -1;

  private _lineBuffer = "";
  private _history: string[] = [];
  private _historyIndex = -1;
  private _savedLine = "";
  private _running = false;
  private _cwd = "/";

  private _promptFn: (cwd: string) => string;
  private _theme: TerminalTheme;
  private _opts: TerminalOptions;
  private _wiring: TerminalWiring | null = null;

  constructor(opts: TerminalOptions) {
    this._opts = opts;
    this._theme = opts.theme ?? DEFAULT_THEME;
    this._promptFn = opts.prompt ?? DEFAULT_PROMPT;
  }

  /* ---- Internal wiring ---- */

  _wireExecution(wiring: TerminalWiring): void {
    this._wiring = wiring;
  }

  _setRunning(running: boolean): void {
    this._running = running;
  }

  _writePrompt(): void {
    this._term?.write(this._promptFn(this._cwd));
  }

  _getCols(): number {
    return this._term?.cols ?? 80;
  }

  _getRows(): number {
    return this._term?.rows ?? 24;
  }

  _writeOutput(text: string, isError = false): void {
    if (!this._term) return;
    const escaped = text.replace(/\r?\n/g, "\r\n");
    if (isError) {
      this._term.write("\x1b[31m" + escaped + "\x1b[0m");
    } else {
      this._term.write(escaped);
    }
  }

  /* ---- Public API ---- */

  attach(target: HTMLElement | string): void {
    const container =
      typeof target === "string"
        ? (document.querySelector(target) as HTMLElement)
        : target;
    if (!container) throw new Error(`Terminal target not found: ${target}`);

    const TermCtor = this._opts.Terminal;

    this._term = new TermCtor({
      cursorBlink: true,
      fontSize: this._opts.fontSize ?? DEFAULT_TERMINAL.FONT_SIZE,
      fontFamily:
        this._opts.fontFamily ??
        '"Cascadia Code", "Fira Code", "Consolas", "Monaco", monospace',
      theme: this._theme,
    });

    if (this._opts.FitAddon) {
      this._fitAddon = new this._opts.FitAddon();
      this._term.loadAddon(this._fitAddon);
    }

    if (this._opts.SerializeAddon) {
      this._serializeAddon = new this._opts.SerializeAddon();
      this._term.loadAddon(this._serializeAddon);
    }

    this._term.open(container);

    if (this._serializedBuffer) {
      this._term.write(this._serializedBuffer);
    }

    if (this._opts.WebglAddon) {
      try {
        this._term.loadAddon(new this._opts.WebglAddon());
      } catch {
        // canvas fallback is fine
      }
    }

    if (this._fitAddon) {
      // Defer fit() so the container has final layout dimensions,
      // otherwise interactive CLIs get wrong cols/rows
      const addon = this._fitAddon;
      requestAnimationFrame(() => {
        addon.fit();
        // second fit covers the case where the container was still
        // laying out when the first fit ran
        setTimeout(() => {
          addon.fit();
          this._notifyResize();
        }, 100);
      });
      this._resizeHandler = () => this._fitAddon?.fit();
      window.addEventListener("resize", this._resizeHandler);
    }

    // xterm fires onResize after any fit(), container size change, or
    // manual term.resize(). debounced so dragging the window doesn't spam
    // the worker channel.
    this._xtermResizeDisposable = this._term.onResize?.(() => {
      this._scheduleResizeNotify();
    });

    this._dataDisposable = this._term.onData((data: string) =>
      this._handleInput(data),
    );

    this._term.focus();
  }

  private _scheduleResizeNotify(): void {
    if (this._resizeDebounce) clearTimeout(this._resizeDebounce);
    this._resizeDebounce = setTimeout(() => {
      this._resizeDebounce = null;
      this._notifyResize();
    }, 80);
  }

  private _notifyResize(): void {
    if (!this._term || !this._wiring?.onResize) return;
    const cols = this._term.cols;
    const rows = this._term.rows;
    if (!cols || !rows) return;
    if (cols === this._lastNotifiedCols && rows === this._lastNotifiedRows) return;
    this._lastNotifiedCols = cols;
    this._lastNotifiedRows = rows;
    try {
      this._wiring.onResize(cols, rows);
    } catch {
      // wiring threw, nothing we can do from the terminal side
    }
  }

  detach(): void {
    if (this._dataDisposable) {
      this._dataDisposable.dispose();
      this._dataDisposable = null;
    }
    if (this._xtermResizeDisposable) {
      this._xtermResizeDisposable.dispose?.();
      this._xtermResizeDisposable = null;
    }
    if (this._resizeDebounce) {
      clearTimeout(this._resizeDebounce);
      this._resizeDebounce = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._serializeAddon) {
      this._serializedBuffer = this._serializeAddon.serialize();
      this._serializeAddon = null;
    }
    if (this._term) {
      this._term.dispose();
      this._term = null;
    }
    this._fitAddon = null;
  }

  clear(): void {
    if (!this._term) return;
    this._term.clear();
    if (!this._running) this._term.write(this._promptFn(this._cwd));
  }

  input(text: string): void {
    if (!this._term) return;
    for (const ch of text) {
      this._handleInput(ch);
    }
  }

  setTheme(theme: Partial<TerminalTheme>): void {
    this._theme = { ...this._theme, ...theme };
    if (this._term) this._term.options.theme = this._theme;
  }

  fit(): void {
    this._fitAddon?.fit();
  }

  serialize(): string {
    if (this._serializeAddon) {
      return this._serializeAddon.serialize();
    }
    return this._serializedBuffer;
  }

  write(text: string): void {
    this._term?.write(text);
  }

  writeln(text: string): void {
    this._term?.writeln(text);
  }

  showPrompt(): void {
    this._term?.write(this._promptFn(this._cwd));
  }

  setCwd(cwd: string): void {
    this._cwd = cwd;
  }

  getCwd(): string {
    return this._cwd;
  }

  get xterm(): any {
    return this._term;
  }

  /* ---- Input handling ---- */

  private _handleInput(data: string): void {
    if (!this._term) return;

    if (this._running) {
      // Ctrl+C
    if (data.includes("\x03")) {
      const isRaw = this._wiring?.getIsStdinRaw() ?? false;
      const sendStdin = this._wiring?.getSendStdin();

      // raw TUI apps handle ctrl+c themselves (often need two presses to quit)
      if (isRaw && sendStdin) {
        sendStdin(data);
        return;
      }

      const abort = this._wiring?.getActiveAbort();
        if (abort) {
          abort.abort();
          // Don't clear activeAbort -- nodepod.ts checks it to skip duplicate prompt
        }
        this._term.write("^C\r\n");
        this._running = false;
        this._writePrompt();
        return;
      }

      const isRaw = this._wiring?.getIsStdinRaw() ?? false;
      const sendStdin = this._wiring?.getSendStdin();

      if (isRaw && sendStdin) {
        sendStdin(data);
      } else if (sendStdin) {
        // Cooked mode: local echo + line buffering
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          const code = ch.charCodeAt(0);
          if (ch === "\r" || ch === "\n") {
            this._term.write("\r\n");
            sendStdin("\n");
          } else if (code === 127 || code === 8) {
            this._term.write("\b \b");
            sendStdin("\x7f");
          } else if (code >= 32) {
            this._term.write(ch);
            sendStdin(ch);
          } else {
            // Control chars -- send remainder as-is
            sendStdin(data.slice(i));
            break;
          }
        }
      }
      return;
    }

    // Line editing mode
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);

      if (ch === "\r" || ch === "\n") {
        const cmd = this._lineBuffer;
        this._lineBuffer = "";
        this._historyIndex = -1;
        this._executeCommand(cmd);
      } else if (code === 127 || code === 8) {
        if (this._lineBuffer.length > 0) {
          this._lineBuffer = this._lineBuffer.slice(0, -1);
          this._term.write("\b \b");
        }
      } else if (code === 3) {
        this._lineBuffer = "";
        this._term.write("^C");
        this._writePrompt();
      } else if (code === 12) {
        this._term.clear();
        this._term.write(this._promptFn(this._cwd) + this._lineBuffer);
      } else if (ch === "\x1b" && i + 2 < data.length && data[i + 1] === "[") {
        const arrow = data[i + 2];
        i += 2;
        if (arrow === "A") this._historyUp();
        else if (arrow === "B") this._historyDown();
      } else if (code === 9) {
        this._handleTab();
      } else if (code >= 32) {
        this._lineBuffer += ch;
        this._term.write(ch);
        this._tabCount = 0;
      }
    }
  }

  /* ---- History navigation ---- */

  private _historyUp(): void {
    if (this._history.length === 0) return;
    if (this._historyIndex === -1) {
      this._savedLine = this._lineBuffer;
      this._historyIndex = this._history.length - 1;
    } else if (this._historyIndex > 0) {
      this._historyIndex--;
    } else {
      return;
    }
    this._replaceLineWith(this._history[this._historyIndex]);
  }

  private _historyDown(): void {
    if (this._historyIndex === -1) return;
    if (this._historyIndex < this._history.length - 1) {
      this._historyIndex++;
      this._replaceLineWith(this._history[this._historyIndex]);
    } else {
      this._historyIndex = -1;
      this._replaceLineWith(this._savedLine);
    }
  }

  private _replaceLineWith(text: string): void {
    const prompt = this._promptFn(this._cwd);
    this._term.write(
      "\r" + prompt + " ".repeat(this._lineBuffer.length) + "\r" + prompt,
    );
    this._lineBuffer = text;
    this._term.write(text);
  }

  /* ---- tab completion ---- */

  // bash style: one match => insert it. several sharing a longer common
  // prefix => extend to that prefix. otherwise first tab does nothing,
  // second tab prints the list.
  private _tabCount = 0;

  private _handleTab(): void {
    const provider = this._wiring?.getCompletions;
    if (!provider) return;

    // cursor is always at the end — no mid-line editing yet
    const cursorPos = this._lineBuffer.length;
    let result;
    try {
      result = provider(this._lineBuffer, cursorPos, this._cwd);
    } catch {
      return;
    }
    const { token, tokenStart, matches } = result;
    if (!matches || matches.length === 0) {
      this._tabCount = 0;
      return;
    }

    // the completer adds a trailing ' ' or '/' as a hint. strip it so the
    // prefix math compares against the raw token.
    const rawMatches = matches.map((m) =>
      m.endsWith(" ") || m.endsWith("/") ? m.slice(0, -1) : m,
    );

    let insertion: string | null = null;
    if (matches.length === 1) {
      insertion = matches[0];
    } else {
      const lcp = longestCommonPrefix(rawMatches);
      if (lcp.length > token.length) {
        // extend to the shared prefix, no trailing space
        insertion = lcp;
      }
    }

    if (insertion !== null) {
      this._replaceToken(tokenStart, insertion);
      this._tabCount = 0;
      return;
    }

    // still ambiguous. first tab does nothing, second one prints the list.
    this._tabCount++;
    if (this._tabCount >= 2) {
      this._printMatches(matches);
      this._redrawLine();
      this._tabCount = 0;
    }
  }

  private _replaceToken(tokenStart: number, replacement: string): void {
    const oldLen = this._lineBuffer.length;
    const newBuffer = this._lineBuffer.slice(0, tokenStart) + replacement;
    // erase what's there, then write the replacement
    const toErase = oldLen - tokenStart;
    if (toErase > 0) {
      this._term.write("\b".repeat(toErase) + " ".repeat(toErase) + "\b".repeat(toErase));
    }
    this._term.write(replacement);
    this._lineBuffer = newBuffer;
  }

  private _printMatches(matches: string[]): void {
    // drop the trailing space on display
    const display = matches.map((m) =>
      m.endsWith(" ") ? m.slice(0, -1) : m,
    );
    this._term.write("\r\n");
    const cols = this._getCols();
    const maxLen = display.reduce((a, s) => Math.max(a, s.length), 0);
    const colWidth = maxLen + 2;
    const perRow = Math.max(1, Math.floor(cols / colWidth));
    for (let i = 0; i < display.length; i++) {
      const cell = display[i].padEnd(colWidth, " ");
      this._term.write(cell);
      if ((i + 1) % perRow === 0) this._term.write("\r\n");
    }
    if (display.length % perRow !== 0) this._term.write("\r\n");
  }

  private _redrawLine(): void {
    this._term.write(this._promptFn(this._cwd) + this._lineBuffer);
  }

  /* ---- Command execution ---- */

  private async _executeCommand(cmd: string): Promise<void> {
    if (!cmd.trim()) {
      this._term?.write("\r\n" + this._promptFn(this._cwd));
      return;
    }
    this._history.push(cmd);
    this._historyIndex = -1;
    this._running = true;

    if (this._wiring?.onCommand) {
      await this._wiring.onCommand(cmd);
    } else {
      this._running = false;
      this._writePrompt();
    }
  }
}
