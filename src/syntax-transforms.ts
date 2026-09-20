// ESM-to-CJS conversion via acorn AST, with regex fallback

import * as acorn from "acorn";

// Pre-compiled regex patterns for fallback paths (avoid per-call compilation)
const RE_AWAIT_QUICK = /\bawait\b/;
const RE_ASYNC_QUICK = /\basync\b/;
const RE_AWAIT_LOOKAHEAD = /(?<![.\w])await\s+(?=[\w$("'\[`!~+\-/])/;
const RE_AWAIT_LOOKAHEAD_G = /(?<![.\w])await\s+(?=[\w$("'\[`!~+\-/])/g;
const RE_ASYNC_FN_G = /(?<![.\w])async\s+(?=function[\s*(])/g;
const RE_ASYNC_PAREN_G = /(?<![.\w])async\s+(?=\()/g;
const RE_ASYNC_ARROW_G = /(?<![.\w])async\s+(?=\w+\s*=>)/g;
const RE_TYPE_IMPORT_BRACES = /import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?/g;
const RE_TYPE_IMPORT_DEFAULT = /import\s+type\s+\w+\s+from\s+['"][^'"]+['"]\s*;?/g;
const RE_TYPE_IMPORT_STAR = /import\s+type\s+\*\s+as\s+\w+\s+from\s+['"][^'"]+['"]\s*;?/g;
const RE_MIXED_TYPE_IMPORT = /import\s+\{([^}]*\btype\s+\w+[^}]*)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_TYPE_EXPORT_FROM = /export\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?/g;
const RE_TYPE_EXPORT = /export\s+type\s+\{[^}]*\}\s*;?/g;
const RE_IMPORT_STAR = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_IMPORT_DEFAULT_NAMED = /import\s+(\w+)\s*,\s*\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_IMPORT_DEFAULT = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_IMPORT_NAMED = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_IMPORT_SIDE_EFFECT = /import\s+['"]([^'"]+)['"]\s*;?/g;
const RE_EXPORT_DEFAULT_CLASS = /export\s+default\s+class\s+(\w+)/g;
const RE_EXPORT_DEFAULT_FN_NAMED = /export\s+default\s+function\s+(\w+)/g;
const RE_EXPORT_DEFAULT_FN_ANON = /export\s+default\s+function\s*\(/g;
const RE_EXPORT_DEFAULT = /export\s+default\s+/g;
const RE_EXPORT_STAR_AS = /export\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_EXPORT_STAR = /export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_EXPORT_NAMED_FROM = /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g;
const RE_EXPORT_NAMED = /export\s+\{([^}]+)\}\s*;?/g;
const RE_EXPORT_ASYNC_FN = /export\s+async\s+function\s+(\w+)/g;
const RE_EXPORT_FN = /export\s+function\s+(\w+)/g;
const RE_EXPORT_CLASS = /export\s+class\s+(\w+)/g;
const RE_EXPORT_VAR = /export\s+(?:const|let|var)\s+(\w+)\s*=/g;
const RE_AS_RENAME = /(\w+)\s+as\s+(\w+)/g;
const RE_TYPE_SPEC = /^\s*type\s+\w+/;
const RE_AS_SPLIT = /\s+as\s+/;

export interface ESMToCJSOptions {
  /**
   * Expression the module record's exports are reached through, e.g.
   * `__nodepodModule.exports`. Pure default exports assign to it; named
   * exports are written as properties of it. Defaults to `module.exports`
   * / `exports`. Passing a binding the module cannot shadow matters: a
   * bundled chunk that declares its own top-level `var exports = {...}`
   * (an inlined package.json is the usual source) would otherwise receive
   * every named export and the real module would export nothing.
   */
  exportTarget?: string;
}

export function esmToCjs(
  code: string,
  options: ESMToCJSOptions = {},
): string {
  try {
    return esmToCjsViaAst(code, options);
  } catch {
    return esmToCjsViaRegex(code, options);
  }
}

// collect ESM→CJS patches from a pre-parsed AST, pushes into the patches array
export function collectEsmCjsPatches(
  ast: any,
  code: string,
  patches: Array<[number, number, string]>,
  options: ESMToCJSOptions = {},
): void {
  const hasDefaultExport = ast.body.some(
    (n: any) => n.type === "ExportDefaultDeclaration",
  );
  // ExportAllDeclaration covers `export * from` and `export * as X from`,
  // both produce named exports. without counting them mixed with a default
  // export, `module.exports = X` ends up clobbering the named ones. #56
  const hasNamedExport = ast.body.some(
    (n: any) =>
      n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration",
  );
  const mixedExports = hasDefaultExport && hasNamedExport;
  const defaultExportTarget = options.exportTarget ?? "module.exports";
  const namedTarget = options.exportTarget ?? "exports";
  // collected during the walk, prepended at the bottom of this fn
  const hoistedFunctionExports: string[] = [];

  for (const node of ast.body) {
    if (node.type === "ImportDeclaration") {
      const src = node.source.value;
      const specs = node.specifiers;

      if (specs.length === 0) {
        patches.push([
          node.start,
          node.end,
          `require(${JSON.stringify(src)});`,
        ]);
      } else {
        const defSpec = specs.find(
          (s: any) => s.type === "ImportDefaultSpecifier",
        );
        const nsSpec = specs.find(
          (s: any) => s.type === "ImportNamespaceSpecifier",
        );
        const namedSpecs = specs.filter(
          (s: any) => s.type === "ImportSpecifier",
        );

        const lines: string[] = [];
        const tmpVar = `__import_${node.start}`;
        const needsTmp = defSpec && (namedSpecs.length > 0 || nsSpec);

        if (needsTmp) {
          lines.push(`const ${tmpVar} = require(${JSON.stringify(src)})`);
          lines.push(
            `const ${defSpec.local.name} = ${tmpVar}.__esModule ? ${tmpVar}.default : ${tmpVar}`,
          );
        } else if (defSpec) {
          lines.push(
            `const ${defSpec.local.name} = (function(m) { return m.__esModule ? m.default : m; })(require(${JSON.stringify(src)}))`,
          );
        }

        if (nsSpec) {
          if (!needsTmp) {
            lines.push(
              `const ${nsSpec.local.name} = require(${JSON.stringify(src)})`,
            );
          } else {
            lines.push(`const ${nsSpec.local.name} = ${tmpVar}`);
          }
        }

        if (namedSpecs.length > 0) {
          const binds = namedSpecs
            .map((s: any) =>
              s.imported.name === s.local.name
                ? s.local.name
                : `${s.imported.name}: ${s.local.name}`,
            )
            .join(", ");
          if (needsTmp) {
            lines.push(`const { ${binds} } = ${tmpVar}`);
          } else {
            lines.push(`const { ${binds} } = require(${JSON.stringify(src)})`);
          }
        }
        patches.push([node.start, node.end, lines.join(";\n") + ";"]);
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      const exportTarget = mixedExports
        ? `${namedTarget}.default`
        : defaultExportTarget;

      if (
        (decl.type === "FunctionDeclaration" ||
          decl.type === "ClassDeclaration") &&
        decl.id?.name
      ) {
        // Non-overlapping: remove "export default ", append binding
        patches.push([node.start, decl.start, ""]);
        patches.push([
          node.end,
          node.end,
          `;\n${exportTarget} = ${decl.id.name};`,
        ]);
      } else {
        // Replace "export default " with assignment target
        patches.push([node.start, decl.start, `${exportTarget} = `]);
      }
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        const decl = node.declaration;
        if (decl.type === "FunctionDeclaration") {
          const name = decl.id.name;
          // assignment goes at the top via hoistedFunctionExports below.
          // function decls are value-hoisted so prepending exports.X = X
          // before the body works, which fixes circular ESM (typebox's
          // instantiate.mjs <-> awaited/instantiate.mjs). #56
          patches.push([node.start, decl.start, ""]);
          hoistedFunctionExports.push(name);
        } else if (decl.type === "ClassDeclaration") {
          const name = decl.id.name;
          // classes are TDZ, can't assign before the decl. keep trailing.
          // circular imports of class exports can still see undefined.
          patches.push([node.start, decl.start, ""]);
          patches.push([
            node.end,
            node.end,
            `;\n${namedTarget}.${name} = ${name};`,
          ]);
        } else if (decl.type === "VariableDeclaration") {
          const needsLiveBinding = decl.kind === "let" || decl.kind === "var";
          const hasDestructuring = decl.declarations.some(
            (d: any) =>
              d.id.type === "ObjectPattern" || d.id.type === "ArrayPattern",
          );
          // Remove "export " prefix
          patches.push([node.start, decl.start, ""]);
          // Append export bindings after declaration
          const bindings: string[] = [];
          if (hasDestructuring) {
            for (const d of decl.declarations) {
              for (const name of extractBindingNames(d.id)) {
                if (needsLiveBinding) {
                  bindings.push(
                    `Object.defineProperty(${namedTarget}, ${JSON.stringify(name)}, { get() { return ${name}; }, enumerable: true })`,
                  );
                } else {
                  bindings.push(`${namedTarget}.${name} = ${name}`);
                }
              }
            }
          } else {
            for (const d of decl.declarations) {
              if (needsLiveBinding) {
                bindings.push(
                  `Object.defineProperty(${namedTarget}, ${JSON.stringify(d.id.name)}, { get() { return ${d.id.name}; }, enumerable: true })`,
                );
              } else {
                bindings.push(`${namedTarget}.${d.id.name} = ${d.id.name}`);
              }
            }
          }
          patches.push([
            node.end,
            node.end,
            "\n" + bindings.join(";\n") + ";",
          ]);
        }
      } else if (node.source) {
        const src = node.source.value;
        const tmp = `__reexport_${node.start}`;
        const lines = [`const ${tmp} = require(${JSON.stringify(src)})`];
        for (const spec of node.specifiers) {
          if (spec.local.name === "default") {
            lines.push(
              `${namedTarget}.${spec.exported.name} = ${tmp}.__esModule ? ${tmp}.default : ${tmp}`,
            );
          } else {
            lines.push(
              `${namedTarget}.${spec.exported.name} = ${tmp}.${spec.local.name}`,
            );
          }
        }
        patches.push([node.start, node.end, lines.join(";\n") + ";"]);
      } else {
        const lines = node.specifiers.map(
          (s: any) => `${namedTarget}.${s.exported.name} = ${s.local.name}`,
        );
        patches.push([node.start, node.end, lines.join(";\n") + ";"]);
      }
    } else if (node.type === "ExportAllDeclaration") {
      const src = node.source.value;
      if (node.exported) {
        const name = node.exported.name || node.exported.value;
        patches.push([
          node.start,
          node.end,
          `${namedTarget}[${JSON.stringify(name)}] = require(${JSON.stringify(src)})`,
        ]);
      } else {
        patches.push([
          node.start,
          node.end,
          `Object.assign(${namedTarget}, require(${JSON.stringify(src)}))`,
        ]);
      }
    }
  }

  // hoist exports.X = X for every `export function X` so circular consumers
  // see populated exports during a partial load. function decls are
  // value-hoisted, classes/let/const arent (TDZ) so they stay trailing. #56
  if (hoistedFunctionExports.length > 0) {
    const prefix =
      hoistedFunctionExports
        .map((n) => `${namedTarget}.${n} = ${n};`)
        .join("\n") + "\n";
    patches.push([0, 0, prefix]);
  }
}

function esmToCjsViaAst(code: string, options: ESMToCJSOptions): string {
  const ast = acorn.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const patches: Array<[number, number, string]> = [];
  collectEsmCjsPatches(ast as any, code, patches, options);

  let output = code;
  patches.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [s, e, r] of patches)
    output = output.slice(0, s) + r + output.slice(e);
  return output;
}

// extract all bound names from a destructuring pattern or identifier
function extractBindingNames(pattern: any): string[] {
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }
  if (pattern.type === "ObjectPattern") {
    const names: string[] = [];
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") {
        names.push(...extractBindingNames(prop.argument));
      } else {
        names.push(...extractBindingNames(prop.value));
      }
    }
    return names;
  }
  if (pattern.type === "ArrayPattern") {
    const names: string[] = [];
    for (const elem of pattern.elements) {
      if (elem) {
        if (elem.type === "RestElement") {
          names.push(...extractBindingNames(elem.argument));
        } else {
          names.push(...extractBindingNames(elem));
        }
      }
    }
    return names;
  }
  if (pattern.type === "AssignmentPattern") {
    return extractBindingNames(pattern.left);
  }
  return [];
}

export function hasTopLevelAwait(code: string): boolean {
  if (!RE_AWAIT_QUICK.test(code)) return false;

  try {
    let ast: any;
    try {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "script",
        allowAwaitOutsideFunction: true,
      });
    } catch {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
      });
    }

    let found = false;
    let insideAsync = 0;

    function walk(node: any): void {
      if (found || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node.type !== "string") return;

      const isAsyncFn =
        (node.type === "FunctionDeclaration" ||
          node.type === "FunctionExpression" ||
          node.type === "ArrowFunctionExpression") &&
        node.async;

      if (isAsyncFn) insideAsync++;
      if (node.type === "AwaitExpression" && insideAsync === 0) {
        found = true;
      }
      if (node.type === "ForOfStatement" && node.await && insideAsync === 0) {
        found = true;
      }
      if (!found) {
        for (const key in node) {
          if (key === "type" || key === "start" || key === "end") continue;
          const val = node[key];
          if (val && typeof val === "object") walk(val);
        }
      }
      if (isAsyncFn) insideAsync--;
    }

    walk(ast);
    return found;
  } catch {
    return RE_AWAIT_LOOKAHEAD.test(code);
  }
}

export function stripTopLevelAwait(
  code: string,
  mode: "topLevelOnly" | "full" = "topLevelOnly",
): string {
  const full = mode === "full";
  if (!full && !RE_AWAIT_QUICK.test(code)) return code;
  if (full && !RE_AWAIT_QUICK.test(code) && !RE_ASYNC_QUICK.test(code)) return code;

  try {
    let ast: any;
    try {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "script",
        allowAwaitOutsideFunction: true,
      });
    } catch {
      ast = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
      });
    }

    const patches: Array<[number, number, string]> = [];
    let insideAsync = 0;

    function walk(node: any) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (typeof node.type !== "string") return;

      const isAsyncFn =
        (node.type === "FunctionDeclaration" ||
          node.type === "FunctionExpression" ||
          node.type === "ArrowFunctionExpression") &&
        node.async;

      if (isAsyncFn) insideAsync++;

      if (full && isAsyncFn && !node.generator) {
        if (code.slice(node.start, node.start + 5) === "async") {
          let end = node.start + 5;
          while (end < code.length && (code[end] === " " || code[end] === "\t")) end++;
          patches.push([node.start, end, ""]);
        } else {
          const searchStart = Math.max(0, node.start - 30);
          const region = code.slice(searchStart, node.start);
          const asyncIdx = region.lastIndexOf("async");
          if (asyncIdx >= 0) {
            const absStart = searchStart + asyncIdx;
            let absEnd = absStart + 5;
            while (absEnd < code.length && (code[absEnd] === " " || code[absEnd] === "\t")) absEnd++;
            patches.push([absStart, absEnd, ""]);
          }
        }
      }

      if (node.type === "AwaitExpression") {
        if (full || insideAsync === 0) {
          let awaitEnd = node.start + 5;
          while (
            awaitEnd < node.argument.start &&
            (code[awaitEnd] === " " || code[awaitEnd] === "\t" || code[awaitEnd] === "\n" || code[awaitEnd] === "\r")
          ) {
            awaitEnd++;
          }
          patches.push([node.start, awaitEnd, "__syncAwait("]);
          patches.push([node.end, node.end, ")"]);
        }
      }

      if (node.type === "ForOfStatement" && node.await) {
        if (full || insideAsync === 0) {
          const forEnd = node.start + 3;
          const snippet = code.slice(forEnd, node.left.start);
          const awIdx = snippet.indexOf("await");
          if (awIdx >= 0) {
            const absStart = forEnd + awIdx;
            let absEnd = absStart + 5;
            while (absEnd < code.length && code[absEnd] === " ") absEnd++;
            patches.push([absStart, absEnd, ""]);
          }
        }
      }

      for (const key in node) {
        if (key === "type" || key === "start" || key === "end") continue;
        const val = node[key];
        if (val && typeof val === "object") walk(val);
      }

      if (isAsyncFn) insideAsync--;
    }

    walk(ast);

    if (patches.length === 0) return code;

    let output = code;
    patches.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    for (const [start, end, replacement] of patches) {
      output = output.slice(0, start) + replacement + output.slice(end);
    }
    return output;
  } catch {
    if (full) {
      let out = code.replace(RE_AWAIT_LOOKAHEAD_G, "");
      out = out.replace(RE_ASYNC_FN_G, "");
      out = out.replace(RE_ASYNC_PAREN_G, "");
      out = out.replace(RE_ASYNC_ARROW_G, "");
      return out;
    }
    return code.replace(RE_AWAIT_LOOKAHEAD_G, "");
  }
}

function esmToCjsViaRegex(
  code: string,
  options: ESMToCJSOptions,
): string {
  let out = code;
  const exportTarget = options.exportTarget ?? "module.exports";
  const namedTarget = options.exportTarget ?? "exports";
  // strip TS type-only imports
  out = out.replace(RE_TYPE_IMPORT_BRACES, "");
  out = out.replace(RE_TYPE_IMPORT_DEFAULT, "");
  out = out.replace(RE_TYPE_IMPORT_STAR, "");
  // remove inline type specifiers from mixed imports
  out = out.replace(
    RE_MIXED_TYPE_IMPORT,
    (_m, specs: string, src: string) => {
      const kept = specs
        .split(",")
        .filter((s: string) => !RE_TYPE_SPEC.test(s))
        .map((s: string) => s.trim())
        .filter(Boolean);
      if (kept.length === 0) return "";
      const fixed = kept.join(", ").replace(RE_AS_RENAME, "$1: $2");
      return `const {${fixed}} = require("${src}");`;
    },
  );
  // strip TS type-only exports
  out = out.replace(RE_TYPE_EXPORT_FROM, "");
  out = out.replace(RE_TYPE_EXPORT, "");
  out = out.replace(RE_IMPORT_STAR, 'const $1 = require("$2");');
  out = out.replace(
    RE_IMPORT_DEFAULT_NAMED,
    (_m, def, named, src) => {
      const tmp = `__import_${def}`;
      const fixed = named.replace(RE_AS_RENAME, "$1: $2");
      return `const ${tmp} = require("${src}"); const ${def} = ${tmp}.__esModule ? ${tmp}.default : ${tmp}; const {${fixed}} = ${tmp};`;
    },
  );
  out = out.replace(RE_IMPORT_DEFAULT, 'const $1 = require("$2");');
  out = out.replace(
    RE_IMPORT_NAMED,
    (_m, specs, src) => {
      const fixed = specs.replace(RE_AS_RENAME, "$1: $2");
      return `const {${fixed}} = require("${src}");`;
    },
  );
  out = out.replace(RE_IMPORT_SIDE_EFFECT, 'require("$1");');
  // export default
  out = out.replace(RE_EXPORT_DEFAULT_CLASS, `${exportTarget} = class $1`);
  out = out.replace(RE_EXPORT_DEFAULT_FN_NAMED, `${exportTarget} = function $1`);
  out = out.replace(RE_EXPORT_DEFAULT_FN_ANON, `${exportTarget} = function(`);
  out = out.replace(RE_EXPORT_DEFAULT, `${exportTarget} = `);
  // re-exports
  out = out.replace(RE_EXPORT_STAR_AS, `${namedTarget}.$1 = require("$2");`);
  out = out.replace(RE_EXPORT_STAR, `Object.assign(${namedTarget}, require("$1"));`);
  out = out.replace(
    RE_EXPORT_NAMED_FROM,
    (_m, specs, src) => {
      const binds = specs
        .split(",")
        .map((s: string) => {
          const parts = s.trim().split(RE_AS_SPLIT);
          const local = parts[0].trim();
          const exported = parts.length > 1 ? parts[1].trim() : local;
          return `${namedTarget}.${exported} = require("${src}").${local}`;
        })
        .join("; ");
      return binds + ";";
    },
  );
  out = out.replace(
    RE_EXPORT_NAMED,
    (_m, specs) => {
      const binds = specs
        .split(",")
        .map((s: string) => {
          const parts = s.trim().split(RE_AS_SPLIT);
          const local = parts[0].trim();
          const exported = parts.length > 1 ? parts[1].trim() : local;
          return `${namedTarget}.${exported} = ${local}`;
        })
        .join("; ");
      return binds + ";";
    },
  );
  // named exports
  out = out.replace(RE_EXPORT_ASYNC_FN, `${namedTarget}.$1 = async function $1`);
  out = out.replace(RE_EXPORT_FN, `${namedTarget}.$1 = function $1`);
  out = out.replace(RE_EXPORT_CLASS, `${namedTarget}.$1 = class $1`);
  out = out.replace(RE_EXPORT_VAR, `${namedTarget}.$1 =`);
  return out;
}
