// Error thrown when Nodepod.boot() can't reach /__sw__.js. Includes a
// framework-specific hint so the user knows which one-liner to add.

export type NodepodSWFrameworkHint = "vite" | "next" | "generic";

export interface NodepodSWSetupErrorDetails {
  swUrl: string;
  status?: number;
  contentType?: string;
  /** Underlying network/abort error, if the preflight never got a response. */
  cause?: unknown;
  framework: NodepodSWFrameworkHint;
}

const HINTS: Record<NodepodSWFrameworkHint, string> = {
  vite: [
    "Detected Vite. Add the nodepod plugin to serve __sw__.js automatically:",
    "",
    "  // vite.config.ts",
    "  import nodepod from '@r1ck404/nodepod/vite';",
    "  export default defineConfig({ plugins: [nodepod()] });",
  ].join("\n"),
  next: [
    "Detected Next.js. Add a route handler to serve __sw__.js:",
    "",
    "  // app/__sw__.js/route.ts",
    "  export { GET } from '@r1ck404/nodepod/next';",
    "",
    "Or compose `nodepodProxy` (Next 16+, proxy.ts) / `nodepodMiddleware`",
    "(Next <=15, middleware.ts) alongside your own handler.",
  ].join("\n"),
  generic: [
    "No recognised framework detected. Either:",
    "",
    "  1. Mount the framework-agnostic handler:",
    "       import { serveSW } from '@r1ck404/nodepod/server';",
    "       app.get('/__sw__.js', () => serveSW());",
    "",
    "  2. Or copy node_modules/@r1ck404/nodepod/dist/__sw__.js",
    "     into your public/ (or static/) directory so it's served at /__sw__.js",
    "     from the same origin as your page.",
  ].join("\n"),
};

export class NodepodSWSetupError extends Error {
  readonly details: NodepodSWSetupErrorDetails;

  constructor(message: string, details: NodepodSWSetupErrorDetails) {
    super(message);
    this.name = "NodepodSWSetupError";
    this.details = details;
    if (details.cause !== undefined) {
      (this as { cause?: unknown }).cause = details.cause;
    }
  }

  override toString(): string {
    const { swUrl, status, contentType, framework } = this.details;
    const lines: string[] = [
      `NodepodSWSetupError: ${this.message}`,
      "",
      `  Requested:    ${swUrl}`,
    ];
    if (status !== undefined) {
      lines.push(`  HTTP status:  ${status}`);
    }
    if (contentType !== undefined) {
      lines.push(`  Content-Type: ${contentType}`);
    }
    lines.push("", HINTS[framework]);
    return lines.join("\n");
  }
}

/**
 * Guess which framework hint to show by sniffing the current runtime.
 * Defaults to "generic" if nothing matches.
 */
export function detectFrameworkHint(): NodepodSWFrameworkHint {
  try {
    const w = typeof window !== "undefined"
      ? (window as unknown as Record<string, unknown>)
      : null;
    if (w) {
      if (
        "__vite_plugin_react_preamble_installed__" in w ||
        "__VITE_PRELOAD__" in w ||
        "__vite_is_modern_browser" in w
      ) {
        return "vite";
      }
      if (
        "next" in w ||
        "__NEXT_DATA__" in w ||
        "__NEXT_ROUTER_BASEPATH__" in w
      ) {
        return "next";
      }
    }
  } catch {
    // detection must never throw
  }
  return "generic";
}
