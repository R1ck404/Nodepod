import { afterEach, describe, expect, it, vi } from "vitest";
import { IframeSandbox } from "../iframe-sandbox";
import { MemoryVolume } from "../memory-volume";

afterEach(() => vi.unstubAllGlobals());

describe("iframe sandbox file sync", () => {
  it("round-trips binary and shared-backed views without decoding", () => {
    const received = new MemoryVolume();
    const postMessage = vi.fn((message: { type: string; path: string; content: Uint8Array | null }) => {
      if (message.type !== "syncFile") return;
      // SharedArrayBuffers cannot cross an opaque iframe's agent cluster.
      expect(message.content?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      if (message.content === null) received.unlinkSync(message.path);
      else received.writeFileSync(message.path, structuredClone(message.content));
    });
    vi.stubGlobal("document", {
      createElement: () => ({ style: {}, setAttribute: vi.fn(), contentWindow: { postMessage }, remove: vi.fn() }),
      body: { appendChild: vi.fn() },
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const volume = new MemoryVolume();
    const decode = vi.spyOn(volume as any, "decodeText");
    const sandbox = new IframeSandbox("https://sandbox.test", volume);
    try {
      volume.writeFileSync("/binary", new Uint8Array([0, 255, 128, 65]));
      const shared = new Uint8Array(new SharedArrayBuffer(6));
      shared.set([99, 0, 255, 128, 65, 99]);
      volume.writeFileSync("/shared", shared.subarray(1, 5));
      volume.writeFileSync("/text", "héllo");
      expect([...received.readFileSync("/binary")]).toEqual([0, 255, 128, 65]);
      expect([...received.readFileSync("/shared")]).toEqual([0, 255, 128, 65]);
      expect(received.readFileSync("/text", "utf8")).toBe("héllo");
      expect(decode).not.toHaveBeenCalled();
      volume.unlinkSync("/binary");
      expect(received.existsSync("/binary")).toBe(false);
    } finally {
      sandbox.terminate();
    }
    const calls = postMessage.mock.calls.length;
    volume.writeFileSync("/after-termination", "ignored");
    expect(postMessage.mock.calls.length).toBe(calls);
  });
});
