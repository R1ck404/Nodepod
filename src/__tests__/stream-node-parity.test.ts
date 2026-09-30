import { describe, expect, it } from "vitest";
import * as native from "node:stream";
import * as pod from "../polyfills/stream";

// Run the same consumers against Node and the browser runtime.
describe("Node stream consumption parity", () => {
  for (const [name, streams] of [["Node", native], ["Nodepod", pod]] as const) {
    for (const fault of [new Error("cancel"), undefined]) {
      it(`${name}: releases queued transforms and settles cancellation callbacks (${fault?.message ?? "no error"})`, async () => {
        let complete!: (err: Error | null, output?: unknown) => void;
        const stream = new streams.Transform({
          transform(_chunk: unknown, _encoding: string, callback: typeof complete) {
            complete = callback;
          },
        });
        const events: string[] = [];
        stream.on("error", () => {});
        for (const value of ["a", "b", "c"]) {
          stream.write(value, (error?: Error | null) => events.push(value + ":" + (error?.message ?? "ok")));
        }
        stream.end((error?: Error | null) => events.push("end:" + (error?.message ?? "ok")));
        stream.destroy(fault);
        if (name === "Nodepod") expect((stream as any)._transformWrites).toEqual([]);
        complete(null, "a");
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(stream.writableLength).toBe(0);
        expect(events[0]).toBe("a:ok");
        expect(events).toHaveLength(4);
        if (fault) expect(events).toEqual(["a:ok", "b:cancel", "c:cancel", "end:cancel"]);
        else expect(events).toEqual([
          "a:ok",
          "b:Cannot call write after a stream was destroyed",
          "c:Cannot call write after a stream was destroyed",
          "end:Cannot call end after a stream was destroyed",
        ]);
      });
    }
    it(`${name}: serializes asynchronous transforms and awaits flush before EOF`, async () => {
      const events: string[] = [];
      const stream = new streams.Transform({
        transform(chunk: any, _encoding: string, callback: any) {
          events.push(`start:${chunk}`);
          setTimeout(() => { events.push(`done:${chunk}`); callback(null, chunk); }, 0);
        },
        flush(callback: any) {
          events.push("flush");
          setTimeout(() => callback(null, "!"), 0);
        },
      });
      const output: string[] = [];
      stream.on("data", chunk => output.push(String(chunk)));
      const ended = new Promise<void>((resolve, reject) => {
        stream.once("end", resolve); stream.once("error", reject);
      });
      stream.write("a");
      stream.end("b");
      await ended;
      expect(output.join("")).toBe("ab!");
      expect(events).toEqual(["start:a", "done:a", "start:b", "done:b", "flush"]);
    }, 1000);

    it(`${name}: ends after manually draining buffered EOF`, async () => {
      const stream = new streams.Readable({ read() {} });
      stream.push("one");
      stream.push("two");
      stream.push(null);
      const ended = new Promise<void>(resolve => stream.once("end", resolve));
      expect(String(stream.read())).toBe("onetwo");
      expect(stream.read()).toBeNull();
      await ended;
      expect(stream.readableEnded).toBe(true);
    }, 1000);

    it(`${name}: notifies a paused reader when asynchronous data arrives`, async () => {
      let started = false;
      const stream = new streams.Readable({ read() {
        if (started) return;
        started = true;
        setTimeout(() => { this.push("hello"); this.push(null); }, 0);
      } });
      const received: string[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("readable", () => {
          let chunk;
          while ((chunk = stream.read()) !== null) received.push(String(chunk));
        });
        stream.once("end", resolve);
        stream.once("error", reject);
      });
      expect(received.join("")).toBe("hello");
      expect(stream.readableFlowing).toBe(false);
    }, 1000);

    it(`${name}: pipes consecutive sources without ending the shared destination`, async () => {
      const destination = new streams.PassThrough();
      const received: string[] = [];
      destination.on("data", chunk => received.push(String(chunk)));
      const ended = new Promise<void>(resolve => destination.once("end", resolve));
      for (const value of ["one", "two"]) {
        const source = new streams.Readable({ read() {} });
        const sourceEnded = new Promise<void>(resolve => source.once("end", resolve));
        source.pipe(destination, { end: false });
        source.push(value);
        source.push(null);
        await sourceEnded;
        expect(destination.writableEnded).toBe(false);
      }
      destination.end();
      await ended;
      expect(received.join("")).toBe("onetwo");
    }, 1000);
  }
});
