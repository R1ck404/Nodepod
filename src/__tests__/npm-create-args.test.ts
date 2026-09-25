import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { initShellExec, shellExec } from "../polyfills/child_process";

// an installed initializer that prints the arguments it was given
function setup() {
  const vol = new MemoryVolume();
  vol.mkdirSync("/node_modules/create-echo", { recursive: true });
  vol.writeFileSync(
    "/node_modules/create-echo/package.json",
    JSON.stringify({ name: "create-echo", version: "1.0.0", bin: { "create-echo": "index.js" } }),
  );
  vol.writeFileSync("/node_modules/create-echo/index.js", "console.log(JSON.stringify(process.argv.slice(2)));");
  initShellExec(vol, { cwd: "/" });
}

function run(command: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    shellExec(command, {}, (err, stdout, stderr) => {
      const line = String(stdout ?? "").trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`no argv printed (err=${err?.message}) stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
}

describe("npm create / npx argument forwarding", () => {
  it("passes what follows the initializer in order, without npm's --", async () => {
    setup();
    expect(await run("npm create echo app -- --template react-ts --no-interactive")).toEqual([
      "app", "--template", "react-ts", "--no-interactive",
    ]);
    expect(await run("npm init echo my-app -- --template vue")).toEqual(["my-app", "--template", "vue"]);
  });

  it("gives the command its own flags, --help and -y included", async () => {
    setup();
    expect(await run("npx create-echo app --help -y")).toEqual(["app", "--help", "-y"]);
    expect(await run("npx -y create-echo -- --flag value")).toEqual(["--flag", "value"]);
  });
});
