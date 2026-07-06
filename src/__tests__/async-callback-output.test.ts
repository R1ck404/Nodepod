import { describe, it, expect } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  executeNodeBinary,
  initShellExec,
} from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

function setup(files: Record<string, string>) {
  const vol = new MemoryVolume();
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  initShellExec(vol, { cwd: "/" });
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return { vol, ctx };
}

describe("async callback output (spawn examples)", () => {
  it("brotliCompress callback logs before process exits", async () => {
    const { ctx } = setup({
      "/test-async-only.js": `
const { brotliCompress } = require('zlib');
brotliCompress('hello brotli async', (err, result) => {
  if (err) console.error('FAIL: ' + err.message);
  else console.log('PASS: async compress returned ' + result.length + ' bytes');
});
      `.trim(),
    });
    const r = await executeNodeBinary("/test-async-only.js", [], ctx);
    expect(r.stdout).toContain("PASS:");
    expect(r.exitCode).toBe(0);
  });

  it("top-level await preloadSqlite logs before process exits", async () => {
    const { ctx } = setup({
      "/sqlite-app.js": `
const { DatabaseSync, preloadSqlite } = require('node:sqlite');
if (!(await preloadSqlite())) {
  console.log('__SQLITE_JSON__' + JSON.stringify({ type: 'error', message: 'wasm fail' }));
  process.exit(1);
}
const cmd = process.argv[2] || 'list';
if (cmd !== 'init') {
  console.log('__SQLITE_JSON__' + JSON.stringify({ type: 'error', message: 'expected init got ' + cmd }));
  process.exit(1);
}
const db = new DatabaseSync('/data.db');
db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
db.prepare('INSERT INTO t (v) VALUES (?)').run('ok');
console.log('__SQLITE_JSON__' + JSON.stringify({ type: 'log', message: 'added row' }));
db.close();
      `.trim(),
    });
    const r = await executeNodeBinary("/sqlite-app.js", ["init"], ctx);
    expect(r.stdout).toContain("added row");
    expect(r.exitCode).toBe(0);
  });
});
