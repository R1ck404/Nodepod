// URL module with legacy parse/format/resolve and fileURLToPath/pathToFileURL

export interface Url {
  protocol?: string | null;
  slashes?: boolean | null;
  auth?: string | null;
  host?: string | null;
  port?: string | null;
  hostname?: string | null;
  hash?: string | null;
  search?: string | null;
  query?: string | Record<string, string | string[]> | null;
  pathname?: string | null;
  path?: string | null;
  href?: string;
}

function hasScheme(raw: string): boolean {
  // Absolute URL with a scheme (http:, https:, file:, etc.)
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

function parsePathOnly(raw: string, parseQuery: boolean): Url {
  let pathname = raw;
  let search: string | null = null;
  let hash: string | null = null;
  const hashPos = pathname.indexOf("#");
  if (hashPos >= 0) {
    hash = pathname.substring(hashPos);
    pathname = pathname.substring(0, hashPos);
  }
  const searchPos = pathname.indexOf("?");
  if (searchPos >= 0) {
    search = pathname.substring(searchPos);
    pathname = pathname.substring(0, searchPos);
  }
  let query: string | Record<string, string | string[]> | null = null;
  if (search) {
    const qs = search.substring(1);
    if (parseQuery) {
      query = Object.fromEntries(new globalThis.URLSearchParams(qs));
    } else {
      query = qs;
    }
  }
  return {
    protocol: null,
    slashes: null,
    auth: null,
    host: null,
    port: null,
    hostname: null,
    hash,
    search,
    query,
    pathname,
    path: pathname + (search || ""),
    href: raw,
  };
}

export function parse(
  raw: string,
  parseQuery: boolean = false,
  _slashesHost: boolean = false,
): Url {
  // Node url.parse keeps path-only inputs hostless (no localhost injection)
  if (!hasScheme(raw)) {
    return parsePathOnly(raw, parseQuery);
  }

  try {
    const u = new globalThis.URL(raw);
    const authPart = u.username
      ? u.password
        ? `${u.username}:${u.password}`
        : u.username
      : null;
    const queryVal = parseQuery
      ? Object.fromEntries(u.searchParams)
      : u.search
        ? u.search.substring(1)
        : null;

    return {
      protocol: u.protocol,
      slashes: u.protocol.endsWith(":"),
      auth: authPart,
      host: u.host,
      port: u.port || null,
      hostname: u.hostname,
      hash: u.hash || null,
      search: u.search || null,
      query: queryVal,
      pathname: u.pathname,
      path: u.pathname + u.search,
      href: u.href,
    };
  } catch {
    return parsePathOnly(raw, parseQuery);
  }
}

export function format(obj: Url): string {
  if (obj.href) return obj.href;

  let result = "";

  if (obj.protocol) {
    result += obj.protocol.endsWith(":") ? obj.protocol : obj.protocol + ":";
  }

  if (obj.slashes || obj.protocol === "http:" || obj.protocol === "https:") {
    result += "//";
  }

  if (obj.auth) result += obj.auth + "@";

  if (obj.hostname) {
    result += obj.hostname;
  } else if (obj.host) {
    result += obj.host;
  }

  if (obj.port) result += ":" + obj.port;
  if (obj.pathname) result += obj.pathname;

  if (obj.search) {
    result += obj.search;
  } else if (obj.query) {
    if (typeof obj.query === "string") {
      result += "?" + obj.query;
    } else {
      const params = new globalThis.URLSearchParams();
      for (const [key, val] of Object.entries(obj.query)) {
        if (Array.isArray(val)) {
          for (const item of val) params.append(key, item);
        } else {
          params.set(key, val);
        }
      }
      const qs = params.toString();
      if (qs) result += "?" + qs;
    }
  }

  if (obj.hash) result += obj.hash;

  return result;
}

export function resolve(base: string, target: string): string {
  try {
    return new globalThis.URL(target, base).href;
  } catch {
    return target;
  }
}

// Chromium reads a file: URL without `//` (`"file:" + __filename`, as zx's
// cli builds its own URL) as naming a host: file:/home/a -> file://home/a.
// node, per WHATWG, keeps it all path: file:///home/a.
export function toNodeFileUrl<T>(input: T): T | string {
  if (typeof input !== "string") return input;
  const m = /^file:(?!\/\/)\/?/i.exec(input);
  return m ? "file:///" + input.slice(m[0].length) : input;
}

// The native browser URL, parsing file: URLs like node, and URLSearchParams
export class URL extends globalThis.URL {
  constructor(url: string | globalThis.URL, base?: string | globalThis.URL) {
    super(toNodeFileUrl(url), toNodeFileUrl(base));
  }
}
export const URLSearchParams = globalThis.URLSearchParams;

function throwInvalidUrlScheme(protocol: string): never {
  const err = new TypeError(
    `The URL must be of scheme file: got ${protocol}`,
  ) as TypeError & { code: string };
  err.code = "ERR_INVALID_URL_SCHEME";
  throw err;
}

export function fileURLToPath(input: string | URL): string {
  if (typeof input === "string") {
    // Bare filesystem path — return as-is
    if (input.startsWith("/") && !hasScheme(input)) return input;
    try {
      const urlObj = new URL(input);
      if (urlObj.protocol !== "file:") {
        throwInvalidUrlScheme(urlObj.protocol);
      }
      return decodeURIComponent(urlObj.pathname);
    } catch (e) {
      if ((e as { code?: string }).code === "ERR_INVALID_URL_SCHEME") throw e;
      // Not a valid URL at all — return as-is
      return input;
    }
  }
  if (input.protocol !== "file:") {
    throwInvalidUrlScheme(input.protocol);
  }
  return decodeURIComponent(input.pathname);
}

export function pathToFileURL(fsPath: string): URL {
  // already a file:// URL, don't double-prefix
  if (fsPath.startsWith("file://")) {
    return new globalThis.URL(fsPath);
  }
  const encoded = encodeURIComponent(fsPath).replace(/%2F/g, "/");
  return new globalThis.URL("file://" + encoded);
}

export function domainToASCII(domain: string): string {
  try {
    return new globalThis.URL(`http://${domain}`).hostname;
  } catch {
    return domain;
  }
}

export function domainToUnicode(domain: string): string {
  return domain;
}

export default {
  parse,
  format,
  resolve,
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  domainToASCII,
  domainToUnicode,
};
