import { describe, it, expect, vi } from "vitest";
import { buildProcessEnv, setStreamDimensions } from "../polyfills/process";

describe("process polyfill", () => {
  describe("basic properties", () => {
    it('has platform "linux"', () => {
      const proc = buildProcessEnv();
      expect(proc.platform).toBe("linux");
    });

    it('has arch "x64"', () => {
      const proc = buildProcessEnv();
      expect(proc.arch).toBe("x64");
    });

    it('has version string starting with "v"', () => {
      const proc = buildProcessEnv();
      expect(proc.version).toMatch(/^v\d+/);
    });

    it("has pid as a number", () => {
      const proc = buildProcessEnv();
      expect(typeof proc.pid).toBe("number");
    });

    it("has argv as an array", () => {
      const proc = buildProcessEnv();
      expect(Array.isArray(proc.argv)).toBe(true);
    });
  });

  describe("cwd / chdir", () => {
    it("cwd() returns initial cwd", () => {
      const proc = buildProcessEnv({ cwd: "/mydir" });
      expect(proc.cwd()).toBe("/mydir");
    });

    it("chdir changes cwd", () => {
      const proc = buildProcessEnv({ cwd: "/" });
      proc.chdir("/other");
      expect(proc.cwd()).toBe("/other");
    });
  });

  describe("env", () => {
    it("includes default env vars", () => {
      const proc = buildProcessEnv();
      expect(proc.env.PATH).toBeDefined();
      expect(proc.env.HOME).toBeDefined();
    });

    it("includes custom env vars passed in config", () => {
      const proc = buildProcessEnv({ env: { MY_VAR: "hello" } });
      expect(proc.env.MY_VAR).toBe("hello");
    });

    it("includes NAPI_RS_FORCE_WASM=1", () => {
      const proc = buildProcessEnv();
      expect(proc.env.NAPI_RS_FORCE_WASM).toBe("1");
    });

    it("is mutable", () => {
      const proc = buildProcessEnv();
      proc.env.CUSTOM = "value";
      expect(proc.env.CUSTOM).toBe("value");
    });
  });

  describe("hrtime", () => {
    it("returns [seconds, nanoseconds] tuple", () => {
      const proc = buildProcessEnv();
      const hr = proc.hrtime();
      expect(Array.isArray(hr)).toBe(true);
      expect(hr.length).toBe(2);
      expect(typeof hr[0]).toBe("number");
      expect(typeof hr[1]).toBe("number");
    });

    it("hrtime.bigint() returns bigint", () => {
      const proc = buildProcessEnv();
      const result = proc.hrtime.bigint();
      expect(typeof result).toBe("bigint");
    });
  });

  describe("nextTick", () => {
    it("schedules callback asynchronously", async () => {
      const proc = buildProcessEnv();
      let called = false;
      proc.nextTick(() => {
        called = true;
      });
      expect(called).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      expect(called).toBe(true);
    });
  });

  describe("memoryUsage", () => {
    it("returns object with expected shape", () => {
      const proc = buildProcessEnv();
      const mem = proc.memoryUsage();
      expect(typeof mem.rss).toBe("number");
      expect(typeof mem.heapTotal).toBe("number");
      expect(typeof mem.heapUsed).toBe("number");
      expect(typeof mem.external).toBe("number");
      expect(typeof mem.arrayBuffers).toBe("number");
    });
  });

  describe("stdout.write", () => {
    it("calls onStdout callback when provided", () => {
      const output: string[] = [];
      const proc = buildProcessEnv({ onStdout: (text) => output.push(text) });
      proc.stdout.write("test");
      expect(output).toContain("test");
    });
  });

  describe("kill / signals", () => {
    it("kill emits signal on process", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.on("SIGTERM", fn);
      proc.kill(proc.pid, "SIGTERM");
      expect(fn).toHaveBeenCalled();
    });
  });

  describe("stdout resize", () => {
    it("emits 'resize' when columns or rows change via assignment", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.stdout.on("resize", fn);
      proc.stdout.columns = 120;
      expect(proc.stdout.columns).toBe(120);
      expect(fn).toHaveBeenCalledTimes(1);
      proc.stdout.rows = 40;
      expect(proc.stdout.rows).toBe(40);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("does not emit 'resize' when assigning the same value", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.stdout.on("resize", fn);
      const c = proc.stdout.columns;
      proc.stdout.columns = c;
      expect(fn).not.toHaveBeenCalled();
    });

    it("setStreamDimensions fires a single 'resize' event for both dims", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.stdout.on("resize", fn);
      const changed = setStreamDimensions(proc.stdout as any, 150, 50);
      expect(changed).toBe(true);
      expect(proc.stdout.columns).toBe(150);
      expect(proc.stdout.rows).toBe(50);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("setStreamDimensions is a no-op when nothing changed", () => {
      const proc = buildProcessEnv();
      setStreamDimensions(proc.stdout as any, 150, 50);
      const fn = vi.fn();
      proc.stdout.on("resize", fn);
      const changed = setStreamDimensions(proc.stdout as any, 150, 50);
      expect(changed).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });

    it("ignores non-finite writes to columns/rows", () => {
      const proc = buildProcessEnv();
      proc.stdout.columns = 100;
      proc.stdout.columns = Number.NaN;
      expect(proc.stdout.columns).toBe(100);
    });

    it("also fires 'resize' on stderr (Node-accurate, both WriteStreams emit)", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.stderr.on("resize", fn);
      const changed = setStreamDimensions(proc.stderr as any, 140, 42);
      expect(changed).toBe(true);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does NOT fire 'resize' on stdin (matches tty.ReadStream)", () => {
      const proc = buildProcessEnv();
      const fn = vi.fn();
      proc.stdin.on("resize", fn);
      // stdin has no _setSize. setStreamDimensions is a no-op.
      const changed = setStreamDimensions(proc.stdin as any, 140, 42);
      expect(changed).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
