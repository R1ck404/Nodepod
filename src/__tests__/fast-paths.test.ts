import { describe, expect, it } from "vitest";
import * as acorn from "acorn";
import { topLevelParser } from "../syntax-transforms";
import { normalize } from "../polyfills/path";
import { MemoryVolume } from "../memory-volume";
import { parseTarArchive } from "../packages/archive-extractor";
import { bytesMentionWasiConvention, findWasiPackageReferences, scanExtractedFile } from "../packages/installer";
import { parseSemver, pickBestMatch } from "../packages/version-resolver";
import { decodeShortAscii } from "../helpers/byte-encoding";
import { Buffer } from "../polyfills/buffer";
import { ScriptEngine } from "../script-engine";

// deterministic pseudo-random
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
}

// path.normalize as it was before the already-normalized fast path
function referenceNormalize(inputPath: string): string {
  if (!inputPath) return ".";
  const rooted = inputPath.charAt(0) === "/";
  const stack: string[] = [];
  for (const token of inputPath.split("/").filter((t) => t.length > 0)) {
    if (token === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!rooted) stack.push("..");
    } else if (token !== ".") {
      stack.push(token);
    }
  }
  const output = (rooted ? "/" : "") + stack.join("/");
  return output || ".";
}

function randomPath(next: () => number): string {
  const parts = ["a", "b", ".", "..", "", ".hidden", "..x", "x..", "...", "node_modules", "@s", "é"];
  const segs: string[] = [];
  const n = Math.floor(next() * 6);
  for (let j = 0; j < n; j++) segs.push(parts[Math.floor(next() * parts.length)]);
  return (next() < 0.5 ? "/" : "") + segs.join("/") + (next() < 0.2 ? "/" : "");
}

describe("path.normalize", () => {
  it("matches the full normalization on random paths", () => {
    const next = rng(1);
    for (let i = 0; i < 50_000; i++) {
      const p = randomPath(next);
      expect(normalize(p)).toBe(referenceNormalize(p));
    }
  });
});

describe("volume path handling", () => {
  it("resolves unnormalized and symlinked paths like normalized ones", () => {
    const vol = new MemoryVolume();
    vol.writeFileSync("/app/node_modules/pkg/lib/index.js", "x");
    vol.symlinkSync("/app/node_modules/pkg", "/app/node_modules/alias");
    vol.symlinkSync("lib", "/app/node_modules/pkg/current");
    for (const p of [
      "/app/node_modules/pkg/lib/index.js",
      "/app//node_modules/pkg/./lib/index.js",
      "/app/node_modules/pkg/lib/../lib/index.js",
      "app/node_modules/pkg/lib/index.js",
      "/app/node_modules/alias/lib/index.js",
      "/app/node_modules/alias/current/index.js",
      "/app/node_modules/pkg/current/../current/index.js",
    ]) {
      expect(vol.readFileSync(p, "utf8")).toBe("x");
    }
    expect(vol.existsSync("/app/node_modules/pkg/lib/")).toBe(true);
    expect(vol.existsSync("/app/node_modules/pkg/nope")).toBe(false);
    expect(vol.lstatSync("/app/node_modules/alias").isSymbolicLink()).toBe(true);
  });

  it("reports symlink loops", () => {
    const vol = new MemoryVolume();
    vol.symlinkSync("/loop/b", "/loop/a");
    vol.symlinkSync("/loop/a", "/loop/b");
    expect(() => vol.readFileSync("/loop/a")).toThrow(/ELOOP/);
  });
});

function tarEntry(name: string, body: string, fields: { mode?: string; size?: string } = {}): Uint8Array[] {
  const enc = new TextEncoder();
  const payload = enc.encode(body);
  const header = new Uint8Array(512);
  header.set(enc.encode(name).slice(0, 100), 0);
  header.set(enc.encode(fields.mode ?? "0000644\0"), 100);
  header.set(enc.encode(fields.size ?? payload.length.toString(8).padStart(11, "0") + "\0"), 124);
  header[156] = 48;
  return [header, payload, new Uint8Array((512 - (payload.length % 512)) % 512)];
}

function tar(...entries: Uint8Array[][]): Uint8Array {
  const parts = [...entries.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("tar headers", () => {
  it("reads names, modes and sizes in their usual encodings", () => {
    const entries = [
      ...parseTarArchive(
        tar(
          tarEntry("package/index.js", "hello"),
          tarEntry("package/ünïcode/file.js", "utf8 name"),
          tarEntry("package/spaced.js", "abc", { mode: " 000755 ", size: "     3 \0" }),
          tarEntry("package/empty.js", ""),
        ),
      ),
    ];
    expect(entries.map((e) => e.filepath)).toEqual([
      "package/index.js",
      "package/ünïcode/file.js",
      "package/spaced.js",
      "package/empty.js",
    ]);
    expect(entries.map((e) => new TextDecoder().decode(e.payload))).toEqual(["hello", "utf8 name", "abc", ""]);
    expect(entries[0].fileMode).toBe(0o644);
    expect(entries[2].fileMode).toBe(0o755);
    expect(entries[2].byteSize).toBe(3);
  });
});

describe("WASI companion scan", () => {
  it("spots the convention in bytes exactly where the text test does", () => {
    const next = rng(7);
    const alphabet = ["-wasm32-wasi", "-WASM32-WASI", "-Wasm32-wasi", "wasm32-wasi", "32-", "-wasm32", "m32-wasi", "abc", " ", "3", "2", "-", "w"];
    const re = /-wasm32-wasi/i;
    for (let i = 0; i < 20_000; i++) {
      let s = "";
      const n = Math.floor(next() * 8);
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(next() * alphabet.length)];
      expect(bytesMentionWasiConvention(new TextEncoder().encode(s))).toBe(re.test(s));
    }
  });

  it("finds references in the files the post-install scan reads", () => {
    const refs = new Set<string>();
    const enc = new TextEncoder();
    scanExtractedFile("dist/index.js", enc.encode('require("@scope/native-wasm32-wasi")'), refs);
    scanExtractedFile("package.json", enc.encode('{"optionalDependencies":{"tool-wasm32-wasi":"1.0.0"}}'), refs);
    // skipped like the scan skips them
    scanExtractedFile("index.d.ts", enc.encode('"typed-wasm32-wasi"'), refs);
    scanExtractedFile("README.md", enc.encode('"docs-wasm32-wasi"'), refs);
    scanExtractedFile("node_modules/dep/index.js", enc.encode('"nested-wasm32-wasi"'), refs);
    scanExtractedFile("lib/plain.js", "module.exports = 1;", refs);
    expect([...refs].sort()).toEqual(["@scope/native-wasm32-wasi", "tool-wasm32-wasi"]);
    expect(findWasiPackageReferences('import "a-wasm32-wasi/x.js"')).toEqual(["a-wasm32-wasi"]);
  });
});

describe("semver picking", () => {
  it("picks the same versions with parsed versions reused", () => {
    const versions = ["1.0.0", "1.2.0", "1.10.0", "2.0.0-beta.1", "2.0.0-beta.10", "2.0.0-beta.2", "2.0.0", "2.1.0-rc.1", "0.0.3", "0.1.0"];
    for (let round = 0; round < 3; round++) {
      expect(pickBestMatch(versions, "^1.0.0")).toBe("1.10.0");
      expect(pickBestMatch(versions, "^2.0.0-beta.1")).toBe("2.0.0");
      expect(pickBestMatch(versions, ">=2.0.0-beta.2 <2.0.0")).toBe("2.0.0-beta.10");
      expect(pickBestMatch(versions, "~0.0.3")).toBe("0.0.3");
      expect(pickBestMatch(versions, "^3.0.0")).toBeNull();
    }
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseSemver("not-a-version")).toBeNull();
  });
});

describe("top-level parse for module conversion", () => {
  const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
  function emptyBodies(node: any): void {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) emptyBodies(c);
      return;
    }
    if (FN.has(node.type) && node.body?.type === "BlockStatement") {
      node.body.body = [];
      return;
    }
    for (const k in node) if (k !== "type") emptyBodies(node[k]);
  }
  const opts = { ecmaVersion: "latest" as const, sourceType: "module" as const };

  it("builds the full parser's tree, function bodies left empty", () => {
    const source = [
      "import a, { b as c } from './x.js';",
      "export const re = /[{}]/g, s = '{', t = `${'}'}${`{${1}}`}`;",
      "export function f(x) { if (x) /}/.test(x); const o = { a: { b: '}' } }; return `}${o}`; }",
      "export default class K { static #p = 1; get g() { return '{'; } m() { return () => { /* } */ }; } static { this.q = 2; } }",
      "export async function* gen() { for await (const v of [1]) yield v; }",
      "const arrow = async (x) => { await x; return { '}': x }; };",
      "const expr = (x) => ({ '{': x });",
      "label: { const y = function inner() { // }\n return 1; }; }",
      "export { arrow, expr as renamed };",
      "export * as ns from './y.js';",
      "await Promise.resolve();",
    ].join("\n");
    const full = acorn.parse(source, opts) as any;
    const top = topLevelParser().parse(source, opts) as any;
    emptyBodies(full);
    expect(JSON.stringify(top)).toBe(JSON.stringify(full));
  });

  it("rejects what the full parser rejects outside function bodies", () => {
    expect(() => topLevelParser().parse("export const = 1;", opts)).toThrow();
    expect(() => topLevelParser().parse("function f() { {", opts)).toThrow();
  });
});

describe("package pack contents", () => {
  it("holds installed packages, not tools' caches in node_modules", async () => {
    const { isPackFile } = await import("../packages/installer");
    expect(isPackFile("/app/node_modules/react/index.js")).toBe(true);
    expect(isPackFile("/app/node_modules/.bin/vite")).toBe(true);
    expect(isPackFile("/app/node_modules/.package-lock.json")).toBe(true);
    expect(isPackFile("/app/node_modules/a/node_modules/b/x.js")).toBe(true);
    expect(isPackFile("/app/node_modules/.vite/deps/react.js")).toBe(false);
    expect(isPackFile("/app/node_modules/.vite")).toBe(false);
    expect(isPackFile("/app/node_modules/.cache/babel/x")).toBe(false);
    expect(isPackFile("/app/node_modules/.vitest/x")).toBe(true);
    expect(isPackFile("/app/src/index.js")).toBe(false);
  });
});

describe("short ASCII decoding", () => {
  const native = new TextDecoder();

  function randomBytes(next: () => number): Uint8Array {
    const length = Math.floor(next() * 90);
    const ascii = next() < 0.7;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = ascii ? Math.floor(next() * 128) : Math.floor(next() * 256);
    return bytes;
  }

  it("decodes what it takes exactly like TextDecoder", () => {
    const next = rng(7);
    let taken = 0;
    for (let i = 0; i < 20000; i++) {
      const bytes = randomBytes(next);
      const short = decodeShortAscii(bytes);
      if (short === null) continue;
      taken++;
      expect(short).toBe(native.decode(bytes));
    }
    expect(taken).toBeGreaterThan(1000);
    expect(decodeShortAscii(new Uint8Array([0x68, 0xc3, 0xa9]))).toBeNull();
    expect(decodeShortAscii(new Uint8Array(65).fill(0x61))).toBeNull();
  });

  it("leaves Buffer#toString unchanged, shared memory included", () => {
    const next = rng(11);
    const shared = new Uint8Array(new SharedArrayBuffer(128));
    for (let i = 0; i < 5000; i++) {
      const bytes = randomBytes(next);
      expect(Buffer.from(bytes).toString()).toBe(native.decode(bytes));
      expect(Buffer.from(bytes).toString("utf8", 1, 20)).toBe(native.decode(bytes.subarray(1, 20)));
      shared.fill(0);
      shared.set(bytes.subarray(0, 128));
      const view = Buffer.from(shared.buffer as unknown as ArrayBuffer, 0, Math.min(bytes.length, 128));
      expect(view.toString()).toBe(native.decode(bytes.subarray(0, 128)));
    }
  });

  it("keeps a decoder's stream state", async () => {
    const vol = new MemoryVolume();
    const Before = globalThis.TextDecoder;
    new ScriptEngine(vol, { cwd: "/" });
    try {
      const Patched = globalThis.TextDecoder;
      expect(Patched).not.toBe(Before);
      const decoder = new Patched();
      const euro = new TextEncoder().encode("€");
      // a character split across calls, then ASCII
      expect(decoder.decode(euro.subarray(0, 1), { stream: true })).toBe("");
      expect(decoder.decode(new Uint8Array([euro[1]!, euro[2]!, 0x61]), { stream: true })).toBe("€a");
      expect(decoder.decode(euro.subarray(0, 2), { stream: true })).toBe("");
      expect(decoder.decode(new Uint8Array([euro[2]!]))).toBe("€");
      expect(decoder.decode(new Uint8Array([0x61, 0x62]))).toBe("ab");
      // a stream left unfinished: the next call still ends it
      expect(decoder.decode(euro.subarray(0, 1), { stream: true })).toBe("");
      expect(decoder.decode(new Uint8Array([0x61]))).toBe("\ufffda");
      expect(new Patched("utf-8", { fatal: true }).decode(new Uint8Array([0x7a]))).toBe("z");
      expect(new Patched("utf-16le").decode(new Uint8Array([0x61, 0x00]))).toBe("a");
    } finally {
      globalThis.TextDecoder = Before;
    }
  });
});

describe("Buffer.byteLength", () => {
  it("counts UTF-8 bytes like encoding them, and a buffer's own size", () => {
    const next = rng(5);
    const pieces = ["a", "é", "€", "😀", "\ud800", "\udc00", "x".repeat(40), "\n"];
    for (let i = 0; i < 3000; i++) {
      let s = "";
      const n = Math.floor(next() * 60);
      for (let j = 0; j < n; j++) s += pieces[Math.floor(next() * pieces.length)];
      expect(Buffer.byteLength(s)).toBe(new TextEncoder().encode(s).length);
    }
    const big = "€".repeat(400_000);
    expect(Buffer.byteLength(big)).toBe(1_200_000);
    expect(Buffer.byteLength(new Uint8Array(7))).toBe(7);
    expect(Buffer.byteLength(Buffer.from("héllo"))).toBe(6);
    expect(Buffer.byteLength(new ArrayBuffer(9))).toBe(9);
    expect(Buffer.byteLength(new Uint16Array(4))).toBe(8);
  });
});
