// end-to-end exit-semantics tests. runs scripts through executeNodeBinary
// (same path `node /script.js` takes from the shell) and asserts timing +
// output invariants that have to match node.
//
// these exist because the old tiered-timeout wait loop had no coverage. it
// silently mis-exited on long timers, stalled on finished scripts, and
// killed slow async startups. the Handle-Registry rework (event-loop.ts)
// swapped that out for a libuv-parity drain-promise model; these guard it.

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
  // wires volume into child_process so executeNodeBinary works
  initShellExec(vol, { cwd: "/" });
  const ctx: ShellContext = {
    cwd: "/",
    env: { HOME: "/home", PATH: "/usr/bin", PWD: "/" },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
  return { vol, ctx };
}

// generous slop for CI / windows timer jitter
const SLOP_MS = 300;

describe("exit semantics - libuv-parity", () => {
  describe("exit latency", () => {
    it("empty script exits immediately (< 200 ms)", async () => {
      const { ctx } = setup({
        "/empty.js": `console.log("hi");`,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/empty.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
      expect(elapsed).toBeLessThan(200);
    });

    it("script with process.exit(0) exits immediately", async () => {
      const { ctx } = setup({
        "/exit.js": `console.log("bye"); process.exit(0);`,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/exit.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("bye");
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe("timers keep the loop alive", () => {
    it("setTimeout(fn, 300) fires before exit", async () => {
      const { ctx } = setup({
        "/timer.js": `setTimeout(() => console.log("late"), 300);`,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/timer.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("late");
      expect(elapsed).toBeGreaterThanOrEqual(300 - 50);
      expect(elapsed).toBeLessThan(300 + SLOP_MS + 400);
    });

    it("unref'd timer does NOT keep the loop alive", async () => {
      const { ctx } = setup({
        "/unref.js": `
          const t = setTimeout(() => console.log("BAD"), 3000);
          t.unref();
          console.log("ok");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/unref.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("ok");
      expect(r.stdout).not.toContain("BAD");
      // exits long before the 3 s timer would fire
      expect(elapsed).toBeLessThan(500);
    });

    it("clearTimeout releases the handle and exit is prompt", async () => {
      const { ctx } = setup({
        "/cleared.js": `
          const t = setTimeout(() => console.log("BAD"), 5000);
          clearTimeout(t);
          console.log("cleared");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/cleared.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("cleared");
      expect(r.stdout).not.toContain("BAD");
      expect(elapsed).toBeLessThan(500);
    });

    it("long timer (>5s tier-3-timeout regression) fires", async () => {
      // the old tier-3 timeout killed anything past 5s if refs dipped to 0
      // and back. with Handle tracking a 5.5s timer just fires.
      const { ctx } = setup({
        "/long.js": `setTimeout(() => console.log("woke"), 5500);`,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/long.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("woke");
      expect(elapsed).toBeGreaterThanOrEqual(5500 - 50);
      expect(elapsed).toBeLessThan(5500 + SLOP_MS + 500);
    }, 15_000);
  });

  describe("beforeExit", () => {
    it("fires on natural drain", async () => {
      const { ctx } = setup({
        "/be.js": `
          process.on("beforeExit", (code) => console.log("bye-" + code));
          console.log("start");
        `,
      });
      const r = await executeNodeBinary("/be.js", [], ctx);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("bye-0");
    });

    it("does NOT fire on process.exit()", async () => {
      const { ctx } = setup({
        "/nobe.js": `
          process.on("beforeExit", () => console.log("SHOULD_NOT_PRINT"));
          console.log("start");
          process.exit(0);
        `,
      });
      const r = await executeNodeBinary("/nobe.js", [], ctx);
      expect(r.stdout).toContain("start");
      expect(r.stdout).not.toContain("SHOULD_NOT_PRINT");
    });

    it("handler that schedules more work re-enters the loop", async () => {
      const { ctx } = setup({
        "/revive.js": `
          let fired = 0;
          process.on("beforeExit", () => {
            fired++;
            if (fired === 1) setTimeout(() => console.log("rescheduled"), 50);
          });
          console.log("start");
        `,
      });
      const r = await executeNodeBinary("/revive.js", [], ctx);
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("rescheduled");
    });
  });

  describe("create-qwik pattern (CJS + unawaited async + wait(500))", () => {
    it("via shellExec (closer to real `npm create qwik` path)", async () => {
      // same script but invoked through initShellExec's shell (has node + npm
      // commands). exercises the full shell-interpreter -> node-command ->
      // executeNodeBinary chain.
      const { shellExec } = await import("../polyfills/child_process");
      setup({
        "/main.cjs": `
          function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
          exports.runCli = async function runCli() {
            console.log("banner");
            await wait(500);
            console.log("after-wait");
          };
        `,
        "/entry.cjs": `
          const mod = require("./main.cjs");
          mod.runCli();
        `,
      });
      const t0 = performance.now();
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
        shellExec("node /entry.cjs", {}, (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: err ? ((err as any).code ?? 1) : 0,
          });
        });
      });
      const elapsed = performance.now() - t0;
      expect(result.stdout).toContain("banner");
      expect(result.stdout).toContain("after-wait");
      expect(elapsed).toBeGreaterThanOrEqual(500 - 50);
    }, 5_000);

    it("deep async chain: unawaited runCli with multiple awaits before setTimeout", async () => {
      // matches create-qwik exactly:
      //   runCli()  async, not awaited
      //     await makeTemplateManager()   first yield, no handle yet
      //       await loadIntegrations()    deeper yield
      //         await fs.promises.readdir even deeper, microtask-resolved
      //     intro(banner)
      //     await wait(500)               finally a setTimeout that refs
      // a naive single-microtask drain exits before we reach setTimeout.
      const { ctx } = setup({
        "/entry.cjs": `
          async function fakeReaddir() { return ['a','b','c']; }
          async function loadIntegrations() {
            const items = await fakeReaddir();
            const checked = await Promise.all(items.map(async () => {
              const inner = await fakeReaddir();
              return inner.length;
            }));
            return checked;
          }
          async function makeTemplateManager() {
            const ints = await loadIntegrations();
            return { count: ints.length };
          }
          function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
          async function runCli() {
            const tm = await makeTemplateManager();
            console.log("banner", tm.count);
            await wait(500);
            console.log("after-wait");
          }
          runCli();
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/entry.cjs", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("banner");
      expect(r.stdout).toContain("after-wait");
      expect(elapsed).toBeGreaterThanOrEqual(500 - 50);
    }, 5_000);

    it("unawaited async function call keeps loop alive while awaiting setTimeout-based sleep", async () => {
      // mirrors create-qwik's structure:
      //   entry.cjs: require('./main'); main.runCli();   // NOT awaited
      //   main.cjs: exports.runCli = async () => { ...; await wait(500); ... };
      //   wait(ms): new Promise(r => setTimeout(r, ms));
      //
      // entry is sync CJS so TLA resolves immediately. between sync entry
      // return and runCli's setTimeout Handle register there's a microtask
      // gap. if the wait loop exits in that gap, "after-wait" never prints.
      const { ctx } = setup({
        "/main.cjs": `
          function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
          exports.runCli = async function runCli() {
            console.log("banner");
            await wait(500);
            console.log("after-wait");
          };
        `,
        "/entry.cjs": `
          const mod = require("./main.cjs");
          mod.runCli();
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/entry.cjs", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("banner");
      expect(r.stdout).toContain("after-wait");
      expect(elapsed).toBeGreaterThanOrEqual(500 - 50);
    }, 5_000);
  });

  describe("node-parity correctness fixes", () => {
    it("process.exitCode is honored on natural drain", async () => {
      const { ctx } = setup({
        "/exitCode.js": `
          process.exitCode = 42;
          console.log("hi");
          // no explicit process.exit, natural drain
        `,
      });
      const r = await executeNodeBinary("/exitCode.js", [], ctx);
      expect(r.stdout).toContain("hi");
      expect(r.exitCode).toBe(42);
    });

    it("beforeExit handler receives process.exitCode (not 0)", async () => {
      const { ctx } = setup({
        "/be-code.js": `
          process.exitCode = 7;
          process.on("beforeExit", (c) => console.log("be-code=" + c));
          console.log("start");
        `,
      });
      const r = await executeNodeBinary("/be-code.js", [], ctx);
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("be-code=7");
      expect(r.exitCode).toBe(7);
    });

    it("'exit' event fires on natural drain", async () => {
      const { ctx } = setup({
        "/exit-evt.js": `
          process.on("exit", (c) => console.log("exit=" + c));
          console.log("start");
        `,
      });
      const r = await executeNodeBinary("/exit-evt.js", [], ctx);
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("exit=0");
    });

    it("'exit' event fires only once when process.exit() is called", async () => {
      const { ctx } = setup({
        "/exit-once.js": `
          let count = 0;
          process.on("exit", () => { count++; console.log("exit-count=" + count); });
          console.log("start");
          process.exit(3);
        `,
      });
      const r = await executeNodeBinary("/exit-once.js", [], ctx);
      expect(r.stdout).toContain("start");
      // exactly one exit emission
      const matches = r.stdout.match(/exit-count=/g) ?? [];
      expect(matches.length).toBe(1);
      expect(r.stdout).toContain("exit-count=1");
      expect(r.exitCode).toBe(3);
    });

    it("process.exit() inside a beforeExit handler short-circuits remaining handlers", async () => {
      const { ctx } = setup({
        "/be-exit.js": `
          process.on("beforeExit", () => {
            console.log("first");
            process.exit(5);
            console.log("after-exit-NEVER");
          });
          process.on("beforeExit", () => {
            console.log("second-NEVER");
          });
          console.log("start");
        `,
      });
      const r = await executeNodeBinary("/be-exit.js", [], ctx);
      expect(r.stdout).toContain("start");
      expect(r.stdout).toContain("first");
      expect(r.stdout).not.toContain("after-exit-NEVER");
      expect(r.stdout).not.toContain("second-NEVER");
      expect(r.exitCode).toBe(5);
    });

    it("process.exit() from a setTimeout callback wakes the wait loop", async () => {
      // regression for vite's q + Enter shortcut. the keypress handler (a
      // setTimeout-style async callback) does `await server.close(); process.exit()`.
      // after server.close, the readline still holds stdin's TTYWrap handle.
      // without an exitPromise in the wait loop's race, process.exit flips
      // didExit=true but the loop keeps waiting on drainPromise (which never
      // resolves because of the readline) and the process hangs.
      const { ctx } = setup({
        "/late-exit.js": `
          const readline = require("node:readline");
          // create a readline so stdin TTYWrap stays referenced
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          readline.emitKeypressEvents(process.stdin, rl);
          // exit after 100ms, readline never closed. mimics vite's q+Enter
          // race where the keypress handler calls process.exit without closing
          // the readline first.
          setTimeout(() => {
            console.log("about-to-exit");
            process.exit(0);
          }, 100);
          console.log("waiting");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/late-exit.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("waiting");
      expect(r.stdout).toContain("about-to-exit");
      expect(r.exitCode).toBe(0);
      // should exit within ~100ms + slop, not hang
      expect(elapsed).toBeLessThan(500);
    });

    it("readline.close() removes its listeners (no leak across sequential readlines)", async () => {
      // create-vite opens a readline for each prompt and closes it. if close
      // leaks listeners, stdin piles up dead handlers across the script's life.
      const { ctx } = setup({
        "/seq-rl.js": `
          const readline = require("node:readline");
          for (let i = 0; i < 3; i++) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
            rl.close();
          }
          const remaining = process.stdin.listenerCount("keypress");
          console.log("keypress-listeners=" + remaining);
        `,
      });
      const r = await executeNodeBinary("/seq-rl.js", [], ctx);
      // each rl adds one keypress listener; close should remove it. the
      // permanent emitKeypressEvents data->keypress decoder sits on 'data',
      // not 'keypress', so it doesn't count here.
      expect(r.stdout).toContain("keypress-listeners=0");
    });

    it("readline.Interface.close() releases stdin so process exits", async () => {
      // @clack/prompts creates readlines, attaches data listeners to stdin
      // (via emitKeypressEvents), then closes the readline. if close doesn't
      // pause stdin, the TTYWrap handle stays active forever and the process
      // hangs after the script is "done".
      const { ctx } = setup({
        "/rl.js": `
          const readline = require("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          // simulate @clack: attach a data listener via emitKeypressEvents
          readline.emitKeypressEvents(process.stdin, rl);
          // user does some work here
          rl.close();
          console.log("rl-closed");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/rl.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("rl-closed");
      // should exit promptly after rl.close()
      expect(elapsed).toBeLessThan(500);
    });

    it("setTimeout(fn, 5000).unref() lets process exit promptly", async () => {
      // already covered by timer tests but keeping an explicit node-parity check
      const { ctx } = setup({
        "/unref-prompt.js": `
          const t = setTimeout(() => console.log("BAD"), 5000);
          t.unref();
          console.log("ok");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/unref-prompt.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("ok");
      expect(r.stdout).not.toContain("BAD");
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("process.getActiveResourcesInfo()", () => {
    it("returns live Handle types for pending timers", async () => {
      const { ctx } = setup({
        "/info.js": `
          setTimeout(() => {}, 100);
          setTimeout(() => {}, 100);
          console.log(JSON.stringify(process.getActiveResourcesInfo()));
        `,
      });
      const r = await executeNodeBinary("/info.js", [], ctx);
      // expect some Timeout entries in the refed list (plus whatever the
      // runtime itself is holding at that moment)
      expect(r.stdout).toMatch(/Timeout/);
    });

    it("omits unref'd handles", async () => {
      const { ctx } = setup({
        "/info2.js": `
          const t = setTimeout(() => {}, 5000);
          t.unref();
          console.log(JSON.stringify(process.getActiveResourcesInfo()));
        `,
      });
      const r = await executeNodeBinary("/info2.js", [], ctx);
      // find the JSON array line in stdout and parse it
      const arrLine = r.stdout
        .split("\n")
        .map((s) => s.trim())
        .find((l) => l.startsWith("[") && l.endsWith("]"));
      expect(arrLine).toBeTruthy();
      const parsed = JSON.parse(arrLine!) as string[];
      // the unref'd timer should not be in the refed list
      expect(parsed).not.toContain("Timeout");
    });
  });

  describe("vite `q`-shortcut pattern", () => {
    // vite v5's quit shortcut is:
    //   try { await server.close(); } finally { process.exit(); }
    // server.close awaits Promise.allSettled([...]) of watcher.close,
    // hot.close, container.close, and closeHttpServer. key bit is that
    // process.exit runs inside finally and has to wake the wait loop even
    // if some handle (bundled ws heartbeat, etc) survives the close.
    // regression test for the "q presses stop the server but terminal hangs"
    // bug.
    it("process.exit() in finally wakes wait loop even with leaked handle", async () => {
      const { ctx } = setup({
        "/vite-like.js": `
          const http = require("node:http");
          const readline = require("node:readline");

          const server = http.createServer((req, res) => { res.end("ok"); });
          server.listen(0);

          const rl = readline.createInterface({ input: process.stdin });
          server.on("close", () => rl.close());

          // leaked handle: interval the shutdown path never clears (mirrors
          // vite's bundled HMR heartbeat if its close path misses something).
          // forces the wait loop to exit via process.exit, not natural drain.
          setInterval(() => {}, 1000);

          setTimeout(async () => {
            try {
              await Promise.allSettled([
                new Promise((r) => setTimeout(r, 10)),
                new Promise((r) => setTimeout(r, 15)),
                new Promise((r) => server.close(r)),
              ]);
            } finally {
              process.exit();
            }
          }, 50);

          console.log("ready");
        `,
      });

      const t0 = performance.now();
      const r = await executeNodeBinary("/vite-like.js", [], ctx);
      const elapsed = performance.now() - t0;

      expect(r.stdout).toContain("ready");
      // must exit, not hang. shutdown is scheduled at t+50ms, allSettled
      // waits ~15ms for the slowest inner timer, so ~70ms is the floor.
      // 1.5s safety margin before we call it a hang.
      expect(elapsed).toBeLessThan(1500);
      expect(r.exitCode).toBe(0);
    }, 5000);

    // chokidar.close awaits a 'close' event from each underlying fs.watch
    // handle. without that event chokidar.close never resolves, vite's
    // Promise.allSettled([watcher.close(), ...]) hangs, finally never runs
    // and the terminal stays stuck. this guards the node-parity 'close' emit.
    it("fs.watch handle emits 'close' event when close() is called", async () => {
      const { ctx } = setup({
        "/watch-close.js": `
          const fs = require("node:fs");
          fs.writeFileSync("/target.txt", "x");
          const w = fs.watch("/target.txt", () => {});
          let got = false;
          w.on("close", () => { got = true; });
          w.close();
          // setTimeout(0) lets any deferred emit settle
          setTimeout(() => {
            console.log("closeEmitted=" + got);
            process.exit(got ? 0 : 1);
          }, 0);
        `,
      });
      const r = await executeNodeBinary("/watch-close.js", [], ctx);
      expect(r.stdout).toContain("closeEmitted=true");
      expect(r.exitCode).toBe(0);
    });

    // exact vite pattern: readline fires 'line', async handler does
    // `await server.close()` where inner allSettled hangs. before the
    // EventEmitter fix this hung because the async listener's Promise was
    // tracked in the registry. now the dangling listener promise is ignored
    // and refs drain to 0 via handle closure, loop exits naturally.
    it("vite pattern: readline 'line' -> async handler with hanging await -> natural exit", async () => {
      const { ctx } = setup({
        "/vite-exact.js": `
          const http = require("node:http");
          const readline = require("node:readline");

          const server = http.createServer((_req, res) => res.end("ok"));
          server.listen(0);

          const rl = readline.createInterface({ input: process.stdin });
          server.on("close", () => rl.close());

          rl.on("line", async (line) => {
            if (line !== "q") return;
            // mirror vite: one inner promise never resolves
            await Promise.allSettled([
              new Promise(() => {}),               // never resolves (vite's _pendingRequests)
              new Promise((r) => server.close(r)), // http close, sync microtask
            ]);
            // unreachable if the above hangs forever, which is the whole point.
            // in real node the hanging promise doesn't keep the loop alive
            // because the OTHER handles close, registry drains, exit.
          });

          // fake the user pressing q by emitting on the stdin bus directly
          setTimeout(() => process.stdin.emit("data", "q\\n"), 30);
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/vite-exact.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.exitCode).toBe(0);
      // if fire-and-forget is working we exit promptly even though the
      // listener's await is forever-pending.
      expect(elapsed).toBeLessThan(1000);
    }, 5000);

    // regression for the vite-q hang. our EventEmitter used to register a
    // Handle per async-listener promise, so any listener returning a
    // never-settling promise leaked a refed Handle forever. node's
    // EventEmitter is fire-and-forget: returned promises aren't awaited and
    // don't keep the loop alive. this asserts that parity.
    it("EventEmitter async listener returning a never-settling Promise does NOT keep loop alive", async () => {
      const { ctx } = setup({
        "/ee-async.js": `
          const { EventEmitter } = require("node:events");
          const ee = new EventEmitter();
          // async listener whose promise never resolves. classic "pending
          // module transform" pattern that was hanging vite's q handler.
          ee.on("signal", async () => {
            await new Promise(() => {});  // never resolves
          });
          ee.emit("signal");
          console.log("after-emit");
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/ee-async.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("after-emit");
      expect(r.exitCode).toBe(0);
      // must exit promptly. if the listener's promise is keeping the loop
      // alive, this would hang past the 5s test timeout.
      expect(elapsed).toBeLessThan(500);
    });

    // chokidar wraps each fs.watch handle in a promise that resolves when
    // it emits 'close'. chokidar.close returns Promise.all(closers). if any
    // closer hangs, the outer close hangs, vite's allSettled hangs, finally
    // never runs. this proves the full chokidar-style pattern resolves here.
    it("chokidar-style close pattern resolves via fs.watch 'close' event", async () => {
      const { ctx } = setup({
        "/chokidar-like.js": `
          const fs = require("node:fs");
          fs.writeFileSync("/a.txt", "a");
          fs.writeFileSync("/b.txt", "b");
          fs.writeFileSync("/c.txt", "c");

          // mirror chokidar: Map of path -> watcher, close returns a promise
          // that resolves when the watcher emits 'close'.
          const watchers = new Map();
          for (const p of ["/a.txt", "/b.txt", "/c.txt"]) {
            const w = fs.watch(p, () => {});
            const closePromise = new Promise((resolve) => {
              w.once("close", resolve);
            });
            watchers.set(p, { w, closePromise });
          }

          async function chokidarClose() {
            const closers = [];
            for (const [, entry] of watchers) {
              entry.w.close();
              closers.push(entry.closePromise);
            }
            await Promise.all(closers);
          }

          setTimeout(async () => {
            await chokidarClose();
            console.log("chokidar-closed");
            process.exit(0);
          }, 10);
        `,
      });
      const t0 = performance.now();
      const r = await executeNodeBinary("/chokidar-like.js", [], ctx);
      const elapsed = performance.now() - t0;
      expect(r.stdout).toContain("chokidar-closed");
      expect(r.exitCode).toBe(0);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("node -e / -p", () => {
    it("node -e waits for short timers before exiting", async () => {
      const { shellExec } = await import("../polyfills/child_process");
      setup({});
      const t0 = performance.now();
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        shellExec(
          'node -e "setTimeout(() => console.log(\\\"done\\\"), 200)"',
          {},
          (err, stdout) => {
            resolve({
              stdout: String(stdout ?? ""),
              exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
            });
          },
        );
      });
      const elapsed = performance.now() - t0;
      expect(result.stdout).toContain("done");
      expect(result.exitCode).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(150);
    }, 5_000);

    it("node -p prints the evaluated expression", async () => {
      const { shellExec } = await import("../polyfills/child_process");
      setup({});
      const result = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        shellExec('node -p "2 + 2"', {}, (err, stdout) => {
          resolve({
            stdout: String(stdout ?? ""),
            exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
          });
        });
      });
      expect(result.stdout).toContain("4");
      expect(result.exitCode).toBe(0);
    });
  });
});
