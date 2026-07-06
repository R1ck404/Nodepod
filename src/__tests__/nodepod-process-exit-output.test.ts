import { describe, expect, it } from "vitest";
import { NodepodProcess } from "../sdk/nodepod-process";

describe("NodepodProcess exit output merge", () => {
  it("merges buffered stdout from exit when nothing was streamed", () => {
    const proc = new NodepodProcess();
    const chunks: string[] = [];
    proc.on("output", (c) => chunks.push(c));

    proc._mergeExitOutput("hello\nworld\n", "");
    proc._finish(0);

    expect(chunks.join("")).toBe("hello\nworld\n");
    return proc.completion.then((r) => {
      expect(r.stdout).toBe("hello\nworld\n");
      expect(r.exitCode).toBe(0);
    });
  });

  it("only appends stdout tail not already received via streaming", () => {
    const proc = new NodepodProcess();
    proc._pushStdout("hello\n");
    proc._mergeExitOutput("hello\nworld\n", "");
    proc._finish(0);

    return proc.completion.then((r) => {
      expect(r.stdout).toBe("hello\nworld\n");
    });
  });
});
