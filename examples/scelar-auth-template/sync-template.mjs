/**
 * Materialize Scelar's AUTH_TEMPLATE_FILES into examples/scelar-auth-template/app/.
 *
 * Run from repo root:
 *   node examples/scelar-auth-template/sync-template.mjs
 *
 * Optional: SCELAR_ROOT=/path/to/scelar (defaults to ../../../scelar)
 */
import esbuild from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const scelarRoot = resolve(process.env.SCELAR_ROOT || resolve(here, "../../../scelar"));
const entry = resolve(scelarRoot, "app/lib/nodepod/templates/auth.ts");
const outputDir = resolve(here, "app");

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});

const source = result.outputFiles[0].text;
const template = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
);

if (!template.AUTH_TEMPLATE_FILES) {
  throw new Error(
    `Failed to load AUTH_TEMPLATE_FILES from ${entry}. Is SCELAR_ROOT correct?`,
  );
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const files = Object.entries(template.AUTH_TEMPLATE_FILES).sort(([a], [b]) =>
  a.localeCompare(b),
);

const manifest = [];
for (const [vfsPath, content] of files) {
  const rel = vfsPath.replace(/^\//, "");
  const outputPath = resolve(outputDir, rel);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, "utf8");
  manifest.push(rel);
}

writeFileSync(
  resolve(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

console.log(`Wrote ${manifest.length} files to ${outputDir}`);
