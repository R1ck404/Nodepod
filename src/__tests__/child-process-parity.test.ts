import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  installPackageNames,
  shellQuote,
  shellCommandFromArgv,
  spawn,
  setSpawnChildCallback,
  setStreamingCallbacks,
  clearStreamingCallbacks,
  shellExec,
  promises as cpPromises,
  initShellExec,
  getUnsupportedNativeExecutableMessage,
} from "../polyfills/child_process";

describe("installPackageNames", () => {
  it("excludes --registry value from package names", () => {
    expect(
      installPackageNames([
        "--registry",
        "https://registry.example.com/",
        "lodash",
      ]),
    ).toEqual(["lodash"]);
  });

  it("excludes --registry=value form", () => {
    expect(
      installPackageNames(["--registry=https://registry.example.com/", "left-pad"]),
    ).toEqual(["left-pad"]);
  });

  it("keeps packages and skips boolean flags", () => {
    expect(installPackageNames(["-D", "typescript", "--no-save"])).toEqual([
      "typescript",
    ]);
  });
});

describe("shellQuote / shellCommandFromArgv", () => {
  it("quotes args with spaces and metacharacters", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
    expect(shellQuote("a;b")).toBe("'a;b'");
    expect(shellQuote("plain")).toBe("plain");
  });

  it("preserves spaces in argv when building a shell command", () => {
    expect(shellCommandFromArgv("node", ["script.js", "arg with spaces"])).toBe(
      "node script.js 'arg with spaces'",
    );
  });
});

describe("spawn env inheritance", () => {
  const prevEnv = { ...(globalThis as any).process?.env };

  beforeEach(() => {
    if (!(globalThis as any).process) {
      (globalThis as any).process = { env: {} };
    }
    (globalThis as any).process.env = { ...prevEnv, NODEPOD_TEST_ENV: "1" };
  });

  afterEach(() => {
    setSpawnChildCallback(null);
    clearStreamingCallbacks();
    if ((globalThis as any).process) {
      (globalThis as any).process.env = prevEnv;
    }
  });

  it("inherits process.env when env is omitted", async () => {
    let captured: Record<string, string> | undefined;
    setSpawnChildCallback(async (_cmd, _args, opts) => {
      captured = opts?.env;
      return { pid: 1, exitCode: 0, stdout: "", stderr: "" };
    });

    const child = spawn("true", []);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });

    expect(captured?.NODEPOD_TEST_ENV).toBe("1");
  });

  it("uses explicit empty env when provided", async () => {
    let captured: Record<string, string> | undefined;
    setSpawnChildCallback(async (_cmd, _args, opts) => {
      captured = opts?.env;
      return { pid: 1, exitCode: 0, stdout: "", stderr: "" };
    });

    const child = spawn("true", [], { env: {} });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });

    expect(captured).toEqual({});
  });

  it("routes kill to the real child operation", async () => {
    let finish!: (value: { pid: number; exitCode: number; stdout: string; stderr: string }) => void;
    const kill = vi.fn(() => true);
    const operation = Object.assign(
      new Promise<{ pid: number; exitCode: number; stdout: string; stderr: string }>((resolve) => { finish = resolve; }),
      { kill },
    );
    setSpawnChildCallback(() => operation);

    const child = spawn("node", ["loop.js"]);
    expect(child.kill("SIGKILL")).toBe(true);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    finish({ pid: 2, exitCode: 137, stdout: "", stderr: "" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  });

  it("streams shell node binary output and inherits stdin before the child exits", async () => {
    const volume = new MemoryVolume();
    volume.writeFileSync("/dev-server.js", "");
    initShellExec(volume, { cwd: "/" });

    let finish!: (value: { pid: number; exitCode: number; stdout: string; stderr: string }) => void;
    let childOptions: Parameters<NonNullable<Parameters<typeof setSpawnChildCallback>[0]>>[2];
    const operation = new Promise<{ pid: number; exitCode: number; stdout: string; stderr: string }>(
      (resolve) => { finish = resolve; },
    );
    setSpawnChildCallback((_command, _args, options) => {
      childOptions = options;
      return operation;
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    setStreamingCallbacks({
      onStdout: (text) => stdout.push(text),
      onStderr: (text) => stderr.push(text),
    });

    const completion = new Promise<void>((resolve) => {
      shellExec("node /dev-server.js", {}, () => resolve());
    });

    await vi.waitFor(() => expect(childOptions).toBeDefined());
    expect(childOptions?.stdio).toBe("inherit");
    childOptions?.onStdout?.("VITE ready\n");
    childOptions?.onStderr?.("warning\n");

    expect(stdout).toEqual(["VITE ready\n"]);
    expect(stderr).toEqual(["warning\n"]);

    finish({
      pid: 2,
      exitCode: 0,
      stdout: "VITE ready\n",
      stderr: "warning\n",
    });
    await completion;
  });
});

describe("browser-incompatible native binaries", () => {
  it("explains why the TypeScript 7 native compiler cannot run", () => {
    expect(
      getUnsupportedNativeExecutableMessage(
        "/project/node_modules/typescript/lib/tsc.exe",
      ),
    ).toMatch(/TypeScript 7\+.*native compiler.*browser/i);
    expect(
      getUnsupportedNativeExecutableMessage("/project/node_modules/.bin/tsc"),
    ).toBeNull();
  });

  it("returns a deterministic 127 for the native TypeScript executable", async () => {
    const child = spawn("/project/node_modules/typescript/lib/tsc.exe", []);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.exitCode).toBe(127);
    expect(stderr).toMatch(/Pin `typescript` to 5\.9\.x/);
  });
});

describe("child_process/promises", () => {
  beforeEach(() => {
    const vol = new MemoryVolume();
    vol.mkdirSync("/", { recursive: true });
    initShellExec(vol, { cwd: "/" });
  });

  afterEach(() => {
    setSpawnChildCallback(null);
  });

  it("exposes exec/execFile/spawn", () => {
    expect(typeof cpPromises.exec).toBe("function");
    expect(typeof cpPromises.execFile).toBe("function");
    expect(typeof cpPromises.spawn).toBe("function");
  });

  it("promises.spawn resolves on exit 0", async () => {
    setSpawnChildCallback(async () => ({
      pid: 2,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    const result = await cpPromises.spawn("echo", ["hi"]);
    expect(result.stdout).toContain("ok");
  });
});

describe("npx persist flag intent", () => {
  it("installPackageNames alone does not imply save (covered by persist:false call site)", () => {
    // Behavioral contract: names used for install; persist is a separate option.
    // Regression guard — registry URL must never appear as a name.
    const names = installPackageNames([
      "-y",
      "--registry",
      "https://example.com/npm/",
      "create-vite@latest",
    ]);
    expect(names).toEqual(["create-vite@latest"]);
    expect(names.some((n) => n.includes("https://"))).toBe(false);
  });
});

describe("npm lifecycle output routing", () => {
  afterEach(() => {
    clearStreamingCallbacks();
    setSpawnChildCallback(null);
  });

  it("writes pre/main/post script headers to stdout", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/app", { recursive: true });
    volume.writeFileSync(
      "/app/package.json",
      JSON.stringify({
        name: "routing-test",
        version: "1.0.0",
        scripts: {
          predev: "echo pre",
          dev: "echo main",
          postdev: "echo post",
        },
      }),
    );
    initShellExec(volume, { cwd: "/app" });

    const streamedStdout: string[] = [];
    const streamedStderr: string[] = [];
    setStreamingCallbacks({
      onStdout: (text) => streamedStdout.push(text),
      onStderr: (text) => streamedStderr.push(text),
    });

    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      shellExec("npm run dev", {}, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });

    expect(result.stdout).toContain("> routing-test@1.0.0 predev");
    expect(result.stdout).toContain("> routing-test@1.0.0 dev");
    expect(result.stdout).toContain("> routing-test@1.0.0 postdev");
    expect(result.stderr).toBe("");
    expect(streamedStdout.join("")).toContain("> routing-test@1.0.0 dev");
    expect(streamedStderr.join("")).not.toContain("routing-test@1.0.0");
  });

  it("keeps command failures on stderr without moving the lifecycle header", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/app", { recursive: true });
    volume.writeFileSync(
      "/app/package.json",
      JSON.stringify({
        name: "routing-test",
        version: "1.0.0",
        scripts: { dev: "cat /missing" },
      }),
    );
    initShellExec(volume, { cwd: "/app" });

    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
      shellExec("npm run dev", {}, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });

    expect(result.error).not.toBeNull();
    expect(result.stdout).toContain("> routing-test@1.0.0 dev");
    expect(result.stderr).toContain("No such file or directory");
    expect(result.stderr).not.toContain("> routing-test@1.0.0 dev");
  });

  it("drops the lifecycle banners with -s/--silent, in any position", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/app", { recursive: true });
    volume.writeFileSync(
      "/app/package.json",
      JSON.stringify({
        name: "routing-test",
        version: "1.0.0",
        scripts: {
          prewhoami: "echo pre",
          whoami: "echo main",
          args: "echo",
        },
      }),
    );
    initShellExec(volume, { cwd: "/app" });

    const run = (cmd: string) =>
      new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        shellExec(cmd, {}, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });

    for (const cmd of [
      "npm run -s whoami",
      "npm run whoami --silent",
      "npm -s run whoami",
      "pnpm --silent run whoami",
      "pnpm -s whoami",
      "yarn -s whoami",
      "bun --silent run whoami",
    ]) {
      const result = await run(cmd);
      expect(result.stdout, cmd).toBe("pre\nmain\n");
      expect(result.stderr, cmd).toBe("");
    }

    // flags after "--" belong to the script, not to run-script
    const passthrough = await run("npm run args -- --silent -s");
    expect(passthrough.stdout).toContain("> routing-test@1.0.0 args");
    expect(passthrough.stdout.trimEnd().endsWith("--silent -s")).toBe(true);
  });
});
