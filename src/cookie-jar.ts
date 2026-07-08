/** In-memory cookie jar for virtual dev-server origins (instance + port). */

import { splitCookiesString } from "set-cookie-parser";

export type CookieRecord = {
  value: string;
  path: string;
  expires: number | null;
};

export function cookieJarKey(instanceId: string, serverPort: number | string): string {
  return `${instanceId}\u0000${serverPort}`;
}

export function parseSetCookie(raw: string): { name: string; rec: CookieRecord } | null {
  const str = String(raw);
  const semi = str.split(";");
  const nameValue = semi.shift();
  if (nameValue == null) return null;
  const eq = nameValue.indexOf("=");
  if (eq < 0) return null;
  const name = nameValue.slice(0, eq).trim();
  if (!name) return null;
  const value = nameValue.slice(eq + 1).trim();

  const rec: CookieRecord = { value, path: "/", expires: null };
  let maxAge: number | null = null;
  let expiresAttr: number | null = null;
  for (const attr of semi) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "path") {
      rec.path = val || "/";
    } else if (key === "max-age") {
      const secs = parseInt(val, 10);
      // Max-Age=0 (or negative) means delete immediately — use 0 as sentinel.
      if (!Number.isNaN(secs)) maxAge = secs <= 0 ? 0 : Date.now() + secs * 1000;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAttr = t;
    }
  }
  rec.expires = maxAge !== null ? maxAge : expiresAttr;
  return { name, rec };
}

export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (requestPath.indexOf(cookiePath) === 0) {
    if (cookiePath.charAt(cookiePath.length - 1) === "/") return true;
    if (requestPath.charAt(cookiePath.length) === "/") return true;
  }
  return false;
}

export function buildCookieHeader(
  jar: Map<string, CookieRecord> | undefined,
  path: string,
): string {
  if (!jar || jar.size === 0) return "";
  const now = Date.now();
  const reqPath = (String(path).split("?")[0] || "/") as string;
  const out: string[] = [];
  for (const [name, rec] of jar) {
    if (rec.expires === 0 || (rec.expires !== null && rec.expires <= now)) {
      jar.delete(name);
      continue;
    }
    if (!cookiePathMatches(reqPath, rec.path)) continue;
    out.push(`${name}=${rec.value}`);
  }
  return out.join("; ");
}

export function mergeCookieHeaders(
  browserCookie: string | undefined,
  jarCookie: string,
): string {
  if (!jarCookie) return browserCookie || "";
  if (!browserCookie) return jarCookie;
  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const part of jarCookie.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    const name = (eq < 0 ? p : p.slice(0, eq)).trim();
    seen.add(name);
    pairs.push(p);
  }
  for (const part of browserCookie.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    const name = (eq < 0 ? p : p.slice(0, eq)).trim();
    if (seen.has(name)) continue;
    pairs.push(p);
  }
  return pairs.join("; ");
}

export class VirtualCookieJar {
  private _jars = new Map<string, Map<string, CookieRecord>>();

  store(
    instanceId: string,
    serverPort: number | string,
    setCookieValue: string | string[] | undefined,
  ): void {
    if (setCookieValue == null) return;
    const list = Array.isArray(setCookieValue)
      ? setCookieValue.flatMap((v) => splitCookiesString(v))
      : splitCookiesString(setCookieValue);
    const key = cookieJarKey(instanceId, serverPort);
    let jar = this._jars.get(key);
    if (!jar) {
      jar = new Map();
      this._jars.set(key, jar);
    }
    for (const raw of list) {
      const parsed = parseSetCookie(raw);
      if (!parsed) continue;
      const { name, rec } = parsed;
      if (
        rec.expires === 0 ||
        (rec.expires !== null && rec.expires <= Date.now())
      ) {
        jar.delete(name);
      } else {
        jar.set(name, rec);
      }
    }
    if (jar.size === 0) this._jars.delete(key);
  }

  cookieHeader(instanceId: string, serverPort: number | string, path: string): string {
    return buildCookieHeader(this._jars.get(cookieJarKey(instanceId, serverPort)), path);
  }

  clearInstance(instanceId: string): void {
    for (const key of [...this._jars.keys()]) {
      if (key.startsWith(instanceId + "\u0000")) this._jars.delete(key);
    }
  }

  clearAll(): void {
    this._jars.clear();
  }
}
