import { afterEach, describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  clearStreamingCallbacks,
  initShellExec,
  setSpawnChildCallback,
  setStreamingCallbacks,
  shellExec,
} from "../polyfills/child_process";

// `node` runs in a child worker that streams its output to the terminal. Output
// going to a pipe, a file or a substitution must reach the shell's result
// only, and input from a pipe must be the child's whole stdin.

type SpawnOptions = Parameters<NonNullable<Parameters<typeof setSpawnChildCallback>[0]>>[2];

interface Run {
  stdout: string;
  stderr: string;
  code: number;
  streamed: { stdout: string; stderr: string };
  spawns: SpawnOptions[];
}

// The fake child prints `out` to stdout and `err` to stderr, or its stdin
// upper-cased when it has piped input, streaming what isn't captured.
function run(line: string, child: { out?: string; err?: string } = {}): Promise<Run> {
  const volume = new MemoryVolume();
  volume.mkdirSync("/w", { recursive: true });
  volume.writeFileSync("/w/app.js", "");
  initShellExec(volume, { cwd: "/w" });
  const spawns: SpawnOptions[] = [];
  setSpawnChildCallback((_command, _args, options) => {
    spawns.push(options);
    const out = options?.input !== undefined ? options.input.toUpperCase() : child.out ?? "";
    const err = child.err ?? "";
    if (out) options?.onStdout?.(out);
    if (err) options?.onStderr?.(err);
    return Promise.resolve({ pid: 2, exitCode: 0, stdout: out, stderr: err });
  });
  const streamed = { stdout: "", stderr: "" };
  setStreamingCallbacks({
    onStdout: (text) => { streamed.stdout += text; },
    onStderr: (text) => { streamed.stderr += text; },
  });
  return new Promise((resolve) => {
    shellExec(line, {}, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? (error as { code?: number }).code ?? 1 : 0, streamed, spawns });
    });
  });
}

afterEach(() => {
  clearStreamingCallbacks();
  setSpawnChildCallback(null);
});

describe("node in pipes and redirects", () => {
  it("streams output that goes to the terminal", async () => {
    const result = await run("node app.js", { out: "hi\n" });
    expect(result.streamed.stdout).toBe("hi\n");
    expect(result.spawns[0]?.stdio).toBe("inherit");
  });

  it("writes `node app.js > out.txt` to the file only", async () => {
    const result = await run("node app.js > out.txt; cat out.txt", { out: "hi\n" });
    expect(result.streamed.stdout).toBe("");
    expect(result.stdout).toBe("hi\n");
    expect(result.spawns[0]?.stdio).toEqual(["inherit", "pipe", "inherit"]);
  });

  it("sends `node app.js | cmd` through the pipe only", async () => {
    const result = await run("node app.js | tr a-z A-Z", { out: "hello\n" });
    expect(result.streamed.stdout).toBe("");
    expect(result.stdout).toBe("HELLO\n");
  });

  it("drops stderr sent to /dev/null", async () => {
    const result = await run("node app.js 2>/dev/null; echo done", { err: "oops\n" });
    expect(result.streamed.stderr).toBe("");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("done\n");
  });

  it("pipes stderr with `2>&1 |`", async () => {
    const result = await run("node app.js 2>&1 | wc -l", { err: "oops\n" });
    expect(result.streamed).toEqual({ stdout: "", stderr: "" });
    expect(result.stdout).toBe("1\n");
    expect(result.spawns[0]?.stdio).toEqual(["inherit", "pipe", "pipe"]);
  });

  it("keeps stderr on the terminal when only stdout is piped", async () => {
    const result = await run("node app.js | cat", { out: "a\n", err: "warn\n" });
    expect(result.streamed).toEqual({ stdout: "", stderr: "warn\n" });
    expect(result.stdout).toBe("a\n");
  });

  it("gives `echo hi | node app.js` its input and ends it", async () => {
    const result = await run("echo hi | node app.js");
    expect(result.spawns[0]?.input).toBe("hi\n");
    expect(result.spawns[0]?.stdio).toEqual(["pipe", "inherit", "inherit"]);
    expect(result.stdout).toBe("HI\n");
  });

  it("chains `node | node`", async () => {
    const result = await run("node app.js | node app.js", { out: "x\n" });
    expect(result.spawns[1]?.input).toBe("x\n");
    expect(result.stdout).toBe("X\n");
    expect(result.streamed.stdout).toBe("X\n");
  });

  it("captures node inside a command substitution", async () => {
    const result = await run("echo \"[$(node app.js)]\"", { out: "v\n" });
    expect(result.streamed.stdout).toBe("");
    expect(result.stdout).toBe("[v]\n");
  });

  it("applies a compound command's redirect to node inside it", async () => {
    const result = await run("{ node app.js; } > out.txt; cat out.txt", { out: "g\n" });
    expect(result.streamed.stdout).toBe("");
    expect(result.stdout).toBe("g\n");
  });
});
