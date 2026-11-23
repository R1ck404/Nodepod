// node:test and `node --test`, checked against native Node where the result is deterministic:
// the summary counts, exit codes, the order tests and hooks run in, and which tests a run finds.
// Durations and stack traces differ by nature and are not compared.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryVolume } from "../memory-volume";
import { executeNodeBinary, initShellExec, shellExec } from "../polyfills/child_process";
import type { ShellContext } from "../shell/shell-types";

type Files = Record<string, string>;
type Run = { stdout: string; stderr: string; exitCode: number };

const nativeDirs: string[] = [];
afterAll(() => {
  for (const dir of nativeDirs) rmSync(dir, { recursive: true, force: true });
});

function nodepodVolume(files: Files): MemoryVolume {
  const vol = new MemoryVolume();
  for (const [path, content] of Object.entries(files)) {
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    if (dir !== "/") vol.mkdirSync(dir, { recursive: true });
    vol.writeFileSync(path, content);
  }
  initShellExec(vol, { cwd: "/" });
  return vol;
}

async function nodepodFile(source: string): Promise<Run> {
  const vol = nodepodVolume({ "/case.test.js": source });
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return executeNodeBinary("/case.test.js", [], ctx);
}

function nodepodShell(files: Files, command: string): Promise<Run> {
  nodepodVolume(files);
  return new Promise((resolve) =>
    shellExec(command, {}, (err, stdout, stderr) =>
      resolve({ stdout, stderr, exitCode: err ? Number((err as { code?: number }).code ?? 1) : 0 }),
    ),
  );
}

/** Writes `files` (paths under /w) to a temporary folder and runs native Node there. */
function native(files: Files, args: string[]): Run {
  const dir = mkdtempSync(join(tmpdir(), "nodepod-node-test-"));
  nativeDirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path.replace(/^\/w\/?/, ""));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 1 };
}

function nativeFile(source: string): Run {
  return native({ "/w/case.test.js": source }, ["--test-reporter=spec", "case.test.js"]);
}

/** The ℹ summary counts, without the duration. */
function summary(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of stdout.matchAll(/^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/gm)) {
    counts[m[1]] = (counts[m[1]] ?? 0) + Number(m[2]);
  }
  return counts;
}

/** Lines the test code printed itself (prefixed with LOG), in order. */
const logged = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("LOG "));

/** Names of the tests reported as passing. */
const passed = (stdout: string) =>
  [...stdout.matchAll(/^\s*✔ (.+?) \([\d.]+ms\)$/gm)].map((m) => m[1]).sort();

const HEADER = "const { test, describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');\n" +
  "const assert = require('node:assert');\n";

const cases: Array<[string, string]> = [
  [
    "queues tests until the module body has finished",
    `let ran = false;
     test('first', () => { ran = true; console.log('LOG in test'); });
     console.log('LOG body end, ran=' + ran);`,
  ],
  [
    "nested suites, hooks, async and callback tests, skip, todo and subtests",
    `const order = [];
     before(() => order.push('before'));
     after(() => console.log('LOG ' + order.join(',')));
     describe('outer', () => {
       beforeEach(() => order.push('beforeEach'));
       afterEach(() => order.push('afterEach'));
       it('first', () => order.push('first'));
       describe('inner', () => {
         it('async', async () => { await new Promise((r) => setTimeout(r, 5)); order.push('async'); });
         it('callback', (t, done) => { setTimeout(() => { order.push('callback'); done(); }, 1); });
       });
       it.skip('skipped', () => order.push('BAD'));
       it.todo('later');
       it('subtests', async (t) => { await t.test('child', () => order.push('child')); });
     });`,
  ],
  [
    "a failing assertion fails the run",
    `describe('math', () => {
       it('adds', () => assert.strictEqual(1 + 1, 2));
       it('breaks', () => assert.strictEqual(1, 2));
     });
     test('after the failure', () => {});`,
  ],
  [
    "a test that times out fails",
    `test('slow', { timeout: 20 }, () => new Promise((r) => setTimeout(r, 1000)));
     test('fast', () => {});`,
  ],
  [
    "an error passed to done fails the test",
    `test('done with error', (t, done) => { setTimeout(() => done(new Error('boom')), 1); });`,
  ],
  [
    "t.skip() and t.todo() inside a test",
    `test('skips itself', (t) => { t.skip('not here'); });
     test('marks itself todo', (t) => { t.todo('soon'); });`,
  ],
  [
    "mock.fn and mock.method",
    `test('mocks', () => {
       const fn = mock.fn((a, b) => a + b);
       assert.strictEqual(fn(2, 3), 5);
       assert.strictEqual(fn.mock.callCount(), 1);
       assert.deepStrictEqual(fn.mock.calls[0].arguments, [2, 3]);
       const obj = { greet: () => 'hi' };
       const m = mock.method(obj, 'greet', () => 'mocked');
       assert.strictEqual(obj.greet(), 'mocked');
       assert.strictEqual(m.mock.callCount(), 1);
       mock.restoreAll();
       assert.strictEqual(obj.greet(), 'hi');
       console.log('LOG mocks ok');
     });`,
  ],
];

describe("node:test matches native Node", () => {
  it.each(cases)("%s", async (_name, body) => {
    const source = HEADER + body;
    const expected = nativeFile(source);
    const actual = await nodepodFile(source);
    expect(actual.exitCode).toBe(expected.exitCode);
    expect(summary(actual.stdout)).toEqual(summary(expected.stdout));
    expect(logged(actual.stdout)).toEqual(logged(expected.stdout));
    expect(passed(actual.stdout)).toEqual(passed(expected.stdout));
  });

  it("is the same callable function through require, default and named imports", async () => {
    const actual = await nodepodFile(
      `const t = require('node:test');
       console.log('LOG ' + [typeof t, t.test === t, typeof t.describe, typeof t.it, typeof t.mock.fn].join(','));`,
    );
    expect(logged(actual.stdout)).toEqual(["LOG function,true,function,function,function"]);
  });

  it("reports failures and sets the exit code", async () => {
    const actual = await nodepodFile(`${HEADER}test('breaks', () => assert.strictEqual(1, 2));`);
    expect(actual.exitCode).toBe(1);
    expect(actual.stdout).toMatch(/^✖ breaks \(/m);
    expect(actual.stdout).toContain("✖ failing tests:");
    expect(actual.stdout).toContain("test at breaks");
  });

  it("starts each script from an empty run when scripts share a realm", async () => {
    const first = await nodepodFile(`${HEADER}test('one', () => {});`);
    const second = await nodepodFile(`${HEADER}test('two', () => { throw new Error('x'); });`);
    expect(summary(first.stdout)).toMatchObject({ tests: 1, pass: 1, fail: 0 });
    expect(first.exitCode).toBe(0);
    expect(summary(second.stdout)).toMatchObject({ tests: 1, pass: 0, fail: 1 });
    expect(second.exitCode).toBe(1);
  });
});

describe("node --test", () => {
  const pass = (name: string) => `const test = require('node:test'); test('${name}', () => {});\n`;
  const fail = (name: string) => `const test = require('node:test'); test('${name}', () => { throw new Error('x'); });\n`;

  const tree: Files = {
    "/w/a.test.js": pass("a.test.js"),
    "/w/test-b.js": pass("test-b.js"),
    "/w/c_test.mjs": "import test from 'node:test';\ntest('c_test.mjs', () => {});\n",
    "/w/d-test.cjs": pass("d-test.cjs"),
    "/w/test.js": pass("test.js"),
    "/w/test/e.js": pass("test/e.js"),
    "/w/test/sub/f.cjs": pass("test/sub/f.cjs"),
    "/w/lib/helper.js": fail("lib/helper.js is not a test file"),
    "/w/node_modules/pkg/x.test.js": fail("node_modules is skipped"),
  };

  it("finds the same files as native Node", async () => {
    const expected = native(tree, ["--test", "--test-reporter=spec"]);
    const actual = await nodepodShell(tree, "cd /w && node --test");
    expect(actual.exitCode).toBe(0);
    expect(actual.exitCode).toBe(expected.exitCode);
    expect(passed(actual.stdout)).toEqual(passed(expected.stdout));
  });

  it("runs only the files given", async () => {
    const expected = native(tree, ["--test", "--test-reporter=spec", "a.test.js", "lib/helper.js"]);
    const actual = await nodepodShell(tree, "cd /w && node --test a.test.js lib/helper.js");
    expect(actual.exitCode).toBe(expected.exitCode);
    expect(passed(actual.stdout)).toEqual(passed(expected.stdout));
    expect(passed(actual.stdout)).toEqual(["a.test.js"]);
  });

  // Node 20 searches a folder given on the command line; Node 22 reads arguments as glob patterns.
  it("searches a folder given on the command line", async () => {
    const actual = await nodepodShell(tree, "cd /w && node --test test");
    expect(actual.exitCode).toBe(0);
    expect(passed(actual.stdout)).toEqual(["test/e.js", "test/sub/f.cjs"]);
  });

  it("exits 1 when any file fails, and still runs the others", async () => {
    const files = { "/w/ok.test.js": pass("ok"), "/w/bad.test.js": fail("bad") };
    const expected = native(files, ["--test", "--test-reporter=spec"]);
    const actual = await nodepodShell(files, "cd /w && node --test");
    expect(actual.exitCode).toBe(1);
    expect(actual.exitCode).toBe(expected.exitCode);
    expect(passed(actual.stdout)).toEqual(["ok"]);
    expect(actual.stdout).toMatch(/✖ bad/);
  });

  it("accepts --test-* options", async () => {
    const actual = await nodepodShell(
      { "/w/a.test.js": pass("a") },
      "cd /w && node --test --test-reporter spec --test-concurrency=1 a.test.js",
    );
    expect(actual.exitCode).toBe(0);
    expect(passed(actual.stdout)).toEqual(["a"]);
  });

  // A switch takes no value, so the file after it still runs.
  it.each(["--test-force-exit", "--test-update-snapshots"])("runs the file after %s, as Node does", async (flag) => {
    const files = { "/w/a.test.js": pass("a"), "/w/other.test.js": pass("other") };
    const expected = native(files, ["--test", "--test-reporter=spec", flag, "a.test.js"]);
    const actual = await nodepodShell(files, `cd /w && node --test ${flag} a.test.js`);
    expect(actual.exitCode).toBe(expected.exitCode);
    expect(passed(actual.stdout)).toEqual(passed(expected.stdout));
    expect(passed(actual.stdout)).toEqual(["a"]);
  });

  // Nodepod accepts --test-only without filtering by `only`, so this checks only which file runs.
  it("runs the file after --test-only", async () => {
    const files = { "/w/a.test.js": pass("a"), "/w/other.test.js": pass("other") };
    const actual = await nodepodShell(files, "cd /w && node --test --test-only a.test.js");
    expect(actual.exitCode).toBe(0);
    expect(passed(actual.stdout)).toEqual(["a"]);
  });

  it("skips the value of an option given as a separate word", async () => {
    const files = { "/w/a.test.js": pass("a"), "/w/other.test.js": pass("other") };
    const actual = await nodepodShell(
      files,
      "cd /w && node --test --test-name-pattern a --test-timeout 5000 --test-shard 1/1 a.test.js",
    );
    expect(actual.exitCode).toBe(0);
    expect(passed(actual.stdout)).toEqual(["a"]);
  });

  it("fails for a path that does not exist", async () => {
    const actual = await nodepodShell({ "/w/a.test.js": pass("a") }, "cd /w && node --test missing.test.js");
    expect(actual.exitCode).toBe(1);
    expect(actual.stderr).toContain("Could not find '/w/missing.test.js'");
  });
});
