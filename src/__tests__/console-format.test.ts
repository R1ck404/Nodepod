import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { format } from "../polyfills/util";
import { initShellExec, shellExec } from "../polyfills/child_process";

describe("console output formatting", () => {
  it("formats no arguments as nothing, undefined as undefined", () => {
    expect(format()).toBe("");
    expect(format(undefined)).toBe("undefined");
    expect(format("%s!", "hi")).toBe("hi!");
  });

  it("prints an empty line for console.log()", async () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/blank.js", "console.log(); console.log('after');");
    initShellExec(vol, { cwd: "/" });
    const stdout = await new Promise<string>((resolve) => {
      shellExec("node /blank.js", {}, (_err, out) => resolve(String(out ?? "")));
    });
    expect(stdout).toBe("\nafter\n");
  });
});
