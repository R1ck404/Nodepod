import { describe, expect, it } from "vitest";
import { PassThrough } from "../polyfills/stream";
import { createInterface } from "../polyfills/readline";

describe("reading a stream to its end", () => {
  it("ends a PassThrough's readable side once it is ended", async () => {
    const pass = new PassThrough();
    const chunks: string[] = [];
    pass.on("data", (c: unknown) => chunks.push(String(c)));
    const ended = new Promise<void>((resolve) => pass.on("end", () => resolve()));
    pass.write("x");
    pass.end("y");
    await ended;
    expect(chunks.join("")).toBe("xy");
  });

  it("iterates every line of a readline interface until the input ends", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    const lines: string[] = [];
    const done = (async () => {
      for await (const line of rl) lines.push(line);
    })();
    // several lines in one chunk arrive together
    input.write("a\nb\n");
    await new Promise((r) => setTimeout(r, 10));
    input.write("c\n");
    input.end();
    await done;
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("answers next() calls made before their lines arrive, in order", async () => {
    const input = new PassThrough();
    const it = createInterface({ input })[Symbol.asyncIterator]();
    const first = it.next();
    const second = it.next();
    const third = it.next();
    input.write("a\nb\n");
    input.end();
    expect(await Promise.all([first, second, third])).toEqual([
      { value: "a", done: false },
      { value: "b", done: false },
      { value: undefined, done: true },
    ]);
  });

  it("settles pending next() calls when the loop is left", async () => {
    const input = new PassThrough();
    const it = createInterface({ input })[Symbol.asyncIterator]();
    const pending = it.next();
    await it.return!();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it("closes the interface when the loop is left early", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input });
    let closed = false;
    rl.on("close", () => { closed = true; });
    setTimeout(() => input.write("first\nsecond\n"), 0);
    const seen: string[] = [];
    for await (const line of rl) {
      seen.push(line);
      break;
    }
    expect(seen).toEqual(["first"]);
    expect(closed).toBe(true);
  });
});
