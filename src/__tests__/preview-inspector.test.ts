import { describe, expect, it } from "vitest";
import {
  PreviewInspector,
  PreviewAgentUnavailableError,
  PreviewNotAttachedError,
} from "../sdk/preview-inspector";
import { readFileSync } from "node:fs";

function wire(instanceId: string, port: number, kind: "ready" | "response", extra: Record<string, unknown> = {}) {
  return { data: { __nodepodInspect: 1, v: 1, kind, instanceId, port, ...extra }, source: extra.source };
}

describe("PreviewInspector", () => {
  it("requires enable and an attached iframe before requests", async () => {
    const proxy = { setPreviewInspectorScript() {} } as any;
    const inspector = new PreviewInspector(proxy, "podtest", () => {});
    await expect(inspector.viewport({ port: 3000 })).rejects.toBeInstanceOf(PreviewAgentUnavailableError);
    await inspector.enable();
    await expect(inspector.viewport({ port: 3000 })).rejects.toBeInstanceOf(PreviewNotAttachedError);
    inspector.dispose();
  });

  it("accepts only the attached iframe and correlates RPC responses", async () => {
    const scripts: unknown[] = [];
    const proxy = { setPreviewInspectorScript(_id: string, script: unknown) { scripts.push(script); } } as any;
    const outbound: unknown[] = [];
    const contentWindow = { postMessage(message: unknown) { outbound.push(message); } } as any;
    const iframe = { contentWindow, src: "https://test/preview" } as HTMLIFrameElement;
    const inspector = new PreviewInspector(proxy, "podtest", () => {});
    await inspector.enable();
    inspector.attach({ port: 3000, iframe });

    // A forged source cannot establish a session.
    (inspector as any).handleMessage(wire("podtest", 3000, "ready", { source: {} }));
    expect(inspector.ports()[0].connected).toBe(false);
    (inspector as any).handleMessage(wire("podtest", 3000, "ready", { source: contentWindow, navigationId: "nav1" }));
    expect(inspector.ports()[0].connected).toBe(true);

    const result = inspector.viewport({ port: 3000 });
    const request = outbound[0] as any;
    expect(request.method).toBe("viewport");
    (inspector as any).handleMessage(wire("podtest", 3000, "response", {
      source: contentWindow,
      navigationId: "nav1",
      id: request.id,
      ok: true,
      data: { port: 3000, url: "https://test/", capturedAt: 1, data: { innerWidth: 100 } },
    }));
    await expect(result).resolves.toMatchObject({ data: { innerWidth: 100 } });
    expect(scripts).toHaveLength(1);
    inspector.dispose();
  });

  it("keeps the service worker user and inspector injection slots separate", () => {
    const source = readFileSync(new URL("../../static/__sw__.js", import.meta.url), "utf8");
    expect(source).toContain("previewInspectorScripts");
    expect(source).toContain("set-preview-inspector-script");
    expect(source).toContain("window.__nodepodInspectConfig");
  });
});
