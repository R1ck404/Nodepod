// Post-process emitted .d.ts files so every relative specifier carries an
// explicit extension. Consumers on moduleResolution node16/nodenext resolve
// extensionless relative paths in declaration files to `any`.
//
// src/ already uses explicit `.js` specifiers; this only catches the ones tsc
// synthesizes itself, e.g. `typeof import("./module").createRequire` for the
// expando assignments on `Module` in src/polyfills/module.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.{1,2}(?:\/[^"']*)?)\2/g;

export function withExtension(specifier, fromFile, exists = fs.existsSync) {
  if (/\.(?:[cm]?js|json|d\.[cm]?ts)$/.test(specifier)) return specifier;
  const target = path.resolve(path.dirname(fromFile), specifier);
  if (exists(`${target}.d.ts`)) return `${specifier}.js`;
  if (exists(path.join(target, "index.d.ts"))) return `${specifier.replace(/\/$/, "")}/index.js`;
  return specifier;
}

export function fixDeclarationText(text, fromFile, exists) {
  return text.replace(SPECIFIER, (match, head, quote, spec) => {
    const fixed = withExtension(spec, fromFile, exists);
    return fixed === spec ? match : `${head}${quote}${fixed}${quote}`;
  });
}

export function fixDeclarationDir(dir) {
  let changed = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".d.ts")) {
        const before = fs.readFileSync(full, "utf8");
        const after = fixDeclarationText(before, full);
        if (after !== before) {
          fs.writeFileSync(full, after);
          changed++;
        }
      }
    }
  };
  walk(dir);
  return changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2] ?? "dist");
  console.log(`fix-dts-extensions: updated ${fixDeclarationDir(dir)} declaration file(s) in ${dir}`);
}
