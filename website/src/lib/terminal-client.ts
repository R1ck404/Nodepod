import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export interface TerminalSession {
  run(command: string): void;
  teardown(): void;
}

const files = {
  "/home/project/hello.js": [
    "const place = 'the browser';",
    "console.log(`Hello from Node.js, inside ${place}.`);",
  ].join("\n"),
  "/home/project/README.md": [
    "# nodepod demo",
    "",
    "This project lives only in this browser tab.",
    "Try `node hello.js`, `ls`, `cat README.md`, or `npx cowsay hi`.",
    "",
  ].join("\n"),
  "/home/project/files.js": [
    "const fs = require('fs');",
    "fs.writeFileSync('note.txt', 'Written by Node.js in the browser.\\n');",
    "console.log(fs.readFileSync('note.txt', 'utf8'));",
  ].join("\n"),
};

export async function createTerminalSession(root: HTMLElement): Promise<TerminalSession> {
  const mount = root.querySelector<HTMLElement>("[data-terminal-mount]");
  if (!mount) throw new Error("Terminal mount is unavailable.");
  mount.replaceChildren();

  const { Nodepod } = await import("@r1ck404/nodepod");
  const nodepod = await Nodepod.boot({
    serviceWorker: false,
    enableSharedArrayBuffer: false,
    watermark: false,
    workdir: "/home/project",
    files,
  });
  const terminal = nodepod.createTerminal({
    Terminal,
    FitAddon,
    fontSize: 14,
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    theme: {
      background: "#0B0B0C",
      foreground: "#F6F2EA",
      cursor: "#FF6257",
      selectionBackground: "#3B3A39",
      black: "#0B0B0C",
      red: "#FF6257",
      green: "#9ECF9A",
      yellow: "#E6C36A",
      blue: "#8EB8DD",
      magenta: "#C8A0D8",
      cyan: "#84CFCA",
      white: "#F6F2EA",
    },
  });
  terminal.attach(mount);

  return {
    run(command) {
      if (command) terminal.input(`${command}\r`);
    },
    teardown() {
      terminal.detach();
      nodepod.teardown();
      mount.replaceChildren();
      root.dataset.teardownCount = String(Number(root.dataset.teardownCount ?? "0") + 1);
    },
  };
}
