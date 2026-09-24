// Fast module-syntax classification backed by es-module-lexer (the lexer
// Vite uses). It skips strings, comments, templates and regex literals like
// a real tokenizer, at roughly 10x the speed of an acorn parse and without
// building an AST, so the loader only pays for a full parse when a module
// actually uses static import/export syntax.

import { initSync, parse } from "es-module-lexer";

let ready = false;

export type LexedModule = ReturnType<typeof parse>;

/** Lex `source`, or return null when the lexer rejects it. */
export function lexModule(source: string): LexedModule | null {
  try {
    if (!ready) {
      initSync();
      ready = true;
    }
    return parse(source);
  } catch {
    return null;
  }
}

// ImportType.Static / StaticSourcePhase / StaticDeferPhase
const STATIC_IMPORT_TYPES = new Set([1, 4, 6]);

/** True when the lexed module has static import or export statements. */
export function hasStaticModuleSyntax(lexed: LexedModule): boolean {
  if (lexed[1].length > 0) return true;
  for (const imp of lexed[0]) if (STATIC_IMPORT_TYPES.has(imp.t)) return true;
  return false;
}

/**
 * Rewrite `import(` to `__asyncLoad(` and `import.meta` to `import_meta`
 * using lexer positions. Returns `source` unchanged when there is nothing to
 * patch.
 */
export function patchDynamicImports(source: string, lexed: LexedModule): string {
  const imports = lexed[0];
  let out = "";
  let pos = 0;
  for (const imp of imports) {
    if (imp.d === -2) {
      out += source.slice(pos, imp.ss) + "import_meta";
      pos = imp.se;
    } else if (imp.d > -1 && imp.t === 2) {
      out += source.slice(pos, imp.ss) + "__asyncLoad";
      pos = imp.ss + 6;
    }
  }
  if (pos === 0) return source;
  return out + source.slice(pos);
}
