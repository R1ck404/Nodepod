import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

describe("preview service-worker recovery", () => {
  it("reclaims its routing after a restart without reloading application state", () => {
    const source = readFileSync(new URL("../../static/__sw__.js", import.meta.url), "utf8");
    const start = source.indexOf("function getLocationPatchScript(");
    const end = source.indexOf("\n// Small \"nodepod\" badge", start);
    const html = runInNewContext(`${source.slice(start, end)}; getLocationPatchScript('test-pod', 5173)`);
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    const addEventListener = (event: string, callback: (event?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    };
    const reload = vi.fn();
    const postMessage = vi.fn();
    const window = { addEventListener, counter: 7 };
    const navigator = { serviceWorker: { addEventListener, controller: { postMessage } } };
    runInNewContext(html.replace(/^<script>\s*/, "").replace(/<\/script>$/, ""), {
      window, navigator, location: { pathname: "/", reload },
      document: { addEventListener }, HTMLElement: { prototype: { click() {} } },
      setTimeout: (callback: () => void) => callback(), URL,
    });
    for (const listener of listeners.get("message") ?? []) listener({ data: { type: "sw-needs-init" } });
    for (const listener of listeners.get("controllerchange") ?? []) listener();
    expect(reload).not.toHaveBeenCalled();
    expect(window.counter).toBe(7);
    expect(postMessage).toHaveBeenLastCalledWith({ type: "nodepod-preview-claim", pod: { instanceId: "test-pod", serverPort: 5173 }, path: "/" });
  });
});
