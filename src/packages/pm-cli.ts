// Shared package-manager CLI helpers used by npm/pnpm/yarn/bun shell commands.

import type { MemoryVolume } from "../memory-volume";
import type { ShellContext, ShellResult } from "../shell/shell-types";
import { NPM_REGISTRY_URL, NPM_REGISTRY_URL_SLASH } from "../constants/config";
import { RegistryClient, flushSharedRegistryCache } from "./registry-client";
import { compareSemver, pickBestMatch, satisfiesRange } from "./version-resolver";
import { clearResolutionMemoryCache } from "./resolution-cache";
import { getTarballCache } from "../persistence/tarball-cache";
import { packTarGz } from "./tar-pack";
import { proxiedFetch } from "../cross-origin";

export type PkgManager = "npm" | "pnpm" | "yarn" | "bun";

const ok = (stdout = "", exitCode = 0): ShellResult => ({
  stdout,
  stderr: "",
  exitCode,
});

const fail = (stderr: string, exitCode = 1): ShellResult => ({
  stdout: "",
  stderr,
  exitCode,
});

/* ------------------------------------------------------------------ */
/*  Global installs                                                    */
/* ------------------------------------------------------------------ */

// npm's layout on Linux: global packages under {prefix}/lib/node_modules,
// their commands linked into {prefix}/bin, which is on the shell's PATH.
// {prefix}/lib keeps a package.json listing them, so every global install
// resolves one consistent tree.
export const GLOBAL_PREFIX = "/usr/local";
export const GLOBAL_LIB = `${GLOBAL_PREFIX}/lib`;
export const GLOBAL_BIN = `${GLOBAL_PREFIX}/bin`;

const isGlobalFlag = (a: string): boolean =>
  a === "-g" || a === "--global" || a === "--location=global";

export function hasGlobalFlag(args: string[]): boolean {
  return args.some(isGlobalFlag);
}

export function withoutGlobalFlags(args: string[]): string[] {
  return args.filter((a) => !isGlobalFlag(a));
}

/** Context for running a package command against the global tree. */
export function globalContext(vol: MemoryVolume, ctx: ShellContext): ShellContext {
  const manifest = `${GLOBAL_LIB}/package.json`;
  if (!vol.existsSync(manifest)) {
    vol.mkdirSync(GLOBAL_LIB, { recursive: true });
    vol.writeFileSync(
      manifest,
      JSON.stringify({ name: "nodepod-global", private: true, dependencies: {} }, null, 2) + "\n",
    );
  }
  return { ...ctx, cwd: GLOBAL_LIB };
}

function binEntries(vol: MemoryVolume, name: string): Array<[string, string]> {
  const pkgDir = `${GLOBAL_LIB}/node_modules/${name}`;
  try {
    const pkg = JSON.parse(vol.readFileSync(`${pkgDir}/package.json`, "utf8") as string);
    const bin: Record<string, string> =
      typeof pkg.bin === "string"
        ? { [String(pkg.name || name).split("/").pop()!]: pkg.bin }
        : pkg.bin && typeof pkg.bin === "object" ? pkg.bin : {};
    return Object.entries(bin)
      .filter(([cmd, rel]) => typeof rel === "string" && /^[\w.@-]+$/.test(cmd))
      .map(([cmd, rel]) => [cmd, `${pkgDir}/${rel.replace(/^\.\//, "")}`]);
  } catch {
    return [];
  }
}

/** Link a global package's commands into GLOBAL_BIN. Returns the names. */
export function linkGlobalBins(vol: MemoryVolume, name: string): string[] {
  const linked: string[] = [];
  for (const [cmd, target] of binEntries(vol, name)) {
    vol.mkdirSync(GLOBAL_BIN, { recursive: true });
    // same stub format as node_modules/.bin, which PATH lookup understands
    vol.writeFileSync(`${GLOBAL_BIN}/${cmd}`, `node "${target}" "$@"\n`);
    linked.push(cmd);
  }
  return linked;
}

/** Remove the GLOBAL_BIN links that point into a global package. */
export function unlinkGlobalBins(vol: MemoryVolume, name: string): void {
  const pkgDir = `${GLOBAL_LIB}/node_modules/${name}/`;
  for (const [cmd] of binEntries(vol, name)) {
    const link = `${GLOBAL_BIN}/${cmd}`;
    try {
      if ((vol.readFileSync(link, "utf8") as string).includes(`"${pkgDir}`)) vol.unlinkSync(link);
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------------ */
/*  .npmrc config                                                      */
/* ------------------------------------------------------------------ */

export function readNpmrc(
  vol: MemoryVolume,
  cwd: string,
): Record<string, string> {
  const cfg: Record<string, string> = {};
  const paths = [`${cwd}/.npmrc`, "/home/user/.npmrc"];
  for (const p of paths) {
    try {
      if (!vol.existsSync(p)) continue;
      const raw = vol.readFileSync(p, "utf8") as string;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
          continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        cfg[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    } catch {
      /* */
    }
  }
  return cfg;
}

export function writeNpmrcKey(
  vol: MemoryVolume,
  cwd: string,
  key: string,
  value: string,
): void {
  const p = `${cwd}/.npmrc`;
  let lines: string[] = [];
  try {
    if (vol.existsSync(p)) {
      lines = (vol.readFileSync(p, "utf8") as string).split("\n");
    }
  } catch {
    /* */
  }
  let found = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      return line;
    const eq = trimmed.indexOf("=");
    if (eq > 0 && trimmed.slice(0, eq).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  const dir = p.substring(0, p.lastIndexOf("/"));
  if (dir && dir !== "/" && !vol.existsSync(dir)) {
    vol.mkdirSync(dir, { recursive: true });
  }
  vol.writeFileSync(p, next.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n");
}

export function deleteNpmrcKey(vol: MemoryVolume, cwd: string, key: string): void {
  const p = `${cwd}/.npmrc`;
  if (!vol.existsSync(p)) return;
  const lines = (vol.readFileSync(p, "utf8") as string)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
        return true;
      const eq = trimmed.indexOf("=");
      if (eq > 0 && trimmed.slice(0, eq).trim() === key) return false;
      return true;
    });
  vol.writeFileSync(p, lines.join("\n"));
}

export function resolveRegistry(
  vol: MemoryVolume,
  cwd: string,
  env: Record<string, string>,
): string {
  const cfg = readNpmrc(vol, cwd);
  return (
    env.npm_config_registry ||
    cfg.registry ||
    NPM_REGISTRY_URL_SLASH
  ).replace(/\/+$/, "");
}

export function resolveAuthToken(
  vol: MemoryVolume,
  cwd: string,
  env: Record<string, string>,
  registry: string,
): string | undefined {
  if (env.NPM_TOKEN) return env.NPM_TOKEN;
  if (env.NODE_AUTH_TOKEN) return env.NODE_AUTH_TOKEN;
  const cfg = readNpmrc(vol, cwd);
  if (cfg["//registry.npmjs.org/:_authToken"])
    return cfg["//registry.npmjs.org/:_authToken"];
  try {
    const host = new URL(registry.endsWith("/") ? registry : registry + "/").host;
    const key = `//${host}/:_authToken`;
    if (cfg[key]) return cfg[key];
  } catch {
    /* */
  }
  return cfg._authToken;
}

export function npmConfig(
  vol: MemoryVolume,
  args: string[],
  ctx: ShellContext,
): ShellResult {
  const sub = args[0];
  const cfg = readNpmrc(vol, ctx.cwd);
  const registry = resolveRegistry(vol, ctx.cwd, ctx.env);

  if (!sub || sub === "list") {
    let out = "; nodepod project config\n";
    out += `prefix = "${ctx.cwd}"\n`;
    out += `registry = "${registry}/"\n`;
    for (const [k, v] of Object.entries(cfg)) {
      if (k === "registry") continue;
      out += `${k} = ${v}\n`;
    }
    return ok(out);
  }
  if (sub === "get") {
    const key = args[1];
    if (!key) return fail("npm config get requires a key\n");
    if (key === "prefix") return ok(ctx.cwd + "\n");
    if (key === "registry") return ok(registry + "/\n");
    if (cfg[key] !== undefined) return ok(cfg[key] + "\n");
    return ok("undefined\n");
  }
  if (sub === "set") {
    const key = args[1];
    const value = args.slice(2).join(" ");
    if (!key || !value) return fail("npm config set requires <key> <value>\n");
    writeNpmrcKey(vol, ctx.cwd, key, value);
    return ok();
  }
  if (sub === "delete" || sub === "rm" || sub === "remove") {
    const key = args[1];
    if (!key) return fail("npm config delete requires a key\n");
    deleteNpmrcKey(vol, ctx.cwd, key);
    return ok();
  }
  return fail(`config: unknown subcommand "${sub}"\n`);
}

/* ------------------------------------------------------------------ */
/*  npm pkg                                                            */
/* ------------------------------------------------------------------ */

function getByPath(obj: any, path: string): unknown {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteByPath(obj: any, path: string): boolean {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== "object") return false;
  const key = parts[parts.length - 1];
  if (!(key in cur)) return false;
  delete cur[key];
  return true;
}

function parsePkgValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function npmPkg(vol: MemoryVolume, args: string[], ctx: ShellContext): ShellResult {
  const sub = args[0];
  const pkgPath = `${ctx.cwd}/package.json`;
  if (!vol.existsSync(pkgPath)) {
    return fail("npm pkg: no package.json found\n");
  }
  let pkg: any;
  try {
    pkg = JSON.parse(vol.readFileSync(pkgPath, "utf8") as string);
  } catch (e: any) {
    return fail(`npm pkg: ${e?.message || "invalid package.json"}\n`);
  }

  if (sub === "get") {
    const key = args[1];
    if (!key) return ok(JSON.stringify(pkg, null, 2) + "\n");
    const val = getByPath(pkg, key);
    if (val === undefined) return ok("undefined\n");
    if (typeof val === "string") return ok(val + "\n");
    return ok(JSON.stringify(val, null, 2) + "\n");
  }
  if (sub === "set") {
    // npm pkg set key=value [key=value...]
    const pairs = args.slice(1);
    if (pairs.length === 0) return fail("npm pkg set requires key=value\n");
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) return fail(`npm pkg set: invalid argument '${pair}'\n`);
      const key = pair.slice(0, eq);
      const value = parsePkgValue(pair.slice(eq + 1));
      setByPath(pkg, key, value);
    }
    vol.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    return ok();
  }
  if (sub === "delete" || sub === "rm" || sub === "remove") {
    const keys = args.slice(1);
    if (keys.length === 0) return fail("npm pkg delete requires a key\n");
    for (const key of keys) deleteByPath(pkg, key);
    vol.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    return ok();
  }
  return fail(`npm pkg: unknown subcommand "${sub ?? ""}"\n`);
}

/* ------------------------------------------------------------------ */
/*  cache / ping / whoami / fund / outdated / audit                    */
/* ------------------------------------------------------------------ */

export async function clearPmCaches(): Promise<ShellResult> {
  flushSharedRegistryCache();
  clearResolutionMemoryCache();
  try {
    if (typeof caches !== "undefined") {
      await caches.delete("nodepod-registry-v1");
      await caches.delete("nodepod-resolution-v1");
    }
  } catch {
    /* */
  }
  try {
    const tc = await getTarballCache();
    await tc?.clear?.();
  } catch {
    /* */
  }
  return ok("Cache cleared.\n");
}

export async function npmPing(
  vol: MemoryVolume,
  ctx: ShellContext,
): Promise<ShellResult> {
  const registry = resolveRegistry(vol, ctx.cwd, ctx.env);
  const url = `${registry}/-/ping`;
  const start = Date.now();
  try {
    const resp = await proxiedFetch(url);
    const ms = Date.now() - start;
    if (!resp.ok) {
      return fail(`npm ping: registry returned HTTP ${resp.status}\n`);
    }
    return ok(`npm notice PING ${registry}/\nnpm notice PONG ${ms}ms\n`);
  } catch (e: any) {
    return fail(`npm ping: ${e?.message || "network error"}\n`);
  }
}

export async function npmWhoami(
  vol: MemoryVolume,
  ctx: ShellContext,
): Promise<ShellResult> {
  const registry = resolveRegistry(vol, ctx.cwd, ctx.env);
  const token = resolveAuthToken(vol, ctx.cwd, ctx.env, registry);
  if (!token) {
    return fail(
      "npm whoami: not authenticated (set NPM_TOKEN or //registry...:_authToken in .npmrc)\n",
    );
  }
  try {
    const resp = await proxiedFetch(`${registry}/-/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      return fail("npm whoami: unauthorized\n");
    }
    if (!resp.ok) {
      return fail(`npm whoami: HTTP ${resp.status}\n`);
    }
    const data = (await resp.json()) as { username?: string; name?: string };
    const name = data.username || data.name;
    if (!name) return fail("npm whoami: empty response\n");
    return ok(name + "\n");
  } catch (e: any) {
    return fail(`npm whoami: ${e?.message || "network error"}\n`);
  }
}

function listInstalledPackages(
  vol: MemoryVolume,
  cwd: string,
): Array<{ name: string; version: string; dir: string }> {
  const nm = `${cwd}/node_modules`;
  const out: Array<{ name: string; version: string; dir: string }> = [];
  if (!vol.existsSync(nm)) return out;
  const walk = (dir: string, scope?: string) => {
    try {
      for (const name of vol.readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const full = `${dir}/${name}`;
        if (name.startsWith("@") && !scope) {
          walk(full, name);
          continue;
        }
        const pkgName = scope ? `${scope}/${name}` : name;
        try {
          const raw = vol.readFileSync(`${full}/package.json`, "utf8") as string;
          const pj = JSON.parse(raw);
          out.push({ name: pkgName, version: pj.version || "0.0.0", dir: full });
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  };
  walk(nm);
  return out;
}

export async function npmFund(
  vol: MemoryVolume,
  ctx: ShellContext,
): Promise<ShellResult> {
  const installed = listInstalledPackages(vol, ctx.cwd);
  const funded: Array<{ name: string; version: string; url: string }> = [];
  for (const pkg of installed) {
    try {
      const raw = vol.readFileSync(`${pkg.dir}/package.json`, "utf8") as string;
      const pj = JSON.parse(raw);
      const funding = pj.funding;
      if (!funding) continue;
      const urls: string[] = [];
      const collect = (f: any) => {
        if (!f) return;
        if (typeof f === "string") urls.push(f);
        else if (Array.isArray(f)) f.forEach(collect);
        else if (typeof f === "object" && f.url) urls.push(String(f.url));
      };
      collect(funding);
      for (const url of urls) {
        funded.push({ name: pkg.name, version: pkg.version, url });
      }
    } catch {
      /* */
    }
  }
  if (funded.length === 0) {
    return ok("0 packages are looking for funding\n");
  }
  let out = `${funded.length} package(s) looking for funding\n`;
  for (const f of funded) {
    out += `${f.name}@${f.version}\n  ${f.url}\n`;
  }
  return ok(out);
}

export async function npmOutdated(
  vol: MemoryVolume,
  ctx: ShellContext,
): Promise<ShellResult> {
  const registry = resolveRegistry(vol, ctx.cwd, ctx.env);
  const client = new RegistryClient({ endpoint: registry });
  const pkgPath = `${ctx.cwd}/package.json`;
  let wanted: Record<string, string> = {};
  try {
    if (vol.existsSync(pkgPath)) {
      const pj = JSON.parse(vol.readFileSync(pkgPath, "utf8") as string);
      wanted = {
        ...(pj.dependencies || {}),
        ...(pj.devDependencies || {}),
        ...(pj.optionalDependencies || {}),
      };
    }
  } catch {
    /* */
  }

  const installed = listInstalledPackages(vol, ctx.cwd).filter((p) =>
    !p.name.includes("/") || p.name.startsWith("@")
      ? wanted[p.name] !== undefined ||
        (() => {
          // top-level only: direct children of node_modules
          const nm = `${ctx.cwd}/node_modules`;
          return p.dir.startsWith(nm + "/") &&
            p.dir.slice(nm.length + 1).split("/").length <= (p.name.startsWith("@") ? 2 : 1);
        })()
      : false,
  );

  // Prefer top-level packages from package.json deps
  const topLevel = Object.keys(wanted);
  const rows: Array<{
    name: string;
    current: string;
    wanted: string;
    latest: string;
  }> = [];

  for (const name of topLevel) {
    const range = wanted[name];
    let current = "";
    try {
      const dir = `${ctx.cwd}/node_modules/${name}`;
      if (vol.existsSync(`${dir}/package.json`)) {
        current = JSON.parse(vol.readFileSync(`${dir}/package.json`, "utf8") as string)
          .version;
      }
    } catch {
      /* */
    }
    if (!current) continue;
    try {
      const meta = await client.fetchManifest(name);
      const versions = Object.keys(meta.versions);
      const wantedVer = pickBestMatch(versions, range) || current;
      const latest = meta["dist-tags"]?.latest || wantedVer;
      if (compareSemver(current, latest) < 0 || compareSemver(current, wantedVer) < 0) {
        rows.push({ name, current, wanted: wantedVer, latest });
      }
    } catch {
      /* skip unreachable packages */
    }
  }

  void installed;
  if (rows.length === 0) return ok("");
  let out = "Package  Current  Wanted  Latest\n";
  for (const r of rows) {
    out += `${r.name}  ${r.current}  ${r.wanted}  ${r.latest}\n`;
  }
  return ok(out, 1);
}

export async function npmAudit(
  vol: MemoryVolume,
  ctx: ShellContext,
): Promise<ShellResult> {
  const registry = resolveRegistry(vol, ctx.cwd, ctx.env);
  const installed = listInstalledPackages(vol, ctx.cwd);
  if (installed.length === 0) {
    return ok("found 0 vulnerabilities\n");
  }
  const body: Record<string, string[]> = {};
  for (const pkg of installed) {
    if (!body[pkg.name]) body[pkg.name] = [];
    if (!body[pkg.name].includes(pkg.version)) body[pkg.name].push(pkg.version);
  }
  try {
    const resp = await proxiedFetch(
      `${registry}/-/npm/v1/security/advisories/bulk`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      // Some registries don't support audit — report honestly
      return fail(`npm audit: registry returned HTTP ${resp.status}\n`);
    }
    const data = (await resp.json()) as Record<
      string,
      Array<{ id?: number; title?: string; severity?: string; url?: string }>
    >;
    let count = 0;
    let out = "";
    for (const [name, advisories] of Object.entries(data || {})) {
      for (const adv of advisories || []) {
        count++;
        out += `${adv.severity || "info"}  ${name}: ${adv.title || "advisory"}${adv.url ? ` (${adv.url})` : ""}\n`;
      }
    }
    out += `found ${count} vulnerabilit${count === 1 ? "y" : "ies"}\n`;
    return { stdout: out, stderr: "", exitCode: count > 0 ? 1 : 0 };
  } catch (e: any) {
    return fail(`npm audit: ${e?.message || "network error"}\n`);
  }
}

/* ------------------------------------------------------------------ */
/*  pack                                                               */
/* ------------------------------------------------------------------ */

function shouldIgnore(rel: string, npmignore: string[]): boolean {
  if (rel.startsWith("node_modules/") || rel === "node_modules") return true;
  if (rel.startsWith(".git/") || rel === ".git") return true;
  for (const pat of npmignore) {
    if (!pat || pat.startsWith("#")) continue;
    if (pat.endsWith("/")) {
      if (rel === pat.slice(0, -1) || rel.startsWith(pat)) return true;
    } else if (pat.includes("*")) {
      const re = new RegExp(
        "^" +
          pat
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*") +
          "$",
      );
      if (re.test(rel) || re.test(rel.split("/").pop() || "")) return true;
    } else if (rel === pat || rel.endsWith("/" + pat)) {
      return true;
    }
  }
  return false;
}

export function npmPack(vol: MemoryVolume, ctx: ShellContext): ShellResult {
  const pkgPath = `${ctx.cwd}/package.json`;
  if (!vol.existsSync(pkgPath)) {
    return fail("npm pack: no package.json found\n");
  }
  let pkg: any;
  try {
    pkg = JSON.parse(vol.readFileSync(pkgPath, "utf8") as string);
  } catch (e: any) {
    return fail(`npm pack: ${e?.message || "invalid package.json"}\n`);
  }
  const name = (pkg.name || "package").replace(/^@/, "").replace(/\//g, "-");
  const version = pkg.version || "0.0.0";
  const tarballName = `${name}-${version}.tgz`;

  let npmignore: string[] = [];
  try {
    if (vol.existsSync(`${ctx.cwd}/.npmignore`)) {
      npmignore = (vol.readFileSync(`${ctx.cwd}/.npmignore`, "utf8") as string)
        .split("\n")
        .map((l) => l.trim());
    }
  } catch {
    /* */
  }

  const filesField: string[] | null = Array.isArray(pkg.files) ? pkg.files : null;
  const entries: Array<{ path: string; content: Uint8Array }> = [];
  const walk = (dir: string, base: string) => {
    for (const ent of vol.readdirSync(dir)) {
      if (ent === "node_modules" || ent === ".git") continue;
      const full = `${dir}/${ent}`;
      const rel = (base ? `${base}/` : "") + ent;
      const st = vol.statSync(full);
      if (st.isDirectory()) {
        walk(full, rel);
      } else {
        if (shouldIgnore(rel, npmignore)) continue;
        if (filesField) {
          const allowed =
            rel === "package.json" ||
            rel === "README.md" ||
            rel === "LICENSE" ||
            rel === "license" ||
            filesField.some(
              (f) =>
                rel === f ||
                rel.startsWith(f.replace(/\/$/, "") + "/") ||
                rel === f.replace(/\/$/, ""),
            );
          if (!allowed) continue;
        }
        const content = vol.readFileSync(full) as Uint8Array | string;
        const bytes =
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : content instanceof Uint8Array
              ? content
              : new TextEncoder().encode(String(content));
        entries.push({ path: `package/${rel}`, content: bytes });
      }
    }
  };
  walk(ctx.cwd, "");

  const gz = packTarGz(entries);
  const outPath = `${ctx.cwd}/${tarballName}`.replace(/\/+/g, "/");
  vol.writeFileSync(outPath, gz);

  const notice = "npm notice";
  let out = `${notice}\n`;
  out += `${notice} package: ${pkg.name}@${version}\n`;
  for (const e of entries) out += `${notice} ${e.path}\n`;
  out += `${notice} total files: ${entries.length}\n`;
  out += `${tarballName}\n`;
  return ok(out);
}

/* ------------------------------------------------------------------ */
/*  Lockfile-aware ci                                                  */
/* ------------------------------------------------------------------ */

export interface LockPackage {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
}

export function readPackageLock(
  vol: MemoryVolume,
  cwd: string,
): { packages: LockPackage[]; lockfileVersion: number } | null {
  const p = `${cwd}/package-lock.json`;
  if (!vol.existsSync(p)) return null;
  try {
    const lock = JSON.parse(vol.readFileSync(p, "utf8") as string);
    const packages: LockPackage[] = [];
    if (lock.packages && typeof lock.packages === "object") {
      for (const [key, val] of Object.entries(lock.packages as Record<string, any>)) {
        if (!key || key === "") continue; // root
        if (!val || !val.version) continue;
        const name =
          val.name ||
          (key.startsWith("node_modules/")
            ? key.replace(/^node_modules\//, "").replace(/\/node_modules\//g, "/")
            : key);
        // only top-level installs for our simple installer
        if (key.includes("/node_modules/") && key !== `node_modules/${name}`) {
          // nested — still include for install-exact helper
        }
        if (!key.startsWith("node_modules/")) continue;
        const depth = key.slice("node_modules/".length).split("/node_modules/").length;
        if (depth > 1) continue; // top-level only for ci install path
        packages.push({
          name,
          version: val.version,
          resolved: val.resolved,
          integrity: val.integrity,
        });
      }
    } else if (lock.dependencies && typeof lock.dependencies === "object") {
      for (const [name, val] of Object.entries(lock.dependencies as Record<string, any>)) {
        packages.push({
          name,
          version: val.version,
          resolved: val.resolved,
          integrity: val.integrity,
        });
      }
    }
    return { packages, lockfileVersion: lock.lockfileVersion || 1 };
  } catch {
    return null;
  }
}

export function packageJsonDepsMatchLock(
  vol: MemoryVolume,
  cwd: string,
  lockPkgs: LockPackage[],
): { ok: true } | { ok: false; reason: string } {
  const pkgPath = `${cwd}/package.json`;
  if (!vol.existsSync(pkgPath)) {
    return { ok: false, reason: "Missing package.json" };
  }
  let pj: any;
  try {
    pj = JSON.parse(vol.readFileSync(pkgPath, "utf8") as string);
  } catch {
    return { ok: false, reason: "Invalid package.json" };
  }
  const declared = {
    ...(pj.dependencies || {}),
    ...(pj.devDependencies || {}),
    ...(pj.optionalDependencies || {}),
  };
  const lockMap = new Map(lockPkgs.map((p) => [p.name, p.version]));
  for (const [name, range] of Object.entries(declared) as [string, string][]) {
    const ver = lockMap.get(name);
    if (!ver) {
      return {
        ok: false,
        reason: `package-lock.json missing entry for "${name}"`,
      };
    }
    if (!satisfiesRange(ver, range) && range !== ver && range !== `=${ver}`) {
      // allow exact pins and ranges that don't satisfy due to aliases — still warn
      if (!range.startsWith("npm:") && compareSemver(ver, range.replace(/^[\^=~]/, "")) < 0 && !satisfiesRange(ver, range)) {
        return {
          ok: false,
          reason: `package.json "${name}"@${range} does not match lock ${ver}`,
        };
      }
    }
  }
  return { ok: true };
}

export function writeNpmPackageLock(
  vol: MemoryVolume,
  cwd: string,
  tree: Map<string, { version: string; tarballUrl: string; dependencies?: Record<string, string> }>,
  rootPkg?: { name?: string; version?: string },
): void {
  const packages: Record<string, any> = {
    "": {
      name: rootPkg?.name || "",
      version: rootPkg?.version || "0.0.0",
      dependencies: Object.fromEntries(
        [...tree.entries()].map(([n, d]) => [n, d.version]),
      ),
    },
  };
  for (const [name, dep] of tree) {
    packages[`node_modules/${name}`] = {
      version: dep.version,
      resolved: dep.tarballUrl,
      dependencies: dep.dependencies || {},
    };
  }
  const lock = {
    name: rootPkg?.name || "",
    version: rootPkg?.version || "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  };
  vol.writeFileSync(
    `${cwd}/package-lock.json`,
    JSON.stringify(lock, null, 2) + "\n",
  );
}

void NPM_REGISTRY_URL;
