import { expect, test } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";

interface Completion {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CompatibilityResult {
  error?: string;
  validation: Completion;
  probes: Record<string, Completion>;
  buildArtifacts: { clientAssets: string[]; serverBytes: number };
}

interface CompatibilityWindow extends Window {
  runCompatibility(router: string, vite: string): Promise<CompatibilityResult>;
}

for (const [routerVersion, viteVersion] of [
  ["8.4.0", "^8.0.0"],
  ["7.1.0", "6.4.4"],
] as const) {
  test(`Forge Router ${routerVersion} / Vite ${viteVersion} validates in browser Nodepod`, async ({
    page,
  }, testInfo) => {
    test.skip(
      !existsSync("memory/forge-router-fixture.json"),
      "Prepare the original Forge starter with prepare-forge-compatibility.mjs",
    );
    test.setTimeout(240_000);
    await page.goto("/tests/browser/forge-compatibility.html");
    const result = await page.evaluate(
      ([router, vite]) => (window as CompatibilityWindow).runCompatibility(router, vite),
      [routerVersion, viteVersion],
    );
    writeFileSync(
      `memory/forge-router-${routerVersion}-results.json`,
      JSON.stringify(result, null, 2),
    );
    await testInfo.attach("forge-compatibility.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });
    expect(result.error).toBeUndefined();
    expect(result.validation, result.validation?.stderr).toMatchObject({ exitCode: 0 });
    expect(result.validation.stdout).not.toContain("Oops, Node");
    for (const name of [
      "node-test",
      "conditional-fixture",
      "router-imports",
      "punycode",
      "external-package-bundle",
    ]) {
      expect(result.probes[name], name).toMatchObject({ exitCode: 0 });
    }
    if (routerVersion === "7.1.0") expect(result.probes.spdx).toMatchObject({ exitCode: 0 });
    expect(result.buildArtifacts.clientAssets.length).toBeGreaterThan(0);
    expect(result.buildArtifacts.serverBytes).toBeGreaterThan(0);
  });
}
