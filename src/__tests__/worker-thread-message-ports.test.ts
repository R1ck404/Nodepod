import { afterEach, describe, it, expect } from "vitest";
import {
  MessageChannel,
  MessagePort,
  decodeTransfer,
  encodeTransfer,
} from "../polyfills/worker_threads";

// tinypool (Vitest's threads pool) posts a MessagePort to each worker thread.
// Worker threads are separate Web Workers, so ports are backed by the host's
// MessageChannel and travel in a message's transfer list; they used to be
// plain objects, which failed with DataCloneError.
describe("worker_threads MessagePort transfer", () => {
  const open: MessagePort[] = [];
  const channel = () => {
    const ch = new MessageChannel();
    open.push(ch.port1, ch.port2);
    return ch;
  };
  const next = (port: MessagePort) =>
    new Promise<unknown>((resolve) => port.once("message", resolve));
  afterEach(() => {
    for (const port of open.splice(0)) port.close();
  });

  it("delivers structured-cloned messages between a channel's ports", async () => {
    const { port1, port2 } = channel();
    const sent = { n: 1, nested: { list: [1, 2] } };
    port2.postMessage(sent);
    const got = await next(port1);
    expect(got).toEqual(sent);
    expect(got).not.toBe(sent);
  });

  it("transfers a port inside a message", async () => {
    const outer = channel();
    const inner = channel();
    outer.port1.postMessage({ port: inner.port2, label: "task" }, [inner.port2]);
    const msg = (await next(outer.port2)) as { port: MessagePort; label: string };
    expect(msg.label).toBe("task");
    expect(msg.port).toBeInstanceOf(MessagePort);
    open.push(msg.port);
    msg.port.postMessage("from the receiver");
    expect(await next(inner.port1)).toBe("from the receiver");
  });

  it("encodes ports for a relayed message and decodes them on arrival", async () => {
    const { port1, port2 } = channel();
    const value = { port: port2, other: [port2], text: "x" };
    const { data, ports } = encodeTransfer(value, [port2]);
    expect(ports).toHaveLength(1);
    // the sender's object is left alone; its port is now detached
    expect(value.port).toBe(port2);
    // the main thread's relay between two workers
    const host = new globalThis.MessageChannel();
    open.push(host.port1 as any, host.port2 as any);
    host.port1.postMessage({ data, ports }, ports as unknown as Transferable[]);
    const env = await new Promise<any>((resolve) => {
      (host.port2 as any).onmessage = (e: { data: unknown }) => resolve(e.data);
    });
    const decoded = decodeTransfer(env.data, env.ports) as { port: MessagePort; other: MessagePort[]; text: string };
    expect(decoded.text).toBe("x");
    expect(decoded.port).toBeInstanceOf(MessagePort);
    expect(decoded.other[0]).toBe(decoded.port);
    open.push(decoded.port);
    decoded.port.postMessage(7);
    expect(await next(port1)).toBe(7);
  });

  it("leaves messages without ports unchanged", () => {
    const value = { a: 1 };
    expect(encodeTransfer(value, [])).toEqual({ data: value, ports: [] });
    expect(encodeTransfer(value, undefined).data).toBe(value);
  });

  it("emits close on both ends", async () => {
    const { port1, port2 } = channel();
    const closed = Promise.all([
      new Promise((r) => port1.once("close", r)),
      new Promise((r) => port2.once("close", r)),
    ]);
    port2.on("message", () => {});
    port1.close();
    await closed;
  });
});
