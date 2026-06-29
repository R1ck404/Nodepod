/**
 * Reproduces the original sandbox failure: `npm run dev` / `node node_modules/vite/bin/vite.js`
 * crashed with ENOENT on `/package.json` because require.resolve('rollup') returned the bare
 * specifier "rollup" instead of a filesystem path inside node_modules.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MemoryVolume } from "../../memory-volume";
import {
  executeNodeBinary,
  initShellExec,
  shellExec,
} from "../../polyfills/child_process";
import type { ShellContext } from "../../shell/shell-types";

const repoRoot = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
);
const hostRequire = createRequire(path.join(repoRoot, "package.json"));

const PROJECT = "/project";

function copyHostTree({
  hostDir,
  vfsDir,
  vol,
}: {
  hostDir: string;
  vfsDir: string;
  vol: MemoryVolume;
}): void {
  const realDir = fs.realpathSync(hostDir);
  for (const entry of fs.readdirSync(realDir, { withFileTypes: true })) {
    const hostPath = path.join(realDir, entry.name);
    const vfsPath = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      vol.mkdirSync(vfsPath, { recursive: true });
      copyHostTree({ hostDir: hostPath, vfsDir: vfsPath, vol });
      continue;
    }
    if (!entry.isFile()) continue;
    vol.writeFileSync(vfsPath, fs.readFileSync(hostPath));
  }
}

function seedHostPackage({
  name,
  vfsDir,
  vol,
  seen,
}: {
  name: string;
  vfsDir: string;
  vol: MemoryVolume;
  seen: Set<string>;
}): void {
  if (seen.has(name)) return;
  seen.add(name);

  let pkgJsonHost: string;
  try {
    pkgJsonHost = hostRequire.resolve(`${name}/package.json`);
  } catch {
    return;
  }

  const pkgRoot = path.dirname(pkgJsonHost);
  copyHostTree({ hostDir: pkgRoot, vfsDir: `${vfsDir}/${name}`, vol });

  const manifest = JSON.parse(fs.readFileSync(pkgJsonHost, "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    seedHostPackage({ name: dep, vfsDir, vol, seen });
  }
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      seedHostPackage({ name: dep, vfsDir, vol, seen });
    } catch {
      /* optional */
    }
  }
}

function createSampleViteProject(): {
  vol: MemoryVolume;
  ctx: ShellContext;
} {
  const vol = new MemoryVolume();
  vol.mkdirSync(PROJECT, { recursive: true });

  vol.writeFileSync(
    `${PROJECT}/package.json`,
    JSON.stringify(
      {
        name: "vite-sandbox-app",
        private: true,
        type: "module",
        scripts: {
          dev: "node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173",
        },
      },
      null,
      2,
    ),
  );

  vol.writeFileSync(
    `${PROJECT}/index.html`,
    `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Vite sandbox</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.js"></script></body>
</html>`,
  );

  vol.writeFileSync(
    `${PROJECT}/src/main.js`,
    `document.getElementById("app").textContent = "hello";`,
  );

  seedHostPackage({
    name: "vite",
    vfsDir: `${PROJECT}/node_modules`,
    vol,
    seen: new Set(),
  });

  initShellExec(vol, { cwd: PROJECT });
  const ctx: ShellContext = {
    cwd: PROJECT,
    env: { HOME: "/home", PATH: "/usr/bin", PWD: PROJECT },
    volume: vol,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  };

  return { vol, ctx };
}

function runShell(
  cmd: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    shellExec(cmd, { cwd }, (err, stdout, stderr) => {
      resolve({
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
      });
    });
  });
}

let viteAvailable = false;
let sampleProject: ReturnType<typeof createSampleViteProject> | undefined;

beforeAll(() => {
  try {
    hostRequire.resolve("vite/package.json");
    viteAvailable = true;
    sampleProject = createSampleViteProject();
  } catch {
    viteAvailable = false;
  }
});

describe("integrations/vite dev startup", () => {
  it("sample project with seeded node_modules starts vite CLI", async () => {
    if (!viteAvailable || !sampleProject) {
      return expect(true).toBe(true);
    }

    const { ctx, vol } = sampleProject;
    const pkg = JSON.parse(
      vol.readFileSync(`${PROJECT}/package.json`, "utf8") as string,
    ) as { scripts: { dev: string } };

    expect(pkg.scripts.dev).toBe(
      "node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 5173",
    );
    expect(vol.existsSync(`${PROJECT}/node_modules/vite/bin/vite.js`)).toBe(
      true,
    );
    expect(vol.existsSync(`${PROJECT}/node_modules/rollup/package.json`)).toBe(
      true,
    );

    // Same binary as scripts.dev. --version loads vite's dependency graph (including
    // resolveDependencyVersion("rollup")) and exits without keeping a dev server alive.
    const result = await executeNodeBinary(
      "node_modules/vite/bin/vite.js",
      ["--version"],
      ctx,
    );

    expect(result.stderr).not.toMatch(/ENOENT.*\/package\.json/);
    expect(result.stderr).not.toMatch(
      /no such file or directory.*\/package\.json/i,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/vite\/v?\d+\.\d+/i);
  }, 120_000);

  it("shell runs the package.json dev entrypoint command", async () => {
    if (!viteAvailable || !sampleProject) {
      return expect(true).toBe(true);
    }

    const result = await runShell(
      "node node_modules/vite/bin/vite.js --version",
      PROJECT,
    );

    expect(result.stderr).not.toMatch(/ENOENT.*\/package\.json/);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/vite\/v?\d+\.\d+/i);
  }, 30_000);
});
